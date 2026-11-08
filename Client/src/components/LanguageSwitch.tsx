import { useTranslation } from 'react-i18next';
import { LANGUAGES, setLanguage, type Language } from '../i18n';

const LABELS: Record<Language, { short: string; long: string }> = {
  ru: { short: 'RU', long: 'Русский' },
  en: { short: 'EN', long: 'English' },
};

/** Segmented RU / EN control (login page and Settings → Language). */
export function LanguageSwitch({ compact }: { compact?: boolean }) {
  const { t, i18n } = useTranslation();
  const current: Language = i18n.language === 'ru' ? 'ru' : 'en';
  return (
    <div className={`segmented${compact ? ' is-compact' : ''}`} role="radiogroup" aria-label={t('settings.language.title')}>
      {LANGUAGES.map((lng) => (
        <button
          key={lng}
          type="button"
          role="radio"
          aria-checked={current === lng}
          lang={lng}
          className={`segment${current === lng ? ' is-active' : ''}`}
          onClick={() => setLanguage(lng)}
        >
          {compact ? LABELS[lng].short : LABELS[lng].long}
        </button>
      ))}
    </div>
  );
}
