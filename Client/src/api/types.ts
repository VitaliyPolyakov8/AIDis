/**
 * Shapes returned by the AIDis backend (G:\AIDis\Server, /api/v1).
 * Mirrors the server DTOs exactly; the server is the source of truth.
 */

export type Role = 'ADMIN' | 'USER';
/** 0.7.0: CATEGORY groups a server's channels. */
export type ChannelType = 'TEXT' | 'VOICE' | 'DM' | 'CATEGORY';

/** users/user.dto.ts PublicUser */
/** 0.5.5 name fonts (bundled, all with Cyrillic). Same ids as the server's users/name-styles.ts. */
export const NICKNAME_FONTS = ['unbounded', 'comfortaa', 'lobster', 'caveat', 'press-start', 'russo-one'] as const;
export type NicknameFont = (typeof NICKNAME_FONTS)[number];

/** 0.5.5 voice channel layouts: participant grid, or a 2D room with proximity voice. */
export type VoiceLayout = 'standard' | 'room';

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  avatarAttachmentId: string | null;
  role: Role;
  lastSeenAt: string | null;
  /** 0.4.0 profile (absent on older servers). */
  bannerAttachmentId?: string | null;
  accentColor?: string | null;
  profileFrame?: string | null;
  profileTags?: string[];
  /** 0.5.0: color of this user's name (#rrggbb, readable) or null for the default. */
  nicknameColor?: string | null;
  /** 0.5.1: built-in animated banner / avatar frame ids (cosmetics/catalog.ts). */
  profileBannerId?: string | null;
  avatarFrameId?: string | null;
  /** 0.5.5 profile theme (gradient accentColor -> accentColor2) and name style. */
  accentColor2?: string | null;
  nicknameColor2?: string | null;
  nicknameGlow?: boolean;
  nicknameFont?: NicknameFont | null;
  /** 0.5.5: day and month only. */
  birthday?: { month: number; day: number } | null;
  showRecentGames?: boolean;
  /** 0.7.0: "About me" (a server profile can override it). */
  bio?: string | null;
  /** Badge keys (GET /badges); absent on message authors. 0.7.0: server roles come from GET /guilds/:id/members. */
  badges?: string[];
}

/** auth/auth.service.ts TokenPair (POST /auth/login, POST /auth/refresh) */
export interface TokenPair {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  tokenType: 'Bearer';
  sessionId: string;
  user: PublicUser;
}

/** auth/auth.service.ts SessionView (GET /auth/sessions) */
export interface SessionView {
  id: string;
  clientType: string;
  deviceName: string | null;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  current: boolean;
}

/** channels/channels.service.ts ChannelView */
export interface Channel {
  id: string;
  type: ChannelType;
  name: string;
  description: string | null;
  position: number;
  createdAt: string;
  /** 0.7.0: the server (null for DMs), the category (null = top level), uses the category's overwrites. */
  guildId: string | null;
  parentId: string | null;
  permissionsSynced: boolean;
  protected?: boolean;
  /** 0.7.0: the channel's own overwrites, only for people who may manage it. */
  overwrites?: OverwriteView[];
  /** DMs only. */
  title?: string | null;
  memberIds?: string[];
  ownerId?: string | null;
  lastMessageAt?: string | null;
  /** 0.5.5 voice channels: microphone bitrate for everyone (kbps) and layout. */
  voiceBitrate?: number;
  voiceLayout?: VoiceLayout;
  /** 0.7.1 voice channels: the extra voice server, null = the main one. */
  voiceNodeId?: string | null;
}

/** Game tracker (GET /users/:id/games). */
export type GameStatus = 'PLAYING' | 'COMPLETED' | 'HUNDRED' | 'DROPPED' | 'PAUSED';
export type GamePlatform = 'PC' | 'PLAYSTATION' | 'XBOX' | 'SWITCH' | 'MOBILE' | 'OTHER';
export interface GameView {
  id: string;
  name: string;
  platform: GamePlatform;
  status: GameStatus;
  /** Added by hand (else found on the PC by the desktop app). */
  manual: boolean;
  steamAppId: number | null;
  totalSeconds: number;
  sessions: number;
  firstPlayedAt: string;
  lastPlayedAt: string;
  coverAttachmentId: string | null;
}

/** attachments/attachment.dto.ts AttachmentView */
export interface Attachment {
  id: string;
  uploaderId: string;
  messageId: string | null;
  originalName: string;
  mimeType: string;
  size: number;
  createdAt: string;
  /** Relative URL; requires the Bearer token. */
  url: string;
}

