import type { PublicUser } from '../users/user.dto.js';
import type { MessageView, ReactionView } from '../messages/message.dto.js';
import type { ReadStateView } from '../reads/reads.service.js';
import type { VoiceMemberEvent, VoiceSessionView } from '../voice/voice-sessions.js';
import type { StreamViewersEvent } from '../voice/voice-states.js';
import type { AnnouncementView } from '../admin/settings.service.js';
import type { GuildView, MemberView, MyGuildView } from '../guilds/guild.dto.js';

/** 0.7.0: why a member left a server. */
export type MemberRemovedReason = 'left' | 'kicked' | 'banned';

/**
 * Realtime protocol (Socket.IO). Event names are part of the public client contract.
 *
 * Server -> client:
 *   ready              { user, presence }                 sent once after a successful connection
 *   message.created    MessageView
 *   message.updated    MessageView
 *   message.deleted    { id, channelId, deletedAt }
 *   presence.updated   PresenceView
 *   typing.started     { channelId, userId, expiresInMs }
 *   typing.stopped     { channelId, userId }
 *   session.revoked    { reason }                          sent right before the server disconnects the socket
 *   user.updated       PublicUser
 *   voice.states       { deafened: userId[], states }      sent once after ready: who is deafened / muted /
 *                                                          streaming right now (0.5.0: states)
 *   voice.state        { userId, deafened, muted, screen, camera }  a user's voice state changed
 *
 * Client -> server:
 *   typing.start       { channelId }
 *   typing.stop        { channelId }
 *   voice.state        { deafened, muted?, screen?, camera? }  own voice state while in a voice call
 *   presence.idle      { idle }                            desktop: no input for a while (automatic Away)
 *   activity.set       { name | null }                     desktop: resolved game name, or null when it closed
 *
 * 0.4.0 (server -> client):
 *   message.reactions  { messageId, channelId, reactions }  a message's reactions changed
 *   channels.changed   { scope: 'channels' | 'dms' }        refetch the channel / DM list (visibility is per user)
 *   roles.changed      {}                                   roles, role members or badges changed: refetch
 *   read.updated       ReadStateView                        own read state changed on another device
 *   voice.move         { channelId }                        an admin moved you: join this voice channel
 *   call.ring          { channelId, fromUserId }            someone started a call in a DM you are in
 *
 * 0.4.1:
 *   voice.sessions     { sessions: VoiceSessionView[] }     sent once after ready: occupied voice channels
 *   voice.session      VoiceSessionView                     a channel's participants or session changed
 *                                                           (startedAt null = the channel is empty now)
 *   client -> server   voice.presence { channelId | null }  joined / left a voice channel: a hint that
 *                                                           makes the server re-read that LiveKit room
 *   activity.set       also takes steamAppId and startedAt (see activityPayload in the gateway)
 *
 * 0.4.2:
 *   voice.participant.joined  { channelId, participant }
 *   voice.participant.left    { channelId, userId }
 *   voice.participant.moved   { fromChannelId, channelId, participant }
 *   client -> server   voice.sync {}   asks for a fresh voice.sessions snapshot (LiveKit reconnect,
 *                                      app resume, channel switch); rate-limited per connection
 *
 * 0.5.0:
 *   voice.state / voice.states carry muted / screen / camera as well, so people outside a voice
 *   channel see the same icons as people inside it (no LiveKit join needed).
 *   client -> server   stream.watch { streamerId, source: 'screen' | 'camera', watching }
 *   stream.viewers     { streamerId, source, viewers: userId[], change: { userId, joined } | null }
 *                      only to the streamer and that stream's viewers; a viewer who stops watching
 *                      stays listed for a 4 s grace period (reconnects, pop-out moves, re-subscribes)
 *
 * 0.5.1:
 *   handshake auth { token, platform: 'desktop' | 'web' | 'android' | 'ios' } (cosmetic only)
 *   0.5.8: handshake auth may also carry `version` (the client's app version, shown to admins)
 *   0.5.8 server -> client: announcement { announcement | null }  the admin banner changed
 *   presence.updated / ready presence carry `platforms` (active client kinds; a closed client's
 *   icon goes after a 5 s grace so reconnects and page reloads do not flicker)
 *
 * Message, typing, reaction and voice session events only go to users who can see the channel.
 */

/** What others see (0.3.0). Invisible users are 'offline'. */
export type PresenceState = 'online' | 'away' | 'dnd' | 'offline';

export interface CustomStatusView {
  text: string;
  expiresAt: string | null;
  /** 0.4.0: optional emoji shown before the text. */
  emoji?: string | null;
}

/** A resolved, safe activity name only (never a process list, path or command line). */
export interface ActivityView {
  type: 'playing';
  name: string;
  /** 0.4.1: when this game started (set on none -> game and on game A -> game B, never on re-scans). */
  startedAt?: string;
  /** 0.4.1: Steam AppID when known, so every client can show the official Steam artwork. */
  steamAppId?: number | null;
}

