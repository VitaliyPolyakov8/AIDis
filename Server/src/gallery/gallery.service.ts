import { z } from 'zod';
import type { PrismaClient } from '../db/prisma.js';
import type { User, Prisma } from '../generated/prisma/client.js';
import type { ChannelsService } from '../channels/channels.service.js';
import type { PermissionsService } from '../permissions/permissions.service.js';
import { Errors } from '../common/errors.js';
import { parseInput } from '../common/validation.js';
import { toAttachmentView, type AttachmentView } from '../attachments/attachment.dto.js';

const categories = z.enum(['images', 'videos', 'documents', 'links']);
const querySchema = z.object({ category: categories, cursor: z.string().min(1).max(512).optional(), limit: z.coerce.number().int().min(1).max(50).default(24) });
const cursorSchema = z.object({ channelId: z.uuid(), category: categories, id: z.uuid(), at: z.iso.datetime() });
type Cursor = z.infer<typeof cursorSchema>;
export interface GalleryItem {
  id: string;
  messageId: string;
  createdAt: string;
  authorName: string;
  attachment?: AttachmentView;
  links?: string[];
}
export interface GalleryPage {
  items: GalleryItem[];
  nextCursor: string | null;
}

/** Text links work even with link previews disabled. Never fetches third-party resources. */
function textLinks(content: string): string[] {
  const links = new Set<string>();
  for (const match of content.matchAll(/\bhttps?:\/\/[^\s<>"']+/gi)) {
    let raw = match[0];
    const trailing = /[.,;:!?)\]}'"]+$/.exec(raw)?.[0] ?? '';
    if (trailing && !(trailing.startsWith(')') && raw.includes('('))) raw = raw.slice(0, -trailing.length);
    try {
      const url = new URL(raw);
      if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password) links.add(url.href);
    } catch {
      /* malformed text is not a link */
    }
    if (links.size >= 50) break;
  }
  return [...links];
}

export class GalleryService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly channels: ChannelsService,
    private readonly permissions: PermissionsService,
  ) {}

  async list(user: User, channelId: string, input: unknown): Promise<GalleryPage> {
    const q = parseInput(querySchema, input);
    const channel = await this.channels.getChat(channelId);
    // 0.7.0: the gallery is message history.
    await this.permissions.requireChannel(user, channel, 'READ_MESSAGE_HISTORY');
    let cursor: Cursor | undefined;
    if (q.cursor) {
      try {
        cursor = cursorSchema.parse(JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8')));
      } catch {
        throw Errors.badRequest('INVALID_CURSOR', 'Invalid gallery cursor');
      }
      if (cursor.channelId !== channelId || cursor.category !== q.category) throw Errors.badRequest('INVALID_CURSOR', 'Cursor belongs to another gallery');
    }
    const before = cursor ? { OR: [{ createdAt: { lt: new Date(cursor.at) } }, { createdAt: new Date(cursor.at), id: { lt: cursor.id } }] } : {};
    const orderBy = [{ createdAt: 'desc' }, { id: 'desc' }] as const;
    const next = (rows: { id: string; createdAt: Date }[]) => {
      const last = rows[q.limit - 1];
      return rows.length > q.limit && last ? Buffer.from(JSON.stringify({ channelId, category: q.category, id: last.id, at: last.createdAt.toISOString() } satisfies Cursor)).toString('base64url') : null;
    };
    if (q.category === 'links') {
      // Page candidates instead of repeatedly scanning history until a page fills: each request
      // reads at most limit + 1 messages. An empty page can still have a continuation cursor.
      const rows = await this.prisma.message.findMany({
        where: { channelId, deletedAt: null, content: { contains: 'http', mode: 'insensitive' }, ...before },
        orderBy: [...orderBy],
        take: q.limit + 1,
        select: { id: true, content: true, createdAt: true, author: { select: { displayName: true } } },
      });
      return {
        items: rows.slice(0, q.limit).flatMap((row) => {
          const links = textLinks(row.content);
          return links.length ? [{ id: row.id, messageId: row.id, createdAt: row.createdAt.toISOString(), authorName: row.author.displayName, links }] : [];
        }),
        nextCursor: next(rows),
      };
    }
    const image = { mimeType: { startsWith: 'image/', mode: 'insensitive' as const } };
    const video = { mimeType: { startsWith: 'video/', mode: 'insensitive' as const } };
    const kind: Prisma.AttachmentWhereInput = q.category === 'images' ? image : q.category === 'videos' ? video : { NOT: [image, video] };
    const rows = await this.prisma.attachment.findMany({
      where: { message: { channelId, deletedAt: null }, ...kind, ...before },
      orderBy: [...orderBy],
      take: q.limit + 1,
      include: { message: { select: { id: true, author: { select: { displayName: true } } } } },
    });
    return {
      items: rows
        .slice(0, q.limit)
        .flatMap((row) => (row.message ? [{ id: row.id, messageId: row.message.id, createdAt: row.createdAt.toISOString(), authorName: row.message.author.displayName, attachment: toAttachmentView(row) }] : [])),
      nextCursor: next(rows),
    };
  }
}
