import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bearer, createTestEnv, createUser, loginAll, type LoginResult, type TestEnv } from './helpers.js';

describe('realtime events do not flush every permission cache', () => {
  let env: TestEnv;
  let alice: LoginResult, bob: LoginResult;

  beforeAll(async () => {
    env = await createTestEnv();
    await createUser(env, 'ciAlice');
    await createUser(env, 'ciBob');
    [alice, bob] = await loginAll(env, ['ciAlice', 'ciBob']);
  });
  afterAll(async () => {
    await env.close();
  });

  it('a friend request leaves the server caches alone', async () => {
    const all = vi.spyOn(env.ctx.services.permissions, 'invalidateAll');
    const guild = vi.spyOn(env.ctx.services.permissions, 'invalidateGuild');
    const res = await env.app.inject({ method: 'POST', url: '/api/v1/friends/requests', headers: bearer(alice.accessToken), payload: { username: 'ciBob' } });
    expect(res.statusCode, res.body).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(all).not.toHaveBeenCalled();
    expect(guild).not.toHaveBeenCalled();
    expect(bob.user.id).toBeTruthy();
  });

  it('a role change on one server flushes only that server', async () => {
    const owner = (await loginAll(env, ['test-owner']))[0];
    const all = vi.spyOn(env.ctx.services.permissions, 'invalidateAll');
    const res = await env.app.inject({ method: 'POST', url: `/api/v1/guilds/${env.guildId}/roles`, headers: bearer(owner.accessToken), payload: { name: 'Fresh' } });
    expect(res.statusCode, res.body).toBe(201);
    await new Promise((r) => setTimeout(r, 50));
    expect(all).not.toHaveBeenCalled();
  });
});
