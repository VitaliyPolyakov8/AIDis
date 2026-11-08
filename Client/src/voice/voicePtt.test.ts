import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionState, Track } from 'livekit-client';

/** Order of microphone set-up steps (processor attached / published), across fakes. */
const micEvents: string[] = [];

/** Minimal LiveKit fakes that record what the voice service asks for. */
class FakeLocalParticipant {
  identity = 'me';
  name = 'Me';
  isSpeaking = false;
  isScreenShareEnabled = false;
  connectionQuality = 'excellent';
  audioLevel = 0;
  trackPublications = new Map();
  micPublished = false;
  micEnabledCalls: boolean[] = [];
  published: { source: Track.Source; muted: boolean }[] = [];
  publishOptions: Record<string, unknown>[] = [];
  /** Next setMicrophoneEnabled(true) fails like Windows does when another app holds the device. */
  failNextEnable: Error | null = null;
  get isMicrophoneEnabled() {
    return this.micEnabledCalls.at(-1) ?? false;
  }
  getTrackPublication(source: Track.Source) {
    return source === Track.Source.Microphone && this.micPublished ? { source } : undefined;
  }
  setMicrophoneEnabled(enabled: boolean) {
    if (enabled && this.failNextEnable) {
      const error = this.failNextEnable;
      this.failNextEnable = null;
      return Promise.reject(error);
    }
    this.micEnabledCalls.push(enabled);
    if (enabled) this.micPublished = true;
    return Promise.resolve();
  }
  publishTrack(track: { muted: boolean }, options: { source: Track.Source } & Record<string, unknown>) {
    this.published.push({ source: options.source, muted: track.muted });
    micEvents.push(`publish${track.muted ? ' muted' : ''}`);
    this.publishOptions.push(options);
    if (options.source === Track.Source.Microphone) this.micPublished = true;
    return Promise.resolve();
  }
}

class FakeRoom {
  static last: FakeRoom | null = null;
  state: ConnectionState = ConnectionState.Disconnected;
  canPlaybackAudio = true;
  options = { audioCaptureDefaults: {} };
  localParticipant = new FakeLocalParticipant();
  remoteParticipants = new Map();
  constructor() {
    FakeRoom.last = this;
  }
  on() {
    return this;
  }
  off() { return this; }
  removeAllListeners() {}
  connect() {
    this.state = ConnectionState.Connected;
    return Promise.resolve();
  }
  disconnect() {
    this.state = ConnectionState.Disconnected;
    return Promise.resolve();
  }
  startAudio() {
    return Promise.resolve();
  }
}

vi.mock('livekit-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('livekit-client')>();
  return {
    ...actual,
    Room: function Room() {
      return new FakeRoom();
    },
    createLocalAudioTrack: () => {
      const track = {
        muted: false,
        mute() {
          track.muted = true;
          return Promise.resolve(track);
        },
        stop() {},
        setAudioContext() {
          micEvents.push('audio context');
        },
        setProcessor() {
          micEvents.push('processor');
          return Promise.resolve();
        },
        getProcessor() {
          return undefined;
        },
      };
      return Promise.resolve(track);
    },
  };
});
vi.mock('../api/voice', () => ({
  voiceApi: {
    token: vi.fn(() => Promise.resolve({ url: 'wss://rtc.test', token: 'jwt', roomName: 'r', identity: 'me', channelId: 'ch1', expiresAt: '' })),
  },
}));
vi.mock('../sounds/sounds', () => ({ playSound: vi.fn() }));

const { voice } = await import('./voiceService');
const { useVoiceStore, INITIAL_VOICE_STATE } = await import('./voiceStore');

const settle = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};
const local = () => FakeRoom.last!.localParticipant;

describe('microphone start-up (join hiss)', () => {
  it('attaches the processing pipeline before LiveKit ever sees the microphone', async () => {
    await voice.reset();
    voice.setInputMode('voiceActivity', 50);
    useVoiceStore.setState(INITIAL_VOICE_STATE);
    const g = globalThis as Record<string, unknown>;
    const saved = { node: g.AudioWorkletNode, context: g.AudioContext };
    g.AudioWorkletNode = class {
      port = {};
    };
    g.AudioContext = class {
      close() {
        return Promise.resolve();
      }
    };
    micEvents.length = 0;
    try {
      await voice.join('ch1');
      await settle();
      expect(micEvents).toEqual(['audio context', 'processor', 'publish']);
      // Push-to-talk: same order, published muted.
      micEvents.length = 0;
      voice.setInputMode('pushToTalk', 0);
      await voice.leave();
      await voice.join('ch1');
      await settle();
      expect(micEvents).toEqual(['audio context', 'processor', 'publish muted']);
    } finally {
      g.AudioWorkletNode = saved.node;
      g.AudioContext = saved.context;
      await voice.reset();
    }
  });
});

