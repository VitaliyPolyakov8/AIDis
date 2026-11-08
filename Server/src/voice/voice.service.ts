import type { FastifyBaseLogger } from 'fastify';
import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk';
import type { AppConfig } from '../config/env.js';
import type { Channel, User } from '../generated/prisma/client.js';
import { AppError, Errors } from '../common/errors.js';
import { notFriends, type ChannelsService } from '../channels/channels.service.js';
import type { PermissionsService } from '../permissions/permissions.service.js';
import type { VoiceRoomSource, VoiceSessionTracker } from './voice-sessions.js';
import type { LiveKitEndpoint, VoiceNodesService } from '../voice-nodes/voice-nodes.service.js';

export interface VoiceTokenResponse {
  /** Public LiveKit signaling URL the client connects to (wss://...). */
  url: string;
  token: string;
  roomName: string;
  identity: string;
  channelId: string;
  expiresAt: string;
}

export interface VoiceParticipantView {
  identity: string;
  name: string;
  joinedAt: string | null;
}

/** LiveKit room name for a voice channel. Derived from the channel id so renames do not matter. */
export function roomNameForChannel(channelId: string): string {
  return `voice-${channelId}`;
}

/** 0.5.5: a stream preview older than this is not shown (the streamer refreshes it every 5 s). */
export const THUMBNAIL_MAX_AGE_MS = 30_000;
export const THUMBNAIL_MAX_BYTES = 256 * 1024;

/**
 * Issues short-lived LiveKit access tokens. The API secret never leaves the backend;
 * clients only receive the signed JWT and the public signaling URL.
 */
/** 0.5.9: how long a failed MoveParticipant is not tried again. */
const MOVE_RETRY_AFTER_MS = 30 * 60_000;

export class VoiceService implements VoiceRoomSource {
  /** The main LiveKit's API client (as in 0.7.0). */
  private roomClient: RoomServiceClient | undefined;
  /** 0.7.1: one API client per extra voice server. */
  private readonly roomClients = new Map<string, RoomServiceClient>();
  /** 0.7.1 extra voice servers (null in unit setups without them: everything uses the main LiveKit). */
  private nodes: Pick<VoiceNodesService, 'endpointFor' | 'endpoints' | 'mainEndpoint'> | null = null;
  /** 0.4.1 voice session timer (null when voice is off or in tests that do not need it). */
  private sessions: VoiceSessionTracker | null = null;

  constructor(
    private readonly config: AppConfig['livekit'],
    private readonly channels: ChannelsService,
    private readonly log: FastifyBaseLogger,
    private readonly permissions: PermissionsService | null = null,
  ) {}

  attachSessions(tracker: VoiceSessionTracker): void {
    this.sessions = tracker;
  }

  attachNodes(nodes: Pick<VoiceNodesService, 'endpointFor' | 'endpoints' | 'mainEndpoint'>): void {
    this.nodes = nodes;
  }

  private mainEndpoint(): LiveKitEndpoint {
    const { publicUrl, apiUrl, apiKey, apiSecret } = this.config;
    return this.nodes?.mainEndpoint() ?? { nodeId: null, url: publicUrl, apiUrl, apiKey, apiSecret };
  }

  /** 0.7.1: the LiveKit a channel's call runs on. */
  private async endpointOf(channel: Pick<Channel, 'guildId' | 'voiceNodeId'> | null): Promise<LiveKitEndpoint> {
    if (!channel || !this.nodes) return this.mainEndpoint();
    return this.nodes.endpointFor(channel);
  }

  /** The LiveKit of a channel by id (the main one when the channel is gone). */
  private async endpointOfId(channelId: string): Promise<LiveKitEndpoint> {
    return this.endpointOf(await this.channels.get(channelId).catch(() => null));
  }

  // ---- 0.7.0 server mute / deafen (memory only, per server) -------------------------------
  private readonly serverState = new Map<string, { muted: boolean; deafened: boolean }>();

  serverFlags(guildId: string, userId: string): { muted: boolean; deafened: boolean } {
    return this.serverState.get(`${guildId}:${userId}`) ?? { muted: false, deafened: false };
  }

