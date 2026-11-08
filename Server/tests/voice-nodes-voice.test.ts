/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- inject().json() bodies are untyped; the assertions check their shape. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/** Who LiveKit says is in a room, per LiveKit API url: { [apiUrl]: { [room]: identities } }. */
const lk = vi.hoisted(() => {
  const rooms: Record<string, Record<string, string[]>> = {};
  return { rooms, removed: [] as string[] };
});

vi.mock('livekit-server-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('livekit-server-sdk')>();
  class FakeRoomServiceClient {
    constructor(readonly url: string) {}
    listRooms() {
      const rooms = lk.rooms[this.url] ?? {};
      return Promise.resolve(Object.entries(rooms).map(([name, ids]) => ({ name, numParticipants: ids.length })));
    }
    listParticipants(room: string) {
      return Promise.resolve((lk.rooms[this.url]?.[room] ?? []).map((identity) => ({ identity, name: identity, joinedAt: BigInt(0) })));
    }
    removeParticipant(room: string, identity: string) {
      lk.removed.push(`${this.url} ${room} ${identity}`);
      return Promise.resolve();
    }
    moveParticipant() {
      return Promise.resolve();
    }
  }
  return { ...actual, RoomServiceClient: FakeRoomServiceClient };
});

const { bearer, connectSocket, createTestEnv, createUser, getVoiceChannelId, listen, login, waitForEvent } = await import('./helpers.js');
type Env = Awaited<ReturnType<typeof createTestEnv>>;
type Login = Awaited<ReturnType<typeof login>>;

/** The API key (JWT issuer) a LiveKit token was signed with. */
const issuer = (jwt: string) => (JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString()) as { iss: string }).iss;

describe('0.7.1 voice through the channel node', () => {
  let env: Env;
  let root: Login;
  let bob: Login;
  let nodeId: string;
  let channelId: string;

  const addNode = async (url: string, apiKey: string, guildIds: string[]) => {
    const res = await env.app.inject({
      method: 'POST',
      url: '/api/v1/admin/voice-nodes',
      headers: bearer(root.accessToken),
      payload: { name: url, url, apiKey, apiSecret: `${apiKey}-secret-0123456789abcdefghijklmnop` },
    });
    const id = res.json().node.id as string;
    if (guildIds.length) await env.app.inject({ method: 'PATCH', url: `/api/v1/admin/voice-nodes/${id}`, headers: bearer(root.accessToken), payload: { guildIds } });
    return id;
  };
  const token = async (who: Login) => (await env.app.inject({ method: 'POST', url: '/api/v1/voice/token', headers: bearer(who.accessToken), payload: { channelId } })).json();

  beforeAll(async () => {
    env = await createTestEnv();
    await createUser(env, 'Root', 'ADMIN');
    await createUser(env, 'Bob');
    root = await login(env, 'Root');
    bob = await login(env, 'Bob');
    channelId = await getVoiceChannelId(env);
    nodeId = await addNode('wss://rtc2.aidis.test', 'node-key', [env.guildId]);
  });
  afterAll(async () => {
    await env.close();
  });

  it('a channel without a node uses the main LiveKit', async () => {
    const t = await token(bob);
    expect(t.url).toBe('wss://rtc.aidis.test');
    expect(issuer(t.token)).toBe('test-key');
  });

  it('a channel on a node gets the node address and a token signed with the node key', async () => {
    const res = await env.app.inject({ method: 'PATCH', url: `/api/v1/channels/${channelId}`, headers: bearer(root.accessToken), payload: { voiceNodeId: nodeId } });
    expect(res.statusCode).toBe(200);
    expect(res.json().channel.voiceNodeId).toBe(nodeId);
    const t = await token(bob);
    expect(t.url).toBe('wss://rtc2.aidis.test');
    expect(issuer(t.token)).toBe('node-key');
  });

  it('only a node given to the server can be picked', async () => {
    const other = await addNode('wss://rtc9.aidis.test', 'other-key', []);
    const res = await env.app.inject({ method: 'PATCH', url: `/api/v1/channels/${channelId}`, headers: bearer(root.accessToken), payload: { voiceNodeId: other } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_VOICE_NODE');
  });

  it('a node the server no longer has (stale row) falls back to the main LiveKit, no error', async () => {
    const other = await env.prisma.voiceNode.findFirstOrThrow({ where: { url: 'wss://rtc9.aidis.test' } });
    await env.prisma.channel.update({ where: { id: channelId }, data: { voiceNodeId: other.id } });
    const t = await token(bob);
    expect(t.url).toBe('wss://rtc.aidis.test');
    expect(issuer(t.token)).toBe('test-key');
    await env.prisma.channel.update({ where: { id: channelId }, data: { voiceNodeId: nodeId } });
  });

  it('people in a channel whose node is deleted are sent back to the main LiveKit (rejoin)', async () => {
    const bobId = (await env.prisma.user.findFirstOrThrow({ where: { usernameNormalized: 'bob' } })).id;
    lk.rooms['https://rtc2.aidis.test'] = { [`voice-${channelId}`]: [bobId] };
    env.ctx.services.voice.touchSession(channelId, 0);
    await vi.waitFor(() => {
      expect(env.ctx.services.voice.channelOf(bobId)).toBe(channelId);
    });

    const url = await listen(env);
    const socket = connectSocket(url, bob.accessToken);
    await waitForEvent(socket, 'ready');
    const move = waitForEvent<{ channelId: string; rejoin: boolean }>(socket, 'voice.move');
    const del = await env.app.inject({ method: 'DELETE', url: `/api/v1/admin/voice-nodes/${nodeId}`, headers: bearer(root.accessToken) });
    expect(del.statusCode).toBe(204);
    expect(await move).toEqual({ channelId, rejoin: true });
    expect((await env.prisma.channel.findUniqueOrThrow({ where: { id: channelId } })).voiceNodeId).toBeNull();
    expect((await token(bob)).url).toBe('wss://rtc.aidis.test');
    socket.disconnect();
  });
});
