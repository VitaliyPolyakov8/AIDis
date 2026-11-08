import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { en } from './en';
import { ru } from './ru';
import { enV070, mergeDictionaries, ruV070 } from './v070';
import { enV071, ruV071 } from './v071';
import { enV100, ruV100 } from './v100';

/**
 * Localization: i18next + react-i18next with two bundled dictionaries (no network loading).
 * Language choice: saved preference -> browser language (ru* -> Russian) -> English.
 * Components use `useTranslation()`; non-React modules (errors, time, voice service) use `t()`.
 */
export const LANGUAGES = ['ru', 'en'] as const;
export type Language = (typeof LANGUAGES)[number];

const STORAGE_KEY = 'aidis.language';

function readSaved(): Language | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'ru' || value === 'en' ? value : null;
  } catch {
    return null;
  }
}

export function detectLanguage(): Language {
  const saved = readSaved();
  if (saved) return saved;
  const browser = typeof navigator !== 'undefined' ? (navigator.languages[0] ?? navigator.language) : '';
  return browser.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

void i18next.use(initReactI18next).init({
  // 0.7.0 strings live in v070.ts and are merged in here.
  // 0.7.1 strings: v071.ts.
  resources: {
    en: { translation: mergeDictionaries(mergeDictionaries(mergeDictionaries(en, enV070), enV071), enV100) },
    ru: { translation: mergeDictionaries(mergeDictionaries(mergeDictionaries(ru, ruV070), ruV071), ruV100) },
  },
  lng: detectLanguage(),
  fallbackLng: 'en',
  supportedLngs: LANGUAGES,
  initAsync: false,
  interpolation: { escapeValue: false }, // React escapes; strings are never injected as HTML
  returnNull: false,
});

function applyDocumentLanguage(lng: string): void {
  if (typeof document !== 'undefined') document.documentElement.lang = lng;
}
applyDocumentLanguage(i18next.language);

export function getLanguage(): Language {
  return i18next.language === 'ru' ? 'ru' : 'en';
}

/** Switches the UI language and remembers the choice on this device. */
export function setLanguage(lng: Language): void {
  try {
    localStorage.setItem(STORAGE_KEY, lng);
  } catch {
    /* storage blocked: the choice lasts for this tab only */
  }
  void i18next.changeLanguage(lng);
  applyDocumentLanguage(lng);
}

export const t = i18next.t.bind(i18next);
export { i18next };
