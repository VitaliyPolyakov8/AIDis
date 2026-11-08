import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { CornerUpLeft, FileText, Paperclip, Plus, SendHorizontal, Smile, Volume2, X } from 'lucide-react';
import type { Attachment, Channel, GifResult } from '../../api/types';
import { EmojiPicker } from './EmojiPicker';
import { GifPicker } from './GifPicker';
import { VoiceMessageRecorder } from '../../voice-messages/VoiceMessageRecorder';
import { insertAtCaret } from './emoji';
import { attachmentsApi, MAX_LARGE_UPLOAD_BYTES, uploadAttachment, type UploadHandle } from '../../api/attachments';
import { friendlyError, isApiError } from '../../api/errors';
import { config } from '../../config';
import { realtime } from '../../realtime/socket';
import { useAuthStore } from '../../stores/authStore';
import { useChatStore } from '../../stores/chatStore';
import { formatBytes, isPreviewableImage } from '../../utils/format';
import { usePresenceStore } from '../../stores/presenceStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { parseTtsCommand } from '../../voice/tts';
import { Avatar } from '../Avatar';
import { StyledName } from '../profile/StyledName';
import type { PublicUser } from '../../api/types';

/** The "@partial" being typed right before the caret, if any. */
export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const match = /(^|[^\w@])@([A-Za-z0-9_.-]{0,32})$/.exec(before);
  if (!match) return null;
  const query = match[2] ?? '';
  return { start: caret - query.length - 1, query };
}

/** Users for the @ list: username or display name starting with (then containing) the query. */
export function mentionCandidates(users: PublicUser[], query: string, limit = 8): PublicUser[] {
  const q = query.toLowerCase();
  const score = (u: PublicUser) => {
    const name = u.username.toLowerCase();
    const display = u.displayName.toLowerCase();
    if (name.startsWith(q) || display.startsWith(q)) return 0;
    if (name.includes(q) || display.includes(q)) return 1;
    return 2;
  };
  return users
    .filter((u) => score(u) < 2)
    .sort((a, b) => score(a) - score(b) || a.displayName.localeCompare(b.displayName))
    .slice(0, limit);
}

const TYPING_REFRESH_MS = 3000;
const TYPING_IDLE_MS = 4000;
const MAX_FILES = 10;

interface PendingUpload {
  key: string;
  file: File;
  progress: number;
  status: 'uploading' | 'done' | 'error';
  attachment?: Attachment;
  error?: string;
  previewUrl?: string;
  handle?: UploadHandle;
  /** 0.5.5: the connection broke; the upload continues by itself at this time. */
  retryAt?: number;
}

let uploadKey = 0;

/** Sends typing.start at most every 3 s while typing and typing.stop after 4 s idle. */
function useTypingEmitter(channelId: string) {
  const lastStart = useRef(0);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stop = useCallback(() => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = null;
    if (lastStart.current !== 0) {
      lastStart.current = 0;
      realtime.emitTyping(channelId, false);
    }
  }, [channelId]);

  const ping = useCallback(() => {
    const now = Date.now();
    if (now - lastStart.current > TYPING_REFRESH_MS) {
      lastStart.current = now;
      realtime.emitTyping(channelId, true);
    }
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(stop, TYPING_IDLE_MS);
  }, [channelId, stop]);

  useEffect(() => stop, [stop]);
  return { ping, stop };
}

