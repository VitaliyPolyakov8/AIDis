/**
 * Token storage for the WEB client.
 *
 * The AIDis server issues the refresh token in the JSON body and expects it back in the
 * JSON body of POST /auth/refresh (no httpOnly cookie exists), so the refresh token has
 * to be handled by JavaScript. Chosen strategy:
 *
 *  - Access token (15 min JWT): memory only. Never persisted.
 *  - Refresh token: "Remember me" -> localStorage (survives browser restarts);
 *    otherwise sessionStorage (gone when the tab/browser session ends).
 *  - The server rotates the refresh token on every use and revokes the session if an old
 *    one is replayed. Tabs therefore coordinate: refreshes run under a Web Lock and always
 *    read the newest token from storage; rotations are broadcast to sibling tabs
 *    (BroadcastChannel) so duplicated tabs in sessionStorage mode stay in sync.
 *
 * XSS is the main risk of JS-readable tokens; the client never renders HTML from the
 * server and the deployment docs recommend a strict Content-Security-Policy.
 *
 * Everything goes through the TokenStore interface so the future Electron client can
 * swap in OS secure storage (safeStorage/keychain) without touching the request layer.
 */

export interface StoredSession {
  refreshToken: string;
  sessionId: string;
  remember: boolean;
}

export interface TokenStore {
  getAccessToken(): { token: string; expiresAt: number } | null;
  setAccessToken(token: string, expiresAt: number): void;
  /** Always returns the newest persisted value (another tab may have rotated it). */
  loadSession(): StoredSession | null;
  saveSession(session: StoredSession): void;
  clear(): void;
  /** Runs fn exclusively across tabs (falls back to in-tab exclusivity). */
  withRefreshLock<T>(fn: () => Promise<T>): Promise<T>;
}

const STORAGE_KEY = 'aidis.session';
const CHANNEL_NAME = 'aidis.auth';

type BroadcastMessage = { type: 'rotated'; session: StoredSession } | { type: 'cleared'; sessionId: string };

function safeStorage(kind: 'local' | 'session'): Storage | null {
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

function parseSession(raw: string | null): StoredSession | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredSession>;
    if (typeof value.refreshToken === 'string' && typeof value.sessionId === 'string') {
      return { refreshToken: value.refreshToken, sessionId: value.sessionId, remember: value.remember === true };
    }
  } catch {
    /* corrupted value: treat as logged out */
  }
  return null;
}

export class WebTokenStore implements TokenStore {
  private access: { token: string; expiresAt: number } | null = null;
  private channel: BroadcastChannel | null = null;
  private localQueue: Promise<unknown> = Promise.resolve();

  constructor() {
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(CHANNEL_NAME);
      this.channel.onmessage = (event: MessageEvent<BroadcastMessage>) => {
        this.onBroadcast(event.data);
      };
    }
  }

  getAccessToken(): { token: string; expiresAt: number } | null {
    return this.access;
  }

  setAccessToken(token: string, expiresAt: number): void {
    this.access = { token, expiresAt };
  }

  loadSession(): StoredSession | null {
    return (
      parseSession(safeStorage('local')?.getItem(STORAGE_KEY) ?? null) ??
      parseSession(safeStorage('session')?.getItem(STORAGE_KEY) ?? null)
    );
  }

  saveSession(session: StoredSession): void {
    this.write(session);
    this.channel?.postMessage({ type: 'rotated', session } satisfies BroadcastMessage);
  }

  clear(): void {
    const current = this.loadSession();
    this.access = null;
    safeStorage('local')?.removeItem(STORAGE_KEY);
    safeStorage('session')?.removeItem(STORAGE_KEY);
    if (current) this.channel?.postMessage({ type: 'cleared', sessionId: current.sessionId } satisfies BroadcastMessage);
  }

  async withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
    if (typeof navigator !== 'undefined' && 'locks' in navigator) {
      return navigator.locks.request('aidis.refresh', fn);
    }
    const run = this.localQueue.then(fn, fn);
    this.localQueue = run.catch(() => undefined);
    return run;
  }

  private write(session: StoredSession): void {
    const target = safeStorage(session.remember ? 'local' : 'session');
    const other = safeStorage(session.remember ? 'session' : 'local');
    other?.removeItem(STORAGE_KEY);
    target?.setItem(STORAGE_KEY, JSON.stringify(session));
  }

  private onBroadcast(message: BroadcastMessage): void {
    const current = this.loadSession();
    if (!current) return;
    if (message.type === 'rotated' && message.session.sessionId === current.sessionId) {
      // Same login session in another tab rotated the token: adopt it so we never replay the old one.
      this.write({ ...message.session, remember: current.remember });
    }
  }
}

/** In-memory store used by tests (and usable as a template for Electron). */
export class MemoryTokenStore implements TokenStore {
  private access: { token: string; expiresAt: number } | null = null;
  private session: StoredSession | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  getAccessToken() {
    return this.access;
  }
  setAccessToken(token: string, expiresAt: number) {
    this.access = { token, expiresAt };
  }
  loadSession() {
    return this.session;
  }
  saveSession(session: StoredSession) {
    this.session = session;
  }
  clear() {
    this.access = null;
    this.session = null;
  }
  withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
