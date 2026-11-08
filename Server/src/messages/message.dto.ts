import type { Attachment, Message, User } from '../generated/prisma/client.js';
import { toAttachmentView, type AttachmentView } from '../attachments/attachment.dto.js';
import { toPublicUser, type PublicUser } from '../users/user.dto.js';
import { embedViews, type Embed } from '../embeds/embed-views.js';

/** 0.4.0: what a reply shows about the message it answers (computed on read, never copied). */
export interface ReplyPreview {
  id: string;
  authorId: string;
  authorName: string;
  /** Short plain-text preview; empty when deleted. */
  content: string;
  deleted: boolean;
  hasAttachments: boolean;
}

/** 0.4.0: one emoji's reactions on a message. */
export interface ReactionView {
  emoji: string;
  count: number;
  userIds: string[];
}

export interface MessageView {
  id: string;
  channelId: string;
  author: PublicUser;
  content: string;
  nonce: string | null;
  replyToId: string | null;
  attachments: AttachmentView[];
  createdAt: string;
  updatedAt: string;
  editedAt: string | null;
  edited: boolean;
  /** 0.3.1: link preview cards / GIFs; image URLs point at the server's image proxy. */
  embeds: Embed[];
  /** 0.4.0 */
  replyTo: ReplyPreview | null;
  reactions: ReactionView[];
  mentions: string[];
  pinnedAt: string | null;
  pinnedById: string | null;
  /** 0.5.2: read aloud to the people in the call (text-to-speech). */
  tts: boolean;
}

type AuthorFields = Parameters<typeof toPublicUser>[0];

export type MessageWithRelations = Message & {
  author: AuthorFields;
  attachments: Attachment[];
  reactions?: { emoji: string; userId: string }[];
  replyTo?:
    | (Pick<Message, 'id' | 'content' | 'deletedAt' | 'authorId'> & {
        author: Pick<User, 'displayName'>;
        _count: { attachments: number };
      })
    | null;
};

export const REPLY_PREVIEW_LENGTH = 140;

export function groupReactions(rows: { emoji: string; userId: string }[]): ReactionView[] {
  const map = new Map<string, string[]>();
  for (const r of rows) map.set(r.emoji, [...(map.get(r.emoji) ?? []), r.userId]);
  return [...map.entries()].map(([emoji, userIds]) => ({ emoji, count: userIds.length, userIds }));
}

export function toMessageView(message: MessageWithRelations): MessageView {
  const reply = message.replyTo;
  return {
    id: message.id,
    channelId: message.channelId,
    author: toPublicUser(message.author),
    content: message.content,
    nonce: message.nonce,
    replyToId: message.replyToId,
    attachments: message.attachments.map(toAttachmentView),
    createdAt: message.createdAt.toISOString(),
    updatedAt: message.updatedAt.toISOString(),
    editedAt: message.editedAt?.toISOString() ?? null,
    edited: message.editedAt !== null,
    embeds: embedViews(message.embeds),
    replyTo: reply
      ? {
          id: reply.id,
          authorId: reply.authorId,
          authorName: reply.author.displayName,
          content: reply.deletedAt ? '' : reply.content.slice(0, REPLY_PREVIEW_LENGTH),
          deleted: reply.deletedAt !== null,
          hasAttachments: !reply.deletedAt && reply._count.attachments > 0,
        }
      : null,
    reactions: groupReactions(message.reactions ?? []),
    mentions: message.mentions,
    pinnedAt: message.pinnedAt?.toISOString() ?? null,
    pinnedById: message.pinnedById,
    tts: message.tts,
  };
}
