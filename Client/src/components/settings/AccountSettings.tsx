import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ImageUp, Trash } from 'lucide-react';
import { authApi } from '../../api/auth';
import { usersApi } from '../../api/users';
import { registrationApi } from '../../api/registration';
import { uploadAttachment } from '../../api/attachments';
import { friendlyError, isApiError } from '../../api/errors';
import { t as translate } from '../../i18n';
import type { SessionView } from '../../api/types';
import { useAuthStore } from '../../stores/authStore';
import { usePresenceStore } from '../../stores/presenceStore';
import { toast } from '../../stores/uiStore';
import { Avatar } from '../Avatar';
import { StyledName } from '../profile/StyledName';
import { formatMessageTimestamp } from '../../utils/time';

function ProfileSection() {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const upsertUser = usePresenceStore((s) => s.upsertUser);
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [saving, setSaving] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  if (!user) return null;

  const apply = (next: typeof user) => {
    setUser(next);
    upsertUser(next);
  };

  const saveName = async (e: SyntheticEvent) => {
    e.preventDefault();
    const name = displayName.trim();
    if (!name || name === user.displayName) return;
    setSaving(true);
    setError(null);
    try {
      const { user: next } = await usersApi.updateMe({ displayName: name });
      apply(next);
      toast.success(t('settings.account.nameSaved'), 'profile');
    } catch (err) {
      setError(friendlyError(err, t('settings.account.nameFailed')));
    } finally {
      setSaving(false);
    }
  };

  const changeAvatar = async (file: File) => {
    // Same rules as the server (0.3.0): PNG, JPEG, GIF or WebP, animated GIF/WebP allowed.
    if (!AVATAR_TYPES.includes(file.type)) {
      setError(t('settings.account.avatarType'));
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setError(t('settings.account.avatarSize'));
      return;
    }
    setAvatarBusy(true);
    setError(null);
    try {
      const attachment = await uploadAttachment(file, () => undefined).promise;
      const { user: next } = await usersApi.updateMe({ avatarAttachmentId: attachment.id });
      apply(next);
    } catch (err) {
      setError(friendlyError(err, t('settings.account.avatarFailed')));
    } finally {
      setAvatarBusy(false);
    }
  };

  const removeAvatar = async () => {
    setAvatarBusy(true);
    try {
      const { user: next } = await usersApi.updateMe({ avatarAttachmentId: null });
      apply(next);
    } catch (err) {
      setError(friendlyError(err, t('settings.account.avatarRemoveFailed')));
    } finally {
      setAvatarBusy(false);
    }
  };

  return (
    <div className="settings-card">
      <div className="profile-row">
        <Avatar userId={user.id} name={user.displayName} avatarAttachmentId={user.avatarAttachmentId} size={72} />
        <div className="profile-ident">
          <span className="profile-name">
            <StyledName userId={user.id} name={user.displayName} fallback={user} />
          </span>
          <span className="profile-username">@{user.username}</span>
          <span className="role-badge">{user.role === 'ADMIN' ? t('members.admin') : t('members.member')}</span>
        </div>
        <div className="profile-avatar-actions">
          <button type="button" className="btn btn-secondary btn-sm" disabled={avatarBusy} onClick={() => fileRef.current?.click()}>
            {avatarBusy ? <span className="spinner" aria-hidden="true" /> : <ImageUp size={14} aria-hidden="true" />}
            {t('settings.account.changeAvatar')}
          </button>
          {user.avatarAttachmentId && (
            <button type="button" className="btn btn-ghost btn-sm" disabled={avatarBusy} onClick={() => void removeAvatar()}>
              <Trash size={14} aria-hidden="true" /> {t('settings.account.removeAvatar')}
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept={AVATAR_TYPES.join(',')}
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void changeAvatar(file);
            }}
          />
        </div>
      </div>

      <form className="settings-form" onSubmit={(e) => void saveName(e)}>
        <div className="field">
          <label className="field-label" htmlFor="settings-display-name">
            {t('settings.account.displayName')}
          </label>
          <div className="inline-field">
            <input id="settings-display-name" className="input" value={displayName} maxLength={64} onChange={(e) => setDisplayName(e.target.value)} />
            <button type="submit" className="btn btn-primary" disabled={saving || !displayName.trim() || displayName.trim() === user.displayName}>
              {t('common.save')}
            </button>
          </div>
          <span className="field-hint">{t('settings.account.displayNameHint')}</span>
        </div>
        <div className="field">
          <span className="field-label">{t('settings.account.username')}</span>
          <span className="readonly-value">{user.username}</span>
        </div>
      </form>
      {error && (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function PasswordSection() {
  const { t } = useTranslation();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handleAuthFailure = useAuthStore((s) => s.handleAuthFailure);

  const submit = async (e: SyntheticEvent) => {
    e.preventDefault();
    setError(null);
    if (next.length < 8) {
      setError(t('settings.account.passwordTooShort'));
      return;
    }
    if (next !== confirm) {
      setError(t('settings.account.passwordMismatch'));
      return;
    }
    setBusy(true);
    try {
      await authApi.changePassword(current, next);
      // The server revokes every session after a password change.
      handleAuthFailure('password_changed');
    } catch (err) {
      setError(isApiError(err) && err.code === 'INVALID_CREDENTIALS' ? t('settings.account.passwordWrong') : friendlyError(err, t('settings.account.passwordFailed')));
      setBusy(false);
    }
  };

  return (
    <form className="settings-card settings-form" onSubmit={(e) => void submit(e)}>
      <h4 className="settings-card-title">{t('settings.account.changePassword')}</h4>
      <p className="field-hint">{t('settings.account.passwordHint')}</p>
      <div className="field">
        <label className="field-label" htmlFor="pw-current">
          {t('settings.account.currentPassword')}
        </label>
        <input id="pw-current" className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </div>
      <div className="field-grid">
        <div className="field">
          <label className="field-label" htmlFor="pw-new">
            {t('settings.account.newPassword')}
          </label>
          <input id="pw-new" className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="pw-confirm">
            {t('settings.account.repeatPassword')}
          </label>
          <input id="pw-confirm" className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
      </div>
      {error && (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      )}
      <div>
        <button type="submit" className="btn btn-secondary" disabled={busy || !current || !next || !confirm}>
          {busy && <span className="spinner" aria-hidden="true" />}
          {t('settings.account.changePassword')}
        </button>
      </div>
    </form>
  );
}

function SessionsSection() {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<SessionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    authApi.sessions().then(
      (r) => {
        if (!cancelled) setSessions(r.sessions);
      },
      (e: unknown) => {
        if (!cancelled) setError(friendlyError(e, translate('settings.account.sessionsFailed')));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const revoke = async (id: string) => {
    try {
      await authApi.revokeSession(id);
      setSessions((list) => list?.filter((s) => s.id !== id) ?? null);
    } catch (e) {
      toast.error(friendlyError(e, t('settings.account.endFailed')));
    }
  };

  return (
    <div className="settings-card">
      <h4 className="settings-card-title">{t('settings.account.sessions')}</h4>
      {error && <p className="alert alert-error">{error}</p>}
      {!sessions && !error && <span className="spinner" role="status" aria-label={t('settings.account.loadingSessions')} />}
      {sessions && (
        <ul className="session-list">
          {sessions.map((s) => (
            <li key={s.id} className="session-row">
              <div className="session-text">
                <span className="session-name">
                  {s.deviceName ?? s.clientType}
                  {s.current && <span className="role-badge is-accent">{t('settings.account.thisDevice')}</span>}
                </span>
                <span className="field-hint">{t('settings.account.active', { when: formatMessageTimestamp(s.lastUsedAt) })}</span>
              </div>
              {!s.current && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void revoke(s.id)}>
                  {t('settings.account.endSession')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** 0.7.1: the account e-mail (password reset). A new address works after its confirmation link. */
function EmailSection() {
  const { t } = useTranslation();
  const [current, setCurrent] = useState<{ email: string | null; verified: boolean } | null>(null);
  const [mail, setMail] = useState(false);
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    registrationApi.myEmail().then(setCurrent, () => undefined);
    registrationApi.state().then(
      (s) => setMail(s.mail),
      () => undefined,
    );
  }, []);

  // Servers before 0.7.1 have no e-mail at all.
  if (!current) return null;

  const submit = async (e: SyntheticEvent) => {
    e.preventDefault();
    if (!next.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await registrationApi.changeEmail(next.trim());
      toast.success(t('accountEmail.sent', { email: next.trim() }), 'account-email');
      setNext('');
    } catch (err) {
      setError(friendlyError(err, t('accountEmail.failed')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="settings-card settings-form" onSubmit={(e) => void submit(e)}>
      <h4 className="settings-card-title">{t('accountEmail.title')}</h4>
      <p className="field-hint">{t('accountEmail.hint')}</p>
      <p>
        {current.email ? (
          <>
            {t('accountEmail.current', { email: current.email })} · {current.verified ? t('accountEmail.verified') : t('accountEmail.notVerified')}
          </>
        ) : (
          t('accountEmail.none')
        )}
      </p>
      {mail ? (
        <div className="field">
          <label className="field-label" htmlFor="account-email">
            {t('accountEmail.newEmail')}
          </label>
          <input id="account-email" className="input" type="email" autoComplete="email" maxLength={254} value={next} onChange={(e) => setNext(e.target.value)} />
        </div>
      ) : (
        <p className="field-hint">{t('accountEmail.noMail')}</p>
      )}
      {error && (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      )}
      {mail && (
        <div>
          <button type="submit" className="btn btn-secondary" disabled={busy || !next.trim()}>
            {busy && <span className="spinner" aria-hidden="true" />}
            {t('accountEmail.change')}
          </button>
        </div>
      )}
    </form>
  );
}

export function AccountSettings() {
  return (
    <div className="settings-stack">
      <ProfileSection />
      <EmailSection />
      <PasswordSection />
      <SessionsSection />
    </div>
  );
}
