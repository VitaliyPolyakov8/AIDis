import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, Hash, MessagesSquare, Volume2 } from 'lucide-react';
import type { Channel } from '../../api/types';
import { EMPTY_CHANNEL, useChatStore } from '../../stores/chatStore';
import { useAuthStore } from '../../stores/authStore';
import { useReadStore } from '../../stores/readStore';
import { useCan } from '../../stores/permsStore';
import { useGuildStore } from '../../stores/guildStore';
import { formatClock, formatDayDivider, isSameDay } from '../../utils/time';
import { isGroupedWith } from '../../utils/chat';
import { MessageItem } from './MessageItem';

const LOAD_OLDER_THRESHOLD_PX = 400;
const STICK_THRESHOLD_PX = 90;
const HIGHLIGHT_MS = 2200;

/**
 * 0.5.2: where each channel's list was left when it unmounted (switching to DMs and back remounts
 * the voice chat). Absent = it was at the bottom. In memory only: a restart starts at the bottom.
 */
interface SavedScroll {
  /** First message whose bottom edge was inside the viewport. */
  messageId: string;
  /** Its top edge, in px from the viewport's top edge (negative = partly scrolled past). */
  offset: number;
}
const savedScroll = new Map<string, SavedScroll>();

/** The window is actually seen by the user (not minimized, not in the background). */
function isWindowActive(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus();
}

