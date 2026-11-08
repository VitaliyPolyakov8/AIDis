/**
 * 0.7.0 permission catalog (Discord-style, per server). Stored as strings in roles.permissions and
 * permission_overwrites.allow / deny, so new permissions (0.7.1 soundboard) need no data migration.
 */
export const PERMISSIONS = [
  // server
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
  // 0.7.1 soundboard
  'CREATE_SOUNDS',
  'MANAGE_SOUNDS',
  // text
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
  // voice
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

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value);
}

/** Only known permission names, without duplicates. */
export function cleanPermissions(values: readonly string[]): Permission[] {
  return [...new Set(values.filter(isPermission))];
}

/** What @everyone of a new server may do (everything implicitly allowed before 0.7.0). */
export const DEFAULT_EVERYONE: readonly Permission[] = [
  'VIEW_CHANNEL',
  'SEND_MESSAGES',
  'READ_MESSAGE_HISTORY',
  'ATTACH_FILES',
  'EMBED_LINKS',
  'ADD_REACTIONS',
  'SEND_TTS',
  'SEND_VOICE_MESSAGES',
  'CONNECT_VOICE',
  'SPEAK',
  'STREAM',
  'CREATE_INVITE',
  'CHANGE_NICKNAME',
  'USE_SOUNDBOARD',
];

/** Permissions that mean something in a channel / category overwrite. */
export const CHANNEL_SCOPED: ReadonlySet<Permission> = new Set<Permission>([
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
]);

/** What every member of a DM may do there (1:1 sending additionally requires friendship). */
export const DM_PERMISSIONS: readonly Permission[] = [
  'VIEW_CHANNEL',
  'SEND_MESSAGES',
  'READ_MESSAGE_HISTORY',
  'ATTACH_FILES',
  'EMBED_LINKS',
  'ADD_REACTIONS',
  'SEND_TTS',
  'SEND_VOICE_MESSAGES',
  'CONNECT_VOICE',
  'SPEAK',
  'STREAM',
];
