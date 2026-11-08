import { z } from 'zod';
import type { GifEmbed } from './embeds.js';
import { cleanText } from './metadata.js';
import { FetchBlockedError, safeFetch } from './safe-fetch.js';

/**
 * Server-backed GIF search (Tenor, GIPHY). The provider API key lives only in the server's .env
 * (GIF_PROVIDER + GIF_API_KEY), never in the client bundle, Socket.IO or logs. The provider
 * receives only the search text (plus the key, a locale and paging): no user names, ids, tokens,
 * messages or voice state.
 *
 * KLIPY is client-backed instead: its standard integration requires API requests and media loads
 * to come from the end-user app, so the server never calls KLIPY. It only accepts KLIPY GIFs that
 * users send (validateGif) and stores their media URLs exactly as KLIPY returned them.
 */
export const SERVER_GIF_PROVIDERS = ['tenor', 'giphy'] as const;
export type ServerGifProviderName = (typeof SERVER_GIF_PROVIDERS)[number];
/** Every provider a sent GIF may come from. */
export const GIF_PROVIDERS = ['klipy', ...SERVER_GIF_PROVIDERS] as const;
export type GifProviderName = (typeof GIF_PROVIDERS)[number];

export interface GifResult {
  provider: ServerGifProviderName;
  id: string;
  url: string;
  title: string | null;
  media: { url: string; width: number; height: number };
  preview: { url: string; width: number; height: number };
}

export interface GifPage {
  results: GifResult[];
  /** Next page number when the provider has more results (GIPHY), else null. */
  nextPage: number | null;
}

/** Why a provider call failed, as far as clients are concerned (never contains provider details). */
export type GifErrorKind = 'rate_limited' | 'unavailable';

export class GifProviderError extends Error {
  constructor(
    readonly kind: GifErrorKind,
    /** Safe for logs: never contains the key or the request URL. */
    readonly reason: string,
  ) {
    super(reason);
  }
}

interface GifProvider {
  search(query: string, limit: number, page: number): Promise<GifPage>;
  trending(limit: number, page: number): Promise<GifPage>;
}

/** Hosts each provider serves media / pages from (sent GIFs are checked against these). */
export const GIF_MEDIA_HOSTS: Record<GifProviderName, RegExp> = {
  klipy: /^static\d*\.klipy\.com$/,
  tenor: /^(media\d*\.tenor\.com|c\.tenor\.com)$/,
  giphy: /^(media\d*\.giphy\.com|i\.giphy\.com)$/,
};
const GIF_PAGE_HOSTS: Record<GifProviderName, RegExp> = {
  klipy: /^(www\.)?klipy\.com$/,
  tenor: /^(www\.)?tenor\.com$/,
  giphy: /^(www\.)?giphy\.com$/,
};

/**
 * KLIPY's integration rules require its media to be loaded directly from the URLs it returns
 * (unchanged, not re-hosted, proxied or rewritten). Stored KLIPY GIFs are therefore shown straight
 * from static*.klipy.com; Tenor / GIPHY media keep going through the AIDis image proxy.
 */
export function loadsMediaDirectly(provider: GifProviderName): boolean {
  return provider === 'klipy';
}

type Fetch = typeof safeFetch;

