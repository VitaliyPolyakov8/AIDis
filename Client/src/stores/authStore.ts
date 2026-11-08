import { i18next } from '../i18n';
import { create } from 'zustand';
import { authApi } from '../api/auth';
import { clearTokens, hasStoredSession, refreshAccessToken, setAuthHandlers, storeTokens } from '../api/client';
import { isApiError } from '../api/errors';
import type { PublicUser, TokenPair } from '../api/types';

/** offline: a stored session exists but the server could not be reached to restore it. */
export type AuthStatus = 'unknown' | 'authenticated' | 'unauthenticated' | 'offline';

interface AuthState {
  status: AuthStatus;
  user: PublicUser | null;
  sessionId: string | null;
  /** i18n key shown on the login page after an involuntary logout. */
  notice: string | null;
  /** Restores a session from the stored refresh token on page load. */
  bootstrap: () => Promise<void>;
  login: (username: string, password: string, remember: boolean) => Promise<void>;
  /** 0.7.1: a session that came from an e-mail link (registration confirmed). */
  adoptSession: (pair: TokenPair) => void;
  logout: () => Promise<void>;
  setUser: (user: PublicUser) => void;
  /** Called when the server rejects our session (refresh failed, revoked, disabled). */
  /** reason: an AuthFailureReason or a server session.revoked reason (password_changed, user_disabled, ...) */
  handleAuthFailure: (reason: string) => void;
  clearNotice: () => void;
}

type Hook = () => void;
const logoutHooks = new Set<Hook>();

/** Lets realtime/voice/chat modules clean up on logout without circular imports. */
export function onLogout(hook: Hook): () => void {
  logoutHooks.add(hook);
  return () => logoutHooks.delete(hook);
}

function runLogoutHooks(): void {
  for (const hook of logoutHooks) {
    try {
      hook();
    } catch {
      /* one failing cleanup must not block the others */
    }
  }
}

/** i18n key of the explanation shown on the login page after an involuntary logout. */
function noticeKey(reason: string): string {
  const key = `notice.${reason}`;
  return i18next.exists(key) ? key : 'notice.expired';
}

export const useAuthStore = create<AuthState>((set, get) => ({
  status: 'unknown',
  user: null,
  sessionId: null,
  notice: null,

  bootstrap: async () => {
    if (!hasStoredSession()) {
      set({ status: 'unauthenticated' });
      return;
    }
    try {
      const token = await refreshAccessToken();
      if (!token) return; // handleAuthFailure already switched to unauthenticated
      const { user, sessionId } = await authApi.me();
      set({ status: 'authenticated', user, sessionId });
    } catch (error) {
      if (get().status === 'unauthenticated') return;
      // Server unreachable: keep the stored session so a reload later can restore it.
      if (isApiError(error) && (error.kind === 'network' || error.kind === 'timeout' || error.status >= 500 || error.status === 429)) {
        set({ status: 'offline' });
        return;
      }
      clearTokens();
      set({ status: 'unauthenticated' });
    }
  },

  login: async (username, password, remember) => {
    const pair = await authApi.login(username, password);
    storeTokens(pair, remember);
    set({ status: 'authenticated', user: pair.user, sessionId: pair.sessionId, notice: null });
  },

  adoptSession: (pair) => {
    storeTokens(pair, true);
    set({ status: 'authenticated', user: pair.user, sessionId: pair.sessionId, notice: null });
  },

  logout: async () => {
    // Tear down realtime/voice first so our own session.revoked echo is not treated as an expiry.
    runLogoutHooks();
    set({ status: 'unauthenticated', user: null, sessionId: null, notice: null });
    try {
      await authApi.logout();
    } catch {
      /* the session is dropped locally either way */
    }
    clearTokens();
    set({ status: 'unauthenticated', user: null, sessionId: null });
  },

  setUser: (user) => set({ user }),

  handleAuthFailure: (reason) => {
    if (reason === 'logout') return; // our own logout, already handled
    const wasAuthenticated = get().status === 'authenticated';
    clearTokens();
    runLogoutHooks();
    set({
      status: 'unauthenticated',
      user: null,
      sessionId: null,
      notice: wasAuthenticated || reason !== 'expired' ? noticeKey(reason) : null,
    });
  },

  clearNotice: () => set({ notice: null }),
}));

setAuthHandlers({
  onAuthFailure: (reason) => {
    useAuthStore.getState().handleAuthFailure(reason);
  },
});
