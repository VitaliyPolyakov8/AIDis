import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionState, RoomEvent, Track, type Room } from 'livekit-client';
import { bindStreamInteractions, normaliseVideoPoint, streamInteractions, subscribeOwnStreamHints, useStreamInteractions, type OwnStreamHint } from './streamInteractions';

class Member {
  identity: string;
  publication: { trackSid: string; track: { mediaStreamTrack: { id: string; readyState: string } } } | undefined;
  publishData = vi.fn(async (_payload: Uint8Array, _options: unknown) => undefined);
  constructor(identity: string, sharing = false) {
    this.identity = identity;
    if (sharing) this.publication = { trackSid: `track-${identity}`, track: { mediaStreamTrack: { id: `capture-${identity}`, readyState: 'live' } } };
  }
  getTrackPublication(source: string) { return source === Track.Source.ScreenShare ? this.publication : undefined; }
}
class TestRoom {
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  on(event: string, listener: (...args: unknown[]) => void) { const group = this.listeners.get(event) ?? new Set(); group.add(listener); this.listeners.set(event, group); return this; }
  off(event: string, listener: (...args: unknown[]) => void) { this.listeners.get(event)?.delete(listener); return this; }
  emit(event: string, ...args: unknown[]) { for (const listener of this.listeners.get(event) ?? []) listener(...args); }
  listenerCount(event: string) { return this.listeners.get(event)?.size ?? 0; }
  state = ConnectionState.Connected;
  name = 'voice-one';
  localParticipant = new Member('me', true);
  remoteParticipants = new Map([['bob', new Member('bob', true)], ['viewer', new Member('viewer')]]);
}

