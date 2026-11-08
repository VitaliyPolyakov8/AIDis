import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { desktop } from '../../desktop/bridge';
import {
  CUSTOM_BITRATE_MAX_MBPS,
  CUSTOM_BITRATE_MIN_MBPS,
  estimatedUploadMbps,
  STREAM_BITRATE_PRESETS,
  STREAM_FRAME_RATES,
  STREAM_RESOLUTIONS,
  streamBitrateMbps,
  type StreamBitrateMode,
  type StreamContentMode,
  type StreamFrameRate,
  type StreamResolution,
} from '../../desktop/contract';
import { useDesktopStore } from '../../desktop/desktopStore';
import { Toggle } from './Toggle';

/** Settings → Streaming (desktop only): capture resolution, frame rate, bitrate ceiling, system audio. */
export function StreamingSettings() {
  const { t } = useTranslation();
  const streaming = useDesktopStore((s) => s.settings.streaming);
  const hardware = useDesktopStore((s) => s.settings.preferences.hardwareAcceleration);
  const hardwareActive = useDesktopStore((s) => s.info?.hardwareAccelerationActive ?? true);
  const update = useDesktopStore((s) => s.update);
  const [customDraft, setCustomDraft] = useState(String(streaming.customBitrateMbps));
  const [customError, setCustomError] = useState(false);

  const commitCustom = (raw: string) => {
    const value = Number(raw);
    const valid = /^\d+$/.test(raw.trim()) && value >= CUSTOM_BITRATE_MIN_MBPS && value <= CUSTOM_BITRATE_MAX_MBPS;
    setCustomError(!valid);
    if (valid) void update({ streaming: { customBitrateMbps: value } });
  };

  const restartPending = hardware !== hardwareActive;

  const modes: StreamContentMode[] = ['game', 'text'];

  return (
    <div className="settings-stack">
      <div className="settings-card">
        <h4 className="settings-card-title">{t('desktop.streaming.contentMode')}</h4>
        <div className="choice-row" role="radiogroup" aria-label={t('desktop.streaming.contentMode')}>
          {modes.map((mode) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={streaming.contentMode === mode}
              className={`choice choice-text${streaming.contentMode === mode ? ' is-active' : ''}`}
              onClick={() => void update({ streaming: { contentMode: mode } })}
            >
              {t(`desktop.streaming.mode.${mode}`)}
              <span className="field-hint">{t(`desktop.streaming.mode.${mode}Hint`)}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="settings-card">
        <h4 className="settings-card-title">{t('desktop.streaming.priority')}</h4>
        <div className="choice-row" role="radiogroup" aria-label={t('desktop.streaming.priority')}>
          {(['resolution', 'auto'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={streaming.qualityPriority === value}
              className={`choice choice-text${streaming.qualityPriority === value ? ' is-active' : ''}`}
              onClick={() => void update({ streaming: { qualityPriority: value } })}
            >
              {t(`desktop.streaming.priorityMode.${value}`)}
              <span className="field-hint">{t(`desktop.streaming.priorityMode.${value}Hint`)}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="settings-card">
        <div className="field-grid">
          <div className="field">
            <label className="field-label" htmlFor="stream-resolution">
              {t('desktop.streaming.resolution')}
            </label>
            <select
              id="stream-resolution"
              className="select"
              value={streaming.resolution}
              onChange={(e) => void update({ streaming: { resolution: e.target.value as StreamResolution } })}
            >
              {(Object.keys(STREAM_RESOLUTIONS) as StreamResolution[]).map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="stream-fps">
              {t('desktop.streaming.frameRate')}
            </label>
            <select
              id="stream-fps"
              className="select"
              value={streaming.frameRate}
              onChange={(e) => void update({ streaming: { frameRate: Number(e.target.value) as StreamFrameRate } })}
            >
              {STREAM_FRAME_RATES.map((fps) => (
                <option key={fps} value={fps}>
                  {t('desktop.streaming.fpsValue', { fps })}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="stream-bitrate">
              {t('desktop.streaming.bitrate')}
            </label>
            <select
              id="stream-bitrate"
              className="select"
              value={streaming.bitrateMode}
              onChange={(e) => void update({ streaming: { bitrateMode: e.target.value as StreamBitrateMode } })}
            >
              <option value="auto">{t('desktop.streaming.bitrateAuto')}</option>
              {STREAM_BITRATE_PRESETS.map((mbps) => (
                <option key={mbps} value={String(mbps)}>
                  {t('desktop.streaming.mbps', { value: mbps })}
                </option>
              ))}
              <option value="custom">{t('desktop.streaming.bitrateCustom')}</option>
            </select>
          </div>
          {streaming.bitrateMode === 'custom' && (
            <div className="field">
              <label className="field-label" htmlFor="stream-custom">
                {t('desktop.streaming.customLabel', { min: CUSTOM_BITRATE_MIN_MBPS, max: CUSTOM_BITRATE_MAX_MBPS })}
              </label>
              <input
                id="stream-custom"
                className="input"
                type="number"
                inputMode="numeric"
                min={CUSTOM_BITRATE_MIN_MBPS}
                max={CUSTOM_BITRATE_MAX_MBPS}
                step={1}
                value={customDraft}
                aria-invalid={customError}
                onChange={(e) => setCustomDraft(e.target.value)}
                onBlur={(e) => commitCustom(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitCustom(e.currentTarget.value);
                }}
              />
              {customError && (
                <span className="field-error" role="alert">
                  {t('desktop.streaming.customInvalid', { min: CUSTOM_BITRATE_MIN_MBPS, max: CUSTOM_BITRATE_MAX_MBPS })}
                </span>
              )}
            </div>
          )}
        </div>
        <p className="field-hint">
          {streaming.bitrateMode === 'auto'
            ? t('desktop.streaming.autoHint', { mbps: streamBitrateMbps(streaming) })
            : t('desktop.streaming.manualHint')}
        </p>
        <p className="upload-estimate">{t('desktop.streaming.upload', { mbps: estimatedUploadMbps(streaming) })}</p>
        {/* 0.5.2: one full-quality layer, so the server sends the whole stream to every viewer. */}
        <p className="field-hint">{t('desktop.streaming.serverLoad', { mbps: streamBitrateMbps(streaming), three: Math.round(streamBitrateMbps(streaming) * 3) })}</p>
        <p className="field-hint">{t('desktop.streaming.sourceLimit')}</p>
      </div>

      <div className="settings-card">
        <Toggle
          label={t('desktop.streaming.systemAudio')}
          hint={t('desktop.streaming.systemAudioHint')}
          checked={streaming.systemAudio}
          onChange={(v) => void update({ streaming: { systemAudio: v } })}
        />
        <Toggle
          label={t('desktop.streaming.hardware')}
          hint={t('desktop.streaming.hardwareHint')}
          checked={hardware}
          onChange={(v) => void update({ preferences: { hardwareAcceleration: v } })}
        />
        {restartPending && (
          <p className="alert alert-info">
            <span className="alert-text">{t('desktop.streaming.restartNeeded')}</span>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => desktop?.app.relaunch()}>
              {t('desktop.restart')}
            </button>
          </p>
        )}
      </div>
    </div>
  );
}
