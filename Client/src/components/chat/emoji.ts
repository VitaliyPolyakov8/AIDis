/**
 * Emoji data for the picker: Unicode emoji from emojibase-data (labels and keywords in the UI
 * language), loaded lazily as a separate chunk the first time the picker opens. Recently used emoji
 * are kept per device in localStorage. The `Emoji` shape has room for custom (server) emoji later:
 * a picker entry is either `unicode` text or, in the future, an image with a `:shortcode:`.
 */
export interface Emoji {
  /** Text inserted into the message (native Unicode emoji). */
  unicode: string;
  label: string;
  tags: string[];
  group: number;
}

export interface EmojiGroup {
  id: number;
  /** Representative emoji for the category tab. */
  icon: string;
  key: 'smileys' | 'people' | 'animals' | 'food' | 'travel' | 'activities' | 'objects' | 'symbols' | 'flags';
}

/** emojibase group ids (2 = skin-tone components, not shown). */
export const EMOJI_GROUPS: EmojiGroup[] = [
  { id: 0, icon: '😀', key: 'smileys' },
  { id: 1, icon: '👋', key: 'people' },
  { id: 3, icon: '🐱', key: 'animals' },
  { id: 4, icon: '🍕', key: 'food' },
  { id: 5, icon: '✈️', key: 'travel' },
  { id: 6, icon: '⚽', key: 'activities' },
  { id: 7, icon: '💡', key: 'objects' },
  { id: 8, icon: '❤️', key: 'symbols' },
  { id: 9, icon: '🏁', key: 'flags' },
];

interface CompactEmoji {
  unicode: string;
  label: string;
  tags?: string[];
  group?: number;
  order?: number;
}

const cache = new Map<string, Promise<Emoji[]>>();

export function loadEmoji(language: 'ru' | 'en'): Promise<Emoji[]> {
  let promise = cache.get(language);
  if (!promise) {
    const data = language === 'ru' ? import('emojibase-data/ru/compact.json') : import('emojibase-data/en/compact.json');
    promise = data.then((mod) =>
      (mod.default as CompactEmoji[])
        .filter((e) => e.group !== undefined && e.group !== 2 && e.order !== undefined)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map((e) => ({ unicode: e.unicode, label: e.label, tags: e.tags ?? [], group: e.group ?? 0 })),
    );
    cache.set(language, promise);
  }
  return promise;
}

export function searchEmoji(list: Emoji[], query: string, limit = 120): Emoji[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const starts: Emoji[] = [];
  const contains: Emoji[] = [];
  for (const e of list) {
    const label = e.label.toLowerCase();
    if (label.startsWith(q) || e.tags.some((t) => t.toLowerCase().startsWith(q))) starts.push(e);
    else if (label.includes(q)) contains.push(e);
    if (starts.length >= limit) break;
  }
  return [...starts, ...contains].slice(0, limit);
}

const RECENT_KEY = 'aidis.recentEmoji';
const RECENT_MAX = 24;

export function recentEmoji(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string' && x.length <= 16).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

export function rememberEmoji(unicode: string): void {
  const next = [unicode, ...recentEmoji().filter((e) => e !== unicode)].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable: recent list stays in this session only */
  }
}

/** Inserts text at the caret (replacing a selection); returns the new value and caret position. */
export function insertAtCaret(value: string, start: number, end: number, insert: string): { value: string; caret: number } {
  const s = Math.max(0, Math.min(start, value.length));
  const e = Math.max(s, Math.min(end, value.length));
  return { value: value.slice(0, s) + insert + value.slice(e), caret: s + insert.length };
}
