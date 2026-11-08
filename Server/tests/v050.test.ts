import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { StreamViewerRegistry, VoiceStateRegistry, type StreamViewersEvent } from '../src/voice/voice-states.js';
import { connectSocket, createTestEnv, createUser, getVoiceChannelId, listen, login, waitForEvent, type LoginResult, type TestEnv } from './helpers.js';

describe('0.5.0 voice state registry', () => {
  it('summarizes every connection of a user and reports only real changes', () => {
    const r = new VoiceStateRegistry();
    expect(r.set('s1', 'u', { muted: true, deafened: false, screen: false, camera: false })).toEqual({ userId: 'u', muted: true, deafened: false, screen: false, camera: false });
    expect(r.set('s1', 'u', { muted: true, deafened: false, screen: false, camera: false })).toBeNull();
    expect(r.set('s2', 'u', { muted: false, deafened: false, screen: true, camera: false })).toMatchObject({ muted: true, screen: true });
    expect(r.snapshot()).toEqual([{ userId: 'u', muted: true, deafened: false, screen: true, camera: false }]);
    expect(r.drop('s2')).toMatchObject({ muted: true, screen: false });
    expect(r.drop('s1')).toMatchObject({ muted: false });
    expect(r.snapshot()).toEqual([]);
  });
});

describe('0.5.0 stream viewers registry', () => {
  it("announces joins and (after the grace period) leaves only to the streamer and that stream's viewers", () => {
    vi.useFakeTimers();
    const events: { event: StreamViewersEvent; audience: string[] }[] = [];
    const r = new StreamViewerRegistry((event, audience) => events.push({ event, audience }), 4000);
    r.watch('b1', 'B', 'A', 'screen');
    expect(events.at(-1)).toEqual({ event: { streamerId: 'A', source: 'screen', viewers: ['B'], change: { userId: 'B', joined: true } }, audience: ['A', 'B'] });
    r.watch('c1', 'C', 'A', 'screen');
    expect(events.at(-1)?.audience.sort()).toEqual(['A', 'B', 'C']);
    // Another stream's viewers are separate.
    r.watch('c1', 'C', 'D', 'screen');
    expect(r.viewersOf('A', 'screen')).toEqual(['B', 'C']);
    expect(r.viewersOf('D', 'screen')).toEqual(['C']);
    const count = events.length;
    // B drops and comes back within the grace period: no event at all.
    r.unwatch('b1', 'B', 'A', 'screen');
    vi.advanceTimersByTime(2000);
    r.watch('b2', 'B', 'A', 'screen');
    vi.advanceTimersByTime(5000);
    expect(events.length).toBe(count);
    // B really leaves: one leave event after the grace period, B included (its own list clears).
    r.dropSocket('b2', 'B');
    expect(events.length).toBe(count);
    vi.advanceTimersByTime(4000);
    expect(events.at(-1)).toEqual({ event: { streamerId: 'A', source: 'screen', viewers: ['C'], change: { userId: 'B', joined: false } }, audience: ['A', 'C', 'B'] });
    // The stream ends: list cleared without a join/leave change.
    r.endStream('A', 'screen');
    expect(events.at(-1)?.event).toEqual({ streamerId: 'A', source: 'screen', viewers: [], change: null });
    expect(r.viewersOf('A', 'screen')).toEqual([]);
    vi.useRealTimers();
  });
});

