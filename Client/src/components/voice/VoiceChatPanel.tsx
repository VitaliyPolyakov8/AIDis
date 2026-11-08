import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import type { Channel } from '../../api/types';
import { MessageList } from '../chat/MessageList';
import { Composer } from '../chat/Composer';
import { TypingIndicator } from '../chat/TypingIndicator';
import { ChannelGalleryButton } from '../chat/ChannelGallery';
import { useChatStore } from '../../stores/chatStore';
import { useUiStore } from '../../stores/uiStore';
import { useSettingsStore } from '../../stores/settingsStore';

/** 0.4.2 resize limits: never narrower than this, never more than this share of the content. */
export const VOICE_CHAT_MIN = 300;
export const VOICE_CHAT_MAX_SHARE = 0.6;

/** Clamps a chat width to the limits for a content area `available` px wide. Pure (unit-tested). */
export function clampVoiceChatWidth(width: number, available: number): number {
  const max = Math.max(VOICE_CHAT_MIN, Math.floor(available * VOICE_CHAT_MAX_SHARE));
  return Math.round(Math.min(max, Math.max(VOICE_CHAT_MIN, width)));
}

/**
 * The text chat of a voice channel: the same message list, composer, attachments, edit/delete and
 * typing indicator as a text channel. Messages are stored with the voice channel's id, so anyone can
 * read and write here whether or not they are connected to the call.
 *
 * 0.4.2: the left edge is a resize handle (drag or arrow keys). Only this panel's CSS width
 * changes; the voice / stream view next to it is never re-mounted, so a watched stream keeps
 * playing. The width is remembered per device.
 */
export function VoiceChatPanel({ channel }: { channel: Channel }) {
  const { t } = useTranslation();
  const setActive = useChatStore((s) => s.setActiveChannel);
  const loadLatest = useChatStore((s) => s.loadLatest);
  const saved = useSettingsStore((s) => s.voiceChatWidth);
  const [width, setWidth] = useState(saved);
  const [resizing, setResizing] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const drag = useRef<{ id: number; startX: number; startWidth: number; available: number } | null>(null);

  // Marks this chat as the one being read (unread dots, notifications) while the panel is open.
  useEffect(() => {
    setActive(channel.id);
    void loadLatest(channel.id);
    return () => setActive(null);
  }, [channel.id, setActive, loadLatest]);

  const available = () => ref.current?.parentElement?.clientWidth ?? window.innerWidth;
  const commit = (value: number) => {
    if (value !== useSettingsStore.getState().voiceChatWidth) useSettingsStore.getState().update({ voiceChatWidth: value });
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, startX: e.clientX, startWidth: ref.current?.offsetWidth ?? width, available: available() };
    setResizing(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d?.id !== e.pointerId) return;
    // The handle is on the left edge: moving left makes the chat wider.
    setWidth(clampVoiceChatWidth(d.startWidth + (d.startX - e.clientX), d.available));
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null;
    setResizing(false);
    commit(width);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = clampVoiceChatWidth(width + (e.key === 'ArrowLeft' ? 24 : -24), available());
    setWidth(next);
    commit(next);
  };

  // The 60 % cap also applies through CSS max-width when the window shrinks later.
  const shown = Math.max(VOICE_CHAT_MIN, width);
  const style = { '--voice-chat-width': `${shown}px` } as CSSProperties;
  return (
    <aside ref={ref} className={`voice-chat chat-view is-resizable${resizing ? ' is-resizing' : ''}`} style={style} aria-label={t('voice.chat.label', { channel: channel.name })}>
      <div
        className="voice-chat-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label={t('voice.chat.resize')}
        aria-valuenow={shown}
        aria-valuemin={VOICE_CHAT_MIN}
        tabIndex={0}
        title={t('voice.chat.resize')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
      />
      <div className="voice-chat-header">
        <span className="voice-chat-title">{t('voice.chat.title')}</span>
        <ChannelGalleryButton key={channel.id} channel={channel} />
        <button
          type="button"
          className="icon-btn icon-btn-sm"
          aria-label={t('voice.chat.close')}
          title={t('voice.chat.close')}
          onClick={() => useUiStore.getState().setVoiceChat(false)}
        >
          <X size={15} />
        </button>
      </div>
      <MessageList key={channel.id} channel={channel} />
      <div className="chat-footer">
        <Composer key={channel.id} channel={channel} />
        <TypingIndicator channelId={channel.id} />
      </div>
    </aside>
  );
}
