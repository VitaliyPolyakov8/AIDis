import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useGuildStore } from '../../stores/guildStore';
import { searchScope } from './searchScope';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Bell, BellOff, BellRing, Pin, Search, X } from 'lucide-react';
import type { Channel, Message, NotifyMode } from '../../api/types';
import { messagesApi } from '../../api/messages';
import { friendlyError } from '../../api/errors';
import { useChatStore } from '../../stores/chatStore';
import { notifyModeOf, useReadStore } from '../../stores/readStore';
import { usePresenceStore } from '../../stores/presenceStore';
import { toast, useUiStore } from '../../stores/uiStore';
import { formatMessageTimestamp } from '../../utils/time';
import { Avatar } from '../Avatar';
import { StyledName } from '../profile/StyledName';
import { usePopover } from '../profile/usePopover';
import { openMenu } from '../menu/MenuHost';
import { linkTo } from '../guilds/routes';
import { ChannelGalleryButton } from './ChannelGallery';
import { emojiShortcodes } from '../../emojis/tokens';

/** Path of a channel's chat view (text channel, voice channel chat or DM). */
export function channelPath(channel: Pick<Channel, 'id' | 'type' | 'guildId'>): string {
  return linkTo(channel);
}

function findChannel(channelId: string): Channel | undefined {
  const { channels, dms } = useChatStore.getState();
  return channels.find((c) => c.id === channelId) ?? dms.find((c) => c.id === channelId);
}

/** Opens the right view and scrolls to the message. */
export function useJumpToMessage() {
  const navigate = useNavigate();
  const jumpTo = useChatStore((s) => s.jumpTo);
  return useCallback(
    (message: Pick<Message, 'id' | 'channelId'>) => {
      const channel = findChannel(message.channelId);
      if (!channel) return;
      if (channel.type === 'VOICE') useUiStore.getState().setVoiceChat(true);
      void navigate(channelPath(channel));
      void jumpTo(message.channelId, message.id);
    },
    [navigate, jumpTo],
  );
}

