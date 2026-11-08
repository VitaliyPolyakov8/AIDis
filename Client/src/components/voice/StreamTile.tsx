import { useEffect, useState } from 'react';
import { useCallNames } from '../../stores/guildStore';
import { useTranslation } from 'react-i18next';
import { MonitorUp, Video } from 'lucide-react';
import { requestBlob } from '../../api/client';
import { usePresenceStore } from '../../stores/presenceStore';
import { voice } from '../../voice/voiceService';
import { useVoiceStore, type StreamRef } from '../../voice/voiceStore';
import { THUMBNAIL_INTERVAL_MS } from '../../voice/streamThumbnails';
import { Avatar } from '../Avatar';

/**
 * 0.5.8: every live stream (screen or camera) is its own tile in the voice grid, next to the
 * people. Clicking it opens the stream; closing the stream brings the tile back, so a stream can
 * always be reopened (also your own, which had no "watch" button before). Screen tiles show the
 * stream's newest snapshot (the same one as the LIVE hover preview), refreshed every few seconds.
 */
export function StreamTile({ stream }: { stream: StreamRef }) {
  const { t } = useTranslation();
  const user = usePresenceStore((s) => s.users[stream.identity]);
  const title = usePresenceStore((s) => (stream.source === 'screen' ? (s.presence[stream.identity]?.activity?.name ?? null) : null));
  const watching = useVoiceStore((s) => s.watchedShares.includes(stream.key));
  const names = useCallNames();
  const name = names(stream.identity, user?.displayName ?? stream.presenter.name);
  const own = stream.presenter.isLocal;
  const thumbnail = useStreamThumbnail(stream.source === 'screen' ? stream.identity : null);
  const label = stream.source === 'camera' ? (own ? t('camera.yourCamera') : t('voice.streamTile.camera', { name })) : own ? t('voice.streamTile.own') : t('voice.streamTile.screen', { name });
  return (
    <li className={`stream-tile is-${stream.source}${watching ? ' is-watching' : ''}`}>
      <button type="button" className="stream-tile-btn" onClick={() => voice.watchShare(stream.key)} aria-label={`${label}. ${t('voice.streamTile.open')}`}>
        <span className="stream-tile-media">
          {thumbnail ? (
            <img src={thumbnail} alt="" draggable={false} />
          ) : (
            <span className="stream-tile-placeholder">
              <Avatar userId={stream.identity} name={name} avatarAttachmentId={user?.avatarAttachmentId} size={56} frame={false} />
            </span>
          )}
          <span className="stream-tile-cta">
            {stream.source === 'camera' ? <Video size={16} aria-hidden="true" /> : <MonitorUp size={16} aria-hidden="true" />}
            {t('voice.streamTile.open')}
          </span>
        </span>
        <span className="stream-tile-caption">
          <span className="live-badge">
            {stream.source === 'camera' && <Video size={10} aria-hidden="true" />}
            {t('voice.live')}
          </span>
          <span className="stream-tile-label">{label}</span>
          {title && <span className="stream-tile-title">{title}</span>}
        </span>
      </button>
    </li>
  );
}

/** The newest snapshot of someone's screen stream as an object URL (null until there is one). */
function useStreamThumbnail(streamerId: string | null): string | null {
  const [url, setUrl] = useState<{ id: string; url: string } | null>(null);
  useEffect(() => {
    if (!streamerId) return;
    let alive = true;
    let current: string | null = null;
    const load = async () => {
      try {
        const blob = await requestBlob(`/api/v1/voice/streams/${streamerId}/thumbnail`, { timeoutMs: 8000 });
        if (!alive) return;
        const next = URL.createObjectURL(blob);
        if (current) URL.revokeObjectURL(current);
        current = next;
        setUrl({ id: streamerId, url: next });
      } catch {
        // No snapshot yet (the stream just started) or an older server: the avatar stays.
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), THUMBNAIL_INTERVAL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
      if (current) URL.revokeObjectURL(current);
    };
  }, [streamerId]);
  return url && url.id === streamerId ? url.url : null;
}
