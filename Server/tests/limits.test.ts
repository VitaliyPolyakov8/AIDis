import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestEnv, createUser, getTextChannelId, login, type LoginResult, type TestEnv } from './helpers.js';

describe('limits set by the superadmin', () => {
  let env: TestEnv;
  let superadmin: LoginResult, alice: LoginResult;

  const api = (user: LoginResult, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    env.app.inject({ method, url: `/api/v1${url}`, headers: bearer(user.accessToken), ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
  const errorOf = (res: { json: () => unknown }) => (res.json() as { error: { code: string; details?: { key: string; limit: number } } }).error;

  beforeAll(async () => {
    env = await createTestEnv();
    await createUser(env, 'lSuper', 'ADMIN', { join: false });
    await createUser(env, 'lAlice');
    [superadmin, alice] = await Promise.all([login(env, 'lSuper'), login(env, 'lAlice')]);
  });
  afterAll(async () => {
    await env.close();
  });

  it('shows the catalog to the superadmin only', async () => {
    expect((await api(alice, 'GET', '/admin/limits')).statusCode).toBe(403);
    const res = await api(superadmin, 'GET', '/admin/limits');
    expect(res.statusCode).toBe(200);
    const catalog = res.json<{ catalog: { key: string; default: number; max: number }[] }>().catalog;
    expect(catalog.find((l) => l.key === 'guilds.owned')?.default).toBe(10);
    expect(catalog.find((l) => l.key === 'upload.size')?.max).toBe(env.config.maxUploadSize);
  });

  it('stops the 11th own server by default and allows it with a user exception', async () => {
    // (the route allows 10 creations a minute, so the first ten go through the service)
    const aliceUser = await env.users.getById(alice.user.id);
    for (let i = 0; i < 10; i += 1) await env.ctx.services.guilds.create(aliceUser, { name: `S${i}` });
    const eleventh = await api(alice, 'POST', '/guilds', { name: 'S10' });
    expect(eleventh.statusCode).toBe(400);
    expect(errorOf(eleventh)).toMatchObject({ code: 'LIMIT_REACHED', details: { key: 'guilds.owned', limit: 10 } });
    expect((await api(superadmin, 'PUT', '/admin/limits/overrides', { key: 'guilds.owned', scope: 'USER', targetId: alice.user.id, value: 12 })).statusCode).toBe(204);
    expect((await api(alice, 'POST', '/guilds', { name: 'S10' })).statusCode).toBe(201);
    // removing the exception
    expect((await api(superadmin, 'PUT', '/admin/limits/overrides', { key: 'guilds.owned', scope: 'USER', targetId: alice.user.id, value: null })).statusCode).toBe(204);
    expect((await api(alice, 'POST', '/guilds', { name: 'S11' })).statusCode).toBe(400);
  });

  it('applies a server exception over the global value', async () => {
    await api(superadmin, 'PUT', '/admin/limits/overrides', { key: 'guild.roles', scope: 'GUILD', targetId: env.guildId, value: 2 });
    const owner = env.ownerId;
    const ownerLogin = await login(env, 'test-owner');
    expect(owner).toBe(ownerLogin.user.id);
    expect((await api(ownerLogin, 'POST', `/guilds/${env.guildId}/roles`, { name: 'A' })).statusCode).toBe(201);
    expect((await api(ownerLogin, 'POST', `/guilds/${env.guildId}/roles`, { name: 'B' })).statusCode).toBe(201);
    const third = await api(ownerLogin, 'POST', `/guilds/${env.guildId}/roles`, { name: 'C' });
    expect(errorOf(third)).toMatchObject({ code: 'LIMIT_REACHED', details: { key: 'guild.roles' } });
  });

  it('limits message length per server', async () => {
    expect((await api(superadmin, 'PUT', '/admin/limits', { values: { 'message.length': 100 } })).statusCode).toBe(204);
    const channel = await getTextChannelId(env);
    expect((await api(alice, 'POST', `/channels/${channel}/messages`, { content: 'x'.repeat(100) })).statusCode).toBe(201);
    const long = await api(alice, 'POST', `/channels/${channel}/messages`, { content: 'x'.repeat(101) });
    expect(long.statusCode).toBe(400);
    expect(errorOf(long).code).toBe('MESSAGE_TOO_LONG');
    await api(superadmin, 'PUT', '/admin/limits', { values: { 'message.length': null } });
  });

  it('refuses values outside the allowed range and unknown keys', async () => {
    const tooBig = await api(superadmin, 'PUT', '/admin/limits', { values: { 'upload.size': env.config.maxUploadSize + 1 } });
    expect(tooBig.statusCode).toBe(400);
    expect(errorOf(tooBig).code).toBe('LIMIT_OUT_OF_RANGE');
    expect((await api(superadmin, 'PUT', '/admin/limits', { values: { nope: 1 } })).statusCode).toBe(400);
    expect((await api(superadmin, 'PUT', '/admin/limits/overrides', { key: 'guilds.owned', scope: 'GUILD', targetId: env.guildId, value: 1 })).statusCode).toBe(400);
  });

  it('limits a user’s single-request uploads', async () => {
    await api(superadmin, 'PUT', '/admin/limits/overrides', { key: 'upload.size', scope: 'USER', targetId: alice.user.id, value: 1024 });
    const boundary = '----aidis';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      Buffer.alloc(2048, 1),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await env.app.inject({ method: 'POST', url: '/api/v1/attachments', headers: { ...bearer(alice.accessToken), 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body });
    expect(res.statusCode).toBe(413);
  });
});
