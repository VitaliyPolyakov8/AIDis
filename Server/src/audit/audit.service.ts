import type { FastifyBaseLogger } from 'fastify';
import type { PrismaClient } from '../db/prisma.js';
import type { Prisma } from '../generated/prisma/client.js';

/** Actions recorded in the audit log (stable strings, also used as i18n keys by the client). */
export type AuditAction =
  | 'emoji.created'
  | 'emoji.updated'
  | 'emoji.deleted'
  | 'channel.created'
  | 'channel.updated'
  | 'channel.deleted'
  | 'channel.reordered'
  | 'voice.disconnected'
  | 'voice.moved'
  | 'role.created'
  | 'role.updated'
  | 'role.deleted'
  | 'user.roles_changed'
  | 'user.badges_changed'
  | 'message.deleted'
  | 'message.pinned'
  | 'message.unpinned'
  // 0.5.8 admin panel
  | 'user.created'
  | 'user.disabled'
  | 'user.enabled'
  | 'user.password_reset'
  | 'user.sessions_revoked'
  | 'attachment.deleted'
  | 'announcement.set'
  | 'announcement.cleared'
  // 0.7.0 servers
  | 'guild.created'
  | 'guild.updated'
  | 'guild.deleted'
  | 'guild.transferred'
  | 'guild.integration_changed'
  | 'member.kicked'
  | 'member.banned'
  | 'member.unbanned'
  | 'member.nickname_changed'
  | 'role.reordered'
  | 'channel.overwrite_changed'
  | 'invite.created'
  | 'invite.revoked'
  | 'limits.changed'
  | 'voice.server_muted'
  | 'voice.server_deafened'
  | 'voice_node.created'
  | 'voice_node.updated'
  | 'voice_node.deleted'
  | 'mail.updated'
  | 'registration.updated'
  | 'sound.created'
  | 'sound.updated'
  | 'sound.deleted';

export interface AuditEntryView {
  id: string;
  guildId: string | null;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

/**
 * Who did what to what, and when. Writes never fail the action they describe (a broken audit insert
 * is logged instead). Details are short names / ids only, never message bodies or secrets.
 */
export class AuditService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly log: FastifyBaseLogger,
  ) {}

  /** guildId: the server the action happened in (null = instance-wide, superadmin). */
  async record(actorId: string | null, action: AuditAction, target: { type: string; id: string } | null, details?: Record<string, unknown>, guildId: string | null = null): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          guildId,
          actorId,
          action,
          targetType: target?.type ?? null,
          targetId: target?.id ?? null,
          ...(details ? { details: details as Prisma.InputJsonValue } : {}),
        },
      });
    } catch (error) {
      this.log.error({ err: error, event: 'audit.write_failed', action }, 'Could not write audit log entry');
    }
  }

  /** guildId: undefined = every entry (superadmin), null = instance-wide entries only, id = that server. */
  async list(limit: number, before?: string, guildId?: string | null): Promise<AuditEntryView[]> {
    const cursor = before ? await this.prisma.auditLog.findUnique({ where: { id: before } }) : null;
    const rows = await this.prisma.auditLog.findMany({
      where: { ...(cursor ? { createdAt: { lt: cursor.createdAt } } : {}), ...(guildId !== undefined ? { guildId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map((r) => ({
      id: r.id,
      guildId: r.guildId,
      actorId: r.actorId,
      action: r.action,
      targetType: r.targetType,
      targetId: r.targetId,
      details: r.details && typeof r.details === 'object' && !Array.isArray(r.details) ? (r.details as Record<string, unknown>) : null,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}
