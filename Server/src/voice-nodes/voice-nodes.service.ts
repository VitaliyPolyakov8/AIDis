import { RoomServiceClient } from 'livekit-server-sdk';
import { z } from 'zod';
import type { FastifyBaseLogger } from 'fastify';
import type { PrismaClient } from '../db/prisma.js';
import type { Channel, VoiceNode } from '../generated/prisma/client.js';
import type { AppConfig } from '../config/env.js';
import { Errors } from '../common/errors.js';
import { parseInput } from '../common/validation.js';
import type { SecretBox } from '../common/secret-box.js';
import type { EventPublisher } from '../realtime/events.js';

export type NodeCheckStatus = 'ok' | 'unreachable' | 'unauthorized';

/** What clients and the server need to talk to one LiveKit (the main one from .env, or a node). */
export interface LiveKitEndpoint {
  /** null = the main LiveKit from .env. */
  nodeId: string | null;
  /** Public wss:// signaling URL given to clients. */
  url: string;
  /** URL for server-side API calls. */
  apiUrl: string;
  apiKey: string;
  apiSecret: string;
}

export interface VoiceNodeView {
  id: string;
  name: string;
  url: string;
  apiKey: string;
  enabled: boolean;
  guildIds: string[];
  lastCheckAt: string | null;
  lastCheckStatus: NodeCheckStatus | null;
}

/** Channels moved back to the main LiveKit because their node went away (people there must rejoin). */
export interface NodeFallback {
  channelIds: string[];
  guildIds: string[];
}

const CHECK_EVERY_MS = 5 * 60_000;

const secret = z.string().min(16).max(256);
const createSchema = z.object({ name: z.string().trim().min(1).max(64), url: z.string().trim().max(255), apiKey: z.string().trim().min(1).max(128), apiSecret: secret });
const updateSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  enabled: z.boolean().optional(),
  guildIds: z.array(z.uuid()).max(1000).optional(),
  apiKey: z.string().trim().min(1).max(128).optional(),
  apiSecret: secret.optional(),
});

/**
 * 0.7.1 extra voice servers: LiveKits on VPSes, each a subdomain of VOICE_NODE_DOMAIN. Only the
 * superadmin manages them; a node serves only the servers it was given (none at first). Channels
 * whose node is gone, disabled or no longer given to their server use the main LiveKit again.
 */