  /**
   * Stores the flag (the caller checked that the target is a member below the moderator). A server
   * mute also updates the live LiveKit connection, but only when the target is in a voice channel
   * of THIS server; the sources are recomputed from their permissions there (never granted extra).
   */
  async setServerFlag(guildId: string, target: User, flag: 'muted' | 'deafened', value: boolean): Promise<{ muted: boolean; deafened: boolean }> {
    const userId = target.id;
    const next = { ...this.serverFlags(guildId, userId), [flag]: value };
    if (next.muted || next.deafened) this.serverState.set(`${guildId}:${userId}`, next);
    else this.serverState.delete(`${guildId}:${userId}`);
    const channelId = this.channelOf(userId);
    const channel = flag === 'muted' && channelId && this.config.enabled ? await this.channels.get(channelId).catch(() => null) : null;
    if (channel?.guildId === guildId) {
      const sources = await this.publishSources(target, channel);
      await this.rooms(await this.endpointOf(channel))
        .updateParticipant(roomNameForChannel(channel.id), userId, { permission: { canPublish: true, canSubscribe: true, canPublishData: true, canPublishSources: sources, canUpdateMetadata: false } })
        .catch((error: unknown) => {
          // The new permission still applies to the next token; the client is told through voice.server_state.
          this.log.warn({ err: error, event: 'livekit.server_mute_failed' }, 'Could not update the participant permission');
        });
    }
    return next;
  }

  /** 0.7.0: account lookup for enforceAccess (wired in app.ts). */
  userLookup: (ids: string[]) => Promise<Pick<User, 'id' | 'role'>[]> = () => Promise.resolve([]);

  /**
   * 0.7.0: removes from LiveKit everyone who may no longer connect where they are (role / overwrite
   * changes, leave, kick, ban, deleted channels and servers). guildId limits the check to one server;
   * calls in channels that no longer exist are always emptied.
   */
  async enforceAccess(guildId?: string): Promise<void> {
    if (!this.sessions || !this.permissions || !this.config.enabled) return;
    for (const session of this.sessions.snapshot()) {
      if (session.participants.length === 0) continue;
      const channel = await this.channels.get(session.channelId).catch(() => null);
      if (channel && (channel.type === 'DM' || (guildId !== undefined && channel.guildId !== guildId))) continue;
      const users = channel ? await this.userLookup(session.participants.map((p) => p.identity)) : [];
      for (const participant of session.participants) {
        const user = users.find((u) => u.id === participant.identity);
        if (channel && user && (await this.permissions.canConnect(user, channel))) continue;
        await this.rooms(await this.endpointOf(channel))
          .removeParticipant(roomNameForChannel(session.channelId), participant.identity)
          .catch((error: unknown) => {
            if (!isNotFound(error)) this.log.warn({ err: error, event: 'voice.enforce_failed' }, 'Could not remove a participant who lost access');
          });
        this.touchSession(session.channelId);
      }
    }
  }

  /** What a user may publish in a channel: SPEAK -> microphone, STREAM -> screen and camera; minus a server mute. */
  private async publishSources(user: User, channel: Channel): Promise<TrackSource[]> {
    const perms = this.permissions ? await this.permissions.channelPermissions(user, channel) : null;
    const can = (p: 'SPEAK' | 'STREAM') => perms === null || perms.has(p);
    const muted = channel.guildId ? this.serverFlags(channel.guildId, user.id).muted : false;
    return [...(can('SPEAK') && !muted ? [TrackSource.MICROPHONE] : []), ...(can('STREAM') ? [TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO] : [])];
  }

  /** 0.7.1: who is in a voice channel right now (user ids, from the session tracker). */
  participantIdsOf(channelId: string): string[] {
    return (this.sessions?.snapshot() ?? []).find((s) => s.channelId === channelId)?.participants.map((p) => p.identity) ?? [];
  }

  /** 0.5.5: the voice channel a user is in (null when unknown or voice is off). */
  channelOf(userId: string): string | null {
    return this.sessions?.channelOf(userId) ?? null;
  }

  // ---- 0.5.5 stream previews -------------------------------------------------------------
  /** Newest small snapshot of each streamer's screen share (memory only, a few KB each). */
  private readonly thumbnails = new Map<string, { channelId: string; type: string; data: Buffer; at: number }>();

  /** Stores a streamer's preview. The streamer must be in a voice channel (it is tied to it). */
  setThumbnail(userId: string, type: string, data: Buffer): boolean {
    const channelId = this.channelOf(userId);
    if (!channelId) return false;
    this.thumbnails.set(userId, { channelId, type, data, at: Date.now() });
    return true;
  }

  clearThumbnail(userId: string): void {
    this.thumbnails.delete(userId);
  }

  /**
   * A streamer's preview for `viewer`: only while it is fresh, the streamer is still in that
   * channel, and the viewer may see the channel (private channels stay private).
   */
  async thumbnailFor(viewer: User, streamerId: string): Promise<{ type: string; data: Buffer; at: number } | null> {
    const entry = this.thumbnails.get(streamerId);
    if (!entry) return null;
    if (Date.now() - entry.at > THUMBNAIL_MAX_AGE_MS || this.channelOf(streamerId) !== entry.channelId) {
      this.thumbnails.delete(streamerId);
      return null;
    }
    const channel = await this.channels.getOfType(entry.channelId, 'VOICE').catch(() => null);
    if (!channel || (this.permissions && !(await this.permissions.canView(viewer, channel)))) return null;
    return entry;
  }

