import type { DesktopLanguage } from '../../../Client/src/desktop/contract';

/** Strings shown by the main process itself (tray menu, native dialogs, system notifications). */
const STRINGS = {
  en: {
    trayTooltip: 'AIDis',
    trayTooltipInCall: 'AIDis · in voice',
    trayInVoice: 'Voice',
    trayMuted: 'Microphone muted',
    trayDeafened: 'Sound off',
    traySpeaking: 'Speaking',
    open: 'Open AIDis',
    muteMic: 'Mute microphone',
    deafen: 'Deafen',
    disconnect: 'Disconnect from voice',
    quit: 'Quit AIDis',
    stillRunningTitle: 'AIDis is still running',
    stillRunningBody: 'AIDis keeps running in the tray. Right-click the tray icon and choose Quit to exit.',
    crashTitle: 'AIDis',
    crashMessage: 'The AIDis window stopped working.',
    crashDetail: 'You can reload it; your login is kept.',
    reload: 'Reload',
    loadFailedMessage: 'AIDis could not load its interface.',
    loadFailedDetail: 'Try restarting the app. If this keeps happening, reinstall AIDis.',
    restartTitle: 'Restart required',
    ok: 'OK',
    updateReadyTitle: 'AIDis update is ready',
    updateReadyBody: 'Version {version} has been downloaded. Open AIDis to restart and update.',
  },
  ru: {
    trayTooltip: 'AIDis',
    trayTooltipInCall: 'AIDis · в голосовом канале',
    trayInVoice: 'Голосовой канал',
    trayMuted: 'Микрофон выключен',
    trayDeafened: 'Звук выключен',
    traySpeaking: 'Говорит',
    open: 'Открыть AIDis',
    muteMic: 'Выключить микрофон',
    deafen: 'Выключить звук',
    disconnect: 'Отключиться от голосового канала',
    quit: 'Выйти из AIDis',
    stillRunningTitle: 'AIDis продолжает работать',
    stillRunningBody: 'AIDis свёрнут в трей. Чтобы выйти, нажмите правой кнопкой на значок в трее и выберите «Выйти».',
    crashTitle: 'AIDis',
    crashMessage: 'Окно AIDis перестало отвечать.',
    crashDetail: 'Его можно перезагрузить, вход сохранится.',
    reload: 'Перезагрузить',
    loadFailedMessage: 'AIDis не удалось загрузить интерфейс.',
    loadFailedDetail: 'Перезапустите приложение. Если ошибка повторяется, переустановите AIDis.',
    restartTitle: 'Нужен перезапуск',
    ok: 'OK',
    updateReadyTitle: 'Обновление AIDis готово',
    updateReadyBody: 'Версия {version} загружена. Откройте AIDis, чтобы перезапустить и обновить.',
  },
} as const;

export type MainStringKey = keyof (typeof STRINGS)['en'];

let language: DesktopLanguage = 'en';

export function setMainLanguage(next: DesktopLanguage): void {
  language = next;
}

export function tr(key: MainStringKey): string {
  return STRINGS[language][key];
}
