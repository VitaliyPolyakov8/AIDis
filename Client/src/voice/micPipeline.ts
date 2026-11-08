import type { AudioProcessorOptions, Track, TrackProcessor } from 'livekit-client';
import gateWorkletUrl from './micGate.worklet.js?url&no-inline';
import noiseWorkletUrl from './noise.worklet.ts?worker&url';

/**
 * Outgoing microphone processing, used both as a LiveKit track processor (what the voice channel
 * receives) and by the microphone test in Settings (local only):
 *
 *   mic track -> input volume (GainNode, 0..2 = 0..200 %) -> limiter -> voice gate (AudioWorklet) -> output track
 *
 * - Input volume is real gain: above 100 % the signal is amplified, and a fast limiter just below
 *   0 dBFS prevents harsh digital clipping. 0 % is silence.
 * - The browser's own processing (echo cancellation, noise suppression, automatic gain control)
 *   happens before this pipeline, on the raw microphone. AGC therefore cannot undo the input
 *   volume; with AGC on, input volume scales an already-levelled signal.
 * - The gate decides when the microphone is "speaking" (manual threshold or automatic); see
 *   micGate.worklet.js. In push-to-talk mode it stays open and the PTT key decides.
 */
export type GateMode = 'open' | 'manual' | 'auto';

export interface MicLevel {
  /** Peak level of the last ~33 ms after input volume, dBFS (-100..0). */
  db: number;
  /** Whether the gate is passing audio right now. */
  open: boolean;
  /** Threshold in use (the automatic one in auto mode), dBFS. */
  threshold: number;
}

export const LEVEL_FLOOR_DB = -100;
/** Range the meter and the sensitivity slider show. */
export const METER_MIN_DB = -80;

/** dBFS -> 0..1 position on the meter (linear in dB, which matches how loudness is perceived). */
export function dbToMeter(db: number): number {
  return Math.min(1, Math.max(0, (db - METER_MIN_DB) / -METER_MIN_DB));
}

export function meterToDb(position: number): number {
  return METER_MIN_DB + Math.min(1, Math.max(0, position)) * -METER_MIN_DB;
}

const loadedContexts = new WeakSet<BaseAudioContext>();
const noiseContexts = new WeakMap<BaseAudioContext, Promise<boolean>>();

/** Loads the RNNoise worklet once per context; false when it cannot run (then no strong mode). */
function ensureNoiseWorklet(context: BaseAudioContext): Promise<boolean> {
  let loaded = noiseContexts.get(context);
  if (!loaded) {
    loaded = context.sampleRate === 48000 ? context.audioWorklet.addModule(noiseWorkletUrl).then(() => true, () => false) : Promise.resolve(false);
    noiseContexts.set(context, loaded);
  }
  return loaded;
}

/** A suspended context produces silence: fail loudly instead of sending nothing. */
async function resumeOrFail(context: AudioContext): Promise<void> {
  await Promise.race([context.resume(), new Promise((resolve) => setTimeout(resolve, 1500))]);
  if (context.state !== 'running') throw new Error(`AudioContext is ${context.state}`);
}

async function ensureWorklet(context: BaseAudioContext): Promise<void> {
  if (loadedContexts.has(context)) return;
  await context.audioWorklet.addModule(gateWorkletUrl);
  loadedContexts.add(context);
}

