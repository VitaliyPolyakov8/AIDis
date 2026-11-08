import { memo, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useChannelMemberDisplay } from '../../stores/guildStore';
import { displayNicknameColor, useNicknameColor } from '../profile/nicknameColor';
import { useTranslation } from 'react-i18next';
import { CircleAlert, Copy, CornerUpLeft, MoreHorizontal, Pencil, Pin, PinOff, RotateCw, SmilePlus, Trash, Volume2, X } from 'lucide-react';
import { friendlyError } from '../../api/errors';
import { useChatStore, type ChatMessage } from '../../stores/chatStore';
import { config } from '../../config';
import { Avatar } from '../Avatar';
import { openProfile } from '../profile/profileState';
import { usePresenceStore } from '../../stores/presenceStore';
import { toast } from '../../stores/uiStore';
import { ConfirmDialog } from '../ConfirmDialog';
import { closeMenu, openEmojiPicker, openMenu, type MenuEntry } from '../menu/MenuHost';
import { MessageText } from './MessageText';
import { MessageAttachments } from './AttachmentView';
import { MessageEmbeds } from './MessageEmbeds';
import { InviteCards } from './InviteCard';
import { EmojiGlyph } from '../../emojis/EmojiImage';
import { useEmojiStore } from '../../emojis/store';
import { createEmojiDraft, emojiShortcodes } from '../../emojis/tokens';
import { useNameStyle } from '../profile/nameStyle';
import { formatClock, formatFullDate, formatMessageTimestamp } from '../../utils/time';

interface MessageItemProps {
  message: ChatMessage;
  grouped: boolean;
  isOwn: boolean;
  canDelete: boolean;
  /** 0.4.0 */
  canPin?: boolean;
  canReact?: boolean;
  selfId?: string | null;
  highlighted?: boolean;
}

/** The quick reactions of the hover strip (kept short on purpose). */
export const QUICK_REACTIONS = ['👍', '❤️', '😂'] as const;

