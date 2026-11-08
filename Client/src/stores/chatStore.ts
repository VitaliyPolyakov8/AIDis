import { t } from '../i18n';
import { create } from 'zustand';
import { dmsApi } from '../api/channels';
import { HISTORY_PAGE_SIZE, messagesApi } from '../api/messages';
import { friendlyError } from '../api/errors';
import type { Attachment, Channel, GifResult, Message, MessageDeletedEvent, PublicUser, ReactionView } from '../api/types';
import type { SendMessageInput } from '../api/messages';
import { createNonce } from '../utils/nonce';
import { useAuthStore } from './authStore';

export type LocalStatus = 'pending' | 'failed';

/** A server message, or an optimistic local one (id "local:<nonce>") waiting for the server. */
export interface ChatMessage extends Message {
  localStatus?: LocalStatus;
  localError?: string;
  /** GIF of a message that is still being sent (kept for retries). */
  localGif?: SendMessageInput['gif'];
}

export interface ChannelMessages {
  messages: ChatMessage[];
  /** More history exists before the oldest loaded message. */
  hasMore: boolean;
  /** 0.4.0: the loaded window ends before the newest message (after a jump to an older message). */
  hasNewer: boolean;
  loadingNewer: boolean;
  status: 'idle' | 'loading' | 'ready' | 'error';
  loadingOlder: boolean;
  error: string | null;
}

/** A message to scroll to and highlight (jump from a reply, pin, search result or "Jump to unread"). */
export interface JumpTarget {
  channelId: string;
  messageId: string;
  seq: number;
}

interface ChatState {
  channels: Channel[];
  channelsLoaded: boolean;
  /** 0.4.0 direct messages (1:1 and group), newest activity first. */
  dms: Channel[];
  jump: JumpTarget | null;
  /** Message being replied to, per channel. */
  replyTo: Record<string, ChatMessage | null>;
  activeChannelId: string | null;
  byChannel: Record<string, ChannelMessages>;
  /** channelId -> userId -> expiry timestamp */
  typing: Record<string, Record<string, number>>;
  unread: Record<string, boolean>;

  /** 0.7.0: all channels of all my servers (kept by the guild store), for lookups by id. */
  loadChannels: () => Promise<Channel[]>;
  setChannels: (channels: Channel[]) => void;
  loadDms: () => Promise<Channel[]>;
  upsertDm: (dm: Channel) => void;
  /** Loads the page around a message (if not loaded) and asks the list to scroll to it. */
  jumpTo: (channelId: string, messageId: string) => Promise<void>;
  clearJump: () => void;
  loadNewer: (channelId: string) => Promise<void>;
  setReplyTo: (channelId: string, message: ChatMessage | null) => void;
  toggleReaction: (message: ChatMessage, emoji: string) => Promise<void>;
  applyReactions: (event: { messageId: string; channelId: string; reactions: ReactionView[] }) => void;
  setPinned: (messageId: string, pinned: boolean) => Promise<void>;
  setActiveChannel: (channelId: string | null) => void;
  loadLatest: (channelId: string, opts?: { force?: boolean }) => Promise<void>;
  loadOlder: (channelId: string) => Promise<void>;
  sendMessage: (channelId: string, author: PublicUser, content: string, attachments?: Attachment[], gif?: GifResult, replyTo?: ChatMessage | null, options?: { tts?: boolean }) => Promise<void>;
  retryMessage: (channelId: string, localId: string) => Promise<void>;
  discardMessage: (channelId: string, localId: string) => void;
  editMessage: (messageId: string, content: string) => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;

  applyCreated: (message: Message, selfId: string | null) => void;
  applyUpdated: (message: Message) => void;
  applyDeleted: (event: MessageDeletedEvent) => void;
  typingStarted: (channelId: string, userId: string, expiresInMs: number) => void;
  typingStopped: (channelId: string, userId: string) => void;
  /** After a realtime reconnect: refresh the open channel, drop other caches. */
  resync: () => Promise<void>;
  reset: () => void;
}

