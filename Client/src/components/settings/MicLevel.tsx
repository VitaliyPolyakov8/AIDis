import { useTranslation } from 'react-i18next';
import { dbToMeter, meterToDb, type MicLevel } from '../../voice/micPipeline';

/**
 * Live microphone meter with the voice-activity threshold on it (Discord-style): everything left
 * of the marker is treated as background noise, everything right of it opens the microphone.
 * The marker is draggable in manual mode and follows the automatic threshold otherwise.
 */
export function MicLevelMeter({
  level,
  thresholdDb,
  editable,
  showThreshold,
  onThreshold,
}: {
  level: MicLevel | null;
  thresholdDb: number;
  editable: boolean;
  showThreshold: boolean;
  onThreshold?: (db: number) => void;
}) {
  const { t } = useTranslation();
  const fill = level ? dbToMeter(level.db) : 0;
  const marker = dbToMeter(thresholdDb);
  const open = level?.open ?? false;

  return (
    <div className="mic-meter-wrap">
      <div
        className={`mic-meter${open ? ' is-open' : ''}${showThreshold ? ' has-threshold' : ''}`}
        role="meter"
        aria-label={t('settings.voice.inputLevelLabel')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(fill * 100)}
      >
        {showThreshold && <span className="mic-meter-noise" style={{ width: `${marker * 100}%` }} aria-hidden="true" />}
        <span className="mic-meter-fill" style={{ width: `${fill * 100}%` }} aria-hidden="true" />
        {showThreshold && <span className="mic-meter-marker" style={{ left: `${marker * 100}%` }} aria-hidden="true" />}
        {showThreshold && editable && (
          <input
            className="mic-meter-range"
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(marker * 100)}
            aria-label={t('settings.voice.sensitivity')}
            aria-valuetext={t('settings.voice.thresholdValue', { db: Math.round(thresholdDb) })}
            onChange={(e) => onThreshold?.(Math.round(meterToDb(Number(e.target.value) / 100)))}
          />
        )}
      </div>
      {showThreshold && (
        <div className="mic-meter-scale" aria-hidden="true">
          <span>{t('settings.voice.moreSensitive')}</span>
          <span>{t('settings.voice.lessSensitive')}</span>
        </div>
      )}
    </div>
  );
}

/** "Transmitting" / "Silent" dot under the meter. */
export function GateIndicator({ level }: { level: MicLevel | null }) {
  const { t } = useTranslation();
  const open = level?.open ?? false;
  return (
    <span className={`gate-indicator${open ? ' is-open' : ''}`} role="status">
      <span className="gate-dot" aria-hidden="true" />
      {open ? t('settings.voice.wouldTransmit') : t('settings.voice.wouldNotTransmit')}
    </span>
  );
}
