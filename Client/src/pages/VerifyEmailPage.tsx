import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { CircleAlert, MailCheck } from 'lucide-react';
import { friendlyError } from '../api/errors';
import { registrationApi } from '../api/registration';
import { channelPath, guildPath } from '../components/guilds/routes';
import { config } from '../config';
import { useAuthStore } from '../stores/authStore';
import { AuthCard } from './AuthCard';

type Outcome = { kind: 'pending' } | { kind: 'error'; message: string } | { kind: 'changed'; email: string } | { kind: 'in'; to: string };

/** 0.7.1 /verify?token=…: confirms a registration (and logs in) or a new e-mail. */
export function VerifyEmailPage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const adoptSession = useAuthStore((s) => s.adoptSession);
  const [outcome, setOutcome] = useState<Outcome>(() => (token ? { kind: 'pending' } : { kind: 'error', message: t('reset.noToken') }));
  // The link works once: StrictMode's second effect run must not use it again.
  const started = useRef(false);

  useEffect(() => {
    document.title = `${t('reg.title')} · ${config.appName}`;
  }, [t]);

  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    registrationApi.verifyEmail(token).then(
      (result) => {
        if ('emailChanged' in result) {
          setOutcome({ kind: 'changed', email: result.email });
          return;
        }
        adoptSession(result);
        setOutcome({ kind: 'in', to: result.guildId ? (result.channelId ? channelPath(result.guildId, result.channelId) : guildPath(result.guildId)) : '/' });
      },
      (e: unknown) => setOutcome({ kind: 'error', message: friendlyError(e, t('reg.verifyFailed')) }),
    );
  }, [token, adoptSession, t]);

  if (outcome.kind === 'in') return <Navigate to={outcome.to} replace />;

  return (
    <AuthCard title={t('reg.title')}>
      {outcome.kind === 'pending' && (
        <p className="alert alert-info" role="status">
          <span className="spinner" aria-hidden="true" />
          {t('reg.verifying')}
        </p>
      )}
      {outcome.kind === 'error' && (
        <p className="alert alert-error" role="alert">
          <CircleAlert size={16} aria-hidden="true" />
          {outcome.message}
        </p>
      )}
      {outcome.kind === 'changed' && (
        <p className="alert alert-info" role="status">
          <MailCheck size={16} aria-hidden="true" />
          {t('reg.emailChanged', { email: outcome.email })}
        </p>
      )}
      {outcome.kind !== 'pending' && (
        <Link className="btn btn-ghost" to="/">
          {outcome.kind === 'changed' ? t('reg.toApp') : t('reg.toLogin')}
        </Link>
      )}
    </AuthCard>
  );
}
