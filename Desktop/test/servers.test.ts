import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: true, getAppPath: () => 'C:/app', getVersion: () => '1.0.0', getPath: () => tmpdir() },
  net: {},
  protocol: {},
  screen: {},
}));
Object.assign(process, { resourcesPath: 'C:/app/resources' });

const { ServerError, ServerStore, normalizeServerAddress, readClientConfig } = await import('../src/main/servers');
const { buildCsp } = await import('../src/main/protocol');

type Route = Record<string, { status: number; body?: unknown; throws?: boolean }>;
function fakeFetch(routes: Route) {
  return vi.fn((url: string) => {
    const r = routes[url];
    if (!r || r.throws) return Promise.reject(new Error('connect ECONNREFUSED'));
    return Promise.resolve({ ok: r.status === 200, status: r.status, json: () => (r.body === undefined ? Promise.reject(new Error('not json')) : Promise.resolve(r.body)) });
  });
}

const CONFIG = {
  server: { name: 'AIDis', version: '1.0.0' },
  livekitUrl: 'wss://rtc.chat.example.com',
  voiceNodeDomain: 'chat.example.com',
  gifs: 'none',
  steamArt: false,
  desktop: { latestVersion: '1.0.0', minimumVersion: '1.0.0', updateMirrorUrl: null },
};

describe('server addresses', () => {
  it('accepts a bare host name and normalizes to an https origin', () => {
    expect(normalizeServerAddress('chat.example.com')).toBe('https://chat.example.com');
    expect(normalizeServerAddress('  https://Chat.Example.com/login ')).toBe('https://chat.example.com');
  });

  it('refuses http (except localhost in development) and junk', () => {
    expect(() => normalizeServerAddress('http://chat.example.com')).toThrow(ServerError);
    expect(() => normalizeServerAddress('http://localhost:3000')).toThrow(ServerError);
    expect(normalizeServerAddress('http://localhost:3000', true)).toBe('http://localhost:3000');
    for (const bad of ['', 'chat', 'ftp://chat.example.com', 'https://user:pw@chat.example.com']) expect(() => normalizeServerAddress(bad), bad).toThrow(ServerError);
  });
});

describe('server store', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aidis-servers-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('adds an AIDis server, makes it current and remembers it across restarts', async () => {
    const fetch = fakeFetch({ 'https://chat.example.com/api/v1/client/config': { status: 200, body: CONFIG } });
    const store = new ServerStore(dir, fetch);
    const added = await store.add('chat.example.com');
    expect(added).toMatchObject({ origin: 'https://chat.example.com', name: 'chat.example.com', config: { livekitUrl: 'wss://rtc.chat.example.com', voiceNodeDomain: 'chat.example.com', minimumVersion: '1.0.0' } });
    const again = new ServerStore(dir, fetch);
    expect(again.current()?.origin).toBe('https://chat.example.com');
    expect(again.list()).toHaveLength(1);
  });

  it('Review Focus 2: a site that is not AIDis, a server that is down or http -> an error and nothing saved', async () => {
    const store = new ServerStore(dir, fakeFetch({ 'https://example.org/api/v1/client/config': { status: 404, body: { error: 'nope' } }, 'https://example.org/api/v1/version': { status: 404 } }));
    await expect(store.add('example.org')).rejects.toMatchObject({ code: 'NOT_AIDIS' });
    await expect(store.add('down.example.net')).rejects.toMatchObject({ code: 'UNREACHABLE' });
    await expect(store.add('http://chat.example.com')).rejects.toMatchObject({ code: 'NOT_HTTPS' });
    const html = new ServerStore(dir, fakeFetch({ 'https://html.example.com/api/v1/client/config': { status: 200 }, 'https://html.example.com/api/v1/version': { status: 200 } }));
    await expect(html.add('html.example.com')).rejects.toMatchObject({ code: 'NOT_AIDIS' });
    expect(store.list()).toEqual([]);
    expect(store.current()).toBeNull();
  });

  it('Review Focus 3: an older AIDis without /client/config connects with defaults', async () => {
    const store = new ServerStore(
      dir,
      fakeFetch({ 'https://old.example.com/api/v1/client/config': { status: 404, body: { error: { code: 'NOT_FOUND' } } }, 'https://old.example.com/api/v1/version': { status: 200, body: { version: '0.7.1' } } }),
    );
    const added = await store.add('old.example.com');
    expect(added.config).toEqual({ serverVersion: '0.7.1', livekitUrl: '', voiceNodeDomain: 'old.example.com', steamArt: false, minimumVersion: '', updateMirrorUrl: null });
    expect(readClientConfig('https://x.example.com', { server: { name: 'AIDis' } }).voiceNodeDomain).toBe('x.example.com');
  });

  it('switches and removes servers', async () => {
    const fetch = fakeFetch({ 'https://a.example.com/api/v1/client/config': { status: 200, body: CONFIG }, 'https://b.example.com/api/v1/client/config': { status: 200, body: CONFIG } });
    const store = new ServerStore(dir, fetch);
    await store.add('a.example.com');
    await store.add('b.example.com');
    expect(store.current()?.origin).toBe('https://b.example.com');
    store.select('https://a.example.com');
    expect(store.current()?.origin).toBe('https://a.example.com');
    store.remove('https://a.example.com');
    expect(store.current()?.origin).toBe('https://b.example.com');
  });
});

describe('CSP of the universal app', () => {
  const connect = (csp: string) => csp.split('; ').find((d) => d.startsWith('connect-src')) ?? '';

  it('without a server the page may talk to nothing but itself', () => {
    expect(connect(buildCsp(null))).toBe("connect-src 'self'");
  });

  it('with a server: its origin, websocket, LiveKit and its voice subdomains, nothing broader', () => {
    const csp = buildCsp({ origin: 'https://chat.example.com', name: 'chat.example.com', config: readClientConfig('https://chat.example.com', CONFIG) });
    const c = connect(csp).split(' ');
    expect(c).toEqual(
      expect.arrayContaining(['https://chat.example.com', 'wss://chat.example.com', 'wss://rtc.chat.example.com', 'https://rtc.chat.example.com', 'wss://*.chat.example.com', 'https://*.chat.example.com']),
    );
    expect(connect(csp)).not.toMatch(/(^|\s)(wss:|https:|\*)(\s|$)/);
    expect(csp).not.toMatch(/steamstatic/);
    const withSteam = buildCsp({ origin: 'https://chat.example.com', name: 'x', config: { ...readClientConfig('https://chat.example.com', CONFIG), steamArt: true } });
    expect(withSteam).toMatch(/img-src[^;]*steamstatic/);
  });
});
