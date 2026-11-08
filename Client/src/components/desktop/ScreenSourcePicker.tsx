import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppWindow, Monitor, RefreshCw, Settings2 } from 'lucide-react';
import { Modal } from '../Modal';
import { Toggle } from '../settings/Toggle';
import { desktop } from '../../desktop/bridge';
import type { CaptureSource } from '../../desktop/contract';
import { STREAM_BITRATE_PRESETS, STREAM_FRAME_RATES, STREAM_RESOLUTIONS, estimatedUploadMbps, streamBitrateMbps, type StreamBitrateMode, type StreamFrameRate, type StreamResolution } from '../../desktop/contract';
import { useDesktopStore } from '../../desktop/desktopStore';
import { changeDesktopShare, startDesktopShare } from '../../desktop/screenCapture';
import { useVoiceStore } from '../../voice/voiceStore';
import { useUiStore } from '../../stores/uiStore';

const REFRESH_MS = 5000;

/**
 * Chromium copies every frame of a captured screen to the CPU and limits that work to half a core,
 * so a 4K screen tops out around 30-40 FPS (measured). Window capture is not affected.
 */
function isLargeScreen(): boolean {
  if (typeof window === 'undefined') return false;
  const ratio = window.devicePixelRatio || 1;
  return window.screen.width * ratio * window.screen.height * ratio > 2560 * 1440;
}

