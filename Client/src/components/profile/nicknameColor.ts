/**
 * 0.5.0 user-selected nickname color. Stored on the server as #rrggbb (never CSS) and synced to
 * every device; used only for a user's display name (chat author, member list, voice list, profile,
 * stream tiles, overlay), never for message text, timestamps or role badges.
 */
import { usePresenceStore } from '../../stores/presenceStore';

/** Attractive presets that are all readable on the dark AIDis surfaces. */
export const NICKNAME_PRESETS = ['#ff6b6b', '#ff9f43', '#feca57', '#7bed9f', '#2ed573', '#1dd1a1', '#48dbfb', '#54a0ff', '#8c7ae6', '#c56cf0', '#ff7ab6', '#f5f6fa'];

/** Darkest surface a name is drawn on and the minimum contrast (the server enforces the same). */
const BACKGROUND = '#111214';
export const MIN_CONTRAST = 3;

const HEX = /^#[0-9a-fA-F]{6}$/;

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

export function contrastOnBackground(hex: string): number {
  const l = luminance(hex);
  const bg = luminance(BACKGROUND);
  return (Math.max(l, bg) + 0.05) / (Math.min(l, bg) + 0.05);
}

export function isReadableNicknameColor(hex: string): boolean {
  return HEX.test(hex) && contrastOnBackground(hex) >= MIN_CONTRAST;
}

function mixWithWhite(hex: string, amount: number): string {
  const to = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16);
    return Math.round(c + (255 - c) * amount)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${to(1)}${to(3)}${to(5)}`;
}

/**
 * What is actually drawn: the color itself when readable, otherwise the same hue lightened just
 * enough (older data, a server without the check). null / invalid = default color. Pure.
 */
export function displayNicknameColor(value: string | null | undefined): string | null {
  if (!value || !HEX.test(value)) return null;
  const hex = value.toLowerCase();
  if (contrastOnBackground(hex) >= MIN_CONTRAST) return hex;
  for (let k = 1; k <= 20; k += 1) {
    const lighter = mixWithWhite(hex, k * 0.05);
    if (contrastOnBackground(lighter) >= MIN_CONTRAST) return lighter;
  }
  return null;
}

/** The display color of a user's name (live: updates when they change it), or null. */
export function useNicknameColor(userId: string | null | undefined): string | null {
  const raw = usePresenceStore((s) => (userId ? s.users[userId]?.nicknameColor : null));
  return displayNicknameColor(raw);
}