describe('stream interactions over authenticated room data', () => {
  let room: TestRoom;
  let cleanup: () => void;
  let sequence = 0;
  const topic = 'aidis.stream.interactions.v1';
  const own = () => useStreamInteractions.getState().streams.me;
  const incoming = (body: Record<string, unknown>, sender = room.remoteParticipants.get('bob'), otherTopic = topic) => {
    const data = { v: 1, id: `event-${++sequence}`, at: Date.now(), ...body };
    room.emit(RoomEvent.DataReceived, new TextEncoder().encode(JSON.stringify(data)), sender, undefined, otherTopic);
    return data;
  };
  const pointer = (extra: Record<string, unknown> = {}) => incoming({ type: 'pointer', owner: 'me', sid: 'track-me', generation: own()?.generation, x: 0.25, y: 0.75, ...extra });
  const remoteState = (extra: Record<string, unknown> = {}) => incoming({ type: 'state', sid: 'track-bob', generation: 'bob-generation-1', seq: 1, pointers: true, ...extra });

  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-31T12:00:00Z'));
    room = new TestRoom(); cleanup = bindStreamInteractions(room as unknown as Room);
    room.localParticipant.publishData.mockClear();
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('defaults consent off and prevents another participant enabling the local owner', () => {
    expect(own()?.pointers).toBe(false);
    pointer(); expect(useStreamInteractions.getState().pointers).toHaveLength(0);
    remoteState({ sid: 'track-me', owner: 'me' });
    expect(own()?.pointers).toBe(false);
    expect(streamInteractions.setPointers(true)).toBe(true);
    const data = JSON.parse(new TextDecoder().decode(room.localParticipant.publishData.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(data).toMatchObject({ type: 'state', pointers: true, sid: 'track-me' });
  });

  it('accepts normalized pointers only for the opted-in local publication, derives sender and expires hints', () => {
    const hints: (OwnStreamHint | null)[] = [];
    const unsubscribe = subscribeOwnStreamHints((hint) => hints.push(hint));
    streamInteractions.setPointers(true);
    pointer({ sender: 'forged-name' });
    expect(useStreamInteractions.getState().pointers).toMatchObject([{ sender: 'bob', owner: 'me', x: 0.25, y: 0.75 }]);
    expect(hints).toMatchObject([null, { type: 'pointer', sender: 'bob', x: 0.25, y: 0.75 }]);
    vi.advanceTimersByTime(2100);
    expect(useStreamInteractions.getState().pointers).toHaveLength(0);
    unsubscribe();
  });

  it('rejects oversized, malformed, stale, replayed, nonmember, nonexistent and invalid-coordinate events', () => {
    streamInteractions.setPointers(true);
    pointer({ x: -1 }); pointer({ y: 1.1 }); pointer({ x: null });
    pointer({ at: Date.now() - 3000 }); pointer({ at: Date.now() + 10000 });
    pointer({ sid: 'wrong' }); pointer({ owner: 'missing' });
    pointer({ extra: 'x'.repeat(1200) });
    incoming({ type: 'pointer', owner: 'me', sid: 'track-me', generation: own()?.generation, x: 0.5, y: 0.5 }, new Member('intruder'));
    incoming({ type: 'pointer', owner: 'me', sid: 'track-me', generation: own()?.generation, x: 0.5, y: 0.5 }, new Member('bob'));
    room.emit(RoomEvent.DataReceived, new TextEncoder().encode('{'), room.remoteParticipants.get('bob'), undefined, topic);
    expect(useStreamInteractions.getState().pointers).toHaveLength(0);
    const accepted = pointer();
    incoming(accepted);
    expect(useStreamInteractions.getState().pointers).toHaveLength(1);
  });

  it('limits pointers and reactions per participant across targets and keeps bounded transient lists', () => {
    streamInteractions.setPointers(true);
    pointer(); pointer(); pointer();
    expect(useStreamInteractions.getState().pointers).toHaveLength(2);
    for (let n = 0; n < 6; n++) incoming({ type: 'reaction', owner: 'me', sid: 'track-me', generation: own()?.generation, reaction: 'clap' });
    expect(useStreamInteractions.getState().reactions).toHaveLength(3);
    vi.advanceTimersByTime(1001);
    pointer(); expect(useStreamInteractions.getState().pointers).toHaveLength(3);
    for (let n = 0; n < 25; n++) {
      const member = new Member(`guest-${n}`); room.remoteParticipants.set(member.identity, member);
      incoming({ type: 'reaction', owner: 'me', sid: 'track-me', generation: own()?.generation, reaction: 'f' }, member);
      incoming({ type: 'pointer', owner: 'me', sid: 'track-me', generation: own()?.generation, x: 0, y: 1 }, member);
    }
    expect(useStreamInteractions.getState().pointers.length).toBeLessThanOrEqual(8);
    expect(useStreamInteractions.getState().reactions.length).toBeLessThanOrEqual(24);
  });

  it('sends pointers only to the consenting owner and broadcasts enumerated reactions with local feedback', () => {
    remoteState();
    expect(streamInteractions.point('bob', { x: 0.2, y: 0.8 })).toBe(true);
    expect(room.localParticipant.publishData.mock.calls.at(-1)?.[1]).toMatchObject({ reliable: false, destinationIdentities: ['bob'], topic });
    expect(useStreamInteractions.getState().pointers).toHaveLength(0);
    expect(streamInteractions.react('bob', 'laugh')).toBe(true);
    expect(room.localParticipant.publishData.mock.calls.at(-1)?.[1]).toEqual({ reliable: false, topic });
    expect(useStreamInteractions.getState().reactions).toMatchObject([{ owner: 'bob', sender: 'me', reaction: 'laugh' }]);
    incoming({ type: 'reaction', owner: 'me', sid: 'track-me', generation: own()?.generation, reaction: '<img onerror=alert(1)>' });
    expect(useStreamInteractions.getState().reactions).toHaveLength(1);
  });

  it('lets streamers react to their own publication and rejects ended or replaced targets', () => {
    expect(streamInteractions.react('me', 'f')).toBe(true);
    expect(useStreamInteractions.getState().reactions).toMatchObject([{ owner: 'me', sender: 'me', reaction: 'f' }]);
    remoteState();
    incoming({ type: 'reaction', owner: 'bob', sid: 'track-bob', generation: 'bob-generation-1', reaction: 'laugh' });
    expect(useStreamInteractions.getState().reactions).toHaveLength(2);
    room.remoteParticipants.get('bob')!.publication!.trackSid = 'replacement-bob';
    room.emit(RoomEvent.TrackPublished);
    incoming({ type: 'reaction', owner: 'bob', sid: 'track-bob', generation: 'bob-generation-1', reaction: 'clap' });
    expect(useStreamInteractions.getState().reactions).toHaveLength(1);
    expect(streamInteractions.react('bob', 'laugh')).toBe(false);
    room.localParticipant.publication!.track.mediaStreamTrack.readyState = 'ended';
    vi.advanceTimersByTime(250);
    expect(useStreamInteractions.getState().streams.me).toBeUndefined();
    expect(useStreamInteractions.getState().reactions).toHaveLength(0);
    expect(streamInteractions.react('me', 'f')).toBe(false);
  });

  it('clears remote reaction state on consent changes and expires all reaction feedback', () => {
    remoteState();
    incoming({ type: 'reaction', owner: 'bob', sid: 'track-bob', generation: 'bob-generation-1', reaction: 'laugh' });
    remoteState({ seq: 2, pointers: false, generation: 'bob-generation-2' });
    expect(useStreamInteractions.getState().reactions).toHaveLength(0);
    expect(streamInteractions.point('bob', { x: 0.5, y: 0.5 })).toBe(false);
    incoming({ type: 'reaction', owner: 'bob', sid: 'track-bob', generation: 'bob-generation-1', reaction: 'laugh' });
    expect(useStreamInteractions.getState().reactions).toHaveLength(0);
    streamInteractions.react('bob', 'clap');
    vi.advanceTimersByTime(2750);
    expect(useStreamInteractions.getState().reactions).toHaveLength(0);
  });

  it('clears markers and rotates consent on opt-out, source replacement, track end and room changes', () => {
    streamInteractions.setPointers(true); const oldGeneration = own()?.generation;
    pointer(); streamInteractions.setPointers(false);
    expect(useStreamInteractions.getState().pointers).toHaveLength(0);
    streamInteractions.setPointers(true); pointer({ generation: oldGeneration });
    expect(useStreamInteractions.getState().pointers).toHaveLength(0);
    pointer(); streamInteractions.sourceChanged();
    expect(own()?.pointers).toBe(false); expect(useStreamInteractions.getState().pointers).toHaveLength(0);
    streamInteractions.setPointers(true); pointer();
    room.localParticipant.publication = undefined; room.emit(RoomEvent.LocalTrackUnpublished);
    vi.advanceTimersByTime(300);
    expect(useStreamInteractions.getState().streams.me).toBeUndefined();
    expect(useStreamInteractions.getState().pointers).toHaveLength(0);
    remoteState(); room.name = 'voice-two'; room.emit(RoomEvent.Moved, 'voice-two');
    expect(useStreamInteractions.getState().streams.bob?.pointers).toBe(false);
  });

  it('syncs owner consent to newly joined viewers and ignores out-of-order owner states', () => {
    streamInteractions.setPointers(true); room.localParticipant.publishData.mockClear();
    incoming({ type: 'sync' }, room.remoteParticipants.get('viewer'));
    expect(room.localParticipant.publishData.mock.calls[0]?.[1]).toMatchObject({ reliable: true, destinationIdentities: ['viewer'] });
    remoteState({ seq: 2, pointers: false }); remoteState({ seq: 1, pointers: true });
    expect(useStreamInteractions.getState().streams.bob?.pointers).toBe(false);
  });

  it('removes listeners, timers and session state on cleanup', () => {
    streamInteractions.setPointers(true); pointer(); cleanup();
    expect(useStreamInteractions.getState().pointers).toEqual([]);
    expect(useStreamInteractions.getState().streams).toEqual({});
    expect(room.listenerCount(RoomEvent.DataReceived)).toBe(0);
    expect(streamInteractions.react('me', 'f')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps session state empty while disconnected and starts fresh after reconnect', () => {
    streamInteractions.setPointers(true); pointer();
    room.state = ConnectionState.Disconnected;
    room.emit(RoomEvent.Disconnected);
    vi.advanceTimersByTime(1000);
    expect(useStreamInteractions.getState().streams).toEqual({});
    expect(streamInteractions.point('bob', { x: 0.5, y: 0.5 })).toBe(false);
    room.state = ConnectionState.Connected; room.emit(RoomEvent.Reconnected);
    expect(own()?.pointers).toBe(false);
  });

  it('forwards native clear signals on source change, opt-out and stream end', () => {
    const hints: (OwnStreamHint | null)[] = [];
    const unsubscribe = subscribeOwnStreamHints((hint) => hints.push(hint));
    streamInteractions.setPointers(true); pointer();
    streamInteractions.sourceChanged();
    expect(hints.at(-1)).toBeNull();
    streamInteractions.setPointers(true); pointer(); streamInteractions.setPointers(false);
    expect(hints.at(-1)).toBeNull();
    room.localParticipant.publication = undefined; room.emit(RoomEvent.LocalTrackUnpublished);
    expect(hints.at(-1)).toBeNull();
    unsubscribe();
  });
});

describe('contained-video pointer geometry', () => {
  it('normalizes landscape content and ignores top/bottom letterboxes', () => {
    const rect = { left: 100, top: 50, width: 400, height: 400 };
    expect(normaliseVideoPoint(rect, 1920, 1080, 300, 250)).toEqual({ x: 0.5, y: 0.5 });
    expect(normaliseVideoPoint(rect, 1920, 1080, 300, 60)).toBeNull();
    expect(normaliseVideoPoint(rect, 1920, 1080, 300, 440)).toBeNull();
  });
  it('ignores side letterboxes and missing/invalid video dimensions', () => {
    const rect = { left: 0, top: 0, width: 800, height: 400 };
    expect(normaliseVideoPoint(rect, 400, 800, 400, 0)).toEqual({ x: 0.5, y: 0 });
    expect(normaliseVideoPoint(rect, 400, 800, 50, 200)).toBeNull();
    expect(normaliseVideoPoint(rect, 0, 0, 400, 200)).toBeNull();
    expect(normaliseVideoPoint(rect, 1920, 1080, Number.NaN, 200)).toBeNull();
  });
});
