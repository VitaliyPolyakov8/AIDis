import { request } from './client';
import type { GifResult, HistoryPage, Message, ReactionView } from './types';

export const HISTORY_PAGE_SIZE = 50;

export interface SendMessageInput {
  content: string;
  nonce: string;
  attachmentIds?: string[];
  replyToId?: string;
  /** 0.3.1: a GIF picked in the GIF browser (provider URLs; the server validates them). */
  gif?: Omit<GifResult, 'previewProxy' | 'mediaProxy'>;
  /** 0.5.2: read aloud in the call (voice channel chats and DMs). */
  tts?: boolean;
}

/** 0.7.0: a search needs a scope — one server, one channel, or the DMs. */
export interface SearchQuery {
  dms?: boolean;
  guildId?: string;
  q?: string;
  channelId?: string;
  authorId?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export const messagesApi = {
  /** Newest page by default; `before` walks back, `after` walks forward, `around` centers on a message. */
  history(
    channelId: string,
    cursor: { before?: string; after?: string; around?: string } = {},
    limit = HISTORY_PAGE_SIZE,
    signal?: AbortSignal,
  ): Promise<HistoryPage> {
    return request(`/api/v1/channels/${channelId}/messages`, {
      query: { before: cursor.before, after: cursor.after, around: cursor.around, limit },
      signal,
    });
  },
  send(channelId: string, input: SendMessageInput): Promise<{ message: Message }> {
    return request(`/api/v1/channels/${channelId}/messages`, { method: 'POST', body: input });
  },
  edit(messageId: string, content: string): Promise<{ message: Message }> {
    return request(`/api/v1/messages/${messageId}`, { method: 'PATCH', body: { content } });
  },
  remove(messageId: string): Promise<void> {
    return request(`/api/v1/messages/${messageId}`, { method: 'DELETE' });
  },
  /** 0.4.0 */
  react(messageId: string, emoji: string, add: boolean): Promise<{ channelId: string; reactions: ReactionView[] }> {
    return request(`/api/v1/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`, { method: add ? 'PUT' : 'DELETE' });
  },
  pin(messageId: string, pinned: boolean): Promise<{ message: Message }> {
    return request(`/api/v1/messages/${messageId}/pin`, { method: pinned ? 'PUT' : 'DELETE' });
  },
  pins(channelId: string): Promise<{ messages: Message[] }> {
    return request(`/api/v1/channels/${channelId}/pins`);
  },
  search(query: SearchQuery, signal?: AbortSignal): Promise<{ messages: Message[] }> {
    const { dms, ...rest } = query;
    return request('/api/v1/search/messages', { query: { ...(dms ? { dms: 1 } : {}), ...rest }, signal });
  },
};
