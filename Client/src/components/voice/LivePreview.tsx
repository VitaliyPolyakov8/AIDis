import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Monitor } from 'lucide-react';
import { requestBlob } from '../../api/client';
import { THUMBNAIL_INTERVAL_MS } from '../../voice/streamThumbnails';

/** Hover this long before the preview opens (passing the mouse over the list must not load images). */
const OPEN_DELAY_MS = 300;

/**
 * 0.5.5: hovering a LIVE badge shows the stream's newest snapshot (refreshed every few seconds
 * while open), so you can see what is going on before joining. The card is portalled to <body>
 * and placed next to the badge, so the sidebar's scroll area never clips it.
 */
export function LivePreview({ streamerId, name, children }: { streamerId: string; name: string; children: ReactNode }) {
  const { t } = useTranslation();
  const anchor = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [image, setImage] = useState<{ url: string; at: number } | null>(null);
  const [missing, setMissing] = useState(false);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    let current: string | null = null;
    const load = async () => {
      try {
        const blob = await requestBlob(`/api/v1/voice/streams/${streamerId}/thumbnail`, { timeoutMs: 8000 });
        if (!alive) return;
        const url = URL.createObjectURL(blob);
        if (current) URL.revokeObjectURL(current);
        current = url;
        setImage({ url, at: Date.now() });
        setMissing(false);
      } catch {
        if (alive) setMissing(true);
      }
    };
    void load();
    const refresh = setInterval(() => void load(), THUMBNAIL_INTERVAL_MS);
    return () => {
      alive = false;
      clearInterval(refresh);
      if (current) URL.revokeObjectURL(current);
      setImage(null);
    };
  }, [open, streamerId]);

  const show = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const width = 260;
      const left = Math.min(window.innerWidth - width - 8, rect.right + 10);
      const top = Math.max(8, Math.min(window.innerHeight - 190, rect.top - 60));
      setPlace({ left, top });
      setOpen(true);
    }, OPEN_DELAY_MS);
  };
  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setOpen(false);
  };
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return (
    <span ref={anchor} className="live-preview-anchor" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      {children}
      {open &&
        place &&
        createPortal(
          <div className="live-preview" role="tooltip" style={{ left: place.left, top: place.top }}>
            <div className="live-preview-frame">
              {image ? (
                <img src={image.url} alt={t('voice.livePreview.alt', { name })} draggable={false} />
              ) : (
                <span className="live-preview-empty">
                  {missing ? <Monitor size={22} aria-hidden="true" /> : <span className="spinner" aria-hidden="true" />}
                  {missing && <span>{t('voice.livePreview.unavailable')}</span>}
                </span>
              )}
              <span className="live-badge live-preview-badge">{t('voice.live')}</span>
            </div>
            <div className="live-preview-caption">{t('voice.livePreview.caption', { name })}</div>
          </div>,
          document.body,
        )}
    </span>
  );
}
