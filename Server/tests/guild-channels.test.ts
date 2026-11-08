import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestEnv, createUser, loginAll, type LoginResult, type TestEnv } from './helpers.js';

interface ChannelView {
  id: string;
  guildId: string;
  type: string;
  name: string;
  parentId: string | null;
  permissionsSynced: boolean;
  overwrites?: { targetType: string; targetId: string; allow: string[]; deny: string[] }[];
}

describe('server channels, categories and permission overwrites', () => {
  let env: TestEnv;
  let owner: LoginResult, mod: LoginResult, member: LoginResult;
  let guildId: string, everyoneId: string, modRoleId: string;
  let category: ChannelView, child: ChannelView;

  const api = (user: LoginResult, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    env.app.inject({ method, url: `/api/v1${url}`, headers: bearer(user.accessToken), ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
  const list = async (user: LoginResult) => (await api(user, 'GET', `/guilds/${guildId}/channels`)).json<{ channels: ChannelView[] }>().channels;

  beforeAll(async () => {
    env = await createTestEnv();
    for (const name of ['cOwner', 'cMod', 'cMember']) await createUser(env, name, 'USER', { join: false });
    [owner, mod, member] = await loginAll(env, ['cOwner', 'cMod', 'cMember']);
    guildId = (await api(owner, 'POST', '/guilds', { name: 'Chan' })).json<{ guild: { id: string } }>().guild.id;
    for (const u of [mod, member]) await env.ctx.services.guilds.join(u.user.id, guildId);
    everyoneId = (await env.prisma.roleDef.findFirstOrThrow({ where: { guildId, key: 'everyone' } })).id;
    modRoleId = (await api(owner, 'POST', `/guilds/${guildId}/roles`, { name: 'Mod', permissions: ['MANAGE_CHANNELS', 'MANAGE_ROLES', 'KICK_MEMBERS'] })).json<{ role: { id: string } }>().role.id;
    await api(owner, 'PUT', `/guilds/${guildId}/members/${mod.user.id}/roles`, { roleIds: [modRoleId] });
  });
  afterAll(async () => {
    await env.close();
  });

  it('creates a category and a synced channel inside it', async () => {
    const cat = await api(mod, 'POST', `/guilds/${guildId}/channels`, { type: 'CATEGORY', name: 'Секрет' });
    expect(cat.statusCode, cat.body).toBe(201);
    category = cat.json<{ channel: ChannelView }>().channel;
    const ch = await api(mod, 'POST', `/guilds/${guildId}/channels`, { type: 'TEXT', name: 'тайный чат', parentId: category.id });
    expect(ch.statusCode, ch.body).toBe(201);
    child = ch.json<{ channel: ChannelView }>().channel;
    expect(child).toMatchObject({ guildId, parentId: category.id, permissionsSynced: true, name: 'тайный-чат' });
    expect((await api(member, 'POST', `/guilds/${guildId}/channels`, { type: 'TEXT', name: 'nope' })).statusCode).toBe(403);
  });

  it('rejects a parent from another server or a non-category parent', async () => {
    const otherCat = await env.prisma.channel.findFirstOrThrow({ where: { guildId: env.guildId, type: 'CATEGORY' } });
    expect((await api(owner, 'POST', `/guilds/${guildId}/channels`, { type: 'TEXT', name: 'x', parentId: otherCat.id })).statusCode).toBe(400);
    expect((await api(owner, 'POST', `/guilds/${guildId}/channels`, { type: 'TEXT', name: 'x', parentId: child.id })).statusCode).toBe(400);
  });

  it('hides a synced child when the category denies VIEW_CHANNEL to @everyone', async () => {
    const res = await api(mod, 'PUT', `/channels/${category.id}/overwrites/ROLE/${everyoneId}`, { allow: [], deny: ['VIEW_CHANNEL'] });
    expect(res.statusCode, res.body).toBe(200);
    const visible = (await list(member)).map((c) => c.id);
    expect(visible).not.toContain(child.id);
    expect(visible).not.toContain(category.id);
    expect((await api(member, 'GET', `/channels/${child.id}`)).statusCode).toBe(404);
    expect((await api(member, 'GET', `/channels/${child.id}/messages`)).statusCode).toBe(404);
    // the owner still sees it, with overwrites
    const forOwner = (await list(owner)).find((c) => c.id === category.id);
    expect(forOwner?.overwrites).toEqual([{ targetType: 'ROLE', targetId: everyoneId, allow: [], deny: ['VIEW_CHANNEL'] }]);
  });

  it('desyncs a child on its own overwrite, copying the category first, and re-syncs on request', async () => {
    const res = await api(owner, 'PUT', `/channels/${child.id}/overwrites/MEMBER/${member.user.id}`, { allow: ['VIEW_CHANNEL'], deny: [] });
    expect(res.statusCode, res.body).toBe(200);
    const after = (await list(owner)).find((c) => c.id === child.id);
    expect(after?.permissionsSynced).toBe(false);
    expect(after?.overwrites).toHaveLength(2);
    expect((await list(member)).map((c) => c.id)).toContain(child.id);
    const synced = await api(owner, 'PATCH', `/channels/${child.id}`, { syncWithParent: true });
    expect(synced.json<{ channel: ChannelView }>().channel.permissionsSynced).toBe(true);
    expect((await list(member)).map((c) => c.id)).not.toContain(child.id);
  });

  it('does not let an overwrite grant what the author lacks, or a server-only permission', async () => {
    const general = (await list(owner)).find((c) => c.type === 'TEXT' && c.name === 'general');
    const notChannel = await api(mod, 'PUT', `/channels/${general?.id}/overwrites/ROLE/${everyoneId}`, { allow: ['BAN_MEMBERS'], deny: [] });
    expect(notChannel.statusCode).toBe(400);
    expect(notChannel.json<{ error: { code: string } }>().error.code).toBe('NOT_CHANNEL_PERMISSION');
    expect((await api(mod, 'PUT', `/channels/${general?.id}/overwrites/ROLE/${everyoneId}`, { allow: ['MANAGE_MESSAGES'], deny: [] })).statusCode).toBe(403);
    // own role is not below the moderator
    expect((await api(mod, 'PUT', `/channels/${general?.id}/overwrites/ROLE/${modRoleId}`, { allow: [], deny: ['SEND_MESSAGES'] })).statusCode).toBe(403);
    expect((await api(mod, 'PUT', `/channels/${general?.id}/overwrites/MEMBER/${mod.user.id}`, { allow: ['SEND_MESSAGES'], deny: [] })).statusCode).toBe(403);
    expect((await api(member, 'PUT', `/channels/${general?.id}/overwrites/ROLE/${everyoneId}`, { allow: [], deny: ['SEND_MESSAGES'] })).statusCode).toBe(403);
  });

  it('removes an overwrite', async () => {
    expect((await api(owner, 'DELETE', `/channels/${category.id}/overwrites/ROLE/${everyoneId}`)).statusCode).toBe(204);
    expect((await list(member)).map((c) => c.id)).toContain(child.id);
  });

  it('keeps a synced channel hidden when it is moved out of its hidden category', async () => {
    const cat = (await api(owner, 'POST', `/guilds/${guildId}/channels`, { type: 'CATEGORY', name: 'Hidden' })).json<{ channel: ChannelView }>().channel;
    await api(owner, 'PUT', `/channels/${cat.id}/overwrites/ROLE/${everyoneId}`, { allow: [], deny: ['VIEW_CHANNEL'] });
    const a = (await api(owner, 'POST', `/guilds/${guildId}/channels`, { type: 'TEXT', name: 'moved-by-patch', parentId: cat.id })).json<{ channel: ChannelView }>().channel;
    const b = (await api(owner, 'POST', `/guilds/${guildId}/channels`, { type: 'TEXT', name: 'moved-by-order', parentId: cat.id })).json<{ channel: ChannelView }>().channel;
    expect((await api(member, 'GET', `/channels/${a.id}`)).statusCode).toBe(404);
    expect((await api(owner, 'PATCH', `/channels/${a.id}`, { parentId: null })).statusCode).toBe(200);
    expect((await api(member, 'GET', `/channels/${a.id}`)).statusCode).toBe(404);
    expect((await api(owner, 'PUT', `/guilds/${guildId}/channels/order`, { items: [{ id: b.id, parentId: null, position: 0 }] })).statusCode).toBe(204);
    expect((await api(member, 'GET', `/channels/${b.id}`)).statusCode).toBe(404);
    const moved = (await list(owner)).filter((c) => c.id === a.id || c.id === b.id);
    expect(moved.every((c) => c.parentId === null && !c.permissionsSynced)).toBe(true);
  });

  it('clears references when a channel is deleted', async () => {
    const extra = (await api(owner, 'POST', `/guilds/${guildId}/channels`, { type: 'TEXT', name: 'news' })).json<{ channel: ChannelView }>().channel;
    await api(owner, 'PATCH', `/guilds/${guildId}`, { systemChannelId: extra.id });
    expect((await api(owner, 'DELETE', `/channels/${extra.id}`)).statusCode).toBe(204);
    expect((await env.prisma.guild.findUniqueOrThrow({ where: { id: guildId } })).systemChannelId).toBeNull();
  });

  it('deleting a category keeps its channels at the top level', async () => {
    expect((await api(owner, 'DELETE', `/channels/${category.id}`)).statusCode).toBe(204);
    const moved = (await list(owner)).find((c) => c.id === child.id);
    expect(moved?.parentId).toBeNull();
  });

  it('limits voice bitrate and reorders with parents', async () => {
    const voice = (await list(owner)).find((c) => c.type === 'VOICE');
    expect((await api(owner, 'PATCH', `/channels/${voice?.id}`, { voiceBitrate: 512 })).statusCode).toBe(400);
    const cat = (await list(owner)).find((c) => c.type === 'CATEGORY');
    const res = await api(owner, 'PUT', `/guilds/${guildId}/channels/order`, { items: [{ id: child.id, parentId: cat?.id, position: 0 }] });
    expect(res.statusCode, res.body).toBe(204);
    expect((await list(owner)).find((c) => c.id === child.id)?.parentId).toBe(cat?.id);
  });

  it('keeps the last text channel', async () => {
    const texts = (await list(owner)).filter((c) => c.type === 'TEXT');
    for (const c of texts.slice(1)) await api(owner, 'DELETE', `/channels/${c.id}`);
    const last = await api(owner, 'DELETE', `/channels/${texts[0]?.id}`);
    expect(last.statusCode).toBe(409);
  });
});
