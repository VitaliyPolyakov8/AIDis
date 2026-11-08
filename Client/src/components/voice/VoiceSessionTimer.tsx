import { useTranslation } from 'react-i18next';
import { Clock } from 'lucide-react';
import { useVoiceStore } from '../../voice/voiceStore';
import { useNow } from '../../hooks/useNow';
import { elapsedSince, formatVoiceElapsed } from '../../utils/duration';

/**
 * 0.4.1 voice session timer: how long the channel has been occupied ("0:42", "12:18", "1:03:42").
 * The start comes from the server (voice.session events); the elapsed time is computed here from
 * the one shared 1-second clock. Hidden while the channel is empty or the server has no session.
 */
export function VoiceSessionTimer({ channelId, chip = false }: { channelId: string; chip?: boolean }) {
  const { t } = useTranslation();
  const startedAt = useVoiceStore((s) => s.voiceSessions[channelId]);
  const occupied = useVoiceStore((s) => (s.occupancy[channelId]?.length ?? 0) > 0 || (s.channelId === channelId && s.status === 'connected' && s.participants.length > 0));
  const active = Boolean(startedAt) && occupied;
  const now = useNow(1000, active);
  const ms = active ? elapsedSince(startedAt, now) : null;
  if (ms === null) return null;
  const text = formatVoiceElapsed(ms);
  return (
    <span className={`voice-timer${chip ? ' is-chip' : ''}`} title={t('voice.sessionTimer', { time: text })} aria-label={t('voice.sessionTimer', { time: text })}>
      {chip && <Clock size={12} aria-hidden="true" />}
      <span className="voice-timer-text">{text}</span>
    </span>
  );
}
