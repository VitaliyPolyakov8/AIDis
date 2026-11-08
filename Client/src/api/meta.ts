import { request } from './client';
import type { ReleaseInfo } from './types';

export const metaApi = {
  /** Public desktop release metadata (the web client itself is always current). */
  desktopRelease(): Promise<ReleaseInfo> {
    return request('/api/v1/client/version', { auth: false, timeoutMs: 8_000 });
  },
  /** 0.5.2: a game's real Steam artwork URLs (newer games use hashed paths clients cannot guess). */
  /** 0.5.8: Steam id of a game by name (null = no clear match). */
  steamAppByName(name: string): Promise<{ appId: number | null }> {
    return request('/api/v1/steam/app-by-name', { query: { name } });
  },
  steamArt(appId: number): Promise<{ appId: number; header: string | null; capsule: string | null }> {
    return request(`/api/v1/steam/apps/${String(appId)}/art`, { timeoutMs: 10_000 });
  },
};
