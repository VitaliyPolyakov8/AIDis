import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '../db/prisma.js';
import type { User } from '../generated/prisma/client.js';
import { AppError, Errors } from '../common/errors.js';
import { isPrintable, parseInput, sanitizeText } from '../common/validation.js';
import type { AuditService } from '../audit/audit.service.js';
import type { LimitsService } from '../limits/limits.service.js';
import type { PermissionsService } from '../permissions/permissions.service.js';
import type { EventPublisher } from '../realtime/events.js';
import { createGuildFromTemplate, GUILD_LANGUAGES, newGuildTemplate, type GuildTemplate } from './template.js';
import { nickname } from './nickname.js';
import { bioSchema } from '../users/users.service.js';
import { toGuildView, toMemberProfile, toMemberView, type GuildView, type MemberView, type MyGuildView } from './guild.dto.js';

export const guildName = z.string().transform(sanitizeText).pipe(z.string().min(1, 'Name is required').max(100, 'Name must be at most 100 characters').refine(isPrintable, 'Name contains invalid characters'));

const createSchema = z.object({ name: guildName, lang: z.enum(GUILD_LANGUAGES).default('en') });
const updateSchema = z.object({
  name: guildName.optional(),
  iconAttachmentId: z.uuid().nullable().optional(),
  bannerAttachmentId: z.uuid().nullable().optional(),
  systemChannelId: z.uuid().nullable().optional(),
  defaultNotifyMode: z.enum(['ALL', 'MENTIONS', 'NONE']).optional(),
});
const deleteSchema = z.object({ confirmName: z.string().max(200) });
const profileSchema = z.object({
  nickname: nickname.optional(),
  avatarAttachmentId: z.uuid().nullable().optional(),
  bannerAttachmentId: z.uuid().nullable().optional(),
  bio: bioSchema,
});
const settingsSchema = z.object({ notifyMode: z.enum(['ALL', 'MENTIONS', 'NONE']).nullable() });

/** Checks an uploaded image for a profile (UsersService.checkImage). */
export type ProfileImageChecker = (userId: string, attachmentId: string, kind: 'avatar' | 'banner') => Promise<void>;
const transferSchema = z.object({ userId: z.uuid() });
const orderSchema = z.object({ guildIds: z.array(z.uuid()).max(1000) });

interface FileRemover {
  remove(storedName: string): Promise<void>;
}

