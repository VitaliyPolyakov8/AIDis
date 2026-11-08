import { getLanguage, t } from '../i18n';

const pad = (n: number) => String(n).padStart(2, '0');

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

const DAY_MS = 24 * 60 * 60 * 1000;

function dayDiff(date: Date, now: Date): number {
  return Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS);
}

/** 24-hour clock in both languages: "13:42". */
export function formatClock(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatDate(date: Date): string {
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
}

/** "Today at 13:42" / "Сегодня в 13:42", "Yesterday at 09:10", "03.10.2026 21:15". */
export function formatMessageTimestamp(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const diff = dayDiff(date, now);
  if (diff === 0) return t('time.today', { time: formatClock(date) });
  if (diff === 1) return t('time.yesterday', { time: formatClock(date) });
  return `${formatDate(date)} ${formatClock(date)}`;
}

/** Full date for tooltips, in the UI language. */
export function formatFullDate(iso: string): string {
  return new Date(iso).toLocaleString(getLanguage() === 'ru' ? 'ru-RU' : 'en-GB', {
    dateStyle: 'full',
    timeStyle: 'short',
  });
}

/** Divider between days: "Today", "Yesterday", "Monday, 5 October 2026" / "понедельник, 5 октября 2026 г.". */
export function formatDayDivider(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const diff = dayDiff(date, now);
  if (diff === 0) return t('time.todayDivider');
  if (diff === 1) return t('time.yesterdayDivider');
  return date.toLocaleDateString(getLanguage() === 'ru' ? 'ru-RU' : 'en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

export function isSameDay(a: string, b: string): boolean {
  return startOfDay(new Date(a)) === startOfDay(new Date(b));
}

/** "Last seen 5 min ago" / "Был(а) 5 минут назад", with proper plural forms. */
export function formatLastSeen(iso: string | null, now: Date = new Date()): string {
  if (!iso) return t('lastSeen.never');
  const date = new Date(iso);
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60_000);
  if (minutes < 1) return t('lastSeen.justNow');
  if (minutes < 60) return t('lastSeen.minutes', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('lastSeen.hours', { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return t('lastSeen.days', { count: days });
  return t('lastSeen.date', { date: formatDate(date) });
}
