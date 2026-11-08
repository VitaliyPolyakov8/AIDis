import type { StoredSession, TokenStore } from '../api/tokenStorage';
import type { AidisDesktopApi, DesktopStoredSession } from './contract';

/**
 * Token storage for AIDis Desktop.
 *
 *  - Access token: memory only (same as the web client).
 *  - Refresh token: handed to the Electron main process, which encrypts it with the OS
 *    (Electron safeStorage = Windows DPAPI, bound to the Windows user) and writes the ciphertext
 *    to the app's userData folder. Nothing sensitive goes to localStorage.
 *  - "Keep me logged in" off: the session lives in memory only and the encrypted file is removed.
 *
 * The TokenStore interface is synchronous, so the decrypted session is loaded once before the app
 * renders (see initDesktop) and cached here; writes are sent to the main process in order.
 * There is a single window per app instance, so the refresh lock is an in-process queue.
 */
export class DesktopTokenStore implements TokenStore {
  private access: { token: string; expiresAt: number } | null = null;
  private session: StoredSession | null;
  private queue: Promise<unknown> = Promise.resolve();
  private writes: Promise<unknown> = Promise.resolve();
  private readonly api: AidisDesktopApi['auth'];

  constructor(api: AidisDesktopApi['auth'], initial: DesktopStoredSession | null) {
    this.api = api;
    this.session = initial ? { ...initial, remember: true } : null;
  }

  getAccessToken() {
    return this.access;
  }

  setAccessToken(token: string, expiresAt: number) {
    this.access = { token, expiresAt };
  }

  loadSession(): StoredSession | null {
    return this.session;
  }

  saveSession(session: StoredSession): void {
    this.session = session;
    const persisted = { refreshToken: session.refreshToken, sessionId: session.sessionId };
    this.enqueueWrite(() => (session.remember ? this.api.save(persisted) : this.api.clear()));
  }

  clear(): void {
    this.access = null;
    this.session = null;
    this.enqueueWrite(() => this.api.clear());
  }

  withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Resolves once every pending write reached the main process (used before quitting in tests). */
  flush(): Promise<unknown> {
    return this.writes;
  }

  private enqueueWrite(write: () => Promise<void>): void {
    // Keep writes ordered so a quick rotate-then-logout can never leave the old token on disk.
    this.writes = this.writes.then(write).catch(() => undefined);
  }
}
