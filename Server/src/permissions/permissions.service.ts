import type { PrismaClient } from '../db/prisma.js';
import type { Channel, User } from '../generated/prisma/client.js';
import { Errors } from '../common/errors.js';
import { cleanPermissions, DM_PERMISSIONS, PERMISSIONS, type Permission } from './catalog.js';
import { basePermissions, channelPermissions, topPosition, type MemberContext, type OverwriteInput, type RoleInput } from './resolve.js';

export { PERMISSIONS, isPermission, type Permission } from './catalog.js';

/**
 * 0.7.0 permissions, per server (Discord-style):
 *
 * - a server member has @everyone's permissions plus those of their roles; ADMINISTRATOR, the
 *   server owner and the superadmin (users.role = ADMIN) have every permission on that server;
 * - in a channel, overwrites apply in Discord's order (see resolve.ts); a channel synced with its
 *   category uses the category's overwrites;
 * - without VIEW_CHANNEL a channel does not exist for the user (NOT_FOUND, no realtime events);
 * - DMs: only their members, with DM_PERMISSIONS (the superadmin cannot read other people's DMs).
 *
 * Everything is enforced here on the server; clients only receive what they may see.
 */

export type UserLike = Pick<User, 'id' | 'role'>;
export type ChannelLike = Pick<Channel, 'id' | 'type' | 'guildId' | 'parentId' | 'permissionsSynced'>;

interface GuildCache {
  ownerId: string;
  roles: RoleInput[];
  /** Enabled and disabled members -> their role ids. */
  members: Map<string, string[]>;
  enabledMemberIds: string[];
}

export class PermissionsService {
  private readonly guilds = new Map<string, GuildCache | null>();
  /** channel id -> its server and its own overwrites. */
  private readonly overwrites = new Map<string, { guildId: string | null; list: OverwriteInput[] }>();
  private readonly dmMembers = new Map<string, Set<string>>();
  /** channel id -> its server and who may see it. */
  private readonly audiences = new Map<string, { guildId: string | null; ids: string[] }>();
  private readonly userGuilds = new Map<string, string[]>();

  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Roles, members, member roles or overwrites of THIS server changed (other servers keep their
   * caches). userIds: people whose server list changed (someone who just joined).
   */
  invalidateGuild(guildId: string, userIds: readonly string[] = []): void {
    this.guilds.delete(guildId);
    for (const [id, entry] of this.overwrites) if (entry.guildId === guildId) this.overwrites.delete(id);
    for (const [id, entry] of this.audiences) if (entry.guildId === guildId) this.audiences.delete(id);
    // Server lists that contain this server (members, leavers) plus the given users (joiners).
    for (const [id, guildIds] of this.userGuilds) if (guildIds.includes(guildId)) this.userGuilds.delete(id);
    for (const id of userIds) this.userGuilds.delete(id);
  }

  /** Members of a DM changed. */
  invalidateDm(channelId: string): void {
    this.dmMembers.delete(channelId);
    this.audiences.delete(channelId);
  }

  /** Anything (users enabled / disabled, superadmin role changes, bulk changes). */
  invalidateAll(): void {
    this.guilds.clear();
    this.overwrites.clear();
    this.dmMembers.clear();
    this.audiences.clear();
    this.userGuilds.clear();
  }

  /** Kept for older call sites: same as invalidateAll(). */
  invalidate(): void {
    this.invalidateAll();
  }

  private async guild(guildId: string): Promise<GuildCache | null> {
    if (this.guilds.has(guildId)) return this.guilds.get(guildId) ?? null;
    const row = await this.prisma.guild.findUnique({
      where: { id: guildId },
      include: {
        roles: { select: { id: true, key: true, position: true, permissions: true } },
        members: { select: { userId: true, user: { select: { disabled: true } }, roles: { select: { roleId: true } } } },
      },
    });
    const entry: GuildCache | null = row
      ? {
          ownerId: row.ownerId,
          roles: row.roles.map((r) => ({ id: r.id, position: r.position, permissions: cleanPermissions(r.permissions), isEveryone: r.key === 'everyone' })),
          members: new Map(row.members.map((m) => [m.userId, m.roles.map((r) => r.roleId)])),
          enabledMemberIds: row.members.filter((m) => !m.user.disabled).map((m) => m.userId),
        }
      : null;
    this.guilds.set(guildId, entry);
    return entry;
  }

