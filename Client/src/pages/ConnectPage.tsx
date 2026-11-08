import { useState, type SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { desktop } from '../desktop/bridge';
import type { DesktopAddServerResult } from '../desktop/contract';
import { AuthCard } from './AuthCard';

/**
 * Desktop app: the address of an AIDis server. The main process checks it is an AIDis
 * (GET /api/v1/client/config), remembers it and reloads the window pointed at it.
 */
export function ServerAddressForm({ autoFocus = false, onAdded }: { autoFocus?: boolean; onAdded?: () => void }) {
  const { t } = useTranslation();
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: SyntheticEvent) => {
    e.preventDefault();
    const servers = desktop?.servers;
    if (!servers || busy) return;
    if (!address.trim()) {
      setError(t('connect.errors.INVALID'));
      return;
    }
    setBusy(true);
    setError(null);
    const result: DesktopAddServerResult = await servers.add(address.trim()).catch(() => ({ ok: false, code: 'UNREACHABLE' }) as const);
    setBusy(false);
    if (!result.ok) {
      setError(t(`connect.errors.${result.code}`));
      return;
    }
    onAdded?.();
  };

  return (
    <form className="login-form" onSubmit={(e) => void submit(e)} noValidate>
      {error && (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      )}
      <div className="field">
        <label className="field-label" htmlFor="server-address">
          {t('connect.address')}
        </label>
        <input id="server-address" className="input" value={address} placeholder="chat.example.com" autoComplete="url" spellCheck={false} autoFocus={autoFocus} onChange={(e) => setAddress(e.target.value)} />
        <span className="field-hint">{t('connect.addressHint')}</span>
      </div>
      <button type="submit" className="btn btn-primary login-submit" disabled={busy}>
        {busy && <span className="spinner spinner-on-accent" aria-hidden="true" />}
        {busy ? t('connect.checking') : t('connect.connect')}
      </button>
    </form>
  );
}

/** First start of the desktop app (no server chosen yet). */
export function ConnectPage() {
  const { t } = useTranslation();
  return (
    <AuthCard title={t('connect.title')} subtitle={t('connect.subtitle')}>
      <ServerAddressForm autoFocus />
      <p className="login-alt connect-hint">{t('connect.noServer')}</p>
    </AuthCard>
  );
}
