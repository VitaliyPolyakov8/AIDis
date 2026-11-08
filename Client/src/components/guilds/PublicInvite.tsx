import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Users } from 'lucide-react';
import { registrationApi, type PublicInvite as Invite } from '../../api/registration';
import { AuthCard } from '../../pages/AuthCard';
import { SplashScreen } from '../Splash';

/**
 * 0.7.1: an invite opened while logged out. While registration is on, the server's name is shown with
 * "Log in" / "Sign up"; otherwise (or for a dead code) it is the 0.7.0 behaviour: straight to login.
 * The caller has already saved the code, so after logging in the invite opens by itself.
 */
export function PublicInvite({ code }: { code: string }) {
  const { t } = useTranslation();
  const location = useLocation();
  const [state, setState] = useState<{ invite: Invite } | 'loading' | 'none'>('loading');

  useEffect(() => {
    let alive = true;
    registrationApi.publicInvite(code).then(
      (res) => alive && setState(res),
      () => alive && setState('none'),
    );
    return () => {
      alive = false;
    };
  }, [code]);

  if (state === 'loading') return <SplashScreen label={t('splash.restoring')} />;
  if (state === 'none') return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  const { invite } = state;
  return (
    <AuthCard title={t('publicInvite.title')} subtitle={t('publicInvite.hint')}>
      <div className="invite-card public-invite">
        <strong className="public-invite-name">{invite.guild.name}</strong>
        <span className="field-hint">
          <Users size={14} aria-hidden="true" /> {t('publicInvite.members', { count: invite.memberCount })}
        </span>
      </div>
      <div className="public-invite-actions">
        <Link className="btn btn-primary" to={`/register?invite=${encodeURIComponent(invite.code)}`}>
          {t('publicInvite.register')}
        </Link>
        <Link className="btn btn-secondary" to="/login" state={{ from: location.pathname }}>
          {t('publicInvite.login')}
        </Link>
      </div>
    </AuthCard>
  );
}