export function MessageList({ channel }: { channel: Channel }) {
  const { t } = useTranslation();
  const state = useChatStore((s) => s.byChannel[channel.id] ?? EMPTY_CHANNEL);
  const loadOlder = useChatStore((s) => s.loadOlder);
  const loadNewer = useChatStore((s) => s.loadNewer);
  const loadLatest = useChatStore((s) => s.loadLatest);
  const jump = useChatStore((s) => (s.jump?.channelId === channel.id ? s.jump : null));
  const clearJump = useChatStore((s) => s.clearJump);
  const jumpTo = useChatStore((s) => s.jumpTo);
  const user = useAuthStore((s) => s.user);
  const read = useReadStore((s) => s.reads[channel.id]);
  const openedAt = useReadStore((s) => s.openedAt[channel.id] ?? null);
  const markRead = useReadStore((s) => s.markRead);
  const markAllRead = useReadStore((s) => s.markAllRead);
  // 0.7.0: permissions in this channel (loaded once per channel; the server checks again).
  const canManageHere = useCan('MANAGE_MESSAGES', channel.id);
  const canReactHere = useCan('ADD_REACTIONS', channel.id);
  const loadChannelPerms = useGuildStore((s) => s.loadChannelPerms);
  useEffect(() => {
    if (channel.guildId) void loadChannelPerms(channel.id).catch(() => undefined);
  }, [channel.id, channel.guildId, loadChannelPerms]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [initialScroll] = useState(() => savedScroll.get(channel.id) ?? null);
  const restoreTo = useRef(initialScroll);
  const stick = useRef(initialScroll === null);
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const firstId = useRef<string | null>(null);
  const [showJump, setShowJump] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);

  const { messages, hasMore, hasNewer, loadingOlder, status } = state;
  const isDm = channel.type === 'DM';
  const isAdmin = user?.role === 'ADMIN';
  const canManage = isDm ? false : canManageHere;
  const canPin = isDm || canManage;
  const canReact = isDm || canReactHere;

  // First unread message (from someone else) since the channel was opened.
  const firstUnread = openedAt ? messages.find((m) => !m.localStatus && m.author.id !== user?.id && m.createdAt > openedAt) : undefined;
  const unreadCount = read?.unread ?? 0;

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  /** Mark read only when the newest message is really on screen in an active window. */
  const maybeMarkRead = useCallback(() => {
    const current = useChatStore.getState().byChannel[channel.id];
    if (!current || current.status !== 'ready' || current.hasNewer || !stick.current || !isWindowActive()) return;
    const newest = [...current.messages].reverse().find((m) => !m.localStatus);
    const r = useReadStore.getState().reads[channel.id];
    if (!newest || (r && newest.createdAt <= r.lastReadAt)) return;
    markRead(channel.id, newest);
  }, [channel.id, markRead]);

  const requestOlder = useCallback(() => {
    const el = scrollRef.current;
    const current = useChatStore.getState().byChannel[channel.id];
    if (!el || !current || current.loadingOlder || !current.hasMore || current.status !== 'ready') return;
    anchor.current = { height: el.scrollHeight, top: el.scrollTop };
    void loadOlder(channel.id);
  }, [channel.id, loadOlder]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stick.current = distance < STICK_THRESHOLD_PX && !useChatStore.getState().byChannel[channel.id]?.hasNewer;
    setShowJump(distance > 700 || hasNewer);
    if (el.scrollTop < LOAD_OLDER_THRESHOLD_PX) requestOlder();
    if (distance < LOAD_OLDER_THRESHOLD_PX && hasNewer) void loadNewer(channel.id);
    if (stick.current) maybeMarkRead();
  };

  // Keep the viewport stable when older messages are prepended; follow new ones at the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const newFirst = messages[0]?.id ?? null;
    const prepended = anchor.current && newFirst !== firstId.current;
    firstId.current = newFirst;
    if (prepended && anchor.current) {
      el.scrollTop = el.scrollHeight - anchor.current.height + anchor.current.top;
      anchor.current = null;
    } else if (stick.current && !jump) {
      el.scrollTop = el.scrollHeight;
    }
    if (!loadingOlder && anchor.current) anchor.current = null;
  }, [messages, loadingOlder, jump]);

  const openedScrolled = useRef(false);

  // 0.5.2: coming back to a list that was left scrolled up: the same message at the same place.
  useLayoutEffect(() => {
    const saved = restoreTo.current;
    const el = scrollRef.current;
    if (!saved || status !== 'ready' || !el) return;
    restoreTo.current = null;
    if (jump) return;
    const target = el.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(saved.messageId)}"]`);
    if (!target) {
      stick.current = true;
      el.scrollTop = el.scrollHeight;
      return;
    }
    openedScrolled.current = true;
    el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top - saved.offset;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowJump(distance > 700 || hasNewer);
  }, [status, jump, hasNewer]);

  // Remember the position for the next mount (see savedScroll).
  useLayoutEffect(() => {
    const id = channel.id;
    return () => {
      const el = scrollRef.current;
      if (!el) return;
      if (stick.current) {
        savedScroll.delete(id);
        return;
      }
      const top = el.getBoundingClientRect().top;
      for (const node of el.querySelectorAll<HTMLElement>('[data-message-id]')) {
        const rect = node.getBoundingClientRect();
        if (rect.bottom > top && node.dataset.messageId) {
          savedScroll.set(id, {
            messageId: node.dataset.messageId,
            offset: rect.top - top,
          });
          return;
        }
      }
    };
  }, [channel.id]);

  // Opening a channel with unread messages: start at the first unread one, not at the bottom.
  useLayoutEffect(() => {
    if (openedScrolled.current || status !== 'ready' || !firstUnread || jump) return;
    openedScrolled.current = true;
    const el = scrollRef.current;
    const target = el?.querySelector<HTMLElement>(`[data-message-id="${firstUnread.id}"]`);
    if (el && target && target.offsetTop > el.clientHeight * 0.6) {
      stick.current = false;
      el.scrollTop = Math.max(0, target.offsetTop - 80);
    }
  }, [status, firstUnread, jump]);

  // Jump to a message (reply, pin, search, unread): scroll it into view and flash it.
  useEffect(() => {
    if (!jump || status !== 'ready') return;
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-message-id="${jump.messageId}"]`);
    if (!el) return;
    stick.current = false;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setHighlight(jump.messageId);
    clearJump();
    const timer = setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [jump, status, messages, clearJump]);

  // Images and embeds change height after load: stay pinned to the bottom if we were there.
  // 0.5.2: the viewport itself too (unread banner, voice controls, panel resize): its height changes
  // without a scroll event and used to leave the newest messages below the fold.
  useEffect(() => {
    const content = contentRef.current;
    const viewport = scrollRef.current;
    if (!content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (stick.current) scrollToBottom();
    });
    observer.observe(content);
    if (viewport) observer.observe(viewport);
    return () => observer.disconnect();
    // Re-attach once the list replaces the loading skeleton.
  }, [scrollToBottom, status]);

  // Short channels: keep loading until the viewport can scroll (or history ends).
  useEffect(() => {
    const el = scrollRef.current;
    if (el && status === 'ready' && hasMore && !loadingOlder && el.scrollHeight <= el.clientHeight + 20) requestOlder();
  }, [status, hasMore, loadingOlder, messages.length, requestOlder]);

  // New messages while looking at the bottom, or coming back to the window: mark read.
  useEffect(() => {
    maybeMarkRead();
  }, [messages, status, hasNewer, read?.lastReadAt, unreadCount, maybeMarkRead]);
  useEffect(() => {
    const onActive = () => maybeMarkRead();
    window.addEventListener('focus', onActive);
    document.addEventListener('visibilitychange', onActive);
    return () => {
      window.removeEventListener('focus', onActive);
      document.removeEventListener('visibilitychange', onActive);
    };
  }, [maybeMarkRead]);

  // Own new messages always scroll into view.
  const lastMessage = messages[messages.length - 1];
  useEffect(() => {
    if (lastMessage?.localStatus === 'pending' && lastMessage.author.id === user?.id) {
      stick.current = true;
      scrollToBottom();
    }
  }, [lastMessage, user?.id, scrollToBottom]);

  if (status === 'loading' || (status === 'idle' && messages.length === 0)) {
    return (
      <div className="message-scroll">
        <div className="message-skeletons" aria-label={t('chat.loading')} role="status">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="skeleton-row" style={{ opacity: 1 - i * 0.16 }}>
              <span className="skeleton-avatar" />
              <span className="skeleton-lines">
                <span className="skeleton-line" style={{ width: `${18 + ((i * 7) % 14)}%` }} />
                <span className="skeleton-line" style={{ width: `${46 + ((i * 13) % 38)}%` }} />
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="message-scroll center-empty">
        <p>{state.error}</p>
        <button type="button" className="btn btn-secondary" onClick={() => void loadLatest(channel.id, { force: true })}>
          {t('common.tryAgain')}
        </button>
      </div>
    );
  }

  const unreadSince = openedAt && unreadCount > 0 ? formatClock(new Date(firstUnread?.createdAt ?? openedAt)) : null;

  return (
    <div className="message-scroll-wrap">
      {unreadCount > 0 && unreadSince && (
        <div className="unread-banner" role="status">
          <button
            type="button"
            className="unread-banner-jump"
            onClick={() => {
              if (firstUnread) void jumpTo(channel.id, firstUnread.id);
            }}
          >
            {t('chat.unread.banner', { count: unreadCount, time: unreadSince })}
          </button>
          <button type="button" className="unread-banner-mark" onClick={() => markAllRead(channel.id)}>
            {t('chat.unread.markRead')}
          </button>
        </div>
      )}
      <div className="message-scroll" ref={scrollRef} onScroll={onScroll} role="log" aria-label={t('chat.messagesIn', { channel: channel.name })}>
        <div className="message-content" ref={contentRef}>
          {hasMore ? (
            <div className="history-loader" aria-hidden={!loadingOlder}>
              {loadingOlder && <span className="spinner" role="status" aria-label={t('chat.loadingOlder')} />}
            </div>
          ) : (
            <div className="channel-intro">
              <span className="channel-intro-icon" aria-hidden="true">
                {channel.type === 'VOICE' ? <Volume2 size={28} /> : isDm ? <MessagesSquare size={28} /> : <Hash size={28} />}
              </span>
              <h2 className="channel-intro-title">{isDm ? t('dm.welcome', { name: channel.name }) : t(channel.type === 'VOICE' ? 'chat.welcomeVoice' : 'chat.welcome', { channel: channel.name })}</h2>
              <p className="channel-intro-text">{messages.length === 0 ? t('chat.empty') : isDm ? t('dm.beginning') : t('chat.beginning')}</p>
            </div>
          )}
          {/* 0.5.6: one block per day, so the day's date can stay pinned at the top while you scroll
              through that day (it used to slide half under the header) and never stacks on another. */}
          {groupByDay(messages).map((day) => (
            <div className="day-group" key={day.key}>
              <div className="day-divider" role="separator">
                <div className="day-divider-row">
                  <span>{formatDayDivider(day.first.createdAt)}</span>
                </div>
              </div>
              {day.messages.map((message, j) => {
                const prev = day.messages[j - 1];
                const newDay = !prev;
                const isFirstUnread = firstUnread?.id === message.id;
                return (
                  <Fragment key={message.id}>
                    {isFirstUnread && (
                      <div className="new-divider" role="separator" aria-label={t('chat.unread.new')}>
                        <span>{t('chat.unread.new')}</span>
                      </div>
                    )}
                    <MessageItem
                      message={message}
                      grouped={!newDay && !isFirstUnread && isGroupedWith(prev, message)}
                      isOwn={message.author.id === user?.id}
                      canDelete={message.author.id === user?.id || canManage || (isAdmin && !isDm)}
                      canPin={canPin}
                      canReact={canReact}
                      selfId={user?.id}
                      highlighted={highlight === message.id}
                    />
                  </Fragment>
                );
              })}
            </div>
          ))}
          {hasNewer && (
            <div className="history-loader">
              <span className="spinner" role="status" aria-label={t('chat.loadingOlder')} />
            </div>
          )}
        </div>
      </div>
      {showJump && (
        <button
          type="button"
          className="jump-latest"
          onClick={() => {
            if (hasNewer) {
              void loadLatest(channel.id, { force: true }).then(() => {
                stick.current = true;
                scrollToBottom();
              });
              return;
            }
            stick.current = true;
            scrollToBottom(true);
            maybeMarkRead();
          }}
        >
          <ArrowDown size={14} aria-hidden="true" />
          {t('chat.jumpLatest')}
        </button>
      )}
    </div>
  );
}

/** 0.5.6: consecutive messages split by calendar day (keyed by the day, so loading older history keeps the blocks). */
function groupByDay<T extends { createdAt: string }>(messages: readonly T[]): { key: string; first: T; messages: T[] }[] {
  const days: { key: string; first: T; messages: T[] }[] = [];
  for (const message of messages) {
    const last = days[days.length - 1];
    if (last && isSameDay(last.first.createdAt, message.createdAt)) last.messages.push(message);
    else {
      const d = new Date(message.createdAt);
      days.push({
        key: `${String(d.getFullYear())}-${String(d.getMonth() + 1)}-${String(d.getDate())}`,
        first: message,
        messages: [message],
      });
    }
  }
  return days;
}
