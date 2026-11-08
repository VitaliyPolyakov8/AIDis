import { Readable } from 'node:stream';
import type { PrismaClient } from '../db/prisma.js';
import { isUniqueViolation } from '../db/prisma.js';
import type { ServerEmoji, User } from '../generated/prisma/client.js';
import { Errors } from '../common/errors.js';
import type { LocalFileStorage } from '../attachments/storage.js';
import { mimeForFormat, parseImageInfo } from '../users/avatar-image.js';
import type { PermissionsService } from '../permissions/permissions.service.js';
import type { LimitsService } from '../limits/limits.service.js';
import type { EventPublisher } from '../realtime/events.js';
import type { AuditService } from '../audit/audit.service.js';

export const MAX_EMOJI_BYTES = 512 * 1024;

export interface ServerEmojiView {
  id: string;
  guildId: string;
  name: string;
  width: number;
  height: number;
  animated: boolean;
  createdById: string;
  createdAt: string;
}

function view(row: ServerEmoji): ServerEmojiView {
  return { id: row.id, guildId: row.guildId, name: row.name, width: row.width, height: row.height, animated: row.animated, createdById: row.createdById, createdAt: row.createdAt.toISOString() };
}

function emojiName(raw: string): string {
  const name = raw.normalize('NFC').toLowerCase();
  if (!/^[\p{L}\p{N}_]{2,32}$/u.test(name)) throw Errors.badRequest('EMOJI_NAME_INVALID', 'Use 2–32 letters, numbers or underscores');
  return name;
}

/**
 * 0.6.1 custom emojis; 0.7.0: they belong to a server (CREATE_EMOJIS / MANAGE_EMOJIS there) and
 * its members can use them everywhere, DMs included. Images are readable by any signed-in user
 * (whoever sees a message must see its emojis).
 */
export class EmojisService {
  constructor(
    private readonly prisma: PrismaClient,
    readonly storage: LocalFileStorage,
    private readonly permissions: PermissionsService,
    private readonly publisher: EventPublisher,
    private readonly audit: AuditService,
    private readonly limits: LimitsService,
  ) {}

  /** Emojis of every server the user is in. */
  async list(user: User): Promise<ServerEmojiView[]> {
    const guildIds = await this.permissions.guildIdsOf(user.id);
    if (guildIds.length === 0) return [];
    return (await this.prisma.serverEmoji.findMany({ where: { guildId: { in: guildIds } }, orderBy: [{ guildId: 'asc' }, { name: 'asc' }] })).map(view);
  }

  async get(id: string): Promise<ServerEmoji> {
    const row = await this.prisma.serverEmoji.findUnique({ where: { id } });
    if (!row) throw Errors.notFound('Emoji');
    return row;
  }

  /** May this user use (react with) this emoji: a member of its server. */
  async usableBy(userId: string, id: string): Promise<boolean> {
    const row = await this.prisma.serverEmoji.findUnique({ where: { id }, select: { guildId: true } });
    return row !== null && (await this.permissions.isMember(userId, row.guildId));
  }

  /**
   * :name: -> emoji ids for one message: the channel's server first, then the author's other servers
   * in their own order (DMs: only the author's servers).
   */
  async resolverFor(authorId: string, channelGuildId: string | null): Promise<Map<string, { id: string; name: string }>> {
    const order = [...(channelGuildId ? [channelGuildId] : []), ...(await this.permissions.guildIdsOf(authorId)).filter((g) => g !== channelGuildId)];
    if (order.length === 0) return new Map();
    const rows = await this.prisma.serverEmoji.findMany({ where: { guildId: { in: order } }, select: { id: true, name: true, guildId: true } });
    const out = new Map<string, { id: string; name: string }>();
    for (const guildId of order) for (const row of rows) if (row.guildId === guildId && !out.has(row.name)) out.set(row.name, { id: row.id, name: row.name });
    return out;
  }

  private async requireCreate(user: User, guildId: string): Promise<void> {
    const perms = await this.permissions.guildPermissions(user, guildId);
    if (perms.size === 0) throw Errors.guildNotFound();
    if (!perms.has('CREATE_EMOJIS') && !perms.has('MANAGE_EMOJIS')) throw Errors.forbidden('Missing permission: CREATE_EMOJIS');
  }

