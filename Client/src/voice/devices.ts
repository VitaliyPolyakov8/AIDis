import { t } from '../i18n';
import { isDesktop } from '../desktop/bridge';

/** Thin wrappers over navigator.mediaDevices that never throw. */

export interface DeviceOption {
  deviceId: string;
  label: string;
}

export function mediaDevicesSupported(): boolean {
  return typeof navigator !== 'undefined' && !!(navigator.mediaDevices as MediaDevices | undefined)?.enumerateDevices;
}

/** Browsers hide labels until microphone permission was granted once. */
export async function listDevices(kind: 'audioinput' | 'audiooutput'): Promise<DeviceOption[]> {
  if (!mediaDevicesSupported()) return [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    let index = 0;
    return devices
      .filter((d) => d.kind === kind && d.deviceId !== '')
      .map((d) => {
        index += 1;
        const fallback = kind === 'audioinput' ? t('mic.defaultMic', { n: index }) : t('mic.defaultSpeaker', { n: index });
        return { deviceId: d.deviceId, label: d.label || fallback };
      });
  } catch {
    return [];
  }
}

/** Chromium supports choosing the output device (HTMLMediaElement.setSinkId); Firefox/Safari mostly do not. */
export function canSelectOutputDevice(): boolean {
  return typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
}

export function onDeviceChange(handler: () => void): () => void {
  if (!mediaDevicesSupported()) return () => undefined;
  navigator.mediaDevices.addEventListener('devicechange', handler);
  return () => {
    navigator.mediaDevices.removeEventListener('devicechange', handler);
  };
}

export type MediaErrorKind = 'denied' | 'notfound' | 'busy' | 'insecure' | 'unsupported' | 'unknown';

export function classifyMediaError(error: unknown): MediaErrorKind {
  if (typeof window !== 'undefined' && !window.isSecureContext) return 'insecure';
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'denied';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') return 'notfound';
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return 'busy';
  if (name === 'TypeError' || name === 'NotSupportedError') return 'unsupported';
  return 'unknown';
}

export function microphoneErrorMessage(error: unknown): string {
  const kind = classifyMediaError(error);
  // In the desktop app there is no address bar: "denied" means Windows privacy settings block it.
  if (kind === 'denied' && isDesktop) return t('mic.deniedDesktop');
  return t(`mic.${kind}`);
}
