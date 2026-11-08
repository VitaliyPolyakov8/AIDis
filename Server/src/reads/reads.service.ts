import { z } from 'zod';
import type { PrismaClient } from '../db/prisma.js';
import type { Channel, NotifyMode, User } from '../generated/prisma/client.js';
import { parseInput } from '../common/validation.js';
import { Errors } from '../common/errors.js';

/** Unread counts are capped: the UI only shows "99+". */
export const UNREAD_CAP = 100;

export interface ReadStateView {
  channelId: string;
  lastReadAt: string;
  /** Messages from others after lastReadAt (capped at UNREAD_CAP). */
  unread: number;
  /** Of those, how many mention the user. */
  mentions: number;
  /** The channel's own setting; null = inherit. */
  notifyMode: NotifyMode | null;
  /** 0.7.0: what applies: channel setting -> the member's server setting -> the server default -> ALL. */
  effectiveNotifyMode: NotifyMode;
  /** 0.7.0: the channel's server (null for DMs). */
  guildId: string | null;
}

type ChannelRef = Pick<Channel, 'id' | 'createdAt'> & { guildId?: string | null };

const notifySchema = z.object({ mode: z.enum(['ALL', 'MENTIONS', 'NONE']).nullable() });
const readSchema = z.object({ messageId: z.uuid().optional() });

/**
 * 0.4.0 per-user read state. A channel becomes read only when the client says the user actually
 * looked at it (POST /channels/:id/read); loading messages never marks anything read. Without a row
 * a channel counts as read up to when the user or the channel appeared, whichever is later.
 */
export class ReadsService {
  constructor(private readonly prisma: PrismaClient) {}

  private baseline(user: Pick<User, 'createdAt'>, channel: Pick<Channel, 'createdAt'>): Date {
    return user.createdAt > channel.createdAt ? user.createdAt : channel.createdAt;
  }

  async states(user: User, channels: ChannelRef[]): Promise<ReadStateView[]> {
    if (channels.length === 0) return [];
    const rows = await this.prisma.channelRead.findMany({ where: { userId: user.id, channelId: { in: channels.map((c) => c.id) } } });
    const byChannel = new Map(rows.map((r) => [r.channelId, r]));
    const guildIds = [...new Set(channels.map((c) => c.guildId).filter((g): g is string => !!g))];
    const [guilds, members] = await Promise.all([
      this.prisma.guild.findMany({ where: { id: { in: guildIds } }, select: { id: true, defaultNotifyMode: true } }),
      this.prisma.guildMember.findMany({ where: { userId: user.id, guildId: { in: guildIds } }, select: { guildId: true, notifyMode: true } }),
    ]);
    const guildDefault = new Map(guilds.map((g) => [g.id, g.defaultNotifyMode]));
    const memberMode = new Map(members.map((m) => [m.guildId, m.notifyMode]));
    return Promise.all(
      channels.map(async (c) => {
        const row = byChannel.get(c.id);
        const lastReadAt = row?.lastReadAt ?? this.baseline(user, c);
        const where = { channelId: c.id, deletedAt: null, authorId: { not: user.id }, createdAt: { gt: lastReadAt } };
        const [unreadRows, mentionRows] = await Promise.all([
          this.prisma.message.findMany({ where, select: { id: true }, take: UNREAD_CAP }),
          this.prisma.message.findMany({ where: { ...where, mentions: { has: user.id } }, select: { id: true }, take: UNREAD_CAP }),
        ]);
        const guildId = c.guildId ?? null;
        const own = row?.notifyMode ?? null;
        const effectiveNotifyMode = own ?? (guildId ? (memberMode.get(guildId) ?? guildDefault.get(guildId) ?? 'ALL') : 'ALL');
        return { channelId: c.id, lastReadAt: lastReadAt.toISOString(), unread: unreadRows.length, mentions: mentionRows.length, notifyMode: own, effectiveNotifyMode, guildId };
      }),
    );
  }

  /**
   * Marks the channel read up to a message (default: its newest message). Never moves backwards,
   * so an older tab cannot undo what a newer one read.
   */
  async markRead(user: User, channel: ChannelRef, input: unknown): Promise<ReadStateView> {
    const { messageId } = parseInput(readSchema, input ?? {});
    let at: Date | null = null;
    if (messageId) {
      const message = await this.prisma.message.findFirst({ where: { id: messageId, channelId: channel.id }, select: { createdAt: true } });
      if (!message) throw Errors.notFound('Message');
      at = message.createdAt;
    }
    if (!at) {
      const newest = await this.prisma.message.findFirst({ where: { channelId: channel.id }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
      at = newest?.createdAt ?? new Date();
    }
    const baseline = this.baseline(user, channel);
    if (at < baseline) at = baseline;
    // A read/check/write sequence races between devices: both first inserts can conflict, and an
    // older request can overwrite a newer marker. PostgreSQL resolves both atomically here.
    await this.prisma.$executeRaw`
      INSERT INTO "channel_reads" ("user_id", "channel_id", "last_read_at")
      VALUES (${user.id}::uuid, ${channel.id}::uuid, ${at})
      ON CONFLICT ("user_id", "channel_id") DO UPDATE
      SET "last_read_at" = GREATEST("channel_reads"."last_read_at", EXCLUDED."last_read_at")
    `;
    const [state] = await this.states(user, [channel]);
    return state as ReadStateView;
  }

  async setNotifyMode(user: User, channel: ChannelRef, input: unknown): Promise<ReadStateView> {
    const { mode } = parseInput(notifySchema, input);
    await this.prisma.channelRead.upsert({
      where: { userId_channelId: { userId: user.id, channelId: channel.id } },
      create: { userId: user.id, channelId: channel.id, lastReadAt: this.baseline(user, channel), notifyMode: mode },
      update: { notifyMode: mode },
    });
    const [state] = await this.states(user, [channel]);
    return state as ReadStateView;
  }
}
