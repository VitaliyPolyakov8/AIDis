import { randomUUID } from 'node:crypto';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, connectSocket, createTestEnv, createUser, listen, login, waitForEvent, type LoginResult, type TestEnv } from './helpers.js';

interface GuildBody {
  guild: { id: string; name: string; ownerId: string; systemChannelId: string | null; memberCount: number; me: { permissions: string[] } };
}

describe('servers (guilds)', () => {
  let env: TestEnv;
  let base: string;
  let owner: LoginResult, member: LoginResult, outsider: LoginResult, superadmin: LoginResult;

  beforeAll(async () => {
    env = await createTestEnv();
    await createUser(env, 'gOwner', 'USER', { join: false });
    await createUser(env, 'gMember', 'USER', { join: false });
    await createUser(env, 'gOutsider', 'USER', { join: false });
    await createUser(env, 'gSuper', 'ADMIN', { join: false });
    [owner, member, outsider, superadmin] = await Promise.all([login(env, 'gOwner'), login(env, 'gMember'), login(env, 'gOutsider'), login(env, 'gSuper')]);
    base = await listen(env);
  });
  afterAll(async () => {
    await env.close();
  });

  const api = (user: LoginResult, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    env.app.inject({ method, url: `/api/v1${url}`, headers: bearer(user.accessToken), ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });

  let guildId: string;

  it('creates a server with two categories, default channels and @everyone', async () => {
    const res = await api(owner, 'POST', '/guilds', { name: '  Мой сервер ', lang: 'ru' });
    expect(res.statusCode, res.body).toBe(201);
    const { guild } = res.json<GuildBody>();
    guildId = guild.id;
    expect(guild.name).toBe('Мой сервер');
    expect(guild.ownerId).toBe(owner.user.id);
    expect(guild.memberCount).toBe(1);
    expect(guild.me.permissions).toContain('ADMINISTRATOR');
    const channels = await env.prisma.channel.findMany({ where: { guildId }, orderBy: { position: 'asc' } });
    const cats = channels.filter((c) => c.type === 'CATEGORY').map((c) => c.name);
    expect(cats).toEqual(['Текстовые каналы', 'Голосовые каналы']);
    const text = channels.find((c) => c.type === 'TEXT');
    expect(text?.name).toBe('общий');
    expect(text?.parentId).toBe(channels.find((c) => c.name === 'Текстовые каналы')?.id);
    expect(channels.find((c) => c.type === 'VOICE')?.name).toBe('Общий');
    expect(guild.systemChannelId).toBe(text?.id);
    const everyone = await env.prisma.roleDef.findFirst({ where: { guildId, key: 'everyone' } });
    expect(everyone?.permissions).toEqual(expect.arrayContaining(['VIEW_CHANNEL', 'SEND_MESSAGES', 'CREATE_INVITE']));
  });

  it('public edition: channel names follow the language of the creator, English by default', async () => {
    const res = await api(owner, 'POST', '/guilds', { name: 'Our place' });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json<GuildBody>().guild.id;
    const channels = await env.prisma.channel.findMany({ where: { guildId: id }, orderBy: { position: 'asc' } });
    expect(channels.filter((c) => c.type === 'CATEGORY').map((c) => c.name)).toEqual(['Text channels', 'Voice channels']);
    expect(channels.find((c) => c.type === 'TEXT')?.name).toBe('general');
    expect(channels.find((c) => c.type === 'VOICE')?.name).toBe('General');
    expect((await api(owner, 'POST', '/guilds', { name: 'x', lang: 'de' })).statusCode).toBe(400);
    await api(owner, 'DELETE', `/guilds/${id}`);
  });

  it('rejects an empty or too long name', async () => {
    expect((await api(owner, 'POST', '/guilds', { name: '   ' })).statusCode).toBe(400);
    expect((await api(owner, 'POST', '/guilds', { name: 'x'.repeat(101) })).statusCode).toBe(400);
  });

  it('lists my servers and hides others', async () => {
    const mine = await api(owner, 'GET', '/guilds');
    expect(mine.json<{ guilds: { id: string }[] }>().guilds.map((g) => g.id)).toContain(guildId);
    const theirs = await api(outsider, 'GET', '/guilds');
    expect(theirs.json<{ guilds: { id: string }[] }>().guilds.map((g) => g.id)).not.toContain(guildId);
    const hidden = await api(outsider, 'GET', `/guilds/${guildId}`);
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json<{ error: { code: string } }>().error.code).toBe('GUILD_NOT_FOUND');
  });

  it('requires MANAGE_GUILD to rename and broadcasts guild.updated to members', async () => {
    await env.ctx.services.guilds.join(member.user.id, guildId);
    expect((await api(member, 'PATCH', `/guilds/${guildId}`, { name: 'hack' })).statusCode).toBe(403);
    const socket = connectSocket(base, member.accessToken);
    await waitForEvent(socket, 'ready');
    try {
      const updated = waitForEvent<{ id: string; name: string }>(socket, 'guild.updated');
      const res = await api(owner, 'PATCH', `/guilds/${guildId}`, { name: 'Renamed' });
      expect(res.statusCode, res.body).toBe(200);
      expect((await updated).name).toBe('Renamed');
    } finally {
      socket.disconnect();
    }
  });

  it('lists members with their server profile fields', async () => {
    const res = await api(member, 'GET', `/guilds/${guildId}/members`);
    expect(res.statusCode).toBe(200);
    const members = res.json<{ members: { userId: string; nickname: string | null; roleIds: string[] }[] }>().members;
    expect(members.map((m) => m.userId).sort()).toEqual([owner.user.id, member.user.id].sort());
    expect(members[0]).toMatchObject({ nickname: null, roleIds: [] });
  });

  it('does not let the owner leave but lets a member leave', async () => {
    const ownerLeave = await api(owner, 'DELETE', `/guilds/${guildId}/members/me`);
    expect(ownerLeave.statusCode).toBe(409);
    expect(ownerLeave.json<{ error: { code: string } }>().error.code).toBe('OWNER_CANNOT_LEAVE');
    expect((await api(member, 'DELETE', `/guilds/${guildId}/members/me`)).statusCode).toBe(204);
    expect((await api(member, 'GET', `/guilds/${guildId}`)).statusCode).toBe(404);
  });

  it('transfers ownership only to a member', async () => {
    expect((await api(owner, 'POST', `/guilds/${guildId}/transfer`, { userId: outsider.user.id })).statusCode).toBe(400);
    await env.ctx.services.guilds.join(member.user.id, guildId);
    expect((await api(member, 'POST', `/guilds/${guildId}/transfer`, { userId: member.user.id })).statusCode).toBe(403);
    const res = await api(owner, 'POST', `/guilds/${guildId}/transfer`, { userId: member.user.id });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<GuildBody>().guild.ownerId).toBe(member.user.id);
    // back to the original owner for the next tests
    expect((await api(member, 'POST', `/guilds/${guildId}/transfer`, { userId: owner.user.id })).statusCode).toBe(200);
  });

  it('keeps the admin guild list for the superadmin only', async () => {
    expect((await api(owner, 'GET', '/admin/guilds')).statusCode).toBe(403);
    const res = await api(superadmin, 'GET', '/admin/guilds');
    expect(res.statusCode).toBe(200);
    expect(res.json<{ guilds: { id: string }[] }>().guilds.map((g) => g.id)).toContain(guildId);
    // The superadmin can open a server without being a member.
    expect((await api(superadmin, 'GET', `/guilds/${guildId}`)).statusCode).toBe(200);
  });

  it('deletes a server only with the right name, removes its files and tells the members', async () => {
    const channel = await env.prisma.channel.findFirstOrThrow({ where: { guildId, type: 'TEXT' } });
    const storedName = randomUUID();
    await writeFile(path.join(env.uploadDir, storedName), 'x');
    const message = await env.prisma.message.create({ data: { channelId: channel.id, authorId: owner.user.id, content: 'file' } });
    await env.prisma.attachment.create({ data: { uploaderId: owner.user.id, messageId: message.id, originalName: 'a.bin', storedName, mimeType: 'application/octet-stream', size: 1n, sha256: '0'.repeat(64) } });
    expect((await api(member, 'DELETE', `/guilds/${guildId}`, { confirmName: 'Renamed' })).statusCode).toBe(403);
    const wrong = await api(owner, 'DELETE', `/guilds/${guildId}`, { confirmName: 'nope' });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json<{ error: { code: string } }>().error.code).toBe('CONFIRM_MISMATCH');
    const socket = connectSocket(base, member.accessToken);
    await waitForEvent(socket, 'ready');
    try {
      const deleted = waitForEvent<{ guildId: string }>(socket, 'guild.deleted');
      expect((await api(owner, 'DELETE', `/guilds/${guildId}`, { confirmName: 'renamed' })).statusCode).toBe(204);
      expect((await deleted).guildId).toBe(guildId);
    } finally {
      socket.disconnect();
    }
    expect(await env.prisma.guild.count({ where: { id: guildId } })).toBe(0);
    expect(await env.prisma.attachment.count({ where: { storedName } })).toBe(0);
    expect(await readdir(env.uploadDir)).not.toContain(storedName);
  });

  it('lets the superadmin delete someone else’s server', async () => {
    const created = await api(owner, 'POST', '/guilds', { name: 'Second' });
    const id = created.json<GuildBody>().guild.id;
    expect((await api(superadmin, 'DELETE', `/guilds/${id}`, { confirmName: 'Second' })).statusCode).toBe(204);
  });
});
