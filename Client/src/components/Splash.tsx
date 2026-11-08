import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { WifiOff } from 'lucide-react';
import { LogoMark } from './Logo';
import { useAuthStore } from '../stores/authStore';

export function SplashScreen({ label }: { label: string }) {
  return (
    <div className="splash" role="status" aria-live="polite">
      <LogoMark size={96} />
      <div className="splash-row">
        <span className="spinner" aria-hidden="true" />
        <span>{label}</span>
      </div>
    </div>
  );
}

/** A saved session exists but the server could not be reached to restore it. */
export function OfflineScreen() {
  const { t } = useTranslation();
  const bootstrap = useAuthStore((s) => s.bootstrap);
  const logout = useAuthStore((s) => s.logout);
  const [busy, setBusy] = useState(false);
  return (
    <div className="splash">
      <WifiOff size={32} className="splash-icon" aria-hidden="true" />
      <h1 className="splash-title">{t('splash.offlineTitle')}</h1>
      <p className="splash-text">{t('splash.offlineText')}</p>
      <div className="splash-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void bootstrap().finally(() => setBusy(false));
          }}
        >
          {busy && <span className="spinner spinner-on-accent" aria-hidden="true" />}
          {t('common.tryAgain')}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => void logout()}>
          {t('common.logOut')}
        </button>
      </div>
    </div>
  );
}
