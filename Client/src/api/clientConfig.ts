import { create } from 'zustand';
import { request } from './client';

/** GET /api/v1/client/config: what the server tells clients before anyone logs in. */
export interface ClientConfig {
  server: { name: string; version: string };
  livekitUrl: string;
  voiceNodeDomain: string;
  gifs: 'none' | 'tenor' | 'giphy';
  steamArt: boolean;
  desktop: { latestVersion: string; minimumVersion: string; updateMirrorUrl: string | null };
}

interface ServerConfigState {
  /** Game covers from the Steam store (off until the server says otherwise: no requests to Steam). */
  steamArt: boolean;
  /** Extra voice servers must be subdomains of this (empty until loaded). */
  voiceNodeDomain: string;
  loaded: boolean;
  load: () => Promise<void>;
}

export const clientConfigApi = {
  get: () => request<ClientConfig>('/api/v1/client/config', { auth: false, timeoutMs: 8_000 }),
};

export const useServerConfig = create<ServerConfigState>((set) => ({
  steamArt: false,
  voiceNodeDomain: '',
  loaded: false,
  load: async () => {
    try {
      const c = await clientConfigApi.get();
      set({ steamArt: c.steamArt, voiceNodeDomain: c.voiceNodeDomain || '', loaded: true });
    } catch {
      // An older server (no /client/config): the defaults stay.
      set({ loaded: true });
    }
  },
}));
