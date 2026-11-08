import { t } from '../i18n';
import { toast, useUiStore } from '../stores/uiStore';
import { useVoiceStore } from '../voice/voiceStore';
import { voice } from '../voice/voiceService';
import { desktop } from './bridge';
import { STREAM_RESOLUTIONS, streamBitrateMbps, streamDegradation, type StreamingSettings } from './contract';
import { useDesktopStore } from './desktopStore';
import { startAppAudio, type AppAudioCapture } from './appAudio';

/**
 * Desktop screen sharing. The flow is:
 *   1. our own source picker (screens + windows with thumbnails) -> sourceId + "system audio";
 *   2. the main process is armed with that choice (capture.select);
 *   3. getDisplayMedia() with exact resolution / frame-rate limits; Electron's display-media
 *      handler answers it with the armed source (+ Windows loopback audio);
 *   4. voice.publishScreenShare() publishes video (ScreenShare) and audio (ScreenShareAudio).
 * `restrictOwnAudio` keeps AIDis' own output (other people's voices, UI sounds) out of the
 * captured system audio, so viewers never hear the call echoed back.
 */

let lastSourceId: string | null = null;

/** Opens the picker in the desktop app, or the browser's own dialog on the web. */
export function requestScreenShare(): void {
  if (desktop) {
    useUiStore.getState().setSourcePicker(true);
    return;
  }
  void voice.startScreenShare();
}

/**
 * 0.4.1 "Stream <game>": asks the desktop app which capture source is the detected game's window
 * (matched by process: Steam folder or executable; the exact title only as a fallback) and opens
 * the normal picker with it preselected. Nothing starts without the user pressing "Share". If the
 * window is not found, the picker opens as usual.
 */
export async function requestGameStream(): Promise<boolean> {
  if (!desktop) return false;
  const find = desktop.capture.findGameSource?.() ?? Promise.resolve(null);
  const sourceId = await find.catch(() => null);
  useUiStore.getState().setSourcePicker(true, 'start', sourceId);
  return sourceId !== null;
}

/** Capture polling rate for a stream rate (see captureConstraints). */
export function captureFrameRate(streamFps: number): number {
  return Math.min(120, streamFps * 2);
}

export function captureConstraints(streaming: StreamingSettings, audio: boolean): DisplayMediaStreamOptions {
  const { width, height } = STREAM_RESOLUTIONS[streaming.resolution];
  const audioConstraints = {
    restrictOwnAudio: true,
    suppressLocalAudioPlayback: false,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 2,
  } as MediaTrackConstraints;
  return {
    // "max" keeps the source's aspect ratio; a smaller window or screen is never upscaled.
    video: {
      width: { max: width },
      height: { max: height },
      // Chromium polls Windows Graphics Capture at the track's frame rate and keeps only frames that
      // are new. Polling at 60 Hz against a 60 FPS game aliases: depending on the phase it delivers
      // anywhere from ~33 to ~57 FPS and drifts (e.g. after Alt+Tab). 0.4.5: the track itself runs
      // at twice the stream rate (the old { ideal: 60, max: 120 } still settled on 60); the encoder
      // (maxFramerate) sends at most the chosen FPS, so the stream is never inflated.
      frameRate: { ideal: captureFrameRate(streaming.frameRate), max: captureFrameRate(streaming.frameRate) },
    },
    audio: audio ? audioConstraints : false,
  };
}

function publishOptions(streaming: StreamingSettings) {
  return {
    frameRate: streaming.frameRate,
    maxBitrate: Math.round(streamBitrateMbps(streaming) * 1_000_000),
    contentMode: streaming.contentMode,
    // 0.4.2: every start, source switch and quality change carries the same priority.
    degradation: streamDegradation(streaming),
    width: STREAM_RESOLUTIONS[streaming.resolution].width,
    height: STREAM_RESOLUTIONS[streaming.resolution].height,
    // 0.4.6: the desktop app streams with the GPU's hardware H.264 encoder when it really is
    // hardware (checked after publishing; otherwise VP8). No setting: AIDis picks automatically.
    codec: 'h264' as const,
  };
}

/** 0.4.5 stream audio: only the captured application, the whole system mix, or none. */
export type StreamAudio = 'app' | 'system' | 'none';

/** The audio a share of this source gets with these settings (screens never get 'app'). Pure. */
export function streamAudioFor(sourceId: string, streaming: Pick<StreamingSettings, 'systemAudio' | 'appAudio'>): StreamAudio {
  if (!streaming.systemAudio) return 'none';
  return kindOf(sourceId) === 'window' && streaming.appAudio ? 'app' : 'system';
}

/** The application-audio capture of the current share (stopped when the share ends or is replaced). */
let appAudio: AppAudioCapture | null = null;
function setAppAudio(next: AppAudioCapture | null): void {
  if (appAudio && appAudio !== next) appAudio.stop();
  appAudio = next;
}
useVoiceStore.subscribe((s, prev) => {
  if (prev.localScreenSharing && !s.localScreenSharing) setAppAudio(null);
});

