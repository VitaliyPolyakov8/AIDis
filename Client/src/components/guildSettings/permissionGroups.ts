import { CHANNEL_PERMISSIONS, type Permission } from '../../api/types';

export type PermissionGroupId = 'general' | 'members' | 'text' | 'voice';

export interface PermissionGroup {
  id: PermissionGroupId;
  permissions: Permission[];
}

/** Role editor groups (Discord-like). Names: perms.groups.<id>, each permission: admin.perms.<P>.name / .hint. */
export const PERMISSION_GROUPS: readonly PermissionGroup[] = [
  { id: 'general', permissions: ['ADMINISTRATOR', 'VIEW_CHANNEL', 'MANAGE_GUILD', 'MANAGE_ROLES', 'MANAGE_CHANNELS', 'VIEW_AUDIT_LOG', 'CREATE_EMOJIS', 'MANAGE_EMOJIS', 'CREATE_SOUNDS', 'MANAGE_SOUNDS'] },
  { id: 'members', permissions: ['CREATE_INVITE', 'CHANGE_NICKNAME', 'MANAGE_NICKNAMES', 'KICK_MEMBERS', 'BAN_MEMBERS'] },
  { id: 'text', permissions: ['SEND_MESSAGES', 'READ_MESSAGE_HISTORY', 'ATTACH_FILES', 'EMBED_LINKS', 'ADD_REACTIONS', 'MENTION_EVERYONE', 'MANAGE_MESSAGES', 'SEND_TTS', 'SEND_VOICE_MESSAGES'] },
  { id: 'voice', permissions: ['CONNECT_VOICE', 'SPEAK', 'STREAM', 'MUTE_MEMBERS', 'DEAFEN_MEMBERS', 'MOVE_USERS', 'DISCONNECT_USERS', 'USE_SOUNDBOARD'] },
];

/** The groups for channel / category overwrites: only permissions that mean something in a channel. */
export function channelPermissionGroups(): PermissionGroup[] {
  return PERMISSION_GROUPS.map((g) => ({ id: g.id, permissions: g.permissions.filter((p) => CHANNEL_PERMISSIONS.includes(p)) })).filter((g) => g.permissions.length > 0);
}
