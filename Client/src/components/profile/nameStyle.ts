/**
 * 0.5.5 name styles: a user's display name can be a two-color gradient, glow, and use one of the
 * bundled fonts. Everything is chosen from fixed options (colors are #rrggbb checked for
 * readability, fonts are ids), never CSS from a user. Used wherever the name is drawn in the
 * user's own color (chat author, member list, voice list and tiles, stream title, profile).
 */
import type { CSSProperties } from 'react';
import '@fontsource/unbounded/cyrillic-400.css';
import '@fontsource/unbounded/latin-400.css';
import '@fontsource/comfortaa/cyrillic-400.css';
import '@fontsource/comfortaa/latin-400.css';
import '@fontsource/lobster/cyrillic-400.css';
import '@fontsource/lobster/latin-400.css';
import '@fontsource/caveat/cyrillic-400.css';
import '@fontsource/caveat/latin-400.css';
import '@fontsource/press-start-2p/cyrillic-400.css';
import '@fontsource/press-start-2p/latin-400.css';
import '@fontsource/russo-one/cyrillic-400.css';
import '@fontsource/russo-one/latin-400.css';
import { NICKNAME_FONTS, type NicknameFont, type PublicUser } from '../../api/types';
import { usePresenceStore } from '../../stores/presenceStore';
import { displayNicknameColor } from './nicknameColor';

/** Font family per id (the CSS families the bundled @fontsource packages register). */
export const NICKNAME_FONT_FAMILIES: Record<NicknameFont, string> = {
  unbounded: "'Unbounded', sans-serif",
  comfortaa: "'Comfortaa', sans-serif",
  lobster: "'Lobster', cursive",
  caveat: "'Caveat', cursive",
  'press-start': "'Press Start 2P', monospace",
  'russo-one': "'Russo One', sans-serif",
};

/** Pixel-ish fonts read large: they are drawn a bit smaller to keep the line height. */
const FONT_SCALE: Partial<Record<NicknameFont, number>> = { 'press-start': 0.72, caveat: 1.18, unbounded: 0.92 };

export function isNicknameFont(value: unknown): value is NicknameFont {
  return typeof value === 'string' && (NICKNAME_FONTS as readonly string[]).includes(value);
}

type StyleFields = Pick<PublicUser, 'nicknameColor' | 'nicknameColor2' | 'nicknameGlow' | 'nicknameFont'>;

export interface NameStyle {
  className: string;
  style: CSSProperties;
}

/**
 * Class + inline style for a name. `fallbackColor` (e.g. the role color) is used when the user
 * picked no color. Pure (unit-tested).
 */
export function nameStyleOf(user: Partial<StyleFields> | null | undefined, fallbackColor: string | null = null): NameStyle {
  const first = displayNicknameColor(user?.nicknameColor) ?? fallbackColor;
  const second = displayNicknameColor(user?.nicknameColor2);
  const font = isNicknameFont(user?.nicknameFont) ? user.nicknameFont : null;
  const classes = ['styled-name'];
  const style: CSSProperties & Record<`--${string}`, string> = {};
  if (first && second) {
    classes.push('is-gradient');
    style.backgroundImage = `linear-gradient(90deg, ${first}, ${second})`;
    style['--name-glow'] = first;
  } else if (first) {
    style.color = first;
    style['--name-glow'] = first;
  }
  if (user?.nicknameGlow) classes.push('is-glow');
  if (font) {
    classes.push('has-font');
    style.fontFamily = NICKNAME_FONT_FAMILIES[font];
    const scale = FONT_SCALE[font];
    if (scale) style.fontSize = `${String(scale)}em`;
  }
  return { className: classes.join(' '), style };
}

/** Live name style of a user (updates when they change it); `fallback` for authors not in the store. */
export function useNameStyle(userId: string | null | undefined, fallback: Partial<StyleFields> | null = null, fallbackColor: string | null = null): NameStyle {
  const user = usePresenceStore((s) => (userId ? s.users[userId] : undefined));
  return nameStyleOf(user ?? fallback, fallbackColor);
}
