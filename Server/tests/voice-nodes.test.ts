/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- inject().json() bodies are untyped; the assertions check their shape. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/** LiveKit API: a node answers by its API key ('good' -> ok, 'bad' -> 401, anything else -> unreachable). */
vi.mock('livekit-server-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('livekit-server-sdk')>();
  class FakeRoomServiceClient {
    constructor(
      readonly url: string,
      readonly key: string,
    ) {}
    listRooms() {
      if (this.key === 'good') return Promise.resolve([]);
      if (this.key === 'bad') return Promise.reject(Object.assign(new Error('unauthorized'), { status: 401 }));
      return Promise.reject(new Error('connect ECONNREFUSED'));
    }
    listParticipants() {
      return Promise.resolve([]);
    }
  }
  return { ...actual, RoomServiceClient: FakeRoomServiceClient };
});

const { bearer, createTestEnv, createUser, login } = await import('./helpers.js');
type Env = Awaited<ReturnType<typeof createTestEnv>>;
type Login = Awaited<ReturnType<typeof login>>;

const node = (over: Record<string, string> = {}) => ({ name: 'Germany', url: 'wss://rtc2.aidis.test', apiKey: 'good', apiSecret: 'a-very-long-node-secret-0123456789abcdefghij', ...over });

describe('0.7.1 voice nodes (superadmin)', () => {
  let env: Env;
  let root: Login;
  let bob: Login;

  beforeAll(async () => {
    env = await createTestEnv();
    await createUser(env, 'Root', 'ADMIN');
    await createUser(env, 'Bob');
    root = await login(env, 'Root');
    bob = await login(env, 'Bob');
  });
  afterAll(async () => {
    await env.close();
  });

  const post = (token: string, body: Record<string, unknown>) => env.app.inject({ method: 'POST', url: '/api/v1/admin/voice-nodes', headers: bearer(token), payload: body });

  it('is for the superadmin only', async () => {
    expect((await post(bob.accessToken, node())).statusCode).toBe(403);
    expect((await env.app.inject({ method: 'GET', url: '/api/v1/admin/voice-nodes', headers: bearer(bob.accessToken) })).statusCode).toBe(403);
  });

  it('accepts only wss:// subdomains of the voice node domain', async () => {
    for (const url of ['https://rtc2.aidis.test', 'wss://rtc2.example.com', 'wss://1.2.3.4', 'wss://aidis.test', 'wss://evil.aidis.test.example.com']) {
      const res = await post(root.accessToken, node({ url }));
      expect(res.statusCode, url).toBe(400);
      expect(res.json().error.code, url).toBe('INVALID_NODE_URL');
    }
  });

  it('stores the secret sealed, never returns it, checks the node and offers it to no server yet', async () => {
    const res = await post(root.accessToken, node());
    expect(res.statusCode).toBe(201);
    const created = res.json().node;
    expect(JSON.stringify(res.json())).not.toContain('a-very-long-node-secret');
    expect(created).toMatchObject({ name: 'Germany', url: 'wss://rtc2.aidis.test', enabled: true, guildIds: [], lastCheckStatus: 'ok' });
    const row = await env.prisma.voiceNode.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.apiSecretSealed).not.toContain('a-very-long-node-secret');

    const list = await env.app.inject({ method: 'GET', url: '/api/v1/admin/voice-nodes', headers: bearer(root.accessToken) });
    expect(list.json().main.url).toBe('wss://rtc.aidis.test');
    expect(JSON.stringify(list.json())).not.toContain('a-very-long-node-secret');

    const forGuild = () => env.app.inject({ method: 'GET', url: `/api/v1/guilds/${env.guildId}/voice-nodes`, headers: bearer(root.accessToken) });
    expect((await forGuild()).json().nodes).toEqual([]);
    const patched = await env.app.inject({ method: 'PATCH', url: `/api/v1/admin/voice-nodes/${created.id}`, headers: bearer(root.accessToken), payload: { guildIds: [env.guildId] } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().node.guildIds).toEqual([env.guildId]);
    expect((await forGuild()).json().nodes).toEqual([{ id: created.id, name: 'Germany' }]);
    // A disabled node is not offered.
    await env.app.inject({ method: 'PATCH', url: `/api/v1/admin/voice-nodes/${created.id}`, headers: bearer(root.accessToken), payload: { enabled: false } });
    expect((await forGuild()).json().nodes).toEqual([]);
  });

  it('a member without MANAGE_CHANNELS cannot list the server nodes', async () => {
    const res = await env.app.inject({ method: 'GET', url: `/api/v1/guilds/${env.guildId}/voice-nodes`, headers: bearer(bob.accessToken) });
    expect(res.statusCode).toBe(403);
  });

  it('reports a wrong key and an unreachable node', async () => {
    const bad = (await post(root.accessToken, node({ url: 'wss://rtc3.aidis.test', apiKey: 'bad' }))).json().node;
    expect(bad.lastCheckStatus).toBe('unauthorized');
    const down = (await post(root.accessToken, node({ url: 'wss://rtc4.aidis.test', apiKey: 'down' }))).json().node;
    expect(down.lastCheckStatus).toBe('unreachable');
    const again = await env.app.inject({ method: 'POST', url: `/api/v1/admin/voice-nodes/${down.id}/check`, headers: bearer(root.accessToken) });
    expect(again.json().node.lastCheckStatus).toBe('unreachable');
    expect(again.json().node.lastCheckAt).toEqual(expect.any(String));
  });

  it('the same address cannot be added twice; a node can be deleted', async () => {
    const dup = await post(root.accessToken, node());
    expect(dup.statusCode).toBe(409);
    const nodes = (await env.app.inject({ method: 'GET', url: '/api/v1/admin/voice-nodes', headers: bearer(root.accessToken) })).json().nodes as { id: string; url: string }[];
    const target = nodes.find((n) => n.url === 'wss://rtc2.aidis.test');
    const del = await env.app.inject({ method: 'DELETE', url: `/api/v1/admin/voice-nodes/${target?.id}`, headers: bearer(root.accessToken) });
    expect(del.statusCode).toBe(204);
    expect(await env.prisma.voiceNode.findUnique({ where: { id: target?.id ?? '' } })).toBeNull();
  });
});
