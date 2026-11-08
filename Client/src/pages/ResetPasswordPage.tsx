import { useEffect, useState, type SyntheticEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { CircleAlert, MailCheck } from 'lucide-react';
import { friendlyError } from '../api/errors';
import { registrationApi } from '../api/registration';
import { config } from '../config';
import { AuthCard } from './AuthCard';

function ErrorLine({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p className="alert alert-error" role="alert">
      <CircleAlert size={16} aria-hidden="true" />
      {text}
    </p>
  );
}

/** 0.7.1 /forgot-password: asks for a reset link (the answer never says whether the address exists). */
export function ForgotPasswordPage() {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = `${t('reset.forgotTitle')} · ${config.appName}`;
  }, [t]);

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (busy || !email.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await registrationApi.requestReset(email.trim());
      setSent(true);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title={t('reset.forgotTitle')} subtitle={sent ? undefined : t('reset.forgotBody')}>
      {sent ? (
        <p className="alert alert-info" role="status">
          <MailCheck size={16} aria-hidden="true" />
          {t('reset.sent')}
        </p>
      ) : (
        <form className="login-form" onSubmit={(e) => void submit(e)} noValidate>
          <ErrorLine text={error} />
          <div className="field">
            <label className="field-label" htmlFor="forgot-email">
              {t('reset.email')}
            </label>
            <input id="forgot-email" className="input" type="email" autoComplete="email" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} autoFocus />
          </div>
          <button type="submit" className="btn btn-primary login-submit" disabled={busy || !email.trim()}>
            {busy && <span className="spinner spinner-on-accent" aria-hidden="true" />}
            {t('reset.send')}
          </button>
        </form>
      )}
      <p className="login-alt">
        <Link to="/login">{t('reg.toLogin')}</Link>
      </p>
    </AuthCard>
  );
}

/** 0.7.1 /reset-password?token=…: sets a new password (every session of the account is signed out). */
export function ResetPasswordPage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(token ? null : t('reset.noToken'));

  useEffect(() => {
    document.title = `${t('reset.title')} · ${config.appName}`;
  }, [t]);

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (busy || !token) return;
    if (password.length < 8) {
      setError(t('reg.tooShort'));
      return;
    }
    if (password !== repeat) {
      setError(t('reg.mismatch'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await registrationApi.confirmReset(token, password);
      setDone(true);
    } catch (e) {
      setError(friendlyError(e, t('reset.failed')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title={t('reset.title')}>
      {done ? (
        <>
          <p className="alert alert-info" role="status">
            {t('reset.done')}
          </p>
          <Link className="btn btn-primary" to="/login">
            {t('reg.login')}
          </Link>
        </>
      ) : (
        <form className="login-form" onSubmit={(e) => void submit(e)} noValidate>
          <ErrorLine text={error} />
          <div className="field">
            <label className="field-label" htmlFor="reset-password">
              {t('reset.password')}
            </label>
            <input id="reset-password" className="input" type="password" autoComplete="new-password" maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy || !token} autoFocus />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="reset-repeat">
              {t('reset.repeat')}
            </label>
            <input id="reset-repeat" className="input" type="password" autoComplete="new-password" maxLength={128} value={repeat} onChange={(e) => setRepeat(e.target.value)} disabled={busy || !token} />
          </div>
          <button type="submit" className="btn btn-primary login-submit" disabled={busy || !token}>
            {busy && <span className="spinner spinner-on-accent" aria-hidden="true" />}
            {t('reset.save')}
          </button>
        </form>
      )}
    </AuthCard>
  );
}