/** messages/message.dto.ts MessageView */
export interface Message {
  id: string;
  channelId: string;
  author: PublicUser;
  content: string;
  nonce: string | null;
  replyToId: string | null;
  attachments: Attachment[];
  createdAt: string;
  updatedAt: string;
  editedAt: string | null;
  edited: boolean;
  /** 0.3.1: link cards and GIFs (absent on older servers). Image URLs are API paths (image proxy). */
  embeds?: Embed[];
  /** 0.4.0 */
  replyTo?: ReplyPreview | null;
  reactions?: ReactionView[];
  mentions?: string[];
  pinnedAt?: string | null;
  pinnedById?: string | null;
  /** 0.5.2: read aloud to the people in the call (absent on older servers). */
  tts?: boolean;
}

/** What a reply shows about the message it answers (computed by the server on read). */
export interface ReplyPreview {
  id: string;
  authorId: string;
  authorName: string;
  content: string;
  deleted: boolean;
  hasAttachments: boolean;
}

export interface ReactionView {
  emoji: string;
  count: number;
  userIds: string[];
}

export type NotifyMode = 'ALL' | 'MENTIONS' | 'NONE';

/** reads/reads.service.ts ReadStateView */
export interface ReadState {
  channelId: string;
  lastReadAt: string;
  unread: number;
  mentions: number;
  /** The channel's own setting (null = inherit). */
  notifyMode: NotifyMode | null;
  /** 0.7.0: what applies (channel -> my server setting -> server default -> ALL) and the channel's server. */
  effectiveNotifyMode?: NotifyMode;
  guildId?: string | null;
}