const EMPTY: ChannelMessages = { messages: [], hasMore: true, hasNewer: false, loadingNewer: false, status: 'idle', loadingOlder: false, error: null };
let jumpSeq = 0;

export const localId = (nonce: string) => `local:${nonce}`;

function compare(a: Message, b: Message): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Inserts or replaces a message, keeping chronological order. A server message whose
 * nonce matches an optimistic local message replaces it (prevents duplicates when both
 * the POST response and the realtime event arrive).
 */
export function upsertMessage(list: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const next = list.filter(
    (m) => m.id !== message.id && !(message.nonce && m.localStatus && m.nonce === message.nonce && m.author.id === message.author.id),
  );
  // Optimistic messages stay at the bottom until confirmed.
  if (!message.localStatus) {
    let i = next.length;
    while (i > 0) {
      const prev = next[i - 1];
      if (prev && !prev.localStatus && compare(prev, message) <= 0) break;
      i -= 1;
    }
    next.splice(i, 0, message);
    return next;
  }
  next.push(message);
  return next;
}

/** Merges an older page in front of the cached messages without duplicates. */
export function prependPage(list: ChatMessage[], older: Message[]): ChatMessage[] {
  const known = new Set(list.map((m) => m.id));
  return [...older.filter((m) => !known.has(m.id)), ...list];
}

