/**
 * 0.4.1 game artwork from Steam's own CDN (official store images, no API key, no proxy):
 *
 * - header  460x215  (profile activity card, stream suggestion)
 * - capsule 231x87   (small art)
 *
 * Newer games keep their images under store_item_assets; both locations are tried. 0.5.2: the
 * newest games only have hashed paths (".../apps/<id>/<hash>/header.jpg"); when both fixed paths
 * fail, the server looks the real URLs up in the Steam store (resolveSteamArt) and they become the
 * third candidate. What worked is cached per AppID in localStorage for a week; that nothing did is
 * remembered for 6 hours only (a temporary network error must not hide the art for a week). The
 * accent color sampled from the header is cached with it (computed once per AppID).
 */
import { metaApi } from '../api/meta';

const CDN = 'https://cdn.cloudflare.steamstatic.com/steam/apps';
const SHARED = 'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps';
const CACHE_KEY = 'aidis.steamArt';
const TTL_MS = 7 * 24 * 3600_000;
const FAIL_TTL_MS = 6 * 3600_000;
const MAX_ENTRIES = 300;

export type SteamArtKind = 'header' | 'capsule';

const FILES: Record<SteamArtKind, string> = { header: 'header.jpg', capsule: 'capsule_231x87.jpg' };

interface Entry {
  /** Index into the candidate list that loaded, or -1 when none did. */
  ok: Partial<Record<SteamArtKind, number>>;
  color?: string | null;
  /** 0.5.2: real URLs from the server's Steam lookup (null = Steam has none). */
  urls?: Partial<Record<SteamArtKind, string | null>>;
  at: number;
}

let memory: Record<string, Entry> | null = null;

function load(): Record<string, Entry> {
  if (memory) return memory;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    memory = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, Entry>) : {};
  } catch {
    memory = {};
  }
  const now = Date.now();
  for (const [id, value] of Object.entries(memory)) {
    const e = value as Partial<Entry> | null;
    if (!e || typeof e.at !== 'number' || now - e.at > TTL_MS) Reflect.deleteProperty(memory, id);
  }
  return memory;
}

function save(): void {
  if (!memory) return;
  const entries = Object.entries(memory).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_ENTRIES);
  memory = Object.fromEntries(entries);
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(memory));
  } catch {
    /* storage full / blocked: memory cache only */
  }
}

function entry(appId: number): Entry {
  const cache = load();
  const key = String(appId);
  cache[key] ??= { ok: {}, at: Date.now() };
  return cache[key];
}

export function isSteamAppId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 100_000_000;
}

/** Candidate URLs in the order they are tried (the looked-up one last, once known). */
export function steamArtCandidates(appId: number, kind: SteamArtKind): string[] {
  const file = FILES[kind];
  const resolved = load()[String(appId)]?.urls?.[kind];
  return [`${CDN}/${String(appId)}/${file}`, `${SHARED}/${String(appId)}/${file}`, ...(resolved ? [resolved] : [])];
}

/** The URL to show now: the cached working one, the first candidate when unknown, null when none works. */
export function steamArtUrl(appId: number, kind: SteamArtKind): string | null {
  const e = load()[String(appId)];
  let known = e?.ok[kind];
  // "Nothing works" expires sooner than a working URL.
  if (e && known === -1 && Date.now() - e.at > FAIL_TTL_MS) {
    Reflect.deleteProperty(e.ok, kind);
    known = undefined;
  }
  const candidates = steamArtCandidates(appId, kind);
  if (known === undefined) return candidates[0] ?? null;
  return known >= 0 ? (candidates[known] ?? null) : null;
}

const lookups = new Map<number, Promise<void>>();
/** URLs that failed to load in this session (never offered again by resolveSteamArt). */
const failedUrls = new Set<string>();

/**
 * 0.5.2: both fixed CDN paths failed: asks the server for the game's real image URLs (once per
 * AppID per session) and returns the one for `kind`, or null when Steam has none either.
 */
export async function resolveSteamArt(appId: number, kind: SteamArtKind): Promise<string | null> {
  const e = entry(appId);
  if (!e.urls) {
    let running = lookups.get(appId);
    if (!running) {
      running = metaApi
        .steamArt(appId)
        .then((art) => {
          const current = entry(appId);
          current.urls = { header: art.header, capsule: art.capsule };
          current.at = Date.now();
          save();
        })
        .catch(() => undefined);
      lookups.set(appId, running);
    }
    await running;
  }
  const url = entry(appId).urls?.[kind] ?? null;
  if (!url || failedUrls.has(url)) return null;
  const current = entry(appId);
  current.ok[kind] = steamArtCandidates(appId, kind).indexOf(url);
  save();
  return url;
}

/** An <img> failed: returns the next candidate, or null (and remembers that nothing works). */
export function steamArtFailed(appId: number, kind: SteamArtKind, failedUrl: string): string | null {
  failedUrls.add(failedUrl);
  const candidates = steamArtCandidates(appId, kind);
  const next = candidates.indexOf(failedUrl) + 1;
  const e = entry(appId);
  e.at = Date.now();
  if (next > 0 && next < candidates.length) {
    e.ok[kind] = next;
    save();
    return candidates[next] ?? null;
  }
  e.ok[kind] = -1;
  save();
  return null;
}

/** An <img> loaded: remember which candidate works. */
export function steamArtLoaded(appId: number, kind: SteamArtKind, url: string): void {
  const index = steamArtCandidates(appId, kind).indexOf(url);
  if (index < 0) return;
  const e = entry(appId);
  if (e.ok[kind] === index) return;
  e.ok[kind] = index;
  e.at = Date.now();
  save();
}

