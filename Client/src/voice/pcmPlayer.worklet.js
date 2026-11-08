/* global AudioWorkletProcessor, registerProcessor */
/**
 * 0.4.5 application audio: plays interleaved float32 stereo PCM (48 kHz) pushed from the desktop
 * app's process-loopback helper into a MediaStream track (published as the stream's audio).
 * A small jitter buffer: playback starts once ~40 ms are queued; if the queue grows beyond
 * ~200 ms (the window was busy) the oldest audio is dropped so latency never builds up.
 */
const START_FRAMES = 1920; // 40 ms
const MAX_FRAMES = 9600; // 200 ms

class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunks = [];
    this.offset = 0;
    this.queued = 0;
    this.playing = false;
    this.port.onmessage = (event) => {
      const data = event.data;
      if (!(data instanceof Float32Array) || data.length < 2) return;
      this.chunks.push(data);
      this.queued += data.length / 2;
      while (this.queued > MAX_FRAMES && this.chunks.length > 1) {
        const dropped = this.chunks.shift();
        this.queued -= (dropped.length - this.offset) / 2;
        this.offset = 0;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const left = out[0];
    const right = out[1] || out[0];
    const frames = left.length;
    if (!this.playing && this.queued >= START_FRAMES) this.playing = true;
    for (let i = 0; i < frames; i += 1) {
      if (!this.playing || this.chunks.length === 0) {
        left[i] = 0;
        right[i] = 0;
        continue;
      }
      const chunk = this.chunks[0];
      left[i] = chunk[this.offset];
      right[i] = chunk[this.offset + 1];
      this.offset += 2;
      this.queued -= 1;
      if (this.offset >= chunk.length) {
        this.chunks.shift();
        this.offset = 0;
      }
    }
    if (this.chunks.length === 0) this.playing = false;
    return true;
  }
}

registerProcessor('aidis-pcm-player', PcmPlayer);