export function Composer({ channel }: { channel: Channel }) {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const sendMessage = useChatStore((s) => s.sendMessage);
  // 0.5.2: "read aloud" in voice channel chats and DMs (toggle, or "/tts text" for one message).
  const ttsAllowed = channel.type === 'VOICE' || channel.type === 'DM';
  const ttsSend = useSettingsStore((s) => s.ttsSend);
  const replyTo = useChatStore((s) => s.replyTo[channel.id] ?? null);
  const setReplyTo = useChatStore((s) => s.setReplyTo);
  const replyAuthor = usePresenceStore((s) => (replyTo ? s.users[replyTo.author.id] : undefined));
  const allUsers = usePresenceStore((s) => s.users);
  const [mention, setMention] = useState<{ start: number; query: string; index: number } | null>(null);
  const [text, setText] = useState('');
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [picker, setPicker] = useState<'emoji' | 'gif' | null>(null);
  const closePicker = useCallback(() => setPicker(null), []);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const uploadsRef = useRef<PendingUpload[]>([]);
  const typing = useTypingEmitter(channel.id);

  useEffect(() => {
    uploadsRef.current = uploads;
  }, [uploads]);

  // Leaving the channel: abort uploads, delete files that were uploaded but never sent, free previews.
  useEffect(
    () => () => {
      for (const u of uploadsRef.current) {
        // 0.5.5: a large upload keeps what arrived (picking the same file again continues it).
        if (u.handle?.suspend) u.handle.suspend();
        else u.handle?.abort();
        if (u.previewUrl) URL.revokeObjectURL(u.previewUrl);
        if (u.attachment) void attachmentsApi.remove(u.attachment.id).catch(() => undefined);
      }
    },
    [],
  );

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    // Empty: fall back to the natural one-row height (a wrapping placeholder must not grow it).
    if (!text) {
      el.style.height = '';
      return;
    }
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  const patchUpload = (key: string, patch: Partial<PendingUpload>) => {
    setUploads((list) => list.map((u) => (u.key === key ? { ...u, ...patch } : u)));
  };

  const addFiles = (files: File[]) => {
    setNotice(null);
    const room = MAX_FILES - uploadsRef.current.length;
    if (room <= 0) {
      setNotice(t('composer.maxFiles', { max: MAX_FILES }));
      return;
    }
    if (files.length > room) setNotice(t('composer.partial', { count: room, max: MAX_FILES }));
    for (const file of files.slice(0, room)) {
      if (file.size === 0) {
        setNotice(t('composer.emptyFile', { name: file.name }));
        continue;
      }
      // 0.5.5: large files go through the resumable upload (up to 5 GB).
      const limit = Math.max(config.maxUploadBytes, MAX_LARGE_UPLOAD_BYTES);
      if (file.size > limit) {
        setNotice(t('composer.tooLarge', { name: file.name, size: formatBytes(file.size), limit: formatBytes(limit) }));
        continue;
      }
      const key = `u${++uploadKey}`;
      const previewUrl = isPreviewableImage(file.type) ? URL.createObjectURL(file) : undefined;
      const handle = uploadAttachment(
        file,
        (progress) => patchUpload(key, { progress, retryAt: undefined }),
        (waitingMs) => patchUpload(key, { retryAt: Date.now() + waitingMs }),
      );
      setUploads((list) => [...list, { key, file, progress: 0, status: 'uploading', previewUrl, handle }]);
      handle.promise.then(
        (attachment) => patchUpload(key, { status: 'done', progress: 1, attachment, handle: undefined }),
        (error: unknown) => {
          if (isApiError(error) && error.code === 'ABORTED') return;
          patchUpload(key, {
            status: 'error',
            handle: undefined,
            error: isApiError(error) && error.code === 'PAYLOAD_TOO_LARGE' ? t('composer.tooLargeServer') : friendlyError(error, t('composer.uploadFailed')),
          });
        },
      );
    }
  };

  const removeUpload = (key: string) => {
    const upload = uploadsRef.current.find((u) => u.key === key);
    if (!upload) return;
    upload.handle?.abort();
    if (upload.previewUrl) URL.revokeObjectURL(upload.previewUrl);
    if (upload.attachment) void attachmentsApi.remove(upload.attachment.id).catch(() => undefined);
    setUploads((list) => list.filter((u) => u.key !== key));
  };

  const trimmed = text.trim();
  const uploading = uploads.some((u) => u.status === 'uploading');
  const ready = uploads.filter((u) => u.status === 'done' && u.attachment);
  const tooLong = trimmed.length > config.maxMessageLength;
  const canSend = !uploading && !tooLong && (trimmed.length > 0 || ready.length > 0);

  const send = () => {
    if (!user || !canSend) return;
    const attachments = ready.flatMap((u) => (u.attachment ? [u.attachment] : []));
    const command = ttsAllowed ? parseTtsCommand(trimmed) : { text: trimmed, tts: false };
    if (!command.text && attachments.length === 0) return;
    for (const u of uploads) if (u.previewUrl) URL.revokeObjectURL(u.previewUrl);
    setUploads((list) => list.filter((u) => u.status === 'error'));
    uploadsRef.current = uploadsRef.current.filter((u) => u.status === 'error');
    setText('');
    setNotice(null);
    setMention(null);
    typing.stop();
    void sendMessage(channel.id, user, command.text, attachments, undefined, replyTo, { tts: ttsAllowed && (ttsSend || command.tts) });
    if (replyTo) setReplyTo(channel.id, null);
    textareaRef.current?.focus();
  };

  // Replying: focus the box so the user can type right away.
  useEffect(() => {
    if (replyTo) textareaRef.current?.focus();
  }, [replyTo]);

  const candidates = mention && channel.type !== 'DM' ? mentionCandidates(Object.values(allUsers), mention.query) : [];

  const updateMention = (value: string, caret: number) => {
    const found = mentionQueryAt(value, caret);
    setMention(found ? { ...found, index: 0 } : null);
  };

  const insertMention = (picked: PublicUser) => {
    if (!mention) return;
    const el = textareaRef.current;
    const caret = el?.selectionStart ?? text.length;
    const insert = `@${picked.username} `;
    const next = text.slice(0, mention.start) + insert + text.slice(caret);
    setText(next);
    setMention(null);
    const pos = mention.start + insert.length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  };

  /** Emoji goes where the caret is (replacing a selection), not always at the end. */
  const insertEmoji = (emoji: string) => {
    const el = textareaRef.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const next = insertAtCaret(text, start, end, emoji);
    setText(next.value);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(next.caret, next.caret);
    });
  };

  /** A GIF is sent right away as its own message (text being typed stays in the box). */
  const sendGif = (gif: GifResult) => {
    if (!user) return;
    setPicker(null);
    void sendMessage(channel.id, user, '', [], gif, replyTo);
    if (replyTo) setReplyTo(channel.id, null);
    textareaRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && candidates.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        setMention({ ...mention, index: (mention.index + delta + candidates.length) % candidates.length });
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const picked = candidates[mention.index];
        if (picked) insertMention(picked);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setMention(null);
        return;
      }
    }
    if (e.key === 'Escape' && replyTo) {
      e.preventDefault();
      e.stopPropagation();
      setReplyTo(channel.id, null);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files];
    if (files.length > 0) {
      e.preventDefault();
      addFiles(files);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = [...e.dataTransfer.files];
    if (files.length > 0) addFiles(files);
  };

  const remaining = config.maxMessageLength - trimmed.length;

  return (
    <div
      className={`composer${dragging ? ' is-dragging' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      {dragging && (
        <div className="composer-drop" aria-hidden="true">
          <Paperclip size={16} />
          {t('composer.dropHere')}
        </div>
      )}
      {uploads.length > 0 && (
        <ul className="upload-list" aria-label={t('composer.attachments')}>
          {uploads.map((u) => (
            <li key={u.key} className={`upload-item is-${u.status}`}>
              {u.previewUrl ? (
                <img className="upload-thumb" src={u.previewUrl} alt="" />
              ) : (
                <span className="upload-thumb is-file">
                  <FileText size={22} aria-hidden="true" />
                </span>
              )}
              <span className="upload-name" title={u.file.name}>
                {u.file.name}
              </span>
              <span className="upload-meta">
                {u.status === 'uploading' && (u.retryAt ? t('composer.reconnecting') : `${Math.round(u.progress * 100)}%${u.file.size > 50 * 1024 * 1024 ? ` · ${formatBytes(u.file.size * u.progress)} / ${formatBytes(u.file.size)}` : ''}`)}
                {u.status === 'done' && formatBytes(u.file.size)}
                {u.status === 'error' && <span className="upload-error">{u.error}</span>}
              </span>
              {u.status === 'uploading' && (
                <span className="upload-progress" aria-hidden="true">
                  <span style={{ width: `${Math.round(u.progress * 100)}%` }} />
                </span>
              )}
              <button type="button" className="upload-remove" aria-label={t('composer.removeFile', { name: u.file.name })} onClick={() => removeUpload(u.key)}>
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {notice && (
        <p className="composer-notice" role="alert">
          {notice}
        </p>
      )}
      {replyTo && (
        <div className="reply-bar">
          <CornerUpLeft size={14} aria-hidden="true" />
          <span className="reply-bar-text">
            {t('chat.reply.replyingTo')} <strong>{replyAuthor?.displayName ?? replyTo.author.displayName}</strong>
          </span>
          <span className="reply-bar-preview">{replyTo.content.slice(0, 120) || (replyTo.attachments.length > 0 ? t('chat.reply.attachment') : '')}</span>
          <button type="button" className="icon-btn" aria-label={t('chat.reply.cancel')} title={t('chat.reply.cancel')} onClick={() => setReplyTo(channel.id, null)}>
            <X size={14} />
          </button>
        </div>
      )}
      {candidates.length > 0 && mention && (
        <ul className="mention-list" role="listbox" aria-label={t('chat.mentions.title')}>
          <li className="mention-list-title">{t('chat.mentions.title')}</li>
          {candidates.map((u, i) => (
            <li key={u.id}>
              <button
                type="button"
                role="option"
                aria-selected={i === mention.index}
                className={`mention-option${i === mention.index ? ' is-active' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertMention(u);
                }}
              >
                <Avatar userId={u.id} name={u.displayName} avatarAttachmentId={u.avatarAttachmentId} size={22} />
                <span className="mention-option-name">
                  <StyledName userId={u.id} name={u.displayName} fallback={u} />
                </span>
                <span className="mention-option-user">@{u.username}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {picker === 'emoji' && <EmojiPicker customMode="message" onPick={insertEmoji} onClose={closePicker} />}
      {picker === 'gif' && <GifPicker onPick={sendGif} onClose={closePicker} />}
      <div className="composer-row">
        <VoiceMessageRecorder key={channel.id} channelId={channel.id} disabled={!user} />
        <button type="button" className="icon-btn composer-attach" aria-label={t('composer.attach')} title={t('composer.attach')} onClick={() => fileRef.current?.click()}>
          <Plus size={19} />
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            addFiles([...(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
        <textarea
          ref={textareaRef}
          className="composer-input"
          spellCheck={true}
          value={text}
          rows={1}
          placeholder={t(channel.type === 'VOICE' ? 'composer.placeholderVoice' : channel.type === 'DM' ? 'composer.placeholderDm' : 'composer.placeholder', { channel: channel.name })}
          aria-label={t(channel.type === 'VOICE' ? 'composer.placeholderVoice' : channel.type === 'DM' ? 'composer.placeholderDm' : 'composer.placeholder', { channel: channel.name })}
          onChange={(e) => {
            setText(e.target.value);
            updateMention(e.target.value, e.target.selectionStart);
            if (e.target.value.trim()) typing.ping();
            else typing.stop();
          }}
          onClick={(e) => updateMention(e.currentTarget.value, e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={typing.stop}
          enterKeyHint="send"
        />
        {remaining < 200 && (
          <span className={`composer-count${remaining < 0 ? ' is-over' : ''}`} aria-live="polite">
            {remaining}
          </span>
        )}
        {ttsAllowed && (
          <button
            type="button"
            className={`icon-btn composer-tts${ttsSend ? ' is-active' : ''}`}
            aria-label={t('tts.toggle')}
            aria-pressed={ttsSend}
            title={t(ttsSend ? 'tts.toggleOn' : 'tts.toggleOff')}
            onClick={() => useSettingsStore.getState().update({ ttsSend: !ttsSend })}
          >
            <Volume2 size={18} />
          </button>
        )}
        <button
          type="button"
          className={`icon-btn composer-gif${picker === 'gif' ? ' is-active' : ''}`}
          aria-label={t('gif.open')}
          title={t('gif.open')}
          aria-expanded={picker === 'gif'}
          onClick={() => setPicker((p) => (p === 'gif' ? null : 'gif'))}
        >
          <span className="composer-gif-label">GIF</span>
        </button>
        <button
          type="button"
          className={`icon-btn composer-emoji${picker === 'emoji' ? ' is-active' : ''}`}
          aria-label={t('emoji.open')}
          title={t('emoji.open')}
          aria-expanded={picker === 'emoji'}
          onClick={() => setPicker((p) => (p === 'emoji' ? null : 'emoji'))}
        >
          <Smile size={19} />
        </button>
        <button type="button" className="icon-btn composer-send" aria-label={t('composer.send')} title={t('composer.send')} disabled={!canSend || !user} onClick={send}>
          <SendHorizontal size={19} />
        </button>
      </div>
    </div>
  );
}
