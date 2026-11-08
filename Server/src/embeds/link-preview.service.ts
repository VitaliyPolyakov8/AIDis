import type { FastifyBaseLogger } from 'fastify';
import type { LinkEmbed } from './embeds.js';
import { absoluteUrl, cleanText, decodeHtml, extractUrls, parseMetadata, steamAppId, youtubeVideoId } from './metadata.js';
import { safeFetch, type SafeFetchOptions } from './safe-fetch.js';

export interface LinkPreviewOptions {
  enabled: boolean;
  /** Steam store country / language for prices and descriptions. */
  steamCountry: string;
  steamLanguage: string;
  /** Test hook. */
  fetcher?: typeof safeFetch;
  resolve?: SafeFetchOptions['resolve'];
}

const CACHE_LIMIT = 500;
const OK_TTL_MS = 6 * 60 * 60 * 1000;
const FAIL_TTL_MS = 30 * 60 * 1000;

const ART_TTL_MS = 24 * 60 * 60 * 1000;

interface CacheEntry {
  embed: LinkEmbed | null;
  expires: number;
}

export interface SteamArt {
  header: string | null;
  capsule: string | null;
}

const STEAM_IMAGE_HOSTS = new Set(['cdn.cloudflare.steamstatic.com', 'shared.cloudflare.steamstatic.com', 'cdn.akamai.steamstatic.com', 'shared.akamai.steamstatic.com']);

/** An https image URL on Steam's CDN, or null. */
function steamImage(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 500) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && STEAM_IMAGE_HOSTS.has(url.hostname) ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Link previews, server side only (consistent result, no CORS, clients' IPs are not exposed to the
 * linked sites, central SSRF protection and caching). Only the FIRST eligible link of a message gets
 * a card, so a message full of links does not become a wall of previews.
 *
 * Results are cached in memory (6 h, failures 30 min, at most 500 URLs). Previews are best effort:
 * a slow or failing site never blocks or fails sending the message.
 */
