import { t } from '../i18n';

const pad = (n: number) => String(n).padStart(2, '0');

/** 0.4.1 voice session timer: "0:42", "12:18", "1:03:42". Negative / invalid -> "0:00". */
export function formatVoiceElapsed(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${String(h)}:${pad(m)}:${pad(s)}` : `${String(m)}:${pad(s)}`;
}

/** 0.4.1 game session length: "1 ч 24 мин" / "1h 24m", "12 мин" / "12m", "меньше минуты" / "less than a minute". */
export function formatPlayDuration(ms: number): string {
  const minutes = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 60_000) : 0;
  if (minutes < 1) return t('activity.duration.lessThanMinute');
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return t('activity.duration.minutes', { m });
  if (m === 0) return t('activity.duration.hours', { h });
  return t('activity.duration.hoursMinutes', { h, m });
}

/** Elapsed ms since an ISO time (null when absent or invalid). */
export function elapsedSince(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const start = Date.parse(iso);
  return Number.isFinite(start) ? Math.max(0, now - start) : null;
}