/** Desktop "Share screen" dialog: pick a display or a window, optionally with system audio. Also "Change stream". */
export function ScreenSourcePicker() {
  const { t } = useTranslation();
  const close = useCallback(() => useUiStore.getState().setSourcePicker(false), []);
  const openSettings = useUiStore((s) => s.openSettings);
  const streaming = useDesktopStore((s) => s.settings.streaming);
  const update = useDesktopStore((s) => s.update);
  const [sources, setSources] = useState<CaptureSource[] | null>(null);
  const [failed, setFailed] = useState(false);
  const changing = useUiStore((s) => s.sourcePickerMode === 'change');
  const shareConfig = useVoiceStore((s) => s.shareConfig);
  // 0.4.1 "Stream <game>": the game's window is preselected (nothing starts until "Share").
  const preselect = useUiStore((s) => s.sourcePickerPreselect);
  const [tab, setTab] = useState<'screen' | 'window'>(() => (preselect?.startsWith('window:') || (changing && shareConfig?.sourceKind === 'window') ? 'window' : 'screen'));
  // Changing a running stream starts from what is live now.
  const [selected, setSelected] = useState<string | null>(() => preselect ?? (changing ? (shareConfig?.sourceId ?? null) : null));
  const [starting, setStarting] = useState(false);

  const load = useCallback(() => {
    if (!desktop) return;
    desktop.capture.getSources().then(
      (list) => {
        setSources(list);
        setFailed(false);
      },
      () => setFailed(true),
    );
  }, []);

  // Thumbnails refresh while the dialog is open; the timer stops when it closes.
  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const screens = sources?.filter((s) => s.kind === 'screen') ?? [];
  const windows = sources?.filter((s) => s.kind === 'window') ?? [];
  const visible = tab === 'screen' ? screens : windows;
  const selectedSource = sources?.find((s) => s.id === selected) ?? null;

  const share = async () => {
    if (!selectedSource) return;
    setStarting(true);
    const ok = changing ? await changeDesktopShare(selectedSource.id, streaming.systemAudio) : await startDesktopShare(selectedSource.id, streaming.systemAudio);
    setStarting(false);
    if (ok) close();
    else load();
  };

  const label = (s: CaptureSource) => (s.kind === 'screen' ? t('desktop.picker.screen', { n: screens.indexOf(s) + 1 }) : s.name);
  const quality = `${streaming.resolution} · ${t('desktop.streaming.fpsValue', { fps: streaming.frameRate })} · ${
    streaming.bitrateMode === 'auto'
      ? t('desktop.streaming.bitrateAutoShort', { mbps: streamBitrateMbps(streaming) })
      : t('desktop.streaming.mbps', { value: streamBitrateMbps(streaming) })
  }`;

  return (
    <Modal
      title={changing ? t('desktop.picker.changeTitle') : t('desktop.picker.title')}
      onClose={close}
      size="lg"
      className="source-picker"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={close}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn btn-primary" disabled={!selectedSource || starting} onClick={() => void share()}>
            {starting ? t('desktop.picker.starting') : changing ? t('desktop.picker.apply') : t('desktop.picker.share')}
          </button>
        </>
      }
    >
      <div className="picker-toolbar">
        <div className="segmented" role="tablist" aria-label={t('desktop.picker.title')}>
          <button type="button" role="tab" aria-selected={tab === 'screen'} className={tab === 'screen' ? 'is-active' : ''} onClick={() => setTab('screen')}>
            <Monitor size={15} aria-hidden="true" />
            {t('desktop.picker.screens')}
          </button>
          <button type="button" role="tab" aria-selected={tab === 'window'} className={tab === 'window' ? 'is-active' : ''} onClick={() => setTab('window')}>
            <AppWindow size={15} aria-hidden="true" />
            {t('desktop.picker.windows')}
          </button>
        </div>
        <button type="button" className="icon-btn" aria-label={t('desktop.picker.refresh')} title={t('desktop.picker.refresh')} onClick={load}>
          <RefreshCw size={16} />
        </button>
      </div>

      {sources === null && !failed && (
        <div className="picker-state" role="status">
          <span className="spinner" aria-hidden="true" />
          {t('desktop.picker.loading')}
        </div>
      )}
      {failed && <p className="alert alert-error">{t('desktop.picker.failed')}</p>}
      {sources !== null && visible.length === 0 && (
        <p className="picker-state">{tab === 'screen' ? t('desktop.picker.noScreens') : t('desktop.picker.noWindows')}</p>
      )}
      {visible.length > 0 && (
        <ul className="source-grid" role="listbox" aria-label={tab === 'screen' ? t('desktop.picker.screens') : t('desktop.picker.windows')}>
          {visible.map((s) => (
            <li key={s.id} role="option" aria-selected={selected === s.id}>
              <button
                type="button"
                className={`source-card${selected === s.id ? ' is-selected' : ''}`}
                onClick={() => setSelected(s.id)}
                onDoubleClick={() => {
                  setSelected(s.id);
                  void startDesktopShare(s.id, streaming.systemAudio).then((ok) => ok && close());
                }}
              >
                <span className="source-thumb">
                  {s.thumbnail ? <img src={s.thumbnail} alt="" draggable={false} /> : <Monitor size={28} aria-hidden="true" />}
                </span>
                <span className="source-name">
                  {s.appIcon && <img src={s.appIcon} alt="" className="source-icon" />}
                  <span className="source-name-text" title={label(s)}>
                    {label(s)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {tab === 'screen' && streaming.frameRate >= 60 && isLargeScreen() && <p className="picker-fps-hint">{t('desktop.picker.screenFpsHint')}</p>}

      <div className="picker-options">
        <div className="picker-mode">
          <span className="setting-row-title">{t('desktop.streaming.contentMode')}</span>
          <div className="segmented" role="radiogroup" aria-label={t('desktop.streaming.contentMode')}>
            {(['game', 'text'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={streaming.contentMode === mode}
                className={streaming.contentMode === mode ? 'is-active' : ''}
                onClick={() => void update({ streaming: { contentMode: mode } })}
              >
                {t(`desktop.streaming.mode.${mode}`)}
              </button>
            ))}
          </div>
        </div>
        <Toggle
          label={t('desktop.streaming.systemAudio')}
          hint={tab === 'window' ? t('desktop.picker.audioWindowHint') : t('desktop.streaming.systemAudioHint')}
          checked={streaming.systemAudio}
          onChange={(v) => void update({ streaming: { systemAudio: v } })}
        />
        {/* 0.4.5: a window can send only its own application's audio (default) or the whole system mix. */}
        {tab === 'window' && streaming.systemAudio && (
          <div className="picker-mode">
            <span className="setting-row-title">{t('desktop.streaming.audioSource')}</span>
            <div className="segmented" role="radiogroup" aria-label={t('desktop.streaming.audioSource')}>
              {([true, false] as const).map((app) => (
                <button
                  key={String(app)}
                  type="button"
                  role="radio"
                  aria-checked={streaming.appAudio === app}
                  className={streaming.appAudio === app ? 'is-active' : ''}
                  onClick={() => void update({ streaming: { appAudio: app } })}
                >
                  {app ? t('desktop.streaming.audioApp') : t('desktop.streaming.audioSystem')}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="picker-quick field-grid">
          <div className="field">
            <label className="field-label" htmlFor="picker-resolution">
              {t('desktop.streaming.resolution')}
            </label>
            <select id="picker-resolution" className="select" value={streaming.resolution} onChange={(e) => void update({ streaming: { resolution: e.target.value as StreamResolution } })}>
              {(Object.keys(STREAM_RESOLUTIONS) as StreamResolution[]).map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="picker-fps">
              {t('desktop.streaming.frameRate')}
            </label>
            <select id="picker-fps" className="select" value={streaming.frameRate} onChange={(e) => void update({ streaming: { frameRate: Number(e.target.value) as StreamFrameRate } })}>
              {STREAM_FRAME_RATES.map((f) => (
                <option key={f} value={f}>
                  {t('desktop.streaming.fpsValue', { fps: f })}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="picker-bitrate">
              {t('desktop.streaming.bitrate')}
            </label>
            <select
              id="picker-bitrate"
              className="select"
              value={streaming.bitrateMode === 'custom' ? 'custom' : streaming.bitrateMode}
              onChange={(e) => void update({ streaming: { bitrateMode: e.target.value as StreamBitrateMode } })}
            >
              <option value="auto">{t('desktop.streaming.bitrateAuto')}</option>
              {STREAM_BITRATE_PRESETS.map((m) => (
                <option key={m} value={String(m)}>
                  {t('desktop.streaming.mbps', { value: m })}
                </option>
              ))}
              {streaming.bitrateMode === 'custom' && <option value="custom">{t('desktop.streaming.bitrateCustom')}</option>}
            </select>
          </div>
        </div>
        {changing && shareConfig && (
          <p className="picker-live" role="status">
            {t('desktop.picker.liveNow', {
              size: shareConfig.width && shareConfig.height ? `${shareConfig.width}×${shareConfig.height}` : '—',
              fps: shareConfig.maxFramerate ?? '—',
              mbps: shareConfig.maxBitrate ? Math.round(shareConfig.maxBitrate / 100_000) / 10 : '—',
              mode: t(`desktop.streaming.mode.${shareConfig.contentMode}`),
              audio: shareConfig.systemAudio ? t('desktop.picker.audioOn') : t('desktop.picker.audioOff'),
            })}
          </p>
        )}
        <div className="picker-quality">
          <span>
            {quality} · {t('desktop.streaming.uploadShort', { mbps: estimatedUploadMbps(streaming) })}
          </span>
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              close();
              openSettings('streaming');
            }}
          >
            <Settings2 size={13} aria-hidden="true" />
            {t('desktop.picker.qualitySettings')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
