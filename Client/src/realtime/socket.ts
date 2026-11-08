import { forgetShelf } from '../games/GameShelf';
import { useSoundboardStore } from '../sounds-board/store';
import { io, type Socket } from 'socket.io-client';
import { useAnnouncementStore } from '../stores/announcementStore';
import { config, getApiOrigin } from '../config';
import { getValidAccessToken, refreshAccessToken } from '../api/client';
import type { ClientToServerEvents, MemberRemovedReason, ServerToClientEvents } from '../api/types';
import { useGuildStore } from '../stores/guildStore';
import { useFriendsStore } from '../stores/friendsStore';
import { toast, useUiStore } from '../stores/uiStore';
import { t } from '../i18n';
import { useAuthStore } from '../stores/authStore';
import { useChatStore } from '../stores/chatStore';
import { useConnectionStore } from '../stores/connectionStore';
import { usePresenceStore } from '../stores/presenceStore';
import { notifyNewMessage } from '../desktop/notifications';
import { overlayMessage } from '../desktop/overlayFeed';
import { applyMemberJoined, applyMemberLeft, applyMemberMoved, applyMemberState, applyVoiceSessions, streamKey, useVoiceStore } from '../voice/voiceStore';
import { playSound } from '../sounds/sounds';
import { useReadStore } from '../stores/readStore';
import { useCallStore } from '../stores/callStore';
import { usersApi } from '../api/users';
import { speakIfTts } from '../voice/tts';
import { voice } from '../voice/voiceService';
import { useEmojiStore } from '../emojis/store';

type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** 0.7.0: I lost a server (deleted, left elsewhere, kicked, banned): drop it, leave its call, say why. */
function loseGuild(guildId: string, reason: 'deleted' | MemberRemovedReason): void {
  const name = useGuildStore.getState().guilds.find((g) => g.id === guildId)?.name ?? '';
  const voiceState = useVoiceStore.getState();
  const inThisCall = voiceState.channelId !== null && useGuildStore.getState().byGuild[guildId]?.channels.some((c) => c.id === voiceState.channelId);
  if (inThisCall && voiceState.status !== 'idle') void voice.leave({ silent: true });
  useGuildStore.getState().removeGuild(guildId);
  if (reason !== 'left') toast.info(t(`guilds.lost.${reason}`, { name }), `guild-lost-${guildId}`);
}

/** 0.7.0: the open channel or my voice channel disappeared (hidden / deleted): leave it. */
function leaveIfChannelGone(): void {
  const voiceState = useVoiceStore.getState();
  if (voiceState.channelId && voiceState.status !== 'idle') {
    const known = useChatStore.getState().channels.some((c) => c.id === voiceState.channelId) || useChatStore.getState().dms.some((d) => d.id === voiceState.channelId);
    if (!known) void voice.leave({ silent: true });
  }
}

/** 0.5.0: our own voice state as others see it. */
export interface OwnVoiceState {
  deafened: boolean;
  muted: boolean;
  screen: boolean;
  camera: boolean;
}
const NO_VOICE_STATE: OwnVoiceState = { deafened: false, muted: false, screen: false, camera: false };

/** 0.4.1: what is published about the game (name, Steam AppID, when it started). */
export interface PublishedActivity {
  name: string;
  steamAppId: number | null;
  startedAt: string | null;
}

function activityPayload(activity: string | PublishedActivity | null): { name: string | null; steamAppId?: number | null; startedAt?: string | null } {
  if (activity === null || typeof activity === 'string') return { name: activity };
  return { name: activity.name, steamAppId: activity.steamAppId, startedAt: activity.startedAt };
}

/**
 * The single Socket.IO connection of the app. Event names are the server's exact
 * contract (Server/src/realtime/events.ts). Auth uses `auth: { token }` and is
 * re-evaluated on every (re)connect so an expired access token is refreshed first.
 */
