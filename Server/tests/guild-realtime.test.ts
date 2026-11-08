import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io-client';
import { bearer, connectSocket, createTestEnv, createUser, listen, loginAll, waitForEvent, type LoginResult, type TestEnv } from './helpers.js';

/** Collects every event of one name until stopped. */
function collect<T>(socket: Socket, event: string): T[] {
  const seen: T[] = [];
  socket.on(event, (payload: T) => seen.push(payload));
  return seen;
}
const settle = () => new Promise((r) => setTimeout(r, 300));

describe('realtime per server', () => {
  let env: TestEnv;
  let base: string;
  let alice: LoginResult, bob: LoginResult, carol: LoginResult, dave: LoginResult;
  let guildA: string, guildB: string, channelA: string, channelB: string;

  const api = (user: LoginResult, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    env.app.inject({ method, url: `/api/v1${url}`, headers: bearer(user.accessToken), ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });

  beforeAll(async () => {
    env = await createTestEnv();
    for (const n of ['rtAlice', 'rtBob', 'rtCarol', 'rtDave']) await createUser(env, n, 'USER', { join: false });
    [alice, bob, carol, dave] = await loginAll(env, ['rtAlice', 'rtBob', 'rtCarol', 'rtDave']);
    // A: alice + bob; B: alice + carol; dave is alone
    guildA = (await api(alice, 'POST', '/guilds', { name: 'A' })).json<{ guild: { id: string; systemChannelId: string } }>().guild.id;
    guildB = (await api(alice, 'POST', '/guilds', { name: 'B' })).json<{ guild: { id: string } }>().guild.id;
    await env.ctx.services.guilds.join(bob.user.id, guildA);
    await env.ctx.services.guilds.join(carol.user.id, guildB);
    channelA = (await env.prisma.channel.findFirstOrThrow({ where: { guildId: guildA, type: 'TEXT' } })).id;
    channelB = (await env.prisma.channel.findFirstOrThrow({ where: { guildId: guildB, type: 'TEXT' } })).id;
    base = await listen(env);
  });
  afterAll(async () => {
    await env.close();
  });

  it('delivers a message only to members of its server', async () => {
    const [bobS, carolS] = [connectSocket(base, bob.accessToken), connectSocket(base, carol.accessToken)];
    await Promise.all([waitForEvent(bobS, 'ready'), waitForEvent(carolS, 'ready')]);
    const carolGot = collect(carolS, 'message.created');
    try {
      const got = waitForEvent<{ channelId: string }>(bobS, 'message.created');
      expect((await api(alice, 'POST', `/channels/${channelA}/messages`, { content: 'only A' })).statusCode).toBe(201);
      expect((await got).channelId).toBe(channelA);
      await settle();
      expect(carolGot).toHaveLength(0);
    } finally {
      bobS.disconnect();
      carolS.disconnect();
    }
  });

  it('sends presence only to people who share a server or are friends', async () => {
    const [carolS, daveS] = [connectSocket(base, carol.accessToken), connectSocket(base, dave.accessToken)];
    await Promise.all([waitForEvent(carolS, 'ready'), waitForEvent(daveS, 'ready')]);
    const carolSaw = collect<{ userId: string }>(carolS, 'presence.updated');
    const daveSaw = collect<{ userId: string }>(daveS, 'presence.updated');
    const bobS = connectSocket(base, bob.accessToken);
    try {
      await waitForEvent(bobS, 'ready');
      await settle();
      // bob shares nothing with carol or dave
      expect(carolSaw.filter((p) => p.userId === bob.user.id)).toHaveLength(0);
      expect(daveSaw.filter((p) => p.userId === bob.user.id)).toHaveLength(0);
      // the ready snapshot does not contain strangers either
    } finally {
      bobS.disconnect();
      carolS.disconnect();
      daveS.disconnect();
    }
    const daveSocket = connectSocket(base, dave.accessToken);
    try {
      const ready = await waitForEvent<{ presence: { userId: string }[] }>(daveSocket, 'ready');
      expect(ready.presence.map((p) => p.userId)).not.toContain(alice.user.id);
    } finally {
      daveSocket.disconnect();
    }
  });

  it('stops events for a kicked member at once and tells them', async () => {
    const bobS = connectSocket(base, bob.accessToken);
    await waitForEvent(bobS, 'ready');
    const bobMessages = collect<{ channelId: string }>(bobS, 'message.created');
    try {
      const removed = waitForEvent<{ guildId: string; userId: string; reason: string }>(bobS, 'guild.member.removed');
      expect((await api(alice, 'DELETE', `/guilds/${guildA}/members/${bob.user.id}`)).statusCode).toBe(204);
      expect(await removed).toMatchObject({ guildId: guildA, userId: bob.user.id, reason: 'kicked' });
      await api(alice, 'POST', `/channels/${channelA}/messages`, { content: 'after kick' });
      await settle();
      expect(bobMessages).toHaveLength(0);
    } finally {
      bobS.disconnect();
    }
  });

  it('makes a new member receive events right after joining, without reconnecting', async () => {
    const daveS = connectSocket(base, dave.accessToken);
    await waitForEvent(daveS, 'ready');
    try {
      const joined = waitForEvent<{ id: string }>(daveS, 'guild.joined');
      const invite = (await api(alice, 'POST', `/guilds/${guildB}/invites`, {})).json<{ invite: { code: string } }>().invite;
      expect((await api(dave, 'POST', `/invites/${invite.code}/accept`)).statusCode).toBe(200);
      expect((await joined).id).toBe(guildB);
      const got = waitForEvent<{ channelId: string }>(daveS, 'message.created');
      await api(carol, 'POST', `/channels/${channelB}/messages`, { content: 'welcome' });
      expect((await got).channelId).toBe(channelB);
    } finally {
      daveS.disconnect();
    }
  });
});