/** 0.5.1: which kind of client a connection is (cosmetic presence metadata, never trusted for auth). */
export const CLIENT_PLATFORMS = ['desktop', 'web', 'android', 'ios'] as const;
export type ClientPlatform = (typeof CLIENT_PLATFORMS)[number];

export interface PresenceView {
  userId: string;
  /** 0.2.x field, kept for older clients: 'online' for online / away / dnd. */
  status: 'online' | 'offline';
  state: PresenceState;
  /** null in an update = unchanged since the last event. */
  lastSeenAt: string | null;
  customStatus: CustomStatusView | null;
  activity: ActivityView | null;
  /**
   * 0.5.1: the kinds of clients the user is connected with right now (a set: desktop + web +
   * android can be active together). Empty while offline / invisible.
   */
  platforms: ClientPlatform[];
}

export interface MessageDeletedEvent {
  id: string;
  channelId: string;
  deletedAt: string;
}

export interface TypingStartedEvent {
  channelId: string;
  userId: string;
  expiresInMs: number;
}

export interface TypingStoppedEvent {
  channelId: string;
  userId: string;
}

/** Deafen ("headphones off") is local to the client; this is how other people see it. 0.5.0: + mic / streams. */
export interface VoiceStateEvent {
  userId: string;
  deafened: boolean;
  muted: boolean;
  screen: boolean;
  camera: boolean;
}

export interface ReactionsUpdatedEvent {
  messageId: string;
  channelId: string;
  reactions: ReactionView[];
}

export interface ServerToClientEvents {
  ready: (payload: { user: PublicUser; presence: PresenceView[] }) => void;
  'message.created': (payload: MessageView) => void;
  'message.updated': (payload: MessageView) => void;
  'message.deleted': (payload: MessageDeletedEvent) => void;
  'presence.updated': (payload: PresenceView) => void;
  'typing.started': (payload: TypingStartedEvent) => void;
  'typing.stopped': (payload: TypingStoppedEvent) => void;
  'session.revoked': (payload: { reason: string }) => void;
  /** Public profile changed (display name, avatar): clients update every place showing this user. */
  'user.updated': (payload: PublicUser) => void;
  'voice.states': (payload: { deafened: string[]; states: VoiceStateEvent[] }) => void;
  'stream.viewers': (payload: StreamViewersEvent) => void;
  'voice.state': (payload: VoiceStateEvent) => void;
  'message.reactions': (payload: ReactionsUpdatedEvent) => void;
  /** guildId: the server whose channel list changed (absent for DMs). */
  'channels.changed': (payload: { scope: 'channels' | 'dms'; guildId?: string }) => void;
  'roles.changed': (payload: { guildId: string }) => void;
  'emojis.changed': (payload: { guildId: string }) => void;
  /** 0.7.1 */
  'sounds.changed': (payload: { guildId: string }) => void;
  /** Game tracker: someone's game list changed. */
  'games.changed': (payload: { userId: string }) => void;
  'voice.sound': (payload: { channelId: string; soundId: string; userId: string }) => void;
  /** 0.7.0 servers: joined / created (to the user's own devices), changed, deleted. */
  'guild.joined': (payload: MyGuildView) => void;
  'guild.updated': (payload: GuildView) => void;
  'guild.deleted': (payload: { guildId: string }) => void;
  'guild.member.added': (payload: { guildId: string; member: MemberView }) => void;
  'guild.member.updated': (payload: { guildId: string; member: MemberView }) => void;
  'guild.member.removed': (payload: { guildId: string; userId: string; reason: MemberRemovedReason }) => void;
  /** 0.7.0: friends or friend requests changed (refetch GET /friends). */
  'friends.changed': (payload: Record<string, never>) => void;
  /** 0.7.0: integrations of a server changed (refetch GET /me/integrations). */
  /** 0.7.0: a moderator server-muted / server-deafened someone on this server (deafen: the client must go silent). */
  'voice.server_state': (payload: { guildId: string; userId: string; muted: boolean; deafened: boolean }) => void;
  'read.updated': (payload: ReadStateView) => void;
  'voice.move': (payload: { channelId: string; rejoin?: boolean }) => void;
  'call.ring': (payload: { channelId: string; fromUserId: string }) => void;
  'voice.sessions': (payload: { sessions: VoiceSessionView[] }) => void;
  'voice.session': (payload: VoiceSessionView) => void;
  'voice.participant.joined': (payload: { channelId: string; participant: VoiceSessionView['participants'][number] }) => void;
  'voice.participant.left': (payload: { channelId: string; userId: string }) => void;
  'voice.participant.moved': (payload: { fromChannelId: string; channelId: string; participant: VoiceSessionView['participants'][number] }) => void;
  /** 0.5.8: the announcement banner changed (null = removed). */
  announcement: (payload: { announcement: AnnouncementView | null }) => void;
  'voice-nodes.changed': (payload: Record<string, never>) => void;
}

