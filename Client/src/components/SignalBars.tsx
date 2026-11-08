import { useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useVoiceStore, type ConnectionQualityLevel } from '../voice/voiceStore';
import { describeQuality } from '../voice/connectionStats';
import { getLanguage } from '../i18n';

const BARS: Record<ConnectionQualityLevel, number> = { excellent: 3, good: 2, poor: 1, lost: 0, unknown: 3 };

function StatsContent() {
  const { t } = useTranslation();
  const status = useVoiceStore((s) => s.status);
  const quality = useVoiceStore((s) => s.quality);
  const stats = useVoiceStore((s) => s.stats);

  if (status === 'reconnecting') return <p className="stats-state">{t('voice.stats.reconnecting')}</p>;
  if (status === 'connecting') return <p className="stats-state">{t('voice.stats.connecting')}</p>;

  const label = describeQuality(quality, stats);
  const locale = getLanguage() === 'ru' ? 'ru-RU' : 'en-US';
  const loss =
    stats?.lossPercent == null
      ? null
      : `${new Intl.NumberFormat(locale, { maximumFractionDigits: stats.lossPercent < 10 ? 1 : 0 }).format(stats.lossPercent)}%`;
  const transport =
    stats?.transport === 'TURN' && stats.relayProtocol
      ? t('voice.stats.viaTurn', { protocol: stats.relayProtocol })
      : (stats?.transport ?? null);
  const measuring = t('voice.stats.measuring');

  return (
    <dl className="stats-list">
      <dt>{t('voice.stats.quality')}</dt>
      <dd className={`stats-quality is-${label}`}>{t(`voice.stats.levels.${label}`)}</dd>
      <dt>{t('voice.stats.ping')}</dt>
      <dd>{stats?.rttMs != null ? t('voice.stats.ms', { value: stats.rttMs }) : measuring}</dd>
      <dt>{t('voice.stats.loss')}</dt>
      <dd>{loss ?? (stats ? t('voice.stats.unavailable') : measuring)}</dd>
      {transport && (
        <>
          <dt>{t('voice.stats.transport')}</dt>
          <dd>{transport}</dd>
        </>
      )}
    </dl>
  );
}

/**
 * Three-bar connection indicator (bar level = LiveKit's connection quality). Hovering or focusing
 * it shows real WebRTC statistics collected by the voice service.
 */
export function SignalBars({
  quality,
  status,
  interactive = true,
}: {
  quality: ConnectionQualityLevel;
  status: string;
  interactive?: boolean;
}) {
  const { t } = useTranslation();
  const tooltipId = useId();
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' });
  const lit = status === 'connected' ? BARS[quality] : 0;
  const canShow = interactive && (status === 'connected' || status === 'reconnecting' || status === 'connecting');

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const width = 224;
    const left = Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 8);
    // Prefer above the bars (they live at the bottom of the sidebar); flip below near the top.
    const above = rect.top > 160;
    setStyle(
      above
        ? { left, bottom: window.innerHeight - rect.top + 8, width }
        : { left, top: rect.bottom + 8, width },
    );
  }, [open]);

  const bars = (
    <span className={`signal-bars q-${status === 'connected' ? quality : status}`} aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <span key={i} className={i < lit ? 'is-lit' : ''} style={{ height: 5 + i * 3 }} />
      ))}
    </span>
  );

  if (!canShow) return bars;

  return (
    <span
      ref={triggerRef}
      className="signal-trigger"
      tabIndex={0}
      role="button"
      aria-label={t('voice.stats.label')}
      aria-describedby={open ? tooltipId : undefined}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') setOpen(false);
      }}
      onClick={() => setOpen((v) => !v)}
    >
      {bars}
      {open &&
        createPortal(
          <div id={tooltipId} role="tooltip" className="stats-tooltip" style={style}>
            <StatsContent />
          </div>,
          document.body,
        )}
    </span>
  );
}
