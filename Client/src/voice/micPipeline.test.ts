import { beforeAll, describe, expect, it } from 'vitest';
import { dbToMeter, meterToDb, MicPipeline } from './micPipeline';
import { effectiveAgc } from './voiceService';
import { sanitizeSettings } from '../stores/settingsStore';

/**
 * Runs the real voice-gate worklet code outside an AudioContext: the AudioWorklet globals are
 * provided here and 128-sample blocks are fed in by hand at 48 kHz.
 */
type Processor = {
  port: { onmessage: ((e: { data: unknown }) => void) | null; postMessage: (m: unknown) => void };
  process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
};
let GateClass: new (options?: { processorOptions?: { mode?: string; thresholdDb?: number } }) => Processor;
let clock = 0;
const messages: { db: number; open: boolean; threshold: number }[] = [];

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.sampleRate = 48_000;
  Object.defineProperty(globalThis, 'currentTime', { get: () => clock, configurable: true });
  g.AudioWorkletProcessor = class {
    port = {
      onmessage: null,
      postMessage: (m: { db: number; open: boolean; threshold: number }) => messages.push(m),
    };
  };
  g.registerProcessor = (_name: string, cls: new () => Processor) => {
    GateClass = cls;
  };
  await import('./micGate.worklet.js');
});

const BLOCK = 128;
const blockSeconds = BLOCK / 48_000;

function sine(db: number): Float32Array {
  const amp = Math.SQRT2 * 10 ** (db / 20);
  return Float32Array.from({ length: BLOCK }, (_, i) => amp * Math.sin((2 * Math.PI * 440 * i) / 48_000));
}

/** Feeds `seconds` of a tone at `db` dBFS; returns the output peak of the last block. */
function feed(gate: Processor, db: number, seconds: number): number {
  let peak = 0;
  const blocks = Math.ceil(seconds / blockSeconds);
  for (let b = 0; b < blocks; b += 1) {
    const out = new Float32Array(BLOCK);
    gate.process([[sine(db)]], [[out]]);
    clock += blockSeconds;
    peak = Math.max(...out.map(Math.abs));
  }
  return peak;
}

describe('voice gate (worklet)', () => {
  it('0.4.5: AGC raising the start-up hiss for seconds after joining never opens the auto gate', () => {
    const gate = new GateClass({ processorOptions: { mode: 'auto', thresholdDb: -50 } });
    // 250 ms warm-up on a quiet microphone, then the AGC ramps the hiss up by 25 dB over 3 s.
    let maxOut = feed(gate, -72, 0.3);
    for (let i = 0; i <= 30; i += 1) maxOut = Math.max(maxOut, feed(gate, -72 + (25 * i) / 30, 0.1));
    maxOut = Math.max(maxOut, feed(gate, -47, 1.5)); // settled hiss
    expect(maxOut).toBeLessThan(0.0005); // nothing of the hiss was sent
    expect(feed(gate, -18, 0.3)).toBeGreaterThan(0.1); // the first word passes
  });

  it('manual threshold: background noise stays silent, speech passes, with hold time', () => {
    const gate = new GateClass();
    gate.port.onmessage?.({ data: { mode: 'manual', thresholdDb: -45 } });
    expect(feed(gate, -60, 0.6)).toBeLessThan(0.0005); // quiet fan noise below threshold
    expect(feed(gate, -20, 0.2)).toBeGreaterThan(0.1); // speech
    expect(feed(gate, -60, 0.2)).toBeGreaterThan(0.0005); // still within the 350 ms hold
    expect(feed(gate, -60, 0.6)).toBeLessThan(0.0005); // closed again afterwards
    expect(messages.at(-1)).toMatchObject({ open: false, threshold: -45 });
  });

  it('open mode (push-to-talk) never gates', () => {
    const gate = new GateClass();
    gate.port.onmessage?.({ data: { mode: 'open', thresholdDb: -10 } });
    expect(feed(gate, -60, 0.6)).toBeGreaterThan(0.0005);
  });

  it('auto mode places the threshold above the measured noise floor', () => {
    const gate = new GateClass();
    gate.port.onmessage?.({ data: { mode: 'auto', thresholdDb: -50 } });
    feed(gate, -55, 3); // room noise
    const threshold = messages.at(-1)!.threshold;
    expect(threshold).toBeGreaterThan(-55);
    expect(threshold).toBeLessThanOrEqual(-30);
    expect(feed(gate, -55, 0.6)).toBeLessThan(0.002); // noise stays out
    expect(feed(gate, -18, 0.2)).toBeGreaterThan(0.1); // voice gets through
  });

  it('starts closed: the start-up hiss of a freshly opened microphone is never passed (join hiss)', () => {
    // Created with its real mode (as MicPipeline does), no settings message needed.
    const gate = new GateClass({ processorOptions: { mode: 'auto', thresholdDb: -50 } });
    // Loud start-up hiss for the first 2 s (AGC / noise suppression still settling)...
    let loudest = 0;
    for (let i = 0; i < 20; i += 1) loudest = Math.max(loudest, feed(gate, -42, 0.1));
    expect(loudest).toBeLessThan(0.002);
    // ...then the room gets quiet and the user speaks: speech still passes.
    feed(gate, -65, 1);
    expect(feed(gate, -18, 0.2)).toBeGreaterThan(0.1);
  });

  it('never defaults to open before its settings arrive', () => {
    const gate = new GateClass();
    expect(feed(gate, -45, 0.1)).toBeLessThan(0.002);
    const manual = new GateClass({ processorOptions: { mode: 'manual', thresholdDb: -40 } });
    const first = new Float32Array(BLOCK);
    manual.process([[sine(-20)]], [[first]]);
    // Opens on real speech with the fast attack, from silence (gain starts at 0).
    expect(Math.abs(first[0] ?? 1)).toBeLessThan(0.01);
    expect(feed(manual, -20, 0.05)).toBeGreaterThan(0.1);
  });
});

