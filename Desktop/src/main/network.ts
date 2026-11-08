import type { Session } from 'electron';
import { RENDERER_ORIGIN } from './config';

/**
 * CORS bridge for the chosen AIDis server, so servers do not need to know the desktop origin.
 *
 * The bundled client runs on aidis://app; a server's CORS list only contains its own web origin.
 * For requests that our renderer sends to the CURRENT server (fetch, Socket.IO polling and its
 * WebSocket upgrade) the main process presents the server's own origin and maps the answer back to
 * the renderer origin. Other hosts, other origins and every other header pass through unchanged,
 * and Chromium still enforces CORS.
 */
const FILTER = { urls: ['https://*/*', 'wss://*/*', 'http://localhost/*', 'ws://localhost/*', 'http://127.0.0.1/*', 'ws://127.0.0.1/*'] };

/** Pure: is this request for the server (its https:// or wss:// origin)? */
export function isServerRequest(url: string, apiOrigin: string | null): boolean {
  if (!apiOrigin) return false;
  try {
    const origin = new URL(url).origin;
    return origin === apiOrigin || origin === apiOrigin.replace(/^http/, 'ws');
  } catch {
    return false;
  }
}

/** Pure: request headers with the renderer Origin replaced by the server origin. */
export function rewriteRequestOrigin(headers: Record<string, string>, apiOrigin: string): Record<string, string> {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'origin');
  if (!key || headers[key] !== RENDERER_ORIGIN) return headers;
  const next = Object.fromEntries(Object.entries(headers).filter(([k]) => k !== key));
  next.Origin = apiOrigin;
  return next;
}

/** Pure: response headers with Access-Control-Allow-Origin mapped back to the renderer origin. */
export function rewriteResponseOrigin(headers: Record<string, string[]>, apiOrigin: string): Record<string, string[]> {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'access-control-allow-origin');
  if (!key || headers[key]?.[0] !== apiOrigin) return headers;
  return { ...headers, [key]: [RENDERER_ORIGIN] };
}

export function installApiCorsBridge(session: Session, apiOrigin: () => string | null): void {
  session.webRequest.onBeforeSendHeaders(FILTER, (details, callback) => {
    const origin = apiOrigin();
    callback({ requestHeaders: origin && isServerRequest(details.url, origin) ? rewriteRequestOrigin(details.requestHeaders, origin) : details.requestHeaders });
  });
  session.webRequest.onHeadersReceived(FILTER, (details, callback) => {
    const origin = apiOrigin();
    callback({ responseHeaders: origin && details.responseHeaders && isServerRequest(details.url, origin) ? rewriteResponseOrigin(details.responseHeaders, origin) : details.responseHeaders });
  });
}
