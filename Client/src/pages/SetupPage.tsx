import { useEffect, useState, type ReactNode, type SyntheticEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { CircleAlert, Copy, PartyPopper } from 'lucide-react';
import { friendlyError } from '../api/errors';
import { setupApi, type RegistrationMode, type SetupResult } from '../api/setup';
import { SplashScreen } from '../components/Splash';
import { config } from '../config';
import { useAuthStore } from '../stores/authStore';
import { toast } from '../stores/uiStore';
import { guildPath } from '../components/guilds/routes';
import { AuthCard } from './AuthCard';

const USERNAME = /^[A-Za-z0-9_.-]{2,32}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MODES: RegistrationMode[] = ['off', 'invite', 'open'];

/**
 * Shows the first-run wizard instead of anything else while the server has no account yet.
 * When the check fails (an older server, no network) the app works as usual.
 */
export function SetupGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [needed, setNeeded] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    setupApi.status().then(
      (s) => alive && setNeeded(s.needed),
      () => alive && setNeeded(false),
    );
    return () => {
      alive = false;
    };
  }, []);
  if (needed === null) return <SplashScreen label={t('splash.restoring')} />;
  if (needed) return <SetupPage onDone={() => setNeeded(false)} />;
  return children;
}

function ErrorLine({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p className="alert alert-error" role="alert">
      <CircleAlert size={16} aria-hidden="true" />
      {text}
    </p>
  );
}

/** The four steps: code from setup.sh -> administrator -> first server -> registration. */
export function SetupPage({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const adoptSession = useAuthStore((s) => s.adoptSession);
  const [step, setStep] = useState(0);
  const [code, setCode] = useState(() => params.get('code') ?? '');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [guildName, setGuildName] = useState('');
  const [mode, setMode] = useState<RegistrationMode>('off');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SetupResult | null>(null);

  useEffect(() => {
    document.title = `${t('setup.title')} · ${config.appName}`;
  }, [t]);

  const next = (event: SyntheticEvent) => {
    event.preventDefault();
    setError(null);
    if (step === 0 && code.trim().length < 8) {
      setError(t('setup.codeMissing'));
      return;
    }
    if (step === 1) {
      if (!USERNAME.test(username.trim())) {
        setError(t('reg.badUsername'));
        return;
      }
      if (email.trim() && !EMAIL.test(email.trim())) {
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
    }
    if (step === 2 && !guildName.trim()) {
      setError(t('setup.guildMissing'));
      return;
    }
    setStep(step + 1);
  };

  const finish = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const done = await setupApi.complete({
        code: code.trim(),
        username: username.trim(),
        displayName: displayName.trim() || username.trim(),
        password,
        ...(email.trim() ? { email: email.trim() } : {}),
        guildName: guildName.trim(),
        registrationMode: mode,
      });
      adoptSession(done);
      setResult(done);
    } catch (e) {
      setError(friendlyError(e, t('setup.failed')));
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    const link = `${window.location.origin}/invite/${result.inviteCode}`;
    return (
      <AuthCard title={t('setup.readyTitle')} subtitle={t('setup.readyBody')}>
        <div className="setup-done">
          <PartyPopper size={28} aria-hidden="true" />
          <label className="field">
            <span className="field-label">{t('setup.inviteLink')}</span>
            <span className="setup-invite">
              <input className="input" readOnly value={link} onFocus={(e) => e.target.select()} />
              <button
                type="button"
                className="icon-btn"
                aria-label={t('setup.copy')}
                title={t('setup.copy')}
                onClick={() => {
                  void navigator.clipboard.writeText(link).then(
                    () => toast.success(t('setup.copied'), 'setup-copy'),
                    () => undefined,
                  );
                }}
              >
                <Copy size={16} />
              </button>
            </span>
          </label>
          <p className="field-hint">{t('setup.nextSteps')}</p>
          <button
            type="button"
            className="btn btn-primary login-submit"
            onClick={() => {
              onDone();
              void navigate(guildPath(result.guildId), { replace: true });
            }}
          >
            {t('setup.open')}
          </button>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard title={t('setup.title')} subtitle={t(`setup.steps.${step}`)}>
      <ol className="setup-progress" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <li key={i} className={i === step ? 'is-current' : i < step ? 'is-done' : ''} />
        ))}
      </ol>
      <form className="login-form" onSubmit={step === 3 ? (e) => void finish(e) : next} noValidate>
        <ErrorLine text={error} />
        {step === 0 && (
          <div className="field">
            <label className="field-label" htmlFor="setup-code">
              {t('setup.code')}
            </label>
            <input id="setup-code" className="input" autoComplete="off" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
            <span className="field-hint">{t('setup.codeHint')}</span>
          </div>
        )}
        {step === 1 && (
          <>
            <div className="field">
              <label className="field-label" htmlFor="setup-username">
                {t('reg.username')}
              </label>
              <input id="setup-username" className="input" autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={32} value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
              <span className="field-hint">{t('reg.usernameHint')}</span>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="setup-display">
                {t('reg.displayName')}
              </label>
              <input id="setup-display" className="input" maxLength={64} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="setup-email">
                {t('setup.email')}
              </label>
              <input id="setup-email" className="input" type="email" autoComplete="email" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />
              <span className="field-hint">{t('setup.emailHint')}</span>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="setup-password">
                {t('reg.password')}
              </label>
              <input id="setup-password" className="input" type="password" autoComplete="new-password" maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} />
              <span className="field-hint">{t('reg.passwordHint')}</span>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="setup-repeat">
                {t('reg.repeat')}
              </label>
              <input id="setup-repeat" className="input" type="password" autoComplete="new-password" maxLength={128} value={repeat} onChange={(e) => setRepeat(e.target.value)} />
            </div>
          </>
        )}
        {step === 2 && (
          <div className="field">
            <label className="field-label" htmlFor="setup-guild">
              {t('setup.guildName')}
            </label>
            <input id="setup-guild" className="input" maxLength={100} value={guildName} onChange={(e) => setGuildName(e.target.value)} autoFocus />
            <span className="field-hint">{t('setup.guildHint')}</span>
          </div>
        )}
        {step === 3 && (
          <div className="setup-modes" role="radiogroup" aria-label={t('setup.steps.3')}>
            {MODES.map((m) => (
              <label key={m} className={`reg-mode${mode === m ? ' is-active' : ''}`}>
                <input type="radio" name="setup-mode" aria-label={t(`regAdmin.modes.${m}`)} checked={mode === m} onChange={() => setMode(m)} />
                <span>
                  <strong>{t(`regAdmin.modes.${m}`)}</strong>
                  <span className="field-hint">{t(`regAdmin.modes.${m}Hint`)}</span>
                </span>
              </label>
            ))}
            <p className="field-hint">{t('setup.mailLater')}</p>
          </div>
        )}
        <div className="setup-actions">
          {step > 0 && (
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setStep(step - 1)}>
              {t('setup.back')}
            </button>
          )}
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy && <span className="spinner spinner-on-accent" aria-hidden="true" />}
            {step === 3 ? t('setup.finish') : t('setup.next')}
          </button>
        </div>
      </form>
    </AuthCard>
  );
}
