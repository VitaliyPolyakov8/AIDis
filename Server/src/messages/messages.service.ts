import { z } from 'zod';
import type { PrismaClient } from '../db/prisma.js';
import { isUniqueViolation } from '../db/prisma.js';
import { Prisma, type Channel, type User } from '../generated/prisma/client.js';
import { Errors } from '../common/errors.js';
import { isPrintable, parseInput, sanitizeText } from '../common/validation.js';
import { notFriends, type ChannelsService } from '../channels/channels.service.js';
import type { PermissionsService } from '../permissions/permissions.service.js';
import type { AuditService } from '../audit/audit.service.js';
import type { LimitsService } from '../limits/limits.service.js';
import type { EmojisService } from '../emojis/service.js';
import type { EventPublisher } from '../realtime/events.js';
import { publicUserSelect } from '../users/user.dto.js';
import { groupReactions, toMessageView, type MessageView, type ReactionView } from './message.dto.js';
import type { Embed, LinkEmbed } from '../embeds/embeds.js';
import { gifInputSchema, validateGif, type ServerGifProviderName } from '../embeds/gif.service.js';
import type { LinkPreviewService } from '../embeds/link-preview.service.js';

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
/** 0.4.0 limits. */
export const MAX_REACTION_KINDS = 20;
export const MAX_PINS_PER_CHANNEL = 50;
export const MAX_SEARCH_RESULTS = 50;

export const messageInclude = {
  author: { select: publicUserSelect },
  attachments: { orderBy: { createdAt: 'asc' } },
  reactions: { select: { emoji: true, userId: true }, orderBy: { createdAt: 'asc' } },
  replyTo: {
    select: { id: true, content: true, deletedAt: true, authorId: true, author: { select: { displayName: true } }, _count: { select: { attachments: true } } },
  },
} as const satisfies Prisma.MessageInclude;

export const historyQuerySchema = z
  .object({
    before: z.uuid().optional(),
    after: z.uuid().optional(),
    /** 0.4.0: a page centered on this message (jump to a reply / pin / search result / first unread). */
    around: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  })
  .refine((q) => [q.before, q.after, q.around].filter(Boolean).length <= 1, { message: 'Use only one of "before", "after" or "around"' });

const searchSchema = z.object({
  q: z.string().trim().max(100).default(''),
  channelId: z.uuid().optional(),
  /** 0.7.0: search scope (one of channelId / guildId / dms). */
  guildId: z.uuid().optional(),
  dms: z.enum(['1', 'true']).optional(),
  authorId: z.uuid().optional(),
  /** ISO dates: messages sent on/after `from` and before `to`. */
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_SEARCH_RESULTS).default(25),
});

/** A Unicode emoji (one grapheme with a pictographic / flag / keycap character), or a future "custom:<id>". */
export const emojiSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((v) => isPrintable(v) && !/\s/.test(v), 'Invalid emoji')
  .refine((v) => /^custom:[A-Za-z0-9_-]{1,40}$/.test(v) || (/\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u.test(v) && [...new Intl.Segmenter().segment(v)].length === 1), 'Invalid emoji');

export interface HistoryPage {
  /** Always in chronological order (oldest first). */
  messages: MessageView[];
  /** True when more messages exist in the requested direction (older for before/latest/around). */
  hasMore: boolean;
  /** 0.4.0 "around" pages: true when newer messages exist after this page. */
  hasNewer?: boolean;
}

const MENTION = /(^|[^\w@])@([A-Za-z0-9_.-]{2,32})/g;