class RealtimeClient {
  private socket: AppSocket | null = null;
  private readyCount = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private authRetries = 0;
  /** Our own voice state while in a call; re-sent after every reconnect (the server forgets it with the socket). */
  private voiceState: OwnVoiceState = NO_VOICE_STATE;
  /** 0.5.0: streams this device watches ("streamerId:source"); re-sent after every reconnect. */
  private watching = new Set<string>();
  /** Desktop idle (automatic Away) and the resolved game name; re-sent after reconnects. */
  private idle = false;
  private activity: string | PublishedActivity | null = null;
  /** 0.4.1: voice channel we are connected to; re-sent after reconnects. */
  private voiceChannel: string | null = null;

  connect(): void {
    if (this.socket) return;
    this.readyCount = 0;
    this.authRetries = 0;
    const origin = getApiOrigin();
    const options = {
      path: '/socket.io',
      autoConnect: false,
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10_000,
      timeout: 15_000,
      auth: (cb: (data: object) => void) => {
        getValidAccessToken().then(
          (token) => {
            cb({ token: token ?? '', platform: config.platform, version: config.clientVersion });
          },
          () => {
            cb({ token: '', platform: config.platform, version: config.clientVersion });
          },
        );
      },
    };
    const socket: AppSocket = origin ? io(origin, options) : io(options);
    this.socket = socket;
    this.bind(socket);
    useConnectionStore.getState().setSocket('connecting');
    socket.connect();
  }

  disconnect(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.voiceState = NO_VOICE_STATE;
    this.watching = new Set();
    // idle / activity describe this device, not the session: kept for the next login.
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.io.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
    useConnectionStore.getState().setSocket('idle');
  }

  /** Typing events are fire-and-forget; dropped silently while disconnected. */
  emitTyping(channelId: string, active: boolean): void {
    if (!this.socket?.connected) return;
    this.socket.emit(active ? 'typing.start' : 'typing.stop', { channelId });
  }

  /**
   * Tells everyone our voice state (0.5.0: mic muted, deafened, screen stream, camera) so the channel
   * list shows it to people outside the channel too. Everything off while we are not in a call.
   */
  setVoiceState(state: OwnVoiceState): void {
    const s = this.voiceState;
    if (s.deafened === state.deafened && s.muted === state.muted && s.screen === state.screen && s.camera === state.camera) return;
    this.voiceState = { ...state };
    if (this.socket?.connected) this.socket.emit('voice.state', this.voiceState);
  }

  /**
   * 0.5.0: the streams this device watches (stream keys of OTHER people). Sends only the
   * difference; the server tells the streamer and the other viewers (with a short grace period).
   */
  setWatchedStreams(streams: readonly { streamerId: string; source: 'screen' | 'camera' }[]): void {
    const next = new Set(streams.map((s) => `${s.streamerId}:${s.source}`));
    for (const id of this.watching) if (!next.has(id)) this.emitWatch(id, false);
    for (const id of next) if (!this.watching.has(id)) this.emitWatch(id, true);
    this.watching = next;
  }

  private emitWatch(id: string, watching: boolean): void {
    if (!this.socket?.connected) return;
    const split = id.lastIndexOf(':');
    this.socket.emit('stream.watch', { streamerId: id.slice(0, split), source: id.slice(split + 1) as 'screen' | 'camera', watching });
  }

  /** Desktop only: no input for a while (automatic Away). */
  setIdle(idle: boolean): void {
    if (idle === this.idle) return;
    this.idle = idle;
    if (this.socket?.connected) this.socket.emit('presence.idle', { idle });
  }

  /** Desktop only: the game being played (already resolved to a display name), or null. */
  setActivity(activity: string | PublishedActivity | null): void {
    if (JSON.stringify(activity) === JSON.stringify(this.activity)) return;
    this.activity = activity;
    if (this.socket?.connected) this.socket.emit('activity.set', activityPayload(activity));
  }

