import { describe, expect, it, vi, afterEach } from 'vitest';
import manifestText from '../../public/manifest.webmanifest?raw';
import swCode from '../../public/sw.js?raw';
import indexHtml from '../../index.html?raw';

const { isStandalone, isIosDevice } = await import('./webApp');
const { sanitizeSettings } = await import('../stores/settingsStore');

describe('0.5.9 web app on iPhone / iPad', () => {
  afterEach(() => {
    delete (navigator as Navigator & { standalone?: boolean }).standalone;
  });

  it('knows when it was opened from the home screen', () => {
    expect(isIosDevice).toBe(false); // jsdom is not an iPhone
    expect(isStandalone()).toBe(false);
    (navigator as Navigator & { standalone?: boolean }).standalone = true;
    expect(isStandalone()).toBe(true);
  });

  it('keeps background sound on unless turned off', () => {
    expect(sanitizeSettings({}).iosBackgroundAudio).toBe(true);
    expect(sanitizeSettings({ iosBackgroundAudio: false }).iosBackgroundAudio).toBe(false);
  });

  it('has an installable manifest with an opaque Apple icon', () => {
    const manifest = JSON.parse(manifestText) as { display: string; start_url: string; icons: { src: string; purpose?: string }[] };
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
    expect(manifest.icons.map((i) => i.src)).toEqual(expect.arrayContaining(['/icon-192.png', '/icon-512.png', '/apple-touch-icon.png']));
    const html = indexHtml;
    expect(html).toContain('apple-mobile-web-app-capable');
    expect(html).toContain('viewport-fit=cover');
  });
});

describe('0.5.9 service worker', () => {
  type Listener = (event: { request: Request; respondWith: (r: Promise<Response>) => void; waitUntil: (p: Promise<unknown>) => void }) => void;

  /** Loads public/sw.js into a fake worker scope; returns its fetch handler and the fake caches. */
  function loadWorker(network: (req: Request) => Promise<Response>) {
    const listeners: Record<string, Listener> = {};
    const stores = new Map<string, Map<string, Response>>();
    const caches = {
      open: async (name: string) => {
        if (!stores.has(name)) stores.set(name, new Map());
        const store = stores.get(name)!;
        return {
          put: async (req: Request | string, res: Response) => {
            store.set(typeof req === 'string' ? req : new URL(req.url).pathname, res);
          },
        };
      },
      match: async (req: Request | string) => {
        const key = typeof req === 'string' ? req : new URL(req.url).pathname;
        for (const store of stores.values()) {
          const hit = store.get(key);
          if (hit) return hit.clone();
        }
        return undefined;
      },
      keys: async () => [...stores.keys()],
      delete: async (name: string) => stores.delete(name),
    };
    const self = { location: { origin: 'https://chat.example.com' }, addEventListener: (type: string, fn: Listener) => (listeners[type] = fn), skipWaiting: vi.fn(), clients: { claim: vi.fn() } };
    // Our own file from the repository (not user input), run in a fake worker scope.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call
    new Function('self', 'caches', 'fetch', swCode)(self, caches, network);
    const fetchEvent = async (url: string, init: RequestInit & { mode?: RequestMode } = {}) => {
      let responded: Promise<Response> | null = null;
      const { mode, ...rest } = init;
      const request = new Request(url, rest);
      if (mode === 'navigate') Object.defineProperty(request, 'mode', { value: 'navigate' });
      listeners.fetch?.({
        request,
        respondWith: (r) => {
          responded = r;
        },
        waitUntil: () => undefined,
      });
      return responded ? await (responded as Promise<Response>) : null;
    };
    return { fetchEvent };
  }

  it('serves pages from the network, and the last good page when offline', async () => {
    let online = true;
    const network = vi.fn(async () => {
      if (!online) throw new TypeError('offline');
      return new Response('<html>v2</html>', { status: 200 });
    });
    const sw = loadWorker(network);
    expect(await (await sw.fetchEvent('https://chat.example.com/channels/1', { mode: 'navigate' }))?.text()).toBe('<html>v2</html>');
    online = false;
    expect(await (await sw.fetchEvent('https://chat.example.com/voice/2', { mode: 'navigate' }))?.text()).toBe('<html>v2</html>');
  });

  it('caches hashed assets and never touches the API', async () => {
    const network = vi.fn(async () => new Response('asset', { status: 200 }));
    const sw = loadWorker(network);
    await sw.fetchEvent('https://chat.example.com/assets/index-abc.js');
    await sw.fetchEvent('https://chat.example.com/assets/index-abc.js');
    expect(network).toHaveBeenCalledTimes(1);
    expect(await sw.fetchEvent('https://chat.example.com/api/v1/users')).toBeNull();
    expect(await sw.fetchEvent('https://chat.example.com/api/v1/messages', { method: 'POST', body: '{}' })).toBeNull();
    expect(await sw.fetchEvent('https://rtc.chat.example.com/assets/x.js')).toBeNull();
  });
});