export class MessagesService {
  private readonly sendSchema;
  private readonly editSchema;
  /** 0.7.0, wired in app.ts. */
  limits: LimitsService | null = null;
  emojis: EmojisService | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly channels: ChannelsService,
    private readonly publisher: EventPublisher,
    maxMessageLength: number,
    private readonly previews: LinkPreviewService | null = null,
    private readonly gifProvider: ServerGifProviderName | 'none' = 'none',
    private readonly permissions: PermissionsService | null = null,
    private readonly audit: AuditService | null = null,
  ) {
    const content = z
      .string()
      .max(maxMessageLength * 2)
      .transform(sanitizeText)
      .pipe(z.string().max(maxMessageLength, `Message must be at most ${maxMessageLength} characters`));
    this.sendSchema = z
      .object({
        content: content.default(''),
        nonce: z
          .string()
          .regex(/^[A-Za-z0-9_-]{1,64}$/, 'nonce must be 1-64 characters of [A-Za-z0-9_-]')
          .optional(),
        replyToId: z.uuid().optional(),
        attachmentIds: z.array(z.uuid()).max(MAX_ATTACHMENTS_PER_MESSAGE).default([]),
        gif: gifInputSchema.optional(),
        /** 0.5.2: read aloud in the call (voice channel chats and DMs; ignored elsewhere). */
        tts: z.boolean().default(false),
      })
      .refine((m) => m.content.length > 0 || m.attachmentIds.length > 0 || m.gif !== undefined, {
        message: 'Message must have content or attachments',
        path: ['content'],
      });
    this.editSchema = z.object({
      content: content.pipe(z.string().min(1, 'Message content cannot be empty')),
    });
  }

  private perms(): PermissionsService {
    if (!this.permissions) throw new Error('PermissionsService not wired');
    return this.permissions;
  }

  /** 0.7.0: the superadmin can lower the message length per server. */
  private async assertLength(channel: Channel, content: string): Promise<void> {
    if (!channel.guildId || !this.limits) return;
    const max = await this.limits.resolve('message.length', { guildId: channel.guildId });
    if (content.length > max) throw Errors.badRequest('MESSAGE_TOO_LONG', `Message must be at most ${max} characters`);
  }

  /** The channel, if the user may see it (NOT_FOUND otherwise, so hidden channels stay hidden). */
  private async visibleChat(user: User, channelId: string): Promise<Channel> {
    const channel = await this.channels.getChat(channelId);
    await this.perms().requireView(user, channel);
    return channel;
  }

  /** 0.7.0: visible and READ_MESSAGE_HISTORY (403 when only the history is closed). */
  private async readableChat(user: User, channelId: string): Promise<Channel> {
    const channel = await this.channels.getChat(channelId);
    await this.perms().requireChannel(user, channel, 'READ_MESSAGE_HISTORY');
    return channel;
  }

  /**
   * Cursor pagination. `before` (default: newest) walks back in time, `after` walks forward
   * (used by clients to catch up after a reconnect), `around` centers a page on a message.
   * Ordering key is (createdAt, id).
   */
  async history(user: User, channelId: string, query: unknown): Promise<HistoryPage> {
    const q = parseInput(historyQuerySchema, query);
    await this.readableChat(user, channelId);

    if (q.around) {
      const target = await this.prisma.message.findFirst({ where: { id: q.around, channelId } });
      if (!target) throw Errors.notFound('Message');
      const half = Math.max(1, Math.floor(q.limit / 2));
      const olderWhere = { OR: [{ createdAt: { lt: target.createdAt } }, { createdAt: target.createdAt, id: { lt: target.id } }] };
      const newerWhere = { OR: [{ createdAt: { gt: target.createdAt } }, { createdAt: target.createdAt, id: { gt: target.id } }] };
      const [older, newer] = await Promise.all([
        this.prisma.message.findMany({ where: { channelId, deletedAt: null, ...olderWhere }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: half + 1, include: messageInclude }),
        this.prisma.message.findMany({ where: { channelId, deletedAt: null, ...newerWhere }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: half + 1, include: messageInclude }),
      ]);
      const center = target.deletedAt ? [] : [await this.prisma.message.findUniqueOrThrow({ where: { id: target.id }, include: messageInclude })];
      const page = [...older.slice(0, half).reverse(), ...center, ...newer.slice(0, half)];
      return { messages: page.map(toMessageView), hasMore: older.length > half, hasNewer: newer.length > half };
    }

    const cursorId = q.before ?? q.after;
    let cursorWhere: Prisma.MessageWhereInput = {};
    if (cursorId) {
      const cursor = await this.prisma.message.findFirst({ where: { id: cursorId, channelId } });
      if (!cursor) {
        throw Errors.notFound('Cursor message');
      }
      cursorWhere = q.before
        ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }
        : { OR: [{ createdAt: { gt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { gt: cursor.id } }] };
    }
    const direction = q.after ? 'asc' : 'desc';
    const rows = await this.prisma.message.findMany({
      where: { channelId, deletedAt: null, ...cursorWhere },
      orderBy: [{ createdAt: direction }, { id: direction }],
      take: q.limit + 1,
      include: messageInclude,
    });
    const hasMore = rows.length > q.limit;
    const page = rows.slice(0, q.limit);
    if (direction === 'desc') page.reverse();
    return { messages: page.map(toMessageView), hasMore };
  }

  /**
   * @username -> stable user ids (unknown names are just text). 0.7.0: only people who can see the
   * channel; @everyone / @here mention all of them, and only with MENTION_EVERYONE.
   */
  private async resolveMentions(content: string, channel: Channel, author: User): Promise<string[]> {
    if (channel.type === 'DM' || !content.includes('@')) return [];
    const names = new Set<string>();
    for (const match of content.matchAll(MENTION)) if (match[2]) names.add(match[2].toLowerCase());
    if (names.size === 0) return [];
    const audience = await this.perms().audience(channel);
    if ((names.has('everyone') || names.has('here')) && (await this.perms().hasInChannel(author, channel, 'MENTION_EVERYONE'))) {
      return audience.filter((id) => id !== author.id);
    }
    const allowed = new Set(audience);
    const users = await this.prisma.user.findMany({ where: { usernameNormalized: { in: [...names].slice(0, 20) }, disabled: false }, select: { id: true } });
    return users.map((u) => u.id).filter((id) => allowed.has(id));
  }

  /**
   * Human-readable :name: in the editor becomes a stable ID in stored messages. URLs stay literal.
   * 0.7.0: the channel's server emojis win, then the author's other servers (DMs: the author's servers).
   */
  private async resolveEmojis(content: string, authorId: string, channel: Channel): Promise<string> {
    if (!/:[\p{L}\p{N}_]{2,32}:/u.test(content) || !this.emojis) return content;
    const byName = await this.emojis.resolverFor(authorId, channel.guildId);
    return content.replace(/https?:\/\/\S+|<:[^>]*>|:([\p{L}\p{N}_]{2,32}):/giu, (literal: string, name: string | undefined) => {
      if (!name) return literal;
      const emoji = byName.get(name.normalize('NFC').toLowerCase());
      return emoji ? `<:${emoji.name}:${emoji.id}>` : literal;
    });
  }

  async send(author: User, channelId: string, input: unknown): Promise<{ message: MessageView; created: boolean }> {
    const data = parseInput(this.sendSchema, input);
    const channel = await this.visibleChat(author, channelId);
    if (!(await this.perms().canSend(author, channel))) throw Errors.forbidden('You cannot send messages in this channel');
    // 0.7.0: a 1:1 DM stays readable after unfriending, but only friends can write there.
    if (channel.type === 'DM' && !(await this.channels.canWriteDm(author, channel))) throw notFriends();

    if (data.nonce) {
      const existing = await this.findByNonce(author.id, data.nonce);
      if (existing) return { message: existing, created: false };
    }
    data.content = await this.resolveEmojis(data.content, author.id, channel);
    parseInput(this.sendSchema, data);
    await this.assertLength(channel, data.content);
    if (data.replyToId) {
      const target = await this.prisma.message.findFirst({ where: { id: data.replyToId, channelId, deletedAt: null } });
      if (!target) throw Errors.badRequest('INVALID_REPLY', 'Replied-to message does not exist in this channel');
    }
    const attachmentIds = [...new Set(data.attachmentIds)];
    if (attachmentIds.length > 0 && channel.guildId && this.limits) {
      const max = await this.limits.resolve('upload.largeSize', { guildId: channel.guildId, userId: author.id });
      const tooBig = await this.prisma.attachment.count({ where: { id: { in: attachmentIds }, size: { gt: BigInt(max) } } });
      if (tooBig > 0) throw Errors.limitReached('upload.largeSize', max);
    }
    let gif: Embed | null = null;
    if (data.gif) {
      gif = validateGif(data.gif, this.gifProvider);
      if (!gif) throw Errors.badRequest('INVALID_GIF', 'GIF must come from the configured GIF provider');
    }
    const mentions = await this.resolveMentions(data.content, channel, author);
    const perms = await this.perms().channelPermissions(author, channel);
    if (attachmentIds.length > 0 && !perms.has('ATTACH_FILES')) throw Errors.forbidden('Missing permission: ATTACH_FILES');
    // Without SEND_TTS the message is simply not read aloud.
    const tts = data.tts && perms.has('SEND_TTS') && data.content.length > 0 && (channel.type === 'VOICE' || channel.type === 'DM');

    let message;
    try {
      message = await this.prisma.$transaction(async (tx) => {
        const created = await tx.message.create({
          data: {
            channelId,
            authorId: author.id,
            content: data.content,
            nonce: data.nonce ?? null,
            replyToId: data.replyToId ?? null,
            mentions,
            tts,
            ...(gif ? { embeds: [gif] as unknown as Prisma.InputJsonValue } : {}),
          },
        });
        if (attachmentIds.length > 0) {
          const linked = await tx.attachment.updateMany({
            where: { id: { in: attachmentIds }, uploaderId: author.id, messageId: null },
            data: { messageId: created.id },
          });
          if (linked.count !== attachmentIds.length) {
            throw Errors.badRequest('INVALID_ATTACHMENTS', 'Attachments must be your own, unused uploads');
          }
        }
        await tx.channel.update({ where: { id: channelId }, data: { lastMessageAt: created.createdAt } });
        // Writing counts as reading: the author's own channel is read up to this message.
        await tx.channelRead.upsert({
          where: { userId_channelId: { userId: author.id, channelId } },
          create: { userId: author.id, channelId, lastReadAt: created.createdAt },
          update: { lastReadAt: created.createdAt },
        });
        return tx.message.findUniqueOrThrow({ where: { id: created.id }, include: messageInclude });
      });
    } catch (error) {
      if (data.nonce && isUniqueViolation(error)) {
        const existing = await this.findByNonce(author.id, data.nonce);
        if (existing) return { message: existing, created: false };
      }
      throw error;
    }
    const view = toMessageView(message);
    this.publisher.messageCreated(view);
    // The message is delivered right away; a link card follows as message.updated when ready (EMBED_LINKS).
    if (perms.has('EMBED_LINKS')) this.schedulePreview(message.id, data.content);
    return { message: view, created: true };
  }

  /** 0.5.8: re-sends a message to clients after something outside it changed (an admin removed its file). */
  async republish(messageId: string): Promise<void> {
    const message = await this.prisma.message.findFirst({ where: { id: messageId, deletedAt: null }, include: messageInclude });
    if (message) this.publisher.messageUpdated(toMessageView(message));
  }

  async edit(actor: User, messageId: string, input: unknown): Promise<MessageView> {
    const data = parseInput(this.editSchema, input);
    const message = await this.getActive(messageId);
    if (message.authorId !== actor.id) {
      throw Errors.forbidden('You can only edit your own messages');
    }
    const channel = await this.visibleChat(actor, message.channelId);
    data.content = await this.resolveEmojis(data.content, actor.id, channel);
    parseInput(this.editSchema, data);
    await this.assertLength(channel, data.content);
    const mentions = await this.resolveMentions(data.content, channel, actor);
    const updated = await this.prisma.message.update({
      where: { id: messageId },
      data: { content: data.content, editedAt: new Date(), mentions },
      include: messageInclude,
    });
    const view = toMessageView(updated);
    this.publisher.messageUpdated(view);
    if (await this.perms().hasInChannel(actor, channel, 'EMBED_LINKS')) this.schedulePreview(messageId, data.content);
    return view;
  }

  /**
   * Link preview for the first URL of the message, in the background. Never throws, never blocks
   * sending; on failure the message simply keeps its plain clickable link.
   */
  private schedulePreview(messageId: string, content: string): void {
    if (!this.previews?.enabled) return;
    const url = this.previews.firstUrl(content);
    const previews = this.previews;
    void (async () => {
      const embed: LinkEmbed | null = url ? await previews.preview(url) : null;
      const current = await this.prisma.message.findUnique({ where: { id: messageId } });
      if (!current || current.deletedAt) return;
      const others = (Array.isArray(current.embeds) ? (current.embeds as unknown as Embed[]) : []).filter((e) => e.type !== 'link');
      const hadLink = Array.isArray(current.embeds) && (current.embeds as unknown as Embed[]).some((e) => e.type === 'link');
      if (!embed && !hadLink) return;
      // The message may have been edited meanwhile: only apply the card if its link is still there.
      if (embed && previews.firstUrl(current.content) !== url) return;
      const next = embed ? [...others, embed] : others;
      const updated = await this.prisma.message.update({
        where: { id: messageId },
        data: { embeds: next.length > 0 ? (next as unknown as Prisma.InputJsonValue) : Prisma.DbNull },
        include: messageInclude,
      });
      this.publisher.messageUpdated(toMessageView(updated));
    })().catch(() => undefined);
  }

  /** Authors may delete their own messages; MANAGE_MESSAGES may delete others' (audited). Soft delete. */
  async delete(actor: User, messageId: string): Promise<void> {
    const message = await this.getActive(messageId);
    const channel = await this.visibleChat(actor, message.channelId);
    const moderation = message.authorId !== actor.id;
    if (moderation && !(await this.perms().canManageMessages(actor, channel))) {
      throw Errors.forbidden('You can only delete your own messages');
    }
    const deletedAt = new Date();
    await this.prisma.$transaction([
      this.prisma.message.update({ where: { id: messageId }, data: { deletedAt, content: '', pinnedAt: null, pinnedById: null } }),
      // Detach files so they no longer show up anywhere; the files themselves are kept for backups/cleanup.
      this.prisma.attachment.updateMany({ where: { messageId }, data: { messageId: null } }),
      this.prisma.reaction.deleteMany({ where: { messageId } }),
    ]);
    if (moderation) await this.audit?.record(actor.id, 'message.deleted', { type: 'message', id: messageId }, { channelId: channel.id, channelName: channel.name, authorId: message.authorId }, channel.guildId);
    this.publisher.messageDeleted({ id: messageId, channelId: message.channelId, deletedAt: deletedAt.toISOString() });
  }

  async getView(user: User, messageId: string): Promise<MessageView> {
    const message = await this.prisma.message.findFirst({
      where: { id: messageId, deletedAt: null },
      include: messageInclude,
    });
    if (!message) throw Errors.notFound('Message');
    await this.readableChat(user, message.channelId);
    return toMessageView(message);
  }

  // ---- reactions (0.4.0) ------------------------------------------------------------------

  async react(user: User, messageId: string, rawEmoji: unknown, add: boolean): Promise<{ channelId: string; reactions: ReactionView[] }> {
    const emoji = parseInput(emojiSchema, rawEmoji);
    const message = await this.getActive(messageId);
    const channel = await this.visibleChat(user, message.channelId);
    if (add) {
      if (!(await this.perms().hasInChannel(user, channel, 'ADD_REACTIONS'))) throw Errors.forbidden('Missing permission: ADD_REACTIONS');
      if (emoji.startsWith('custom:')) {
        const id = emoji.slice(7);
        // 0.7.0: only emojis of a server the reacting user is in.
        if (!z.uuid().safeParse(id).success || !this.emojis || !(await this.emojis.usableBy(user.id, id))) throw Errors.notFound('Emoji');
      }
      const kinds = await this.prisma.reaction.findMany({ where: { messageId }, distinct: ['emoji'], select: { emoji: true } });
      if (!kinds.some((k) => k.emoji === emoji) && kinds.length >= MAX_REACTION_KINDS) {
        throw Errors.badRequest('TOO_MANY_REACTIONS', `A message can have at most ${MAX_REACTION_KINDS} different reactions`);
      }
      await this.prisma.reaction.createMany({ data: [{ messageId, userId: user.id, emoji }], skipDuplicates: true });
    } else {
      await this.prisma.reaction.deleteMany({ where: { messageId, userId: user.id, emoji } });
    }
    const rows = await this.prisma.reaction.findMany({ where: { messageId }, select: { emoji: true, userId: true }, orderBy: { createdAt: 'asc' } });
    const reactions = groupReactions(rows);
    this.publisher.reactionsUpdated({ messageId, channelId: message.channelId, reactions });
    return { channelId: message.channelId, reactions };
  }

  // ---- pins (0.4.0) -----------------------------------------------------------------------

  /** MANAGE_MESSAGES in channels; any member in a DM. */
  async setPinned(user: User, messageId: string, pinned: boolean): Promise<MessageView> {
    const message = await this.getActive(messageId);
    const channel = await this.visibleChat(user, message.channelId);
    const allowed = channel.type === 'DM' || (await this.perms().canManageMessages(user, channel));
    if (!allowed) throw Errors.forbidden('You cannot pin messages here');
    if (pinned && !message.pinnedAt) {
      const count = await this.prisma.message.count({ where: { channelId: channel.id, pinnedAt: { not: null }, deletedAt: null } });
      if (count >= MAX_PINS_PER_CHANNEL) throw Errors.badRequest('TOO_MANY_PINS', `A channel can have at most ${MAX_PINS_PER_CHANNEL} pinned messages`);
    }
    const updated = await this.prisma.message.update({
      where: { id: messageId },
      data: pinned ? { pinnedAt: message.pinnedAt ?? new Date(), pinnedById: message.pinnedById ?? user.id } : { pinnedAt: null, pinnedById: null },
      include: messageInclude,
    });
    if (channel.type !== 'DM') await this.audit?.record(user.id, pinned ? 'message.pinned' : 'message.unpinned', { type: 'message', id: messageId }, { channelId: channel.id, channelName: channel.name }, channel.guildId);
    const view = toMessageView(updated);
    this.publisher.messageUpdated(view);
    return view;
  }

  async pins(user: User, channelId: string): Promise<MessageView[]> {
    await this.readableChat(user, channelId);
    const rows = await this.prisma.message.findMany({
      where: { channelId, deletedAt: null, pinnedAt: { not: null } },
      orderBy: { pinnedAt: 'desc' },
      take: MAX_PINS_PER_CHANNEL,
      include: messageInclude,
    });
    return rows.map(toMessageView);
  }

  // ---- search (0.4.0) ---------------------------------------------------------------------

  /**
   * Case-insensitive text search (PostgreSQL ILIKE). 0.7.0: in one server (?guildId=, channels with
   * READ_MESSAGE_HISTORY), in the DMs (?dms=1) or in one channel (?channelId=).
   */
  async search(user: User, query: unknown): Promise<MessageView[]> {
    const q = parseInput(searchSchema, query);
    if (!q.channelId && !q.guildId && !q.dms) throw Errors.badRequest('SEARCH_SCOPE', 'Search one server, one channel or the direct messages');
    if (!q.q && !q.authorId) return [];
    let channelIds: string[];
    if (q.channelId) {
      await this.readableChat(user, q.channelId);
      channelIds = [q.channelId];
    } else if (q.guildId) {
      const visible = await this.channels.listVisible(user, q.guildId);
      channelIds = [];
      for (const c of visible) {
        if (c.type === 'CATEGORY') continue;
        if (await this.perms().hasInChannel(user, { id: c.id, type: c.type, guildId: c.guildId, parentId: c.parentId, permissionsSynced: c.permissionsSynced }, 'READ_MESSAGE_HISTORY')) channelIds.push(c.id);
      }
    } else {
      channelIds = (await this.channels.listDms(user)).map((c) => c.id);
    }
    if (channelIds.length === 0) return [];
    const rows = await this.prisma.message.findMany({
      where: {
        channelId: { in: channelIds },
        deletedAt: null,
        ...(q.q ? { content: { contains: q.q, mode: 'insensitive' } } : {}),
        ...(q.authorId ? { authorId: q.authorId } : {}),
        ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lt: new Date(q.to) } : {}) } } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit,
      include: messageInclude,
    });
    return rows.map(toMessageView);
  }

  private async getActive(messageId: string) {
    const message = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!message || message.deletedAt !== null) {
      throw Errors.notFound('Message');
    }
    return message;
  }

  private async findByNonce(authorId: string, nonce: string): Promise<MessageView | null> {
    const existing = await this.prisma.message.findUnique({
      where: { authorId_nonce: { authorId, nonce } },
      include: messageInclude,
    });
    return existing && existing.deletedAt === null ? toMessageView(existing) : null;
  }
}
