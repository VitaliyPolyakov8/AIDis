import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, RefreshCw } from 'lucide-react';
import { LogoMark } from '../Logo';
import { isDesktop } from '../../desktop/bridge';
import { useDesktopStore } from '../../desktop/desktopStore';
import { checkForUpdates, downloadUpdate, restartAndUpdate } from '../../desktop/updates';

/**
 * 0.7.0: the server refused this app version (CLIENT_OUTDATED). Nothing else works until the update,
 * so this screen replaces the app and cannot be closed. Desktop: download and install at once.
 * Browser: the new web client is already on the server, a reload is enough.
 */
export function UpdateRequired() {
  const { t } = useTranslation();
  const state = useDesktopStore((s) => s.updateState);

  // Desktop: look for the update and download it without waiting for the user.
  useEffect(() => {
    if (!isDesktop) return;
    if (state.status === 'idle' || state.status === 'not-available' || state.status === 'error') checkForUpdates();
    if (state.status === 'available') downloadUpdate();
  }, [state.status]);

  let line = t('updateRequired.web');
  if (isDesktop) {
    if (state.status === 'downloading') line = t('updateRequired.downloading', { percent: Math.round(state.percent) });
    else if (state.status === 'downloaded') line = t('updateRequired.ready');
    else if (state.status === 'error') line = t('updateRequired.error');
    else if (state.status === 'unsupported') line = t('updateRequired.manual');
    else line = t('updateRequired.checking');
  }

  return (
    <div className="splash update-required" role="alertdialog" aria-labelledby="update-required-title" aria-describedby="update-required-text">
      <LogoMark size={56} />
      <h1 id="update-required-title" className="splash-title">
        {t('updateRequired.title')}
      </h1>
      <p id="update-required-text" className="splash-text">
        {t('updateRequired.why')} {line}
      </p>
      <div className="splash-actions">
        {!isDesktop && (
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
            <RefreshCw size={16} aria-hidden="true" /> {t('updateRequired.reload')}
          </button>
        )}
        {isDesktop && state.status === 'downloaded' && (
          <button type="button" className="btn btn-primary" onClick={() => void restartAndUpdate()}>
            <Download size={16} aria-hidden="true" /> {t('updateRequired.install')}
          </button>
        )}
        {isDesktop && state.status === 'error' && (
          <button type="button" className="btn btn-secondary" onClick={checkForUpdates}>
            <RefreshCw size={16} aria-hidden="true" /> {t('updateRequired.retry')}
          </button>
        )}
      </div>
    </div>
  );
}
