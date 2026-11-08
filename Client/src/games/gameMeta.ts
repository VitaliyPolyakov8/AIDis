import type { GamePlatform, GameStatus } from '../api/types';

export const GAME_STATUSES: readonly GameStatus[] = ['PLAYING', 'PAUSED', 'COMPLETED', 'HUNDRED', 'DROPPED'];
export const GAME_PLATFORMS: readonly GamePlatform[] = ['PC', 'PLAYSTATION', 'XBOX', 'SWITCH', 'MOBILE', 'OTHER'];

/** Status chip colors (readable on the dark and the light theme). */
export const STATUS_COLORS: Record<GameStatus, { bg: string; fg: string }> = {
  PLAYING: { bg: 'rgba(88, 101, 242, 0.18)', fg: '#8b96ff' },
  PAUSED: { bg: 'rgba(240, 178, 50, 0.18)', fg: '#f0b232' },
  COMPLETED: { bg: 'rgba(59, 165, 93, 0.18)', fg: '#4fd18b' },
  HUNDRED: { bg: 'rgba(235, 69, 158, 0.18)', fg: '#f06fb6' },
  DROPPED: { bg: 'rgba(237, 66, 69, 0.16)', fg: '#ff7a7c' },
};

/** "5 minutes ago", "yesterday", "3 days ago" in the UI language. Pure apart from Intl. */
export function playedAgo(iso: string, language: string, now = Date.now()): string {
  const seconds = Math.round((Date.parse(iso) - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  const abs = Math.abs(seconds);
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(seconds / 3600), 'hour');
  if (abs < 30 * 86_400) return rtf.format(Math.round(seconds / 86_400), 'day');
  return new Date(iso).toLocaleDateString(language, { day: 'numeric', month: 'short' });
}
