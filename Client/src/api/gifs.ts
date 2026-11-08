import { request } from './client';
import type { GifResult } from './types';

export type GifProvider = GifResult['provider'];

export interface GifSearchResponse {
  /** False when the server has no GIF provider configured. */
  enabled: boolean;
  /** Only for attribution (e.g. "Search Tenor"). */
  provider: GifProvider | null;
  results: GifResult[];
  /** Next page to request, or null when there is no more (older servers omit it). */
  nextPage?: number | null;
}

/** Why a search failed, as the picker shows it. */
export type GifFailure = 'rateLimited' | 'unavailable';

/**
 * GIF search goes through the server (/api/v1/gifs: Tenor / GIPHY with the owner's key; off by default).
 */
interface GifSource {
  search(q: string, limit: number, page: number): Promise<GifSearchResponse>;
  registerShare(gif: GifResult, query: string): void;
}

const serverSource: GifSource = {
  search: (q, limit, page) => request(`/api/v1/gifs?q=${encodeURIComponent(q)}&limit=${limit}${page > 1 ? `&page=${page}` : ''}`),
  registerShare: () => undefined,
};

export function gifFailure(error: unknown): GifFailure {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'GIF_RATE_LIMITED' ? 'rateLimited' : 'unavailable';
}

export const gifsApi = {
  /** The provider is decided by the server (GIF_PROVIDER in its .env). */
  clientProvider(): GifProvider | null {
    return null;
  },
  /** Empty query = trending. Only the query text (and paging) reaches the provider. */
  search(q: string, limit = 24, page = 1): Promise<GifSearchResponse> {
    return serverSource.search(q, limit, page);
  },
  /** Kept for the picker: server providers need no share analytics. */
  registerShare(_gif: GifResult, _query: string): void {},
};
