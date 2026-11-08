import { request } from '../api/client';
import type { SoundView } from '../api/types';

export const MAX_SOUND_BYTES = 512 * 1024;
export const MAX_SOUND_SECONDS = 5;
export const SOUND_TYPES = ['audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave'];

/** 0.7.1 server soundboard. */
export const soundsApi = {
  list: (guildId: string) => request<{ sounds: SoundView[] }>(`/api/v1/guilds/${encodeURIComponent(guildId)}/sounds`),
  create: (guildId: string, meta: { name: string; emoji: string | null; volume: number }, file: File) => {
    const query = new URLSearchParams({ name: meta.name, volume: String(meta.volume), ...(meta.emoji ? { emoji: meta.emoji } : {}) });
    return request<{ sound: SoundView }>(`/api/v1/guilds/${encodeURIComponent(guildId)}/sounds?${query.toString()}`, {
      method: 'POST',
      body: new Blob([file], { type: 'application/octet-stream' }),
    });
  },
  update: (id: string, patch: { name?: string; emoji?: string | null; volume?: number }) => request<{ sound: SoundView }>(`/api/v1/sounds/${id}`, { method: 'PATCH', body: patch }),
  remove: async (id: string): Promise<void> => {
    await request(`/api/v1/sounds/${id}`, { method: 'DELETE' });
  },
};
