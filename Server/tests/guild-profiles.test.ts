import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, connectSocket, createTestEnv, createUser, listen, loginAll, waitForEvent, type LoginResult, type TestEnv } from './helpers.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZJkAAAAASUVORK5CYII=', 'base64');

describe('server profiles, bio and server notification level', () => {
  let env: TestEnv;
  let base: string;
  let alice: LoginResult, bob: LoginResult, stranger: LoginResult;

  const api = (user: LoginResult, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    env.app.inject({ method, url: `/api/v1${url}`, headers: bearer(user.accessToken), ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
  const upload = async (user: LoginResult) => {
    const boundary = '----aidis';
    const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`), png, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const res = await env.app.inject({ method: 'POST', url: '/api/v1/attachments', headers: { ...bearer(user.accessToken), 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ attachment: { id: string } }>().attachment.id;
  };

  beforeAll(async () => {
    env = await createTestEnv();
    await createUser(env, 'pAlice');
    await createUser(env, 'pBob');
    await createUser(env, 'pStranger', 'USER', { join: false });
    [alice, bob, stranger] = await loginAll(env, ['pAlice', 'pBob', 'pStranger']);
    base = await listen(env);
  });
  afterAll(async () => {
    await env.close();
  });

  it('sets a server profile without touching the global one and tells only that server', async () => {
    const avatar = await upload(alice);
    const bobSocket = connectSocket(base, bob.accessToken);
    const strangerSocket = connectSocket(base, stranger.accessToken);
    await Promise.all([waitForEvent(bobSocket, 'ready'), waitForEvent(strangerSocket, 'ready')]);
    let strangerGot = false;
    strangerSocket.on('guild.member.updated', () => {
      strangerGot = true;
    });
    try {
      const updated = waitForEvent<{ guildId: string; member: { nickname: string } }>(bobSocket, 'guild.member.updated');
      const res = await api(alice, 'PATCH', `/guilds/${env.guildId}/members/me/profile`, { nickname: 'Лиса', avatarAttachmentId: avatar, bio: 'Привет!\nЯ тут.' });
      expect(res.statusCode, res.body).toBe(200);
      expect((await updated).member.nickname).toBe('Лиса');
    } finally {
      bobSocket.disconnect();
      strangerSocket.disconnect();
    }
    expect(strangerGot).toBe(false);
    const members = (await api(bob, 'GET', `/guilds/${env.guildId}/members`)).json<{ members: { userId: string; nickname: string; avatarAttachmentId: string; bio: string }[] }>().members;
    expect(members.find((m) => m.userId === alice.user.id)).toMatchObject({ nickname: 'Лиса', avatarAttachmentId: avatar, bio: 'Привет!\nЯ тут.' });
    const global = (await api(bob, 'GET', `/users/${alice.user.id}`)).json<{ user: { avatarAttachmentId: string | null; bio: string | null } }>().user;
    expect(global).toMatchObject({ avatarAttachmentId: null, bio: null });
  });

  it('serves server-profile pictures to members of that server, not to strangers', async () => {
    const avatar = await upload(alice);
    expect((await api(alice, 'PATCH', `/guilds/${env.guildId}/members/me/profile`, { avatarAttachmentId: avatar })).statusCode).toBe(200);
    expect((await api(bob, 'GET', `/attachments/${avatar}`)).statusCode).toBe(200);
    expect((await api(stranger, 'GET', `/attachments/${avatar}`)).statusCode).toBe(404);
  });

  it('serves the server icon to everyone signed in (invite previews need it) and checks its bytes', async () => {
    const owner = (await loginAll(env, ['test-owner']))[0];
    const fake = await (async () => {
      const boundary = '----aidis';
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`),
        Buffer.from('not an image'),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const res = await env.app.inject({ method: 'POST', url: '/api/v1/attachments', headers: { ...bearer(owner.accessToken), 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body });
      return res.json<{ attachment: { id: string } }>().attachment.id;
    })();
    expect((await api(owner, 'PATCH', `/guilds/${env.guildId}`, { iconAttachmentId: fake })).statusCode).toBe(400);
    const icon = await upload(owner);
    expect((await api(owner, 'PATCH', `/guilds/${env.guildId}`, { iconAttachmentId: icon })).statusCode).toBe(200);
    expect((await api(bob, 'GET', `/attachments/${icon}`)).statusCode).toBe(200);
    expect((await api(stranger, 'GET', `/attachments/${icon}`)).statusCode).toBe(200);
  });

  it('clears fields with null', async () => {
    const res = await api(alice, 'PATCH', `/guilds/${env.guildId}/members/me/profile`, { nickname: null, avatarAttachmentId: null, bio: null });
    expect(res.json<{ member: { nickname: string | null; avatarAttachmentId: string | null; bio: string | null } }>().member).toMatchObject({ nickname: null, avatarAttachmentId: null, bio: null });
  });

  it('rejects someone else’s file and a too long bio', async () => {
    const bobFile = await upload(bob);
    expect((await api(alice, 'PATCH', `/guilds/${env.guildId}/members/me/profile`, { avatarAttachmentId: bobFile })).statusCode).toBe(400);
    expect((await api(alice, 'PATCH', `/guilds/${env.guildId}/members/me/profile`, { bio: 'x'.repeat(191) })).statusCode).toBe(400);
    expect((await api(stranger, 'PATCH', `/guilds/${env.guildId}/members/me/profile`, { bio: 'hi' })).statusCode).toBe(404);
  });

  it('stores a global bio', async () => {
    const res = await api(alice, 'PATCH', '/users/me', { bio: 'Глобально' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ user: { bio: string } }>().user.bio).toBe('Глобально');
  });

  it('applies the member server notification level to channels without their own', async () => {
    const res = await api(alice, 'PATCH', `/guilds/${env.guildId}/members/me/settings`, { notifyMode: 'MENTIONS' });
    expect(res.statusCode, res.body).toBe(204);
    const reads = (await api(alice, 'GET', '/reads')).json<{ reads: { channelId: string; notifyMode: string | null; effectiveNotifyMode: string; guildId: string }[] }>().reads;
    const general = reads.find((r) => r.guildId === env.guildId);
    expect(general).toMatchObject({ notifyMode: null, effectiveNotifyMode: 'MENTIONS' });
    await api(alice, 'PATCH', `/guilds/${env.guildId}/members/me/settings`, { notifyMode: null });
    const after = (await api(alice, 'GET', '/reads')).json<{ reads: { guildId: string; effectiveNotifyMode: string }[] }>().reads;
    expect(after.find((r) => r.guildId === env.guildId)?.effectiveNotifyMode).toBe('ALL');
  });
});
