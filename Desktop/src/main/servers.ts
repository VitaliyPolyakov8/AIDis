import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DesktopServer, DesktopServerConfig } from '../../../Client/src/desktop/contract';
import { writeFileAtomic } from './jsonFile';
import { logger } from './logger';

/**
 * The AIDis servers this app knows (one universal app for every installation). The user types an
 * address once; the app checks it is an AIDis (GET /api/v1/client/config, or /api/v1/version on an
 * older server), remembers it and builds the CSP, the CORS bridge and the session store from the
 * chosen one. Persisted in %APPDATA%\AIDis\servers.json (no secrets: tokens live in the session store).
 */

export type AddServerError = 'NOT_HTTPS' | 'INVALID' | 'UNREACHABLE' | 'NOT_AIDIS';

export class ServerError extends Error {
  constructor(readonly code: AddServerError) {
    super(code);
    this.name = 'ServerError';
  }
}

type Fetch = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

const TIMEOUT_MS = 10_000;
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/;

/** Pure: "chat.example.com", "https://chat.example.com/" -> "https://chat.example.com". */
export function normalizeServerAddress(input: string, allowLocalHttp = false): string {
  const raw = input.trim();
  if (!raw) throw new ServerError('INVALID');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new ServerError('INVALID');
  }
  if (url.username || url.password) throw new ServerError('INVALID');
  if (url.protocol === 'http:' && !(allowLocalHttp && LOCAL.test(url.hostname))) throw new ServerError('NOT_HTTPS');
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ServerError('NOT_HTTPS');
  if (!url.hostname.includes('.') && !LOCAL.test(url.hostname)) throw new ServerError('INVALID');
  return url.origin;
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

/** Pure: whatever the server answered -> a complete config (an older server lacks newer fields). */
export function readClientConfig(origin: string, raw: unknown): DesktopServerConfig {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const desktop = (typeof o.desktop === 'object' && o.desktop !== null ? o.desktop : {}) as Record<string, unknown>;
  const server = (typeof o.server === 'object' && o.server !== null ? o.server : {}) as Record<string, unknown>;
  const host = new URL(origin).hostname;
  const mirror = str(desktop.updateMirrorUrl, '');
  return {
    serverVersion: str(server.version, ''),
    livekitUrl: /^wss?:\/\//.test(str(o.livekitUrl, '')) ? str(o.livekitUrl, '') : '',
    voiceNodeDomain: /^[a-z0-9.-]+$/i.test(str(o.voiceNodeDomain, '')) && str(o.voiceNodeDomain, '') ? str(o.voiceNodeDomain, '').toLowerCase() : host,
    steamArt: o.steamArt === true,
    minimumVersion: str(desktop.minimumVersion, ''),
    updateMirrorUrl: /^https:\/\/\S+$/.test(mirror) ? mirror : null,
  };
}

async function getJson(fetchImpl: Fetch, url: string): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } catch {
    throw new ServerError('UNREACHABLE');
  } finally {
    clearTimeout(timer);
  }
}

/** Asks a server who it is. */
export async function probeServer(origin: string, fetchImpl: Fetch): Promise<DesktopServerConfig> {
  const config = await getJson(fetchImpl, `${origin}/api/v1/client/config`);
  const body = config.body as { server?: { name?: unknown } } | null;
  if (config.status === 200 && body?.server?.name === 'AIDis') return readClientConfig(origin, body);
  // An AIDis older than /client/config still answers /api/v1/version.
  const version = await getJson(fetchImpl, `${origin}/api/v1/version`);
  const v = version.body as { version?: unknown } | null;
  if (version.status === 200 && typeof v?.version === 'string') return readClientConfig(origin, { server: { version: v.version } });
  throw new ServerError('NOT_AIDIS');
}

interface FileShape {
  current: string | null;
  servers: DesktopServer[];
}

export class ServerStore {
  private readonly file: string;
  private data: FileShape = { current: null, servers: [] };

  constructor(
    userDataDir: string,
    private readonly fetchImpl: Fetch,
    private readonly allowLocalHttp = false,
  ) {
    this.file = join(userDataDir, 'servers.json');
    this.load();
  }

  list(): DesktopServer[] {
    return this.data.servers;
  }

  current(): DesktopServer | null {
    return this.data.servers.find((s) => s.origin === this.data.current) ?? null;
  }

  /** Checks and remembers a server, and makes it the current one. */
  async add(input: string): Promise<DesktopServer> {
    const origin = normalizeServerAddress(input, this.allowLocalHttp);
    const config = await probeServer(origin, this.fetchImpl);
    const entry: DesktopServer = { origin, name: new URL(origin).host, config };
    this.data = { current: origin, servers: [entry, ...this.data.servers.filter((s) => s.origin !== origin)] };
    this.save();
    logger.info('servers', `Server ${origin} added (AIDis ${config.serverVersion || 'version unknown'})`);
    return entry;
  }

  select(origin: string): DesktopServer {
    const found = this.data.servers.find((s) => s.origin === origin);
    if (!found) throw new ServerError('INVALID');
    this.data.current = origin;
    this.save();
    return found;
  }

  remove(origin: string): void {
    this.data.servers = this.data.servers.filter((s) => s.origin !== origin);
    if (this.data.current === origin) this.data.current = this.data.servers[0]?.origin ?? null;
    this.save();
  }

  /** At start: the current server's settings may have changed; keep the old ones when it is down. */
  async refreshCurrent(): Promise<DesktopServer | null> {
    const current = this.current();
    if (!current) return null;
    try {
      const config = await probeServer(current.origin, this.fetchImpl);
      current.config = config;
      this.save();
    } catch (error) {
      logger.warn('servers', `Could not refresh ${current.origin}: ${error instanceof ServerError ? error.code : 'error'}`);
    }
    return current;
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<FileShape>;
      const servers = Array.isArray(raw.servers)
        ? raw.servers
            .filter((s): s is DesktopServer => typeof s === 'object' && typeof s.origin === 'string' && typeof s.name === 'string')
            .map((s) => ({ ...s, config: readClientConfig(s.origin, { ...s.config, server: { version: s.config.serverVersion }, desktop: s.config }) }))
        : [];
      this.data = { servers, current: typeof raw.current === 'string' && servers.some((s) => s.origin === raw.current) ? raw.current : (servers[0]?.origin ?? null) };
    } catch (error) {
      logger.warn('servers', 'servers.json unreadable; starting without servers', error);
    }
  }

  private save(): void {
    writeFileAtomic(this.file, JSON.stringify(this.data, null, 2));
  }
}
