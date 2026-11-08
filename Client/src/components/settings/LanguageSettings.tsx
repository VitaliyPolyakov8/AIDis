import { useTranslation } from 'react-i18next';
import { LanguageSwitch } from '../LanguageSwitch';

export function LanguageSettings() {
  const { t } = useTranslation();
  return (
    <div className="settings-stack">
      <div className="settings-card">
        <div className="setting-row">
          <span className="setting-row-text">
            <span className="setting-row-title">{t('settings.language.title')}</span>
            <span className="field-hint">{t('settings.language.hint')}</span>
          </span>
          <LanguageSwitch />
        </div>
      </div>
    </div>
  );
}
