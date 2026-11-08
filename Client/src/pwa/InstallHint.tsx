import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Share, SquarePlus, X } from 'lucide-react';
import { isIosDevice, isStandalone } from './webApp';
import { config } from '../config';

const DISMISSED_KEY = 'aidis.pwa.installHintDismissed';

function dismissedBefore(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * 0.5.9: in Safari on iPhone / iPad (iOS has no install prompt), a one-time hint how to put AIDis
 * on the home screen: full screen, its own icon, and sound in the background during calls.
 */
export function InstallHint() {
  const { t } = useTranslation();
  const [hidden, setHidden] = useState(() => dismissedBefore());
  if (hidden || !isIosDevice || isStandalone() || config.platform !== 'ios') return null;
  const close = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      // storage blocked: hidden for this visit only
    }
    setHidden(true);
  };
  return (
    <div className="install-hint" role="note">
      <img src="/apple-touch-icon.png" alt="" className="install-hint-icon" />
      <div className="install-hint-text">
        <strong>{t('pwa.installTitle')}</strong>
        <span>
          {t('pwa.installStep1')} <Share size={14} aria-label={t('pwa.share')} className="install-hint-glyph" /> {t('pwa.installStep2')} <SquarePlus size={14} aria-hidden="true" className="install-hint-glyph" />{' '}
          <b>{t('pwa.addToHome')}</b>
        </span>
        <span className="field-hint">{t('pwa.installWhy')}</span>
      </div>
      <button type="button" className="icon-btn icon-btn-xs" aria-label={t('common.close')} onClick={close}>
        <X size={14} />
      </button>
    </div>
  );
}
