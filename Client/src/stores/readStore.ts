import { create } from 'zustand';
import { channelsApi } from '../api/channels';
import { isApiError } from '../api/errors';
import { messagesApi } from '../api/messages';
import type { Message, NotifyMode, ReadState } from '../api/types';

/**
 * 0.4.0 unread state per channel / DM (source of truth: the server, GET /reads).
 *
 * New messages from others raise the counters locally. A channel only becomes read when the user
 * actually sees it (the message list reports that: channel open, window visible and focused, the
 * newest message on screen); merely loading messages never marks anything read.
 */
interface ReadStore {
  reads: Record<string, ReadState>;
  /**
   * lastReadAt of each channel at the moment it was opened: the "new messages" line stays where it
   * was even after the channel gets marked read.
   */
  openedAt: Record<string, string | null>;
  load: () => Promise<void>;
  apply: (state: ReadState) => void;
  onMessage: (message: Message, selfId: string | null) => void;
  /** Remember where unread started when a channel is opened. */
  noteOpened: (channelId: string) => void;
  markRead: (channelId: string, message?: Pick<Message, 'id' | 'createdAt'>) => void;
  /** Explicit "Mark as read" (also clears the new-messages line). */
  markAllRead: (channelId: string) => void;
  setNotify: (channelId: string, mode: NotifyMode | null) => Promise<void>;
  reset: () => void;
}

const MARK_DELAY_MS = 400;
interface PendingRead {
  messageId?: string;
  revision: number;
  timer: ReturnType<typeof setTimeout> | null;
  sending: boolean;
  retryDelay: number;
}
const pendingReads = new Map<string, PendingRead>();
const observedUnread = new Map<string, Map<string, { createdAt: string; mentioned: boolean; revision: number; unconfirmed: boolean }>>();
const arrivalRevisions = new Map<string, number>();
let sessionGeneration = 0;

function pruneObserved(channelId: string, lastReadAt: string): void {
  const observed = observedUnread.get(channelId);
  if (!observed) return;
  for (const [id, message] of observed) if (message.createdAt <= lastReadAt) observed.delete(id);
  if (observed.size === 0) observedUnread.delete(channelId);
}

/** REST snapshots and socket events can arrive after a newer local read or a newer message. */
function mergeRead(current: ReadState | undefined, incoming: ReadState, preserveLocalCounts = true): ReadState {
  if (current && current.lastReadAt > incoming.lastReadAt) return { ...current, notifyMode: incoming.notifyMode, effectiveNotifyMode: incoming.effectiveNotifyMode, guildId: incoming.guildId };
  pruneObserved(incoming.channelId, incoming.lastReadAt);
  if (!preserveLocalCounts) return incoming;
  if (current?.lastReadAt === incoming.lastReadAt) {
    return { ...incoming, unread: Math.max(incoming.unread, current.unread), mentions: Math.max(incoming.mentions, current.mentions) };
  }
  const observed = [...(observedUnread.get(incoming.channelId)?.values() ?? [])].filter((m) => m.unconfirmed);
  // A response can have been computed before the socket delivered a newer message. These IDs
  // are definitely unread, but may already be included in the server count, so use max, not sum.
  return { ...incoming, unread: Math.max(incoming.unread, observed.length), mentions: Math.max(incoming.mentions, observed.filter((m) => m.mentioned).length) };
}

async function sendRead(channelId: string, pending: PendingRead, revision: number): Promise<{ read: ReadState } | null> {
  let messageId = pending.messageId;
  if (!messageId) {
    // Explicit "mark all": resolve one concrete target so retrying a lost response cannot read
    // messages that arrive later while this chat is no longer open.
    const page = await messagesApi.history(channelId, {}, 1);
    if (pendingReads.get(channelId) !== pending) return null;
    messageId = page.messages.at(-1)?.id;
    if (!messageId) return null;
    if (pending.revision === revision) pending.messageId = messageId;
  }
  return channelsApi.markRead(channelId, messageId);
}

/** One request per channel at a time. New targets coalesce without postponing the first send. */
function scheduleRead(channelId: string, pending: PendingRead, delay = MARK_DELAY_MS): void {
  if (pending.sending || pending.timer !== null) return;
  pending.timer = setTimeout(() => {
    pending.timer = null;
    pending.sending = true;
    const revision = pending.revision;
    sendRead(channelId, pending, revision).then(
      (result) => {
        if (pendingReads.get(channelId) !== pending) return;
        if (result) useReadStore.getState().apply(result.read);
        pending.sending = false;
        pending.retryDelay = 1000;
        if (pending.revision === revision) pendingReads.delete(channelId);
        else scheduleRead(channelId, pending);
      },
      (error: unknown) => {
        if (pendingReads.get(channelId) !== pending) return;
        pending.sending = false;
        const transient = !isApiError(error) || error.kind === 'network' || error.kind === 'timeout' || error.status === 429 || error.status >= 500;
        if (!transient) {
          pendingReads.delete(channelId);
          return;
        }
        scheduleRead(channelId, pending, pending.retryDelay);
        pending.retryDelay = Math.min(30_000, pending.retryDelay * 2);
      },
    );
  }, delay);
}

