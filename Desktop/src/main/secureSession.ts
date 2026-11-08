import { safeStorage } from 'electron';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { DesktopStoredSession } from '../../../Client/src/desktop/contract';
import { writeFileAtomic } from './jsonFile';
import { logger } from './logger';

/**
 * Persists the refresh token encrypted with Electron safeStorage. On Windows that is DPAPI: the
 * ciphertext in %APPDATA%\AIDis\session.bin can only be decrypted by the same Windows user on the
 * same machine. If OS encryption is unavailable the session is kept in memory only (never written
 * in plain text), so the user simply logs in again after a restart.
 */
const MAX_FIELD = 4096;

function isSession(value: unknown): value is DesktopStoredSession {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.refreshToken === 'string' && typeof v.sessionId === 'string' && v.refreshToken.length > 0 && v.refreshToken.length <= MAX_FIELD && v.sessionId.length > 0 && v.sessionId.length <= MAX_FIELD;
}

export class SecureSessionStore {
  private readonly file: string;
  private memory: DesktopStoredSession | null = null;

  /** One store per server: %APPDATA%\\AIDis\\session-<hash of the server address>.bin. */
  constructor(userDataDir: string, serverOrigin: string) {
    this.file = join(userDataDir, `session-${createHash('sha256').update(serverOrigin).digest('hex').slice(0, 16)}.bin`);
  }

  get encryptionAvailable(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  load(): DesktopStoredSession | null {
    if (this.memory) return this.memory;
    if (!existsSync(this.file)) return null;
    if (!this.encryptionAvailable) {
      logger.warn('auth', 'OS encryption unavailable; stored session ignored');
      return null;
    }
    try {
      const parsed = JSON.parse(safeStorage.decryptString(readFileSync(this.file))) as unknown;
      if (isSession(parsed)) return { refreshToken: parsed.refreshToken, sessionId: parsed.sessionId };
      logger.warn('auth', 'Stored session has an unexpected shape; discarding it');
    } catch (error) {
      logger.warn('auth', 'Stored session could not be decrypted; discarding it', error);
    }
    this.clear();
    return null;
  }

  save(value: unknown): void {
    if (!isSession(value)) throw new Error('Invalid session');
    const session = { refreshToken: value.refreshToken, sessionId: value.sessionId };
    if (!this.encryptionAvailable) {
      this.memory = session;
      rmSync(this.file, { force: true });
      return;
    }
    this.memory = null;
    writeFileAtomic(this.file, safeStorage.encryptString(JSON.stringify(session)));
  }

  clear(): void {
    this.memory = null;
    try {
      rmSync(this.file, { force: true });
    } catch (error) {
      logger.warn('auth', 'Could not remove the stored session', error);
    }
  }
}