/** Server/src/permissions/catalog.ts PERMISSIONS (same order). */
export const PERMISSIONS = [
  'ADMINISTRATOR',
  'MANAGE_GUILD',
  'MANAGE_ROLES',
  'MANAGE_CHANNELS',
  'KICK_MEMBERS',
  'BAN_MEMBERS',
  'CREATE_INVITE',
  'CHANGE_NICKNAME',
  'MANAGE_NICKNAMES',
  'VIEW_AUDIT_LOG',
  'CREATE_EMOJIS',
  'MANAGE_EMOJIS',
  'CREATE_SOUNDS',
  'MANAGE_SOUNDS',
  'VIEW_CHANNEL',
  'SEND_MESSAGES',
  'READ_MESSAGE_HISTORY',
  'ATTACH_FILES',
  'EMBED_LINKS',
  'ADD_REACTIONS',
  'MENTION_EVERYONE',
  'MANAGE_MESSAGES',
  'SEND_TTS',
  'SEND_VOICE_MESSAGES',
  'CONNECT_VOICE',
  'SPEAK',
  'STREAM',
  'MUTE_MEMBERS',
  'DEAFEN_MEMBERS',
  'MOVE_USERS',
  'DISCONNECT_USERS',
  'USE_SOUNDBOARD',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Server CHANNEL_SCOPED: permissions that mean something in a channel / category overwrite. */
export const CHANNEL_PERMISSIONS: readonly Permission[] = [
  'MANAGE_CHANNELS',
  'MANAGE_ROLES',
  'CREATE_INVITE',
  'VIEW_CHANNEL',
  'SEND_MESSAGES',
  'READ_MESSAGE_HISTORY',
  'ATTACH_FILES',
  'EMBED_LINKS',
  'ADD_REACTIONS',
  'MENTION_EVERYONE',
  'MANAGE_MESSAGES',
  'SEND_TTS',
  'SEND_VOICE_MESSAGES',
  'CONNECT_VOICE',
  'SPEAK',
  'STREAM',
  'MUTE_MEMBERS',
  'DEAFEN_MEMBERS',
  'MOVE_USERS',
  'DISCONNECT_USERS',
  'USE_SOUNDBOARD',
];

export interface OverwriteView {
  targetType: 'ROLE' | 'MEMBER';
  targetId: string;
  allow: Permission[];
  deny: Permission[];
}

export interface ServerEmoji {
  id: string;
  /** 0.7.0: the server it belongs to (members can use it everywhere). */
  guildId: string;
  name: string;
  width: number;
  height: number;
  animated: boolean;
  createdById: string;
  createdAt: string;
}

/** roles/roles.service.ts RoleView (0.7.0, per server). Higher position = higher in the hierarchy. */
export interface RoleView {
  id: string;
  guildId: string;
  name: string;
  color: string | null;
  position: number;
  permissions: Permission[];
  hoist: boolean;
  mentionable: boolean;
  isEveryone: boolean;
  memberCount: number;
}

export interface BadgeView {
  id: string;
  key: string;
  label: string;
  icon: string;
  color: string;
}

export interface AuditEntry {
  id: string;
  /** 0.7.0: null = instance-wide (superadmin) entry. */
  guildId?: string | null;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

export interface EmbedImage {
  url: string;
  width: number | null;
  height: number | null;
}

export interface LinkEmbed {
  type: 'link';
  provider: 'youtube' | 'steam' | 'website';
  url: string;
  siteName: string | null;
  title: string | null;
  description: string | null;
  image: EmbedImage | null;
  author: string | null;
  price: string | null;
  free: boolean;
}

export interface GifEmbed {
  type: 'gif';
  provider: 'klipy' | 'tenor' | 'giphy';
  id: string;
  url: string;
  media: EmbedImage;
  preview: EmbedImage | null;
  title: string | null;
}

export type Embed = LinkEmbed | GifEmbed;

/** A GIF search result (server /api/v1/gifs). */
export interface GifResult {
  provider: 'klipy' | 'tenor' | 'giphy';
  id: string;
  url: string;
  title: string | null;
  media: { url: string; width: number; height: number };
  preview: { url: string; width: number; height: number };
  /** Same images through the AIDis image proxy (what the client displays). */
  previewProxy: string;
  mediaProxy: string;
}

/** messages/messages.service.ts HistoryPage — messages are oldest first. */
export interface HistoryPage {
  messages: Message[];
  hasMore: boolean;
  /** "around" pages: newer messages exist after this page. */
  hasNewer?: boolean;
}

/** What others see (server 0.3.0+). Invisible users are reported as 'offline'. */
export type PresenceState = 'online' | 'away' | 'dnd' | 'offline';

/** The status a user picks for themselves (stored on the server, stable values). */
export type StatusPreference = 'ONLINE' | 'AWAY' | 'DND' | 'INVISIBLE';

export interface CustomStatusView {
  text: string;
  expiresAt: string | null;
  /** 0.4.0 */
  emoji?: string | null;
}

/** A resolved activity name only, e.g. "Helldivers 2". */
export interface ActivityView {
  type: 'playing';
  name: string;
  /** 0.4.1: when this game started (server-authoritative; absent on older servers). */
  startedAt?: string;
  /** 0.4.1: Steam AppID when known (official Steam artwork). */
  steamAppId?: number | null;
}

/** 0.4.1 voice/voice-sessions.ts VoiceSessionView: an occupied voice channel. */
export interface VoiceSessionView {
  channelId: string;
  /** When the channel went from 0 to 1 participant; null = it is empty now. */
  startedAt: string | null;
  participants: VoiceParticipantView[];
}

/** realtime/events.ts PresenceView. state / customStatus / activity are absent on 0.2.x servers. */
export interface PresenceView {
  userId: string;
  status: 'online' | 'offline';
  state?: PresenceState;
  /** null in an update = unchanged. */
  lastSeenAt: string | null;
  customStatus?: CustomStatusView | null;
  activity?: ActivityView | null;
  /** 0.5.1: kinds of clients the user is connected with right now (desktop / web / android / ios). */
  platforms?: ClientPlatform[];
}

export type ClientPlatform = 'desktop' | 'web' | 'android' | 'ios';

export interface OwnStatus {
  status: StatusPreference;
  customStatus: CustomStatusView | null;
}

/** voice/voice.service.ts VoiceTokenResponse */
export interface VoiceTokenResponse {
  url: string;
  token: string;
  roomName: string;
  identity: string;
  channelId: string;
  expiresAt: string;
}

/** voice/voice.service.ts VoiceParticipantView */
export interface VoiceParticipantView {
  identity: string;
  name: string;
  joinedAt: string | null;
}

/** client-version/client-version.ts ReleaseInfo (desktop update metadata) */
export interface ReleaseInfo {
  latestVersion: string;
  minimumVersion: string;
  downloadUrl: string;
  mandatory: boolean;
  releaseNotes: string[];
}

/** Every API error body: { error: { code, message, details? } } */
export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

// ---- Socket.IO contract (realtime/events.ts) ---------------------------------

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

export interface ServerToClientEvents {
  ready: (payload: { user: PublicUser; presence: PresenceView[] }) => void;
  'message.created': (payload: Message) => void;
  'message.updated': (payload: Message) => void;
  'message.deleted': (payload: MessageDeletedEvent) => void;
  'presence.updated': (payload: PresenceView) => void;
  'typing.started': (payload: TypingStartedEvent) => void;
  'typing.stopped': (payload: TypingStoppedEvent) => void;
  'session.revoked': (payload: { reason: string }) => void;
  /** Someone changed their display name or avatar (server 0.2.3+). */
  'user.updated': (payload: PublicUser) => void;
  /** Who is deafened right now, sent after ready (server 0.2.5+). 0.5.0: + everyone's full voice state. */
  'voice.states': (payload: { deafened: string[]; states?: VoiceMemberStateView[] }) => void;
  /** A user deafened / undeafened (server 0.2.5+). 0.5.0: + mic muted, screen stream, camera. */
  'voice.state': (payload: { userId: string; deafened: boolean; muted?: boolean; screen?: boolean; camera?: boolean }) => void;
  /** 0.5.0: viewers of a stream we stream or watch (only sent to the streamer and its viewers). */
  'stream.viewers': (payload: StreamViewersView) => void;
  /** 0.4.0 */
  'message.reactions': (payload: { messageId: string; channelId: string; reactions: ReactionView[] }) => void;
  'channels.changed': (payload: { scope: 'channels' | 'dms'; guildId?: string }) => void;
  'roles.changed': (payload: { guildId: string }) => void;
  'emojis.changed': (payload: { guildId: string }) => void;
  /** 0.7.1 soundboard. */
  'sounds.changed': (payload: { guildId: string }) => void;
  /** Game tracker: someone's list changed. */
  'games.changed': (payload: { userId: string }) => void;
  'voice.sound': (payload: VoiceSoundEvent) => void;
  /** 0.7.0 servers. */
  'guild.joined': (payload: MyGuildView) => void;
  'guild.updated': (payload: GuildView) => void;
  'guild.deleted': (payload: { guildId: string }) => void;
  'guild.member.added': (payload: { guildId: string; member: MemberView }) => void;
  'guild.member.updated': (payload: { guildId: string; member: MemberView }) => void;
  'guild.member.removed': (payload: { guildId: string; userId: string; reason: MemberRemovedReason }) => void;
  'friends.changed': (payload: Record<string, never>) => void;
  'voice.server_state': (payload: { guildId: string; userId: string; muted: boolean; deafened: boolean }) => void;
  'read.updated': (payload: ReadState) => void;
  'voice.move': (payload: { channelId: string; rejoin?: boolean }) => void;
  'call.ring': (payload: { channelId: string; fromUserId: string }) => void;
  /** 0.4.1: occupied voice channels after ready, then one event per change (no polling). */
  'voice.sessions': (payload: { sessions: VoiceSessionView[] }) => void;
  'voice.session': (payload: VoiceSessionView) => void;
  /** 0.4.2 explicit membership changes (applied idempotently). */
  'voice.participant.joined': (payload: { channelId: string; participant: VoiceParticipantView }) => void;
  'voice.participant.left': (payload: { channelId: string; userId: string }) => void;
  'voice.participant.moved': (payload: { fromChannelId: string; channelId: string; participant: VoiceParticipantView }) => void;
  /** 0.5.8: the admin banner changed (null = removed). */
  announcement: (payload: { announcement: Announcement | null }) => void;
  /** 0.7.1 superadmins: the voice server list changed. */
  'voice-nodes.changed': (payload: Record<string, never>) => void;
}

export interface ClientToServerEvents {
  'typing.start': (payload: { channelId: string }) => void;
  'voice.state': (payload: { deafened: boolean; muted: boolean; screen: boolean; camera: boolean }) => void;
  /** 0.5.0: this device started / stopped watching a stream. */
  'stream.watch': (payload: { streamerId: string; source: 'screen' | 'camera'; watching: boolean }) => void;
  'presence.idle': (payload: { idle: boolean }) => void;
  'activity.set': (payload: { name: string | null; steamAppId?: number | null; startedAt?: string | null }) => void;
  /** 0.4.1: joined / left a voice channel (a hint; the server re-reads the LiveKit room). */
  'voice.presence': (payload: { channelId: string | null }) => void;
  /** 0.4.2: ask for a fresh voice.sessions snapshot. */
  'voice.sync': (payload: Record<string, never>) => void;
  'typing.stop': (payload: { channelId: string }) => void;
  /** 0.7.1: a soundboard press; the ack says whether everyone in the channel got it. */
  'voice.sound.play': (payload: { soundId: string }, ack: (result: { ok: true } | { ok: false; code: string }) => void) => void;
}

/** 0.5.0: a user's voice state from the realtime server. */
export interface VoiceMemberStateView {
  userId: string;
  deafened: boolean;
  muted: boolean;
  screen: boolean;
  camera: boolean;
}

/** 0.5.0: who watches one stream (streamer + source). */
export interface StreamViewersView {
  streamerId: string;
  source: 'screen' | 'camera';
  viewers: string[];
  change: { userId: string; joined: boolean } | null;
}

// ---- 0.5.8 admin panel ------------------------------------------------------------------------

export interface Announcement {
  id: string;
  text: string;
  level: 'info' | 'warning';
  updatedAt: string;
}

export interface AdminUser extends PublicUser {
  disabled: boolean;
  /** 0.7.1 (absent from older servers). */
  email?: string | null;
  emailVerifiedAt?: string | null;
  pendingVerification?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdminOverview {
  server: { version: string; node: string; environment: string; startedAt: string; uptimeSeconds: number; memoryMb: number };
  database: { ok: boolean; latencyMs: number | null };
  livekit: { configured: boolean; ok: boolean | null; latencyMs: number | null };
  realtime: { connections: number; users: number };
  counts: { users: number; disabledUsers: number; channels: number; messages: number; files: number; fileBytes: number };
}

export interface AdminConnection {
  userId: string;
  sessionId: string;
  platform: 'desktop' | 'web' | 'android' | 'ios';
  version: string | null;
  connectedAt: string;
}

export interface AdminStorage {
  files: { count: number; bytes: number };
  partial: { count: number; bytes: number; idleOverHour: number };
  disk: { free: number; total: number } | null;
  maxUploadSize: number;
  maxLargeUploadSize: number;
}

export interface AdminFile {
  id: string;
  originalName: string;
  mimeType: string;
  size: number;
  createdAt: string;
  uploader: { id: string; displayName: string };
  messageId: string | null;
  channelId: string | null;
}

// ---- 0.7.0 servers, invites, friends, limits, integrations (Server/src/*/…dto / service views) ----

export type MemberRemovedReason = 'left' | 'kicked' | 'banned';

export interface GuildView {
  id: string;
  name: string;
  iconAttachmentId: string | null;
  bannerAttachmentId: string | null;
  ownerId: string;
  systemChannelId: string | null;
  defaultNotifyMode: NotifyMode;
  memberCount: number;
  createdAt: string;
}

export interface MemberProfileView {
  nickname: string | null;
  avatarAttachmentId: string | null;
  bannerAttachmentId: string | null;
  bio: string | null;
}

export interface MemberView extends MemberProfileView {
  userId: string;
  joinedAt: string;
  roleIds: string[];
}

export interface MyGuildView extends GuildView {
  me: { member: boolean; permissions: Permission[]; roleIds: string[]; notifyMode: NotifyMode | null; railPosition: number | null; profile: MemberProfileView };
}

export interface InviteView {
  code: string;
  guildId: string;
  channelId: string | null;
  creatorId: string;
  maxUses: number | null;
  uses: number;
  expiresAt: string | null;
  createdAt: string;
}

export interface InvitePreview {
  code: string;
  guild: { id: string; name: string; iconAttachmentId: string | null };
  memberCount: number;
  onlineCount: number;
  expiresAt: string | null;
  alreadyMember: boolean;
}

export interface BanView {
  userId: string;
  reason: string | null;
  bannedById: string;
  createdAt: string;
}

export interface FriendsState {
  friends: { userId: string; since: string }[];
  incoming: { userId: string; createdAt: string }[];
  outgoing: { userId: string; createdAt: string }[];
}

export type LimitScope = 'GUILD' | 'USER';
export interface LimitsView {
  catalog: { key: string; scopes: LimitScope[]; default: number; min: number; max: number }[];
  global: Record<string, number>;
  overrides: { key: string; scope: LimitScope; targetId: string; value: number }[];
}

/** 0.7.1 an extra voice server (superadmin view; the API secret is never sent). */
export interface VoiceNodeView {
  id: string;
  name: string;
  url: string;
  apiKey: string;
  enabled: boolean;
  guildIds: string[];
  lastCheckAt: string | null;
  lastCheckStatus: 'ok' | 'unreachable' | 'unauthorized' | null;
}

/** 0.7.1 a server's soundboard sound. */
export interface SoundView {
  id: string;
  guildId: string;
  name: string;
  emoji: string | null;
  /** 0..100 (times each listener's own soundboard volume). */
  volume: number;
  durationMs: number;
  createdById: string;
  createdAt: string;
}

/** 0.7.1: someone in my voice channel pressed a sound. */
export interface VoiceSoundEvent {
  channelId: string;
  soundId: string;
  userId: string;
}
