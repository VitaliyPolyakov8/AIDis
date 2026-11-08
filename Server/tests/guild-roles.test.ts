import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestEnv, createUser, loginAll, type LoginResult, type TestEnv } from './helpers.js';

interface RoleView {
  id: string;
  name: string;
  position: number;
  permissions: string[];
  isEveryone: boolean;
  memberCount: number;
}

describe('server roles and hierarchy', () => {
  let env: TestEnv;
  let owner: LoginResult, mod: LoginResult, member: LoginResult, outsider: LoginResult;
  let guildId: string;
  let modRoleId: string, highRoleId: string;

  const api = (user: LoginResult, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    env.app.inject({ method, url: `/api/v1${url}`, headers: bearer(user.accessToken), ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
  const roles = async () => (await api(owner, 'GET', `/guilds/${guildId}/roles`)).json<{ roles: RoleView[] }>().roles;

  beforeAll(async () => {
    env = await createTestEnv();
    for (const name of ['rOwner', 'rMod', 'rMember', 'rOutsider']) await createUser(env, name, 'USER', { join: false });
    [owner, mod, member, outsider] = await loginAll(env, ['rOwner', 'rMod', 'rMember', 'rOutsider']);
    guildId = (await api(owner, 'POST', '/guilds', { name: 'Roles' })).json<{ guild: { id: string } }>().guild.id;
    await env.ctx.services.guilds.join(mod.user.id, guildId);
    await env.ctx.services.guilds.join(member.user.id, guildId);
    // owner builds: High (top) and Mod (MANAGE_ROLES + KICK_MEMBERS) below it
    highRoleId = (await api(owner, 'POST', `/guilds/${guildId}/roles`, { name: 'High', permissions: ['MANAGE_MESSAGES'] })).json<{ role: RoleView }>().role.id;
    modRoleId = (await api(owner, 'POST', `/guilds/${guildId}/roles`, { name: 'Mod', permissions: ['MANAGE_ROLES', 'KICK_MEMBERS', 'MANAGE_NICKNAMES'] })).json<{ role: RoleView }>().role.id;
    expect((await api(owner, 'PUT', `/guilds/${guildId}/members/${mod.user.id}/roles`, { roleIds: [modRoleId] })).statusCode).toBe(200);
  });
  afterAll(async () => {
    await env.close();
  });

  it('places new roles just above @everyone', async () => {
    const list = await roles();
    expect(list.map((r) => [r.name, r.position])).toEqual([
      ['@everyone', 0],
      ['Mod', 1],
      ['High', 2],
    ]);
    expect(list.find((r) => r.name === 'Mod')?.memberCount).toBe(1);
  });

  it('hides roles from non-members', async () => {
    expect((await api(outsider, 'GET', `/guilds/${guildId}/roles`)).statusCode).toBe(404);
  });

  it('lets a moderator create a role below their own', async () => {
    const res = await api(mod, 'POST', `/guilds/${guildId}/roles`, { name: 'Helpers', permissions: ['KICK_MEMBERS'] });
    expect(res.statusCode, res.body).toBe(201);
    const list = await roles();
    expect(list.find((r) => r.name === 'Helpers')?.position).toBe(1);
    expect(list.find((r) => r.name === 'Mod')?.position).toBe(2);
  });

  it('does not let a moderator grant a permission they do not have', async () => {
    const res = await api(mod, 'POST', `/guilds/${guildId}/roles`, { name: 'Bad', permissions: ['BAN_MEMBERS'] });
    expect(res.statusCode).toBe(403);
  });

  it('does not let a moderator edit, delete or assign a role above them', async () => {
    expect((await api(mod, 'PATCH', `/guilds/${guildId}/roles/${highRoleId}`, { name: 'Mine' })).statusCode).toBe(403);
    expect((await api(mod, 'DELETE', `/guilds/${guildId}/roles/${highRoleId}`)).statusCode).toBe(403);
    expect((await api(mod, 'PUT', `/guilds/${guildId}/members/${member.user.id}/roles`, { roleIds: [highRoleId] })).statusCode).toBe(403);
    // their own role is not below them either
    expect((await api(mod, 'PATCH', `/guilds/${guildId}/roles/${modRoleId}`, { permissions: ['MANAGE_ROLES', 'KICK_MEMBERS'] })).statusCode).toBe(403);
  });

  it('lets a moderator assign a role below them', async () => {
    const helpers = (await roles()).find((r) => r.name === 'Helpers');
    const res = await api(mod, 'PUT', `/guilds/${guildId}/members/${member.user.id}/roles`, { roleIds: [helpers?.id] });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ roleIds: string[] }>().roleIds).toEqual([helpers?.id]);
  });

  it('rejects roles of another server and @everyone in assignments', async () => {
    const everyone = (await roles()).find((r) => r.isEveryone);
    expect((await api(owner, 'PUT', `/guilds/${guildId}/members/${member.user.id}/roles`, { roleIds: [everyone?.id] })).statusCode).toBe(400);
    const otherRole = await env.prisma.roleDef.findFirstOrThrow({ where: { guildId: env.guildId } });
    expect((await api(owner, 'PUT', `/guilds/${guildId}/members/${member.user.id}/roles`, { roleIds: [otherRole.id] })).statusCode).toBe(400);
  });

  it('cannot delete @everyone', async () => {
    const everyone = (await roles()).find((r) => r.isEveryone);
    const res = await api(owner, 'DELETE', `/guilds/${guildId}/roles/${everyone?.id}`);
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('ROLE_BUILT_IN');
  });

  it('reorders only roles below the actor', async () => {
    const before = await roles();
    const helpers = before.find((r) => r.name === 'Helpers');
    const high = before.find((r) => r.name === 'High');
    // mod tries to put Helpers above High: High is not movable for mod, so nothing above mod changes
    expect((await api(mod, 'PUT', `/guilds/${guildId}/roles/order`, { ids: [high?.id, helpers?.id] })).statusCode).toBe(204);
    const after = await roles();
    expect(after.find((r) => r.name === 'High')?.position).toBe(high?.position);
    expect(after.find((r) => r.name === 'Helpers')?.position).toBe(helpers?.position);
    // owner swaps High and Mod
    const mod2 = after.find((r) => r.name === 'Mod');
    expect((await api(owner, 'PUT', `/guilds/${guildId}/roles/order`, { ids: [helpers?.id, high?.id, mod2?.id] })).statusCode).toBe(204);
    expect((await roles()).map((r) => r.name)).toEqual(['@everyone', 'Helpers', 'High', 'Mod']);
  });

  it('reports effective permissions, also per channel', async () => {
    const res = await api(member, 'GET', `/guilds/${guildId}/permissions`);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ permissions: string[] }>().permissions).toEqual(expect.arrayContaining(['VIEW_CHANNEL', 'KICK_MEMBERS']));
    const channel = await env.prisma.channel.findFirstOrThrow({ where: { guildId, type: 'TEXT' } });
    const inChannel = await api(member, 'GET', `/guilds/${guildId}/permissions?channelId=${channel.id}`);
    expect(inChannel.json<{ permissions: string[] }>().permissions).toContain('SEND_MESSAGES');
    expect((await api(outsider, 'GET', `/guilds/${guildId}/permissions`)).statusCode).toBe(404);
  });
});