export class MicPipeline implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  readonly name = 'aidis-mic-pipeline';
  processedTrack?: MediaStreamTrack;

  private context: AudioContext | null = null;
  /** The context this pipeline was first given; reused on restart(). */
  private ownContext: AudioContext | null = null;
  private nodes: AudioNode[] = [];
  private gainNode: GainNode | null = null;
  private gate: AudioWorkletNode | null = null;
  private volume = 1;
  private gateMode: GateMode = 'open';
  private strongNoise = false;
  private noise: AudioWorkletNode | null = null;
  private thresholdDb = -50;
  private level: MicLevel = { db: LEVEL_FLOOR_DB, open: false, threshold: -50 };
  private readonly listeners = new Set<(level: MicLevel) => void>();

  async init(options: AudioProcessorOptions): Promise<void> {
    // LiveKit passes the AudioContext on setProcessor() but NOT on restart() (device switch,
    // processing change, recovery after the device was lost). Keep the first one; without it the
    // pipeline would fail and the raw microphone would be sent around the volume and the gate.
    const context = (options.audioContext as AudioContext | undefined) ?? this.ownContext;
    if (!context) throw new Error('No AudioContext for the microphone pipeline');
    this.ownContext = context;
    this.context = context;
    await ensureWorklet(context);
    if (context.state !== 'running') await resumeOrFail(context);

    const source = context.createMediaStreamSource(new MediaStream([options.track]));
    // Strong noise suppression (RNNoise) cleans the signal itself, before volume and the gate.
    let noise: AudioWorkletNode | null = null;
    if (this.strongNoise && (await ensureNoiseWorklet(context))) {
      try {
        noise = new AudioWorkletNode(context, 'aidis-noise-suppressor', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      } catch {
        noise = null;
      }
    }
    const gain = context.createGain();
    gain.gain.value = this.volume;
    // Limiter: transparent below -3 dBFS, stops amplified peaks from clipping.
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.1;
    // The gate is created with its real mode and threshold and starts closed (see micGate.worklet.js).
    const gate = new AudioWorkletNode(context, 'aidis-mic-gate', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { mode: this.gateMode, thresholdDb: this.thresholdDb },
    });
    gate.port.onmessage = (event: MessageEvent<MicLevel>) => {
      this.level = event.data;
      for (const listener of this.listeners) listener(event.data);
    };
    const destination = context.createMediaStreamDestination();
    if (noise) source.connect(noise).connect(gain);
    else source.connect(gain);
    gain.connect(limiter).connect(gate).connect(destination);

    this.noise = noise;
    this.nodes = noise ? [source, noise, gain, limiter, gate, destination] : [source, gain, limiter, gate, destination];
    this.gainNode = gain;
    this.gate = gate;
    this.sendGateSettings();
    this.processedTrack = destination.stream.getAudioTracks()[0];
  }

  /** New microphone track (device switch, new processing options): rebuild the graph on the same context. */
  async restart(options: AudioProcessorOptions): Promise<void> {
    this.teardown();
    await this.init(options);
  }

  /** True while the graph is built and producing the processed track. */
  get active(): boolean {
    return this.processedTrack !== undefined && this.context?.state === 'running';
  }

  destroy(): Promise<void> {
    this.teardown();
    this.ownContext = null;
    return Promise.resolve();
  }

  private teardown(): void {
    if (this.gate) this.gate.port.onmessage = null;
    for (const node of this.nodes) node.disconnect();
    this.nodes = [];
    this.gainNode = null;
    this.gate = null;
    this.noise = null;
    this.processedTrack?.stop();
    this.processedTrack = undefined;
    this.context = null;
    this.level = { db: LEVEL_FLOOR_DB, open: this.gateMode === 'open', threshold: this.thresholdDb };
  }

  /** Strong (RNNoise) suppression for the next graph build (init / restart). */
  setNoiseSuppression(strong: boolean): void {
    this.strongNoise = strong;
  }

  /** RNNoise is really in the signal path right now. */
  get noiseActive(): boolean {
    return this.noise !== null;
  }

  /** Input volume in percent (0..200). Applied immediately with a short ramp. */
  setVolume(percent: number): void {
    this.volume = Math.min(2, Math.max(0, percent / 100));
    if (this.gainNode && this.context) this.gainNode.gain.setTargetAtTime(this.volume, this.context.currentTime, 0.02);
  }

  setGate(mode: GateMode, thresholdDb: number): void {
    this.gateMode = mode;
    this.thresholdDb = thresholdDb;
    this.sendGateSettings();
  }

  getLevel(): MicLevel {
    return this.level;
  }

  onLevel(listener: (level: MicLevel) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private sendGateSettings(): void {
    this.gate?.port.postMessage({ mode: this.gateMode, thresholdDb: this.thresholdDb });
  }
}
