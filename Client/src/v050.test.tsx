import { describe, expect, it, vi } from 'vitest';

const { streamKey, parseStreamKey, liveStreams, pruneWatched, applyMemberState, useVoiceStore, INITIAL_VOICE_STATE } = await import('./voice/voiceStore');
const { displayNicknameColor, isReadableNicknameColor, contrastOnBackground, NICKNAME_PRESETS } = await import('./components/profile/nicknameColor');
const { presetsFor, cameraErrorCode } = await import('./voice/camera');
const { cameraBitrate } = await import('./voice/voiceService');

const p = (identity: string, extra: Record<string, unknown> = {}) => ({ identity, name: identity, isLocal: false, isSpeaking: false, micMuted: false, screenSharing: false, ...extra });

describe('0.5.0 stream keys: screen and camera are separate streams', () => {
  it('keeps the screen key = identity (backwards compatible) and adds #camera', () => {
    expect(streamKey('a', 'screen')).toBe('a');
    expect(streamKey('a', 'camera')).toBe('a#camera');
    expect(parseStreamKey('a#camera')).toEqual({ identity: 'a', source: 'camera' });
    expect(parseStreamKey('a')).toEqual({ identity: 'a', source: 'screen' });
  });

  it('lists a game stream, a webcam and another stream independently and prunes ended ones', () => {
    const people = [p('A', { screenSharing: true }), p('B', { camera: true }), p('C', { screenSharing: true, camera: true })];
    expect(liveStreams(people).map((s) => s.key)).toEqual(['A', 'B#camera', 'C', 'C#camera']);
    // C stops the camera: only that tile goes.
    const after = [p('A', { screenSharing: true }), p('B', { camera: true }), p('C', { screenSharing: true })];
    expect(pruneWatched(after, ['A', 'C#camera', 'B#camera']).watched).toEqual(['A', 'B#camera']);
  });
});

describe('0.5.0 voice states from outside the channel', () => {
  it('stores muted / deafened / LIVE / camera per user and drops users with nothing on', () => {
    let states = applyMemberState({}, 'u', { muted: true, deafened: false, screen: true, camera: false });
    expect(states).toEqual({ u: { muted: true, deafened: false, screen: true, camera: false } });
    states = applyMemberState(states, 'u', { muted: false, deafened: false, screen: false, camera: false });
    expect(states).toEqual({});
  });
});

describe('0.5.0 nickname color readability', () => {
  it('keeps readable colors, lightens too-dark ones and ignores anything that is not #rrggbb', () => {
    expect(displayNicknameColor('#FF7AB6')).toBe('#ff7ab6');
    expect(displayNicknameColor(null)).toBeNull();
    expect(displayNicknameColor('red')).toBeNull();
    expect(displayNicknameColor('#fff; background:url(x)')).toBeNull();
    const fixed = displayNicknameColor('#0a0a2a');
    expect(fixed).not.toBe('#0a0a2a');
    expect(fixed && contrastOnBackground(fixed)).toBeGreaterThanOrEqual(3);
    expect(isReadableNicknameColor('#0a0a2a')).toBe(false);
    for (const preset of NICKNAME_PRESETS) expect(isReadableNicknameColor(preset), preset).toBe(true);
  });
});

describe('0.5.0 webcam', () => {
  it('offers only presets the camera reports (720p30 always, 1080p / 60 FPS when supported)', () => {
    expect(presetsFor(null).map((x) => `${x.resolution}@${x.fps}`)).toEqual(['720p@30']);
    expect(presetsFor({ width: { max: 1280 }, height: { max: 720 }, frameRate: { max: 30 } }).map((x) => `${x.resolution}@${x.fps}`)).toEqual(['720p@30']);
    expect(presetsFor({ width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 30 } }).map((x) => `${x.resolution}@${x.fps}`)).toEqual(['720p@30', '1080p@30']);
    expect(presetsFor({ width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 60 } }).map((x) => `${x.resolution}@${x.fps}`)).toEqual(['720p@30', '720p@60', '1080p@30', '1080p@60']);
  });

  it('turns getUserMedia errors into clear reasons', () => {
    expect(cameraErrorCode(new DOMException('x', 'NotAllowedError'))).toBe('denied');
    expect(cameraErrorCode(new DOMException('x', 'NotReadableError'))).toBe('busy');
    expect(cameraErrorCode(new DOMException('x', 'NotFoundError'))).toBe('notFound');
    expect(cameraErrorCode(new Error('weird'))).toBe('failed');
  });

  it('uses a modest bitrate that leaves room for a game stream', () => {
    expect(cameraBitrate({ width: 1280, height: 720, frameRate: 30 })).toBe(2_500_000);
    expect(cameraBitrate({ width: 1920, height: 1080, frameRate: 60 })).toBe(6_750_000);
  });
});