describe('0.5.0 realtime voice states + stream viewers', () => {
  let env: TestEnv;
  let baseUrl: string;
  let a: LoginResult;
  let b: LoginResult;
  let c: LoginResult;

  beforeAll(async () => {
    env = await createTestEnv();
    for (const n of ['Anna', 'Boris', 'Carl']) await createUser(env, n);
    [a, b, c] = await Promise.all([login(env, 'Anna'), login(env, 'Boris'), login(env, 'Carl')]);
    baseUrl = await listen(env);
    // 0.7.0: a stream can only be watched by people who see the streamer's voice channel, so Anna
    // is put "in" the General voice channel the way LiveKit would report it.
    const tracker = (env.ctx.services.voice as unknown as { sessions: { apply(channelId: string, p: { identity: string; name: string; joinedAt: string | null }[]): void } }).sessions;
    tracker.apply(await getVoiceChannelId(env), [{ identity: a.user.id, name: 'Anna', joinedAt: new Date().toISOString() }]);
  });
  afterAll(async () => {
    await env.close();
  });

  it('shows mute / deafen / stream to people outside the channel and sends viewer events to the right people', async () => {
    const sa = connectSocket(baseUrl, a.accessToken);
    const sb = connectSocket(baseUrl, b.accessToken);
    const sc = connectSocket(baseUrl, c.accessToken);
    await Promise.all([waitForEvent(sa, 'ready'), waitForEvent(sb, 'ready'), waitForEvent(sc, 'ready')]);

    const seen = waitForEvent<Record<string, unknown>>(sc, 'voice.state');
    sa.emit('voice.state', { deafened: false, muted: true, screen: true, camera: false });
    expect(await seen).toEqual({ userId: a.user.id, deafened: false, muted: true, screen: true, camera: false });

    // A late connection (e.g. after a reconnect) gets the full snapshot.
    const late = connectSocket(baseUrl, c.accessToken);
    expect((await waitForEvent<{ states: unknown[] }>(late, 'voice.states')).states).toEqual([{ userId: a.user.id, deafened: false, muted: true, screen: true, camera: false }]);
    late.close();

    // B starts watching A's stream: A hears about it, C (not watching) does not.
    let cGotViewers = false;
    sc.on('stream.viewers', () => {
      cGotViewers = true;
    });
    const toA = waitForEvent<{ viewers: string[]; change: unknown }>(sa, 'stream.viewers');
    sb.emit('stream.watch', { streamerId: a.user.id, source: 'screen', watching: true });
    expect(await toA).toMatchObject({ viewers: [b.user.id], change: { userId: b.user.id, joined: true } });

    // The stream ends: viewer list cleared for A and B.
    const cleared = new Promise<{ viewers: string[]; change: unknown }>((resolve) => {
      sb.on('stream.viewers', (e: { viewers: string[]; change: unknown }) => {
        if (e.viewers.length === 0) resolve(e);
      });
    });
    sa.emit('voice.state', { deafened: false, muted: true, screen: false, camera: false });
    expect(await cleared).toMatchObject({ viewers: [], change: null });
    expect(cGotViewers).toBe(false);
    for (const s of [sa, sb, sc]) s.close();
  });
});

describe('0.5.0 nickname color', () => {
  let env: TestEnv;
  let baseUrl: string;
  let alice: LoginResult;
  let bob: LoginResult;
  beforeAll(async () => {
    env = await createTestEnv();
    await createUser(env, 'Alice');
    await createUser(env, 'Bob');
    [alice, bob] = await Promise.all([login(env, 'Alice'), login(env, 'Bob')]);
    baseUrl = await listen(env);
  });
  afterAll(async () => {
    await env.close();
  });
  const patchMe = (session: LoginResult, payload: unknown) =>
    env.app.inject({ method: 'PATCH', url: '/api/v1/users/me', headers: { authorization: `Bearer ${session.accessToken}` }, payload: payload as Record<string, unknown> });

  it('stores a readable #rrggbb, broadcasts it, rejects CSS / unreadable colors and resets to default', async () => {
    const bobSocket = connectSocket(baseUrl, bob.accessToken);
    await waitForEvent(bobSocket, 'ready');
    const updated = waitForEvent<{ id: string; nicknameColor: string | null }>(bobSocket, 'user.updated');
    const ok = await patchMe(alice, { nicknameColor: '#FF7AB6' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ user: { nicknameColor: string } }>().user.nicknameColor).toBe('#ff7ab6');
    expect(await updated).toMatchObject({ id: alice.user.id, nicknameColor: '#ff7ab6' });
    // Never CSS, never an invisible name.
    for (const bad of ['red', 'rgb(1,2,3)', '#fff; background:url(x)', '#12345', '#0a0a0c', '#1a1b20']) {
      expect((await patchMe(alice, { nicknameColor: bad })).statusCode, bad).toBe(400);
    }
    // Survives a new login (another device) and can be reset.
    const again = await login(env, 'Alice');
    const me = await env.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${again.accessToken}` } });
    expect(JSON.stringify(me.json())).toContain('#ff7ab6');
    expect((await patchMe(alice, { nicknameColor: null })).json<{ user: { nicknameColor: null } }>().user.nicknameColor).toBeNull();
    bobSocket.close();
  });
});