  private context(user: UserLike, guild: GuildCache): MemberContext | null {
    const roleIds = guild.members.get(user.id);
    const isSuperadmin = user.role === 'ADMIN';
    if (!roleIds && !isSuperadmin) return null;
    return { userId: user.id, roleIds: roleIds ?? [], isOwner: guild.ownerId === user.id, isSuperadmin };
  }

  async isMember(userId: string, guildId: string): Promise<boolean> {
    return (await this.guild(guildId))?.members.has(userId) ?? false;
  }

  async isOwner(userId: string, guildId: string): Promise<boolean> {
    return (await this.guild(guildId))?.ownerId === userId;
  }

  async guildIdsOf(userId: string): Promise<string[]> {
    let ids = this.userGuilds.get(userId);
    if (!ids) {
      const rows = await this.prisma.guildMember.findMany({ where: { userId }, select: { guildId: true }, orderBy: { joinedAt: 'asc' } });
      ids = rows.map((r) => r.guildId);
      this.userGuilds.set(userId, ids);
    }
    return ids;
  }

  /** Enabled members of a server. */
  async memberIdsOf(guildId: string): Promise<string[]> {
    return (await this.guild(guildId))?.enabledMemberIds ?? [];
  }

  /** Role ids of a member (without @everyone). */
  async roleIdsOf(userId: string, guildId: string): Promise<string[]> {
    return (await this.guild(guildId))?.members.get(userId) ?? [];
  }

  async guildPermissions(user: UserLike, guildId: string): Promise<Set<Permission>> {
    const guild = await this.guild(guildId);
    const ctx = guild && this.context(user, guild);
    if (!guild || !ctx) return new Set();
    return basePermissions(ctx, guild.roles);
  }

  /** Server visible (member or superadmin), and optionally a server-wide permission. 404 / 403. */
  async requireGuild(user: UserLike, guildId: string, permission?: Permission): Promise<void> {
    const guild = await this.guild(guildId);
    const ctx = guild && this.context(user, guild);
    if (!guild || !ctx) throw Errors.guildNotFound();
    if (permission && !basePermissions(ctx, guild.roles).has(permission)) throw Errors.forbidden(`Missing permission: ${permission}`);
  }

  async topPosition(user: UserLike, guildId: string): Promise<number> {
    const guild = await this.guild(guildId);
    const ctx = guild && this.context(user, guild);
    if (!guild || !ctx) return -1;
    return topPosition(ctx, guild.roles);
  }

  /** Top position of a member by id (not a superadmin check: used for targets). */
  async memberTopPosition(userId: string, guildId: string): Promise<number> {
    const guild = await this.guild(guildId);
    if (!guild) return -1;
    if (guild.ownerId === userId) return Infinity;
    return topPosition({ userId, roleIds: guild.members.get(userId) ?? [], isOwner: false, isSuperadmin: false }, guild.roles);
  }

  async rolesOf(guildId: string): Promise<RoleInput[]> {
    return (await this.guild(guildId))?.roles ?? [];
  }

  private async overwritesOf(channelId: string, guildId: string | null): Promise<OverwriteInput[]> {
    let entry = this.overwrites.get(channelId);
    if (!entry) {
      const rows = await this.prisma.permissionOverwrite.findMany({ where: { channelId } });
      entry = { guildId, list: rows.map((r) => ({ targetType: r.targetType, targetId: r.targetId, allow: cleanPermissions(r.allow), deny: cleanPermissions(r.deny) })) };
      this.overwrites.set(channelId, entry);
    }
    return entry.list;
  }

