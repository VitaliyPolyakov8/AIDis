import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const shell = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }));
vi.mock('./bridge', () => ({ desktop: { appAudio: shell } }));

const { startAppAudio } = await import('./appAudio');

describe('application audio ownership during source switches', () => {
  let moduleFails = false;
  const contexts: { close: ReturnType<typeof vi.fn>; track: EventTarget & { stop: ReturnType<typeof vi.fn> } }[] = [];
  const ports: { close: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn> }[] = [];

  beforeEach(() => {
    moduleFails = false;
    shell.stop.mockClear();
    contexts.length = 0;
    ports.length = 0;
    shell.start.mockImplementation(async () => {
      const port = { close: vi.fn(), start: vi.fn(), onmessage: null };
      ports.push(port);
      window.dispatchEvent(new MessageEvent('message', { source: window, data: 'aidis-app-audio-port', ports: [port as unknown as MessagePort] }));
      return { ok: true };
    });
    vi.stubGlobal('AudioContext', class {
      audioWorklet = { addModule: vi.fn(async () => { if (moduleFails) throw new Error('worklet unavailable'); }) };
      close = vi.fn(async () => undefined);
      track = Object.assign(new EventTarget(), { stop: vi.fn() });
      constructor() { contexts.push(this); }
      createMediaStreamDestination() { return { stream: { getAudioTracks: () => [this.track] } }; }
    });
    vi.stubGlobal('AudioWorkletNode', class {
      port = { postMessage: vi.fn() };
      connect() {}
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('releasing the old window keeps the new window helper alive and releases old local resources', async () => {
    const first = (await startAppAudio('window:1:0')).capture!;
    const second = (await startAppAudio('window:2:0')).capture!;
    first.stop();
    expect(shell.stop).not.toHaveBeenCalled();
    expect(ports[0]?.close).toHaveBeenCalledOnce();
    expect(contexts[0]?.close).toHaveBeenCalledOnce();
    expect(contexts[0]?.track.stop).toHaveBeenCalledOnce();
    second.stop();
    second.stop();
    expect(shell.stop).toHaveBeenCalledOnce();
    expect(ports[1]?.close).toHaveBeenCalledOnce();
  });

  it('an ended event from the previous audio track cannot stop the replacement helper', async () => {
    await startAppAudio('window:1:0');
    const second = (await startAppAudio('window:2:0')).capture!;
    contexts[0]?.track.dispatchEvent(new Event('ended'));
    expect(shell.stop).not.toHaveBeenCalled();
    second.stop();
    expect(shell.stop).toHaveBeenCalledOnce();
  });
  it('releases the helper and local resources when audio processing cannot initialize', async () => {
    moduleFails = true;
    await expect(startAppAudio('window:1:0')).resolves.toMatchObject({ capture: null, reason: 'error' });
    expect(shell.stop).toHaveBeenCalledOnce();
    expect(ports[0]?.close).toHaveBeenCalledOnce();
    expect(contexts[0]?.close).toHaveBeenCalledOnce();
  });
});
