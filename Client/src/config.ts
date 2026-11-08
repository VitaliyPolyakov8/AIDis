/**
 * Public runtime configuration. Everything here ends up in the browser bundle,
 * so it must never contain secrets.
 *
 * The API origin is resolved once and can be overridden at runtime
 * (the desktop app points the same UI at the server the user picked).
 */

declare const __APP_VERSION__: string;

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function numberEnv(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

let apiOrigin = trimSlash(import.meta.env.VITE_API_URL ?? '');

export const config = {
  appName: import.meta.env.VITE_APP_NAME || 'AIDis',
  clientVersion: __APP_VERSION__,
  livekitUrl: trimSlash(import.meta.env.VITE_LIVEKIT_URL ?? ''),
  maxMessageLength: numberEnv(import.meta.env.VITE_MAX_MESSAGE_LENGTH, 4000),
  maxUploadBytes: numberEnv(import.meta.env.VITE_MAX_UPLOAD_MB, 50) * 1024 * 1024,
  /** Value sent as `clientType` on login. Electron will use "desktop". */
  clientType: 'web' as 'web' | 'desktop' | 'android',
  /**
   * 0.5.1: what this client tells the realtime server it is (desktop / web / android), for the
   * device icons next to names. Set explicitly by the desktop shell and the Android app at
   * startup; never guessed from the user agent.
   */
  platform: 'web' as 'web' | 'desktop' | 'android' | 'ios',
};

/** "" means same origin (relative URLs). */
export function getApiOrigin(): string {
  return apiOrigin;
}

/** Lets a host shell (e.g. Electron) point the client at another backend before startup. */
export function setApiOrigin(origin: string): void {
  apiOrigin = trimSlash(origin);
}

/** Builds an absolute or same-origin URL for a server path such as "/api/v1/users". */
export function apiUrl(path: string): string {
  return `${apiOrigin}${path}`;
}