function MiniMessage({ message, onOpen }: { message: Message; onOpen: () => void }) {
  const { t } = useTranslation();
  const author = usePresenceStore((s) => s.users[message.author.id]) ?? message.author;
  const channel = findChannel(message.channelId);
  return (
    <button type="button" className="mini-message" onClick={onOpen}>
      <Avatar userId={message.author.id} name={author.displayName} avatarAttachmentId={author.avatarAttachmentId} size={28} />
      <span className="mini-message-body">
        <span className="mini-message-meta">
          <span className="mini-message-author">
            <StyledName userId={message.author.id} name={author.displayName} fallback={message.author} />
          </span>
          {channel && channel.type !== 'DM' && <span className="mini-message-channel">#{channel.name}</span>}
          <time dateTime={message.createdAt}>{formatMessageTimestamp(message.createdAt)}</time>
        </span>
        <span className="mini-message-text">{emojiShortcodes(message.content) || (message.attachments.length > 0 ? `📎 ${message.attachments[0]?.originalName ?? ''}` : t('chat.reply.attachment'))}</span>
      </span>
    </button>
  );
}

function PinsPopover({ channel, x, y, onClose }: { channel: Channel; x: number; y: number; onClose: () => void }) {
  const { t } = useTranslation();
  const { ref, style } = usePopover(x, y, onClose);
  const [pins, setPins] = useState<Message[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const jump = useJumpToMessage();
  // Pins change in realtime too (message.updated): re-read the list when cached pins change.
  const pinnedKey = useChatStore((s) =>
    (s.byChannel[channel.id]?.messages ?? [])
      .filter((m) => m.pinnedAt)
      .map((m) => m.id)
      .join(','),
  );
  useEffect(() => {
    messagesApi.pins(channel.id).then(
      ({ messages }) => setPins(messages),
      (e: unknown) => setError(friendlyError(e, t('chat.pins.loadFailed'))),
    );
  }, [channel.id, pinnedKey, t]);
  return createPortal(
    <div ref={ref} className="popover-panel pins-panel" role="dialog" aria-label={t('chat.pins.title')} style={style}>
      <div className="popover-panel-head">
        <Pin size={16} aria-hidden="true" />
        <span>{t('chat.pins.title')}</span>
        <button type="button" className="icon-btn" aria-label={t('common.close')} onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <div className="popover-panel-body">
        {error && <p className="popover-empty">{error}</p>}
        {!error && pins === null && <span className="spinner" role="status" aria-label={t('common.loading')} />}
        {pins?.length === 0 && (
          <div className="popover-empty">
            <Pin size={28} aria-hidden="true" />
            <p>{t('chat.pins.empty')}</p>
          </div>
        )}
        {pins?.map((m) => (
          <MiniMessage
            key={m.id}
            message={m}
            onOpen={() => {
              onClose();
              jump(m);
            }}
          />
        ))}
      </div>
    </div>,
    document.body,
  );
}

const NOTIFY_ICON: Record<NotifyMode, typeof Bell> = { ALL: Bell, MENTIONS: BellRing, NONE: BellOff };

/** Header buttons: pinned messages, notification mode, search (shared by channels, voice chats and DMs). */
export function ChannelTools({ channel }: { channel: Channel }) {
  const { t } = useTranslation();
  const [pins, setPins] = useState<{ x: number; y: number } | null>(null);
  const read = useReadStore((s) => s.reads[channel.id]);
  const setNotify = useReadStore((s) => s.setNotify);
  const mode = notifyModeOf(read);
  const Icon = NOTIFY_ICON[mode];
  const closePins = useCallback(() => setPins(null), []);

  const openNotify = (e: ReactMouseEvent) => {
    const pick = (m: NotifyMode) => () => {
      setNotify(channel.id, m).catch((err: unknown) => toast.error(friendlyError(err, t('notify.failed')), 'notify'));
    };
    openMenu(
      e,
      [
        { kind: 'title', label: t('notify.title') },
        { label: t('notify.ALL'), onSelect: pick('ALL'), checked: mode === 'ALL' },
        { label: t('notify.MENTIONS'), onSelect: pick('MENTIONS'), checked: mode === 'MENTIONS' },
        { label: t('notify.NONE'), onSelect: pick('NONE'), checked: mode === 'NONE' },
      ],
      t('notify.title'),
    );
  };

  return (
    <>
      <ChannelGalleryButton key={channel.id} channel={channel} />
      <button
        type="button"
        className={`icon-btn${pins ? ' is-active' : ''}`}
        aria-label={t('chat.pins.title')}
        title={t('chat.pins.title')}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setPins(pins ? null : { x: rect.right - 380, y: rect.bottom + 6 });
        }}
      >
        <Pin size={18} />
      </button>
      <button type="button" className={`icon-btn${mode !== 'ALL' ? ' is-active' : ''}`} aria-label={t('notify.title')} title={`${t('notify.title')}: ${t(`notify.${mode}`)}`} onClick={openNotify}>
        <Icon size={18} />
      </button>
      <SearchBox channel={channel} />
      {pins && <PinsPopover channel={channel} x={pins.x} y={pins.y} onClose={closePins} />}
    </>
  );
}

function SearchBox({ channel }: { channel: Channel }) {
  const { t } = useTranslation();
  const query = useUiStore((s) => s.search.query);
  const openSearch = useUiStore((s) => s.openSearch);
  const [value, setValue] = useState(query);
  const [synced, setSynced] = useState(query);
  const inputRef = useRef<HTMLInputElement>(null);
  // A search opened elsewhere (or closed) updates the box: adjust state during render.
  if (synced !== query) {
    setSynced(query);
    setValue(query);
  }
  // Ctrl+F focuses the search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <form
      className="header-search"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) openSearch(value.trim(), channel.id);
      }}
    >
      <Search size={14} aria-hidden="true" />
      <input ref={inputRef} value={value} placeholder={t('search.placeholder')} aria-label={t('search.placeholder')} onChange={(e) => setValue(e.target.value)} maxLength={100} />
    </form>
  );
}

