import type { SoundsService } from '../sounds/sounds.service.js';
import type { Server as HttpServer } from 'node:http';
import type { FastifyBaseLogger } from 'fastify';
import { Server, type Socket } from 'socket.io';
import { z } from 'zod';
import { AppError } from '../common/errors.js';
import { isPrintable } from '../common/validation.js';
import { extractBearerToken } from '../auth/auth.hooks.js';
import type { AuthService } from '../auth/auth.service.js';
import type { ChannelsService } from '../channels/channels.service.js';
import type { PermissionsService } from '../permissions/permissions.service.js';
import type { ReadStateView } from '../reads/reads.service.js';
import type { Channel } from '../generated/prisma/client.js';
import type { PresenceService } from '../presence/presence.service.js';
import type { MessageView } from '../messages/message.dto.js';
import type { VoiceService } from '../voice/voice.service.js';
import type { VoiceMemberEvent, VoiceSessionTracker, VoiceSessionView } from '../voice/voice-sessions.js';
import { StreamViewerRegistry, VoiceStateRegistry, type VoiceMemberFlags } from '../voice/voice-states.js';
import { toPublicUser, type PublicUser } from '../users/user.dto.js';
import type { User } from '../generated/prisma/client.js';
import { CLIENT_PLATFORMS, type ClientPlatform } from './events.js';
import type { AnnouncementView } from '../admin/settings.service.js';
import type { GuildView, MemberView, MyGuildView } from '../guilds/guild.dto.js';
import type { FriendsService } from '../friends/friends.service.js';
import { isOutdatedDesktop, type ClientVersionService } from '../client-version/client-version.js';
import type { ActivityView, ClientToServerEvents, EventPublisher, MemberRemovedReason, MessageDeletedEvent, PresenceView, ReactionsUpdatedEvent, ServerToClientEvents } from './events.js';

interface SocketData {
  user: User;
  sessionId: string;
  /** 0.5.1: what the client says it is (cosmetic presence metadata only). */
  platform: ClientPlatform;
  /** 0.5.8: the app version the client reports (admin panel only), null when it sent none. */
  version: string | null;
  connectedAt: number;
}

/** 0.5.8: one live realtime connection, for the admin panel. */
export interface ConnectionView {
  userId: string;
  sessionId: string;
  platform: ClientPlatform;
  version: string | null;
  connectedAt: string;
}

type AppServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

/** Every connection (instance-wide things only: the announcement banner). */
const WORKSPACE_ROOM = 'workspace';
/** 0.7.0: superadmins see everyone's presence. */
const SUPERADMIN_ROOM = 'superadmins';
const userRoom = (userId: string) => `user:${userId}`;
const sessionRoom = (sessionId: string) => `session:${sessionId}`;

export const TYPING_TIMEOUT_MS = 8_000;
const TYPING_REBROADCAST_MS = 3_000;
const SESSION_SWEEP_MS = 60_000;

const typingPayload = z.object({ channelId: z.uuid() });
/** 0.5.0: muted / screen / camera are optional so 0.4.x clients (deafened only) keep working. */
const voiceStatePayload = z.object({ deafened: z.boolean(), muted: z.boolean().optional(), screen: z.boolean().optional(), camera: z.boolean().optional() });
/** 0.5.0: this connection started / stopped watching someone's stream. */
const streamWatchPayload = z.object({ streamerId: z.uuid(), source: z.enum(['screen', 'camera']), watching: z.boolean() });
const idlePayload = z.object({ idle: z.boolean() });
/** Only a short, printable display name of an already resolved game: never paths or process lists. */
const activityPayload = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .refine((v) => isPrintable(v) && !/[\\/<>]/.test(v))
    .nullable(),
  /** 0.4.1: Steam AppID (a public number), never a path. */
  steamAppId: z.number().int().positive().max(100_000_000).nullable().optional(),
  /** 0.4.1: when the desktop app first saw this game (kept across reconnects). */
  startedAt: z.iso.datetime().nullable().optional(),
});
const ACTIVITY_MIN_INTERVAL_MS = 1000;
const voicePresencePayload = z.object({ channelId: z.uuid().nullable() });
const soundPlayPayload = z.object({ soundId: z.uuid() });
/** A client-reported game start is trusted only within this window (a reconnect keeps the timer). */
const ACTIVITY_START_MAX_AGE_MS = 48 * 3600_000;