export interface ClientToServerEvents {
  'typing.start': (payload: unknown) => void;
  'typing.stop': (payload: unknown) => void;
  'voice.state': (payload: unknown) => void;
  'presence.idle': (payload: unknown) => void;
  'activity.set': (payload: unknown) => void;
  'voice.presence': (payload: unknown) => void;
  'voice.sync': (payload: unknown) => void;
  'stream.watch': (payload: unknown) => void;
  /** 0.7.1 soundboard press; the ack says whether it was played. */
  'voice.sound.play': (payload: unknown, ack?: (result: { ok: true } | { ok: false; code: string }) => void) => void;
}

/**
 * What domain services use to publish events. Implemented by the Socket.IO
 * gateway; a no-op implementation is used by the CLI.
 */
export interface EventPublisher {
  messageCreated(message: MessageView): void;
  messageUpdated(message: MessageView): void;
  messageDeleted(event: MessageDeletedEvent): void;
  userUpdated(user: PublicUser): void;
  /** A user's presence (status, custom status, activity) changed. */
  presenceUpdated(presence: PresenceView): void;
  reactionsUpdated(event: ReactionsUpdatedEvent): void;
  /** Channel list changed (create / rename / delete / reorder / access). userIds: only these users (DMs); guildId: that server's members. */
  channelsChanged(scope: 'channels' | 'dms', userIds?: string[], guildId?: string): void;
  rolesChanged(guildId: string): void;
  emojisChanged(guildId: string): void;
  /** 0.7.1 */
  soundsChanged(guildId: string): void;
  gamesChanged(userId: string): void;
  /** 0.7.0 servers (userIds = who receives it, computed by the caller after the change). */
  guildJoined(userId: string, guild: MyGuildView): void;
  guildUpdated(guild: GuildView, userIds: string[]): void;
  guildDeleted(guildId: string, userIds: string[]): void;
  memberAdded(guildId: string, member: MemberView, userIds: string[]): void;
  memberUpdated(guildId: string, member: MemberView, userIds: string[]): void;
  memberRemoved(guildId: string, userId: string, reason: MemberRemovedReason, userIds: string[]): void;
  friendsChanged(userIds: string[]): void;
  voiceServerState(guildId: string, userId: string, flags: { muted: boolean; deafened: boolean }): void;
  readUpdated(userId: string, state: ReadStateView): void;
  /** rejoin (0.5.9): LiveKit could not move the connection; the client must join the new room itself. */
  voiceMove(userId: string, channelId: string, rejoin?: boolean): void;
  callRing(channelId: string, fromUserId: string, userIds: string[]): void;
  /** 0.4.1: a voice channel's participants or session start changed. */
  voiceSession(session: VoiceSessionView): void;
  /** 0.4.2: one participant joined / left / moved between voice channels. */
  voiceMember(event: VoiceMemberEvent): void;
  /** Visibility changed (roles, private channels, DMs): realtime routing must be recomputed. */
  accessChanged(): void;
  /** Disconnects realtime connections of one session (e.g. logout, revoke). */
  disconnectSession(sessionId: string, reason: string): void;
  /** Disconnects all realtime connections of a user (e.g. logout-all, account disabled). */
  disconnectUser(userId: string, reason: string): void;
  /** 0.5.8: the admin changed the announcement banner. */
  announcementChanged(announcement: AnnouncementView | null): void;
  /** 0.7.1: the superadmins' voice server list changed. */
  voiceNodesChanged(): void;
}

export const noopPublisher: EventPublisher = {
  messageCreated: () => undefined,
  messageUpdated: () => undefined,
  messageDeleted: () => undefined,
  userUpdated: () => undefined,
  presenceUpdated: () => undefined,
  reactionsUpdated: () => undefined,
  channelsChanged: () => undefined,
  rolesChanged: () => undefined,
  emojisChanged: () => undefined,
  soundsChanged: () => undefined,
  gamesChanged: () => undefined,
  guildJoined: () => undefined,
  guildUpdated: () => undefined,
  guildDeleted: () => undefined,
  memberAdded: () => undefined,
  memberUpdated: () => undefined,
  memberRemoved: () => undefined,
  friendsChanged: () => undefined,
  voiceServerState: () => undefined,
  readUpdated: () => undefined,
  voiceMove: () => undefined,
  callRing: () => undefined,
  voiceSession: () => undefined,
  voiceMember: () => undefined,
  accessChanged: () => undefined,
  disconnectSession: () => undefined,
  disconnectUser: () => undefined,
  announcementChanged: () => undefined,
  voiceNodesChanged: () => undefined,
};
