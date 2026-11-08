import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { Socket } from 'socket.io-client';
import { connectSocket, createTestEnv, createUser, getVoiceChannelId, listen, login, waitForEvent, type LoginResult, type TestEnv } from './helpers.js';
import { VoiceSessionTracker, type VoiceRoomSource, type VoiceSessionView } from '../src/voice/voice-sessions.js';
import type { VoiceParticipantView } from '../src/voice/voice.service.js';

const quietLog = { debug: () => undefined } as unknown as FastifyBaseLogger;
const person = (identity: string, joinedAt: string | null = null): VoiceParticipantView => ({ identity, name: identity, joinedAt });

/** A LiveKit stand-in: rooms are plain arrays the test edits. */
function fakeLiveKit() {
  const rooms = new Map<string, VoiceParticipantView[]>();
  let down = false;
  const source: VoiceRoomSource = {
    listParticipants: (channelId) => (down ? Promise.reject(new Error('down')) : Promise.resolve(rooms.get(channelId) ?? [])),
    occupiedChannels: () => (down ? Promise.reject(new Error('down')) : Promise.resolve([...rooms.entries()].filter(([, list]) => list.length > 0).map(([id]) => id))),
  };
  return {
    rooms,
    source,
    setDown: (value: boolean) => {
      down = value;
    },
  };
}

