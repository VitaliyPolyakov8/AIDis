import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestEnv, createUser, loginAll, type LoginResult, type TestEnv } from './helpers.js';

describe('server moderation: kick, ban, nicknames', () => {
  let env: TestEnv;
  let owner: LoginResult, mod: LoginResult, high: LoginResult, member: LoginResult, superadmin: LoginResult;
  let guildId: string;

  const api = (user: LoginResult, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    env.app.inject({ method, url: `/api/v1${url}`, headers: bearer(user.accessToken), ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
  const code = (res: { json: () => unknown }) => (res.json() as { error: { code: string } }).error.code;

  beforeAll(async () => {
    env = await createTestEnv();
    for (const name of ['mOwner', 'mMod', 'mHigh', 'mMember']) await createUser(env, name, 'USER', { join: false });
    await createUser(env, 'mSuper', 'ADMIN', { join: false });
    [owner, mod, high, member, superadmin] = await loginAll(env, ['mOwner', 'mMod', 'mHigh', 'mMember', 'mSuper']);
    guildId = (await api(owner, 'POST', '/guilds', { name: 'Mod' })).json<{ guild: { id: string } }>().guild.id;
    for (const u of [mod, high, member]) await env.ctx.services.guilds.join(u.user.id, guildId);
    const modRole = (await api(owner, 'POST', `/guilds/${guildId}/roles`, { name: 'Mod', permissions: ['KICK_MEMBERS', 'BAN_MEMBERS', 'MANAGE_NICKNAMES'] })).json<{ role: { id: string } }>().role.id;
    const highRole = (await api(owner, 'POST', `/guilds/${guildId}/roles`, { name: 'High' })).json<{ role: { id: string } }>().role.id; // position 1, Mod -> 2
    // High must be above Mod: owner reorders [Mod, High] (bottom -> top)
    await api(owner, 'PUT', `/guilds/${guildId}/roles/order`, { ids: [modRole, highRole] });
    await api(owner, 'PUT', `/guilds/${guildId}/members/${mod.user.id}/roles`, { roleIds: [modRole] });
    await api(owner, 'PUT', `/guilds/${guildId}/members/${high.user.id}/roles`, { roleIds: [highRole] });
  });
  afterAll(async () => {
    await env.close();
  });

  it('does not let a moderator kick someone ranked higher', async () => {
    expect((await api(mod, 'DELETE', `/guilds/${guildId}/members/${high.user.id}`)).statusCode).toBe(403);
  });

  it('kicks a member ranked lower', async () => {
    expect((await api(mod, 'DELETE', `/guilds/${guildId}/members/${member.user.id}`)).statusCode).toBe(204);
    expect(await env.ctx.services.permissions.isMember(member.user.id, guildId)).toBe(false);
    expect((await api(member, 'GET', `/guilds/${guildId}`)).statusCode).toBe(404);
  });

  it('bans, blocks re-joining and unbans', async () => {
    await env.ctx.services.guilds.join(member.user.id, guildId);
    const ban = await api(mod, 'PUT', `/guilds/${guildId}/bans/${member.user.id}`, { reason: 'spam' });
    expect(ban.statusCode, ban.body).toBe(204);
    await expect(env.ctx.services.guilds.join(member.user.id, guildId)).rejects.toMatchObject({ statusCode: 403, code: 'BANNED' });
    const bans = await api(mod, 'GET', `/guilds/${guildId}/bans`);
    expect(bans.json<{ bans: { userId: string; reason: string | null }[] }>().bans).toEqual([expect.objectContaining({ userId: member.user.id, reason: 'spam' })]);
    expect((await api(member, 'GET', `/guilds/${guildId}/bans`)).statusCode).toBe(404);
    expect((await api(mod, 'DELETE', `/guilds/${guildId}/bans/${member.user.id}`)).statusCode).toBe(204);
    expect(await env.ctx.services.guilds.join(member.user.id, guildId)).toBe(true);
  });

  it('never kicks or bans the owner, not even as superadmin', async () => {
    const kick = await api(superadmin, 'DELETE', `/guilds/${guildId}/members/${owner.user.id}`);
    expect(kick.statusCode).toBe(409);
    expect(code(kick)).toBe('OWNER');
    expect((await api(superadmin, 'PUT', `/guilds/${guildId}/bans/${owner.user.id}`, {})).statusCode).toBe(409);
  });

  it('handles nicknames by permission and hierarchy', async () => {
    const own = await api(member, 'PATCH', `/guilds/${guildId}/members/${member.user.id}`, { nickname: 'Кот' });
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json<{ member: { nickname: string } }>().member.nickname).toBe('Кот');
    expect((await api(member, 'PATCH', `/guilds/${guildId}/members/${member.user.id}`, { nickname: 'x'.repeat(33) })).statusCode).toBe(400);
    expect((await api(mod, 'PATCH', `/guilds/${guildId}/members/${high.user.id}`, { nickname: 'boss' })).statusCode).toBe(403);
    expect((await api(mod, 'PATCH', `/guilds/${guildId}/members/${member.user.id}`, { nickname: null })).json<{ member: { nickname: string | null } }>().member.nickname).toBeNull();
    // without CHANGE_NICKNAME a member cannot rename themselves
    const everyone = await env.prisma.roleDef.findFirstOrThrow({ where: { guildId, key: 'everyone' } });
    await api(owner, 'PATCH', `/guilds/${guildId}/roles/${everyone.id}`, { permissions: everyone.permissions.filter((p) => p !== 'CHANGE_NICKNAME') });
    expect((await api(member, 'PATCH', `/guilds/${guildId}/members/${member.user.id}`, { nickname: 'again' })).statusCode).toBe(403);
  });
});