  private async requireEdit(user: User, row: ServerEmoji): Promise<void> {
    const perms = await this.permissions.guildPermissions(user, row.guildId);
    if (perms.has('MANAGE_EMOJIS')) return;
    if (row.createdById === user.id && perms.has('CREATE_EMOJIS')) return;
    throw Errors.forbidden('You cannot manage this server emoji');
  }

  async create(user: User, guildId: string, rawName: string, stream: Readable): Promise<ServerEmojiView> {
    await this.requireCreate(user, guildId);
    const name = emojiName(rawName);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const raw of stream) {
      const chunk: unknown = raw;
      if (!Buffer.isBuffer(chunk)) throw Errors.badRequest('EMOJI_FORMAT', 'An image file is required');
      size += chunk.length;
      if (size > MAX_EMOJI_BYTES) throw Errors.payloadTooLarge('Emoji files must be at most 512 KiB');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    const info = parseImageInfo(bytes);
    if (!info || info.width < 1 || info.height < 1) throw Errors.badRequest('EMOJI_FORMAT', 'Use PNG, JPEG, GIF or WebP');
    if (info.width > 512 || info.height > 512) throw Errors.badRequest('EMOJI_DIMENSIONS', 'Emoji images must be at most 512×512 pixels');
    if (await this.prisma.serverEmoji.findUnique({ where: { guildId_name: { guildId, name } } })) throw Errors.conflict('EMOJI_NAME_TAKEN', 'This emoji name is already in use');
    const limit = await this.limits.resolve('guild.emojis', { guildId });
    if ((await this.prisma.serverEmoji.count({ where: { guildId } })) >= limit) throw Errors.limitReached('guild.emojis', limit);
    const saved = await this.storage.save(Readable.from(bytes));
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        // Unique slots 0..limit-1 per server keep the limit even with parallel uploads.
        const used = new Set((await this.prisma.serverEmoji.findMany({ where: { guildId }, select: { slot: true } })).map((e) => e.slot));
        const slot = Array.from({ length: limit }, (_, i) => i).find((i) => !used.has(i));
        if (slot === undefined) throw Errors.limitReached('guild.emojis', limit);
        try {
          const row = await this.prisma.serverEmoji.create({
            data: { guildId, name, slot, storedName: saved.storedName, mimeType: mimeForFormat(info.format), size, width: info.width, height: info.height, animated: info.animated, createdById: user.id },
          });
          await this.audit.record(user.id, 'emoji.created', { type: 'emoji', id: row.id }, { name }, guildId);
          this.publisher.emojisChanged(guildId);
          return view(row);
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          if (await this.prisma.serverEmoji.findUnique({ where: { guildId_name: { guildId, name } } })) throw Errors.conflict('EMOJI_NAME_TAKEN', 'This emoji name is already in use');
        }
      }
      throw Errors.conflict('EMOJI_BUSY', 'Another emoji is being added; please retry');
    } catch (error) {
      await this.storage.remove(saved.storedName);
      throw error;
    }
  }

  async rename(user: User, id: string, rawName: string): Promise<ServerEmojiView> {
    const row = await this.get(id);
    await this.requireEdit(user, row);
    const name = emojiName(rawName);
    let updated: ServerEmoji;
    try {
      updated = await this.prisma.serverEmoji.update({ where: { id }, data: { name } });
    } catch (error) {
      if (isUniqueViolation(error)) throw Errors.conflict('EMOJI_NAME_TAKEN', 'This emoji name is already in use');
      throw error;
    }
    await this.audit.record(user.id, 'emoji.updated', { type: 'emoji', id }, { name }, row.guildId);
    this.publisher.emojisChanged(row.guildId);
    return view(updated);
  }

  async remove(user: User, id: string): Promise<void> {
    const row = await this.get(id);
    await this.requireEdit(user, row);
    await this.prisma.serverEmoji.delete({ where: { id } });
    await this.storage.remove(row.storedName);
    await this.audit.record(user.id, 'emoji.deleted', { type: 'emoji', id }, { name: row.name }, row.guildId);
    this.publisher.emojisChanged(row.guildId);
  }
}
