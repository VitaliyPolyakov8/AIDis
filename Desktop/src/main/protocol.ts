import { net, protocol } from 'electron';
import { existsSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DesktopServer } from '../../../Client/src/desktop/contract';
import { APP_SCHEME, RENDERER_DIR } from './config';
import { logger } from './logger';

/**
 * Serves the bundled React client from aidis://app/ (production only), with the CSP of the chosen server.
 *
 * The scheme is registered as standard + secure, so the page is a secure context (microphone and
 * screen capture work), has a real origin ("aidis://app") and BrowserRouter paths work: any path
 * without a file extension falls back to index.html. Requests can never escape RENDERER_DIR.
 */

/** Official Steam store artwork (header / capsule), only when the server allows it (STEAM_ART). Images only. */
const STEAM_MEDIA_ORIGINS = 'https://cdn.cloudflare.steamstatic.com https://shared.cloudflare.steamstatic.com https://cdn.akamai.steamstatic.com https://shared.akamai.steamstatic.com';

function wsOf(origin: string): string {
  return origin.replace(/^http/, 'ws');
}

/**
 * Pure: the CSP of the packaged app for the server the user picked. Without a server the page may
 * only reach itself (the "server address" screen talks to the main process, not the network).
 * With one: that server (HTTP + WebSocket), its LiveKit and the subdomains of its voice domain
 * (extra voice servers); nothing broader is ever allowed.
 */
export function buildCsp(server: DesktopServer | null): string {
  const origin = server?.origin ?? '';
  const connect = ["'self'"];
  if (server) {
    connect.push(origin, wsOf(origin));
    const lk = server.config.livekitUrl;
    if (lk) {
      const ws = new URL(lk).origin;
      connect.push(ws, ws.replace(/^ws/, 'http'));
    }
    const domain = server.config.voiceNodeDomain;
    if (domain) connect.push(`wss://*.${domain}`, `https://*.${domain}`);
  }
  const unique = [...new Set(connect)];
  return [
    "default-src 'self'",
    // 'wasm-unsafe-eval': only WebAssembly compilation (RNNoise noise suppression), not JS eval.
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    // Link-preview / GIF images come through the server's image proxy.
    `img-src 'self' data: blob:${server ? ` ${origin}` : ''}${server?.config.steamArt ? ` ${STEAM_MEDIA_ORIGINS}` : ''}`,
    // Videos and audio stream from the API with signed links (Range requests).
    `media-src 'self' blob: mediastream:${server ? ` ${origin}` : ''}`,
    "font-src 'self' data:",
    `connect-src ${unique.join(' ')}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** Must run before app 'ready'. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true },
    },
  ]);
}

/**
 * Pure: maps a request URL to a file inside `root`, or null when it must not be served.
 * Unknown extension-less paths (client routes like /channels/abc) resolve to index.html.
 */
export function resolveAppFile(root: string, requestUrl: string, exists: (file: string) => boolean): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.host !== 'app') return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (pathname.includes('\0')) return null;
  const base = resolve(root);
  const target = resolve(base, `.${pathname}`);
  if (target !== base && !target.startsWith(base + sep)) return null;
  if (target !== base && exists(target)) return target;
  if (extname(pathname) === '') return resolve(base, 'index.html');
  return null;
}

function isFile(file: string): boolean {
  try {
    return existsSync(file) && statSync(file).isFile();
  } catch {
    return false;
  }
}

export function handleAppScheme(currentServer: () => DesktopServer | null): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const file = resolveAppFile(RENDERER_DIR, request.url, isFile);
    if (!file) return new Response('Not found', { status: 404 });
    try {
      const response = await net.fetch(pathToFileURL(file).toString());
      const headers = new Headers(response.headers);
      headers.set('Content-Security-Policy', buildCsp(currentServer()));
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('Referrer-Policy', 'no-referrer');
      if (file.endsWith('index.html')) headers.set('Cache-Control', 'no-cache');
      return new Response(response.body, { status: response.status, headers });
    } catch (error) {
      logger.error('protocol', `Failed to serve ${extname(file) || 'file'}`, error);
      return new Response('Error', { status: 500 });
    }
  });
}