  /** Something changed in a channel's room (join, leave, move, disconnect): refresh its session. */
  touchSession(channelId: string, delayMs?: number): void {
    this.sessions?.touch(channelId, delayMs);
  }

  /** VoiceRoomSource: one room, without permission checks (server-internal). */
  async listParticipants(channelId: string): Promise<VoiceParticipantView[]> {
    try {
      const list = await this.rooms(await this.endpointOfId(channelId)).listParticipants(roomNameForChannel(channelId));
      return list.map(toParticipantView);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  /** VoiceRoomSource: channel ids of rooms with people in them (one LiveKit call for all rooms). */
  async occupiedChannels(): Promise<string[]> {
    // 0.7.1: every LiveKit; a voice node that does not answer must not hide the others (the main one still throws).
    const endpoints = this.nodes ? await this.nodes.endpoints() : [this.mainEndpoint()];
    const ids = new Set<string>();
    for (const [index, endpoint] of endpoints.entries()) {
      try {
        const rooms = await this.rooms(endpoint).listRooms();
        for (const r of rooms) if (r.numParticipants > 0 && r.name.startsWith('voice-')) ids.add(r.name.slice('voice-'.length));
      } catch (error) {
        if (index === 0) throw error;
        this.log.warn({ err: error, event: 'livekit.node_unreachable', nodeId: endpoint.nodeId }, 'A voice server did not answer');
      }
    }
    return [...ids];
  }

  /** A VOICE channel or DM the user may join (0.4.0: private channels, DMs, CONNECT_VOICE). */
  private async callableFor(user: User, channelId: string) {
    const channel = await this.channels.getCallable(channelId);
    if (this.permissions) {
      await this.permissions.requireView(user, channel);
      if (!(await this.permissions.canConnect(user, channel))) throw Errors.forbidden('You cannot join this voice channel');
    }
    // 0.7.0: calls in a 1:1 DM need friendship, like writing there.
    if (channel.type === 'DM' && !(await this.channels.canWriteDm(user, channel))) throw notFriends();
    return channel;
  }

  async createToken(user: User, channelId: string): Promise<VoiceTokenResponse> {
    this.assertEnabled();
    const channel = await this.callableFor(user, channelId);
    const roomName = roomNameForChannel(channel.id);
    const identity = user.id;
    const endpoint = await this.endpointOf(channel);
    const at = new AccessToken(endpoint.apiKey, endpoint.apiSecret, {
      identity,
      name: user.displayName,
      ttl: this.config.tokenTtlSeconds,
      metadata: JSON.stringify({ username: user.username, role: user.role }),
    });
    at.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      // 0.7.0: only what this person may publish in this channel.
      canPublishSources: await this.publishSources(user, channel),
      canUpdateOwnMetadata: false,
    });
    let token: string;
    try {
      token = await at.toJwt();
    } catch (error) {
      this.log.error({ err: error, event: 'livekit.token_failed' }, 'Failed to sign LiveKit token');
      throw Errors.serviceUnavailable('VOICE_TOKEN_FAILED', 'Could not create a voice token');
    }
    this.log.info({ event: 'voice.token_issued', userId: user.id, channelId: channel.id }, 'Voice token issued');
    // The client connects to LiveKit right after this; look at the room once it had time to join
    // (the client also says "joined" over the socket, which refreshes sooner).
    this.touchSession(channel.id, 4000);
    return {
      url: endpoint.url,
      token,
      roomName,
      identity,
      channelId: channel.id,
      expiresAt: new Date(Date.now() + this.config.tokenTtlSeconds * 1000).toISOString(),
    };
  }

  /** Who is currently in a voice channel (asks LiveKit; empty if the room does not exist yet). */
  async participants(user: User, channelId: string): Promise<VoiceParticipantView[]> {
    this.assertEnabled();
    const channel = await this.channels.getCallable(channelId);
    if (this.permissions) await this.permissions.requireView(user, channel);
    try {
      const list = await this.rooms(await this.endpointOf(channel)).listParticipants(roomNameForChannel(channel.id));
      return list.map(toParticipantView);
    } catch (error) {
      if (isNotFound(error)) return [];
      this.log.error({ err: error, event: 'livekit.api_failed' }, 'LiveKit API call failed');
      throw Errors.serviceUnavailable('LIVEKIT_UNAVAILABLE', 'Voice server is not reachable');
    }
  }