describe('0.5.0 stream viewer events over the socket', () => {
  it('updates the viewer list and plays a sound only for the streamer / viewers of that stream, never for yourself', async () => {
    const sockets: { handlers: Record<string, (p: unknown) => void>; fire: (e: string, p: unknown) => void }[] = [];
    vi.doMock('socket.io-client', () => ({
      io: () => {
        const handlers: Record<string, (p: unknown) => void> = {};
        const s = {
          handlers,
          connected: true,
          on: (e: string, h: (p: unknown) => void) => {
            handlers[e] = h;
            return s;
          },
          emit: vi.fn(),
          connect: vi.fn(),
          disconnect: vi.fn(),
          removeAllListeners: vi.fn(),
          io: { on: vi.fn(), removeAllListeners: vi.fn() },
          fire: (e: string, payload: unknown) => handlers[e]?.(payload),
        };
        sockets.push(s);
        return s;
      },
    }));
    const played: string[] = [];
    vi.doMock('./sounds/sounds', () => ({ playSound: (name: string) => played.push(name) }));
    vi.resetModules();
    const { realtime } = await import('./realtime/socket');
    const store = await import('./voice/voiceStore');
    const { useAuthStore } = await import('./stores/authStore');
    useAuthStore.setState({ user: { id: 'me' } as never });
    store.useVoiceStore.setState({ ...store.INITIAL_VOICE_STATE, watchedShares: ['A'] });
    realtime.connect();
    const socket = sockets[0]!;
    socket.fire('stream.viewers', { streamerId: 'A', source: 'screen', viewers: ['me', 'C'], change: { userId: 'C', joined: true } });
    expect(store.useVoiceStore.getState().streamViewers).toEqual({ A: ['me', 'C'] });
    expect(played).toEqual(['viewerJoin']);
    // Our own join: no sound.
    socket.fire('stream.viewers', { streamerId: 'A', source: 'screen', viewers: ['me', 'C'], change: { userId: 'me', joined: true } });
    expect(played).toEqual(['viewerJoin']);
    // A stream we neither stream nor watch: list only, no sound.
    socket.fire('stream.viewers', { streamerId: 'Z', source: 'camera', viewers: ['C'], change: { userId: 'C', joined: true } });
    expect(played).toEqual(['viewerJoin']);
    socket.fire('stream.viewers', { streamerId: 'A', source: 'screen', viewers: ['me'], change: { userId: 'C', joined: false } });
    expect(played).toEqual(['viewerJoin', 'viewerLeave']);
    // Only the difference of what we watch goes to the server; leaving sends "stopped watching".
    realtime.setWatchedStreams([{ streamerId: 'A', source: 'screen' }]);
    realtime.setWatchedStreams([{ streamerId: 'A', source: 'screen' }, { streamerId: 'B', source: 'camera' }]);
    realtime.setWatchedStreams([]);
    const emits = (socket as unknown as { emit: { mock: { calls: unknown[][] } } }).emit.mock.calls.filter((c) => c[0] === 'stream.watch');
    expect(emits).toEqual([
      ['stream.watch', { streamerId: 'A', source: 'screen', watching: true }],
      ['stream.watch', { streamerId: 'B', source: 'camera', watching: true }],
      ['stream.watch', { streamerId: 'A', source: 'screen', watching: false }],
      ['stream.watch', { streamerId: 'B', source: 'camera', watching: false }],
    ]);
    realtime.disconnect();
    useVoiceStore.setState(INITIAL_VOICE_STATE);
  });
});
