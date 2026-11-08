/**
 * Screen-share quality presets. The browser build uses DEFAULT_SCREEN_SHARE_QUALITY:
 * getDisplayMedia treats resolution/frame rate as hints, so the web UI does not promise
 * exact modes. A future Electron build (desktopCapturer + explicit constraints) can expose
 * the whole list in a picker without changing the voice service.
 */
export interface ScreenShareQuality {
  id: '720p30' | '720p60' | '1080p30' | '1080p60' | '1440p60';
  label: string;
  width: number;
  height: number;
  frameRate: number;
  /** Upper bound for the encoder, bits per second. */
  maxBitrate: number;
}

export const SCREEN_SHARE_QUALITIES: readonly ScreenShareQuality[] = [
  { id: '720p30', label: '720p 30 fps', width: 1280, height: 720, frameRate: 30, maxBitrate: 2_000_000 },
  { id: '720p60', label: '720p 60 fps', width: 1280, height: 720, frameRate: 60, maxBitrate: 3_500_000 },
  { id: '1080p30', label: '1080p 30 fps', width: 1920, height: 1080, frameRate: 30, maxBitrate: 3_500_000 },
  { id: '1080p60', label: '1080p 60 fps', width: 1920, height: 1080, frameRate: 60, maxBitrate: 6_000_000 },
  { id: '1440p60', label: '1440p 60 fps', width: 2560, height: 1440, frameRate: 60, maxBitrate: 9_000_000 },
];

export const DEFAULT_SCREEN_SHARE_QUALITY: ScreenShareQuality = SCREEN_SHARE_QUALITIES[2] ?? {
  id: '1080p30',
  label: '1080p 30 fps',
  width: 1920,
  height: 1080,
  frameRate: 30,
  maxBitrate: 3_500_000,
};

/** True when this browser can capture the screen at all (mobile browsers usually cannot). */
export function canShareScreen(): boolean {
  // 0.5.9: iPhone / iPad Safari cannot capture the screen even where the function exists.
  if (isIosDevice) return false;
  return typeof navigator !== 'undefined' && typeof (navigator.mediaDevices as MediaDevices | undefined)?.getDisplayMedia === 'function';
}
import { isIosDevice } from '../pwa/webApp';
