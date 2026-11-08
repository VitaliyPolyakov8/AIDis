import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionState, RoomEvent } from 'livekit-client';

type Handler = (...args: unknown[]) => void;

class FakeParticipant {
  isSpeaking = false;
  isMicrophoneEnabled = true;
  isScreenShareEnabled = false;
  connectionQuality = 'excellent';
  audioLevel = 0;
  trackPublications = new Map();
  identity: string;
  name: string;
  constructor(identity: string, name: string) {
    this.identity = identity;
    this.name = name;
  }
  micPublished = false;
  getTrackPublication(source?: string) {
    return source === 'microphone' && this.micPublished ? { source } : undefined;
  }
  publishTrack(track: { muted: boolean }, options: { source: string }) {
    if (options.source === 'microphone') {
      this.micPublished = true;
      this.isMicrophoneEnabled = !track.muted;
    }
    return Promise.resolve();
  }
  setMicrophoneEnabled(enabled: boolean) {
    this.isMicrophoneEnabled = enabled;
    this.micPublished = true;
    return Promise.resolve();
  }
  /** Playback volume per source, as the voice service sets it (local only). */
  volumes = new Map<string, number>();
  setVolume(volume: number, source = 'microphone') {
    this.volumes.set(source, volume);
  }
}

class FakeRoom {
  static last: FakeRoom | null = null;
  state: ConnectionState = ConnectionState.Disconnected;
  canPlaybackAudio = true;
  options = { audioCaptureDefaults: {} };
  localParticipant = new FakeParticipant('me', 'Me');
  remoteParticipants = new Map<string, FakeParticipant>();
  handlers = new Map<string, Handler[]>();
  constructor() {
    FakeRoom.last = this;
  }
  on(event: string, handler: Handler) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return this;
  }
  off(event: string, handler: Handler) {
    this.handlers.set(event, (this.handlers.get(event) ?? []).filter(h => h !== handler));
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    for (const h of this.handlers.get(event) ?? []) h(...args);
  }
  removeAllListeners() {
    this.handlers.clear();
  }
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
  /** Simulates a remote participant joining. */
  addRemote(identity: string) {
    const participant = new FakeParticipant(identity, identity);
    this.remoteParticipants.set(identity, participant);
    this.emit(RoomEvent.ParticipantConnected, participant);
  }
  /** LiveKit order: delete from the map, then emit ParticipantDisconnected. */
  removeRemote(identity: string) {
    const participant = this.remoteParticipants.get(identity);
    this.remoteParticipants.delete(identity);
    this.emit(RoomEvent.ParticipantDisconnected, participant);
  }
  /** LiveKit's handleRestarting(): disconnect events for everyone, THEN state -> Reconnecting. */
  fullReconnectStart() {
    for (const identity of [...this.remoteParticipants.keys()]) this.removeRemote(identity);
    this.state = ConnectionState.Reconnecting;
    this.emit(RoomEvent.ConnectionStateChanged, ConnectionState.Reconnecting);
  }
  reconnected(identities: string[]) {
    for (const id of identities) this.remoteParticipants.set(id, new FakeParticipant(id, id));
    this.state = ConnectionState.Connected;
    this.emit(RoomEvent.ConnectionStateChanged, ConnectionState.Connected);
  }
}

vi.mock('livekit-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('livekit-client')>();
  // FakeRoom is only touched when the service constructs a room (after this file has initialised).
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
      };
      return Promise.resolve(track);
    },
  };
});
vi.mock('../api/voice', () => ({
  voiceApi: {
    token: vi.fn(() =>
      Promise.resolve({ url: 'wss://rtc.test', token: 'jwt', roomName: 'voice-1', identity: 'me', channelId: 'ch1', expiresAt: '' }),
    ),
    participants: vi.fn(),
  },
}));
vi.mock('../sounds/sounds', () => ({ playSound: vi.fn() }));

const { voice } = await import('./voiceService');
const { useVoiceStore, INITIAL_VOICE_STATE } = await import('./voiceStore');
const { playSound } = await import('../sounds/sounds');
const { useAuthStore } = await import('../stores/authStore');
const { useSettingsStore } = await import('../stores/settingsStore');

