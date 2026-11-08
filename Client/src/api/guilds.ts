import { request } from './client';
import { getLanguage } from '../i18n';
import type { AuditEntry, BanView, Channel, ChannelType, GuildView, MemberView, MyGuildView, NotifyMode, Permission, RoleView, ServerEmoji, VoiceLayout } from './types';

export interface GuildPatch {
  name?: string;
  iconAttachmentId?: string | null;
  bannerAttachmentId?: string | null;
  systemChannelId?: string | null;
  defaultNotifyMode?: NotifyMode;
}

export interface MemberProfilePatch {
  nickname?: string | null;
  avatarAttachmentId?: string | null;
  bannerAttachmentId?: string | null;
  bio?: string | null;
}

export interface NewChannelInput {
  type: Exclude<ChannelType, 'DM'>;
  name: string;
  description?: string | null;
  parentId?: string | null;
  voiceBitrate?: number;
  voiceLayout?: VoiceLayout;
  /** 0.7.1 */
  voiceNodeId?: string | null;
}

export interface RoleInput {
  name?: string;
  color?: string | null;
  permissions?: Permission[];
  hoist?: boolean;
  mentionable?: boolean;
}

export interface ChannelOrderItem {
  id: string;
  parentId: string | null;
  position: number;
}

const g = (guildId: string, rest = '') => `/api/v1/guilds/${encodeURIComponent(guildId)}${rest}`;

/** 0.7.0 servers (Server/src/guilds, roles, channels routes). */
export const guildsApi = {
  list(): Promise<{ guilds: MyGuildView[] }> {
    return request('/api/v1/guilds');
  },
  create(name: string): Promise<{ guild: MyGuildView }> {
    // The default channels of a new server are named in the creator's language.
    return request('/api/v1/guilds', { method: 'POST', body: { name, lang: getLanguage() } });
  },
  get(guildId: string): Promise<{ guild: MyGuildView }> {
    return request(g(guildId));
  },
  update(guildId: string, patch: GuildPatch): Promise<{ guild: GuildView }> {
    return request(g(guildId), { method: 'PATCH', body: patch });
  },
  remove(guildId: string, confirmName: string): Promise<void> {
    return request(g(guildId), { method: 'DELETE', body: { confirmName } });
  },
  transfer(guildId: string, userId: string): Promise<{ guild: GuildView }> {
    return request(g(guildId, '/transfer'), { method: 'POST', body: { userId } });
  },
  leave(guildId: string): Promise<void> {
    return request(g(guildId, '/members/me'), { method: 'DELETE' });
  },
  members(guildId: string): Promise<{ members: MemberView[] }> {
    return request(g(guildId, '/members'));
  },
  updateMyProfile(guildId: string, patch: MemberProfilePatch): Promise<{ member: MemberView }> {
    return request(g(guildId, '/members/me/profile'), { method: 'PATCH', body: patch });
  },
  updateMySettings(guildId: string, settings: { notifyMode: NotifyMode | null }): Promise<void> {
    return request(g(guildId, '/members/me/settings'), { method: 'PATCH', body: settings });
  },
  setOrder(guildIds: string[]): Promise<void> {
    return request('/api/v1/me/guild-order', { method: 'PUT', body: { guildIds } });
  },
  permissions(guildId: string, channelId?: string): Promise<{ permissions: Permission[]; all: Permission[] }> {
    return request(g(guildId, '/permissions'), { query: { channelId } });
  },
  // ---- channels ----
  channels(guildId: string): Promise<{ channels: Channel[] }> {
    return request(g(guildId, '/channels'));
  },
  createChannel(guildId: string, input: NewChannelInput): Promise<{ channel: Channel }> {
    return request(g(guildId, '/channels'), { method: 'POST', body: input });
  },
  reorderChannels(guildId: string, items: ChannelOrderItem[]): Promise<void> {
    return request(g(guildId, '/channels/order'), { method: 'PUT', body: { items } });
  },
  // ---- roles ----
  roles(guildId: string): Promise<{ roles: RoleView[] }> {
    return request(g(guildId, '/roles'));
  },
  createRole(guildId: string, input: RoleInput & { name: string }): Promise<{ role: RoleView }> {
    return request(g(guildId, '/roles'), { method: 'POST', body: input });
  },
  updateRole(guildId: string, roleId: string, input: RoleInput): Promise<{ role: RoleView }> {
    return request(g(guildId, `/roles/${encodeURIComponent(roleId)}`), { method: 'PATCH', body: input });
  },
  deleteRole(guildId: string, roleId: string): Promise<void> {
    return request(g(guildId, `/roles/${encodeURIComponent(roleId)}`), { method: 'DELETE' });
  },
  /** Role ids from the lowest to the highest (only roles below mine move). */
  reorderRoles(guildId: string, ids: string[]): Promise<void> {
    return request(g(guildId, '/roles/order'), { method: 'PUT', body: { ids } });
  },
  setMemberRoles(guildId: string, userId: string, roleIds: string[]): Promise<{ roleIds: string[] }> {
    return request(g(guildId, `/members/${encodeURIComponent(userId)}/roles`), { method: 'PUT', body: { roleIds } });
  },
  // ---- moderation ----
  setNickname(guildId: string, userId: string, nickname: string | null): Promise<{ member: MemberView }> {
    return request(g(guildId, `/members/${encodeURIComponent(userId)}`), { method: 'PATCH', body: { nickname } });
  },
  kick(guildId: string, userId: string): Promise<void> {
    return request(g(guildId, `/members/${encodeURIComponent(userId)}`), { method: 'DELETE' });
  },
  bans(guildId: string): Promise<{ bans: BanView[] }> {
    return request(g(guildId, '/bans'));
  },
  ban(guildId: string, userId: string, reason?: string): Promise<void> {
    return request(g(guildId, `/bans/${encodeURIComponent(userId)}`), { method: 'PUT', body: reason ? { reason } : {} });
  },
  unban(guildId: string, userId: string): Promise<void> {
    return request(g(guildId, `/bans/${encodeURIComponent(userId)}`), { method: 'DELETE' });
  },
  audit(guildId: string, before?: string): Promise<{ entries: AuditEntry[] }> {
    return request(g(guildId, '/audit'), { query: { before, limit: 50 } });
  },
  // ---- emojis ----
  createEmoji(guildId: string, name: string, file: File): Promise<{ emoji: ServerEmoji }> {
    return request(g(guildId, `/emojis?name=${encodeURIComponent(name)}`), { method: 'POST', body: new Blob([file], { type: 'application/octet-stream' }) });
  },
};