/** Right-hand search results panel (replaces the member list while open). */
export function SearchPanel() {
  const { t } = useTranslation();
  const search = useUiStore((s) => s.search);
  const closeSearch = useUiStore((s) => s.closeSearch);
  const users = usePresenceStore((s) => s.users);
  const [scope, setScope] = useState<'channel' | 'all'>('all');
  const [authorId, setAuthorId] = useState('');
  // Results belong to one exact request; a different key means "loading".
  const key = `${search.query}|${scope === 'channel' ? (search.channelId ?? '') : ''}|${authorId}`;
  const [answer, setAnswer] = useState<{ key: string; messages: Message[] | null; error: string | null } | null>(null);
  const jump = useJumpToMessage();

  useEffect(() => {
    if (!search.open || !search.query) return;
    const controller = new AbortController();
    messagesApi
      .search(
        { q: search.query, ...searchScope(scope, search.channelId ? findChannel(search.channelId) : undefined, useGuildStore.getState().activeGuildId), authorId: authorId || undefined, limit: 50 },
        controller.signal,
      )
      .then(
        ({ messages }) => setAnswer({ key, messages, error: null }),
        (e: unknown) => {
          if (!controller.signal.aborted) setAnswer({ key, messages: null, error: friendlyError(e, t('search.failed')) });
        },
      );
    return () => controller.abort();
  }, [search.open, search.query, search.channelId, scope, authorId, key, t]);
  const current = answer?.key === key ? answer : null;
  const results = current?.messages ?? null;
  const error = current?.error ?? null;

  if (!search.open) return null;
  const channel = search.channelId ? findChannel(search.channelId) : undefined;
  return (
    <aside className="search-panel" aria-label={t('search.title')}>
      <div className="search-panel-head">
        <Search size={16} aria-hidden="true" />
        <span className="search-panel-title">{t('search.results', { query: search.query })}</span>
        <button type="button" className="icon-btn" aria-label={t('common.close')} onClick={closeSearch}>
          <X size={16} />
        </button>
      </div>
      <div className="search-panel-filters">
        <div className="segmented" role="radiogroup" aria-label={t('search.scope')}>
          <button type="button" role="radio" aria-checked={scope === 'all'} className={scope === 'all' ? 'is-active' : ''} onClick={() => setScope('all')}>
            {t('search.everywhere')}
          </button>
          <button type="button" role="radio" aria-checked={scope === 'channel'} className={scope === 'channel' ? 'is-active' : ''} disabled={!channel} onClick={() => setScope('channel')}>
            {channel ? (channel.type === 'DM' ? t('search.thisChat') : `#${channel.name}`) : t('search.thisChat')}
          </button>
        </div>
        <select className="select select-sm" value={authorId} onChange={(e) => setAuthorId(e.target.value)} aria-label={t('search.author')}>
          <option value="">{t('search.anyAuthor')}</option>
          {Object.values(users)
            .sort((a, b) => a.displayName.localeCompare(b.displayName))
            .map((u) => (
              <option key={u.id} value={u.id}>
                {u.displayName}
              </option>
            ))}
        </select>
      </div>
      <div className="search-panel-body">
        {error && <p className="popover-empty">{error}</p>}
        {!error && results === null && <span className="spinner" role="status" aria-label={t('common.loading')} />}
        {results?.length === 0 && (
          <div className="popover-empty">
            <Search size={28} aria-hidden="true" />
            <p>{t('search.nothing')}</p>
          </div>
        )}
        {results && results.length > 0 && <p className="search-count">{t('search.count', { count: results.length })}</p>}
        {results?.map((m) => (
          <MiniMessage key={m.id} message={m} onOpen={() => jump(m)} />
        ))}
      </div>
    </aside>
  );
}