export const useChatStore = create<ChatState>((set, get) => {
  const patchChannel = (channelId: string, patch: Partial<ChannelMessages>) => {
    set((s) => ({ byChannel: { ...s.byChannel, [channelId]: { ...(s.byChannel[channelId] ?? EMPTY), ...patch } } }));
  };
  const updateMessages = (channelId: string, fn: (list: ChatMessage[]) => ChatMessage[]) => {
    const current = get().byChannel[channelId];
    if (!current) return;
    patchChannel(channelId, { messages: fn(current.messages) });
  };
  const findMessage = (messageId: string): ChatMessage | undefined => {
    for (const entry of Object.values(get().byChannel)) {
      const found = entry.messages.find((m) => m.id === messageId);
      if (found) return found;
    }
    return undefined;
  };
  const latestRequests = new Map<string, AbortController>();

  const deliver = async (channelId: string, message: ChatMessage, attachmentIds: string[]) => {
    try {
      const { message: saved } = await messagesApi.send(channelId, {
        content: message.content,
        nonce: message.nonce ?? createNonce(),
        attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
        gif: message.localGif,
        replyToId: message.replyToId ?? undefined,
        tts: message.tts === true ? true : undefined,
      });
      updateMessages(channelId, (list) => upsertMessage(list, saved));
    } catch (error) {
      updateMessages(channelId, (list) =>
        list.map((m) => (m.id === message.id ? { ...m, localStatus: 'failed', localError: friendlyError(error) } : m)),
      );
    }
  };

  return {
    channels: [],
    channelsLoaded: false,
    dms: [],
    jump: null,
    replyTo: {},
    activeChannelId: null,
    byChannel: {},
    typing: {},
    unread: {},

    /** 0.7.0: channels belong to servers; the guild store loads them and mirrors them here. */
    loadChannels: async () => {
      const { useGuildStore } = await import('./guildStore');
      await useGuildStore.getState().loadGuilds();
      return get().channels;
    },

    setChannels: (channels) => {
      const current = get().channels;
      const same = current.length === channels.length && current.every((c, i) => c === channels[i]);
      if (!same || !get().channelsLoaded) set({ channels, channelsLoaded: true });
    },

    loadDms: async () => {
      const { dms } = await dmsApi.list();
      set({ dms });
      return dms;
    },

    upsertDm: (dm) => {
      set((s) => ({ dms: [dm, ...s.dms.filter((d) => d.id !== dm.id)] }));
    },

    jumpTo: async (channelId, messageId) => {
      const loaded = get().byChannel[channelId]?.messages.some((m) => m.id === messageId);
      if (!loaded) {
        latestRequests.get(channelId)?.abort();
        patchChannel(channelId, { status: 'loading', error: null });
        try {
          const page = await messagesApi.history(channelId, { around: messageId }, HISTORY_PAGE_SIZE);
          patchChannel(channelId, { messages: page.messages, hasMore: page.hasMore, hasNewer: page.hasNewer === true, status: 'ready', error: null, loadingOlder: false, loadingNewer: false });
        } catch (error) {
          patchChannel(channelId, { status: 'error', error: friendlyError(error, t('chat.loadFailed')) });
          return;
        }
      }
      set({ jump: { channelId, messageId, seq: ++jumpSeq } });
    },

    clearJump: () => set({ jump: null }),

    loadNewer: async (channelId) => {
      const current = get().byChannel[channelId];
      if (!current || current.status !== 'ready' || current.loadingNewer || !current.hasNewer) return;
      const newest = [...current.messages].reverse().find((m) => !m.localStatus);
      if (!newest) return;
      patchChannel(channelId, { loadingNewer: true });
      try {
        const page = await messagesApi.history(channelId, { after: newest.id });
        const latest = get().byChannel[channelId] ?? current;
        const known = new Set(latest.messages.map((m) => m.id));
        patchChannel(channelId, { messages: [...latest.messages, ...page.messages.filter((m) => !known.has(m.id))], hasNewer: page.hasMore, loadingNewer: false });
      } catch {
        patchChannel(channelId, { loadingNewer: false });
      }
    },

    setReplyTo: (channelId, message) => set((s) => ({ replyTo: { ...s.replyTo, [channelId]: message } })),

    toggleReaction: async (message, emoji) => {
      const userId = useAuthStore.getState().user?.id;
      if (!userId) return;
      const current = message.reactions ?? [];
      const mine = current.find((r) => r.emoji === emoji)?.userIds.includes(userId) === true;
      // Optimistic: the server's message.reactions event replaces this with the truth.
      const next: ReactionView[] = mine
        ? current.map((r) => (r.emoji === emoji ? { ...r, count: r.count - 1, userIds: r.userIds.filter((u) => u !== userId) } : r)).filter((r) => r.count > 0)
        : current.some((r) => r.emoji === emoji)
          ? current.map((r) => (r.emoji === emoji ? { ...r, count: r.count + 1, userIds: [...r.userIds, userId] } : r))
          : [...current, { emoji, count: 1, userIds: [userId] }];
      get().applyReactions({ messageId: message.id, channelId: message.channelId, reactions: next });
      try {
        const res = await messagesApi.react(message.id, emoji, !mine);
        get().applyReactions({ messageId: message.id, channelId: res.channelId, reactions: res.reactions });
      } catch (error) {
        get().applyReactions({ messageId: message.id, channelId: message.channelId, reactions: current });
        throw error;
      }
    },

    applyReactions: ({ messageId, channelId, reactions }) => {
      updateMessages(channelId, (list) => list.map((m) => (m.id === messageId ? { ...m, reactions } : m)));
    },

    setPinned: async (messageId, pinned) => {
      const { message } = await messagesApi.pin(messageId, pinned);
      get().applyUpdated(message);
    },

    setActiveChannel: (channelId) => {
      set((s) => ({
        activeChannelId: channelId,
        unread: channelId ? { ...s.unread, [channelId]: false } : s.unread,
      }));
    },

    loadLatest: async (channelId, opts = {}) => {
      const current = get().byChannel[channelId];
      if (!opts.force && current && (current.status === 'ready' || current.status === 'loading')) return;
      latestRequests.get(channelId)?.abort();
      const controller = new AbortController();
      latestRequests.set(channelId, controller);
      if (!current || current.status !== 'ready') patchChannel(channelId, { status: 'loading', error: null });
      try {
        const page = await messagesApi.history(channelId, {}, HISTORY_PAGE_SIZE, controller.signal);
        const existing = get().byChannel[channelId];
        const pendingLocal = existing?.messages.filter((m) => m.localStatus) ?? [];
        let messages: ChatMessage[] = page.messages;
        const oldestFresh = page.messages[0];
        if (opts.force && existing?.status === 'ready' && oldestFresh) {
          // Keep older history we already had when the fresh page overlaps it.
          const overlaps = existing.messages.some((m) => m.id === oldestFresh.id);
          if (overlaps) {
            const older = existing.messages.filter((m) => !m.localStatus && compare(m, oldestFresh) < 0);
            messages = [...older, ...page.messages];
            patchChannel(channelId, { messages: [...messages, ...pendingLocal], status: 'ready', error: null, hasNewer: false });
            return;
          }
        }
        let merged = messages;
        for (const local of pendingLocal) merged = upsertMessage(merged, local);
        patchChannel(channelId, { messages: merged, hasMore: page.hasMore, hasNewer: false, status: 'ready', error: null });
      } catch (error) {
        if (controller.signal.aborted) return;
        if (get().byChannel[channelId]?.status !== 'ready') {
          patchChannel(channelId, { status: 'error', error: friendlyError(error, t('chat.loadFailed')) });
        }
      } finally {
        if (latestRequests.get(channelId) === controller) latestRequests.delete(channelId);
      }
    },

    loadOlder: async (channelId) => {
      const current = get().byChannel[channelId];
      if (!current || current.status !== 'ready' || current.loadingOlder || !current.hasMore) return;
      const oldest = current.messages.find((m) => !m.localStatus);
      if (!oldest) {
        patchChannel(channelId, { hasMore: false });
        return;
      }
      patchChannel(channelId, { loadingOlder: true });
      try {
        const page = await messagesApi.history(channelId, { before: oldest.id });
        const latest = get().byChannel[channelId] ?? current;
        patchChannel(channelId, {
          messages: prependPage(latest.messages, page.messages),
          hasMore: page.hasMore,
          loadingOlder: false,
        });
      } catch {
        patchChannel(channelId, { loadingOlder: false });
      }
    },

    sendMessage: async (channelId, author, content, attachments = [], gif, replyTo = null, options = {}) => {
      const nonce = createNonce();
      const now = new Date().toISOString();
      const local: ChatMessage = {
        id: localId(nonce),
        channelId,
        author,
        content,
        nonce,
        replyToId: replyTo?.id ?? null,
        replyTo: replyTo
          ? {
              id: replyTo.id,
              authorId: replyTo.author.id,
              authorName: replyTo.author.displayName,
              content: replyTo.content.slice(0, 140),
              deleted: false,
              hasAttachments: replyTo.attachments.length > 0,
            }
          : null,
        reactions: [],
        mentions: [],
        attachments,
        createdAt: now,
        updatedAt: now,
        editedAt: null,
        edited: false,
        // Shown at once from the picker's proxied images; the server's copy replaces it.
        embeds: gif
          ? [
              {
                type: 'gif',
                provider: gif.provider,
                id: gif.id,
                url: gif.url,
                title: gif.title,
                media: { url: gif.mediaProxy, width: gif.media.width, height: gif.media.height },
                preview: { url: gif.previewProxy, width: gif.preview.width, height: gif.preview.height },
              },
            ]
          : [],
        localGif: gif ? { provider: gif.provider, id: gif.id, url: gif.url, title: gif.title, media: gif.media, preview: gif.preview } : undefined,
        localStatus: 'pending',
        ...(options.tts && content.length > 0 ? { tts: true } : {}),
      };
      if (!get().byChannel[channelId]) patchChannel(channelId, { status: 'ready', hasMore: true });
      updateMessages(channelId, (list) => upsertMessage(list, local));
      await deliver(
        channelId,
        local,
        attachments.map((a) => a.id),
      );
    },

    retryMessage: async (channelId, id) => {
      const message = get().byChannel[channelId]?.messages.find((m) => m.id === id);
      if (message?.localStatus !== 'failed') return;
      const pendingMessage: ChatMessage = { ...message, localStatus: 'pending', localError: undefined };
      updateMessages(channelId, (list) => list.map((m) => (m.id === id ? pendingMessage : m)));
      // Same nonce: if the first attempt actually reached the server, it returns the stored message.
      await deliver(
        channelId,
        pendingMessage,
        message.attachments.map((a) => a.id),
      );
    },

    discardMessage: (channelId, id) => {
      updateMessages(channelId, (list) => list.filter((m) => m.id !== id));
    },

    editMessage: async (messageId, content) => {
      const { message } = await messagesApi.edit(messageId, content);
      get().applyUpdated(message);
    },

    deleteMessage: async (messageId) => {
      const message = findMessage(messageId);
      await messagesApi.remove(messageId);
      if (message) get().applyDeleted({ id: messageId, channelId: message.channelId, deletedAt: new Date().toISOString() });
    },

    applyCreated: (message, selfId) => {
      const { byChannel, activeChannelId } = get();
      const cached = byChannel[message.channelId];
      // After a jump into older history the newest messages are not loaded: do not append past the gap.
      if (cached?.status === 'ready' && !cached.hasNewer) {
        updateMessages(message.channelId, (list) => upsertMessage(list, message));
      }
      if (message.channelId !== activeChannelId && message.author.id !== selfId) {
        set((s) => ({ unread: { ...s.unread, [message.channelId]: true } }));
      }
      // DMs: newest conversation first.
      if (get().dms.some((d) => d.id === message.channelId)) {
        set((s) => {
          const dm = s.dms.find((d) => d.id === message.channelId);
          return dm ? { dms: [{ ...dm, lastMessageAt: message.createdAt }, ...s.dms.filter((d) => d.id !== dm.id)] } : s;
        });
      }
      get().typingStopped(message.channelId, message.author.id);
    },

    applyUpdated: (message) => {
      updateMessages(message.channelId, (list) => (list.some((m) => m.id === message.id) ? upsertMessage(list, message) : list));
    },

    applyDeleted: (event) => {
      updateMessages(event.channelId, (list) =>
        list
          .filter((m) => m.id !== event.id)
          // Replies to it now say "Original message deleted".
          .map((m) => (m.replyTo?.id === event.id ? { ...m, replyTo: { ...m.replyTo, deleted: true, content: '', hasAttachments: false } } : m)),
      );
      const reply = get().replyTo[event.channelId];
      if (reply?.id === event.id) get().setReplyTo(event.channelId, null);
    },

    typingStarted: (channelId, userId, expiresInMs) => {
      set((s) => ({
        typing: { ...s.typing, [channelId]: { ...(s.typing[channelId] ?? {}), [userId]: Date.now() + expiresInMs } },
      }));
    },

    typingStopped: (channelId, userId) => {
      const current = get().typing[channelId];
      if (!current || !(userId in current)) return;
      const { [userId]: _removed, ...rest } = current;
      set((s) => ({ typing: { ...s.typing, [channelId]: rest } }));
    },

    resync: async () => {
      const { activeChannelId, byChannel } = get();
      // Other channels may have missed edits/deletes while offline; reload them lazily on open.
      const kept: Record<string, ChannelMessages> = {};
      if (activeChannelId && byChannel[activeChannelId]) kept[activeChannelId] = byChannel[activeChannelId];
      set({ byChannel: kept, typing: {} });
      try {
        await Promise.all([get().loadChannels(), get().loadDms()]);
      } catch {
        /* keep the old list */
      }
      if (activeChannelId) await get().loadLatest(activeChannelId, { force: true });
    },

    reset: () => {
      for (const controller of latestRequests.values()) controller.abort();
      latestRequests.clear();
      set({ channels: [], channelsLoaded: false, dms: [], jump: null, replyTo: {}, activeChannelId: null, byChannel: {}, typing: {}, unread: {} });
    },
  };
});

export const EMPTY_CHANNEL = EMPTY;