export interface GatewayOptions {
  corsOrigins: string[];
  auth: AuthService;
  presence: PresenceService;
  channels: ChannelsService;
  permissions: PermissionsService;
  log: FastifyBaseLogger;
  /** 0.4.1 voice session timers (optional so older tests can build a gateway without them). */
  voice?: VoiceService;
  voiceSessions?: VoiceSessionTracker;
  /** 0.7.0: who may see whom (presence, profiles, voice states). */
  friends?: FriendsService;
  /** 0.7.0: refuses desktop clients below the minimum version. */
  clientVersion?: ClientVersionService;
  /** 0.7.1 soundboard presses. */
  sounds?: Pick<SoundsService, 'press'>;
}

/**
 * Socket.IO gateway. Every connection must present a valid access token in the
 * handshake (`auth: { token }` or an `Authorization: Bearer` header); otherwise
 * the connection is refused before any event can be received.
 */
export class RealtimeGateway implements EventPublisher {
  readonly io: AppServer;
  private readonly typing = new Map<string, { timer: NodeJS.Timeout; lastBroadcast: number }>();
  /** Channel rows for audience lookups (cleared whenever access may have changed). */
  private readonly channelCache = new Map<string, Channel | null>();
  /** Channel-scoped emits run in order (an audience lookup may hit the database). */
  private emitQueue: Promise<void> = Promise.resolve();
  /** 0.5.0: muted / deafened / streaming / camera per connection, summarized per user (in memory). */
  private readonly voiceStates = new VoiceStateRegistry();
  /** 0.5.0: who watches which stream; only the streamer and that stream's viewers hear about it. */
  private readonly streamViewers = new StreamViewerRegistry((event, audience) => {
    this.io.to(audience.map(userRoom)).emit('stream.viewers', event);
  });
  /** Voice channel each socket says it is in (0.4.1; only used to re-check that room when it leaves). */
  private readonly voiceChannelOf = new Map<string, string>();
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(
    httpServer: HttpServer,
    private readonly options: GatewayOptions,
  ) {
    this.io = new Server(httpServer, {
      path: '/socket.io',
      serveClient: false,
      maxHttpBufferSize: 64 * 1024,
      cors: {
        origin: options.corsOrigins.length > 0 ? options.corsOrigins : false,
        credentials: true,
      },
    });
    this.io.use((socket, next) => {
      void this.authenticate(socket).then(
        () => {
          next();
        },
        (error: unknown) => {
          const appError = error instanceof AppError ? error : null;
          const err = new Error(appError?.message ?? 'Unauthorized') as Error & { data?: unknown };
          err.data = { code: appError?.code ?? 'UNAUTHORIZED' };
          next(err);
        },
      );
    });
    // 0.5.1: a closed client's platform icon expires after a grace period (broadcast then).
    options.presence.onLateChange = (change) => {
      this.presenceUpdated(change);
    };
    this.io.on('connection', (socket) => {
      void this.onConnection(socket);
    });
    this.sweepTimer = setInterval(() => {
      void this.sweep();
    }, SESSION_SWEEP_MS);
    this.sweepTimer.unref();
  }

