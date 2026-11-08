import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AudioLines } from 'lucide-react';
import { useChatStore } from '../stores/chatStore';
import { useGuildPerm } from '../stores/guildStore';
import { useVoiceStore } from '../voice/voiceStore';
import { SoundboardPanel } from './SoundboardPanel';
import { useSoundboardStore } from './store';

/**
 * 0.7.1 "Sounds" next to the mic / screen buttons: only in a server voice channel where I have
 * USE_SOUNDBOARD. `variant` picks the call-screen control or the compact dock action.
 */
export function SoundboardButton({ variant }: { variant: 'control' | 'dock' }) {
  const { t } = useTranslation();
  const channelId = useVoiceStore((s) => s.channelId);
  const status = useVoiceStore((s) => s.status);
  const guildId = useChatStore((s) => s.channels.find((c) => c.id === channelId)?.guildId ?? null);
  const allowed = useGuildPerm('USE_SOUNDBOARD', channelId ?? undefined);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (!channelId || !guildId || !allowed) return null;
  return (
    <div className={`soundboard-anchor is-${variant}`} ref={box}>
      <button
        type="button"
        className={variant === 'control' ? `control-btn control-sounds${open ? ' is-active' : ''}` : `dock-action${open ? ' is-active' : ''}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={status !== 'connected'}
        onClick={() => setOpen((v) => !v)}
      >
        <AudioLines size={variant === 'control' ? 19 : 16} aria-hidden="true" />
        <span className={variant === 'control' ? 'control-label' : undefined}>{t('soundboard.button')}</span>
      </button>
      {open && <SoundboardPanel guildId={guildId} onClose={() => setOpen(false)} />}
    </div>
  );
}

/** 0.7.1: a small note on a participant's tile for 1.5 s after they played a sound. */
export function RecentSoundBadge({ userId }: { userId: string }) {
  const { t } = useTranslation();
  const at = useSoundboardStore((s) => s.lastPlayed[userId] ?? 0);
  // The badge hides itself 1.5 s after the press (state changes only from the timer).
  const [expired, setExpired] = useState(0);
  useEffect(() => {
    if (at === 0) return;
    const timer = window.setTimeout(() => setExpired(at), Math.max(0, 1500 - (Date.now() - at)));
    return () => window.clearTimeout(timer);
  }, [at]);
  const fresh = at !== 0 && expired !== at;
  if (!fresh) return null;
  return (
    <span className="muted-chip sound-chip" title={t('soundboard.played')}>
      <AudioLines size={13} role="img" aria-label={t('soundboard.played')} />
    </span>
  );
}
