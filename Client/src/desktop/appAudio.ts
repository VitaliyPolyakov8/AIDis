import playerUrl from '../voice/pcmPlayer.worklet.js?url&no-inline';
import { desktop } from './bridge';

/**
 * 0.4.5 application-only stream audio (desktop app, Windows).
 *
 * The desktop app runs a small helper that uses the documented Windows process-loopback API to
 * capture ONLY the chosen window's process (and its children): no system mix, no injection.
 * Its PCM arrives here over a MessagePort and is turned into an ordinary audio track, which is
 * published as the stream's audio exactly like system audio was.
 */
export interface AppAudioCapture {
  track: MediaStreamTrack;
  stop(): void;
}

let pendingPort: ((port: MessagePort) => void) | null = null;
// The shell has one helper: starting B replaces A before A's track is released by LiveKit.
// Only the latest capture may stop that helper; older captures still release their own graph.
let helperOwner: symbol | null = null;
if (typeof window !== 'undefined') {
  // The preload forwards the port with window.postMessage (ports cannot cross contextBridge).
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window || event.data !== 'aidis-app-audio-port' || !event.ports[0]) return;
    pendingPort?.(event.ports[0]);
    pendingPort = null;
  });
}

/** Starts application audio for a window capture source. Resolves null when it is unavailable. */
export async function startAppAudio(sourceId: string): Promise<{ capture: AppAudioCapture | null; reason: string | null }> {
  const api = desktop?.appAudio;
  if (!api) return { capture: null, reason: 'unsupported' };
  const owner = Symbol();
  helperOwner = owner;
  const stopHelper = () => {
    if (helperOwner !== owner) return;
    helperOwner = null;
    api.stop();
  };
  const portPromise = new Promise<MessagePort>((resolve) => {
    pendingPort = resolve;
  });
  const result = await api.start(sourceId).catch(() => ({ ok: false as const, reason: 'error' }));
  if (!result.ok) {
    pendingPort = null;
    return { capture: null, reason: result.reason };
  }
  const port = await Promise.race([portPromise, new Promise<null>((r) => setTimeout(() => r(null), 3000))]);
  if (!port) {
    stopHelper();
    return { capture: null, reason: 'timeout' };
  }
  let context: AudioContext | null = null;
  let track: MediaStreamTrack | undefined;
  try {
    context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    await context.audioWorklet.addModule(playerUrl);
    const node = new AudioWorkletNode(context, 'aidis-pcm-player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    const destination = context.createMediaStreamDestination();
    destination.channelCount = 2;
    node.connect(destination);
    port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (event.data instanceof ArrayBuffer) node.port.postMessage(new Float32Array(event.data));
    };
    port.start();
    track = destination.stream.getAudioTracks()[0];
    if (!track) throw new Error('No application audio track');
    const audioContext = context;
    const audioTrack = track;
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      stopHelper();
      port.close();
      audioTrack.stop();
      void audioContext.close().catch(() => undefined);
    };
    // LiveKit stops the track when the share ends: stop the helper too.
    track.addEventListener('ended', stop);
    return { capture: { track, stop }, reason: null };
  } catch {
    stopHelper();
    port.close();
    track?.stop();
    if (context) void context.close().catch(() => undefined);
    return { capture: null, reason: 'error' };
  }
}
