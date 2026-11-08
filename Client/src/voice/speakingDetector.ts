/**
 * Fast "who is speaking" detection, measured on this device instead of waiting for the server.
 *
 * LiveKit's ActiveSpeakersChanged comes from the SFU, which aggregates audio levels over intervals
 * and smooths them before telling clients; together with the network that made the speaking ring
 * appear 1.5–2 s late. Here every remote microphone track that is already playing is also fed into
 * a small AnalyserNode (no output, no extra download), and its level is checked every 50 ms:
 *   start: as soon as the level crosses SPEAKING_DB (≤ ~50 ms after the audio arrives)
 *   stop:  after RELEASE_MS below it, so the ring does not flicker between syllables
 * Only transitions are reported, so React re-renders a few times per sentence, not 20 times a second.
 */
export const SPEAKING_DB = -50;
export const RELEASE_MS = 250;
const INTERVAL_MS = 50;

export interface SpeakingState {
  speaking: boolean;
  lastLoudAt: number;
}

/** Pure attack/release step (unit-tested). */
export function nextSpeaking(prev: SpeakingState, db: number, now: number): SpeakingState {
  if (db >= SPEAKING_DB) return { speaking: true, lastLoudAt: now };
  return { speaking: prev.speaking && now - prev.lastLoudAt < RELEASE_MS, lastLoudAt: prev.lastLoudAt };
}

interface Entry {
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  buffer: Float32Array<ArrayBuffer>;
  state: SpeakingState;
}

export class SpeakingDetector {
  private context: AudioContext | null = null;
  private readonly entries = new Map<string, Entry>();
  private readonly local: { read: () => number | null; state: SpeakingState; enabled: boolean } = { read: () => null, state: { speaking: false, lastLoudAt: 0 }, enabled: false };
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly onChange: () => void;

  constructor(onChange: () => void) {
    this.onChange = onChange;
  }

  /** Our own level (dBFS of what we are sending), or null when we are not transmitting. */
  setLocalLevel(read: () => number | null): void {
    this.local.read = read;
    this.local.enabled = true;
    this.ensureTimer();
  }

  /** 0.5.9: back from the background (iOS suspends audio contexts there). */
  resume(): void {
    if (this.context && this.context.state !== 'running' && this.context.state !== 'closed') void this.context.resume().catch(() => undefined);
  }

  addRemote(identity: string, track: MediaStreamTrack): void {
    this.removeRemote(identity);
    if (typeof AudioContext === 'undefined') return;
    try {
      this.context ??= new AudioContext({ latencyHint: 'interactive' });
      if (this.context.state === 'suspended') void this.context.resume().catch(() => undefined);
      const source = this.context.createMediaStreamSource(new MediaStream([track]));
      const analyser = this.context.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser); // analysis only: nothing is connected to the speakers
      this.entries.set(identity, { source, analyser, buffer: new Float32Array(analyser.fftSize), state: { speaking: false, lastLoudAt: 0 } });
      this.ensureTimer();
    } catch {
      /* fall back to LiveKit's own speaking state for this participant */
    }
  }

  removeRemote(identity: string): void {
    const entry = this.entries.get(identity);
    if (!entry) return;
    entry.source.disconnect();
    this.entries.delete(identity);
    if (entry.state.speaking) this.onChange();
  }

  /** true/false when measured here, undefined when this device has no measurement for them. */
  isSpeaking(identity: string, isLocal: boolean): boolean | undefined {
    if (isLocal) return this.timer && this.local.enabled ? this.local.state.speaking : undefined;
    return this.entries.get(identity)?.state.speaking;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const entry of this.entries.values()) entry.source.disconnect();
    this.entries.clear();
    this.local.read = () => null;
    this.local.state = { speaking: false, lastLoudAt: 0 };
    void this.context?.close().catch(() => undefined);
    this.context = null;
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), INTERVAL_MS);
  }

  private tick(): void {
    const now = performance.now();
    let changed = false;
    for (const entry of this.entries.values()) {
      entry.analyser.getFloatTimeDomainData(entry.buffer);
      let sum = 0;
      for (const v of entry.buffer) sum += v * v;
      const rms = Math.sqrt(sum / entry.buffer.length);
      const db = rms > 0 ? 20 * Math.log10(rms) : -100;
      const next = nextSpeaking(entry.state, db, now);
      if (next.speaking !== entry.state.speaking) changed = true;
      entry.state = next;
    }
    const localDb = this.local.read();
    const localNext = nextSpeaking(this.local.state, localDb ?? -100, now);
    if (localNext.speaking !== this.local.state.speaking) changed = true;
    this.local.state = localNext;
    if (changed) this.onChange();
  }
}
