import { request } from '../api/client';
import type { GamePlatform, GameStatus, GameView } from '../api/types';

export interface GameInput {
  name: string;
  platform: GamePlatform;
  status: GameStatus;
  coverAttachmentId: string | null;
}

/** Game tracker API. */
export const gamesApi = {
  list: (userId: string) => request<{ games: GameView[]; hidden: boolean }>(`/api/v1/users/${encodeURIComponent(userId)}/games`),
  add: async (input: GameInput): Promise<GameView> => (await request<{ game: GameView }>('/api/v1/users/me/games', { method: 'POST', body: input })).game,
  update: async (id: string, patch: Partial<GameInput>): Promise<GameView> => (await request<{ game: GameView }>(`/api/v1/users/me/games/${id}`, { method: 'PATCH', body: patch })).game,
  remove: async (id: string): Promise<void> => {
    await request(`/api/v1/users/me/games/${id}`, { method: 'DELETE' });
  },
  prompts: () => request<{ games: GameView[] }>('/api/v1/users/me/games/prompts'),
  prompted: async (id: string): Promise<void> => {
    await request(`/api/v1/users/me/games/${id}/prompted`, { method: 'POST' });
  },
};