const ids = () => useVoiceStore.getState().participants.map((p) => p.identity);
const occupancyIds = (channel = 'ch1') => (useVoiceStore.getState().occupancy[channel] ?? []).map((p) => p.identity);
const flush = () => Promise.resolve();

describe('voice service participant lifecycle', () => {
  beforeEach(async () => {
    await voice.reset();
    useVoiceStore.setState(INITIAL_VOICE_STATE);
    useAuthStore.setState({ user: { id: 'me', username: 'me', displayName: 'Me', avatarAttachmentId: null, role: 'USER', lastSeenAt: null } });
    vi.mocked(playSound).mockClear();
    await voice.join('ch1');
  });

  it('plays the join sound and lists local + remote participants', async () => {
    expect(playSound).toHaveBeenCalledWith('join');
    FakeRoom.last!.addRemote('bob');
    await flush();
    expect(ids()).toEqual(['me', 'bob']);
    expect(occupancyIds()).toEqual(['me', 'bob']);
  });

  it('removes a participant who leaves right away (same tick as LiveKit reports it)', async () => {
    FakeRoom.last!.addRemote('bob');
    await flush();
    FakeRoom.last!.removeRemote('bob');
    await flush();
    expect(ids()).toEqual(['me']);
    expect(occupancyIds()).toEqual(['me']);
  });

  it('does not remove anyone while our own connection does a full reconnect', async () => {
    FakeRoom.last!.addRemote('bob');
    await flush();
    FakeRoom.last!.fullReconnectStart();
    await flush();
    expect(useVoiceStore.getState().status).toBe('reconnecting');
    expect(ids()).toEqual(['me', 'bob']);

    FakeRoom.last!.reconnected(['bob']);
    await flush();
    expect(useVoiceStore.getState().status).toBe('connected');
    expect(ids()).toEqual(['me', 'bob']);
  });

  it('after a reconnect, someone who left during the outage disappears', async () => {
    FakeRoom.last!.addRemote('bob');
    FakeRoom.last!.addRemote('carol');
    await flush();
    FakeRoom.last!.fullReconnectStart();
    await flush();
    FakeRoom.last!.reconnected(['carol']);
    await flush();
    expect(ids()).toEqual(['me', 'carol']);
  });

  it('leaving removes us from the sidebar occupancy immediately and plays the leave sound', async () => {
    FakeRoom.last!.addRemote('bob');
    await flush();
    await voice.leave();
    expect(useVoiceStore.getState().status).toBe('idle');
    expect(occupancyIds()).toEqual(['bob']);
    expect(playSound).toHaveBeenLastCalledWith('leave');
  });

  it('runs exactly one stats timer while connected and stops it on leave', async () => {
    expect(voice.statsActive).toBe(true);
    await voice.join('ch1'); // same channel: no second room, no second timer
    expect(voice.statsActive).toBe(true);
    await voice.leave();
    expect(voice.statsActive).toBe(false);
    expect(useVoiceStore.getState().stats).toBeNull();
    await voice.join('ch1'); // rejoin: exactly one new loop
    expect(voice.statsActive).toBe(true);
  });

  it('drops stale stats while reconnecting', () => {
    useVoiceStore.setState({ stats: { rttMs: 40, lossPercent: 0, transport: 'UDP', relayProtocol: null } });
    FakeRoom.last!.fullReconnectStart();
    expect(useVoiceStore.getState().status).toBe('reconnecting');
    expect(useVoiceStore.getState().stats).toBeNull();
  });

  it('plays mute / unmute sounds locally', async () => {
    await voice.toggleMic();
    expect(playSound).toHaveBeenLastCalledWith('mute');
    expect(FakeRoom.last!.localParticipant.isMicrophoneEnabled).toBe(false);
    await voice.toggleMic();
    expect(playSound).toHaveBeenLastCalledWith('unmute');
  });
});