describe('0.4.1 voice session timer (VoiceSessionTracker)', () => {
  it('starts on 0 -> 1, keeps the start while people come and go, clears on 1 -> 0', async () => {
    const lk = fakeLiveKit();
    const events: VoiceSessionView[] = [];
    const tracker = new VoiceSessionTracker(lk.source, (s) => events.push(s), quietLog);

    const t0 = new Date(Date.now() - 42_000).toISOString();
    lk.rooms.set('A', [person('alice', t0)]);
    await tracker.refresh('A');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ channelId: 'A', startedAt: t0 });

    // B joins: same start, new participant list.
    lk.rooms.set('A', [person('alice', t0), person('bob', new Date().toISOString())]);
    await tracker.refresh('A');
    expect(events[1]?.startedAt).toBe(t0);
    expect(events[1]?.participants.map((p) => p.identity)).toEqual(['alice', 'bob']);

    // Nothing changed: no event.
    await tracker.refresh('A');
    expect(events).toHaveLength(2);

    // A leaves, B stays: the timer keeps running from the original start.
    lk.rooms.set('A', [person('bob', new Date().toISOString())]);
    await tracker.refresh('A');
    expect(events[2]?.startedAt).toBe(t0);

    // Empty: the session ends.
    lk.rooms.set('A', []);
    await tracker.refresh('A');
    expect(events[3]).toEqual({ channelId: 'A', startedAt: null, participants: [] });
    expect(tracker.snapshot()).toEqual([]);

    // Somebody joins again: a new session with a new start.
    const t1 = new Date().toISOString();
    lk.rooms.set('A', [person('carol', t1)]);
    await tracker.refresh('A');
    expect(events[4]?.startedAt).toBe(t1);
  });

  it('rebuilds sessions after a restart from LiveKit join times (sweep), and closes rooms that emptied', async () => {
    const lk = fakeLiveKit();
    const events: VoiceSessionView[] = [];
    const early = new Date(Date.now() - 3_600_000).toISOString();
    const later = new Date(Date.now() - 60_000).toISOString();
    lk.rooms.set('A', [person('bob', later), person('alice', early)]);
    lk.rooms.set('B', []);
    // A fresh tracker = the backend just restarted.
    const tracker = new VoiceSessionTracker(lk.source, (s) => events.push(s), quietLog);
    await tracker.sweep();
    expect(tracker.snapshot()).toEqual([expect.objectContaining({ channelId: 'A', startedAt: early })]);

    // Everybody left while no client said so: the sweep closes it.
    lk.rooms.set('A', []);
    await tracker.sweep();
    expect(events.at(-1)).toEqual({ channelId: 'A', startedAt: null, participants: [] });
  });

  it('keeps what it knows while LiveKit is unreachable, and debounces bursts of hints', async () => {
    vi.useFakeTimers();
    try {
      const lk = fakeLiveKit();
      const events: VoiceSessionView[] = [];
      const tracker = new VoiceSessionTracker(lk.source, (s) => events.push(s), quietLog);
      lk.rooms.set('A', [person('alice', new Date().toISOString())]);
      const spy = vi.spyOn(lk.source, 'listParticipants');
      tracker.touch('A');
      tracker.touch('A');
      tracker.touch('A');
      await vi.advanceTimersByTimeAsync(1000);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(events).toHaveLength(1);

      lk.setDown(true);
      await tracker.sweep();
      await tracker.refresh('A');
      expect(tracker.snapshot()).toHaveLength(1);
      expect(events).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

interface Presence {
  userId: string;
  activity: { type: string; name: string; startedAt?: string; steamAppId?: number | null } | null;
}

describe('0.4.1 realtime: voice sessions and game activity startedAt', () => {
  let env: TestEnv;
  let baseUrl: string;
  let alice: LoginResult;
  let bob: LoginResult;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    env = await createTestEnv();
    await createUser(env, 'Alice41');
    await createUser(env, 'Bob41');
    alice = await login(env, 'Alice41');
    bob = await login(env, 'Bob41');
    baseUrl = await listen(env);
  });

  afterAll(async () => {
    for (const s of sockets) s.close();
    await env.close();
  });

  async function connect(token: string): Promise<{ socket: Socket; sessions: { sessions: VoiceSessionView[] } }> {
    const socket = connectSocket(baseUrl, token);
    sockets.push(socket);
    const sessions = waitForEvent<{ sessions: VoiceSessionView[] }>(socket, 'voice.sessions');
    await waitForEvent(socket, 'ready');
    return { socket, sessions: await sessions };
  }

  function nextActivity(socket: Socket, userId: string, match: (p: Presence) => boolean): Promise<Presence> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.off('presence.updated', on);
        reject(new Error('Timed out waiting for presence.updated'));
      }, 5000);
      const on = (p: Presence) => {
        if (p.userId !== userId || !match(p)) return;
        clearTimeout(timer);
        socket.off('presence.updated', on);
        resolve(p);
      };
      socket.on('presence.updated', on);
    });
  }

  it('sends voice sessions after ready and routes changes to people who can see the channel', async () => {
    const { socket: bobSocket, sessions } = await connect(bob.accessToken);
    expect(sessions).toEqual({ sessions: [] });
    const voiceId = await getVoiceChannelId(env);
    const startedAt = new Date(Date.now() - 5000).toISOString();
    const got = waitForEvent<VoiceSessionView>(bobSocket, 'voice.session');
    env.gateway.voiceSession({ channelId: voiceId, startedAt, participants: [{ identity: alice.user.id, name: 'Alice41', joinedAt: startedAt }] });
    expect(await got).toMatchObject({ channelId: voiceId, startedAt });
    // A malformed hint is ignored; a valid one is accepted without errors.
    bobSocket.emit('voice.presence', { channelId: 'nope' });
    bobSocket.emit('voice.presence', { channelId: voiceId });
    bobSocket.emit('voice.presence', { channelId: null });
  });

  it('game startedAt: set on start, kept on re-report, reset on another game, cleared on close', async () => {
    const { socket: bobSocket } = await connect(bob.accessToken);
    const { socket: aliceSocket } = await connect(alice.accessToken);
    const uid = alice.user.id;

    let next = nextActivity(bobSocket, uid, (p) => p.activity?.name === 'PowerWash Simulator 2');
    aliceSocket.emit('activity.set', { name: 'PowerWash Simulator 2', steamAppId: 2_000_000 });
    const first = (await next).activity;
    expect(first).toMatchObject({ type: 'playing', name: 'PowerWash Simulator 2', steamAppId: 2_000_000 });
    expect(Date.now() - Date.parse(first?.startedAt ?? '')).toBeLessThan(5000);

    // The same game again (a re-scan) does not restart the timer: no visible change, no event.
    let extra = false;
    const onExtra = (p: Presence) => {
      if (p.userId === uid) extra = true;
    };
    bobSocket.on('presence.updated', onExtra);
    await new Promise((r) => setTimeout(r, 1100));
    aliceSocket.emit('activity.set', { name: 'PowerWash Simulator 2', steamAppId: 2_000_000 });
    await new Promise((r) => setTimeout(r, 400));
    bobSocket.off('presence.updated', onExtra);
    expect(extra).toBe(false);

    // Game A -> Game B: a new start.
    await new Promise((r) => setTimeout(r, 1100));
    next = nextActivity(bobSocket, uid, (p) => p.activity?.name === 'Helldivers 2');
    aliceSocket.emit('activity.set', { name: 'Helldivers 2' });
    const second = (await next).activity;
    expect(Date.parse(second?.startedAt ?? '')).toBeGreaterThan(Date.parse(first?.startedAt ?? ''));

    // A reconnecting desktop app reports when the game really started (trusted within 48 h).
    await new Promise((r) => setTimeout(r, 1100));
    const real = new Date(Date.now() - 84 * 60_000).toISOString();
    next = nextActivity(bobSocket, uid, (p) => p.activity?.startedAt === real);
    aliceSocket.emit('activity.set', { name: 'Helldivers 2', startedAt: real });
    expect((await next).activity?.startedAt).toBe(real);

    // Absurd start times are ignored; paths are still rejected.
    await new Promise((r) => setTimeout(r, 1100));
    next = nextActivity(bobSocket, uid, (p) => p.activity?.name === 'Elden Ring');
    aliceSocket.emit('activity.set', { name: 'Elden Ring', startedAt: '2001-01-01T00:00:00.000Z' });
    const third = (await next).activity;
    expect(Date.now() - Date.parse(third?.startedAt ?? '')).toBeLessThan(5000);

    next = nextActivity(bobSocket, uid, (p) => p.activity === null);
    aliceSocket.emit('activity.set', { name: null });
    expect((await next).activity).toBeNull();

  });
});