async function capture(sourceId: string, mode: StreamAudio | boolean, streaming: StreamingSettings): Promise<MediaStream | null> {
  if (!desktop) return null;
  const want: StreamAudio = mode === true ? streamAudioFor(sourceId, { systemAudio: true, appAudio: streaming.appAudio }) : mode === false ? 'none' : mode;
  const stream = await captureRaw(sourceId, want === 'system', streaming);
  if (!stream || want !== 'app') return stream;
  const { capture: app, reason } = await startAppAudio(sourceId);
  if (app) {
    stream.addTrack(app.track);
    pendingAppAudio = app;
    return stream;
  }
  desktop.app.log('warn', `Application audio unavailable: ${reason ?? 'unknown'}`);
  // Never switch to the whole system mix silently: ask.
  if (window.confirm(t('desktop.capture.appAudioUnavailable'))) {
    for (const track of stream.getTracks()) track.stop();
    return captureRaw(sourceId, true, streaming);
  }
  toast.info(t('desktop.capture.noAudioSent'), 'screen-audio');
  return stream;
}

/** Set by capture() for the share that is being started / switched to. */
let pendingAppAudio: AppAudioCapture | null = null;
function commitAppAudio(ok: boolean): void {
  const next = pendingAppAudio;
  pendingAppAudio = null;
  if (ok) setAppAudio(next);
  else next?.stop();
}

async function captureRaw(sourceId: string, audio: boolean, streaming: StreamingSettings): Promise<MediaStream | null> {
  if (!desktop) return null;
  const armed = await desktop.capture.select({ sourceId, audio }).catch(() => false);
  if (!armed) {
    toast.warning(t('desktop.capture.sourceGone'), 'screen-share');
    return null;
  }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia(captureConstraints(streaming, audio));
    if (audio && stream.getAudioTracks().length === 0) toast.info(t('desktop.capture.noSystemAudio'), 'screen-audio');
    return stream;
  } catch (error) {
    const name = error instanceof Error || error instanceof DOMException ? error.name : '';
    const kind = kindOf(sourceId);
    desktop.app.log('warn', `Screen capture failed: ${kind}, ${name || 'unknown error'}`);
    toast.error(name === 'NotReadableError'
      ? t(kind === 'window' ? 'desktop.capture.windowUnavailable' : 'desktop.capture.busy')
      : t('voice.errors.screenFailed'), 'screen-share');
    return null;
  }
}

const kindOf = (sourceId: string): 'screen' | 'window' => (sourceId.startsWith('screen:') ? 'screen' : 'window');

export async function startDesktopShare(sourceId: string, audio: boolean): Promise<boolean> {
  if (!desktop) return false;
  if (useVoiceStore.getState().status !== 'connected') return false;
  const streaming = useDesktopStore.getState().settings.streaming;
  const stream = await capture(sourceId, audio, streaming);
  if (!stream) return false;
  lastSourceId = sourceId;
  const ok = await voice.publishScreenShare(stream, publishOptions(streaming), { sourceId, sourceKind: kindOf(sourceId) });
  commitAppAudio(ok);
  return ok;
}

/**
 * "Change stream" while sharing (0.3.1). Same source and same audio choice: only constraints and
 * sender limits change (no new capture, no flicker). Another window/screen or audio on/off: a new
 * capture replaces the tracks inside the running publications, so viewers keep watching.
 */
export async function changeDesktopShare(sourceId: string, audio: boolean): Promise<boolean> {
  if (!desktop) return false;
  const state = useVoiceStore.getState();
  if (state.status !== 'connected') return false;
  if (!state.localScreenSharing) return startDesktopShare(sourceId, audio);
  const streaming = useDesktopStore.getState().settings.streaming;
  const current = state.shareConfig;
  if (current?.sourceId === sourceId && current.systemAudio === audio) {
    const { width, height } = STREAM_RESOLUTIONS[streaming.resolution];
    return voice.updateScreenShareQuality(publishOptions(streaming), { width, height }, captureFrameRate(streaming.frameRate));
  }
  const stream = await capture(sourceId, audio, streaming);
  if (!stream) return false;
  lastSourceId = sourceId;
  const ok = await voice.replaceScreenShare(stream, publishOptions(streaming), { sourceId, sourceKind: kindOf(sourceId) });
  commitAppAudio(ok);
  return ok;
}

/**
 * Global hotkey: stop the current share, or start sharing again without the picker (the app may
 * be behind a game). Uses the last shared source if it still exists, else the primary screen.
 */
export async function toggleScreenShareFromHotkey(): Promise<void> {
  if (!desktop) return;
  const state = useVoiceStore.getState();
  if (state.localScreenSharing) {
    await voice.stopScreenShare();
    return;
  }
  if (state.status !== 'connected') return;
  const sources = await desktop.capture.getSources().catch(() => []);
  const source = sources.find((s) => s.id === lastSourceId) ?? sources.find((s) => s.kind === 'screen');
  if (!source) return;
  await startDesktopShare(source.id, useDesktopStore.getState().settings.streaming.systemAudio);
}