export function cachedSteamColor(appId: number): string | null | undefined {
  return load()[String(appId)]?.color;
}

/**
 * The header's dominant vivid color, sampled once on a tiny canvas and cached per AppID.
 * Needs Steam's CORS headers; if the image cannot be read, null is cached and the
 * deterministic game color is used instead.
 */
export function sampleSteamColor(appId: number): Promise<string | null> {
  const cached = cachedSteamColor(appId);
  if (cached !== undefined) return Promise.resolve(cached);
  const url = steamArtUrl(appId, 'header');
  if (!url || typeof document === 'undefined') return Promise.resolve(null);
  return sampleFrom(appId, url, true);
}

function sampleFrom(appId: number, url: string, mayResolve: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    const done = (color: string | null) => {
      const e = entry(appId);
      e.color = color;
      e.at = Date.now();
      save();
      resolve(color);
    };
    img.onload = () => {
      try {
        done(dominantColor(img));
      } catch {
        done(null);
      }
    };
    // 0.5.2: a 404 on the fixed path: try the looked-up URL before giving up on the color.
    img.onerror = () => {
      if (!mayResolve) {
        done(null);
        return;
      }
      void resolveSteamArt(appId, 'header').then((real) => (real && real !== url ? resolve(sampleFrom(appId, real, false)) : done(null)));
    };
    img.src = url;
  });
}

function dominantColor(img: HTMLImageElement): string | null {
  const size = 24;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, size, size);
  const data = ctx.getImageData(0, 0, size, size).data;
  return pickVivid(data);
}

/**
 * Picks a readable accent from RGBA pixels: buckets by hue, weights by saturation, ignores
 * near-black / near-white / grey pixels. Pure (unit-tested).
 */
export function pickVivid(data: ArrayLike<number>): string | null {
  const buckets = new Map<number, { w: number; r: number; g: number; b: number }>();
  for (let i = 0; i + 3 < data.length; i += 4) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 510;
    const s = max === min ? 0 : (max - min) / (255 - Math.abs(max + min - 255));
    if (s < 0.25 || l < 0.12 || l > 0.9) continue;
    let h: number;
    if (max === r) h = ((g - b) / (max - min) + 6) % 6;
    else if (max === g) h = (b - r) / (max - min) + 2;
    else h = (r - g) / (max - min) + 4;
    const key = Math.floor(h * 2); // 12 hue buckets
    const w = s * (1 - Math.abs(l - 0.5));
    const bucket = buckets.get(key) ?? { w: 0, r: 0, g: 0, b: 0 };
    bucket.w += w;
    bucket.r += r * w;
    bucket.g += g * w;
    bucket.b += b * w;
    buckets.set(key, bucket);
  }
  let best: { w: number; r: number; g: number; b: number } | null = null;
  for (const bucket of buckets.values()) if (!best || bucket.w > best.w) best = bucket;
  if (!best || best.w < 0.5) return null;
  let r = best.r / best.w;
  let g = best.g / best.w;
  let b = best.b / best.w;
  // Lift dark accents so they stay readable on the dark UI.
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (lum < 0.45) {
    const k = 0.45 / Math.max(lum, 0.05);
    r = Math.min(255, r * k);
    g = Math.min(255, g * k);
    b = Math.min(255, b * k);
  }
  const hex = (n: number) => Math.round(n).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** Tests. */
export function resetSteamArtCache(): void {
  memory = null;
  lookups.clear();
  failedUrls.clear();
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    /* ignore */
  }
}

// ---- 0.5.8: Steam id by game name ----------------------------------------------------------------

const ID_CACHE_KEY = 'aidis.steamIds';
const ID_TTL_MS = 7 * 24 * 3600_000;
const ID_FAIL_TTL_MS = 6 * 3600_000;
let idCache: Record<string, { id: number | null; at: number }> | null = null;
const idLookups = new Map<string, Promise<number | null>>();

function ids(): Record<string, { id: number | null; at: number }> {
  if (idCache) return idCache;
  try {
    idCache = JSON.parse(localStorage.getItem(ID_CACHE_KEY) ?? '{}') as Record<string, { id: number | null; at: number }>;
  } catch {
    idCache = {};
  }
  return idCache;
}

function nameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Steam id known for this game name without asking (undefined = not looked up yet). */
export function cachedSteamIdByName(name: string): number | null | undefined {
  const hit = ids()[nameKey(name)];
  if (!hit) return undefined;
  return Date.now() - hit.at < (hit.id ? ID_TTL_MS : ID_FAIL_TTL_MS) ? hit.id : undefined;
}

/**
 * 0.5.8: games found by their process (not started by Steam) come without a Steam id, so their
 * artwork never showed. The server finds the id by name (clear matches only); remembered a week.
 */
export async function resolveSteamIdByName(name: string): Promise<number | null> {
  const key = nameKey(name);
  if (key.length < 2) return null;
  const known = cachedSteamIdByName(name);
  if (known !== undefined) return known;
  let running = idLookups.get(key);
  if (!running) {
    running = metaApi.steamAppByName(name).then(
      ({ appId }) => {
        const all = ids();
        all[key] = { id: isSteamAppId(appId) ? appId : null, at: Date.now() };
        try {
          const entries = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, 300);
          localStorage.setItem(ID_CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
        } catch {
          // storage full or blocked: memory only
        }
        idLookups.delete(key);
        return all[key].id;
      },
      () => {
        idLookups.delete(key);
        return null;
      },
    );
    idLookups.set(key, running);
  }
  return running;
}
