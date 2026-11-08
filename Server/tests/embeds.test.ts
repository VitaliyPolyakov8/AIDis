import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertFetchableUrl, FetchBlockedError, isPublicAddress, safeFetch, type RawResponse, type SafeFetchOptions } from '../src/embeds/safe-fetch.js';
import { decodeHtml, extractUrls, parseMetadata, steamAppId, youtubeVideoId } from '../src/embeds/metadata.js';
import { LinkPreviewService } from '../src/embeds/link-preview.service.js';
import { GifProviderError, GifService, validateGif } from '../src/embeds/gif.service.js';
import { gifConfig } from '../src/config/env.js';
import { ImageSigner } from '../src/embeds/embeds.js';
import { bearer, connectSocket, createTestEnv, createUser, getVoiceChannelId, listen, login, waitForEvent, type LoginResult, type TestEnv } from './helpers.js';

const silentLog = { info: () => undefined, warn: () => undefined, error: () => undefined } as never;

function response(status: number, body: string, headers: Record<string, string> = {}): RawResponse {
  return { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers }, body: Buffer.from(body), truncated: false };
}

describe('SSRF protection', () => {
  it('only allows globally routable addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.5.5',
      '172.31.255.255',
      '192.168.1.57',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      '::',
      'fe80::1',
      'fd00::1',
      '::ffff:127.0.0.1',
      '::ffff:192.168.0.1',
      '64:ff9b::a00:1',
      '2002:c0a8:0101::1',
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700::6810:84e5', '::ffff:8.8.8.8']) expect(isPublicAddress(ip), ip).toBe(true);
  });

  it('refuses local names, private literals, other protocols, ports and credentials before any request', () => {
    for (const url of [
      'http://localhost/',
      'http://127.0.0.1/',
      'http://[::1]/',
      'http://192.168.1.57/',
      'http://10.0.0.5/admin',
      'http://169.254.169.254/latest/meta-data/',
      'http://metadata.google.internal/',
      'http://postgres/',
      'http://db.local/',
      'http://example.com:8080/',
      'http://user:pass@example.com/',
      'file:///etc/passwd',
      'ftp://example.com/',
      'gopher://example.com/',
      'not a url',
    ]) {
      expect(() => assertFetchableUrl(url), url).toThrow(FetchBlockedError);
    }
    expect(assertFetchableUrl('https://store.steampowered.com/app/553850/').hostname).toBe('store.steampowered.com');
  });

  it('checks every DNS answer (rebinding) and every redirect target, and limits redirects', async () => {
    const opts = (resolve: SafeFetchOptions['resolve'], transport: SafeFetchOptions['transport']): SafeFetchOptions => ({ accept: ['text/html'], maxBytes: 1000, resolve, transport });
    const neverCalled = () => Promise.reject(new Error('should not connect'));
    await expect(
      safeFetch(
        'http://evil.example/',
        opts(() => Promise.resolve(['10.0.0.8']), neverCalled),
      ),
    ).rejects.toThrow(FetchBlockedError);
    await expect(
      safeFetch(
        'http://evil.example/',
        opts(() => Promise.resolve(['93.184.216.34', '127.0.0.1']), neverCalled),
      ),
    ).rejects.toThrow(FetchBlockedError);

    const connected: string[] = [];
    const redirectToLocal: SafeFetchOptions['transport'] = (url, address) => {
      connected.push(`${url.hostname}@${address}`);
      return Promise.resolve(response(302, '', { location: 'http://127.0.0.1:80/secret' }));
    };
    await expect(
      safeFetch(
        'https://short.example/x',
        opts(() => Promise.resolve(['93.184.216.34']), redirectToLocal),
      ),
    ).rejects.toThrow(FetchBlockedError);
    expect(connected).toEqual(['short.example@93.184.216.34']); // connected to the checked address only

    let hops = 0;
    const loop: SafeFetchOptions['transport'] = () => {
      hops += 1;
      return Promise.resolve(response(301, '', { location: `https://loop.example/${hops}` }));
    };
    await expect(
      safeFetch(
        'https://loop.example/0',
        opts(() => Promise.resolve(['93.184.216.34']), loop),
      ),
    ).rejects.toThrow('too many redirects');
    expect(hops).toBe(4);

    const pdf: SafeFetchOptions['transport'] = () => Promise.resolve(response(200, '%PDF', { 'content-type': 'application/pdf' }));
    await expect(
      safeFetch(
        'https://files.example/a.pdf',
        opts(() => Promise.resolve(['93.184.216.34']), pdf),
      ),
    ).rejects.toThrow('content type');
  });
});

