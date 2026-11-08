import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { request, setAuthHandlers, setTokenStore, storeTokens } from './client';
import { MemoryTokenStore } from './tokenStorage';
import { ApiError, friendlyError } from './errors';
import { jsonResponse, tokenPair } from '../test/fixtures';

const fetchMock = vi.fn<typeof fetch>();

function authHeader(call: Parameters<typeof fetch>): string | undefined {
  const headers = call[1]?.headers as Record<string, string> | undefined;
  return headers?.Authorization;
}

describe('request layer', () => {
  let store: MemoryTokenStore;
  let failures: string[];

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    store = new MemoryTokenStore();
    setTokenStore(store);
    failures = [];
    setAuthHandlers({ onAuthFailure: (reason) => failures.push(reason) });
    storeTokens(tokenPair(1), true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('attaches the access token', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    await expect(request('/api/v1/users')).resolves.toEqual({ ok: true });
    expect(authHeader(fetchMock.mock.calls[0]!)).toBe('Bearer access-1');
  });

  it('refreshes once on 401 and retries the original request once', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: 'UNAUTHORIZED', message: 'Access token expired' } }))
      .mockResolvedValueOnce(jsonResponse(200, tokenPair(2)))
      .mockResolvedValueOnce(jsonResponse(200, { users: [] }));

    await expect(request('/api/v1/users')).resolves.toEqual({ users: [] });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[1]![0])).toBe('/api/v1/auth/refresh');
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toEqual({ refreshToken: tokenPair(1).refreshToken });
    expect(authHeader(fetchMock.mock.calls[2]!)).toBe('Bearer access-2');
    expect(store.loadSession()?.refreshToken).toBe(tokenPair(2).refreshToken);
    expect(failures).toEqual([]);
  });

  it('does not loop: a second 401 after refreshing logs out', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: 'UNAUTHORIZED', message: 'x' } }))
      .mockResolvedValueOnce(jsonResponse(200, tokenPair(2)))
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: 'UNAUTHORIZED', message: 'x' } }));

    await expect(request('/api/v1/users')).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(failures).toEqual(['expired']);
    expect(store.loadSession()).toBeNull();
  });

  it('logs out when the refresh token is rejected', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: 'UNAUTHORIZED', message: 'x' } }))
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: 'INVALID_REFRESH_TOKEN', message: 'x' } }));

    await expect(request('/api/v1/users')).rejects.toBeInstanceOf(ApiError);
    expect(failures).toEqual(['expired']);
    expect(store.getAccessToken()).toBeNull();
  });

  it('shares one refresh between concurrent requests', async () => {
    store.setAccessToken('stale', Date.now() - 1000); // already expired -> proactive refresh
    let refreshes = 0;
    fetchMock.mockImplementation((input) => {
      if (String(input) === '/api/v1/auth/refresh') {
        refreshes += 1;
        return Promise.resolve(jsonResponse(200, tokenPair(2)));
      }
      return Promise.resolve(jsonResponse(200, { ok: true }));
    });

    await Promise.all([request('/a'), request('/b'), request('/c')]);
    expect(refreshes).toBe(1);
  });

  it('keeps the session on network errors', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(request('/api/v1/users')).rejects.toMatchObject({ kind: 'network', code: 'NETWORK_ERROR' });
    expect(failures).toEqual([]);
    expect(store.loadSession()).not.toBeNull();
  });

  it('maps a disabled account to a logout', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { error: { code: 'ACCOUNT_DISABLED', message: 'x' } }));
    await expect(request('/api/v1/users')).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED' });
    expect(failures).toEqual(['disabled']);
  });

  it('does not send a token or refresh for public endpoints', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: { code: 'INVALID_CREDENTIALS', message: 'x' } }));
    await expect(request('/api/v1/auth/login', { method: 'POST', auth: false, body: {} })).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(authHeader(fetchMock.mock.calls[0]!)).toBeUndefined();
  });

  it('turns a proxy HTML error page into SERVER_UNAVAILABLE', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>Bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }));
    const error = await request('/api/v1/users').catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'SERVER_UNAVAILABLE' });
    expect(friendlyError(error)).toMatch(/temporarily unavailable/);
  });
});

describe('friendlyError', () => {
  it('never shows raw server text', () => {
    expect(friendlyError(new ApiError('http', 401, 'INVALID_CREDENTIALS', 'Invalid username or password'))).toBe(
      'Incorrect username or password.',
    );
    expect(friendlyError(new ApiError('http', 429, 'RATE_LIMITED', 'Too many requests, retry in 41s'))).toMatch(/Too many attempts/);
    expect(friendlyError(new ApiError('http', 418, 'SOMETHING_NEW', '{"raw":"json"}'), 'Fallback')).toBe('Fallback');
  });

  it('uses the first validation message', () => {
    const error = new ApiError('http', 400, 'VALIDATION_ERROR', 'Request validation failed', [
      { path: 'content', message: 'Message must be at most 4000 characters' },
    ]);
    expect(friendlyError(error)).toBe('Message must be at most 4000 characters');
  });
});