  /** 0.4.2: asks the server for an authoritative voice membership snapshot (resync). */
  /** 0.7.1: a soundboard press; resolves with 'ok' or the server's refusal code. */
  async playSound(soundId: string): Promise<string> {
    if (!this.socket?.connected) return 'OFFLINE';
    try {
      const result = (await this.socket.timeout(5000).emitWithAck('voice.sound.play', { soundId })) as { ok: true } | { ok: false; code: string };
      return result.ok ? 'ok' : result.code;
    } catch {
      return 'TIMEOUT';
    }
  }

  requestVoiceSync(): void {
    if (this.socket?.connected) this.socket.emit('voice.sync', {});
  }

  /** 0.4.1: tells the server we joined / left a voice channel, so its session timer updates at once. */
  setVoiceChannel(channelId: string | null): void {
    if (channelId === this.voiceChannel) return;
    this.voiceChannel = channelId;
    if (this.socket?.connected) this.socket.emit('voice.presence', { channelId });
  }

  /** A realtime 'ready' snapshot has been applied since connect() (fresher than any REST answer). */
  get hasSnapshot(): boolean {
    return this.readyCount > 0;
  }

  get connected(): boolean {
    return this.socket?.connected ?? false;
  }

  private bind(socket: AppSocket): void {
    const connection = useConnectionStore.getState();

    socket.on('connect', () => {
      this.authRetries = 0;
      connection.setSocket('connected');
    });

    socket.on('disconnect', (reason) => {
      if (this.socket !== socket) return;
      if (reason === 'io client disconnect') return;
      // "io server disconnect" = the server kicked us (session revoked); session.revoked handles that.
      connection.setSocket('reconnecting');
      if (reason === 'io server disconnect') this.scheduleManualReconnect(socket);
    });

    socket.on('connect_error', (error: Error & { data?: { code?: string } }) => {
      if (this.socket !== socket) return;
      connection.setSocket(this.readyCount > 0 ? 'reconnecting' : 'connecting');
      const code = error.data?.code;
      if (code === 'ACCOUNT_DISABLED') {
        useAuthStore.getState().handleAuthFailure('disabled');
        return;
      }
      // 0.7.0: this app version is too old for the server: no retries, the update screen takes over.
      if (code === 'CLIENT_OUTDATED') {
        useUiStore.setState({ updateRequired: true });
        socket.io.reconnection(false);
        socket.disconnect();
        return;
      }
      if (socket.active) return; // transport error: Socket.IO keeps retrying on its own
      // Middleware rejection (e.g. expired token): refresh, then reconnect manually.
      if (code === 'UNAUTHORIZED' && this.authRetries < 3) {
        this.authRetries += 1;
        refreshAccessToken().then(
          (token) => {
            if (token && this.socket === socket) this.scheduleManualReconnect(socket, 0);
          },
          () => {
            this.scheduleManualReconnect(socket);
          },
        );
        return;
      }
      this.scheduleManualReconnect(socket);
    });

    socket.on('ready', ({ user, presence }) => {
      void useEmojiStore.getState().load();
      const isReconnect = this.readyCount > 0;
      this.readyCount += 1;
      useAuthStore.getState().setUser(user);
      usePresenceStore.getState().applySnapshot(presence);
      if (isReconnect) {
        void useChatStore.getState().resync();
        void useReadStore
          .getState()
          .load()
          .catch(() => undefined);
      }
      const vs = this.voiceState;
      if (vs.deafened || vs.muted || vs.screen || vs.camera) socket.emit('voice.state', vs);
      for (const id of this.watching) this.emitWatch(id, true);
      if (this.idle) socket.emit('presence.idle', { idle: true });
      if (this.activity) socket.emit('activity.set', activityPayload(this.activity));
      if (this.voiceChannel) socket.emit('voice.presence', { channelId: this.voiceChannel });
    });
    // 0.4.2: one canonical membership map (channel -> user id -> participant), server-authoritative.
    const self = () => useAuthStore.getState().user?.id ?? null;
    socket.on('voice.sessions', ({ sessions }) => {
      useVoiceStore.setState((state) => applyVoiceSessions(state, sessions, true, self()));
    });
    socket.on('voice.session', (session) => {
      useVoiceStore.setState((state) => applyVoiceSessions(state, [session], false, self()));
    });
    socket.on('voice.participant.joined', ({ channelId, participant }) => {
      useVoiceStore.setState((state) => applyMemberJoined(state, channelId, participant, self()));
    });
    socket.on('voice.participant.left', ({ channelId, userId }) => {
      useVoiceStore.setState((state) => applyMemberLeft(state, channelId, userId, self()));
    });
    socket.on('voice.participant.moved', ({ fromChannelId, channelId, participant }) => {
      useVoiceStore.setState((state) => applyMemberMoved(state, fromChannelId, channelId, participant, self()));
    });
    socket.on('voice.states', ({ deafened, states }) => {
      // 0.5.0: a full snapshot after (re)connecting replaces what we knew (no stale icons).
      const memberStates = Object.fromEntries((states ?? []).map((s) => [s.userId, { muted: s.muted, deafened: s.deafened, screen: s.screen, camera: s.camera }] as const));
      useVoiceStore.setState({ deafenedUsers: Object.fromEntries(deafened.map((id) => [id, true] as const)), memberStates });
    });
    socket.on('voice.state', ({ userId, deafened, muted = false, screen = false, camera = false }) => {
      const { deafenedUsers, memberStates } = useVoiceStore.getState();
      const { [userId]: _removed, ...rest } = deafenedUsers;
      useVoiceStore.setState({
        deafenedUsers: deafened ? { ...rest, [userId]: true } : rest,
        memberStates: applyMemberState(memberStates, userId, { muted, deafened, screen, camera }),
      });
    });
    socket.on('stream.viewers', ({ streamerId, source, viewers, change }) => {
      const key = streamKey(streamerId, source);
      const state = useVoiceStore.getState();
      const selfId = useAuthStore.getState().user?.id;
      const { [key]: _old, ...rest } = state.streamViewers;
      const streamViewers = viewers.length > 0 ? { ...rest, [key]: viewers } : rest;
      // The streamer and the people watching this same stream hear who comes and goes; never yourself.
      const involved = streamerId === selfId || state.watchedShares.includes(key);
      if (change && change.userId !== selfId && involved) {
        playSound(change.joined ? 'viewerJoin' : 'viewerLeave');
        useVoiceStore.setState({ streamViewers, viewerEvents: { ...state.viewerEvents, [key]: { ...change, at: Date.now() } } });
      } else {
        useVoiceStore.setState({ streamViewers });
      }
    });

    socket.on('message.created', (message) => {
      const selfId = useAuthStore.getState().user?.id ?? null;
      useChatStore.getState().applyCreated(message, selfId);
      useReadStore.getState().onMessage(message, selfId);
      notifyNewMessage(message);
      overlayMessage(message);
      speakIfTts(message);
    });
    socket.on('message.reactions', (event) => {
      useChatStore.getState().applyReactions(event);
    });
    socket.on('channels.changed', ({ scope, guildId }) => {
      const reload = scope === 'dms' ? useChatStore.getState().loadDms() : guildId ? useGuildStore.getState().refreshChannels(guildId) : useGuildStore.getState().loadGuilds();
      void reload
        .then(() => {
          leaveIfChannelGone();
          return useReadStore.getState().load();
        })
        .catch(() => undefined);
    });
    socket.on('announcement', ({ announcement }) => {
      useAnnouncementStore.getState().set(announcement);
    });
    socket.on('roles.changed', ({ guildId }) => {
      // Roles, my permissions and channel visibility of that server may have changed.
      const guilds = useGuildStore.getState();
      void Promise.all([guilds.refreshRoles(guildId), guilds.refreshMe(guildId), guilds.refreshChannels(guildId), guilds.refreshMembers(guildId)])
        .then(() => leaveIfChannelGone())
        .catch(() => undefined);
    });
    socket.on('emojis.changed', () => {
      void useEmojiStore.getState().load();
    });
    // 0.7.1 soundboard.
    socket.on('voice.sound', (event) => {
      useSoundboardStore.getState().heard(event);
    });
    socket.on('games.changed', ({ userId }) => {
      forgetShelf(userId);
    });
    socket.on('sounds.changed', ({ guildId }) => {
      useSoundboardStore.getState().changed(guildId);
    });
    // ---- 0.7.0 servers and friends -----------------------------------------------------------
    socket.on('guild.joined', (guild) => {
      useGuildStore.getState().applyGuild(guild);
      void useGuildStore
        .getState()
        .refreshChannels(guild.id)
        .catch(() => undefined);
      void useEmojiStore.getState().load();
    });
    socket.on('guild.updated', (guild) => {
      useGuildStore.getState().applyGuild(guild);
    });
    socket.on('guild.deleted', ({ guildId }) => {
      loseGuild(guildId, 'deleted');
    });
    socket.on('guild.member.added', ({ guildId, member }) => {
      useGuildStore.getState().applyMember(guildId, member);
    });
    socket.on('guild.member.updated', ({ guildId, member }) => {
      useGuildStore.getState().applyMember(guildId, member);
    });
    socket.on('guild.member.removed', ({ guildId, userId, reason }) => {
      if (userId === useAuthStore.getState().user?.id) loseGuild(guildId, reason);
      else useGuildStore.getState().dropMember(guildId, userId);
    });
    socket.on('friends.changed', () => {
      void useFriendsStore
        .getState()
        .load()
        .catch(() => undefined);
      void usersApi
        .list()
        .then(({ users }) => usePresenceStore.getState().setUsers(users))
        .catch(() => undefined);
    });
    // 0.7.1: the superadmin panel reloads its voice server list.
    socket.on('voice-nodes.changed', () => {
      window.dispatchEvent(new Event('aidis:voice-nodes-changed'));
    });
    socket.on('voice.server_state', ({ guildId, userId, muted, deafened }) => {
      useVoiceStore.setState((s) => ({ serverStates: { ...s.serverStates, [`${guildId}:${userId}`]: { muted, deafened } } }));
      if (userId === useAuthStore.getState().user?.id) voice.applyServerState(guildId, { muted, deafened });
    });
    socket.on('read.updated', (state) => {
      useReadStore.getState().apply(state);
    });
    socket.on('voice.move', ({ channelId, rejoin }) => {
      void voice.followMove(channelId, rejoin === true);
    });
    socket.on('call.ring', ({ channelId, fromUserId }) => {
      useCallStore.getState().ring(channelId, fromUserId);
    });
    socket.on('message.updated', (message) => {
      useChatStore.getState().applyUpdated(message);
    });
    socket.on('message.deleted', (event) => {
      useChatStore.getState().applyDeleted(event);
    });
    socket.on('presence.updated', (presence) => {
      usePresenceStore.getState().applyPresence(presence);
    });
    socket.on('typing.started', ({ channelId, userId, expiresInMs }) => {
      if (userId === useAuthStore.getState().user?.id) return;
      useChatStore.getState().typingStarted(channelId, userId, expiresInMs);
    });
    socket.on('typing.stopped', ({ channelId, userId }) => {
      useChatStore.getState().typingStopped(channelId, userId);
    });
    socket.on('user.updated', (user) => {
      // New avatar = new attachment id = new URL: every Avatar re-renders with the fresh image.
      usePresenceStore.getState().upsertUser(user);
      if (user.id === useAuthStore.getState().user?.id) useAuthStore.getState().setUser(user);
    });
    socket.on('session.revoked', ({ reason }) => {
      useAuthStore.getState().handleAuthFailure(reason);
    });
  }

  private scheduleManualReconnect(socket: AppSocket, delayMs = 5000): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.socket === socket && !socket.connected) socket.connect();
    }, delayMs);
  }
}

export const realtime = new RealtimeClient();
