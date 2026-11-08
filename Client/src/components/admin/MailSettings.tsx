import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MailCheck, Save } from 'lucide-react';
import { friendlyError } from '../../api/errors';
import { registrationApi, type MailSecurity, type MailSettings as Mail } from '../../api/registration';
import { toast } from '../../stores/uiStore';
import { formatMessageTimestamp } from '../../utils/time';

const DEFAULT_PORT: Record<MailSecurity, number> = { tls: 465, starttls: 587, none: 25 };

/** 0.7.1 superadmin: the SMTP server for registration and password reset letters. */
export function MailSettings() {
  const { t } = useTranslation();
  const [mail, setMail] = useState<Mail | null | undefined>(undefined);
  const [host, setHost] = useState('');
  const [security, setSecurity] = useState<MailSecurity>('tls');
  const [port, setPort] = useState(465);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fromName, setFromName] = useState('AIDis');
  const [fromAddress, setFromAddress] = useState('');
  const [testTo, setTestTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = (m: Mail | null) => {
    setMail(m);
    if (!m) return;
    setHost(m.host);
    setSecurity(m.security);
    setPort(m.port);
    setUsername(m.username);
    setFromName(m.fromName);
    setFromAddress(m.fromAddress);
    setPassword('');
  };

  useEffect(() => {
    registrationApi.mail().then(
      ({ mail: m }) => apply(m),
      (e: unknown) => setError(friendlyError(e, t('mailAdmin.failed'))),
    );
  }, [t]);

  const run = async (action: () => Promise<{ mail: Mail }>, ok: string) => {
    setBusy(true);
    setError(null);
    try {
      const { mail: m } = await action();
      apply(m);
      toast.success(t(ok), 'mail-admin');
    } catch (e) {
      setError(friendlyError(e, t('mailAdmin.failed')));
    } finally {
      setBusy(false);
    }
  };

  if (mail === undefined && !error) return <span className="spinner" role="status" aria-label={t('common.loading')} />;
  const save = () =>
    run(() => registrationApi.saveMail({ host: host.trim(), port, security, username: username.trim(), ...(password ? { password } : {}), fromName: fromName.trim(), fromAddress: fromAddress.trim() }), 'mailAdmin.saved');

  return (
    <div className="admin-section">
      <p className="field-hint">{t('mailAdmin.hint')}</p>
      <form
        className="admin-card mail-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p className={`mail-status${mail?.verifiedAt ? ' is-ok' : ''}`}>
          {!mail ? t('mailAdmin.empty') : mail.verifiedAt ? t('mailAdmin.verified', { when: formatMessageTimestamp(mail.verifiedAt) }) : t('mailAdmin.notVerified')}
        </p>
        <div className="admin-form-grid">
          <label className="field">
            <span className="field-label">{t('mailAdmin.host')}</span>
            <input className="input" value={host} maxLength={253} onChange={(e) => setHost(e.target.value)} placeholder="smtp.yandex.ru" spellCheck={false} />
          </label>
          <label className="field">
            <span className="field-label">{t('mailAdmin.security')}</span>
            <select
              className="input"
              value={security}
              onChange={(e) => {
                const next = e.target.value as MailSecurity;
                if (port === DEFAULT_PORT[security]) setPort(DEFAULT_PORT[next]);
                setSecurity(next);
              }}
            >
              {(['tls', 'starttls', 'none'] as const).map((s) => (
                <option key={s} value={s}>
                  {t(`mailAdmin.securityOptions.${s}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">{t('mailAdmin.port')}</span>
            <input className="input" type="number" min={1} max={65535} value={port} onChange={(e) => setPort(Number(e.target.value) || 0)} />
          </label>
          <label className="field">
            <span className="field-label">{t('mailAdmin.username')}</span>
            <input className="input" value={username} maxLength={254} autoComplete="off" onChange={(e) => setUsername(e.target.value)} spellCheck={false} />
          </label>
          <label className="field">
            <span className="field-label">{t('mailAdmin.password')}</span>
            <input
              className="input"
              type="password"
              value={password}
              maxLength={512}
              autoComplete="new-password"
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mail?.hasPassword ? t('mailAdmin.passwordKeep') : ''}
            />
          </label>
          <label className="field">
            <span className="field-label">{t('mailAdmin.fromName')}</span>
            <input className="input" value={fromName} maxLength={100} onChange={(e) => setFromName(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">{t('mailAdmin.fromAddress')}</span>
            <input className="input" type="email" value={fromAddress} maxLength={254} onChange={(e) => setFromAddress(e.target.value)} placeholder="noreply@example.com" spellCheck={false} />
          </label>
        </div>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !host.trim() || !fromAddress.trim() || port < 1}>
          <Save size={14} aria-hidden="true" /> {t('mailAdmin.save')}
        </button>
      </form>
      {mail && (
        <form
          className="admin-card mail-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (testTo.trim()) void run(() => registrationApi.testMail(testTo.trim()), 'mailAdmin.testOk');
          }}
        >
          <label className="field">
            <span className="field-label">{t('mailAdmin.testTo')}</span>
            <input className="input" type="email" value={testTo} maxLength={254} onChange={(e) => setTestTo(e.target.value)} placeholder="you@example.com" />
          </label>
          <button type="submit" className="btn btn-secondary btn-sm" disabled={busy || !testTo.trim()}>
            {busy ? <span className="spinner" aria-hidden="true" /> : <MailCheck size={14} aria-hidden="true" />} {t('mailAdmin.test')}
          </button>
        </form>
      )}
    </div>
  );
}
