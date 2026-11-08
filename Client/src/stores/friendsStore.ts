import { create } from 'zustand';
import { friendsApi } from '../api/friends';
import { friendlyError, isApiError } from '../api/errors';
import { t } from '../i18n';

/** 0.7.0 friends and friend requests (DMs are between friends). */
interface FriendsState {
  friendIds: string[];
  incoming: string[];
  outgoing: string[];
  loaded: boolean;
  load: () => Promise<void>;
  request: (username: string) => Promise<'sent' | 'accepted'>;
  accept: (userId: string) => Promise<void>;
  decline: (userId: string) => Promise<void>;
  remove: (userId: string) => Promise<void>;
  isFriend: (userId: string) => boolean;
  reset: () => void;
}

export const useFriendsStore = create<FriendsState>((set, get) => ({
  friendIds: [],
  incoming: [],
  outgoing: [],
  loaded: false,
  load: async () => {
    const state = await friendsApi.state();
    set({ friendIds: state.friends.map((f) => f.userId), incoming: state.incoming.map((r) => r.userId), outgoing: state.outgoing.map((r) => r.userId), loaded: true });
  },
  request: async (username) => {
    const { status } = await friendsApi.request(username.trim());
    await get().load();
    return status;
  },
  accept: async (userId) => {
    await friendsApi.accept(userId);
    await get().load();
  },
  decline: async (userId) => {
    await friendsApi.decline(userId);
    await get().load();
  },
  remove: async (userId) => {
    await friendsApi.remove(userId);
    await get().load();
  },
  isFriend: (userId) => get().friendIds.includes(userId),
  reset: () => set({ friendIds: [], incoming: [], outgoing: [], loaded: false }),
}));

/** Friend-specific wording for server error codes. */
export function friendsErrorText(error: unknown): string {
  if (isApiError(error)) {
    if (error.code === 'USER_NOT_FOUND') return t('friends.errors.notFound');
    if (error.code === 'ALREADY_FRIENDS') return t('friends.errors.already');
    if (error.code === 'SELF') return t('friends.errors.self');
  }
  return friendlyError(error, t('friends.errors.failed'));
}
