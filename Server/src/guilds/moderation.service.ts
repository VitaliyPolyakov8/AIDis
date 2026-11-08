import { z } from 'zod';
import type { PrismaClient } from '../db/prisma.js';
import type { User } from '../generated/prisma/client.js';
import { Errors } from '../common/errors.js';
import { parseInput, sanitizeText } from '../common/validation.js';
import { nickname } from './nickname.js';
import { outranks } from '../permissions/resolve.js';
import type { PermissionsService } from '../permissions/permissions.service.js';
import type { AuditService } from '../audit/audit.service.js';
import type { EventPublisher } from '../realtime/events.js';
import type { GuildsService } from './guilds.service.js';
import type { MemberView } from './guild.dto.js';

const banSchema = z.object({ reason: z.string().transform(sanitizeText).pipe(z.string().max(300)).optional() });
const nicknameSchema = z.object({ nickname });

export interface BanView {
  userId: string;
  reason: string | null;
  bannedById: string;
  createdAt: string;
}

/** 0.7.0: kick, ban, unban, nicknames. Everything respects the role hierarchy. Voice is cut by the gateway (memberRemoved). */
export class ModerationService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly permissions: PermissionsService,
    private readonly guilds: GuildsService,
    private readonly audit: AuditService,
    private readonly publisher: EventPublisher,
  ) {}

  /** The actor must be strictly above the target; nobody can act on the owner. */
  private async assertCanActOn(actor: User, guildId: string, userId: string): Promise<void> {
    if (await this.permissions.isOwner(userId, guildId)) throw Errors.conflict('OWNER', 'The server owner cannot be moderated');
    if (userId === actor.id) throw Errors.badRequest('SELF', 'You cannot do this to yourself');
    const [mine, theirs] = await Promise.all([this.permissions.topPosition(actor, guildId), this.permissions.memberTopPosition(userId, guildId)]);
    if (!outranks(mine, theirs)) throw Errors.forbidden('This member is not below you');
  }

  async kick(actor: User, guildId: string, userId: string): Promise<void> {
    await this.permissions.requireGuild(actor, guildId, 'KICK_MEMBERS');
    if (!(await this.permissions.isMember(userId, guildId))) throw Errors.notFound('Member');
    await this.assertCanActOn(actor, guildId, userId);
    await this.guilds.removeMember(guildId, userId, 'kicked');
    await this.audit.record(actor.id, 'member.kicked', { type: 'user', id: userId }, {}, guildId);
  }

  async ban(actor: User, guildId: string, userId: string, input: unknown): Promise<void> {
    await this.permissions.requireGuild(actor, guildId, 'BAN_MEMBERS');
    const { reason } = parseInput(banSchema, input ?? {});
    if (!(await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } }))) throw Errors.notFound('User');
    const member = await this.permissions.isMember(userId, guildId);
    if (member) await this.assertCanActOn(actor, guildId, userId);
    else if (userId === actor.id) throw Errors.badRequest('SELF', 'You cannot do this to yourself');
    await this.prisma.guildBan.upsert({
      where: { guildId_userId: { guildId, userId } },
      create: { guildId, userId, reason: reason || null, bannedById: actor.id },
      update: { reason: reason || null, bannedById: actor.id },
    });
    if (member) await this.guilds.removeMember(guildId, userId, 'banned');
    await this.audit.record(actor.id, 'member.banned', { type: 'user', id: userId }, reason ? { reason } : {}, guildId);
  }

  async unban(actor: User, guildId: string, userId: string): Promise<void> {
    await this.permissions.requireGuild(actor, guildId, 'BAN_MEMBERS');
    const { count } = await this.prisma.guildBan.deleteMany({ where: { guildId, userId } });
    if (count === 0) throw Errors.notFound('Ban');
    await this.audit.record(actor.id, 'member.unbanned', { type: 'user', id: userId }, {}, guildId);
  }

  async bans(actor: User, guildId: string): Promise<BanView[]> {
    await this.permissions.requireGuild(actor, guildId, 'BAN_MEMBERS');
    const rows = await this.prisma.guildBan.findMany({ where: { guildId }, orderBy: { createdAt: 'desc' } });
    return rows.map((b) => ({ userId: b.userId, reason: b.reason, bannedById: b.bannedById, createdAt: b.createdAt.toISOString() }));
  }

  async setNickname(actor: User, guildId: string, userId: string, input: unknown): Promise<MemberView> {
    const data = parseInput(nicknameSchema, input);
    if (userId === actor.id) {
      await this.permissions.requireGuild(actor, guildId, 'CHANGE_NICKNAME');
    } else {
      await this.permissions.requireGuild(actor, guildId, 'MANAGE_NICKNAMES');
      if (!(await this.permissions.isMember(userId, guildId))) throw Errors.notFound('Member');
      await this.assertCanActOn(actor, guildId, userId);
    }
    if (!(await this.permissions.isMember(userId, guildId))) throw Errors.notFound('Member');
    await this.prisma.guildMember.update({ where: { guildId_userId: { guildId, userId } }, data: { nickname: data.nickname || null } });
    const member = await this.guilds.member(guildId, userId);
    if (!member) throw Errors.notFound('Member');
    if (userId !== actor.id) await this.audit.record(actor.id, 'member.nickname_changed', { type: 'user', id: userId }, { nickname: member.nickname }, guildId);
    this.publisher.memberUpdated(guildId, member, await this.permissions.guildAudience(guildId));
    return member;
  }
}