describe('per-user playback volume (local only)', () => {
  beforeEach(async () => {
    await voice.reset();
    useVoiceStore.setState(INITIAL_VOICE_STATE);
    useSettingsStore.setState({ userVolumes: {}, userMutes: {}, streamVolumes: {} });
    useAuthStore.setState({ user: { id: 'me', username: 'me', displayName: 'Me', avatarAttachmentId: null, role: 'USER', lastSeenAt: null } });
    await voice.join('ch1');
    FakeRoom.last!.addRemote('bob');
    FakeRoom.last!.addRemote('carol');
    FakeRoom.last!.remoteParticipants.get('bob')!.isScreenShareEnabled = true;
    FakeRoom.last!.remoteParticipants.get('carol')!.isScreenShareEnabled = true;
    await flush();
    useVoiceStore.setState({ watchedShares: ['bob', 'carol'], audioShare: 'bob' });
  });

  const vol = (id: string, source = 'microphone') => FakeRoom.last!.remoteParticipants.get(id)!.volumes.get(source);

  it('plays only the pinned stream audio while leaving both microphones unchanged', () => {
    useVoiceStore.setState({ watchedShares: ['bob', 'carol'] });
    voice.selectStreamAudio('bob');
    expect(vol('bob', 'screen_share_audio')).toBe(1);
    expect(vol('carol', 'screen_share_audio')).toBe(0);
    voice.selectStreamAudio('carol');
    expect(vol('bob', 'screen_share_audio')).toBe(0);
    expect(vol('carol', 'screen_share_audio')).toBe(1);
    expect(vol('bob')).toBe(1);
    expect(vol('carol')).toBe(1);
    voice.stopWatching('carol');
    expect(vol('carol', 'screen_share_audio')).toBe(0);
    expect(useVoiceStore.getState().audioShare).toBeNull();
    voice.selectStreamAudio('not-watched');
    expect(useVoiceStore.getState().audioShare).toBeNull();
  });

  it('changes only the chosen participant, and only their voice', () => {
    voice.setUserVolume('bob', 50);
    expect(vol('bob')).toBe(0.5);
    expect(vol('bob', 'screen_share_audio')).toBe(1); // stream audio has its own volume
    expect(vol('carol')).toBe(1);
    expect(useSettingsStore.getState().userVolumes).toEqual({ bob: 50 });
  });

  it('stream volume changes only the stream audio, 0..200 %; local mute silences it, deafen does not (0.4.5)', async () => {
    voice.setUserVolume('bob', 100);
    voice.setStreamVolume('bob', 35);
    expect(vol('bob', 'screen_share_audio')).toBe(0.35);
    expect(vol('bob')).toBe(1); // voice untouched
    voice.setStreamVolume('bob', 0);
    expect(vol('bob', 'screen_share_audio')).toBe(0);
    expect(vol('bob')).toBe(1);
    voice.setStreamVolume('bob', 500);
    expect(useSettingsStore.getState().streamVolumes.bob).toBe(200);
    expect(vol('bob', 'screen_share_audio')).toBe(2);
    voice.setUserMuted('bob', true);
    expect(vol('bob', 'screen_share_audio')).toBe(0);
    voice.setUserMuted('bob', false);
    await voice.toggleDeafen();
    // 0.4.5: headphones off silences voices, not the watched stream (it has its own mute).
    expect(vol('bob', 'screen_share_audio')).toBe(2);
    expect(vol('bob')).toBe(0);
    await voice.toggleDeafen();
    expect(vol('bob', 'screen_share_audio')).toBe(2);
    expect(vol('carol', 'screen_share_audio')).toBe(0);
  });

  it('allows up to 200 % and clamps nonsense', () => {
    voice.setUserVolume('bob', 200);
    expect(vol('bob')).toBe(2);
    voice.setUserVolume('bob', 999);
    expect(useSettingsStore.getState().userVolumes.bob).toBe(200);
  });

  it('local mute keeps the volume for unmuting, and deafen silences everyone', async () => {
    voice.setUserVolume('bob', 70);
    voice.setUserMuted('bob', true);
    expect(vol('bob')).toBe(0);
    expect(vol('carol')).toBe(1);
    voice.setUserMuted('bob', false);
    expect(vol('bob')).toBe(0.7);
    expect(useSettingsStore.getState().userMutes).toEqual({});
    await voice.toggleDeafen();
    expect(vol('bob')).toBe(0);
    expect(vol('carol')).toBe(0);
    await voice.toggleDeafen();
    expect(vol('bob')).toBe(0.7);
  });

  it('applies saved volumes to people who join later', () => {
    voice.setUserVolume('dave', 30);
    FakeRoom.last!.addRemote('dave');
    expect(vol('dave')).toBe(0.3);
  });
});
