/**
 * 0.5.6 "What's new": the release notes shown once after an update (and from Settings -> About).
 * Newest first. Text lives here, next to the data, in both languages (ru is the main one).
 */
export interface Localized {
  ru: string;
  en: string;
}

export interface ChangelogSection {
  title: Localized;
  items: Localized[];
}

export interface ChangelogEntry {
  version: string;
  /** ISO date of the release. */
  date: string;
  summary: Localized;
  sections: ChangelogSection[];
}

export const CHANGELOG: readonly ChangelogEntry[] = [
  {
    version: '1.0.0', date: '2026-11-08',
    summary: { ru: 'Первая публичная версия AIDis — собственный сервер для общения с друзьями.', en: 'The first public release of AIDis — your own server for talking with friends.' },
    sections: [
      { title: { ru: 'Серверы и общение', en: 'Servers and chat' }, items: [
        { ru: 'Свои серверы с каналами, категориями, ролями и правами, приглашения, друзья и личные сообщения.', en: 'Your own servers with channels, categories, roles and permissions, invites, friends and direct messages.' },
      ] },
      { title: { ru: 'Голос', en: 'Voice' }, items: [
        { ru: 'Голосовые каналы, демонстрация экрана и камера, звуки сервера, дополнительные голосовые серверы.', en: 'Voice channels, screen sharing and camera, server sounds, extra voice servers.' },
      ] },
      { title: { ru: 'Игры', en: 'Games' }, items: [
        { ru: 'Трекер игр: что вы играете и что прошли, в том числе на других платформах.', en: 'Game tracker: what you play and what you finished, including other platforms.' },
      ] },
    ],
  },
];

/** Release notes text in the UI language (anything that is not Russian gets English). */
export function localized(text: Localized, language: string | undefined): string {
  return language?.startsWith('ru') ? text.ru : text.en;
}

/** The entry for this exact version, if there are notes for it. */
export function changelogFor(version: string): ChangelogEntry | null {
  return CHANGELOG.find((entry) => entry.version === version) ?? null;
}
