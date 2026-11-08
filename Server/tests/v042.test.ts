import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { Socket } from 'socket.io-client';
import { connectSocket, createTestEnv, createUser, getVoiceChannelId, listen, login, waitForEvent, type LoginResult, type TestEnv } from './helpers.js';
import { VoiceSessionTracker, type VoiceMemberEvent, type VoiceRoomSource, type VoiceSessionView } from '../src/voice/voice-sessions.js';
import type { VoiceParticipantView } from '../src/voice/voice.service.js';

const quietLog = { debug: () => undefined } as unknown as FastifyBaseLogger;
const person = (identity: string): VoiceParticipantView => ({ identity, name: identity, joinedAt: null });

function setup() {
  const rooms = new Map<string, VoiceParticipantView[]>();
  const source: VoiceRoomSource = {
    listParticipants: (id) => Promise.resolve(rooms.get(id) ?? []),
    occupiedChannels: () => Promise.resolve([...rooms.entries()].filter(([, l]) => l.length > 0).map(([id]) => id)),
  };
  const sessions: VoiceSessionView[] = [];
  const members: VoiceMemberEvent[] = [];
  const tracker = new VoiceSessionTracker(source, (s) => sessions.push(s), quietLog, (e) => members.push(e));
  return { rooms, tracker, sessions, members };
}

describe('0.4.2 canonical voice membership (tracker)', () => {
  it('emits joined / left, and a move instead of a duplicate when the old room was not re-read yet', async () => {
    const { rooms, tracker, members } = setup();
    rooms.set('A', [person('u1'), person('u2')]);
    rooms.set('B', [person('u3')]);
    await tracker.sweep();
    expect(members.filter((e) => e.type === 'joined')).toHaveLength(3);

    // u2 switches to B; LiveKit already shows them in B but A is still stale.
    rooms.set('B', [person('u3'), person('u2')]);
    await tracker.refresh('B');
    expect(members.at(-1)).toMatchObject({ type: 'moved', fromChannelId: 'A', channelId: 'B' });
    const snap = tracker.snapshot();
    const everyone = snap.flatMap((s) => s.participants.map((p) => p.identity)).sort();
    expect(everyone).toEqual(['u1', 'u2', 'u3']); // never twice

    // The stale room A is read later: u2 is already gone there, nothing more is emitted for u2.
    rooms.set('A', [person('u1')]);
    const before = members.length;
    await tracker.refresh('A');
    expect(members.length).toBe(before);

    // u1 leaves: one "left".
    rooms.set('A', []);
    await tracker.refresh('A');
    expect(members.at(-1)).toEqual({ type: 'left', channelId: 'A', userId: 'u1' });
  });

  it('collapses a duplicate identity inside one room (LiveKit reconnect overlap)', async () => {
    const { rooms, tracker } = setup();
    rooms.set('A', [person('u1'), person('u1'), person('u2')]);
    await tracker.refresh('A');
    expect(tracker.snapshot()[0]?.participants.map((p) => p.identity)).toEqual(['u1', 'u2']);
  });
});

describe('0.4.2 realtime: voice.sync resync and explicit membership events', () => {
  let env: TestEnv;
  let baseUrl: string;
  let bob: LoginResult;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    env = await createTestEnv();
    await createUser(env, 'Bob42');
    bob = await login(env, 'Bob42');
    baseUrl = await listen(env);
  });
  afterAll(async () => {
    for (const s of sockets) s.close();
    await env.close();
  });

  it('answers voice.sync with a snapshot and routes joined / left / moved', async () => {
    const socket = connectSocket(baseUrl, bob.accessToken);
    sockets.push(socket);
    const first = waitForEvent(socket, 'voice.sessions');
    await waitForEvent(socket, 'ready');
    await first;
    const snapshot = waitForEvent<{ sessions: unknown[] }>(socket, 'voice.sessions');
    socket.emit('voice.sync', {});
    expect(await snapshot).toEqual({ sessions: [] });

    const voiceId = await getVoiceChannelId(env);
    const joined = waitForEvent<{ channelId: string }>(socket, 'voice.participant.joined');
    env.gateway.voiceMember({ type: 'joined', channelId: voiceId, participant: person('u9') });
    expect(await joined).toMatchObject({ channelId: voiceId, participant: { identity: 'u9' } });
    const left = waitForEvent<{ userId: string }>(socket, 'voice.participant.left');
    env.gateway.voiceMember({ type: 'left', channelId: voiceId, userId: 'u9' });
    expect(await left).toEqual({ channelId: voiceId, userId: 'u9' });
  });
});
