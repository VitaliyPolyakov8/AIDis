/**
 * "Strong" noise suppression (0.3.1): RNNoise (Xiph / Jean-Marc Valin, via @jitsi/rnnoise-wasm) in
 * an AudioWorklet on the audio thread. A small recurrent network (~85 kB of weights) that removes
 * fan hum, hiss, keyboard clicks and room noise from speech; ~1-2 % of one CPU core at 48 kHz.
 *
 * RNNoise works on 480-sample frames (10 ms at 48 kHz) with 16-bit scaled floats. The worklet
 * gets 128-sample blocks, so it buffers: the extra latency is one frame (10 ms). Samples pass in
 * order, nothing is dropped. Bundled by Vite as its own module (`?worker&url`, ES format).
 */
import createRNNWasmModuleSync from '@jitsi/rnnoise-wasm/dist/rnnoise-sync.js';

declare const sampleRate: number;
declare function registerProcessor(name: string, processor: new (options?: unknown) => unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

interface RnnoiseModule {
  _rnnoise_create(model: number): number;
  _rnnoise_destroy(state: number): void;
  _rnnoise_process_frame(state: number, out: number, input: number): number;
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  HEAPF32: Float32Array;
}

const FRAME = 480;
const SCALE = 32768;

class NoiseSuppressorProcessor extends AudioWorkletProcessor {
  private readonly module: RnnoiseModule;
  private readonly state: number;
  private readonly inPtr: number;
  private readonly outPtr: number;
  /** Input not yet processed / processed output not yet played. */
  private readonly inBuf = new Float32Array(FRAME);
  private inLen = 0;
  private readonly outBuf = new Float32Array(FRAME * 4);
  private outRead = 0;
  private outLen = 0;
  private enabled = true;

  constructor() {
    super();
    this.module = createRNNWasmModuleSync() as RnnoiseModule;
    this.state = this.module._rnnoise_create(0);
    this.inPtr = this.module._malloc(FRAME * 4);
    this.outPtr = this.module._malloc(FRAME * 4);
    // Start with one frame of silence so output always has samples ready (fixed 10 ms latency).
    this.outLen = FRAME;
    this.port.onmessage = (event: MessageEvent<{ enabled?: unknown }>) => {
      if (typeof event.data.enabled === 'boolean') this.enabled = event.data.enabled;
    };
  }

  private processFrame(): void {
    const heap = this.module.HEAPF32;
    const inIndex = this.inPtr >> 2;
    const outIndex = this.outPtr >> 2;
    for (let i = 0; i < FRAME; i += 1) heap[inIndex + i] = (this.inBuf[i] ?? 0) * SCALE;
    this.module._rnnoise_process_frame(this.state, this.outPtr, this.inPtr);
    const out = this.module.HEAPF32; // the heap view may have been replaced
    for (let i = 0; i < FRAME; i += 1) {
      const write = (this.outRead + this.outLen) % this.outBuf.length;
      this.outBuf[write] = this.enabled ? (out[outIndex + i] ?? 0) / SCALE : (this.inBuf[i] ?? 0);
      this.outLen += 1;
    }
    this.inLen = 0;
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    const output = outputs[0];
    if (!output?.[0]) return true;
    const frames = output[0].length;
    for (let i = 0; i < frames; i += 1) {
      this.inBuf[this.inLen] = input ? (input[i] ?? 0) : 0;
      this.inLen += 1;
      if (this.inLen === FRAME) this.processFrame();
      let sample = 0;
      if (this.outLen > 0) {
        sample = this.outBuf[this.outRead] ?? 0;
        this.outRead = (this.outRead + 1) % this.outBuf.length;
        this.outLen -= 1;
      }
      for (const channel of output) channel[i] = sample;
    }
    return true;
  }
}

if (sampleRate === 48000) registerProcessor('aidis-noise-suppressor', NoiseSuppressorProcessor);
