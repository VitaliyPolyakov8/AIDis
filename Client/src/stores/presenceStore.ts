import { create } from 'zustand';
import { usersApi } from '../api/users';
import type { PresenceView, PublicUser } from '../api/types';

interface PresenceState {
  users: Record<string, PublicUser>;
  presence: Record<string, PresenceView>;
  loaded: boolean;
  setUsers: (users: PublicUser[]) => void;
  upsertUser: (user: PublicUser) => void;
  applySnapshot: (presence: PresenceView[]) => void;
  applyPresence: (presence: PresenceView) => void;
  ensureUser: (userId: string) => void;
  reset: () => void;
}

const pending = new Set<string>();

export const usePresenceStore = create<PresenceState>((set, get) => ({
  users: {},
  presence: {},
  loaded: false,
  setUsers: (users) => set({ users: Object.fromEntries(users.map((u) => [u.id, u])), loaded: true }),
  upsertUser: (user) => set((s) => ({ users: { ...s.users, [user.id]: user } })),
  applySnapshot: (presence) => {
    set({ presence: Object.fromEntries(presence.map((p) => [p.userId, p])) });
    for (const p of presence) get().ensureUser(p.userId);
  },
  applyPresence: (p) => {
    // An update without lastSeenAt keeps the one we already know.
    set((s) => ({ presence: { ...s.presence, [p.userId]: { ...p, lastSeenAt: p.lastSeenAt ?? s.presence[p.userId]?.lastSeenAt ?? null } } }));
    get().ensureUser(p.userId);
  },
  /** Fetches a user we have not seen yet (e.g. an account created after we loaded the list). */
  ensureUser: (userId) => {
    if (!get().loaded || get().users[userId] || pending.has(userId)) return;
    pending.add(userId);
    usersApi
      .get(userId)
      .then(({ user }) => get().upsertUser(user))
      .catch(() => undefined)
      .finally(() => pending.delete(userId));
  },
  reset: () => set({ users: {}, presence: {}, loaded: false }),
}));

export function isOnline(state: PresenceState, userId: string): boolean {
  return state.presence[userId]?.status === 'online';
}
