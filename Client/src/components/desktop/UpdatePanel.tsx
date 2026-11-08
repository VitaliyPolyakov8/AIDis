import { useTranslation } from 'react-i18next';
import { Download, RefreshCw, RotateCw, X } from 'lucide-react';
import type { UpdateState } from '../../desktop/contract';
import { useDesktopStore } from '../../desktop/desktopStore';
import { checkForUpdates, downloadUpdate, restartAndUpdate } from '../../desktop/updates';
import { getLanguage } from '../../i18n';
import { useVoiceStore } from '../../voice/voiceStore';

function megabytes(bytes: number): string {
  return new Intl.NumberFormat(getLanguage() === 'ru' ? 'ru-RU' : 'en-US', { maximumFractionDigits: 1 }).format(bytes / 1_048_576);
}

function useStatusText(state: UpdateState): string {
  const { t } = useTranslation();
  switch (state.status) {
    case 'unsupported':
      return t('updates.unsupported');
    case 'idle':
      return t('updates.idle');
    case 'checking':
      return t('updates.checking');
    case 'available':
      return t('updates.available', { version: state.version });
    case 'downloading':
      return t('updates.downloading', { version: state.version, percent: state.percent });
    case 'downloaded':
      return t('updates.ready', { version: state.version });
    case 'not-available':
      return t('updates.upToDate');
    case 'error':
      return state.message === 'network' || state.message === 'not-published' || state.message === 'integrity'
        ? t(`updates.errors.${state.message}`)
        : t('updates.errors.generic');
  }
}

/** Settings -> About: real updater state, progress, manual check and "Restart and update". */
export function UpdatePanel() {
  const { t } = useTranslation();
  const state = useDesktopStore((s) => s.updateState);
  const inVoice = useVoiceStore((s) => s.status !== 'idle' && s.status !== 'error');
  const text = useStatusText(state);
  const busy = state.status === 'checking' || state.status === 'available' || state.status === 'downloading';

  return (
    <div className="update-panel">
      <p className={`update-status${state.status === 'error' ? ' is-error' : ''}`} role="status">
        {text}
      </p>
      {state.status === 'downloading' && (
        <div className="update-progress">
          <div className="update-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={state.percent}>
            <span style={{ width: `${state.percent}%` }} />
          </div>
          <span className="field-hint">
            {t('updates.progress', {
              done: megabytes(state.transferred),
              total: megabytes(state.total),
              speed: megabytes(state.bytesPerSecond),
            })}
          </span>
        </div>
      )}
      <div className="settings-actions">
        {state.status === 'available' ? (
          <button type="button" className="btn btn-primary btn-sm" onClick={downloadUpdate}>
            <Download size={14} aria-hidden="true" />
            {t('updates.download')}
          </button>
        ) : state.status === 'downloaded' ? (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void restartAndUpdate()}>
            <RotateCw size={14} aria-hidden="true" />
            {t('updates.restart')}
          </button>
        ) : (
          <button type="button" className="btn btn-secondary btn-sm" disabled={state.status === 'unsupported' || busy} onClick={checkForUpdates}>
            <RefreshCw size={14} aria-hidden="true" />
            {t('updates.check')}
          </button>
        )}
      </div>
      {state.status === 'downloaded' && inVoice && <p className="field-hint">{t('updates.voiceNote')}</p>}
    </div>
  );
}

/** Thin bar at the top of the app once an update is downloaded. Never restarts by itself. */
export function UpdateBanner() {
  const { t } = useTranslation();
  const state = useDesktopStore((s) => s.updateState);
  const dismissed = useDesktopStore((s) => s.updateBannerDismissed);
  if (state.status !== 'downloaded' || dismissed === state.version) return null;
  return (
    <div className="update-banner" role="status">
      <Download size={15} aria-hidden="true" />
      <span className="update-banner-text">{t('updates.ready', { version: state.version })}</span>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => void restartAndUpdate()}>
        {t('updates.restart')}
      </button>
      <button
        type="button"
        className="icon-btn icon-btn-sm"
        aria-label={t('updates.later')}
        title={t('updates.later')}
        onClick={() => useDesktopStore.setState({ updateBannerDismissed: state.version })}
      >
        <X size={14} />
      </button>
    </div>
  );
}