describe('meter scale and stored settings', () => {
  it('maps dBFS to the meter and back', () => {
    expect(dbToMeter(-80)).toBe(0);
    expect(dbToMeter(0)).toBe(1);
    expect(dbToMeter(-40)).toBeCloseTo(0.5);
    expect(dbToMeter(-120)).toBe(0);
    expect(meterToDb(0.5)).toBeCloseTo(-40);
  });

  it('repairs out-of-range stored audio settings', () => {
    const s = sanitizeSettings({
      inputVolume: 900,
      sensitivityDb: -300,
      autoSensitivity: 'yes' as unknown as boolean,
      userVolumes: { bob: 50, eve: 999, '': 10 } as Record<string, number>,
      userMutes: { bob: true, eve: false } as Record<string, boolean>,
    });
    expect(s.inputVolume).toBe(200);
    expect(s.sensitivityDb).toBe(-80);
    expect(s.autoSensitivity).toBe(true);
    expect(s.userVolumes).toEqual({ bob: 50 });
    expect(s.userMutes).toEqual({ bob: true });
  });
});

describe('pipeline lifecycle', () => {
  /** Minimal Web Audio stand-ins: enough to build and tear down the graph. */
  function fakeContext() {
    const node = () => ({ connect: (n: unknown) => n, disconnect: () => undefined, gain: { value: 1, setTargetAtTime: () => undefined } });
    const processed = { stop: () => undefined, kind: 'audio' };
    return {
      state: 'running',
      currentTime: 0,
      audioWorklet: { addModule: () => Promise.resolve() },
      resume: () => Promise.resolve(),
      createMediaStreamSource: node,
      createGain: node,
      createDynamicsCompressor: () => ({ ...node(), threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 }, attack: { value: 0 }, release: { value: 0 } }),
      createMediaStreamDestination: () => ({ ...node(), stream: { getAudioTracks: () => [processed] } }),
    } as unknown as AudioContext;
  }

  beforeAll(() => {
    const g = globalThis as Record<string, unknown>;
    g.AudioWorkletNode = class {
      port = { onmessage: null, postMessage: () => undefined };
      connect(n: unknown) {
        return n;
      }
      disconnect() {}
    };
    g.MediaStream ??= class {
      tracks: unknown[];
      constructor(tracks: unknown[]) {
        this.tracks = tracks;
      }
    };
  });

  it('keeps working after LiveKit restarts it without an AudioContext (device switch)', async () => {
    const ctx = fakeContext();
    const pipeline = new MicPipeline();
    const track = {} as MediaStreamTrack;
    await pipeline.init({ kind: 'audio' as never, track, audioContext: ctx });
    expect(pipeline.active).toBe(true);
    // LiveKit's setMediaStreamTrack() calls restart({ track, kind, element, localTrack }) - no audioContext.
    await pipeline.restart({ kind: 'audio' as never, track } as never);
    expect(pipeline.active).toBe(true);
    expect(pipeline.processedTrack).toBeDefined();
    await pipeline.destroy();
    expect(pipeline.active).toBe(false);
  });

  it('refuses to run on a suspended context instead of sending silence', async () => {
    const ctx = Object.assign(fakeContext(), { state: 'suspended' });
    const pipeline = new MicPipeline();
    await expect(pipeline.init({ kind: 'audio' as never, track: {} as MediaStreamTrack, audioContext: ctx })).rejects.toThrow(/suspended/);
  });

  it('turns browser AGC off whenever the input volume is set manually', () => {
    expect(effectiveAgc({ autoGainControl: true, inputVolume: 100 })).toBe(true);
    expect(effectiveAgc({ autoGainControl: true, inputVolume: 150 })).toBe(false);
    expect(effectiveAgc({ autoGainControl: false, inputVolume: 100 })).toBe(false);
  });
});
