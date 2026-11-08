import { useTranslation } from 'react-i18next';
import { UI_THEMES, useSettingsStore, type UiTheme } from '../../stores/settingsStore';

/** Swatch previews (the real colors live in v041.css as CSS variables). */
const PREVIEW: Record<UiTheme, string> = {
  default: 'linear-gradient(135deg, #1b2240, #3b4fbf 55%, #9b7bff)',
  aurora: 'linear-gradient(135deg, #12304a, #38bdf8 50%, #9b7bff)',
  sunset: 'linear-gradient(135deg, #4a1022, #ff8a5b 55%, #a24ad0)',
  emerald: 'linear-gradient(135deg, #0d2b26, #2fc6b0 55%, #3fa7d6)',
  crimson: 'linear-gradient(135deg, #1b1b1f, #6e1424 55%, #e4566a)',
  midnight: 'linear-gradient(135deg, #160f2e, #4b2a99 50%, #a77bff)',
  neutral: 'linear-gradient(135deg, #1a1b20, #3a3f4b 60%, #9aa3b5)',
};

export function AppearanceSettings() {
  const { t } = useTranslation();
  const density = useSettingsStore((s) => s.messageDensity);
  const theme = useSettingsStore((s) => s.uiTheme);
  const seasonal = useSettingsStore((s) => s.seasonalTheme);
  const update = useSettingsStore((s) => s.update);
  return (
    <div className="settings-stack">
      <div className="settings-card">
        <h4 className="settings-card-title">{t('settings.appearance.seasonal')}</h4>
        <div className="choice-row" role="radiogroup" aria-label={t('settings.appearance.seasonal')}>
          {(['auto', 'newyear', 'halloween', 'off'] as const).map((value) => (
            <button key={value} type="button" role="radio" aria-checked={seasonal === value} className={`choice${seasonal === value ? ' is-active' : ''}`} onClick={() => update({ seasonalTheme: value })}>
              {t(`settings.appearance.seasons.${value}`)}
            </button>
          ))}
        </div>
        <p className="field-hint">{t('settings.appearance.seasonalHint')}</p>
      </div>
      <div className="settings-card">
        <h4 className="settings-card-title">{t('settings.appearance.gradient')}</h4>
        <div className="theme-grid" role="radiogroup" aria-label={t('settings.appearance.gradient')}>
          {UI_THEMES.map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={theme === value}
              className={`theme-swatch${theme === value ? ' is-active' : ''}`}
              onClick={() => update({ uiTheme: value })}
            >
              <span className="theme-swatch-preview" style={{ background: PREVIEW[value] }} aria-hidden="true" />
              {t(`settings.appearance.themes.${value}`)}
            </button>
          ))}
        </div>
        <p className="field-hint">{t('settings.appearance.gradientHint')}</p>
      </div>
      <div className="settings-card">
        <h4 className="settings-card-title">{t('settings.appearance.spacing')}</h4>
        <div className="choice-row" role="radiogroup" aria-label={t('settings.appearance.spacing')}>
          {(['cozy', 'compact'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={density === value}
              className={`choice${density === value ? ' is-active' : ''}`}
              onClick={() => update({ messageDensity: value })}
            >
              <span className={`choice-lines is-${value}`} aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              {t(`settings.appearance.${value}`)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
