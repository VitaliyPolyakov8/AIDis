/**
 * 0.4.0 game / activity colors. Every game gets a stable accent so the member list and profiles
 * feel alive, without hard-coding thousands of games:
 *
 * 1. Curated themes for well-known games (matched on a normalized name).
 * 2. Everything else: a deterministic color from a hash of the normalized name (FNV-1a), mapped
 *    into a pleasant hue / saturation / lightness range so it is readable on the dark UI.
 *
 * The same game always gets the same theme on every client (pure function of the name). Nothing is
 * fetched: no icon downloads, no network requests (the detected game name is all we have).
 */
export interface GameTheme {
  /** Main accent (text, border, glow), readable on dark backgrounds. */
  accent: string;
  /** Second color for gradients. */
  accent2: string;
  /** Soft translucent fill for pills / cards. */
  soft: string;
  /** True for curated (hand-picked) themes. */
  curated: boolean;
}

interface Curated {
  match: RegExp;
  accent: string;
  accent2: string;
}

/** Hand-picked accents for games the group actually plays (extend freely; order matters). */
const CURATED: Curated[] = [
  { match: /helldivers/, accent: '#ff8a3d', accent2: '#e8423f' },
  { match: /escape from tarkov|tarkov/, accent: '#9fae6a', accent2: '#5f6b3a' },
  { match: /escape simulator/, accent: '#ffb547', accent2: '#c2692b' },
  { match: /^f1|formula 1|ea sports f1/, accent: '#ff3b3b', accent2: '#b00020' },
  { match: /minecraft/, accent: '#6cc04a', accent2: '#8b5a2b' },
  { match: /cyberpunk/, accent: '#f5e663', accent2: '#3fe0ff' },
  { match: /counter-strike|cs2|cs:go/, accent: '#f2a93b', accent2: '#3a6ea5' },
  { match: /dota/, accent: '#e2463a', accent2: '#7a1f1a' },
  { match: /valorant/, accent: '#ff4655', accent2: '#0f1923' },
  { match: /league of legends/, accent: '#c8aa6e', accent2: '#0ac8b9' },
  { match: /apex legends/, accent: '#da292a', accent2: '#8e1b1b' },
  { match: /fortnite/, accent: '#9d4dff', accent2: '#2cc1ff' },
  { match: /baldur'?s gate/, accent: '#c99a5b', accent2: '#6b2a2a' },
  { match: /elden ring/, accent: '#d6b56a', accent2: '#5a4a2a' },
  { match: /deep rock galactic/, accent: '#ffb000', accent2: '#4a3a1a' },
  { match: /lethal company/, accent: '#ff5a3c', accent2: '#3b3b3b' },
  { match: /phasmophobia/, accent: '#7fd3c7', accent2: '#2a3a4a' },
  { match: /rust$|^rust\b/, accent: '#ce422b', accent2: '#5a3a2a' },
  { match: /gta|grand theft auto/, accent: '#5fbf4a', accent2: '#e6c34a' },
  { match: /the finals/, accent: '#ff2e63', accent2: '#ffd400' },
  { match: /rocket league/, accent: '#1f8bff', accent2: '#ff8a1f' },
  { match: /terraria/, accent: '#5ec26a', accent2: '#3a7bd5' },
  { match: /stardew/, accent: '#7cc46b', accent2: '#e6a84a' },
  { match: /powerwash/, accent: '#3fc5ff', accent2: '#2a6cff' },
  { match: /world of warcraft|warcraft/, accent: '#f8b700', accent2: '#2a5ab3' },
  { match: /overwatch/, accent: '#fa9c1e', accent2: '#4a90e2' },
  { match: /pubg|battlegrounds/, accent: '#f2a900', accent2: '#3a3a3a' },
  { match: /sea of thieves/, accent: '#2fb7a6', accent2: '#c9a24a' },
  { match: /among us/, accent: '#ff3b3b', accent2: '#3bd1ff' },
];

export function normalizeGameName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ™®©]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** FNV-1a 32-bit: small, fast and stable across platforms. */
export function hashString(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function hsl(h: number, s: number, l: number): string {
  return `hsl(${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%)`;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const cache = new Map<string, GameTheme>();

export function gameTheme(name: string): GameTheme {
  const key = normalizeGameName(name);
  const hit = cache.get(key);
  if (hit) return hit;
  let theme: GameTheme;
  const curated = CURATED.find((c) => c.match.test(key));
  if (curated) {
    const [r, g, b] = hexToRgb(curated.accent);
    theme = { accent: curated.accent, accent2: curated.accent2, soft: `rgba(${r}, ${g}, ${b}, 0.14)`, curated: true };
  } else {
    const h = hashString(key);
    const hue = h % 360;
    // Second hue 30..70 degrees away, saturation / lightness in a readable band.
    const hue2 = (hue + 30 + ((h >>> 9) % 41)) % 360;
    const sat = 62 + ((h >>> 17) % 22);
    const light = 62 + ((h >>> 24) % 10);
    theme = {
      accent: hsl(hue, sat, light),
      accent2: hsl(hue2, sat - 10, light - 18),
      soft: `hsl(${hue} ${sat}% ${light}% / 0.14)`,
      curated: false,
    };
  }
  cache.set(key, theme);
  return theme;
}

/** CSS custom properties for an element showing this game. */
export function gameThemeStyle(name: string): Record<string, string> {
  const t = gameTheme(name);
  return { '--game-accent': t.accent, '--game-accent-2': t.accent2, '--game-soft': t.soft };
}
