import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestEnv, createUser, getTextChannelId, login, type LoginResult, type TestEnv } from './helpers.js';

describe('search, history, mentions and audit stay inside a server', () => {
  let env: TestEnv;
  let owner: LoginResult, alice: LoginResult, bob: LoginResult, outsider: LoginResult;
  let general: string, hidden: string, everyoneId: string, guildB: string, channelB: string;

  const api = (user: LoginResult, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    env.app.inject({ method, url: `/api/v1${url}`, headers: bearer(user.accessToken), ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
  const post = async (user: LoginResult, channelId: string, content: string) => (await api(user, 'POST', `/channels/${channelId}/messages`, { content })).json<{ message: { id: string; mentions: string[] } }>().message;

  beforeAll(async () => {
    env = await createTestEnv();
    await createUser(env, 'sAlice');
    await createUser(env, 'sBob');
    await createUser(env, 'sOutsider', 'USER', { join: false });
    [owner, alice, bob, outsider] = await Promise.all([login(env, 'test-owner'), login(env, 'sAlice'), login(env, 'sBob'), login(env, 'sOutsider')]);
    general = await getTextChannelId(env);
    hidden = await getTextChannelId(env, 'random');
    everyoneId = (await env.prisma.roleDef.findFirstOrThrow({ where: { guildId: env.guildId, key: 'everyone' } })).id;
    await post(owner, hidden, 'needle in the hidden channel');
    await api(owner, 'PUT', `/channels/${hidden}/overwrites/ROLE/${everyoneId}`, { allow: [], deny: ['VIEW_CHANNEL'] });
    guildB = (await api(outsider, 'POST', '/guilds', { name: 'B' })).json<{ guild: { id: string } }>().guild.id;
    channelB = await getTextChannelId(env, 'general', guildB);
    await post(outsider, channelB, 'needle in another server');
    await post(alice, general, 'needle in general');
  });
  afterAll(async () => {
    await env.close();
  });

  it('searches one server or the DMs, never hidden channels or other servers', async () => {
    expect((await api(alice, 'GET', '/search/messages?q=needle')).statusCode).toBe(400);
    const res = await api(alice, 'GET', `/search/messages?q=needle&guildId=${env.guildId}`);
    expect(res.statusCode, res.body).toBe(200);
    const found = res.json<{ messages: { content: string }[] }>().messages.map((m) => m.content);
    expect(found).toEqual(['needle in general']);
    expect((await api(alice, 'GET', `/search/messages?q=needle&guildId=${guildB}`)).statusCode).toBe(404);
    expect((await api(alice, 'GET', '/search/messages?q=needle&dms=1')).json<{ messages: unknown[] }>().messages).toEqual([]);
  });

  it('needs READ_MESSAGE_HISTORY to read but not to send', async () => {
    await api(owner, 'PUT', `/channels/${general}/overwrites/ROLE/${everyoneId}`, { allow: [], deny: ['READ_MESSAGE_HISTORY'] });
    expect((await api(bob, 'GET', `/channels/${general}/messages`)).statusCode).toBe(403);
    expect((await api(bob, 'GET', `/channels/${general}/pins`)).statusCode).toBe(403);
    expect((await api(bob, 'POST', `/channels/${general}/messages`, { content: 'blind post' })).statusCode).toBe(201);
    await api(owner, 'DELETE', `/channels/${general}/overwrites/ROLE/${everyoneId}`);
  });

  it('needs ADD_REACTIONS to react', async () => {
    const message = await post(alice, general, 'react to me');
    await api(owner, 'PUT', `/channels/${general}/overwrites/ROLE/${everyoneId}`, { allow: [], deny: ['ADD_REACTIONS'] });
    expect((await api(bob, 'PUT', `/messages/${message.id}/reactions/${encodeURIComponent('👍')}`)).statusCode).toBe(403);
    await api(owner, 'DELETE', `/channels/${general}/overwrites/ROLE/${everyoneId}`);
    expect((await api(bob, 'PUT', `/messages/${message.id}/reactions/${encodeURIComponent('👍')}`)).statusCode).toBe(200);
  });

  it('mentions only members of the server', async () => {
    const message = await post(alice, general, 'hi @sBob and @sOutsider');
    expect(message.mentions).toEqual([bob.user.id]);
  });

  it('turns @everyone into mentions only with MENTION_EVERYONE', async () => {
    expect((await post(alice, general, 'hey @everyone')).mentions).toEqual([]);
    const withRight = await post(owner, general, 'hey @everyone');
    expect(withRight.mentions).toEqual(expect.arrayContaining([alice.user.id, bob.user.id]));
    expect(withRight.mentions).not.toContain(owner.user.id);
    expect(withRight.mentions).not.toContain(outsider.user.id);
  });

  it('keeps audit logs per server', async () => {
    expect((await api(bob, 'GET', `/guilds/${env.guildId}/audit`)).statusCode).toBe(403);
    const ownerLog = (await api(owner, 'GET', `/guilds/${env.guildId}/audit`)).json<{ entries: { action: string; guildId: string }[] }>().entries;
    expect(ownerLog.length).toBeGreaterThan(0);
    expect(ownerLog.every((e) => e.guildId === env.guildId)).toBe(true);
    expect((await api(owner, 'GET', `/guilds/${guildB}/audit`)).statusCode).toBe(404);
  });
});
