import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { friendlyError } from '../../api/errors';
import { registrationApi, type RegistrationMode, type RegistrationState } from '../../api/registration';
import { toast } from '../../stores/uiStore';

const MODES: RegistrationMode[] = ['off', 'invite', 'open'];

/** 0.7.1 superadmin: who may create an account by themselves. Needs checked mail except for "off". */
export function RegistrationSettings() {
  const { t } = useTranslation();
  const [state, setState] = useState<RegistrationState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    registrationApi.state().then(setState, (e: unknown) => setError(friendlyError(e, t('regAdmin.failed'))));
  }, [t]);

  const pick = async (mode: RegistrationMode) => {
    setBusy(true);
    setError(null);
    try {
      setState(await registrationApi.setMode(mode));
      toast.success(t('regAdmin.saved'), 'reg-admin');
    } catch (e) {
      setError(friendlyError(e, t('regAdmin.failed')));
    } finally {
      setBusy(false);
    }
  };

  if (!state && !error) return <span className="spinner" role="status" aria-label={t('common.loading')} />;
  return (
    <div className="admin-section">
      <p className="field-hint">{t('regAdmin.hint')}</p>
      {state && !state.mail && <p className="alert alert-info">{t('regAdmin.needMail')}</p>}
      <div className="admin-card reg-modes" role="radiogroup" aria-label={t('adminPanel.tabs.registration')}>
        {MODES.map((mode) => {
          const disabled = busy || (mode !== 'off' && !state?.mail);
          return (
            <label key={mode} className={`reg-mode${state?.mode === mode ? ' is-active' : ''}${disabled ? ' is-disabled' : ''}`}>
              <input type="radio" name="registration-mode" aria-label={t(`regAdmin.modes.${mode}`)} checked={state?.mode === mode} disabled={disabled} onChange={() => void pick(mode)} />
              <span>
                <strong>{t(`regAdmin.modes.${mode}`)}</strong>
                <span className="field-hint">{t(`regAdmin.modes.${mode}Hint`)}</span>
              </span>
            </label>
          );
        })}
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
