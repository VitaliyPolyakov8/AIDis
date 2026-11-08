/* global AudioWorkletProcessor, registerProcessor, currentTime, sampleRate */
/**
 * Voice-activity gate for the outgoing microphone (runs on the audio thread, so it keeps working
 * when the window is in the background).
 *
 * Every 128-sample block: measure the RMS level in dBFS, decide whether the microphone is "open",
 * and pass the audio through a smoothed gain (fast attack, slower release, plus a hold time so
 * words are not chopped). Modes:
 *   open   - always transmit (push-to-talk mode: the PTT key decides instead)
 *   manual - open while the level is at or above the user's threshold
 *   auto   - threshold follows the room: 15th percentile of the last ~10 s of levels + 15 dB,
 *            kept between -55 and -30 dBFS (short noise peaks such as keys sit well above the
 *            floor, so the margin is generous; normal speech is around -30..-15 dBFS)
 * About 30 times a second it reports { db, open, threshold } to the main thread for the meter.
 *
 * Start-up: the gate starts CLOSED (gain 0) with the mode it is created with, never "open" by
 * default. In auto mode the first ~250 ms only measure the room (the microphone's start-up hiss
 * while AGC / noise suppression settle) to set the first threshold; nothing is passed meanwhile.
 * This calibration stays local: the gate output is silence until real speech crosses the threshold.
 *
 * 0.4.5 settling: Windows / browser AGC keeps raising the microphone gain for several seconds after
 * the device opens, so the start-up hiss grows well past the level measured in the first 250 ms and
 * opened the gate ("hiss for a few seconds after joining"). For the first SETTLE_MS the automatic
 * threshold therefore follows the noise quickly (30th percentile of the last ~1.5 s + margin) and
 * only ever goes UP; afterwards the normal slow 10 s logic takes over (and can lower it again).
 */
const HOLD_MS = 350;
const AUTO_MARGIN_DB = 15;
const AUTO_MIN_DB = -55;
const AUTO_MAX_DB = -30;
const FLOOR_DB = -100;
const WARMUP_MS = 250;
const SETTLE_MS = 5000;
/** History entries are taken every 8 blocks (~21 ms at 48 kHz): ~1.5 s window. */
const SETTLE_WINDOW = 70;

class MicGateProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const initial = (options && options.processorOptions) || {};
    this.mode = initial.mode === 'open' || initial.mode === 'manual' || initial.mode === 'auto' ? initial.mode : 'auto';
    this.thresholdDb = typeof initial.thresholdDb === 'number' && Number.isFinite(initial.thresholdDb) ? initial.thresholdDb : -50;
    this.autoThresholdDb = -50;
    this.lastLoudMs = -1e9;
    this.gain = 0;
    this.warmupBlocks = Math.ceil((WARMUP_MS / 1000) * sampleRate / 128);
    this.settleBlocks = Math.ceil((SETTLE_MS / 1000) * sampleRate / 128);
    this.warm = [];
    this.blocks = 0;
    this.history = [];
    this.peakDb = FLOOR_DB;
    this.reportEvery = Math.max(1, Math.round(sampleRate / 128 / 30));
    // Per-sample smoothing: ~3 ms attack, ~60 ms release.
    this.attack = 1 - Math.exp(-1 / (0.003 * sampleRate));
    this.release = 1 - Math.exp(-1 / (0.06 * sampleRate));
    this.port.onmessage = (event) => {
      const data = event.data || {};
      if (data.mode === 'open' || data.mode === 'manual' || data.mode === 'auto') this.mode = data.mode;
      if (typeof data.thresholdDb === 'number' && Number.isFinite(data.thresholdDb)) this.thresholdDb = data.thresholdDb;
    };
  }

  process(inputs, outputs) {
    const input = inputs[0] || [];
    const output = outputs[0] || [];
    let sum = 0;
    let count = 0;
    for (const channel of input) {
      for (let i = 0; i < channel.length; i += 1) sum += channel[i] * channel[i];
      count += channel.length;
    }
    const rms = count > 0 ? Math.sqrt(sum / count) : 0;
    const db = rms > 0 ? Math.max(FLOOR_DB, 20 * Math.log10(rms)) : FLOOR_DB;
    const nowMs = currentTime * 1000;

    this.blocks += 1;
    const warmingUp = this.blocks <= this.warmupBlocks;
    if (warmingUp) {
      this.warm.push(db);
      if (this.blocks === this.warmupBlocks) {
        // First threshold from the start-up noise: its loud end (75th percentile) + the margin.
        const sorted = this.warm.slice().sort((a, b) => a - b);
        const noise = sorted[Math.floor(sorted.length * 0.75)];
        this.autoThresholdDb = Math.min(AUTO_MAX_DB, Math.max(AUTO_MIN_DB, noise + AUTO_MARGIN_DB));
        this.warm = [];
      }
    }
    if (this.blocks % 8 === 0) {
      this.history.push(db);
      if (this.history.length > 470) this.history.shift();
    }
    const settling = !warmingUp && this.blocks <= this.settleBlocks;
    if (settling && this.mode === 'auto' && this.blocks % 16 === 0 && this.history.length >= 8) {
      const recent = this.history.slice(-SETTLE_WINDOW).sort((a, b) => a - b);
      const noise = recent[Math.floor(recent.length * 0.3)];
      this.autoThresholdDb = Math.max(this.autoThresholdDb, Math.min(AUTO_MAX_DB, Math.max(AUTO_MIN_DB, noise + AUTO_MARGIN_DB)));
    }
    if (!warmingUp && !settling && this.blocks % 64 === 0 && this.history.length > 20) {
      const sorted = this.history.slice().sort((a, b) => a - b);
      const floor = sorted[Math.floor(sorted.length * 0.15)];
      this.autoThresholdDb = Math.min(AUTO_MAX_DB, Math.max(AUTO_MIN_DB, floor + AUTO_MARGIN_DB));
    }

    const threshold = this.mode === 'auto' ? this.autoThresholdDb : this.thresholdDb;
    let open = true;
    if (this.mode === 'auto' && warmingUp) {
      open = false;
    } else if (this.mode !== 'open') {
      if (db >= threshold) this.lastLoudMs = nowMs;
      open = nowMs - this.lastLoudMs <= HOLD_MS;
    }
    const target = open ? 1 : 0;

    const frames = output[0] ? output[0].length : 128;
    for (let i = 0; i < frames; i += 1) {
      this.gain += (target - this.gain) * (target > this.gain ? this.attack : this.release);
      for (let c = 0; c < output.length; c += 1) {
        const source = input[c] || input[0];
        output[c][i] = source ? source[i] * this.gain : 0;
      }
    }

    this.peakDb = Math.max(this.peakDb, db);
    if (this.blocks % this.reportEvery === 0) {
      this.port.postMessage({ db: this.peakDb, open, threshold });
      this.peakDb = FLOOR_DB;
    }
    return true;
  }
}

registerProcessor('aidis-mic-gate', MicGateProcessor);