export class VoiceNodesService {
  private timer: NodeJS.Timeout | null = null;
  /** Called when channels fall back to the main LiveKit (the voice service makes people rejoin). */
  onFallback: (fallback: NodeFallback) => void = () => undefined;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly box: SecretBox,
    private readonly config: Pick<AppConfig, 'livekit' | 'voiceNodeDomain'>,
    private readonly publisher: EventPublisher,
    private readonly log: FastifyBaseLogger,
  ) {}

  start(): void {
    this.timer ??= setInterval(() => void this.checkAll(), CHECK_EVERY_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** wss://<one label>.<domain>, nothing else (no path, port, user info). */
  validUrl(raw: string): string | null {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    const domain = this.config.voiceNodeDomain.toLowerCase();
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'wss:' || url.port || url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) return null;
    if (!host.endsWith(`.${domain}`)) return null;
    const label = host.slice(0, -domain.length - 1);
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return null;
    return `wss://${host}`;
  }

  main(): { url: string } {
    return { url: this.config.livekit.publicUrl };
  }

  async list(): Promise<VoiceNodeView[]> {
    const rows = await this.prisma.voiceNode.findMany({ include: { guilds: { select: { guildId: true } } }, orderBy: { createdAt: 'asc' } });
    return rows.map((r) =>
      this.view(
        r,
        r.guilds.map((g) => g.guildId),
      ),
    );
  }

  async get(id: string): Promise<VoiceNodeView> {
    const row = await this.prisma.voiceNode.findUnique({ where: { id }, include: { guilds: { select: { guildId: true } } } });
    if (!row) throw Errors.notFound('Voice server');
    return this.view(
      row,
      row.guilds.map((g) => g.guildId),
    );
  }

  async create(input: unknown): Promise<VoiceNodeView> {
    const data = parseInput(createSchema, input);
    const url = this.validUrl(data.url);
    if (!url) throw Errors.badRequest('INVALID_NODE_URL', `The address must be wss://<name>.${this.config.voiceNodeDomain}`);
    if (await this.prisma.voiceNode.findUnique({ where: { url } })) throw Errors.conflict('NODE_EXISTS', 'This voice server is already added');
    const row = await this.prisma.voiceNode.create({ data: { name: data.name, url, apiKey: data.apiKey, apiSecretSealed: this.box.seal(data.apiSecret) } });
    await this.check(row.id);
    this.publisher.voiceNodesChanged();
    return this.get(row.id);
  }

  async update(id: string, input: unknown): Promise<VoiceNodeView> {
    const data = parseInput(updateSchema, input);
    const before = await this.get(id);
    if (data.guildIds) {
      const existing = await this.prisma.guild.count({ where: { id: { in: data.guildIds } } });
      if (existing !== new Set(data.guildIds).size) throw Errors.badRequest('INVALID_GUILD', 'Unknown server');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.voiceNode.update({
        where: { id },
        data: {
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
          ...(data.apiKey !== undefined ? { apiKey: data.apiKey } : {}),
          ...(data.apiSecret !== undefined ? { apiSecretSealed: this.box.seal(data.apiSecret) } : {}),
        },
      });
      if (data.guildIds) {
        await tx.voiceNodeGuild.deleteMany({ where: { nodeId: id } });
        await tx.voiceNodeGuild.createMany({ data: [...new Set(data.guildIds)].map((guildId) => ({ nodeId: id, guildId })) });
      }
    });
    // Channels that can no longer use the node go back to the main LiveKit.
    const lost = data.enabled === false ? before.guildIds : data.guildIds ? before.guildIds.filter((g) => !data.guildIds?.includes(g)) : [];
    if (data.enabled === false) await this.fallback(id, null);
    else if (lost.length > 0) await this.fallback(id, lost);
    if (data.apiKey !== undefined || data.apiSecret !== undefined) await this.check(id);
    this.publisher.voiceNodesChanged();
    return this.get(id);
  }

  async remove(id: string): Promise<VoiceNode> {
    const row = await this.prisma.voiceNode.findUnique({ where: { id } });
    if (!row) throw Errors.notFound('Voice server');
    await this.fallback(id, null);
    await this.prisma.voiceNode.delete({ where: { id } });
    this.publisher.voiceNodesChanged();
    return row;
  }

  /** Nodes a server may pick for its voice channels (enabled and given to it). */
  async forGuild(guildId: string): Promise<{ id: string; name: string }[]> {
    return this.prisma.voiceNode.findMany({ where: { enabled: true, guilds: { some: { guildId } } }, select: { id: true, name: true }, orderBy: { createdAt: 'asc' } });
  }

  async usableBy(nodeId: string, guildId: string): Promise<boolean> {
    return (await this.prisma.voiceNode.count({ where: { id: nodeId, enabled: true, guilds: { some: { guildId } } } })) > 0;
  }

  /** The LiveKit a channel's call runs on (the main one unless its node is usable by its server). */
  async endpointFor(channel: Pick<Channel, 'guildId' | 'voiceNodeId'>): Promise<LiveKitEndpoint> {
    if (channel.voiceNodeId && channel.guildId) {
      const row = await this.prisma.voiceNode.findFirst({ where: { id: channel.voiceNodeId, enabled: true, guilds: { some: { guildId: channel.guildId } } } });
      if (row) return this.endpoint(row);
    }
    return this.mainEndpoint();
  }

  mainEndpoint(): LiveKitEndpoint {
    const { publicUrl, apiUrl, apiKey, apiSecret } = this.config.livekit;
    return { nodeId: null, url: publicUrl, apiUrl, apiKey, apiSecret };
  }

  /** Every LiveKit a call can run on now (the main one first). */
  async endpoints(): Promise<LiveKitEndpoint[]> {
    const rows = await this.prisma.voiceNode.findMany({ where: { enabled: true } });
    const nodes: LiveKitEndpoint[] = [];
    for (const row of rows) {
      try {
        nodes.push(this.endpoint(row));
      } catch (error) {
        this.log.warn({ err: error, nodeId: row.id }, 'Voice node secret cannot be opened (server secret changed?)');
      }
    }
    return [this.mainEndpoint(), ...nodes];
  }

  async check(id: string): Promise<NodeCheckStatus> {
    const row = await this.prisma.voiceNode.findUnique({ where: { id } });
    if (!row) throw Errors.notFound('Voice server');
    let status: NodeCheckStatus;
    try {
      const ep = this.endpoint(row);
      await new RoomServiceClient(ep.apiUrl, ep.apiKey, ep.apiSecret).listRooms();
      status = 'ok';
    } catch (error) {
      const code = (error as { status?: unknown; code?: unknown }).status ?? (error as { code?: unknown }).code;
      status = code === 401 || code === 403 || code === 'unauthenticated' || code === 'permission_denied' ? 'unauthorized' : 'unreachable';
    }
    await this.prisma.voiceNode.update({ where: { id }, data: { lastCheckAt: new Date(), lastCheckStatus: status } });
    return status;
  }

  private async checkAll(): Promise<void> {
    const rows = await this.prisma.voiceNode.findMany({ where: { enabled: true }, select: { id: true } });
    for (const { id } of rows)
      await this.check(id).catch((error: unknown) => {
        this.log.warn({ err: error, nodeId: id }, 'Voice node check failed');
      });
    if (rows.length > 0) this.publisher.voiceNodesChanged();
  }

  /** Channels of these servers (null = all) on the node go back to the main LiveKit. */
  private async fallback(nodeId: string, guildIds: string[] | null): Promise<void> {
    const where = { voiceNodeId: nodeId, ...(guildIds ? { guildId: { in: guildIds } } : {}) };
    const channels = await this.prisma.channel.findMany({ where, select: { id: true, guildId: true } });
    if (channels.length === 0) return;
    await this.prisma.channel.updateMany({ where, data: { voiceNodeId: null } });
    const affectedGuilds = [...new Set(channels.map((c) => c.guildId).filter((g): g is string => g !== null))];
    for (const guildId of affectedGuilds) this.publisher.channelsChanged('channels', undefined, guildId);
    this.onFallback({ channelIds: channels.map((c) => c.id), guildIds: affectedGuilds });
  }

  private endpoint(row: VoiceNode): LiveKitEndpoint {
    return { nodeId: row.id, url: row.url, apiUrl: row.url.replace(/^wss:/, 'https:'), apiKey: row.apiKey, apiSecret: this.box.open(row.apiSecretSealed) };
  }

  private view(row: VoiceNode, guildIds: string[]): VoiceNodeView {
    return {
      id: row.id,
      name: row.name,
      url: row.url,
      apiKey: row.apiKey,
      enabled: row.enabled,
      guildIds,
      lastCheckAt: row.lastCheckAt?.toISOString() ?? null,
      lastCheckStatus: (row.lastCheckStatus as NodeCheckStatus | null) ?? null,
    };
  }
}
