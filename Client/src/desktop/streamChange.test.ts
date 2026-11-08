import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DESKTOP_SETTINGS } from './contract';

vi.mock('./bridge', () => ({
  isDesktop: true,
  desktop: { capture: { select: vi.fn(() => Promise.resolve(true)), getSources: vi.fn() }, app: { log: vi.fn() } },
}));

const { changeDesktopShare } = await import('./screenCapture');
const { voice } = await import('../voice/voiceService');
const { useVoiceStore, INITIAL_VOICE_STATE } = await import('../voice/voiceStore');
const { useDesktopStore } = await import('./desktopStore');
const { useUiStore } = await import('../stores/uiStore');

function fakeStream(audio: boolean): MediaStream {
  const video = { kind: 'video', stop: vi.fn(), contentHint: '' };
  const tracks = audio ? [video, { kind: 'audio', stop: vi.fn() }] : [video];
  return {
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
  } as unknown as MediaStream;
}

describe('change stream while live (desktop)', () => {
  const getDisplayMedia = vi.fn((_c: DisplayMediaStreamOptions) => Promise.resolve(fakeStream(true)));

  beforeEach(() => {
    Object.defineProperty(navigator, 'mediaDevices', { value: { getDisplayMedia }, configurable: true });
    getDisplayMedia.mockClear();
    useUiStore.setState({ toasts: [] });
    vi.restoreAllMocks();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    useDesktopStore.setState({ settings: { ...DEFAULT_DESKTOP_SETTINGS, streaming: { ...DEFAULT_DESKTOP_SETTINGS.streaming, resolution: '720p', frameRate: 60, bitrateMode: '12' } } });
    useVoiceStore.setState({
      ...INITIAL_VOICE_STATE,
      status: 'connected',
      localScreenSharing: true,
      shareConfig: { sourceId: 'window:1:0', sourceKind: 'window', width: 1920, height: 1080, maxFramerate: 60, maxBitrate: 8_000_000, contentMode: 'game', systemAudio: true },
    });
  });

  it('same source and audio: only constraints and sender limits change (no new capture)', async () => {
    const quality = vi.spyOn(voice, 'updateScreenShareQuality').mockResolvedValue(true);
    const replace = vi.spyOn(voice, 'replaceScreenShare').mockResolvedValue(true);
    expect(await changeDesktopShare('window:1:0', true)).toBe(true);
    expect(quality).toHaveBeenCalledWith(expect.objectContaining({ frameRate: 60, maxBitrate: 12_000_000, contentMode: 'game', degradation: 'maintain-framerate-and-resolution' }), { width: 1280, height: 720 }, 120);
    expect(getDisplayMedia).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('another window (or audio on/off): new capture with the same 60 FPS constraints, swapped into the running stream', async () => {
    const replace = vi.spyOn(voice, 'replaceScreenShare').mockResolvedValue(true);
    const publish = vi.spyOn(voice, 'publishScreenShare').mockResolvedValue(true);
    expect(await changeDesktopShare('screen:0:0', false)).toBe(true);
    const constraints = getDisplayMedia.mock.calls[0]?.[0];
    expect(constraints?.video).toEqual({ width: { max: 1280 }, height: { max: 720 }, frameRate: { ideal: 120, max: 120 } });
    expect(constraints?.audio).toBe(false);
    expect(replace).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ frameRate: 60, maxBitrate: 12_000_000, contentMode: 'game', degradation: 'maintain-framerate-and-resolution' }), { sourceId: 'screen:0:0', sourceKind: 'screen' });
    expect(publish).not.toHaveBeenCalled();
  });

  it('not live anymore: starts a normal share', async () => {
    useVoiceStore.setState({ localScreenSharing: false, shareConfig: null });
    const publish = vi.spyOn(voice, 'publishScreenShare').mockResolvedValue(true);
    await changeDesktopShare('window:3:0', true);
    expect(publish).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ frameRate: 60 }), { sourceId: 'window:3:0', sourceKind: 'window' });
  });

  it('explains window-capture workarounds when Windows cannot read a game window, without capturing a display', async () => {
    getDisplayMedia.mockRejectedValueOnce(new DOMException('Could not start video source', 'NotReadableError'));
    const replace = vi.spyOn(voice, 'replaceScreenShare').mockResolvedValue(true);
    expect(await changeDesktopShare('window:9:0', true)).toBe(false);
    expect(getDisplayMedia).toHaveBeenCalledOnce();
    expect(replace).not.toHaveBeenCalled();
    expect(useUiStore.getState().toasts.at(-1)?.message).toContain('borderless');
    expect(useVoiceStore.getState().shareConfig?.sourceId).toBe('window:1:0');
  });
});

describe('replaceScreenShare keeps the publication and re-applies limits', () => {
  it('swaps the video track in place, replaces audio, stops the old capture and tells viewers', async () => {
    const params = { encodings: [{ maxBitrate: 1, maxFramerate: 30 }] };
    const sender = { getParameters: vi.fn(() => params), setParameters: vi.fn(() => Promise.resolve()) };
    const videoTrack = {
      replaceTrack: vi.fn(() => Promise.resolve()),
      setDegradationPreference: vi.fn(() => Promise.resolve()),
      sender,
      mediaStreamTrack: { contentHint: 'motion', getSettings: () => ({ width: 1280, height: 720, frameRate: 120 }) },
      getRTCStatsReport: () => Promise.resolve(undefined),
    };
    const audioTrack = { replaceTrack: vi.fn(() => Promise.resolve()) };
    const publishData = vi.fn(() => Promise.resolve());
    const room = {
      state: 'connected',
      localParticipant: {
        getTrackPublication: (source: string) => (source === 'screen_share' ? { track: videoTrack } : source === 'screen_share_audio' ? { track: audioTrack } : undefined),
        publishData,
        unpublishTrack: vi.fn(),
      },
    };
    const v = voice as unknown as { room: unknown; captureTracks: { stop: () => void }[] };
    const oldTrack = { stop: vi.fn() };
    v.room = room;
    v.captureTracks = [oldTrack];
    const stream = fakeStream(true);
    const ok = await voice.replaceScreenShare(stream, { frameRate: 60, maxBitrate: 12_000_000, contentMode: 'game' }, { sourceId: 'window:9:0', sourceKind: 'window' });
    expect(ok).toBe(true);
    expect(videoTrack.replaceTrack).toHaveBeenCalledWith(stream.getVideoTracks()[0], true);
    expect(audioTrack.replaceTrack).toHaveBeenCalledWith(stream.getAudioTracks()[0], true);
    expect(stream.getVideoTracks()[0]?.contentHint).toBe('motion');
    // 0.4.2: a new source keeps the selected resolution (default priority: maintain resolution).
    expect(videoTrack.setDegradationPreference).toHaveBeenCalledWith('maintain-resolution');
    // Full-size layer and the degradation preference are enforced on the sender too.
    expect(sender.setParameters).toHaveBeenCalledWith({ encodings: [{ maxBitrate: 12_000_000, maxFramerate: 60, scaleResolutionDownBy: 1 }], degradationPreference: 'maintain-resolution' });
    expect(oldTrack.stop).toHaveBeenCalled();
    expect(publishData).toHaveBeenCalledWith(expect.anything(), { reliable: true, topic: 'aidis.stream' });
    expect(useVoiceStore.getState().shareConfig).toMatchObject({ sourceId: 'window:9:0', width: 1280, height: 720, contentMode: 'game', systemAudio: true });
    v.room = null;
    v.captureTracks = [];
  });
});