  /**
   * Removes one participant from a voice channel's LiveKit room (admin "disconnect from voice").
   * Only the LiveKit connection ends: the account, its sessions and text chat are untouched, and
   * the user can rejoin voice right away. Every client sees a normal participant-left event.
   */
  async disconnectParticipant(channelId: string, identity: string): Promise<void> {
    this.assertEnabled();
    const channel = await this.channels.getCallable(channelId);
    try {
      await this.rooms(await this.endpointOf(channel)).removeParticipant(roomNameForChannel(channel.id), identity);
      this.touchSession(channel.id);
    } catch (error) {
      // The user already left (or never joined) this room: a specific code, not a generic 404.
      if (isNotFound(error)) throw new AppError(404, 'VOICE_PARTICIPANT_NOT_FOUND', 'The user is not in this voice channel');
      this.log.error({ err: error, event: 'livekit.api_failed' }, 'LiveKit API call failed');
      throw Errors.serviceUnavailable('LIVEKIT_UNAVAILABLE', 'Voice server is not reachable');
    }
  }

  /**
   * 0.4.0 "Move to": LiveKit moves the participant's connection to the target room on the server
   * (MoveParticipant; the client follows without reconnecting). Returns false when the LiveKit
   * server cannot do that, so the caller falls back to "remove + tell the client to rejoin".
   */
  async moveParticipant(fromChannelId: string, toChannelId: string, identity: string): Promise<boolean> {
    this.assertEnabled();
    const from = await this.channels.getOfType(fromChannelId, 'VOICE');
    const to = await this.channels.getOfType(toChannelId, 'VOICE');
    const fromEndpoint = await this.endpointOf(from);
    const toEndpoint = await this.endpointOf(to);
    // 0.7.1: rooms on different LiveKits cannot be moved between: the client rejoins instead.
    const sameLiveKit = fromEndpoint.url === toEndpoint.url;
    try {
      if (!sameLiveKit) throw new Error('different voice servers');
      // 0.5.9: after a failed MoveParticipant (LiveKit without it) skip straight to the fallback
      // for a while: the extra round trip made every move about a second slower.
      if (Date.now() < this.moveUnsupportedUntil) throw new Error('move unsupported (remembered)');
      await this.rooms(fromEndpoint).moveParticipant(roomNameForChannel(from.id), identity, roomNameForChannel(to.id));
      this.touchSession(from.id);
      this.touchSession(to.id);
      return true;
    } catch (error) {
      if (isNotFound(error)) throw new AppError(404, 'VOICE_PARTICIPANT_NOT_FOUND', 'The user is not in this voice channel');
      if (sameLiveKit && Date.now() >= this.moveUnsupportedUntil) {
        this.moveUnsupportedUntil = Date.now() + MOVE_RETRY_AFTER_MS;
        this.log.warn({ err: error, event: 'livekit.move_failed' }, 'LiveKit MoveParticipant failed; falling back to remove + rejoin');
      }
      try {
        await this.rooms(fromEndpoint).removeParticipant(roomNameForChannel(from.id), identity);
        this.touchSession(from.id);
      } catch (removeError) {
        if (isNotFound(removeError)) throw new AppError(404, 'VOICE_PARTICIPANT_NOT_FOUND', 'The user is not in this voice channel');
        throw Errors.serviceUnavailable('LIVEKIT_UNAVAILABLE', 'Voice server is not reachable');
      }
      return false;
    }
  }

  /** 0.5.9: until when MoveParticipant is skipped after it failed (ms epoch). */
  private moveUnsupportedUntil = 0;

  private rooms(endpoint: LiveKitEndpoint): RoomServiceClient {
    if (endpoint.nodeId === null) {
      this.roomClient ??= new RoomServiceClient(endpoint.apiUrl, endpoint.apiKey, endpoint.apiSecret);
      return this.roomClient;
    }
    const key = `${endpoint.apiUrl}|${endpoint.apiKey}|${endpoint.apiSecret}`;
    let client = this.roomClients.get(key);
    if (!client) {
      client = new RoomServiceClient(endpoint.apiUrl, endpoint.apiKey, endpoint.apiSecret);
      this.roomClients.set(key, client);
    }
    return client;
  }

  private assertEnabled(): void {
    if (!this.config.enabled) {
      throw Errors.serviceUnavailable('VOICE_NOT_CONFIGURED', 'Voice is not configured on this server');
    }
  }
}

function toParticipantView(p: { identity: string; name: string; joinedAt?: bigint | number }): VoiceParticipantView {
  return { identity: p.identity, name: p.name, joinedAt: p.joinedAt ? new Date(Number(p.joinedAt) * 1000).toISOString() : null };
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === 404;
}