  async close(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const entry of this.typing.values()) clearTimeout(entry.timer);
    this.typing.clear();
    this.voiceStates.clear();
    this.options.presence.dispose();
    this.streamViewers.clear();
    this.channelCache.clear();
    // Do not call io.close(): it would also close the HTTP server, which Fastify owns.
    this.io.disconnectSockets(true);
    this.io.engine.close();
    await Promise.resolve();
  }

  // ---- EventPublisher -------------------------------------------------------

  messageCreated(message: MessageView): void {
    this.stopTyping(message.author.id, message.channelId);
    this.toChannel(message.channelId, (rooms) => this.io.to(rooms).emit('message.created', message));
  }

  messageUpdated(message: MessageView): void {
    this.toChannel(message.channelId, (rooms) => this.io.to(rooms).emit('message.updated', message));
  }

  messageDeleted(event: MessageDeletedEvent): void {
    this.toChannel(event.channelId, (rooms) => this.io.to(rooms).emit('message.deleted', event));
  }

  reactionsUpdated(event: ReactionsUpdatedEvent): void {
    this.toChannel(event.channelId, (rooms) => this.io.to(rooms).emit('message.reactions', event));
  }

  channelsChanged(scope: 'channels' | 'dms', userIds?: string[], guildId?: string): void {
    this.accessChanged();
    if (userIds) {
      this.toUsers(userIds, (rooms) => this.io.to(rooms).emit('channels.changed', { scope, ...(guildId ? { guildId } : {}) }));
    } else if (guildId) {
      this.toGuild(guildId, (rooms) => this.io.to(rooms).emit('channels.changed', { scope, guildId }));
    }
    if (guildId) this.enforceVoice(guildId);
  }

  rolesChanged(guildId: string): void {
    this.accessChanged();
    this.toGuild(guildId, (rooms) => this.io.to(rooms).emit('roles.changed', { guildId }));
    this.enforceVoice(guildId);
  }

  /** 0.7.0: whoever can no longer connect where they are leaves that call (see VoiceService.enforceAccess). */
  private enforceVoice(guildId: string): void {
    void this.options.voice?.enforceAccess(guildId).catch((error: unknown) => {
      this.options.log.error({ err: error, guildId }, 'Voice access check failed');
    });
  }

  emojisChanged(guildId: string): void {
    this.toGuild(guildId, (rooms) => this.io.to(rooms).emit('emojis.changed', { guildId }));
  }

  gamesChanged(userId: string): void {
    this.toWatchers(userId, (rooms) => this.io.to([...rooms, userRoom(userId)]).emit('games.changed', { userId }));
  }

  soundsChanged(guildId: string): void {
    this.toGuild(guildId, (rooms) => this.io.to(rooms).emit('sounds.changed', { guildId }));
  }

  guildJoined(userId: string, guild: MyGuildView): void {
    this.accessChanged();
    this.io.to(userRoom(userId)).emit('guild.joined', guild);
  }

  guildUpdated(guild: GuildView, userIds: string[]): void {
    this.toUsers(userIds, (rooms) => this.io.to(rooms).emit('guild.updated', guild));
  }

  guildDeleted(guildId: string, userIds: string[]): void {
    this.accessChanged();
    this.toUsers(userIds, (rooms) => this.io.to(rooms).emit('guild.deleted', { guildId }));
    this.enforceVoice(guildId);
  }

  memberAdded(guildId: string, member: MemberView, userIds: string[]): void {
    this.accessChanged();
    this.toUsers(userIds, (rooms) => this.io.to(rooms).emit('guild.member.added', { guildId, member }));
  }

  memberUpdated(guildId: string, member: MemberView, userIds: string[]): void {
    this.toUsers(userIds, (rooms) => this.io.to(rooms).emit('guild.member.updated', { guildId, member }));
  }

  memberRemoved(guildId: string, userId: string, reason: MemberRemovedReason, userIds: string[]): void {
    this.accessChanged();
    this.toUsers(userIds, (rooms) => this.io.to(rooms).emit('guild.member.removed', { guildId, userId, reason }));
    this.enforceVoice(guildId);
  }

  friendsChanged(userIds: string[]): void {
    this.accessChanged();
    this.toUsers(userIds, (rooms) => this.io.to(rooms).emit('friends.changed', {}));
  }

  voiceServerState(guildId: string, userId: string, flags: { muted: boolean; deafened: boolean }): void {
    this.toGuild(guildId, (rooms) => this.io.to(rooms).emit('voice.server_state', { guildId, userId, ...flags }));
  }

  /** Ordered with channel emits, so a member removal never overtakes the messages before it. */
  private toUsers(userIds: string[], emit: (rooms: string[]) => void): void {
    const ids = [...new Set(userIds)];
    this.emitQueue = this.emitQueue.then(() => {
      if (ids.length > 0) emit(ids.map(userRoom));
    });
  }

  private toGuild(guildId: string, emit: (rooms: string[]) => void): void {
    this.emitQueue = this.emitQueue
      .then(async () => {
        const ids = await this.options.permissions.guildAudience(guildId);
        if (ids.length > 0) emit(ids.map(userRoom));
      })
      .catch((error: unknown) => {
        this.options.log.error({ err: error, guildId }, 'Realtime guild emit failed');
      });
  }

  readUpdated(userId: string, state: ReadStateView): void {
    this.io.to(userRoom(userId)).emit('read.updated', state);
  }

  voiceMove(userId: string, channelId: string, rejoin = false): void {
    this.io.to(userRoom(userId)).emit('voice.move', { channelId, rejoin });
  }

  callRing(channelId: string, fromUserId: string, userIds: string[]): void {
    const targets = userIds.filter((id) => id !== fromUserId);
    if (targets.length > 0) this.io.to(targets.map(userRoom)).emit('call.ring', { channelId, fromUserId });
  }

  voiceSession(session: VoiceSessionView): void {
    this.toChannel(session.channelId, (rooms) => this.io.to(rooms).emit('voice.session', session));
  }

  voiceMember(event: VoiceMemberEvent): void {
    if (event.type === 'joined') {
      const { channelId, participant } = event;
      this.toChannel(channelId, (rooms) => this.io.to(rooms).emit('voice.participant.joined', { channelId, participant }));
    } else if (event.type === 'left') {
      const { channelId, userId } = event;
      this.toChannel(channelId, (rooms) => this.io.to(rooms).emit('voice.participant.left', { channelId, userId }));
    } else {
      const { fromChannelId, channelId, participant } = event;
      // Viewers of either channel need it (the client applies it idempotently).
      for (const id of new Set([fromChannelId, channelId])) {
        this.toChannel(id, (rooms) => this.io.to(rooms).emit('voice.participant.moved', { fromChannelId, channelId, participant }));
      }
    }
  }

  /**
   * Channel rows may have changed (moved, deleted). 0.7.0: permission caches are invalidated by the
   * services that change them, per server (PermissionsService.invalidateGuild), never globally here.
   */
  accessChanged(): void {
    this.channelCache.clear();
  }

  /**
   * Runs `emit` with the socket rooms of everyone who may see the channel (0.4.0: private channels
   * and DMs never reach other users). Ordered, so created / updated / deleted keep their order.
   */
  private toChannel(channelId: string, emit: (rooms: string[]) => void): void {
    this.emitQueue = this.emitQueue
      .then(async () => {
        const channel = await this.channelFor(channelId);
        if (!channel) return;
        const userIds = await this.options.permissions.audience(channel);
        if (userIds.length > 0) emit(userIds.map(userRoom));
      })
      .catch((error: unknown) => {
        this.options.log.error({ err: error, channelId }, 'Realtime channel emit failed');
      });
  }

  private async channelFor(channelId: string): Promise<Channel | null> {
    if (this.channelCache.has(channelId)) return this.channelCache.get(channelId) ?? null;
    const channel = await this.options.channels.get(channelId).catch(() => null);
    this.channelCache.set(channelId, channel);
    return channel;
  }

  userUpdated(user: PublicUser): void {
    this.toWatchers(user.id, (rooms) => this.io.to(rooms).emit('user.updated', user));
  }

  presenceUpdated(presence: PresenceView): void {
    this.toWatchers(presence.userId, (rooms) => this.io.to(rooms).emit('presence.updated', presence));
  }

  /**
   * 0.7.0: things about one person (presence, profile, voice state) go to their friends, the members
   * of their servers and the superadmins only.
   */
  private toWatchers(userId: string, emit: (rooms: string[]) => void): void {
    const friends = this.options.friends;
    if (!friends) {
      emit([WORKSPACE_ROOM]);
      return;
    }
    this.emitQueue = this.emitQueue
      .then(async () => {
        emit([...(await friends.watchersOf(userId)).map(userRoom), SUPERADMIN_ROOM]);
      })
      .catch((error: unknown) => {
        this.options.log.error({ err: error, userId }, 'Realtime watcher emit failed');
      });
  }

  /** Ids this socket's user may see (null = everyone: superadmin or no friends service wired). */
  private async visibleTo(user: User): Promise<Set<string> | null> {
    const friends = this.options.friends;
    if (!friends) return null;
    const visible = await friends.visibleUserIds(user);
    return visible === 'all' ? null : visible;
  }

  announcementChanged(announcement: AnnouncementView | null): void {
    this.io.to(WORKSPACE_ROOM).emit('announcement', { announcement });
  }

  voiceNodesChanged(): void {
    this.io.to(SUPERADMIN_ROOM).emit('voice-nodes.changed', {});
  }

  disconnectSession(sessionId: string, reason: string): void {
    this.io.to(sessionRoom(sessionId)).emit('session.revoked', { reason });
    this.io.in(sessionRoom(sessionId)).disconnectSockets(true);
  }

  disconnectUser(userId: string, reason: string): void {
    this.io.to(userRoom(userId)).emit('session.revoked', { reason });
    this.io.in(userRoom(userId)).disconnectSockets(true);
  }

  // ---- internals ------------------------------------------------------------

  private async authenticate(socket: AppSocket): Promise<void> {
    const authPayload: unknown = socket.handshake.auth;
    let token: string | null = null;
    if (typeof authPayload === 'object' && authPayload !== null && 'token' in authPayload) {
      const value = authPayload.token;
      if (typeof value === 'string') token = value.replace(/^Bearer\s+/i, '');
    }
    token ??= extractBearerToken(socket.handshake.headers.authorization);
    if (!token) {
      throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
    }
    const ctx = await this.options.auth.authenticate(token);
    socket.data.user = ctx.user;
    socket.data.sessionId = ctx.sessionId;
    // 0.5.1: the client's own kind (desktop / web / android); unknown values count as web.
    const platform = typeof authPayload === 'object' && authPayload !== null && 'platform' in authPayload ? authPayload.platform : null;
    socket.data.platform = (CLIENT_PLATFORMS as readonly unknown[]).includes(platform) ? (platform as ClientPlatform) : 'web';
    const version = typeof authPayload === 'object' && authPayload !== null && 'version' in authPayload ? authPayload.version : null;
    socket.data.version = typeof version === 'string' && /^[0-9A-Za-z.+-]{1,32}$/.test(version) ? version : null;
    // 0.7.0: an outdated desktop app must update first (the web client is always current).
    if (this.options.clientVersion && (await isOutdatedDesktop(this.options.clientVersion, socket.data.platform, socket.data.version))) {
      throw new AppError(426, 'CLIENT_OUTDATED', 'Update AIDis to continue');
    }
    socket.data.connectedAt = Date.now();
  }

  /** 0.5.8: every live connection (admin panel: who is online on which client and version). */
  connections(): ConnectionView[] {
    return (
      [...this.io.sockets.sockets.values()]
        // A socket is only in this list after authentication (io.use above), so user is set.
        .map((socket) => ({
          userId: socket.data.user.id,
          sessionId: socket.data.sessionId,
          platform: socket.data.platform,
          version: socket.data.version,
          connectedAt: new Date(socket.data.connectedAt).toISOString(),
        }))
    );
  }

  private async onConnection(socket: AppSocket): Promise<void> {
    const { user, sessionId } = socket.data;
    const { presence, log } = this.options;
    socket.on('typing.start', (payload) => {
      void this.handleTypingStart(socket, payload);
    });
    socket.on('typing.stop', (payload) => {
      const parsed = typingPayload.safeParse(payload);
      if (parsed.success) this.stopTyping(user.id, parsed.data.channelId);
    });
    let lastActivityAt = 0;
    socket.on('presence.idle', (payload) => {
      const parsed = idlePayload.safeParse(payload);
      if (!parsed.success) return;
      const change = presence.setIdle(user.id, socket.id, parsed.data.idle);
      if (change) this.presenceUpdated(change);
    });
    socket.on('activity.set', (payload) => {
      const parsed = activityPayload.safeParse(payload);
      if (!parsed.success) return;
      // A starting game is reported once; ignore floods (a closing game is always accepted).
      const now = Date.now();
      if (parsed.data.name !== null && now - lastActivityAt < ACTIVITY_MIN_INTERVAL_MS) return;
      lastActivityAt = now;
      const { name, steamAppId, startedAt } = parsed.data;
      const reported = startedAt ? Date.parse(startedAt) : NaN;
      const trusted = Number.isFinite(reported) && reported <= now + 60_000 && now - reported <= ACTIVITY_START_MAX_AGE_MS;
      const activity: ActivityView | null = name ? { type: 'playing', name, steamAppId: steamAppId ?? null, ...(trusted ? { startedAt: new Date(Math.min(reported, now)).toISOString() } : {}) } : null;
      const change = presence.setActivity(user.id, socket.id, activity);
      if (change) this.presenceUpdated(change);
    });
    socket.on('voice.presence', (payload) => {
      const parsed = voicePresencePayload.safeParse(payload);
      if (!parsed.success) return;
      // Only a hint: the room is re-read from LiveKit, so a client cannot fake who is inside.
      const previous = this.voiceChannelOf.get(socket.id);
      if (previous && previous !== parsed.data.channelId) this.options.voice?.touchSession(previous);
      if (parsed.data.channelId) {
        this.voiceChannelOf.set(socket.id, parsed.data.channelId);
        this.options.voice?.touchSession(parsed.data.channelId);
      } else {
        this.voiceChannelOf.delete(socket.id);
      }
    });
    let lastSyncAt = 0;
    socket.on('voice.sync', () => {
      // Authoritative resync on request (LiveKit reconnect, resume, channel switch); at most 1/s.
      const now = Date.now();
      if (now - lastSyncAt < 1000) return;
      lastSyncAt = now;
      void this.visibleVoiceSessions(user).then(
        (sessions) => {
          socket.emit('voice.sessions', { sessions });
        },
        () => undefined,
      );
    });
    socket.on('voice.state', (payload) => {
      const parsed = voiceStatePayload.safeParse(payload);
      if (!parsed.success) return;
      const { deafened, muted = false, screen = false, camera = false } = parsed.data;
      this.setVoiceState(socket, { deafened, muted, screen, camera });
    });
    socket.on('voice.sound.play', (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => undefined;
      const parsed = soundPlayPayload.safeParse(payload);
      if (!parsed.success || !this.options.sounds) {
        reply({ ok: false, code: 'VALIDATION_ERROR' });
        return;
      }
      void this.options.sounds.press(user, parsed.data.soundId).then(
        (result) => {
          if (!result.ok) {
            reply({ ok: false, code: result.code });
            return;
          }
          // Only the people in that voice channel (the presser hears it from the same event).
          const event = { channelId: result.channelId, soundId: parsed.data.soundId, userId: user.id };
          for (const id of result.listenerIds) this.io.to(userRoom(id)).emit('voice.sound', event);
          reply({ ok: true });
        },
        () => {
          reply({ ok: false, code: 'INTERNAL_ERROR' });
        },
      );
    });
    socket.on('stream.watch', (payload) => {
      const parsed = streamWatchPayload.safeParse(payload);
      if (!parsed.success) return;
      const { streamerId, source, watching } = parsed.data;
      if (!watching) {
        this.streamViewers.unwatch(socket.id, user.id, streamerId, source);
        return;
      }
      // 0.7.0: only people who can see the streamer's channel (its server members with access, or the DM's members).
      void this.canWatch(user, streamerId).then(
        (allowed) => {
          if (allowed && socket.connected) socket.emit('stream.viewers', this.streamViewers.watch(socket.id, user.id, streamerId, source));
        },
        () => undefined,
      );
    });
    socket.on('disconnect', () => {
      this.streamViewers.dropSocket(socket.id, user.id);
      const left = this.voiceStates.drop(socket.id);
      if (left) this.publishVoiceState(left, true);
      // The LiveKit connection may outlive the socket for a bit (or end with it): re-check the room.
      const voiceChannel = this.voiceChannelOf.get(socket.id);
      this.voiceChannelOf.delete(socket.id);
      if (voiceChannel) this.options.voice?.touchSession(voiceChannel, 3000);
      void this.onDisconnect(socket);
    });

    await socket.join([WORKSPACE_ROOM, userRoom(user.id), sessionRoom(sessionId), ...(user.role === 'ADMIN' ? [SUPERADMIN_ROOM] : [])]);

    try {
      const change = await presence.connect(user.id, socket.id, socket.data.platform);
      if (!socket.connected) {
        // The client went away while we were registering it; undo so presence stays correct.
        await this.onDisconnect(socket);
        return;
      }
      if (change) this.presenceUpdated(change);
      const visible = await this.visibleTo(user);
      const snapshot = await presence.snapshot();
      socket.emit('ready', { user: toPublicUser(user), presence: visible ? snapshot.filter((p) => visible.has(p.userId)) : snapshot });
      const states = this.voiceStates.snapshot().filter((s) => !visible || visible.has(s.userId));
      socket.emit('voice.states', { deafened: states.filter((s) => s.deafened).map((s) => s.userId), states });
      socket.emit('voice.sessions', { sessions: await this.visibleVoiceSessions(user) });
    } catch (error) {
      log.error({ err: error, userId: user.id }, 'Realtime connection setup failed');
    }
    log.debug({ event: 'realtime.connect', userId: user.id, sessionId }, 'Realtime client connected');
  }

  private async onDisconnect(socket: AppSocket): Promise<void> {
    const { user } = socket.data;
    try {
      const change = await this.options.presence.disconnect(user.id, socket.id);
      if (change) {
        for (const key of [...this.typing.keys()]) {
          if (key.startsWith(`${user.id}:`)) this.stopTyping(user.id, key.slice(user.id.length + 1));
        }
        this.presenceUpdated(change);
      }
    } catch (error) {
      this.options.log.error({ err: error, userId: user.id }, 'Realtime disconnect handling failed');
    }
  }

  /** A stream can be watched by whoever can see the channel the streamer is in. */
  private async canWatch(user: User, streamerId: string): Promise<boolean> {
    const channelId = this.options.voice?.channelOf(streamerId);
    if (!channelId) return false;
    const channel = await this.channelFor(channelId);
    return channel !== null && (await this.options.permissions.canView(user, channel));
  }

  /** Voice sessions in channels this user may see. */
  private async visibleVoiceSessions(user: User): Promise<VoiceSessionView[]> {
    const visible: VoiceSessionView[] = [];
    for (const session of this.options.voiceSessions?.snapshot() ?? []) {
      const channel = await this.channelFor(session.channelId);
      if (channel && (await this.options.permissions.canView(user, channel))) visible.push(session);
    }
    return visible;
  }

  /** Stores one connection's voice state and tells everyone when the user's summary changes. */
  private setVoiceState(socket: AppSocket, flags: VoiceMemberFlags): void {
    const before = this.voiceStates.stateOf(socket.data.user.id);
    const after = this.voiceStates.set(socket.id, socket.data.user.id, flags);
    if (after) this.publishVoiceState(after, before.screen || before.camera);
  }

  private publishVoiceState(state: ReturnType<VoiceStateRegistry['stateOf']>, hadStream: boolean): void {
    this.toWatchers(state.userId, (rooms) => this.io.to(rooms).emit('voice.state', state));
    // A stream that ended takes its viewer list with it (no leave sounds for that).
    if (hadStream && !state.screen) this.streamViewers.endStream(state.userId, 'screen');
    if (hadStream && !state.camera) this.streamViewers.endStream(state.userId, 'camera');
  }

  private async handleTypingStart(socket: AppSocket, payload: unknown): Promise<void> {
    const parsed = typingPayload.safeParse(payload);
    if (!parsed.success) return;
    const { channelId } = parsed.data;
    const channel = await this.channelFor(channelId);
    if (!channel || !(await this.options.permissions.canView(socket.data.user, channel))) return;

    const userId = socket.data.user.id;
    const key = `${userId}:${channelId}`;
    const existing = this.typing.get(key);
    const now = Date.now();
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      this.stopTyping(userId, channelId);
    }, TYPING_TIMEOUT_MS);
    timer.unref();
    const shouldBroadcast = !existing || now - existing.lastBroadcast >= TYPING_REBROADCAST_MS;
    const lastBroadcast = existing && !shouldBroadcast ? existing.lastBroadcast : now;
    this.typing.set(key, { timer, lastBroadcast });
    if (shouldBroadcast) {
      const rooms = (await this.options.permissions.audience(channel)).filter((id) => id !== userId).map(userRoom);
      if (rooms.length > 0) this.io.to(rooms).emit('typing.started', { channelId, userId, expiresInMs: TYPING_TIMEOUT_MS });
    }
  }

  private stopTyping(userId: string, channelId: string): void {
    const key = `${userId}:${channelId}`;
    const entry = this.typing.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.typing.delete(key);
    this.toChannel(channelId, (rooms) => this.io.to(rooms).emit('typing.stopped', { channelId, userId }));
  }

  /** Drops sockets whose session was revoked elsewhere (e.g. by the admin CLI) and refreshes lastSeenAt. */
  private async sweep(): Promise<void> {
    try {
      const sockets = await this.io.fetchSockets();
      const checked = new Map<string, boolean>();
      for (const socket of sockets) {
        const sessionId = socket.data.sessionId;
        let active = checked.get(sessionId);
        if (active === undefined) {
          active = await this.options.auth.isSessionActive(sessionId);
          checked.set(sessionId, active);
        }
        if (!active) {
          socket.emit('session.revoked', { reason: 'session_inactive' });
          socket.disconnect(true);
        }
      }
      await this.options.presence.refreshOnlineUsers();
      for (const change of await this.options.presence.expireCustomStatuses()) this.presenceUpdated(change);
    } catch (error) {
      this.options.log.error({ err: error }, 'Realtime session sweep failed');
    }
  }
}
