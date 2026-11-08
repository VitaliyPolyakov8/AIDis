export const MAX_RECORDING_BYTES = 20 * 1024 * 1024;
export interface RecordingState {
  status: 'idle' | 'requesting' | 'recording' | 'stopping' | 'preview' | 'error';
  blob: Blob | null;
  seconds: number;
  error: 'unsupported' | 'microphone' | 'limit' | null;
}

/** Owns only microphone/encoder resources; uploading and sending always require explicit UI actions. */
export class VoiceRecorder {
  snapshot: RecordingState = { status: 'idle', blob: null, seconds: 0, error: null };
  private generation = 0;
  private media: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private parts: Blob[] = [];
  private bytes = 0;
  private readonly changed: (state: RecordingState) => void;
  constructor(changed: (state: RecordingState) => void) { this.changed = changed; }
  private update(patch: Partial<RecordingState>) { this.snapshot = { ...this.snapshot, ...patch }; this.changed(this.snapshot); }
  private releaseMic() {
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
    if (this.timer) clearInterval(this.timer); this.timer = null;
  }
  async start(): Promise<void> {
    this.cancel();
    if (typeof MediaRecorder === 'undefined' || typeof navigator.mediaDevices === 'undefined' || typeof navigator.mediaDevices.getUserMedia !== 'function') { this.update({ status: 'error', error: 'unsupported' }); return; }
    const mimeType = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) { this.update({ status: 'error', error: 'unsupported' }); return; }
    const generation = this.generation;
    this.update({ status: 'requesting' });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      const media = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64_000 });
      this.media = media;
      media.ondataavailable = event => {
        if (generation !== this.generation || !event.data.size) return;
        this.bytes += event.data.size;
        if (this.bytes > MAX_RECORDING_BYTES) { this.cancel(); this.update({ status: 'error', error: 'limit' }); return; }
        this.parts.push(event.data);
      };
      media.onerror = () => { if (generation === this.generation) { this.cancel(); this.update({ status: 'error', error: 'microphone' }); } };
      media.onstop = () => {
        if (generation !== this.generation) return;
        this.releaseMic(); this.media = null;
        const blob = new Blob(this.parts, { type: media.mimeType.split(';')[0] });
        this.parts = [];
        this.update(blob.size ? { status: 'preview', blob } : { status: 'error', error: 'microphone' });
      };
      media.start(1000);
      this.update({ status: 'recording' });
      const started = Date.now();
      this.timer = setInterval(() => {
        const seconds = Math.floor((Date.now() - started) / 1000);
        this.update({ seconds });
        // Leave a little encoder/container margin below the server's strict decoded 300s cap.
        if (seconds >= 299) this.stop();
      }, 250);
    } catch {
      if (generation !== this.generation) return;
      this.cancel(); this.update({ status: 'error', error: 'microphone' });
    }
  }
  stop(): void {
    if (!this.media || this.media.state !== 'recording') return;
    this.update({ status: 'stopping' });
    this.media.stop(); this.releaseMic();
  }
  cancel(): void {
    this.generation++;
    if (this.media) {
      this.media.ondataavailable = null; this.media.onstop = null; this.media.onerror = null;
      if (this.media.state !== 'inactive') this.media.stop();
    }
    this.media = null; this.releaseMic(); this.parts = []; this.bytes = 0;
    this.update({ status: 'idle', blob: null, seconds: 0, error: null });
  }
}
