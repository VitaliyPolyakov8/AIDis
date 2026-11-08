import { request } from './client';
import type { FriendsState } from './types';

/** 0.7.0 friends (DMs are between friends). */
export const friendsApi = {
  state(): Promise<FriendsState> {
    return request('/api/v1/friends');
  },
  request(username: string): Promise<{ status: 'sent' | 'accepted' }> {
    return request('/api/v1/friends/requests', { method: 'POST', body: { username } });
  },
  accept(userId: string): Promise<void> {
    return request(`/api/v1/friends/requests/${encodeURIComponent(userId)}/accept`, { method: 'POST' });
  },
  /** Declines an incoming request or cancels an outgoing one. */
  decline(userId: string): Promise<void> {
    return request(`/api/v1/friends/requests/${encodeURIComponent(userId)}`, { method: 'DELETE' });
  },
  remove(userId: string): Promise<void> {
    return request(`/api/v1/friends/${encodeURIComponent(userId)}`, { method: 'DELETE' });
  },
};
