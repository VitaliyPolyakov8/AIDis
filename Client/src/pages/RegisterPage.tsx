import { useEffect, useState, type SyntheticEvent } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { CircleAlert, MailCheck } from 'lucide-react';
import { friendlyError } from '../api/errors';
import { normalizeInviteInput } from '../api/invites';
import { registrationApi, type RegistrationState } from '../api/registration';
import { config } from '../config';
import { useAuthStore } from '../stores/authStore';
import { AuthCard } from './AuthCard';

const USERNAME = /^[A-Za-z0-9_.-]{2,32}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** 0.7.1 /register[?invite=code]: self-registration (when the superadmin turned it on). */
export function RegisterPage() {
  const { t } = useTranslation();
  const status = useAuthStore((s) => s.status);
  const [params] = useSearchParams();
  const [state, setState] = useState<RegistrationState | null>(null);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [invite, setInvite] = useState(() => params.get('invite') ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  useEffect(() => {
    document.title = `${t('reg.title')} · ${config.appName}`;
  }, [t]);
  useEffect(() => {
    registrationApi.state().then(setState, () => setState({ mode: 'off', mail: false }));
  }, []);

  if (status === 'authenticated') return <Navigate to="/" replace />;

  if (sentTo) {
    return (
      <AuthCard title={t('reg.checkTitle')}>
        <p className="alert alert-info" role="status">
          <MailCheck size={16} aria-hidden="true" />
          {t('reg.checkBody', { email: sentTo })}
        </p>
        <p className="field-hint">{t('reg.checkSpam')}</p>
        <Link className="btn btn-ghost" to="/login">
          {t('reg.toLogin')}
        </Link>
      </AuthCard>
    );
  }

  if (state && state.mode === 'off') {
    return (
      <AuthCard title={t('reg.title')}>
        <p className="alert alert-info" role="status">
          {t('reg.closed')}
        </p>
        <Link className="btn btn-primary" to="/login">
          {t('reg.login')}
        </Link>
      </AuthCard>
    );
  }

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!USERNAME.test(username.trim())) {
      setError(t('reg.badUsername'));
      return;
    }
    if (!EMAIL.test(email.trim())) {
      setError(t('reg.badEmail'));
      return;
    }
    if (password.length < 8) {
      setError(t('reg.tooShort'));
      return;
    }
    if (password !== repeat) {
      setError(t('reg.mismatch'));
      return;
    }
    const inviteCode = invite.trim() ? (normalizeInviteInput(invite) ?? undefined) : undefined;
    setBusy(true);
    setError(null);
    try {
      await registrationApi.register({ username: username.trim(), displayName: displayName.trim() || username.trim(), email: email.trim(), password, inviteCode });
      setSentTo(email.trim());
    } catch (e) {
      setError(friendlyError(e, t('reg.failed')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title={t('reg.title')} subtitle={t('reg.subtitle')}>
      <form className="login-form" onSubmit={(e) => void submit(e)} noValidate>
        {error && (
          <p className="alert alert-error" role="alert">
            <CircleAlert size={16} aria-hidden="true" />
            {error}
          </p>
        )}
        <div className="field">
          <label className="field-label" htmlFor="reg-username">
            {t('reg.username')}
          </label>
          <input
            id="reg-username"
            className="input"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={32}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={busy}
            autoFocus
          />
          <span className="field-hint">{t('reg.usernameHint')}</span>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="reg-display">
            {t('reg.displayName')}
          </label>
          <input id="reg-display" className="input" maxLength={64} value={displayName} onChange={(e) => setDisplayName(e.target.value)} disabled={busy} />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="reg-email">
            {t('reg.email')}
          </label>
          <input id="reg-email" className="input" type="email" autoComplete="email" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="reg-password">
            {t('reg.password')}
          </label>
          <input id="reg-password" className="input" type="password" autoComplete="new-password" maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
          <span className="field-hint">{t('reg.passwordHint')}</span>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="reg-repeat">
            {t('reg.repeat')}
          </label>
          <input id="reg-repeat" className="input" type="password" autoComplete="new-password" maxLength={128} value={repeat} onChange={(e) => setRepeat(e.target.value)} disabled={busy} />
        </div>
        {(state?.mode === 'invite' || invite) && (
          <div className="field">
            <label className="field-label" htmlFor="reg-invite">
              {t('reg.invite')}
            </label>
            <input id="reg-invite" className="input" spellCheck={false} maxLength={200} value={invite} onChange={(e) => setInvite(e.target.value)} disabled={busy} />
            {state?.mode === 'invite' && <span className="field-hint">{t('reg.inviteHint')}</span>}
          </div>
        )}
        <button type="submit" className="btn btn-primary login-submit" disabled={busy}>
          {busy && <span className="spinner spinner-on-accent" aria-hidden="true" />}
          {busy ? t('reg.submitting') : t('reg.submit')}
        </button>
        <p className="login-alt">
          {t('reg.haveAccount')} <Link to="/login">{t('reg.login')}</Link>
        </p>
      </form>
    </AuthCard>
  );
}