export class LinkPreviewService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, Promise<LinkEmbed | null>>();
  private readonly artCache = new Map<string, { art: SteamArt | null; expires: number }>();
  private readonly artPending = new Map<string, Promise<SteamArt | null>>();
  /** 0.5.8: normalized game name -> Steam id (null = no clear match). */
  private readonly nameCache = new Map<string, { appId: number | null; expires: number }>();
  private readonly fetcher: typeof safeFetch;

  constructor(
    private readonly options: LinkPreviewOptions,
    private readonly log: FastifyBaseLogger,
  ) {
    this.fetcher = options.fetcher ?? safeFetch;
  }

  get enabled(): boolean {
    return this.options.enabled;
  }

  /** The URL that will get a preview card, if any. */
  firstUrl(text: string): string | null {
    return extractUrls(text)[0] ?? null;
  }

  async preview(url: string): Promise<LinkEmbed | null> {
    if (!this.options.enabled) return null;
    const cached = this.cache.get(url);
    if (cached && cached.expires > Date.now()) return cached.embed;
    const running = this.pending.get(url);
    if (running) return running;
    const task = this.build(url)
      .catch((error: unknown) => {
        this.log.info({ event: 'link_preview.failed', host: hostOf(url), reason: error instanceof Error ? error.message : 'error' }, 'Link preview failed');
        return null;
      })
      .then((embed) => {
        this.remember(url, embed);
        this.pending.delete(url);
        return embed;
      });
    this.pending.set(url, task);
    return task;
  }

  /**
   * 0.5.2: a game's real Steam artwork URLs (header 460x215, capsule 231x87) for activity cards.
   * Newer games only have hashed asset paths (".../apps/<id>/<hash>/header.jpg"), so the fixed CDN
   * paths the clients try first return 404 for them; the store's appdetails names the real ones.
   * Only https URLs on Steam's image CDNs are returned (they are what the clients' CSP allows).
   * Not tied to LINK_PREVIEWS: one fixed, public Steam endpoint, cached (24 h, failures 30 min).
   */
  async steamArt(appId: number): Promise<SteamArt | null> {
    const key = String(appId);
    const cached = this.artCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.art;
    const running = this.artPending.get(key);
    if (running) return running;
    const task = (async () => {
      const body = (await this.json(`https://store.steampowered.com/api/appdetails?appids=${key}&filters=basic`)) as Record<string, { success?: boolean; data?: Record<string, unknown> }>;
      const d = body[key]?.success ? body[key].data : undefined;
      if (!d) return null;
      const art = { header: steamImage(d.header_image), capsule: steamImage(d.capsule_image) };
      return art.header || art.capsule ? art : null;
    })()
      .catch((error: unknown) => {
        this.log.info({ event: 'steam_art.failed', appId, reason: error instanceof Error ? error.message : 'error' }, 'Steam art lookup failed');
        return null;
      })
      .then((art) => {
        if (this.artCache.size >= CACHE_LIMIT) {
          const oldest = this.artCache.keys().next().value;
          if (oldest !== undefined) this.artCache.delete(oldest);
        }
        this.artCache.set(key, { art, expires: Date.now() + (art ? ART_TTL_MS : FAIL_TTL_MS) });
        this.artPending.delete(key);
        return art;
      });
    this.artPending.set(key, task);
    return task;
  }

  /**
   * 0.5.8: Steam id of a game by its name (Steam store search), for activities and "recently
   * played" entries that came without one (games found by their process). Only a clear match
   * counts: the same name ignoring case, marks and punctuation.
   */
  async steamAppIdByName(name: string): Promise<number | null> {
    const wanted = normalizeGameName(name);
    if (wanted.length < 2) return null;
    const cached = this.nameCache.get(wanted);
    if (cached && cached.expires > Date.now()) return cached.appId;
    const appId = await (async () => {
      const body = (await this.json(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(name.slice(0, 100))}&cc=${this.options.steamCountry}&l=english`)) as { items?: { id?: unknown; name?: unknown }[] };
      for (const item of (body.items ?? []).slice(0, 10)) {
        if (typeof item.id === 'number' && typeof item.name === 'string' && normalizeGameName(item.name) === wanted) return item.id;
      }
      return null;
    })().catch((error: unknown) => {
      this.log.info({ event: 'steam_search.failed', reason: error instanceof Error ? error.message : 'error' }, 'Steam app search failed');
      return undefined;
    });
    if (this.nameCache.size >= CACHE_LIMIT) {
      const oldest = this.nameCache.keys().next().value;
      if (oldest !== undefined) this.nameCache.delete(oldest);
    }
    // A failed request is retried sooner than a clear "no such game".
    this.nameCache.set(wanted, { appId: appId ?? null, expires: Date.now() + (appId === undefined ? FAIL_TTL_MS : ART_TTL_MS) });
    return appId ?? null;
  }

  private remember(url: string, embed: LinkEmbed | null): void {
    if (this.cache.size >= CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(url, { embed, expires: Date.now() + (embed ? OK_TTL_MS : FAIL_TTL_MS) });
  }

  private async json(url: string): Promise<unknown> {
    const res = await this.fetcher(url, { accept: ['application/json', 'text/javascript'], maxBytes: 512 * 1024, resolve: this.options.resolve });
    return JSON.parse(res.body.toString('utf8')) as unknown;
  }

  private async build(url: string): Promise<LinkEmbed | null> {
    const video = youtubeVideoId(url);
    if (video) return this.youtube(url, video);
    const app = steamAppId(url);
    if (app) return this.steam(url, app);
    return this.website(url);
  }

  /** YouTube's official oEmbed endpoint (no API key, no page scraping). */
  private async youtube(url: string, id: string): Promise<LinkEmbed | null> {
    const watch = `https://www.youtube.com/watch?v=${id}`;
    const data = (await this.json(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watch)}`)) as Record<string, unknown>;
    const title = cleanText(typeof data.title === 'string' ? data.title : null, 200);
    if (!title) return null;
    const thumb = absoluteUrl(typeof data.thumbnail_url === 'string' ? data.thumbnail_url : `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, watch);
    return {
      type: 'link',
      provider: 'youtube',
      url,
      siteName: 'YouTube',
      title,
      description: null,
      image: thumb ? { url: thumb, width: num(data.thumbnail_width), height: num(data.thumbnail_height) } : null,
      author: cleanText(typeof data.author_name === 'string' ? data.author_name : null, 100),
      price: null,
      free: false,
    };
  }

  /**
   * Steam's public store endpoint (appdetails): name, short description, header image, price.
   * Games that are not sold in the configured country (e.g. some titles in the RU store) come back
   * as "success: false"; then the card is built from the US store WITHOUT a price (a foreign price
   * would be misleading). Nothing is guessed.
   */
  private async steam(url: string, appId: string): Promise<LinkEmbed | null> {
    const { steamCountry, steamLanguage } = this.options;
    const fetchDetails = async (cc: string, lang: string) => {
      const body = (await this.json(
        `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=${encodeURIComponent(cc)}&l=${encodeURIComponent(lang)}`,
      )) as Record<string, { success?: boolean; data?: Record<string, unknown> }>;
      const entry = body[appId];
      return entry?.success && entry.data ? entry.data : null;
    };
    let d = await fetchDetails(steamCountry, steamLanguage);
    let priceTrusted = true;
    if (!d && steamCountry !== 'us') {
      d = await fetchDetails('us', steamLanguage);
      priceTrusted = false;
    }
    if (!d) return null;
    const price = d.price_overview as { final_formatted?: unknown } | undefined;
    const image = absoluteUrl(typeof d.header_image === 'string' ? d.header_image : null, url);
    return {
      type: 'link',
      provider: 'steam',
      url,
      siteName: 'Steam',
      title: cleanText(typeof d.name === 'string' ? d.name : null, 200),
      description: cleanText(typeof d.short_description === 'string' ? d.short_description : null, 350),
      image: image ? { url: image, width: 460, height: 215 } : null,
      author: null,
      price: priceTrusted && typeof price?.final_formatted === 'string' ? cleanText(price.final_formatted, 40) : null,
      free: d.is_free === true,
    };
  }

  /** Any page: Open Graph / meta tags from the <head> only (max 512 KB, stops at </head>). */
  private async website(url: string): Promise<LinkEmbed | null> {
    const res = await this.fetcher(url, {
      accept: ['text/html', 'application/xhtml+xml'],
      maxBytes: 512 * 1024,
      stopAt: '</head>',
      resolve: this.options.resolve,
    });
    const meta = parseMetadata(decodeHtml(res.body, res.contentType), res.url);
    if (!meta.title && !meta.description) return null;
    return {
      type: 'link',
      provider: 'website',
      url,
      siteName: meta.siteName ?? hostOf(res.url),
      title: meta.title,
      description: meta.description,
      image: meta.image ? { url: meta.image, width: null, height: null } : null,
      author: null,
      price: null,
      free: false,
    };
  }
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Lower-case name without marks and punctuation ("HADES™" and "Hades" are the same game). */
export function normalizeGameName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