function EditBox({ message, onDone }: { message: ChatMessage; onDone: () => void }) {
  const { t } = useTranslation();
  const editMessage = useChatStore((s) => s.editMessage);
  const [draft] = useState(() => createEmojiDraft(message.content, useEmojiStore.getState().emojis));
  const [value, setValue] = useState(draft.text);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [value]);

  const save = async () => {
    const content = value.trim();
    if (!content) {
      setError(t('chat.editEmpty'));
      return;
    }
    if (content === draft.text) {
      onDone();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await editMessage(message.id, draft.restore(content));
      onDone();
    } catch (e) {
      setError(friendlyError(e, t('chat.editFailed')));
      setSaving(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onDone();
    } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void save();
    }
  };

  return (
    <div className="edit-box">
      <textarea
        ref={ref}
        className="edit-input"
        spellCheck={true}
        value={value}
        maxLength={config.maxMessageLength}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={saving}
        aria-label={t('chat.editLabel')}
        rows={1}
      />
      <div className="edit-hint">
        {error ? (
          <span className="field-error">{error}</span>
        ) : (
          <span>
            {t('chat.editHintCancel')}{' '}
            <button type="button" className="link-btn" onClick={onDone}>
              {t('chat.cancelLower')}
            </button>
            {' · '}
            {t('chat.editHintSave')}{' '}
            <button type="button" className="link-btn" onClick={() => void save()}>
              {t('chat.saveLower')}
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

/** "↱ @Name preview…" above a reply; clicking jumps to the original. */
function ReplyLine({ message }: { message: ChatMessage }) {
  const { t } = useTranslation();
  const reply = message.replyTo;
  const jumpTo = useChatStore((s) => s.jumpTo);
  const author = usePresenceStore((s) => (reply ? s.users[reply.authorId] : undefined));
  if (!reply) return null;
  const name = author?.displayName ?? reply.authorName;
  return (
    <div className="reply-line">
      <span className="reply-spine" aria-hidden="true" />
      {reply.deleted ? (
        <span className="reply-deleted">{t('chat.reply.deleted')}</span>
      ) : (
        <button type="button" className="reply-target" onClick={() => void jumpTo(message.channelId, reply.id)} title={t('chat.reply.jump')}>
          <Avatar userId={reply.authorId} name={name} avatarAttachmentId={author?.avatarAttachmentId} size={16} />
          <span className="reply-author" style={author?.accentColor ? { color: author.accentColor } : undefined}>
            @{name}
          </span>
          <span className="reply-preview">{emojiShortcodes(reply.content) || (reply.hasAttachments ? t('chat.reply.attachment') : '')}</span>
        </button>
      )}
    </div>
  );
}

function Reactions({ message, selfId, canReact }: { message: ChatMessage; selfId: string | null | undefined; canReact: boolean }) {
  const { t } = useTranslation();
  const toggle = useChatStore((s) => s.toggleReaction);
  const users = usePresenceStore((s) => s.users);
  const serverEmojis = useEmojiStore((s) => s.emojis);
  const reactions = message.reactions ?? [];
  if (reactions.length === 0) return null;
  const react = (emoji: string) => {
    toggle(message, emoji).catch((e: unknown) => toast.error(friendlyError(e, t('chat.reactions.failed')), 'reaction'));
  };
  return (
    <div className="reactions" role="group" aria-label={t('chat.reactions.title')}>
      {reactions.map((r) => {
        const mine = selfId ? r.userIds.includes(selfId) : false;
        const names = r.userIds.map((id) => users[id]?.displayName ?? '…');
        const who = names.length > 6 ? `${names.slice(0, 6).join(', ')} +${names.length - 6}` : names.join(', ');
        const label = r.emoji.startsWith('custom:') ? `:${serverEmojis.find((e) => e.id === r.emoji.slice(7))?.name ?? 'emoji'}:` : r.emoji;
        return (
          <button
            key={r.emoji}
            type="button"
            className={`reaction${mine ? ' is-mine' : ''}`}
            aria-pressed={mine}
            disabled={!canReact}
            title={t('chat.reactions.who', { names: who, emoji: label })}
            onClick={() => react(r.emoji)}
          >
            <span className="reaction-emoji">
              <EmojiGlyph value={r.emoji} />
            </span>
            <span className="reaction-count">{r.count}</span>
          </button>
        );
      })}
      {canReact && (
        <button type="button" className="reaction reaction-add" aria-label={t('chat.reactions.add')} title={t('chat.reactions.add')} onClick={(e) => openEmojiPicker(e, react)}>
          <SmilePlus size={15} />
        </button>
      )}
    </div>
  );
}

export const MessageItem = memo(function MessageItem({ message, grouped, isOwn, canDelete, canPin = false, canReact = true, selfId, highlighted = false }: MessageItemProps) {
  const { t } = useTranslation();
  // Current profile (updated in realtime) wins over the author snapshot stored with the message.
  const globalAuthor = usePresenceStore((st) => st.users[message.author.id]) ?? message.author;
  // 0.7.0: on a server, the author's server profile (nickname, avatar) and the role colour.
  const shown = useChannelMemberDisplay(message.channelId, message.author.id);
  const author = { ...globalAuthor, displayName: shown.name === '…' ? globalAuthor.displayName : shown.name, avatarAttachmentId: shown.avatarAttachmentId ?? globalAuthor.avatarAttachmentId };
  // 0.5.0: the author's own nickname color wins (only the name is colored, never the text).
  const nameColor = useNicknameColor(message.author.id) ?? displayNicknameColor(message.author.nicknameColor);
  // 0.5.5: gradient / glow / font of the name (role colour, then accent colour when no colour is set).
  const nameStyle = useNameStyle(message.author.id, message.author, nameColor ?? shown.roleColor ?? author.accentColor ?? null);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleteMessage = useChatStore((s) => s.deleteMessage);
  const retryMessage = useChatStore((s) => s.retryMessage);
  const discardMessage = useChatStore((s) => s.discardMessage);
  const setReplyTo = useChatStore((s) => s.setReplyTo);
  const toggleReaction = useChatStore((s) => s.toggleReaction);
  const setPinned = useChatStore((s) => s.setPinned);

  const isLocal = !!message.localStatus;
  const mentionsMe = !!selfId && !isOwn && message.mentions?.includes(selfId) === true;
  const fullTime = formatFullDate(message.createdAt);
  // A reply always shows its header, so the quote line has an author under it.
  const showHeader = !grouped || !!message.replyTo;
  const classes = [
    'message',
    showHeader ? 'is-first' : 'is-grouped',
    editing ? 'is-editing' : '',
    message.localStatus === 'pending' ? 'is-pending' : '',
    message.localStatus === 'failed' ? 'is-failed' : '',
    mentionsMe ? 'is-mentioned' : '',
    highlighted ? 'is-highlighted' : '',
    message.pinnedAt ? 'is-pinned' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const react = (emoji: string) => {
    toggleReaction(message, emoji).catch((e: unknown) => toast.error(friendlyError(e, t('chat.reactions.failed')), 'reaction'));
  };
  const reply = () => setReplyTo(message.channelId, message);
  const pin = (pinned: boolean) => {
    setPinned(message.id, pinned).then(
      () => toast.success(pinned ? t('chat.pins.pinned') : t('chat.pins.unpinned'), 'pin'),
      (e: unknown) => toast.error(friendlyError(e, t('chat.pins.failed')), 'pin'),
    );
  };

  const menuEntries = (): MenuEntry[] => {
    const entries: MenuEntry[] = [];
    if (canReact) {
      entries.push({
        kind: 'custom',
        render: () => (
          <div className="menu-quick-reactions">
            {['👍', '❤️', '😂', '😮', '😢', '🔥'].map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => {
                  closeMenu();
                  react(e);
                }}
              >
                {e}
              </button>
            ))}
          </div>
        ),
      });
      entries.push({ kind: 'separator' });
      entries.push({ label: t('chat.reply.action'), icon: <CornerUpLeft size={15} />, onSelect: reply });
    }
    if (isOwn) entries.push({ label: t('chat.edit'), icon: <Pencil size={15} />, onSelect: () => setEditing(true) });
    if (canPin) {
      entries.push(message.pinnedAt ? { label: t('chat.pins.unpin'), icon: <PinOff size={15} />, onSelect: () => pin(false) } : { label: t('chat.pins.pin'), icon: <Pin size={15} />, onSelect: () => pin(true) });
    }
    if (message.content) {
      entries.push({
        label: t('chat.copyText'),
        icon: <Copy size={15} />,
        onSelect: () => {
          void navigator.clipboard.writeText(message.content).then(() => toast.success(t('chat.copied'), 'copy'));
        },
      });
    }
    if (canDelete) {
      entries.push({ kind: 'separator' });
      entries.push({ label: t('common.delete'), icon: <Trash size={15} />, danger: true, onSelect: () => setConfirmDelete(true) });
    }
    return entries;
  };

  const onContextMenu = (e: MouseEvent) => {
    if (isLocal || editing) return;
    // Keep the normal menu on links and selected text.
    if ((e.target as HTMLElement).closest('a') || (window.getSelection()?.toString() ?? '') !== '') return;
    openMenu(e, menuEntries(), t('chat.actions'));
  };

  return (
    <article className={classes} tabIndex={-1} data-message-id={message.id} aria-label={`${author.displayName}, ${formatMessageTimestamp(message.createdAt)}`} onContextMenu={onContextMenu}>
      {message.replyTo && <ReplyLine message={message} />}
      <div className="message-row">
        <div className="message-gutter">
          {!showHeader ? (
            <time className="message-hover-time" dateTime={message.createdAt} title={fullTime}>
              {formatClock(new Date(message.createdAt))}
            </time>
          ) : (
            <button type="button" className="message-avatar-btn" aria-label={author.displayName} onClick={(e) => openProfile(e, message.author.id)}>
              <Avatar userId={message.author.id} name={author.displayName} avatarAttachmentId={author.avatarAttachmentId} size={38} />
            </button>
          )}
        </div>
        <div className="message-main">
          {showHeader && (
            <div className="message-meta">
              <button type="button" className={`message-author ${nameStyle.className}`} style={nameStyle.style} onClick={(e) => openProfile(e, message.author.id)}>
                {author.displayName}
              </button>
              <time className="message-time" dateTime={message.createdAt} title={fullTime}>
                {formatMessageTimestamp(message.createdAt)}
              </time>
              {message.pinnedAt && (
                <span className="message-pinned" title={t('chat.pins.pinnedBadge')}>
                  <Pin size={12} aria-hidden="true" />
                </span>
              )}
            </div>
          )}
          {editing ? (
            <EditBox message={message} onDone={() => setEditing(false)} />
          ) : (
            message.content && (
              <div className="message-body">
                <MessageText text={message.content} />
                {message.tts && (
                  <span className="message-tts" title={t('tts.badge')}>
                    <Volume2 size={12} role="img" aria-label={t('tts.badge')} />
                  </span>
                )}
                {message.edited && (
                  <span className="message-edited" title={message.editedAt ? formatFullDate(message.editedAt) : undefined}>
                    ({t('chat.edited')})
                  </span>
                )}
              </div>
            )
          )}
          {message.embeds && message.embeds.length > 0 && <MessageEmbeds embeds={message.embeds} />}
          <InviteCards content={message.content} />
          {message.attachments.length > 0 && <MessageAttachments attachments={message.attachments} />}
          <Reactions message={message} selfId={selfId} canReact={canReact && !isLocal} />
          {message.localStatus === 'failed' && (
            <div className="message-failed" role="alert">
              <CircleAlert size={14} aria-hidden="true" />
              <span>{message.localError ?? t('chat.notSent')}</span>
              <button type="button" className="link-btn" onClick={() => void retryMessage(message.channelId, message.id)}>
                <RotateCw size={12} aria-hidden="true" /> {t('chat.retry')}
              </button>
              <button type="button" className="link-btn" onClick={() => discardMessage(message.channelId, message.id)}>
                <X size={12} aria-hidden="true" /> {t('chat.discard')}
              </button>
            </div>
          )}
        </div>
      </div>

      {!isLocal && !editing && (
        <div className="message-actions" role="toolbar" aria-label={t('chat.actions')}>
          {canReact &&
            QUICK_REACTIONS.map((emoji) => (
              <button key={emoji} type="button" className="icon-btn action-emoji" aria-label={t('chat.reactions.react', { emoji })} title={emoji} onClick={() => react(emoji)}>
                {emoji}
              </button>
            ))}
          {canReact && (
            <button type="button" className="icon-btn" aria-label={t('chat.reactions.add')} title={t('chat.reactions.add')} onClick={(e) => openEmojiPicker(e, react)}>
              <SmilePlus size={16} />
            </button>
          )}
          {canReact && <span className="message-actions-sep" aria-hidden="true" />}
          {canReact && (
            <button type="button" className="icon-btn" aria-label={t('chat.reply.action')} title={t('chat.reply.action')} onClick={reply}>
              <CornerUpLeft size={16} />
            </button>
          )}
          {isOwn && (
            <button type="button" className="icon-btn" aria-label={t('chat.editLabel')} title={t('chat.edit')} onClick={() => setEditing(true)}>
              <Pencil size={15} />
            </button>
          )}
          <button type="button" className="icon-btn" aria-label={t('chat.more')} title={t('chat.more')} onClick={(e) => openMenu(e, menuEntries(), t('chat.actions'))}>
            <MoreHorizontal size={16} />
          </button>
        </div>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title={t('chat.deleteMessage')}
          confirmLabel={t('common.delete')}
          onClose={() => setConfirmDelete(false)}
          onConfirm={async () => {
            try {
              await deleteMessage(message.id);
            } catch (e) {
              throw new Error(friendlyError(e, t('chat.deleteFailed')), { cause: e });
            }
          }}
        >
          <p>{isOwn ? t('chat.deleteOwn') : t('chat.deleteOther', { name: author.displayName })}</p>
          {message.content && <blockquote className="confirm-quote">{message.content.slice(0, 280)}</blockquote>}
        </ConfirmDialog>
      )}
    </article>
  );
});
