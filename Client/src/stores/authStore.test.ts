import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore, onLogout } from './authStore';
import { getTokenStore, setTokenStore } from '../api/client';
import { MemoryTokenStore } from '../api/tokenStorage';
import { authApi } from '../api/auth';
import { alice, tokenPair } from '../test/fixtures';
import { t } from '../i18n';

vi.mock('../api/auth', () => ({ authApi: { login: vi.fn(), logout: vi.fn(), me: vi.fn() } }));
const api = vi.mocked(authApi);

describe('auth store', () => {
  beforeEach(() => {
    setTokenStore(new MemoryTokenStore());
    useAuthStore.setState({ status: 'unauthenticated', user: null, sessionId: null, notice: null });
    vi.resetAllMocks();
  });

  it('stores tokens on login', async () => {
    api.login.mockResolvedValueOnce(tokenPair(1));
    await useAuthStore.getState().login('alice', 'pw', true);
    expect(useAuthStore.getState()).toMatchObject({ status: 'authenticated', user: alice });
    expect(getTokenStore().getAccessToken()?.token).toBe('access-1');
    expect(getTokenStore().loadSession()?.remember).toBe(true);
  });

  it('logout clears tokens, runs cleanup hooks and shows no "expired" notice', async () => {
    api.login.mockResolvedValueOnce(tokenPair(1));
    api.logout.mockImplementationOnce(() => {
      // The server echoes session.revoked { reason: "logout" } to our own socket.
      useAuthStore.getState().handleAuthFailure('logout');
      return Promise.resolve();
    });
    const hook = vi.fn();
    const off = onLogout(hook);
    await useAuthStore.getState().login('alice', 'pw', false);
    await useAuthStore.getState().logout();
    off();
    expect(hook).toHaveBeenCalled();
    expect(useAuthStore.getState()).toMatchObject({ status: 'unauthenticated', user: null, notice: null });
    expect(getTokenStore().loadSession()).toBeNull();
    expect(getTokenStore().getAccessToken()).toBeNull();
  });

  it('an involuntary logout explains why', async () => {
    api.login.mockResolvedValueOnce(tokenPair(1));
    await useAuthStore.getState().login('alice', 'pw', false);
    useAuthStore.getState().handleAuthFailure('password_changed');
    expect(useAuthStore.getState().status).toBe('unauthenticated');
    expect(useAuthStore.getState().notice).toBe('notice.password_changed');
    expect(t(useAuthStore.getState().notice ?? '')).toMatch(/password was changed/);
  });

  it('bootstrap without a stored session goes straight to login', async () => {
    useAuthStore.setState({ status: 'unknown' });
    await useAuthStore.getState().bootstrap();
    expect(useAuthStore.getState().status).toBe('unauthenticated');
  });
});