describe('push-to-talk', () => {
  beforeEach(async () => {
    vi.useRealTimers();
    await voice.reset();
    voice.setInputMode('voiceActivity', 50);
    useVoiceStore.setState(INITIAL_VOICE_STATE);
  });

  it('joins with the microphone published but muted, then transmits only while the key is held', async () => {
    voice.setInputMode('pushToTalk', 0);
    await voice.join('ch1');
    await settle();
    expect(local().published).toEqual([{ source: Track.Source.Microphone, muted: true }]);
    expect(local().isMicrophoneEnabled).toBe(false);
    expect(useVoiceStore.getState().pttMode).toBe(true);

    voice.setPushToTalk(true);
    await settle();
    expect(local().isMicrophoneEnabled).toBe(true);
    expect(useVoiceStore.getState().pttActive).toBe(true);

    voice.setPushToTalk(false);
    await settle();
    expect(local().isMicrophoneEnabled).toBe(false);
    expect(useVoiceStore.getState().pttActive).toBe(false);
  });

  it('keeps the microphone open for the release delay', async () => {
    voice.setInputMode('pushToTalk', 200);
    await voice.join('ch1');
    await settle();
    vi.useFakeTimers();
    voice.setPushToTalk(true);
    await settle();
    voice.setPushToTalk(false);
    await settle();
    expect(local().isMicrophoneEnabled).toBe(true);
    vi.advanceTimersByTime(150);
    await settle();
    expect(local().isMicrophoneEnabled).toBe(true);
    // Pressing again within the delay cancels the release.
    voice.setPushToTalk(true);
    vi.advanceTimersByTime(100);
    await settle();
    expect(local().isMicrophoneEnabled).toBe(true);
    voice.setPushToTalk(false);
    vi.advanceTimersByTime(250);
    await settle();
    expect(local().isMicrophoneEnabled).toBe(false);
  });

  it('does not transmit while muted or deafened, even with the key held', async () => {
    voice.setInputMode('pushToTalk', 0);
    await voice.join('ch1');
    await settle();
    await voice.toggleMic(); // mute
    voice.setPushToTalk(true);
    await settle();
    expect(local().isMicrophoneEnabled).toBe(false);
    voice.setPushToTalk(false);
    await voice.toggleMic(); // unmute again
    await voice.toggleDeafen();
    voice.setPushToTalk(true);
    await settle();
    expect(local().isMicrophoneEnabled).toBe(false);
  });

  it('ends rapid taps in the state of the last event', async () => {
    voice.setInputMode('pushToTalk', 0);
    await voice.join('ch1');
    await settle();
    for (let i = 0; i < 5; i += 1) {
      voice.setPushToTalk(true);
      voice.setPushToTalk(false);
    }
    voice.setPushToTalk(true);
    await settle();
    expect(local().isMicrophoneEnabled).toBe(true);
  });

  it('switching back to voice activity opens the microphone', async () => {
    voice.setInputMode('pushToTalk', 0);
    await voice.join('ch1');
    await settle();
    voice.setInputMode('voiceActivity', 0);
    await settle();
    expect(local().isMicrophoneEnabled).toBe(true);
    expect(useVoiceStore.getState().pttMode).toBe(false);
  });

  it('ignores PTT events in voice-activity mode', async () => {
    await voice.join('ch1');
    await settle();
    const calls = local().micEnabledCalls.length;
    voice.setPushToTalk(true);
    voice.setPushToTalk(false);
    await settle();
    expect(local().micEnabledCalls.length).toBe(calls);
  });
});

describe('screen share publishing', () => {
  beforeEach(async () => {
    await voice.reset();
    useVoiceStore.setState(INITIAL_VOICE_STATE);
  });

  function fakeStream() {
    const video = { kind: 'video', contentHint: '', stop: vi.fn() };
    return {
      video,
      stream: { getTracks: () => [video], getVideoTracks: () => [video], getAudioTracks: () => [] } as unknown as MediaStream,
    };
  }

  it('game mode: real bitrate/FPS go to screenShareEncoding (not the ignored videoEncoding), one layer, motion first', async () => {
    await voice.join('ch1');
    const { stream, video } = fakeStream();
    await voice.publishScreenShare(stream, { frameRate: 60, maxBitrate: 12_000_000, contentMode: 'game' });
    const opts = local().publishOptions.find((o) => o.source === Track.Source.ScreenShare)!;
    expect(opts.screenShareEncoding).toEqual({ maxBitrate: 12_000_000, maxFramerate: 60, priority: 'high' });
    expect(opts.videoEncoding).toBeUndefined();
    expect(opts.simulcast).toBe(false);
    // 0.4.2: the selected resolution is held unless the user picked "Automatic".
    expect(opts.degradationPreference).toBe('maintain-resolution');
    expect(video.contentHint).toBe('motion');
  });

  it('text mode keeps resolution and uses a text/detail hint', async () => {
    await voice.join('ch1');
    const { stream, video } = fakeStream();
    await voice.publishScreenShare(stream, { frameRate: 30, maxBitrate: 5_000_000, contentMode: 'text' });
    const opts = local().publishOptions.find((o) => o.source === Track.Source.ScreenShare)!;
    expect(opts.degradationPreference).toBe('maintain-resolution');
    expect(opts.screenShareEncoding).toMatchObject({ maxBitrate: 5_000_000, maxFramerate: 30 });
    expect(['text', 'detail']).toContain(video.contentHint);
  });
});

describe('microphone access errors', () => {
  beforeEach(async () => {
    await voice.reset();
    voice.setInputMode('voiceActivity', 50);
    useVoiceStore.setState(INITIAL_VOICE_STATE);
  });

  it('shows the exclusive-use message and recovers with Retry', async () => {
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    await voice.join('ch1');
    await settle();
    await voice.toggleMic(); // mute
    local().failNextEnable = Object.assign(new Error('Could not start audio source'), { name: 'NotReadableError' });
    await voice.toggleMic(); // unmute -> Windows refuses
    await settle();
    expect(useVoiceStore.getState().micEnabled).toBe(false);
    expect(useVoiceStore.getState().micError).toMatch(/exclusive use/);
    await voice.retryMicrophone();
    await settle();
    expect(useVoiceStore.getState().micError).toBeNull();
    expect(useVoiceStore.getState().micEnabled).toBe(true);
    expect(local().isMicrophoneEnabled).toBe(true);
  });
});
