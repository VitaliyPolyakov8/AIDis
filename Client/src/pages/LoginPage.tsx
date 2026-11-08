import { useEffect, useState, type SyntheticEvent } from 'react';
import { Link, Navigate, useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
import { CircleAlert, Eye, EyeOff, Info } from 'lucide-react';
import { friendlyError } from '../api/errors';
import { LogoMark } from '../components/Logo';
import { LanguageSwitch } from '../components/LanguageSwitch';
import { config } from '../config';
import { useAuthStore } from '../stores/authStore';
import { validateLogin, type FieldErrors } from '../utils/validation';
import { takePendingInvite } from '../components/guilds/inviteLinks';
import { invitePath } from '../components/guilds/routes';
import { registrationApi, type RegistrationState } from '../api/registration';

/** Where to go after logging in: the page asked for, else an invite opened before login, else the app. */
function AfterLogin({ from }: { from?: string }) {
  const [target] = useState(() => {
    const pending = takePendingInvite();
    if (from && from !== '/login') return from;
    return pending ? invitePath(pending) : '/';
  });
  return <Navigate to={target} replace />;
}

export function LoginPage() {
  const { t } = useTranslation();
  const status = useAuthStore((s) => s.status);
  const notice = useAuthStore((s) => s.notice);
  const login = useAuthStore((s) => s.login);
  const clearNotice = useAuthStore((s) => s.clearNotice);
  const location = useLocation();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // 0.7.1: sign-up and password reset links appear only when the superadmin turned them on.
  const [registration, setRegistration] = useState<RegistrationState | null>(null);
  useEffect(() => {
    let alive = true;
    registrationApi.state().then(
      (s) => alive && setRegistration(s),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    document.title = `${t('login.pageTitle')} · ${config.appName}`;
  }, [t]);

  if (status === 'authenticated') return <AfterLogin from={(location.state as { from?: string } | null)?.from} />;

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (submitting) return;
    const errors = validateLogin(username, password);
    setFieldErrors(errors);
    if (errors.username || errors.password) return;
    setSubmitting(true);
    setError(null);
    clearNotice();
    try {
      await login(username.trim(), password, remember);
    } catch (e) {
      setError(friendlyError(e, t('login.failed')));
      setPassword('');
      setSubmitting(false);
    }
  };

  return (
    <div className="login-screen">
      <div className="login-lang">
        <LanguageSwitch compact />
      </div>
      <main className="login-card">
        <div className="login-brand">
          <LogoMark size={88} />
          <h1 className="login-title">{config.appName}</h1>
          <p className="login-subtitle">{t('login.subtitle')}</p>
        </div>

        <form className="login-form" onSubmit={(e) => void submit(e)} noValidate>
          {notice && !error && (
            <p className="alert alert-info" role="status">
              <Info size={16} aria-hidden="true" />
              {t(notice)}
            </p>
          )}
          {error && (
            <p className="alert alert-error" role="alert">
              <CircleAlert size={16} aria-hidden="true" />
              {error}
            </p>
          )}

          <div className="field">
            <label className="field-label" htmlFor="login-username">
              {t('login.username')}
            </label>
            <input
              id="login-username"
              className="input"
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
                if (fieldErrors.username) setFieldErrors((f) => ({ ...f, username: undefined }));
              }}
              aria-invalid={fieldErrors.username ? true : undefined}
              aria-describedby={fieldErrors.username ? 'login-username-error' : undefined}
              disabled={submitting}
              autoFocus
            />
            {fieldErrors.username && (
              <span id="login-username-error" className="field-error">
                {fieldErrors.username}
              </span>
            )}
          </div>

          <div className="field">
            <label className="field-label" htmlFor="login-password">
              {t('login.password')}
            </label>
            <div className="password-wrap">
              <input
                id="login-password"
                className="input"
                name="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (fieldErrors.password) setFieldErrors((f) => ({ ...f, password: undefined }));
                }}
                aria-invalid={fieldErrors.password ? true : undefined}
                aria-describedby={fieldErrors.password ? 'login-password-error' : undefined}
                disabled={submitting}
              />
              <button type="button" className="icon-btn password-toggle" aria-label={showPassword ? t('login.hidePassword') : t('login.showPassword')} onClick={() => setShowPassword((v) => !v)}>
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            {fieldErrors.password && (
              <span id="login-password-error" className="field-error">
                {fieldErrors.password}
              </span>
            )}
          </div>

          <label className="checkbox-row">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} disabled={submitting} />
            {t('login.remember')}
          </label>

          <button type="submit" className="btn btn-primary login-submit" disabled={submitting}>
            {submitting && <span className="spinner spinner-on-accent" aria-hidden="true" />}
            {submitting ? t('login.submitting') : t('login.submit')}
          </button>
          {registration?.mail && (
            <p className="login-alt">
              <Link to="/forgot-password">{t('login.forgot')}</Link>
            </p>
          )}
          {registration && registration.mode !== 'off' && (
            <p className="login-alt">
              {t('login.noAccount')} <Link to="/register">{t('login.register')}</Link>
            </p>
          )}
        </form>
      </main>
    </div>
  );
}