/** 0.7.0 servers: create, read, change, delete, leave, transfer, join, server profiles. */
export class GuildsService {
  checkImage: ProfileImageChecker = () => Promise.resolve();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly permissions: PermissionsService,
    private readonly limits: LimitsService,
    private readonly publisher: EventPublisher,
    private readonly audit: AuditService,
    private readonly files: FileRemover,
    private readonly log: FastifyBaseLogger,
  ) {}

  private async view(guildId: string): Promise<GuildView> {
    const guild = await this.prisma.guild.findUnique({ where: { id: guildId }, include: { _count: { select: { members: true } } } });
    if (!guild) throw Errors.guildNotFound();
    return toGuildView(guild, guild._count.members);
  }

  /** The server as one user sees it (their permissions, roles, profile). */
  async myView(user: Pick<User, 'id' | 'role'>, guildId: string): Promise<MyGuildView> {
    await this.permissions.requireGuild(user, guildId);
    const [view, member] = await Promise.all([this.view(guildId), this.prisma.guildMember.findUnique({ where: { guildId_userId: { guildId, userId: user.id } }, include: { roles: { select: { roleId: true } } } })]);
    return {
      ...view,
      me: {
        member: member !== null,
        permissions: [...(await this.permissions.guildPermissions(user, guildId))],
        roleIds: member?.roles.map((r) => r.roleId) ?? [],
        notifyMode: member?.notifyMode ?? null,
        railPosition: member?.railPosition ?? null,
        profile: toMemberProfile(member),
      },
    };
  }

  async listMine(user: User): Promise<MyGuildView[]> {
    const rows = await this.prisma.guildMember.findMany({ where: { userId: user.id }, orderBy: [{ railPosition: { sort: 'asc', nulls: 'last' } }, { joinedAt: 'asc' }], select: { guildId: true } });
    return Promise.all(rows.map((r) => this.myView(user, r.guildId)));
  }

  /** Superadmin: every server. */
  async listAll(): Promise<GuildView[]> {
    const rows = await this.prisma.guild.findMany({ orderBy: { createdAt: 'asc' }, include: { _count: { select: { members: true } } } });
    return rows.map((g) => toGuildView(g, g._count.members));
  }

  async create(user: User, input: unknown): Promise<MyGuildView> {
    const { name, lang } = parseInput(createSchema, input);
    const [owned, joined] = await Promise.all([this.prisma.guild.count({ where: { ownerId: user.id } }), this.prisma.guildMember.count({ where: { userId: user.id } })]);
    await this.limits.assertBelow('guilds.owned', { userId: user.id }, owned);
    await this.limits.assertBelow('guilds.joined', { userId: user.id }, joined);
    const guild = await this.createFromTemplate(user.id, name, newGuildTemplate(lang));
    await this.audit.record(user.id, 'guild.created', { type: 'guild', id: guild.id }, { name }, guild.id);
    const mine = await this.myView(user, guild.id);
    this.publisher.guildJoined(user.id, mine);
    return mine;
  }

  /** No limits, no events: used by create() and by tests to set up a server. */
  async createFromTemplate(ownerId: string, name: string, template: GuildTemplate): Promise<GuildView> {
    const id = await this.prisma.$transaction((tx) => createGuildFromTemplate(tx, { name, ownerId, template }));
    this.permissions.invalidateGuild(id, [ownerId]);
    return this.view(id);
  }

  async update(user: User, guildId: string, input: unknown): Promise<GuildView> {
    await this.permissions.requireGuild(user, guildId, 'MANAGE_GUILD');
    const data = parseInput(updateSchema, input);
    // Same checks as profile pictures: an image the caller uploaded, judged by its real bytes.
    if (data.iconAttachmentId) await this.checkImage(user.id, data.iconAttachmentId, 'avatar');
    if (data.bannerAttachmentId) await this.checkImage(user.id, data.bannerAttachmentId, 'banner');
    if (data.systemChannelId) {
      const channel = await this.prisma.channel.findUnique({ where: { id: data.systemChannelId } });
      if (channel?.guildId !== guildId || channel.type !== 'TEXT') throw Errors.badRequest('INVALID_CHANNEL', 'Pick a text channel of this server');
    }
    const before = await this.view(guildId);
    await this.prisma.guild.update({
      where: { id: guildId },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.iconAttachmentId !== undefined ? { iconAttachmentId: data.iconAttachmentId } : {}),
        ...(data.bannerAttachmentId !== undefined ? { bannerAttachmentId: data.bannerAttachmentId } : {}),
        ...(data.systemChannelId !== undefined ? { systemChannelId: data.systemChannelId } : {}),
        ...(data.defaultNotifyMode !== undefined ? { defaultNotifyMode: data.defaultNotifyMode } : {}),
      },
    });
    const after = await this.view(guildId);
    await this.audit.record(user.id, 'guild.updated', { type: 'guild', id: guildId }, { name: after.name, ...(before.name !== after.name ? { renamedFrom: before.name } : {}) }, guildId);
    this.publisher.guildUpdated(after, await this.permissions.guildAudience(guildId));
    return after;
  }

  private async requireOwnerOrSuperadmin(user: User, guildId: string): Promise<void> {
    await this.permissions.requireGuild(user, guildId);
    if (user.role !== 'ADMIN' && !(await this.permissions.isOwner(user.id, guildId))) throw Errors.forbidden('Only the owner can do this');
  }

  async delete(user: User, guildId: string, input: unknown): Promise<void> {
    await this.requireOwnerOrSuperadmin(user, guildId);
    const { confirmName } = parseInput(deleteSchema, input);
    const guild = await this.view(guildId);
    if (sanitizeText(confirmName).toLocaleLowerCase('ru') !== guild.name.toLocaleLowerCase('ru')) throw Errors.badRequest('CONFIRM_MISMATCH', 'Type the server name to delete it');
    const audience = await this.permissions.guildAudience(guildId);
    const storedNames = await this.prisma.$transaction(async (tx) => {
      const attachments = await tx.attachment.findMany({ where: { message: { channel: { guildId } } }, select: { id: true, storedName: true } });
      const emojis = await tx.serverEmoji.findMany({ where: { guildId }, select: { storedName: true } });
      await tx.attachment.deleteMany({ where: { id: { in: attachments.map((a) => a.id) } } });
      await tx.guild.delete({ where: { id: guildId } });
      return [...attachments.map((a) => a.storedName), ...emojis.map((e) => e.storedName)];
    });
    for (const name of storedNames) {
      await this.files.remove(name).catch((error: unknown) => {
        this.log.warn({ err: error, storedName: name }, 'Could not remove a file of a deleted server');
      });
    }
    this.permissions.invalidateGuild(guildId);
    await this.audit.record(user.id, 'guild.deleted', { type: 'guild', id: guildId }, { name: guild.name, files: storedNames.length }, null);
    this.publisher.guildDeleted(guildId, audience);
  }

  async transfer(user: User, guildId: string, input: unknown): Promise<GuildView> {
    await this.requireOwnerOrSuperadmin(user, guildId);
    const { userId } = parseInput(transferSchema, input);
    if (!(await this.permissions.isMember(userId, guildId))) throw Errors.badRequest('NOT_A_MEMBER', 'The new owner must be a member of the server');
    await this.prisma.guild.update({ where: { id: guildId }, data: { ownerId: userId } });
    this.permissions.invalidateGuild(guildId);
    await this.audit.record(user.id, 'guild.transferred', { type: 'user', id: userId }, {}, guildId);
    const view = await this.view(guildId);
    this.publisher.guildUpdated(view, await this.permissions.guildAudience(guildId));
    return view;
  }

  async leave(user: User, guildId: string): Promise<void> {
    if (!(await this.permissions.isMember(user.id, guildId))) throw Errors.guildNotFound();
    if (await this.permissions.isOwner(user.id, guildId)) throw Errors.conflict('OWNER_CANNOT_LEAVE', 'Transfer the server to someone else before leaving');
    await this.removeMember(guildId, user.id, 'left');
  }

  /** Removes a membership (leave / kick / ban) and tells the server and the user. */
  async removeMember(guildId: string, userId: string, reason: 'left' | 'kicked' | 'banned'): Promise<void> {
    await this.prisma.guildMember.deleteMany({ where: { guildId, userId } });
    this.permissions.invalidateGuild(guildId, [userId]);
    const audience = await this.permissions.guildAudience(guildId);
    this.publisher.memberRemoved(guildId, userId, reason, [...new Set([...audience, userId])]);
  }

  async members(user: User, guildId: string): Promise<MemberView[]> {
    await this.permissions.requireGuild(user, guildId);
    const rows = await this.prisma.guildMember.findMany({ where: { guildId }, include: { roles: { select: { roleId: true } } }, orderBy: { joinedAt: 'asc' } });
    return rows.map(toMemberView);
  }

  async member(guildId: string, userId: string): Promise<MemberView | null> {
    const row = await this.prisma.guildMember.findUnique({ where: { guildId_userId: { guildId, userId } }, include: { roles: { select: { roleId: true } } } });
    return row ? toMemberView(row) : null;
  }

  /** The caller's own server profile (nickname needs CHANGE_NICKNAME; avatar, banner, bio: any member). */
  async updateMyProfile(user: User, guildId: string, input: unknown): Promise<MemberView> {
    if (!(await this.permissions.isMember(user.id, guildId))) throw Errors.guildNotFound();
    const data = parseInput(profileSchema, input);
    if (data.nickname !== undefined) await this.permissions.requireGuild(user, guildId, 'CHANGE_NICKNAME');
    if (data.avatarAttachmentId) await this.checkImage(user.id, data.avatarAttachmentId, 'avatar');
    if (data.bannerAttachmentId) await this.checkImage(user.id, data.bannerAttachmentId, 'banner');
    await this.prisma.guildMember.update({
      where: { guildId_userId: { guildId, userId: user.id } },
      data: {
        ...(data.nickname !== undefined ? { nickname: data.nickname || null } : {}),
        ...(data.avatarAttachmentId !== undefined ? { avatarAttachmentId: data.avatarAttachmentId } : {}),
        ...(data.bannerAttachmentId !== undefined ? { bannerAttachmentId: data.bannerAttachmentId } : {}),
        ...(data.bio !== undefined ? { bio: data.bio || null } : {}),
      },
    });
    const member = await this.member(guildId, user.id);
    if (!member) throw Errors.guildNotFound();
    this.publisher.memberUpdated(guildId, member, await this.permissions.guildAudience(guildId));
    return member;
  }

  /** The caller's notification level for the whole server (null = the server default). */
  async updateMySettings(user: User, guildId: string, input: unknown): Promise<void> {
    if (!(await this.permissions.isMember(user.id, guildId))) throw Errors.guildNotFound();
    const { notifyMode } = parseInput(settingsSchema, input);
    await this.prisma.guildMember.update({ where: { guildId_userId: { guildId, userId: user.id } }, data: { notifyMode } });
  }

  async setRailOrder(user: User, input: unknown): Promise<void> {
    const { guildIds } = parseInput(orderSchema, input);
    const mine = new Set(await this.permissions.guildIdsOf(user.id));
    const ordered = [...new Set(guildIds)].filter((id) => mine.has(id));
    await this.prisma.$transaction(ordered.map((guildId, railPosition) => this.prisma.guildMember.update({ where: { guildId_userId: { guildId, userId: user.id } }, data: { railPosition } })));
  }

  /**
   * Adds a member (invites, admin-created accounts). Banned -> 403 BANNED; limits apply.
   * Returns false when the user already was a member.
   */
  /** Throws when this user may not join (unknown server, banned, limits). */
  async assertCanJoin(userId: string, guildId: string): Promise<void> {
    const guild = await this.prisma.guild.findUnique({ where: { id: guildId }, select: { id: true } });
    if (!guild) throw Errors.guildNotFound();
    if (await this.prisma.guildBan.findUnique({ where: { guildId_userId: { guildId, userId } } })) throw new AppError(403, 'BANNED', 'You are banned from this server');
    const [members, joined] = await Promise.all([this.prisma.guildMember.count({ where: { guildId } }), this.prisma.guildMember.count({ where: { userId } })]);
    await this.limits.assertBelow('guild.members', { guildId }, members);
    await this.limits.assertBelow('guilds.joined', { userId }, joined);
  }

  async join(userId: string, guildId: string): Promise<boolean> {
    if (await this.permissions.isMember(userId, guildId)) return false;
    await this.assertCanJoin(userId, guildId);
    try {
      await this.prisma.guildMember.create({ data: { guildId, userId } });
    } catch (error) {
      // A parallel join of the same user (double click): already a member.
      if (await this.prisma.guildMember.findUnique({ where: { guildId_userId: { guildId, userId } } })) return false;
      throw error;
    }
    this.permissions.invalidateGuild(guildId, [userId]);
    const member = await this.member(guildId, userId);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { id: true, role: true } });
    if (member)
      this.publisher.memberAdded(
        guildId,
        member,
        (await this.permissions.guildAudience(guildId)).filter((id) => id !== userId),
      );
    this.publisher.guildJoined(userId, await this.myView(user, guildId));
    return true;
  }
}
