/**
 * 0.5.0 webcam: device list, capability-based presets, opening a camera and readable errors.
 *
 * Only the standard MediaDevices / getUserMedia API (no Electron API): the web client and a future
 * mobile client reuse this as it is. The camera is opened only from the camera picker (an explicit
 * user action) and never at startup; the preferred device is remembered, never started.
 */
import type { CameraFps, CameraResolution } from '../stores/settingsStore';

export interface CameraDevice {
  deviceId: string;
  label: string;
}

export interface CameraPreset {
  resolution: CameraResolution;
  fps: CameraFps;
  width: number;
  height: number;
  frameRate: number;
}

export const CAMERA_RESOLUTIONS: Record<CameraResolution, { width: number; height: number }> = {
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
};

export type CameraErrorCode = 'denied' | 'busy' | 'notFound' | 'unsupported' | 'failed';

export class CameraError extends Error {
  readonly code: CameraErrorCode;
  constructor(code: CameraErrorCode) {
    super(code);
    this.code = code;
    this.name = 'CameraError';
  }
}

export function canUseCamera(): boolean {
  // mediaDevices is missing outside secure contexts.
  return typeof navigator !== 'undefined' && 'mediaDevices' in navigator && typeof navigator.mediaDevices.getUserMedia === 'function';
}

/** getUserMedia errors -> what the user can act on. Pure. */
export function cameraErrorCode(error: unknown): CameraErrorCode {
  const name = typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'denied';
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return 'busy';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') return 'notFound';
  if (name === 'TypeError') return 'unsupported';
  return 'failed';
}

/** Video inputs (labels appear once the user allowed the camera at least once). */
export async function listCameras(): Promise<CameraDevice[]> {
  if (!canUseCamera()) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  let n = 0;
  return devices
    .filter((d) => d.kind === 'videoinput')
    .map((d) => ({ deviceId: d.deviceId, label: phoneCameraLabel(d.label) ?? (d.label || `Camera ${(n += 1)}`) }));
}

/**
 * 0.5.1: Android reports cameras as "camera2 1, facing front"; show them as Front / Rear camera
 * (the picker switches between them). Other labels are kept.
 */
export function phoneCameraLabel(label: string): string | null {
  const facing = /facing (front|back)/i.exec(label)?.[1]?.toLowerCase();
  if (!facing) return null;
  const ru = typeof document !== 'undefined' && document.documentElement.lang.startsWith('ru');
  if (facing === 'front') return ru ? 'Фронтальная камера' : 'Front camera';
  return ru ? 'Основная (задняя) камера' : 'Rear camera';
}

/** Opens a camera (720p30 to start the preview). Throws CameraError. */
export async function openCamera(deviceId: string | null, preset?: Pick<CameraPreset, 'width' | 'height' | 'frameRate'>): Promise<MediaStreamTrack> {
  if (!canUseCamera()) throw new CameraError('unsupported');
  const size = preset ?? { ...CAMERA_RESOLUTIONS['720p'], frameRate: 30 };
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        width: { ideal: size.width },
        height: { ideal: size.height },
        frameRate: { ideal: size.frameRate },
      },
    });
    const track = stream.getVideoTracks()[0];
    if (!track) throw new CameraError('notFound');
    track.contentHint = 'motion';
    return track;
  } catch (error) {
    if (error instanceof CameraError) throw error;
    throw new CameraError(cameraErrorCode(error));
  }
}

/**
 * Presets this camera can really deliver, from its reported capabilities (720p30 always; 1080p and
 * 60 FPS only when the device reports them). Without capability information only 720p30 / 30 is
 * offered (no options the device may not provide). Pure.
 */
export function presetsFor(caps: { width?: { max?: number }; height?: { max?: number }; frameRate?: { max?: number } } | null): CameraPreset[] {
  const maxW = caps?.width?.max ?? 1280;
  const maxH = caps?.height?.max ?? 720;
  const maxFps = caps?.frameRate?.max ?? 30;
  const out: CameraPreset[] = [];
  for (const resolution of ['720p', '1080p'] as const) {
    const size = CAMERA_RESOLUTIONS[resolution];
    if (resolution === '1080p' && (maxW < size.width || maxH < size.height)) continue;
    for (const fps of [30, 60] as const) {
      if (fps === 60 && maxFps < 59) continue;
      out.push({ resolution, fps, ...size, frameRate: fps });
    }
  }
  return out;
}

export function trackCapabilities(track: MediaStreamTrack): ReturnType<MediaStreamTrack['getCapabilities']> | null {
  try {
    return typeof track.getCapabilities === 'function' ? track.getCapabilities() : null;
  } catch {
    return null;
  }
}
