import { z } from 'zod';
import type { PrismaClient } from '../db/prisma.js';
import type { Invite, User } from '../generated/prisma/client.js';
import { AppError, Errors } from '../common/errors.js';
import { parseInput } from '../common/validation.js';
import { isUniqueViolation } from '../db/prisma.js';
import type { PermissionsService } from '../permissions/permissions.service.js';
import type { LimitsService } from '../limits/limits.service.js';
import type { GuildsService } from '../guilds/guilds.service.js';
import type { MyGuildView } from '../guilds/guild.dto.js';
import { generateInviteCode, normalizeInviteCode } from './code.js';

export const MAX_AGES = [1800, 3600, 21600, 43200, 86400, 604800, 0] as const;
export const MAX_USES = [0, 1, 5, 10, 25, 50, 100] as const;

const createSchema = z.object({
  maxAgeSeconds: z.union(MAX_AGES.map((v) => z.literal(v))).default(604800),
  maxUses: z.union(MAX_USES.map((v) => z.literal(v))).default(0),
  channelId: z.uuid().nullable().optional(),
});

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

const invalid = () => new AppError(404, 'INVITE_INVALID', 'This invite is invalid or has expired');

function toView(i: Invite): InviteView {
  return { code: i.code, guildId: i.guildId, channelId: i.channelId, creatorId: i.creatorId, maxUses: i.maxUses, uses: i.uses, expiresAt: i.expiresAt?.toISOString() ?? null, createdAt: i.createdAt.toISOString() };
}

function isUsable(i: Invite, now = Date.now()): boolean {
  return !i.revokedAt && (!i.expiresAt || i.expiresAt.getTime() > now) && (i.maxUses === null || i.uses < i.maxUses);
}

/** Online check (presence lives in memory; injected to keep this module independent). */
export type OnlineCounter = (userIds: string[]) => number;

/** 0.7.0 invites: codes and links to join a server. */
export class InvitesService {
  countOnline: OnlineCounter = () => 0;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly permissions: PermissionsService,
    private readonly limits: LimitsService,
    private readonly guilds: GuildsService,
  ) {}

  private activeWhere(guildId: string) {
    return { guildId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] };
  }

  async create(user: User, guildId: string, input: unknown): Promise<InviteView> {
    await this.permissions.requireGuild(user, guildId, 'CREATE_INVITE');
    const data = parseInput(createSchema, input ?? {});
    if (data.channelId) {
      const channel = await this.prisma.channel.findUnique({ where: { id: data.channelId } });
      if (channel?.guildId !== guildId || channel.type === 'CATEGORY' || !(await this.permissions.canView(user, channel))) throw Errors.badRequest('INVALID_CHANNEL', 'Pick a channel of this server');
    }
    const active = await this.prisma.invite.count({ where: this.activeWhere(guildId) });
    await this.limits.assertBelow('guild.invites', { guildId }, active);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const invite = await this.prisma.invite.create({
          data: {
            code: generateInviteCode(),
            guildId,
            channelId: data.channelId ?? null,
            creatorId: user.id,
            maxUses: data.maxUses === 0 ? null : data.maxUses,
            expiresAt: data.maxAgeSeconds === 0 ? null : new Date(Date.now() + data.maxAgeSeconds * 1000),
          },
        });
        return toView(invite);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    throw Errors.serviceUnavailable('INVITE_CODE', 'Could not create a unique code, try again');
  }

  /** MANAGE_GUILD sees every active invite; others only their own. */
  async list(user: User, guildId: string): Promise<InviteView[]> {
    await this.permissions.requireGuild(user, guildId);
    const all = (await this.permissions.guildPermissions(user, guildId)).has('MANAGE_GUILD');
    const rows = await this.prisma.invite.findMany({ where: { ...this.activeWhere(guildId), ...(all ? {} : { creatorId: user.id }) }, orderBy: { createdAt: 'desc' } });
    return rows.filter((r) => isUsable(r)).map(toView);
  }

  async revoke(user: User, rawCode: string): Promise<InviteView> {
    const code = normalizeInviteCode(rawCode);
    const invite = code ? await this.prisma.invite.findUnique({ where: { code } }) : null;
    if (!invite || !(await this.permissions.guildPermissions(user, invite.guildId)).size) throw invalid();
    if (invite.creatorId !== user.id) await this.permissions.requireGuild(user, invite.guildId, 'MANAGE_GUILD');
    const updated = await this.prisma.invite.update({ where: { code: invite.code }, data: { revokedAt: new Date() } });
    return toView(updated);
  }

  private async usable(rawCode: string): Promise<Invite> {
    const code = normalizeInviteCode(rawCode);
    const invite = code ? await this.prisma.invite.findUnique({ where: { code } }) : null;
    if (!invite || !isUsable(invite)) throw invalid();
    return invite;
  }

  /** 0.7.1 registration by invite: throws INVITE_INVALID unless the code can be used now. */
  async assertUsable(rawCode: string): Promise<string> {
    return (await this.usable(rawCode)).code;
  }

  /** 0.7.1: what a logged-out visitor sees on the invite page (registration on). */
  async publicPreview(rawCode: string): Promise<{ code: string; guild: { id: string; name: string }; memberCount: number }> {
    const invite = await this.usable(rawCode);
    const guild = await this.prisma.guild.findUniqueOrThrow({ where: { id: invite.guildId } });
    return { code: invite.code, guild: { id: guild.id, name: guild.name }, memberCount: await this.prisma.guildMember.count({ where: { guildId: guild.id } }) };
  }

  async preview(user: User, rawCode: string): Promise<InvitePreview> {
    const invite = await this.usable(rawCode);
    const guild = await this.prisma.guild.findUniqueOrThrow({ where: { id: invite.guildId } });
    const memberIds = await this.permissions.memberIdsOf(guild.id);
    return {
      code: invite.code,
      guild: { id: guild.id, name: guild.name, iconAttachmentId: guild.iconAttachmentId },
      memberCount: await this.prisma.guildMember.count({ where: { guildId: guild.id } }),
      onlineCount: this.countOnline(memberIds),
      expiresAt: invite.expiresAt?.toISOString() ?? null,
      alreadyMember: await this.permissions.isMember(user.id, guild.id),
    };
  }

  /**
   * Joins the server. Already a member: no use counted. The use is taken atomically, so two people
   * cannot both pass a single-use invite; a join that fails afterwards gives the use back.
   */
  async accept(user: User, rawCode: string): Promise<{ guild: MyGuildView; channelId: string | null }> {
    const invite = await this.usable(rawCode);
    const guildId = invite.guildId;
    if (!(await this.permissions.isMember(user.id, guildId))) {
      await this.guilds.assertCanJoin(user.id, guildId);
      const taken = await this.prisma.$executeRaw`UPDATE "invites" SET "uses" = "uses" + 1
        WHERE "code" = ${invite.code} AND "revoked_at" IS NULL AND ("expires_at" IS NULL OR "expires_at" > now()) AND ("max_uses" IS NULL OR "uses" < "max_uses")`;
      if (taken === 0) throw invalid();
      try {
        await this.guilds.join(user.id, guildId);
      } catch (error) {
        await this.prisma.$executeRaw`UPDATE "invites" SET "uses" = GREATEST("uses" - 1, 0) WHERE "code" = ${invite.code}`;
        throw error;
      }
    }
    return { guild: await this.guilds.myView(user, guildId), channelId: invite.channelId };
  }
}
