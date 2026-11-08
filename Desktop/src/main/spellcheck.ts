import type { Session } from 'electron';

type SpellingSession = Pick<Session, 'availableSpellCheckerLanguages' | 'setSpellCheckerEnabled' | 'setSpellCheckerLanguages'>;

/** Check both chat languages locally, independently of the interface language. */
export function configureSpellcheck(session: SpellingSession): void {
  session.setSpellCheckerEnabled(true);
  const supported = new Set(session.availableSpellCheckerLanguages);
  const languages = ['ru', 'en-US'].filter((language) => supported.has(language));
  if (languages.length > 0) session.setSpellCheckerLanguages(languages);
}