  /** The overwrites that apply to a channel: its category's when synced, else its own. */
  async effectiveOverwrites(channel: ChannelLike): Promise<OverwriteInput[]> {
    return this.overwritesOf(channel.permissionsSynced && channel.parentId ? channel.parentId : channel.id, channel.guildId);
  }

  private async dmMembersOf(channelId: string): Promise<Set<string>> {
    let set = this.dmMembers.get(channelId);
    if (!set) {
      const rows = await this.prisma.channelMember.findMany({ where: { channelId }, select: { userId: true } });
      set = new Set(rows.map((r) => r.userId));
      this.dmMembers.set(channelId, set);
    }
    return set;
  }

  async channelPermissions(user: UserLike, channel: ChannelLike): Promise<Set<Permission>> {
    if (channel.type === 'DM') return (await this.dmMembersOf(channel.id)).has(user.id) ? new Set(DM_PERMISSIONS) : new Set();
    if (!channel.guildId) return new Set();
    const guild = await this.guild(channel.guildId);
    const ctx = guild && this.context(user, guild);
    if (!guild || !ctx) return new Set();
    return channelPermissions(ctx, guild.roles, await this.effectiveOverwrites(channel), channel.type);
  }

  async hasInChannel(user: UserLike, channel: ChannelLike, permission: Permission): Promise<boolean> {
    return (await this.channelPermissions(user, channel)).has(permission);
  }

  async canView(user: UserLike, channel: ChannelLike): Promise<boolean> {
    return this.hasInChannel(user, channel, 'VIEW_CHANNEL');
  }

  /** Throws NOT_FOUND (not FORBIDDEN) so hidden channels do not reveal that they exist. */
  async requireView(user: UserLike, channel: ChannelLike): Promise<void> {
    if (!(await this.canView(user, channel))) throw Errors.notFound('Channel');
  }

  /** Visible (else 404) and the permission (else 403). */
  async requireChannel(user: UserLike, channel: ChannelLike, permission: Permission): Promise<void> {
    const perms = await this.channelPermissions(user, channel);
    if (!perms.has('VIEW_CHANNEL')) throw Errors.notFound('Channel');
    if (!perms.has(permission)) throw Errors.forbidden(`Missing permission: ${permission}`);
  }

  async canSend(user: UserLike, channel: ChannelLike): Promise<boolean> {
    return this.hasInChannel(user, channel, 'SEND_MESSAGES');
  }

  /** Delete others' messages, pin: MANAGE_MESSAGES (never in DMs). */
  async canManageMessages(user: UserLike, channel: ChannelLike): Promise<boolean> {
    if (channel.type === 'DM') return false;
    return this.hasInChannel(user, channel, 'MANAGE_MESSAGES');
  }

  async canConnect(user: UserLike, channel: ChannelLike): Promise<boolean> {
    return this.hasInChannel(user, channel, 'CONNECT_VOICE');
  }

  /** Enabled users who may see a channel: who receives its realtime events. */
  async audience(channel: ChannelLike): Promise<string[]> {
    const cached = this.audiences.get(channel.id);
    if (cached) return cached.ids;
    let ids: string[] = [];
    if (channel.type === 'DM') {
      ids = [...(await this.dmMembersOf(channel.id))];
    } else if (channel.guildId) {
      const memberIds = await this.memberIdsOf(channel.guildId);
      const users = await this.prisma.user.findMany({ where: { id: { in: memberIds } }, select: { id: true, role: true } });
      for (const u of users) if (await this.canView(u, channel)) ids.push(u.id);
    }
    this.audiences.set(channel.id, { guildId: channel.guildId, ids });
    return ids;
  }

  /** Enabled members of a server (server-wide events). */
  async guildAudience(guildId: string): Promise<string[]> {
    return this.memberIdsOf(guildId);
  }

  /** All permission names (for clients). */
  all(): readonly Permission[] {
    return PERMISSIONS;
  }
}