describe('metadata extraction', () => {
  it('reads Open Graph, falls back to <title>/description, decodes entities, ignores HTML', () => {
    const html = `<html><head><title>Fallback</title>
      <meta property="og:title" content="Статья &amp; новости &#8212; тест">
      <meta content="Описание &lt;b&gt;без&lt;/b&gt; тегов" name="description">
      <meta property="og:image" content="/img/cover.jpg"><meta property="og:site_name" content="Example">
      <script>alert(1)</script></head><body>...</body></html>`;
    expect(parseMetadata(html, 'https://news.example/a')).toEqual({
      title: 'Статья & новости — тест',
      description: 'Описание без тегов',
      image: 'https://news.example/img/cover.jpg',
      siteName: 'Example',
      url: null,
    });
    expect(parseMetadata('<title>Only title</title>', 'https://x.example/').title).toBe('Only title');
    expect(parseMetadata('<meta property="og:image" content="javascript:alert(1)">', 'https://x.example/').image).toBeNull();
    const cp1251 = Buffer.from([0x3c, 0x74, 0x69, 0x74, 0x6c, 0x65, 0x3e, 0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x3c, 0x2f, 0x74, 0x69, 0x74, 0x6c, 0x65, 0x3e]);
    expect(parseMetadata(decodeHtml(cp1251, 'text/html; charset=windows-1251'), 'https://x.example/').title).toBe('Привет');
  });

  it('finds links, skips code and <suppressed> links, recognises YouTube and Steam', () => {
    expect(extractUrls('see https://a.example/x, and (https://b.example/y) `https://code.example` <https://hidden.example>')).toEqual(['https://a.example/x', 'https://b.example/y']);
    for (const url of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=5', 'https://youtu.be/dQw4w9WgXcQ', 'https://m.youtube.com/shorts/dQw4w9WgXcQ']) {
      expect(youtubeVideoId(url), url).toBe('dQw4w9WgXcQ');
    }
    expect(youtubeVideoId('https://example.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(steamAppId('https://store.steampowered.com/app/553850/HELLDIVERS_2/')).toBe('553850');
    expect(steamAppId('https://evil.example/app/553850')).toBeNull();
  });
});

describe('link previews', () => {
  const fakeFetch =
    (routes: Record<string, () => RawResponse>): typeof safeFetch =>
    (url) => {
      const key = Object.keys(routes).find((k) => url.startsWith(k));
      if (!key) return Promise.reject(new Error('offline'));
      const res = routes[key]?.();
      if (!res) return Promise.reject(new Error('offline'));
      return Promise.resolve({ url, status: res.status, contentType: String(res.headers['content-type']), body: res.body, truncated: false });
    };

  it('builds YouTube, Steam and website cards from real-shaped responses, never inventing fields', async () => {
    const json = (o: unknown) => response(200, JSON.stringify(o), { 'content-type': 'application/json' });
    const service = new LinkPreviewService(
      {
        enabled: true,
        steamCountry: 'ru',
        steamLanguage: 'russian',
        fetcher: fakeFetch({
          'https://www.youtube.com/oembed': () =>
            json({ title: 'Rick Astley - Never Gonna Give You Up', author_name: 'Rick Astley', thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg', thumbnail_width: 480, thumbnail_height: 360 }),
          'https://store.steampowered.com/api/appdetails?appids=553850': () =>
            json({
              553850: {
                success: true,
                data: {
                  name: 'HELLDIVERS™ 2',
                  short_description: 'Галактическая армия',
                  header_image: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/553850/header.jpg',
                  price_overview: { final_formatted: '1999 руб.' },
                  is_free: false,
                },
              },
            }),
          'https://store.steampowered.com/api/appdetails?appids=1': () => json({ 1: { success: true, data: { name: 'No price game', is_free: false } } }),
          'https://store.steampowered.com/api/appdetails?appids=2&cc=ru': () => json({ 2: { success: false } }),
          'https://store.steampowered.com/api/appdetails?appids=2&cc=us': () => json({ 2: { success: true, data: { name: 'Not sold in RU', price_overview: { final_formatted: '$39.99' } } } }),
          'https://blog.example/post': () => response(200, '<meta property="og:title" content="Post"><meta property="og:description" content="Text">'),
          'https://empty.example/': () => response(200, '<html><body>nothing</body></html>'),
        }),
      },
      silentLog,
    );
    expect(await service.preview('https://youtu.be/dQw4w9WgXcQ')).toMatchObject({
      provider: 'youtube',
      siteName: 'YouTube',
      title: 'Rick Astley - Never Gonna Give You Up',
      author: 'Rick Astley',
      image: { url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg' },
    });
    expect(await service.preview('https://store.steampowered.com/app/553850/HELLDIVERS_2/')).toMatchObject({ provider: 'steam', title: 'HELLDIVERS™ 2', price: '1999 руб.', description: 'Галактическая армия' });
    expect((await service.preview('https://store.steampowered.com/app/1/'))?.price).toBeNull();
    // Not sold in the configured country: metadata from the US store, but no (foreign) price.
    expect(await service.preview('https://store.steampowered.com/app/2/')).toMatchObject({ title: 'Not sold in RU', price: null });
    expect(await service.preview('https://blog.example/post')).toMatchObject({ provider: 'website', title: 'Post', siteName: 'blog.example' });
    expect(await service.preview('https://empty.example/')).toBeNull();
    expect(await service.preview('https://down.example/')).toBeNull();
  });
});

describe('GIFs', () => {
  it('maps provider results and accepts only provider-hosted media', async () => {
    const tenorBody = {
      results: [
        {
          id: '123',
          itemurl: 'https://tenor.com/view/cat-123',
          content_description: 'cat',
          media_formats: { gif: { url: 'https://media.tenor.com/abc/cat.gif', dims: [498, 280] }, tinygif: { url: 'https://media.tenor.com/abc/tiny.gif', dims: [220, 124] } },
        },
      ],
    };
    const seen: string[] = [];
    const fetcher: typeof safeFetch = (url) => {
      seen.push(url);
      return Promise.resolve({ url, status: 200, contentType: 'application/json', body: Buffer.from(JSON.stringify(tenorBody)), truncated: false });
    };
    const gifs = new GifService('tenor', 'test-key', 'ru_RU', fetcher);
    const [first] = (await gifs.search('кот')).results;
    expect(first).toMatchObject({ provider: 'tenor', id: '123', media: { width: 498, height: 280 }, preview: { url: 'https://media.tenor.com/abc/tiny.gif' } });
    // Only the query (+ key / locale) goes to the provider.
    expect(seen[0]).toMatch(/^https:\/\/tenor\.googleapis\.com\/v2\/search\?q=%D0%BA%D0%BE%D1%82&limit=24&key=test-key/);
    expect(new GifService('none', '', 'ru_RU').enabled).toBe(false);

    const gif = { provider: 'tenor' as const, id: '123', url: 'https://tenor.com/view/cat-123', title: 'cat', media: { url: 'https://media.tenor.com/abc/cat.gif', width: 498, height: 280 }, preview: null };
    expect(validateGif(gif, 'tenor')).toMatchObject({ type: 'gif', provider: 'tenor' });
    expect(validateGif({ ...gif, media: { ...gif.media, url: 'https://evil.example/x.gif' } }, 'tenor')).toBeNull();
    expect(validateGif({ ...gif, media: { ...gif.media, url: 'http://media.tenor.com/x.gif' } }, 'tenor')).toBeNull();
    expect(validateGif(gif, 'giphy')).toBeNull();
  });
});

describe('GIF provider configuration and errors', () => {
  const jsonFetcher =
    (body: unknown): typeof safeFetch =>
    (url) =>
      Promise.resolve({ url, status: 200, contentType: 'application/json', body: Buffer.from(JSON.stringify(body)), truncated: false });
  const failing =
    (error: Error): typeof safeFetch =>
    () =>
      Promise.reject(error);

  it('server providers are tenor | giphy; KLIPY, unknown values and missing keys turn server GIFs off with a clear error', () => {
    expect(gifConfig('giphy', 'k', 'ru_RU')).toEqual({ provider: 'giphy', apiKey: 'k', locale: 'ru_RU', configError: null });
    expect(gifConfig('tenor', 'k', 'ru_RU').provider).toBe('tenor');
    expect(gifConfig('none', 'k', 'ru_RU')).toMatchObject({ provider: 'none', configError: null });
    const klipy = gifConfig('klipy', 'secret-key-123', 'ru_RU');
    expect(klipy).toMatchObject({ provider: 'none', apiKey: '' });
    expect(klipy.configError).toMatch(/klipy is not supported/);
    const unknown = gifConfig('gifcat', 'secret-key-123', 'ru_RU');
    expect(unknown).toMatchObject({ provider: 'none', apiKey: '' });
    expect(unknown.configError).toMatch(/GIF_PROVIDER "gifcat" is not supported/);
    for (const c of [klipy, unknown]) expect(c.configError).not.toContain('secret-key-123');
    expect(gifConfig('giphy', '', 'ru_RU').configError).toMatch(/GIF_API_KEY is empty/);
  });

  it('turns rate limits, timeouts, bad keys and invalid responses into clean provider errors without the key', async () => {
    const expectKind = async (fetcher: typeof safeFetch, kind: string, reason: RegExp) => {
      const error = await new GifService('giphy', 'super-secret-key', 'ru_RU', fetcher).search('q').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GifProviderError);
      expect(error).toMatchObject({ kind });
      expect((error as GifProviderError).reason).toMatch(reason);
      expect(JSON.stringify(error) + String(error)).not.toContain('super-secret-key');
    };
    await expectKind(failing(new Error('HTTP 429')), 'rate_limited', /rate limit/);
    await expectKind(failing(new FetchBlockedError('timeout')), 'unavailable', /timeout/);
    await expectKind(failing(new Error('HTTP 401')), 'unavailable', /API key/);
    await expectKind(failing(new Error('HTTP 503')), 'unavailable', /HTTP 503/);
    await expectKind(failing(new Error('getaddrinfo ENOTFOUND')), 'unavailable', /unreachable/);
    await expectKind(() => Promise.resolve({ url: 'x', status: 200, contentType: 'application/json', body: Buffer.from('<html>'), truncated: false }), 'unavailable', /invalid/);
    // A well-formed but empty answer is simply "no results".
    expect((await new GifService('giphy', 'k', 'ru_RU', jsonFetcher({ data: [] })).search('q')).results).toEqual([]);
  });

  it('accepts client-side KLIPY GIFs (KLIPY hosts only) and keeps their URLs byte for byte', () => {
    const media = 'https://static1.klipy.com/ii/a1b2/md/cat.webp?v=3&utm_source=partner&sig=AbC_-';
    const gif = {
      provider: 'klipy' as const,
      id: 'cat-dance-1',
      url: 'https://klipy.com/gifs/cat-dance-1',
      title: 'cat',
      media: { url: media, width: 480, height: 270 },
      preview: { url: 'https://static2.klipy.com/ii/a1b2/sm/cat.webp?x=1', width: 220, height: 124 },
    };
    // Accepted whatever the server-side provider is (KLIPY never runs on the server).
    for (const server of ['none', 'tenor', 'giphy'] as const) expect(validateGif(gif, server)?.media.url).toBe(media);
    expect(validateGif(gif, 'none')?.preview?.url).toBe('https://static2.klipy.com/ii/a1b2/sm/cat.webp?x=1');
    expect(validateGif({ ...gif, media: { ...gif.media, url: 'https://static.klipy.com.evil.example/x.webp' } }, 'none')).toBeNull();
    expect(validateGif({ ...gif, media: { ...gif.media, url: 'http://static.klipy.com/x.webp' } }, 'none')).toBeNull();
    expect(validateGif({ ...gif, url: 'https://evil.example/gifs/x' }, 'none')).toBeNull();
    // Tenor / GIPHY still need to be the server's configured provider.
    expect(validateGif({ ...gif, provider: 'tenor', media: { ...gif.media, url: 'https://media.tenor.com/a.gif' }, preview: null, url: 'https://tenor.com/view/a' }, 'none')).toBeNull();
  });
});

describe('GIF configuration through the API', () => {
  it('GIF_PROVIDER=klipy or an unknown value keeps the backend running; the server never searches KLIPY', async () => {
    for (const provider of ['klipy', 'gifcat']) {
      const env = await createTestEnv({ GIF_PROVIDER: provider, GIF_API_KEY: 'k' });
      try {
        await createUser(env, 'Carol');
        const carol = await login(env, 'Carol');
        const res = await env.app.inject({ method: 'GET', url: '/api/v1/gifs?q=cat', headers: bearer(carol.accessToken) });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ enabled: false, provider: null, results: [], nextPage: null });
        expect((await env.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
      } finally {
        await env.close();
      }
    }
  });
});

describe('embeds through the API', () => {
  let env: TestEnv;
  let baseUrl: string;
  let alice: LoginResult;
  let bob: LoginResult;
  let channelId: string;

  beforeAll(async () => {
    env = await createTestEnv({ GIF_PROVIDER: 'tenor', GIF_API_KEY: 'test-key' });
    await createUser(env, 'Alice');
    await createUser(env, 'Bob');
    alice = await login(env, 'Alice');
    bob = await login(env, 'Bob');
    channelId = await getVoiceChannelId(env);
    baseUrl = await listen(env);
  });
  afterAll(async () => {
    await env.close();
  });

  it('sends a GIF as a structured embed (no upload), persisted, with proxied image URLs', async () => {
    const res = await env.app.inject({
      method: 'POST',
      url: `/api/v1/channels/${channelId}/messages`,
      headers: bearer(alice.accessToken),
      payload: { gif: { provider: 'tenor', id: '123', url: 'https://tenor.com/view/cat-123', title: 'cat', media: { url: 'https://media.tenor.com/abc/cat.gif', width: 498, height: 280 }, preview: null } },
    });
    expect(res.statusCode).toBe(201);
    const embed = res.json<{ message: { content: string; embeds: { type: string; media: { url: string; width: number } }[] } }>().message.embeds[0];
    expect(embed?.type).toBe('gif');
    expect(embed?.media.width).toBe(498);
    expect(embed?.media.url).toMatch(/^\/api\/v1\/embeds\/image\?u=.+&s=.+/);
    const history = await env.app.inject({ method: 'GET', url: `/api/v1/channels/${channelId}/messages`, headers: bearer(bob.accessToken) });
    expect(history.json<{ messages: { embeds: unknown[] }[] }>().messages.at(-1)?.embeds).toHaveLength(1);

    const bad = await env.app.inject({
      method: 'POST',
      url: `/api/v1/channels/${channelId}/messages`,
      headers: bearer(alice.accessToken),
      payload: { gif: { provider: 'tenor', id: '1', url: 'https://tenor.com/view/x', media: { url: 'https://evil.example/x.gif', width: 1, height: 1 } } },
    });
    expect(bad.json<{ error: { code: string } }>().error.code).toBe('INVALID_GIF');
  });

  it('stores a client-side KLIPY GIF with its exact KLIPY URLs (never proxied) for every reader', async () => {
    const media = 'https://static1.klipy.com/ii/a1b2/md/cat.webp?v=3&utm_source=partner';
    const preview = 'https://static2.klipy.com/ii/a1b2/sm/cat.webp?v=3';
    const res = await env.app.inject({
      method: 'POST',
      url: `/api/v1/channels/${channelId}/messages`,
      headers: bearer(alice.accessToken),
      payload: {
        gif: { provider: 'klipy', id: 'cat-dance-1', url: 'https://klipy.com/gifs/cat-dance-1', title: 'cat', media: { url: media, width: 480, height: 270 }, preview: { url: preview, width: 220, height: 124 } },
      },
    });
    expect(res.statusCode).toBe(201);
    const sent = res.json<{ message: { embeds: { provider: string; media: { url: string }; preview: { url: string } }[] } }>().message.embeds[0];
    expect(sent).toMatchObject({ provider: 'klipy', media: { url: media }, preview: { url: preview } });
    const history = await env.app.inject({ method: 'GET', url: `/api/v1/channels/${channelId}/messages`, headers: bearer(bob.accessToken) });
    const reloaded = history.json<{ messages: { embeds: { media: { url: string }; preview: { url: string } }[] }[] }>().messages.at(-1)?.embeds[0];
    expect(reloaded?.media.url).toBe(media);
    expect(reloaded?.preview.url).toBe(preview);
  });

  it('image proxy: unsigned URLs are refused, signed private addresses are blocked (SSRF)', async () => {
    const signer = new ImageSigner('test-access-secret-0123456789abcdef0123456789');
    const target = 'http://127.0.0.1:3000/api/v1/health';
    const forged = await env.app.inject({ method: 'GET', url: `/api/v1/embeds/image?u=${Buffer.from(target).toString('base64url')}&s=${'x'.repeat(32)}` });
    expect(forged.statusCode).toBe(403);
    const signedLocal = await env.app.inject({ method: 'GET', url: signer.proxyPath(target) });
    expect(signedLocal.statusCode).toBe(502);
    const signedLan = await env.app.inject({ method: 'GET', url: signer.proxyPath('http://192.168.1.57/a.png') });
    expect(signedLan.statusCode).toBe(502);
  });

  it('delivers the message at once and adds the link card afterwards (message.updated)', async () => {
    const previews = new LinkPreviewService(
      {
        enabled: true,
        steamCountry: 'ru',
        steamLanguage: 'russian',
        fetcher: (url) =>
          new Promise((resolve) => {
            setTimeout(() => {
              resolve({ url, status: 200, contentType: 'text/html', body: Buffer.from('<meta property="og:title" content="Slow page">'), truncated: false });
            }, 300);
          }),
      },
      silentLog,
    );
    (env.ctx.services.messages as unknown as { previews: LinkPreviewService }).previews = previews;
    const socket = connectSocket(baseUrl, bob.accessToken);
    await waitForEvent(socket, 'ready');
    const created = waitForEvent<{ embeds: unknown[] }>(socket, 'message.created');
    const updated = waitForEvent<{ embeds: { title: string }[] }>(socket, 'message.updated');
    const t0 = Date.now();
    const res = await env.app.inject({ method: 'POST', url: `/api/v1/channels/${channelId}/messages`, headers: bearer(alice.accessToken), payload: { content: 'look https://slow.example/page' } });
    expect(res.statusCode).toBe(201);
    expect(Date.now() - t0).toBeLessThan(300); // not held back by the slow site
    expect((await created).embeds).toEqual([]);
    expect((await updated).embeds[0]?.title).toBe('Slow page');
    socket.close();
  });
});
