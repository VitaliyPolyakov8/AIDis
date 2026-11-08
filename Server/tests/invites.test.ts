import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateInviteCode, INVITE_ALPHABET, normalizeInviteCode } from '../src/invites/code.js';
import { bearer, createTestEnv, createUser, login, loginAll, type LoginResult, type TestEnv } from './helpers.js';

interface InviteView {
  code: string;
  guildId: string;
  channelId: string | null;
  maxUses: number | null;
  uses: number;
  expiresAt: string | null;
}

describe('invite codes', () => {
  it('generates 8 characters from the unambiguous alphabet', () => {
    for (let i = 0; i < 50; i += 1) {
      const code = generateInviteCode();
      expect(code).toHaveLength(8);
      expect(code).toMatch(new RegExp(`^[${INVITE_ALPHABET}]{8}$`));
    }
  });

  it('accepts a code or a link, ignoring case', () => {
    expect(normalizeInviteCode('https://chat.example.com/invite/AbCd2345')).toBe('abcd2345');
    expect(normalizeInviteCode('  ABCD2345 ')).toBe('abcd2345');
    expect(normalizeInviteCode('abc')).toBeNull();
    expect(normalizeInviteCode('abcd234!')).toBeNull();
  });
});

describe('invites', () => {
  let env: TestEnv;
  let owner: LoginResult, member: LoginResult, guest: LoginResult, guest2: LoginResult, banned: LoginResult;
  let guildId: string, channelId: string;

  const api = (user: LoginResult, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    env.app.inject({ method, url: `/api/v1${url}`, headers: bearer(user.accessToken), ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
  const create = async (user: LoginResult, payload: Record<string, unknown> = {}) => api(user, 'POST', `/guilds/${guildId}/invites`, payload);

  beforeAll(async () => {
    env = await createTestEnv();
    for (const name of ['iOwner', 'iMember', 'iGuest', 'iGuest2', 'iBanned']) await createUser(env, name, 'USER', { join: false });
    [owner, member, guest, guest2, banned] = await loginAll(env, ['iOwner', 'iMember', 'iGuest', 'iGuest2', 'iBanned']);
    const guild = (await api(owner, 'POST', '/guilds', { name: 'Invites' })).json<{ guild: { id: string; systemChannelId: string } }>().guild;
    guildId = guild.id;
    channelId = guild.systemChannelId;
    await env.ctx.services.guilds.join(member.user.id, guildId);
  });
  afterAll(async () => {
    await env.close();
  });

  it('creates an invite with the defaults (7 days, unlimited) and shows a preview to outsiders', async () => {
    const res = await create(member, { channelId });
    expect(res.statusCode, res.body).toBe(201);
    const invite = res.json<{ invite: InviteView }>().invite;
    expect(invite.maxUses).toBeNull();
    expect(Date.parse(invite.expiresAt ?? '') - Date.now()).toBeGreaterThan(6.9 * 86400_000);
    const preview = await api(guest, 'GET', `/invites/${invite.code.toUpperCase()}`);
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json<{ invite: { guild: { name: string }; memberCount: number; alreadyMember: boolean } }>().invite).toMatchObject({ guild: { name: 'Invites' }, memberCount: 2, alreadyMember: false });
  });

  it('accepts an invite, returns the channel and does not count a second accept', async () => {
    const invite = (await create(owner, { channelId })).json<{ invite: InviteView }>().invite;
    const accepted = await api(guest, 'POST', `/invites/${invite.code}/accept`);
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json<{ guild: { id: string }; channelId: string }>()).toMatchObject({ guild: { id: guildId }, channelId });
    expect(await env.ctx.services.permissions.isMember(guest.user.id, guildId)).toBe(true);
    expect((await api(guest, 'POST', `/invites/${invite.code}/accept`)).statusCode).toBe(200);
    expect((await env.prisma.invite.findUniqueOrThrow({ where: { code: invite.code } })).uses).toBe(1);
  });

  it('rejects expired and revoked invites as invalid', async () => {
    const expired = (await create(owner)).json<{ invite: InviteView }>().invite;
    await env.prisma.invite.update({ where: { code: expired.code }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await api(guest2, 'GET', `/invites/${expired.code}`);
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('INVITE_INVALID');
    const revoked = (await create(owner)).json<{ invite: InviteView }>().invite;
    expect((await api(owner, 'DELETE', `/invites/${revoked.code}`)).statusCode).toBe(204);
    expect((await api(guest2, 'POST', `/invites/${revoked.code}/accept`)).statusCode).toBe(404);
  });

  it('keeps banned users out', async () => {
    await env.prisma.guildBan.create({ data: { guildId, userId: banned.user.id, bannedById: owner.user.id } });
    const invite = (await create(owner)).json<{ invite: InviteView }>().invite;
    const res = await api(banned, 'POST', `/invites/${invite.code}/accept`);
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('BANNED');
  });

  it('lets exactly one of two parallel accepts through a single-use invite', async () => {
    const invite = (await create(owner, { maxUses: 1 })).json<{ invite: InviteView }>().invite;
    const extra = await createUser(env, 'iRacer', 'USER', { join: false });
    const racer = await login(env, 'iRacer');
    const results = await Promise.all([api(guest2, 'POST', `/invites/${invite.code}/accept`), api(racer, 'POST', `/invites/${invite.code}/accept`)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 404]);
    const members = [await env.ctx.services.permissions.isMember(guest2.user.id, guildId), await env.ctx.services.permissions.isMember(extra.id, guildId)];
    expect(members.filter(Boolean)).toHaveLength(1);
  });

  it('needs CREATE_INVITE and hides the list from outsiders', async () => {
    const everyone = await env.prisma.roleDef.findFirstOrThrow({ where: { guildId, key: 'everyone' } });
    await api(owner, 'PATCH', `/guilds/${guildId}/roles/${everyone.id}`, { permissions: everyone.permissions.filter((p) => p !== 'CREATE_INVITE') });
    expect((await create(member)).statusCode).toBe(403);
    await createUser(env, 'iNobody', 'USER', { join: false });
    expect((await api(await login(env, 'iNobody'), 'GET', `/guilds/${guildId}/invites`)).statusCode).toBe(404);
    // a member sees their own invites only, the owner sees all
    const mine = await api(member, 'GET', `/guilds/${guildId}/invites`);
    const all = await api(owner, 'GET', `/guilds/${guildId}/invites`);
    expect(mine.json<{ invites: InviteView[] }>().invites.length).toBeLessThan(all.json<{ invites: InviteView[] }>().invites.length);
  });

  it('stops at the server member limit', async () => {
    await env.ctx.services.limits.setOverride('guild.members', 'GUILD', guildId, await env.prisma.guildMember.count({ where: { guildId } }));
    const invite = (await create(owner)).json<{ invite: InviteView }>().invite;
    await createUser(env, 'iLate', 'USER', { join: false });
    const res = await api(await login(env, 'iLate'), 'POST', `/invites/${invite.code}/accept`);
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string; details: { key: string } } }>().error).toMatchObject({ code: 'LIMIT_REACHED', details: { key: 'guild.members' } });
    // nothing was used up
    expect((await env.prisma.invite.findUniqueOrThrow({ where: { code: invite.code } })).uses).toBe(0);
  });
});