/** One JSON request to a provider; every failure becomes a GifProviderError without the URL/key. */
async function getJson(fetcher: Fetch, url: string): Promise<Record<string, unknown>> {
  let res;
  try {
    res = await fetcher(url, { accept: ['application/json'], maxBytes: 2 * 1024 * 1024, timeoutMs: 6000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'error';
    if (/^HTTP 429\b/.test(message)) throw new GifProviderError('rate_limited', 'provider rate limit (HTTP 429)');
    if (/^HTTP (401|403)\b/.test(message)) throw new GifProviderError('unavailable', 'provider rejected the API key');
    if (/^HTTP \d+/.test(message)) throw new GifProviderError('unavailable', `provider ${message}`);
    if (message === 'timeout') throw new GifProviderError('unavailable', 'provider timeout');
    if (error instanceof FetchBlockedError) throw new GifProviderError('unavailable', `request blocked (${message})`);
    throw new GifProviderError('unavailable', /timeout|ETIMEDOUT/i.test(message) ? 'provider timeout' : 'provider unreachable');
  }
  try {
    const body = JSON.parse(res.body.toString('utf8')) as unknown;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('not an object');
    return body as Record<string, unknown>;
  } catch {
    throw new GifProviderError('unavailable', 'invalid provider response');
  }
}

type Media = { url?: unknown; dims?: unknown; width?: unknown; height?: unknown };

function dims(m: Media | undefined): { url: string; width: number; height: number } | null {
  if (!m || typeof m.url !== 'string' || !m.url.startsWith('https://')) return null;
  const pair = Array.isArray(m.dims) ? (m.dims as unknown[]) : [];
  const width = Number(pair[0] ?? m.width);
  const height = Number(pair[1] ?? m.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { url: m.url, width: Math.round(width), height: Math.round(height) };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Tenor API v2 (Google). Paging is token based; only the first page is offered. */
function tenor(key: string, locale: string, fetcher: Fetch): GifProvider {
  const map = (body: Record<string, unknown>): GifPage => ({
    nextPage: null,
    results: ((Array.isArray(body.results) ? body.results : []) as unknown[]).flatMap((r): GifResult[] => {
      if (!isRecord(r) || typeof r.id !== 'string') return [];
      const formats = (isRecord(r.media_formats) ? r.media_formats : {}) as Record<string, Media>;
      const media = dims(formats.gif) ?? dims(formats.mediumgif);
      const preview = dims(formats.tinygif) ?? media;
      if (!media || !preview) return [];
      return [{ provider: 'tenor', id: r.id, url: typeof r.itemurl === 'string' ? r.itemurl : `https://tenor.com/view/${r.id}`, title: cleanText(typeof r.content_description === 'string' ? r.content_description : null, 200), media, preview }];
    }),
  });
  const base = `key=${encodeURIComponent(key)}&client_key=aidis&media_filter=gif,mediumgif,tinygif&contentfilter=medium&locale=${encodeURIComponent(locale)}`;
  return {
    search: async (q, limit) => map(await getJson(fetcher, `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(q)}&limit=${limit}&${base}`)),
    trending: async (limit) => map(await getJson(fetcher, `https://tenor.googleapis.com/v2/featured?limit=${limit}&${base}`)),
  };
}

/** GIPHY API v1 (offset paging). */
function giphy(key: string, locale: string, fetcher: Fetch): GifProvider {
  const map = (body: Record<string, unknown>, limit: number, page: number): GifPage => {
    const results = ((Array.isArray(body.data) ? body.data : []) as unknown[]).flatMap((r): GifResult[] => {
      if (!isRecord(r) || typeof r.id !== 'string') return [];
      const images = (isRecord(r.images) ? r.images : {}) as Record<string, Media>;
      const media = dims(images.downsized_medium) ?? dims(images.original);
      const preview = dims(images.fixed_width) ?? media;
      if (!media || !preview) return [];
      return [{ provider: 'giphy', id: r.id, url: typeof r.url === 'string' ? r.url : `https://giphy.com/gifs/${r.id}`, title: cleanText(typeof r.title === 'string' ? r.title : null, 200), media, preview }];
    });
    const pagination = isRecord(body.pagination) ? body.pagination : {};
    const total = Number(pagination.total_count);
    return { results, nextPage: Number.isFinite(total) && page * limit < total ? page + 1 : null };
  };
  const lang = locale.slice(0, 2);
  const base = `api_key=${encodeURIComponent(key)}&rating=pg-13&lang=${encodeURIComponent(lang)}`;
  return {
    search: async (q, limit, page) => map(await getJson(fetcher, `https://api.giphy.com/v1/gifs/search?q=${encodeURIComponent(q)}&limit=${limit}&offset=${(page - 1) * limit}&${base}`), limit, page),
    trending: async (limit, page) => map(await getJson(fetcher, `https://api.giphy.com/v1/gifs/trending?limit=${limit}&offset=${(page - 1) * limit}&${base}`), limit, page),
  };
}

export class GifService {
  private readonly provider: GifProvider | null;
  private readonly cache = new Map<string, { at: number; page: GifPage }>();

  constructor(
    readonly providerName: ServerGifProviderName | 'none',
    apiKey: string,
    locale: string,
    fetcher: Fetch = safeFetch,
  ) {
    if (!apiKey) this.provider = null;
    else if (providerName === 'tenor') this.provider = tenor(apiKey, locale, fetcher);
    else if (providerName === 'giphy') this.provider = giphy(apiKey, locale, fetcher);
    else this.provider = null;
  }

  get enabled(): boolean {
    return this.provider !== null;
  }

  /** Search (or trending when the query is empty). Cached 10 minutes per query and page. */
  async search(query: string, limit = 24, page = 1): Promise<GifPage> {
    if (!this.provider) return { results: [], nextPage: null };
    const q = query.trim().slice(0, 100);
    const key = `${q}|${limit}|${page}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.page;
    const result = q ? await this.provider.search(q, limit, page) : await this.provider.trending(limit, page);
    if (this.cache.size > 200) this.cache.clear();
    this.cache.set(key, { at: Date.now(), page: result });
    return result;
  }
}

/** A GIF chosen by the client, checked before it is stored with a message. */
export const gifInputSchema = z.object({
  provider: z.enum(GIF_PROVIDERS),
  id: z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/),
  url: z.url().max(2048),
  title: z.string().max(200).nullable().optional(),
  media: z.object({ url: z.url().max(2048), width: z.number().int().min(1).max(4096), height: z.number().int().min(1).max(4096) }),
  preview: z.object({ url: z.url().max(2048), width: z.number().int().min(1).max(4096), height: z.number().int().min(1).max(4096) }).nullable().optional(),
});

/**
 * Only https URLs on the provider's own media / page hosts are accepted. Tenor / GIPHY GIFs must
 * come from the provider this server has configured; KLIPY GIFs come from the client-side KLIPY
 * integration and are accepted on their own (KLIPY hosts only). URLs are stored exactly as sent.
 */
export function validateGif(input: z.infer<typeof gifInputSchema>, serverProvider: ServerGifProviderName | 'none'): GifEmbed | null {
  if (input.provider !== 'klipy' && input.provider !== serverProvider) return null;
  const ok = (raw: string, hosts: RegExp) => {
    try {
      const u = new URL(raw);
      return u.protocol === 'https:' && !u.port && hosts.test(u.hostname.toLowerCase());
    } catch {
      return false;
    }
  };
  if (!ok(input.media.url, GIF_MEDIA_HOSTS[input.provider])) return null;
  if (input.preview && !ok(input.preview.url, GIF_MEDIA_HOSTS[input.provider])) return null;
  if (!ok(input.url, GIF_PAGE_HOSTS[input.provider])) return null;
  return {
    type: 'gif',
    provider: input.provider,
    id: input.id,
    url: input.url,
    title: cleanText(input.title ?? null, 200),
    media: input.media,
    preview: input.preview ?? null,
  };
}
