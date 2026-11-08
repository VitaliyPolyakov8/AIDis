import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { befriend, bearer, connectSocket, createTestEnv, createUser, getTextChannelId, listen, login, waitForEvent, type LoginResult, type TestEnv } from './helpers.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZJkAAAAASUVORK5CYII=', 'base64');
interface EmojiView {
  id: string;
  guildId: string;
  name: string;
  createdById: string;
  animated: boolean;
}

describe('server emoji access and lifecycle', () => {
  let env: TestEnv;
  let owner: LoginResult;
  let alice: LoginResult;
  let bob: LoginResult;
  let base: string;
  beforeAll(async () => {
    env = await createTestEnv();
    await createUser(env, 'EmojiAlice');
    await createUser(env, 'EmojiBob');
    [owner, alice, bob] = await Promise.all([login(env, 'test-owner'), login(env, 'EmojiAlice'), login(env, 'EmojiBob')]);
    base = await listen(env);
  });
  afterAll(async () => {
    await env.close();
  });
  const api = (user: LoginResult, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    env.app.inject({ method, url: `/api/v1${url}`, headers: bearer(user.accessToken), ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
  const upload = (user: LoginResult, name: string, bytes = png, guildId = env.guildId) =>
    env.app.inject({ method: 'POST', url: `/api/v1/guilds/${guildId}/emojis?name=${encodeURIComponent(name)}`, headers: { ...bearer(user.accessToken), 'content-type': 'application/octet-stream' }, payload: bytes });
  let roleId: string;
  it('lists only for signed-in users and denies an ordinary user before accepting file data', async () => {
    expect((await env.app.inject({ method: 'GET', url: '/api/v1/emojis' })).statusCode).toBe(401);
    const list = await api(bob, 'GET', '/emojis');
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ emojis: [] });
    expect((await upload(bob, 'nope')).statusCode).toBe(403);
  });
  it('lets the server owner grant the distinct upload permission to a role', async () => {
    const role = await api(owner, 'POST', `/guilds/${env.guildId}/roles`, { name: 'Emoji artists', permissions: ['CREATE_EMOJIS'] });
    expect(role.statusCode, role.body).toBe(201);
    roleId = role.json<{ role: { id: string } }>().role.id;
    const assigned = await api(owner, 'PUT', `/guilds/${env.guildId}/members/${alice.user.id}/roles`, { roleIds: [roleId] });
    expect(assigned.statusCode, assigned.body).toBe(200);
  });
  let emoji: EmojiView;
  it('publishes an authenticated image and broadcasts catalog changes to another member', async () => {
    const socket = connectSocket(base, bob.accessToken);
    await waitForEvent(socket, 'ready');
    try {
      const changed = waitForEvent<{ guildId: string }>(socket, 'emojis.changed');
      const created = await upload(alice, 'Улыбка');
      expect(created.statusCode, created.body).toBe(201);
      emoji = created.json<{ emoji: EmojiView }>().emoji;
      expect(emoji.name).toBe('улыбка');
      expect(emoji.createdById).toBe(alice.user.id);
      expect(emoji.guildId).toBe(env.guildId);
      expect((await changed).guildId).toBe(env.guildId);
      expect((await env.app.inject({ method: 'GET', url: `/api/v1/emojis/${emoji.id}/content` })).statusCode).toBe(401);
      const content = await api(bob, 'GET', `/emojis/${emoji.id}/content`);
      expect(content.statusCode).toBe(200);
      expect(content.headers['content-type']).toBe('image/png');
      expect(content.rawPayload).toEqual(png);
    } finally {
      socket.disconnect();
    }
  });
  it('rejects bad formats, huge dimensions, oversized files and duplicate names without orphan files', async () => {
    const before = (await readdir(env.uploadDir)).sort();
    for (const name of ['a', 'bad name', '<script>']) expect((await upload(alice, name)).statusCode).toBe(400);
    expect((await upload(alice, 'html', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).statusCode).toBe(400);
    const big = Buffer.from(png);
    big.writeUInt32BE(513, 16);
    expect((await upload(alice, 'big', big)).statusCode).toBe(400);
    expect((await upload(alice, 'huge', Buffer.alloc(512 * 1024 + 1))).statusCode).toBe(413);
    expect((await upload(alice, 'УЛЫБКА')).statusCode).toBe(409);
    expect((await readdir(env.uploadDir)).sort()).toEqual(before);
  });
  it('preserves the stable ID on rename, enforces ownership and uses the emoji in real reactions', async () => {
    expect((await api(bob, 'PATCH', `/emojis/${emoji.id}`, { name: 'stolen' })).statusCode).toBe(403);
    expect((await api(bob, 'DELETE', `/emojis/${emoji.id}`)).statusCode).toBe(403);
    const renamed = await api(alice, 'PATCH', `/emojis/${emoji.id}`, { name: 'smile' });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<{ emoji: EmojiView }>().emoji).toMatchObject({ id: emoji.id, name: 'smile' });
    const channel = await getTextChannelId(env);
    const message = await api(bob, 'POST', `/channels/${channel}/messages`, { content: ':smile: https://example.test/:smile:' });
    expect(message.statusCode).toBe(201);
    expect(message.json<{ message: { content: string } }>().message.content).toBe(`<:smile:${emoji.id}> https://example.test/:smile:`);
    const messageId = message.json<{ message: { id: string } }>().message.id;
    const edited = await api(bob, 'PATCH', `/messages/${messageId}`, { content: ':smile: again' });
    expect(edited.json<{ message: { content: string } }>().message.content).toBe(`<:smile:${emoji.id}> again`);
    const reactionUrl = `/messages/${messageId}/reactions/${encodeURIComponent(`custom:${emoji.id}`)}`;
    expect((await api(bob, 'PUT', reactionUrl)).statusCode).toBe(200);
    expect((await api(bob, 'PUT', `/messages/${messageId}/reactions/${encodeURIComponent(`custom:${randomUUID()}`)}`)).statusCode).toBe(404);
    expect((await api(owner, 'DELETE', `/emojis/${emoji.id}`)).statusCode).toBe(204);
    expect((await api(bob, 'GET', `/emojis/${emoji.id}/content`)).statusCode).toBe(404);
    expect((await api(bob, 'PUT', reactionUrl)).statusCode).toBe(404);
    expect((await api(bob, 'DELETE', reactionUrl)).statusCode).toBe(200);
  });
  it('applies permission revocation immediately and accepts a separate emoji moderator role', async () => {
    await api(owner, 'PUT', `/guilds/${env.guildId}/members/${alice.user.id}/roles`, { roleIds: [] });
    expect((await upload(alice, 'revoked')).statusCode).toBe(403);
    const role = await api(owner, 'POST', `/guilds/${env.guildId}/roles`, { name: 'Emoji moderators', permissions: ['MANAGE_EMOJIS'] });
    expect(role.statusCode).toBe(201);
    await api(owner, 'PUT', `/guilds/${env.guildId}/members/${alice.user.id}/roles`, { roleIds: [role.json<{ role: { id: string } }>().role.id] });
    const created = await upload(owner, 'admin_smile');
    expect(created.statusCode).toBe(201);
    const id = created.json<{ emoji: EmojiView }>().emoji.id;
    expect((await api(alice, 'PATCH', `/emojis/${id}`, { name: 'moderated' })).statusCode).toBe(200);
    expect((await api(alice, 'DELETE', `/emojis/${id}`)).statusCode).toBe(204);
  });
  it('keeps only one file when duplicate names are uploaded concurrently', async () => {
    const before = (await readdir(env.uploadDir)).length;
    const answers = await Promise.all([upload(owner, 'race_name'), upload(owner, 'RACE_NAME')]);
    expect(answers.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect((await readdir(env.uploadDir)).length).toBe(before + 1);
    const created = answers.find((r) => r.statusCode === 201);
    if (created) await api(owner, 'DELETE', `/emojis/${created.json<{ emoji: EmojiView }>().emoji.id}`);
  });
  it('enforces the configurable server limit and allows upload again after a deletion', async () => {
    await env.ctx.services.limits.setOverride('guild.emojis', 'GUILD', env.guildId, 3);
    await env.prisma.serverEmoji.createMany({
      data: Array.from({ length: 3 }, (_, slot) => ({
        guildId: env.guildId,
        name: `seed_${slot}`,
        slot,
        storedName: randomUUID(),
        mimeType: 'image/png',
        size: png.length,
        width: 1,
        height: 1,
        animated: false,
        createdById: owner.user.id,
      })),
    });
    const before = (await readdir(env.uploadDir)).length;
    const full = await upload(owner, 'over_limit');
    expect(full.statusCode).toBe(400);
    expect(full.json<{ error: { code: string } }>().error.code).toBe('LIMIT_REACHED');
    expect((await readdir(env.uploadDir)).length).toBe(before);
    await env.prisma.serverEmoji.deleteMany({ where: { guildId: env.guildId, slot: 2 } });
    expect((await upload(owner, 'last_slot')).statusCode).toBe(201);
    expect(await env.prisma.serverEmoji.count({ where: { guildId: env.guildId } })).toBe(3);
    await env.prisma.serverEmoji.deleteMany({ where: { guildId: env.guildId } });
    await env.ctx.services.limits.setOverride('guild.emojis', 'GUILD', env.guildId, null);
  });
});

describe('emojis across servers', () => {
  let env: TestEnv;
  let alice: LoginResult;
  let bob: LoginResult;
  let carol: LoginResult;
  let guildB: string;
  let aidisSmile: string;
  let bSmile: string;
  const api = (user: LoginResult, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    env.app.inject({ method, url: `/api/v1${url}`, headers: bearer(user.accessToken), ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
  const upload = (user: LoginResult, guildId: string, name: string) =>
    env.app.inject({ method: 'POST', url: `/api/v1/guilds/${guildId}/emojis?name=${name}`, headers: { ...bearer(user.accessToken), 'content-type': 'application/octet-stream' }, payload: png });
  beforeAll(async () => {
    env = await createTestEnv();
    await createUser(env, 'xAlice');
    await createUser(env, 'xBob');
    await createUser(env, 'xCarol', 'USER', { join: false });
    [alice, bob, carol] = await Promise.all([login(env, 'xAlice'), login(env, 'xBob'), login(env, 'xCarol')]);
    guildB = (await api(alice, 'POST', '/guilds', { name: 'B' })).json<{ guild: { id: string } }>().guild.id;
    const owner = await login(env, 'test-owner');
    aidisSmile = (await upload(owner, env.guildId, 'smile')).json<{ emoji: { id: string } }>().emoji.id;
    bSmile = (await upload(alice, guildB, 'smile')).json<{ emoji: { id: string } }>().emoji.id;
    await env.ctx.services.guilds.join(carol.user.id, guildB);
  });
  afterAll(async () => {
    await env.close();
  });

  it('allows the same name in two servers and lists the emojis of all my servers', async () => {
    expect(aidisSmile).not.toBe(bSmile);
    const mine = (await api(alice, 'GET', '/emojis'))
      .json<{ emojis: { id: string }[] }>()
      .emojis.map((e) => e.id)
      .sort();
    expect(mine).toEqual([aidisSmile, bSmile].sort());
    expect((await api(bob, 'GET', '/emojis')).json<{ emojis: { id: string }[] }>().emojis.map((e) => e.id)).toEqual([aidisSmile]);
  });

  it('prefers the channel server emoji, then the author’s other servers', async () => {
    const bChannel = await getTextChannelId(env, 'general', guildB);
    const inB = await api(alice, 'POST', `/channels/${bChannel}/messages`, { content: ':smile:' });
    expect(inB.json<{ message: { content: string } }>().message.content).toBe(`<:smile:${bSmile}>`);
    const inAidis = await api(alice, 'POST', `/channels/${await getTextChannelId(env)}/messages`, { content: ':smile:' });
    expect(inAidis.json<{ message: { content: string } }>().message.content).toBe(`<:smile:${aidisSmile}>`);
    const carolInB = await api(carol, 'POST', `/channels/${bChannel}/messages`, { content: ':smile:' });
    expect(carolInB.json<{ message: { content: string } }>().message.content).toBe(`<:smile:${bSmile}>`);
  });

  it('uses the author’s server emojis in DMs', async () => {
    await befriend(env, alice.user.id, carol.user.id);
    const dm = (await api(carol, 'POST', '/dms', { userIds: [alice.user.id] })).json<{ dm: { id: string } }>().dm;
    const res = await api(carol, 'POST', `/channels/${dm.id}/messages`, { content: ':smile:' });
    expect(res.json<{ message: { content: string } }>().message.content).toBe(`<:smile:${bSmile}>`);
  });

  it('does not let a non-member react with another server’s emoji', async () => {
    const message = (await api(bob, 'POST', `/channels/${await getTextChannelId(env)}/messages`, { content: 'hi' })).json<{ message: { id: string } }>().message;
    expect((await api(bob, 'PUT', `/messages/${message.id}/reactions/${encodeURIComponent(`custom:${bSmile}`)}`)).statusCode).toBe(404);
    expect((await api(alice, 'PUT', `/messages/${message.id}/reactions/${encodeURIComponent(`custom:${bSmile}`)}`)).statusCode).toBe(200);
  });
});