const empty = (channelId: string): ReadState => ({ channelId, lastReadAt: new Date(0).toISOString(), unread: 0, mentions: 0, notifyMode: null });

export const useReadStore = create<ReadStore>((set, get) => ({
  reads: {},
  openedAt: {},

  load: async () => {
    const generation = sessionGeneration;
    const arrivals = new Map(arrivalRevisions);
    const { reads } = await channelsApi.reads();
    if (generation !== sessionGeneration) return;
    set((s) => ({
      reads: Object.fromEntries(
        reads.map((r) => {
          const before = arrivals.get(r.channelId) ?? 0;
          const changed = (arrivalRevisions.get(r.channelId) ?? 0) !== before;
          // Messages already received before this GET are accounted for by its authoritative counts
          // (including any deletions). Keep their IDs for deduplication, but not as a count floor.
          for (const message of observedUnread.get(r.channelId)?.values() ?? []) {
            if (message.revision <= before) message.unconfirmed = false;
          }
          return [r.channelId, mergeRead(s.reads[r.channelId], r, changed)];
        }),
      ),
    }));
  },

  apply: (state) => {
    set((s) => {
      const current = s.reads[state.channelId];
      return { reads: { ...s.reads, [state.channelId]: mergeRead(current, state) } };
    });
  },

  onMessage: (message, selfId) => {
    if (!selfId || message.author.id === selfId) return;
    set((s) => {
      const current = s.reads[message.channelId] ?? empty(message.channelId);
      if (message.createdAt <= current.lastReadAt) return s;
      const mentioned = message.mentions?.includes(selfId) === true;
      let observed = observedUnread.get(message.channelId);
      if (observed?.has(message.id)) return s;
      if (!observed) {
        observed = new Map();
        observedUnread.set(message.channelId, observed);
      }
      const revision = (arrivalRevisions.get(message.channelId) ?? 0) + 1;
      arrivalRevisions.set(message.channelId, revision);
      observed.set(message.id, { createdAt: message.createdAt, mentioned, revision, unconfirmed: true });
      // The displayed/server counters are capped at 100; keep only the newest 100 IDs as well.
      if (observed.size > 100) {
        const oldest = [...observed].sort((a, b) => a[1].createdAt.localeCompare(b[1].createdAt))[0];
        if (oldest) observed.delete(oldest[0]);
      }
      return {
        reads: {
          ...s.reads,
          [message.channelId]: { ...current, unread: Math.min(100, current.unread + 1), mentions: Math.min(100, current.mentions + (mentioned ? 1 : 0)) },
        },
      };
    });
  },

  noteOpened: (channelId) => {
    set((s) => ({ openedAt: { ...s.openedAt, [channelId]: s.reads[channelId] && s.reads[channelId].unread > 0 ? s.reads[channelId].lastReadAt : null } }));
  },

  markRead: (channelId, message) => {
    const current = get().reads[channelId];
    if (current && current.unread === 0 && (!message || message.createdAt <= current.lastReadAt)) return;
    if (message && current && message.createdAt < current.lastReadAt) return;
    if (message) pruneObserved(channelId, message.createdAt);
    set((s) => ({
      reads: {
        ...s.reads,
        // Explicit "mark all" is confirmed by the server; do not use a potentially fast client clock.
        [channelId]: { ...(s.reads[channelId] ?? empty(channelId)), unread: 0, mentions: 0, lastReadAt: message?.createdAt ?? current?.lastReadAt ?? empty(channelId).lastReadAt },
      },
    }));
    let pending = pendingReads.get(channelId);
    if (pending) {
      pending.messageId = message?.id;
      pending.revision += 1;
    } else {
      pending = { messageId: message?.id, revision: 0, timer: null, sending: false, retryDelay: 1000 };
      pendingReads.set(channelId, pending);
    }
    scheduleRead(channelId, pending);
  },

  markAllRead: (channelId) => {
    set((s) => ({ openedAt: { ...s.openedAt, [channelId]: null } }));
    get().markRead(channelId);
  },

  setNotify: async (channelId, mode) => {
    const generation = sessionGeneration;
    const { read } = await channelsApi.setNotify(channelId, mode);
    if (generation !== sessionGeneration) return;
    get().apply(read);
  },

  reset: () => {
    sessionGeneration += 1;
    for (const { timer } of pendingReads.values()) if (timer !== null) clearTimeout(timer);
    pendingReads.clear();
    observedUnread.clear();
    arrivalRevisions.clear();
    set({ reads: {}, openedAt: {} });
  },
}));

/** 0.7.0: the mode that applies (the channel's own, else my server setting, else the server default). */
export function notifyModeOf(state: ReadState | undefined): NotifyMode {
  return state?.effectiveNotifyMode ?? state?.notifyMode ?? 'ALL';
}

export const isMutedRead = (state: ReadState | undefined) => notifyModeOf(state) === 'NONE';
