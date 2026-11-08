import { request } from '../api/client';
import type { ServerEmoji } from '../api/types';

/** 0.7.0: emojis of all my servers; uploads go to one server. */
export const emojisApi = {
  list: () => request<{ emojis: ServerEmoji[] }>('/api/v1/emojis'),
  create: (guildId: string, name: string, file: File) =>
    request<{ emoji: ServerEmoji }>(`/api/v1/guilds/${encodeURIComponent(guildId)}/emojis?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      body: new Blob([file], { type: 'application/octet-stream' }),
    }),
  rename: (id: string, name: string) => request<{ emoji: ServerEmoji }>(`/api/v1/emojis/${id}`, { method: 'PATCH', body: { name } }),
  remove: async (id: string): Promise<void> => {
    await request(`/api/v1/emojis/${id}`, { method: 'DELETE' });
  },
};
