import { apiUrl } from '../config';
import { ApiError, errorFromResponse } from './errors';
import { WebTokenStore, type TokenStore } from './tokenStorage';
import type { TokenPair } from './types';

/**
 * Central request layer. Every HTTP call goes through `request()`, which:
 *  1. attaches the access token (refreshing it first when it is about to expire);
 *  2. on 401 refreshes the token once (single-flight, cross-tab locked) and retries once;
 *  3. reports a failed refresh to the auth store, which logs the user out.
 * Network errors never log the user out; only a rejected refresh token does.
 */

const DEFAULT_TIMEOUT_MS = 20_000;
/** Refresh this long before the access token actually expires. */
const EXPIRY_SKEW_MS = 30_000;

export type AuthFailureReason = 'expired' | 'disabled' | 'revoked';

let store: TokenStore = new WebTokenStore();
let onAuthFailure: (reason: AuthFailureReason) => void = () => undefined;
let onTokensRefreshed: (pair: TokenPair) => void = () => undefined;
let refreshInFlight: Promise<string | null> | null = null;

export function setTokenStore(next: TokenStore): void {
  store = next;
  refreshInFlight = null;
}

export function getTokenStore(): TokenStore {
  return store;
}

export function setAuthHandlers(handlers: {
  onAuthFailure: (reason: AuthFailureReason) => void;
  onTokensRefreshed?: (pair: TokenPair) => void;
}): void {
  onAuthFailure = handlers.onAuthFailure;
  onTokensRefreshed = handlers.onTokensRefreshed ?? (() => undefined);
}

/** Persists a fresh token pair (login or refresh). */
export function storeTokens(pair: TokenPair, remember: boolean): void {
  store.setAccessToken(pair.accessToken, Date.parse(pair.accessTokenExpiresAt));
  store.saveSession({ refreshToken: pair.refreshToken, sessionId: pair.sessionId, remember });
}

export function hasStoredSession(): boolean {
  return store.loadSession() !== null;
}

export function clearTokens(): void {
  store.clear();
}

// ---- low level fetch ----------------------------------------------------------

interface RawOptions {
  method: string;
  path: string;
  body?: unknown;
  token?: string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
  responseType?: 'json' | 'blob';
}

async function rawFetch(options: RawOptions): Promise<Response> {
  const controller = new AbortController();
  const state = { timedOut: false };
  const timer = setTimeout(() => {
    state.timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const onExternalAbort = () => {
    controller.abort();
  };
  options.signal?.addEventListener('abort', onExternalAbort);

  const headers: Record<string, string> = {};
  // 0.5.5: a Blob goes as-is with its own type (stream previews); anything else is JSON.
  const isBlob = typeof Blob !== 'undefined' && options.body instanceof Blob;
  if (options.body !== undefined) headers['Content-Type'] = isBlob ? (options.body as Blob).type || 'application/octet-stream' : 'application/json';
  if (options.token) headers.Authorization = `Bearer ${options.token}`;

  try {
    return await fetch(apiUrl(options.path), {
      method: options.method,
      headers,
      body: options.body === undefined ? undefined : isBlob ? (options.body as Blob) : JSON.stringify(options.body),
      signal: controller.signal,
      credentials: 'omit',
    });
  } catch {
    if (state.timedOut) throw ApiError.timeout();
    if (options.signal?.aborted) throw ApiError.aborted();
    throw ApiError.network();
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onExternalAbort);
  }
}

async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) {
    return undefined;
  }
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

// ---- token refresh --------------------------------------------------------------

function fail(reason: AuthFailureReason): null {
  store.clear();
  onAuthFailure(reason);
  return null;
}

async function doRefresh(): Promise<string | null> {
  return store.withRefreshLock(async () => {
    // Read inside the lock: another tab may have rotated the token while we waited.
    const session = store.loadSession();
    if (!session) return fail('expired');

    const response = await rawFetch({
      method: 'POST',
      path: '/api/v1/auth/refresh',
      body: { refreshToken: session.refreshToken },
    });
    const body = await readBody(response);
    if (!response.ok) {
      const error = errorFromResponse(response.status, body);
      if (error.code === 'ACCOUNT_DISABLED') return fail('disabled');
      if (error.code === 'REFRESH_TOKEN_REUSED') return fail('revoked');
      if (response.status === 401 || response.status === 400) return fail('expired');
      // 429 / 5xx: keep the session, surface the error to the caller.
      throw error;
    }
    const pair = body as TokenPair;
    storeTokens(pair, session.remember);
    onTokensRefreshed(pair);
    return pair.accessToken;
  });
}

/**
 * Refreshes the access token. Concurrent callers share one in-flight refresh.
 * Resolves to the new access token, or null when the session is gone (user logged out).
 * Throws ApiError on network/server problems (session kept).
 */
export function refreshAccessToken(): Promise<string | null> {
  refreshInFlight ??= doRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

/** Returns a usable access token, refreshing when needed. Null when not logged in. */
export async function getValidAccessToken(): Promise<string | null> {
  const access = store.getAccessToken();
  if (access && access.expiresAt - EXPIRY_SKEW_MS > Date.now()) return access.token;
  if (!store.loadSession()) return null;
  return refreshAccessToken();
}

// ---- public request API -------------------------------------------------------

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** false for public endpoints (login, refresh, client version). */
  auth?: boolean;
}

function withQuery(path: string, query: RequestOptions['query']): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

async function send(path: string, options: RequestOptions, responseType: 'json' | 'blob'): Promise<Response> {
  const auth = options.auth ?? true;
  const fullPath = withQuery(path, options.query);
  const base = {
    method: options.method ?? 'GET',
    path: fullPath,
    body: options.body,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    responseType,
  };

  let token: string | null = null;
  if (auth) {
    token = await getValidAccessToken();
    if (!token) throw ApiError.sessionExpired();
  }
  let response = await rawFetch({ ...base, token });

  if (auth && response.status === 401) {
    // Expired or rejected access token: refresh once and retry once. Never loops.
    const fresh = await refreshAccessToken();
    if (!fresh) throw ApiError.sessionExpired();
    response = await rawFetch({ ...base, token: fresh });
    if (response.status === 401) {
      fail('expired');
      throw ApiError.sessionExpired();
    }
  }
  if (auth && response.status === 403) {
    const body = await readBody(response.clone());
    const error = errorFromResponse(403, body);
    if (error.code === 'ACCOUNT_DISABLED') {
      fail('disabled');
      throw error;
    }
  }
  return response;
}

/** JSON request. Resolves with the parsed body (undefined for 204). */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await send(path, options, 'json');
  const body = await readBody(response);
  if (!response.ok) throw errorFromResponse(response.status, body);
  return body as T;
}

/** Authenticated binary download (attachments need the Bearer token, so <img src> cannot be used directly). */
export async function requestBlob(path: string, options: RequestOptions = {}): Promise<Blob> {
  const response = await send(path, { timeoutMs: 120_000, ...options }, 'blob');
  if (!response.ok) throw errorFromResponse(response.status, await readBody(response));
  return response.blob();
}
