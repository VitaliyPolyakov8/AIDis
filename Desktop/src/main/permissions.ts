import type { Session } from 'electron';
import { RENDERER_ORIGIN } from './config';
import { logger } from './logger';

/**
 * Only our own page gets permissions, and only the ones AIDis uses:
 * microphone, camera (0.5.0: only requested from the camera picker, after the user clicked
 * "Camera"; never at startup), screen capture (answered by our picker), notifications, fullscreen
 * for the stream viewer, clipboard write and output-device selection.
 */
const ALLOWED_REQUESTS = new Set(['media', 'display-capture', 'notifications', 'fullscreen', 'clipboard-sanitized-write', 'speaker-selection']);
const ALLOWED_CHECKS = new Set([...ALLOWED_REQUESTS, 'media']);
/** getUserMedia kinds AIDis asks for: microphone and (0.5.0) camera. */
const MEDIA_TYPES = new Set<string>(['audio', 'video']);

/** scheme://host[:port]. Node's URL#origin is "null" for custom schemes like aidis://, so build it by hand. */
export function originOf(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

export function isRendererUrl(url: string | undefined | null): boolean {
  return originOf(url) === RENDERER_ORIGIN;
}

export function installPermissionHandlers(session: Session): void {
  session.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    let allowed = ALLOWED_REQUESTS.has(permission) && isRendererUrl(details.requestingUrl);
    if (allowed && permission === 'media') {
      const types = 'mediaTypes' in details ? (details.mediaTypes ?? []) : [];
      allowed = types.every((type) => MEDIA_TYPES.has(type));
    }
    if (!allowed) logger.warn('permissions', `Denied ${permission}`);
    callback(allowed);
  });
  session.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    return ALLOWED_CHECKS.has(permission) && originOf(requestingOrigin) === RENDERER_ORIGIN;
  });
  session.setDevicePermissionHandler(() => false);
}
