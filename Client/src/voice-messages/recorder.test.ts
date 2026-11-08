import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceRecorder } from './recorder';

describe('voice recording lifecycle', () => {
  const track = { stop: vi.fn() };
  const getUserMedia = vi.fn();
  let media: { state: string; mimeType: string; ondataavailable: ((e: { data: Blob }) => void) | null; onstop: (() => void) | null; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    vi.useFakeTimers(); track.stop.mockClear();
    getUserMedia.mockResolvedValue({ getTracks: () => [track] });
    vi.stubGlobal('MediaRecorder', Object.assign(class {
      state = 'inactive'; mimeType = 'audio/webm;codecs=opus'; ondataavailable = null; onstop = null;
      constructor() { capture(this); }
      start = vi.fn(() => { this.state = 'recording'; });
      stop = vi.fn(() => { this.state = 'inactive'; });
    }, { isTypeSupported: () => true }));
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
  });
  function capture(value: typeof media) { media = value; }
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('stops the microphone before preview, never sends automatically, and revokes preview on cancel', async () => {
    const changed = vi.fn(); const recorder = new VoiceRecorder(changed);
    await recorder.start();
    media.ondataavailable?.({ data: new Blob(['sound']) });
    recorder.stop();
    expect(track.stop).toHaveBeenCalledOnce();
    media.onstop?.();
    expect(recorder.snapshot.status).toBe('preview');
    expect(recorder.snapshot.blob?.type).toBe('audio/webm');
    recorder.cancel();
    expect(recorder.snapshot.status).toBe('idle');
    expect(recorder.snapshot.blob).toBeNull();
  });

  it('cancellation or navigation while awaiting permission releases the late microphone', async () => {
    let grant!: (value: unknown) => void;
    getUserMedia.mockReturnValueOnce(new Promise(r => { grant = r; }));
    const recorder = new VoiceRecorder(() => undefined);
    const starting = recorder.start(); recorder.cancel();
    grant({ getTracks: () => [track] }); await starting;
    expect(track.stop).toHaveBeenCalledOnce();
    expect(recorder.snapshot.status).toBe('idle');
  });

  it('caps duration without auto-send and discards oversized recordings', async () => {
    const recorder = new VoiceRecorder(() => undefined); await recorder.start();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(media.stop).toHaveBeenCalledOnce(); expect(track.stop).toHaveBeenCalledOnce();
    recorder.cancel(); await recorder.start();
    media.ondataavailable?.({ data: { size: 21 * 1024 * 1024 } as Blob });
    expect(recorder.snapshot.status).toBe('error'); expect(recorder.snapshot.blob).toBeNull();
    expect(track.stop).toHaveBeenCalledTimes(2);
  });
});
