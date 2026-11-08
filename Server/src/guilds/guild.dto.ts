import type { Guild, GuildMember, NotifyMode } from '../generated/prisma/client.js';
import type { Permission } from '../permissions/catalog.js';

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
  me: {
    /** False for a superadmin looking at a server they did not join. */
    member: boolean;
    permissions: Permission[];
    roleIds: string[];
    notifyMode: NotifyMode | null;
    railPosition: number | null;
    profile: MemberProfileView;
  };
}

export function toGuildView(guild: Guild, memberCount: number): GuildView {
  return {
    id: guild.id,
    name: guild.name,
    iconAttachmentId: guild.iconAttachmentId,
    bannerAttachmentId: guild.bannerAttachmentId,
    ownerId: guild.ownerId,
    systemChannelId: guild.systemChannelId,
    defaultNotifyMode: guild.defaultNotifyMode,
    memberCount,
    createdAt: guild.createdAt.toISOString(),
  };
}

export function toMemberProfile(member: Pick<GuildMember, 'nickname' | 'avatarAttachmentId' | 'bannerAttachmentId' | 'bio'> | null): MemberProfileView {
  return {
    nickname: member?.nickname ?? null,
    avatarAttachmentId: member?.avatarAttachmentId ?? null,
    bannerAttachmentId: member?.bannerAttachmentId ?? null,
    bio: member?.bio ?? null,
  };
}

export function toMemberView(member: GuildMember & { roles: { roleId: string }[] }): MemberView {
  return { userId: member.userId, joinedAt: member.joinedAt.toISOString(), roleIds: member.roles.map((r) => r.roleId), ...toMemberProfile(member) };
}
