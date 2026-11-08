import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io-client';
import { DEFAULT_EVERYONE } from '../src/permissions/catalog.js';
import { befriend, bearer, connectSocket, createPrivateChannel, createTestEnv, createUser, getTextChannelId, listen, login, waitForEvent, type LoginResult, type TestEnv } from './helpers.js';

interface Msg {
  id: string;
  channelId: string;
  content: string;
  replyTo: { id: string; authorName: string; content: string; deleted: boolean } | null;
  reactions: { emoji: string; count: number; userIds: string[] }[];
  mentions: string[];
  pinnedAt: string | null;
}

describe('0.4.0 messaging, channels, roles, DMs (server-side enforcement)', () => {
  let env: TestEnv;
  let baseUrl: string;
  let admin: LoginResult;
  let alice: LoginResult;
  let bob: LoginResult;
  let carol: LoginResult;
  let general: string;
  const sockets: Socket[] = [];

  const api = (session: LoginResult, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    env.app.inject({ method, url: `/api/v1${url}`, headers: bearer(session.accessToken), ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
  const send = async (session: LoginResult, channelId: string, body: Record<string, unknown>) => {
    const res = await api(session, 'POST', `/channels/${channelId}/messages`, body);
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ message: Msg }>().message;
  };
  const socketFor = async (session: LoginResult) => {
    const s = connectSocket(baseUrl, session.accessToken);
    sockets.push(s);
    await waitForEvent(s, 'ready');
    return s;
  };
  /** Collects events of one name for a while (to prove something did NOT arrive). */
  const collect = <T>(s: Socket, event: string) => {
    const got: T[] = [];
    s.on(event, (p: T) => got.push(p));
    return got;
  };

  beforeAll(async () => {
    env = await createTestEnv();
    await createUser(env, 'Admin', 'ADMIN');
    await createUser(env, 'Alice');
    await createUser(env, 'Bob');
    await createUser(env, 'Carol');
    [admin, alice, bob, carol] = await Promise.all([login(env, 'Admin'), login(env, 'Alice'), login(env, 'Bob'), login(env, 'Carol')]);
    // 0.7.0: DMs are between friends.
    await befriend(env, alice.user.id, bob.user.id);
    await befriend(env, alice.user.id, carol.user.id);
    await befriend(env, bob.user.id, carol.user.id);
    general = await getTextChannelId(env);
    baseUrl = await listen(env);
  });
  afterAll(async () => {
    for (const s of sockets) s.disconnect();
    await env.close();
  });

  it('replies show a live preview of the original (and "deleted" after it is deleted)', async () => {
    const original = await send(alice, general, { content: 'Кто сегодня играет?' });
    const reply = await send(bob, general, { content: 'Я!', replyToId: original.id });
    expect(reply.replyTo).toMatchObject({ id: original.id, authorName: 'Alice', content: 'Кто сегодня играет?', deleted: false });
    await api(alice, 'DELETE', `/messages/${original.id}`);
    const again = (await api(bob, 'GET', `/messages/${reply.id}`)).json<{ message: Msg }>().message;
    expect(again.replyTo).toMatchObject({ id: original.id, deleted: true, content: '' });
  });

  it('reactions: add / remove own, counts and who, realtime without reloading the message', async () => {
    const bobSocket = await socketFor(bob);
    const msg = await send(alice, general, { content: 'react to me' });
    const event = waitForEvent<{ messageId: string; reactions: Msg['reactions'] }>(bobSocket, 'message.reactions');
    const put = await api(alice, 'PUT', `/messages/${msg.id}/reactions/${encodeURIComponent('👍')}`);
    expect(put.statusCode).toBe(200);
    expect((await event).reactions).toEqual([{ emoji: '👍', count: 1, userIds: [alice.user.id] }]);
    await api(bob, 'PUT', `/messages/${msg.id}/reactions/${encodeURIComponent('👍')}`);
    await api(bob, 'PUT', `/messages/${msg.id}/reactions/${encodeURIComponent('❤️')}`);
    // Idempotent; and removing only removes your own.
    await api(bob, 'PUT', `/messages/${msg.id}/reactions/${encodeURIComponent('👍')}`);
    const del = await api(bob, 'DELETE', `/messages/${msg.id}/reactions/${encodeURIComponent('👍')}`);
    expect(del.json<{ reactions: Msg['reactions'] }>().reactions).toEqual([
      { emoji: '👍', count: 1, userIds: [alice.user.id] },
      { emoji: '❤️', count: 1, userIds: [bob.user.id] },
    ]);
    expect((await api(bob, 'PUT', `/messages/${msg.id}/reactions/${encodeURIComponent('not an emoji')}`)).statusCode).toBe(400);
    expect((await api(bob, 'PUT', `/messages/${msg.id}/reactions/abc`)).statusCode).toBe(400);
  });

  it('mentions are stored as user ids and count separately in unread state', async () => {
    const before = (await api(bob, 'GET', '/reads')).json<{ reads: { channelId: string; unread: number; mentions: number }[] }>().reads.find((r) => r.channelId === general);
    await api(bob, 'POST', `/channels/${general}/read`, {});
    const msg = await send(alice, general, { content: 'эй @bob и @nobody, глянь' });
    expect(msg.mentions).toEqual([bob.user.id]);
    await send(alice, general, { content: 'ещё одно' });
    const after = (await api(bob, 'GET', '/reads')).json<{ reads: { channelId: string; unread: number; mentions: number }[] }>().reads.find((r) => r.channelId === general);
    expect(before).toBeDefined();
    expect(after).toMatchObject({ unread: 2, mentions: 1 });
    // Loading history does not mark anything read.
    await api(bob, 'GET', `/channels/${general}/messages`);
    expect((await api(bob, 'GET', '/reads')).json<{ reads: { channelId: string; unread: number }[] }>().reads.find((r) => r.channelId === general)?.unread).toBe(2);
    // Marking read does (and is broadcast to the user's other devices).
    const bobSocket = await socketFor(bob);
    const sync = waitForEvent<{ channelId: string; unread: number }>(bobSocket, 'read.updated');
    expect((await api(bob, 'POST', `/channels/${general}/read`, {})).json<{ read: { unread: number } }>().read.unread).toBe(0);
    expect(await sync).toMatchObject({ channelId: general, unread: 0 });
    // Own messages never count as unread.
    await send(bob, general, { content: 'my own' });
    expect((await api(bob, 'GET', '/reads')).json<{ reads: { channelId: string; unread: number }[] }>().reads.find((r) => r.channelId === general)?.unread).toBe(0);
  });

  it('notification mode per channel and user', async () => {
    const res = await api(alice, 'PUT', `/channels/${general}/notify`, { mode: 'MENTIONS' });
    expect(res.json<{ read: { notifyMode: string } }>().read.notifyMode).toBe('MENTIONS');
    expect((await api(alice, 'PUT', `/channels/${general}/notify`, { mode: 'LOUD' })).statusCode).toBe(400);
    const bobs = (await api(bob, 'GET', '/reads')).json<{ reads: { channelId: string; notifyMode: string | null }[] }>().reads.find((r) => r.channelId === general);
    expect(bobs?.notifyMode).toBeNull();
  });

  it('pins: MANAGE_MESSAGES only (or admin), listed per channel; jump with ?around', async () => {
    const msg = await send(alice, general, { content: 'pin me' });
    expect((await api(bob, 'PUT', `/messages/${msg.id}/pin`)).statusCode).toBe(403);
    expect((await api(admin, 'PUT', `/messages/${msg.id}/pin`)).statusCode).toBe(200);
    const pins = (await api(bob, 'GET', `/channels/${general}/pins`)).json<{ messages: Msg[] }>().messages;
    expect(pins.map((m) => m.id)).toContain(msg.id);
    const around = (await api(bob, 'GET', `/channels/${general}/messages?around=${msg.id}&limit=10`)).json<{ messages: Msg[]; hasMore: boolean; hasNewer: boolean }>();
    expect(around.messages.some((m) => m.id === msg.id)).toBe(true);
    const audit = (await api(admin, 'GET', `/guilds/${env.guildId}/audit`)).json<{ entries: { action: string }[] }>().entries;
    expect(audit.some((e) => e.action === 'message.pinned')).toBe(true);
    expect((await api(bob, 'GET', `/guilds/${env.guildId}/audit`)).statusCode).toBe(403);
    expect((await api(bob, 'GET', '/admin/audit')).statusCode).toBe(403);
  });

  it('search finds text across visible channels of the server, filters by author', async () => {
    await send(alice, general, { content: 'Helldivers 2 вечером?' });
    const all = (await api(bob, 'GET', `/search/messages?q=${encodeURIComponent('helldivers')}&guildId=${env.guildId}`)).json<{ messages: Msg[] }>().messages;
    expect(all.length).toBeGreaterThan(0);
    const byBob = (await api(bob, 'GET', `/search/messages?q=helldivers&guildId=${env.guildId}&authorId=${bob.user.id}`)).json<{ messages: Msg[] }>().messages;
    expect(byBob).toHaveLength(0);
  });

  it('channel management: MANAGE_CHANNELS only, protected defaults, audit, realtime list change', async () => {
    const channelsUrl = `/guilds/${env.guildId}/channels`;
    expect((await api(alice, 'POST', channelsUrl, { type: 'TEXT', name: 'nope' })).statusCode).toBe(403);
    const aliceSocket = await socketFor(alice);
    const changed = waitForEvent(aliceSocket, 'channels.changed');
    const created = await api(admin, 'POST', channelsUrl, { type: 'TEXT', name: 'announcements', description: 'News' });
    expect(created.statusCode).toBe(201);
    await changed;
    const id = created.json<{ channel: { id: string } }>().channel.id;
    expect((await api(admin, 'PATCH', `/channels/${id}`, { name: 'news' })).json<{ channel: { name: string } }>().channel.name).toBe('news');
    expect((await api(admin, 'DELETE', `/channels/${general}`)).statusCode).toBe(409);
    const texts = async () => (await api(alice, 'GET', channelsUrl)).json<{ channels: { id: string; type: string; position: number; parentId: string | null }[] }>().channels.filter((c) => c.type === 'TEXT');
    const before = await texts();
    const reversed = [...before].reverse();
    expect((await api(admin, 'PUT', `/guilds/${env.guildId}/channels/order`, { items: reversed.map((c, position) => ({ id: c.id, parentId: c.parentId, position })) })).statusCode).toBe(204);
    expect((await texts()).sort((a, b) => a.position - b.position).map((c) => c.id)).toEqual(reversed.map((c) => c.id));
    expect((await api(admin, 'DELETE', `/channels/${id}`)).statusCode).toBe(204);
    const actions = (await api(admin, 'GET', `/guilds/${env.guildId}/audit`)).json<{ entries: { action: string }[] }>().entries.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['channel.created', 'channel.updated', 'channel.deleted', 'channel.reordered']));
  });

  it('private channels: invisible (list, history, send, files, realtime) unless allowed by user or role', async () => {
    const secret = (await createPrivateChannel(env, 'secret', { userIds: [alice.user.id] })).id;
    const bobSocket = await socketFor(bob);
    const bobGot = collect<Msg>(bobSocket, 'message.created');
    const aliceSocket = await socketFor(alice);
    const aliceGets = waitForEvent<Msg>(aliceSocket, 'message.created');
    const msg = await send(alice, secret, { content: 'тсс' });
    expect((await aliceGets).id).toBe(msg.id);
    await new Promise((r) => setTimeout(r, 300));
    expect(bobGot.filter((m) => m.channelId === secret)).toHaveLength(0);
    expect((await api(bob, 'GET', `/guilds/${env.guildId}/channels`)).json<{ channels: { id: string }[] }>().channels.some((c) => c.id === secret)).toBe(false);
    expect((await api(bob, 'GET', `/channels/${secret}/messages`)).statusCode).toBe(404);
    expect((await api(bob, 'POST', `/channels/${secret}/messages`, { content: 'hi' })).statusCode).toBe(404);
    expect((await api(bob, 'GET', `/messages/${msg.id}`)).statusCode).toBe(404);
    expect((await api(bob, 'PUT', `/messages/${msg.id}/reactions/${encodeURIComponent('👍')}`)).statusCode).toBe(404);
    expect((await api(bob, 'GET', `/search/messages?q=${encodeURIComponent('тсс')}&guildId=${env.guildId}`)).json<{ messages: Msg[] }>().messages).toHaveLength(0);
    // A file in the private channel is not served to Bob.
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('secret file')], { type: 'text/plain' }), 'secret.txt');
    const upload = await fetch(`${baseUrl}/api/v1/attachments`, { method: 'POST', headers: bearer(alice.accessToken), body: form });
    const attachment = ((await upload.json()) as { attachment: { id: string } }).attachment;
    await send(alice, secret, { content: 'file', attachmentIds: [attachment.id] });
    expect((await api(bob, 'GET', `/attachments/${attachment.id}/content`)).statusCode).toBe(404);
    expect((await api(alice, 'GET', `/attachments/${attachment.id}/content`)).statusCode).toBe(200);
    // Allowed through a role: Bob gets Moderator, the channel allows Moderator.
    const rolesUrl = `/guilds/${env.guildId}/roles`;
    const moderator = (await api(admin, 'POST', rolesUrl, { name: 'Moderator' })).json<{ role: { id: string } }>().role.id;
    await api(admin, 'PUT', `/channels/${secret}/overwrites/ROLE/${moderator}`, { allow: ['VIEW_CHANNEL'], deny: [] });
    expect((await api(bob, 'GET', `/channels/${secret}/messages`)).statusCode).toBe(404);
    expect((await api(admin, 'PUT', `/guilds/${env.guildId}/members/${bob.user.id}/roles`, { roleIds: [moderator] })).statusCode).toBe(200);
    expect((await api(bob, 'GET', `/channels/${secret}/messages`)).statusCode).toBe(200);
    const bobLive = waitForEvent<Msg>(bobSocket, 'message.created');
    await send(alice, secret, { content: 'теперь видно' });
    expect((await bobLive).channelId).toBe(secret);
    await api(admin, 'PUT', `/guilds/${env.guildId}/members/${bob.user.id}/roles`, { roleIds: [] });
  });

  it('roles: permissions are enforced; nobody grants what they do not have', async () => {
    const rolesUrl = `/guilds/${env.guildId}/roles`;
    const perms = (await api(alice, 'GET', `/guilds/${env.guildId}/permissions`)).json<{ permissions: string[] }>().permissions;
    expect(perms.sort()).toEqual([...DEFAULT_EVERYONE].sort());
    const created = await api(admin, 'POST', rolesUrl, { name: 'Role Managers', color: '#ff00aa', permissions: ['MANAGE_ROLES'] });
    expect(created.statusCode).toBe(201);
    const managers = created.json<{ role: { id: string } }>().role.id;
    await api(admin, 'PUT', `/guilds/${env.guildId}/members/${alice.user.id}/roles`, { roleIds: [managers] });
    // Alice can manage roles, but cannot hand out MANAGE_CHANNELS which she lacks.
    expect((await api(alice, 'POST', rolesUrl, { name: 'Builders', permissions: ['MANAGE_CHANNELS'] })).statusCode).toBe(403);
    expect((await api(alice, 'POST', rolesUrl, { name: 'Plain', permissions: [] })).statusCode).toBe(201);
    expect((await api(bob, 'POST', rolesUrl, { name: 'x' })).statusCode).toBe(403);
    // Built-in roles cannot be deleted; badges are admin-only.
    const everyone = (await api(admin, 'GET', rolesUrl)).json<{ roles: { id: string; isEveryone: boolean }[] }>().roles.find((r) => r.isEveryone)?.id ?? '';
    expect((await api(admin, 'DELETE', `${rolesUrl}/${everyone}`)).statusCode).toBe(409);
    const badges = (await api(alice, 'GET', '/badges')).json<{ badges: { id: string; key: string }[] }>().badges;
    expect(badges.map((b) => b.key)).toEqual(['admin', 'developer', 'founder', 'tester']);
    const tester = badges.find((b) => b.key === 'tester')?.id ?? '';
    expect((await api(alice, 'PUT', `/users/${bob.user.id}/badges`, { badgeIds: [tester] })).statusCode).toBe(403);
    expect((await api(admin, 'PUT', `/users/${bob.user.id}/badges`, { badgeIds: [tester] })).json<{ badges: string[] }>().badges).toEqual(['tester']);
    const bobProfile = (await api(alice, 'GET', '/users')).json<{ users: { id: string; badges: string[] }[] }>().users.find((u) => u.id === bob.user.id);
    expect(bobProfile?.badges).toEqual(['tester']);
    // Removing VIEW_CHANNEL from @everyone hides channels from regular users (the superadmin still sees them).
    const channelsUrl = `/guilds/${env.guildId}/channels`;
    await api(admin, 'PATCH', `${rolesUrl}/${everyone}`, { permissions: DEFAULT_EVERYONE.filter((p) => p !== 'VIEW_CHANNEL') });
    expect((await api(carol, 'GET', channelsUrl)).json<{ channels: unknown[] }>().channels).toHaveLength(0);
    expect((await api(admin, 'GET', channelsUrl)).json<{ channels: unknown[] }>().channels.length).toBeGreaterThan(0);
    await api(admin, 'PATCH', `${rolesUrl}/${everyone}`, { permissions: [...DEFAULT_EVERYONE] });
    expect((await api(carol, 'GET', channelsUrl)).json<{ channels: unknown[] }>().channels.length).toBeGreaterThan(0);
    await api(admin, 'PUT', `/guilds/${env.guildId}/members/${alice.user.id}/roles`, { roleIds: [] });
  });

  it('DMs: 1:1 reuses one conversation, group DMs, members only (not even admins), realtime only to members', async () => {
    const first = await api(alice, 'POST', '/dms', { userIds: [bob.user.id] });
    expect(first.statusCode).toBe(201);
    const dm = first.json<{ dm: { id: string; type: string; memberIds: string[] } }>().dm;
    expect(dm.memberIds.sort()).toEqual([alice.user.id, bob.user.id].sort());
    expect((await api(bob, 'POST', '/dms', { userIds: [alice.user.id] })).json<{ dm: { id: string } }>().dm.id).toBe(dm.id);
    const carolSocket = await socketFor(carol);
    const carolGot = collect<Msg>(carolSocket, 'message.created');
    const bobSocket = await socketFor(bob);
    const bobGets = waitForEvent<Msg>(bobSocket, 'message.created');
    const msg = await send(alice, dm.id, { content: 'привет, лично' });
    expect((await bobGets).id).toBe(msg.id);
    await new Promise((r) => setTimeout(r, 300));
    expect(carolGot).toHaveLength(0);
    for (const outsider of [carol, admin]) {
      expect((await api(outsider, 'GET', `/channels/${dm.id}/messages`)).statusCode).toBe(404);
      expect((await api(outsider, 'POST', `/channels/${dm.id}/messages`, { content: 'x' })).statusCode).toBe(404);
      expect((await api(outsider, 'GET', `/messages/${msg.id}`)).statusCode).toBe(404);
    }
    expect((await api(carol, 'GET', '/dms')).json<{ dms: unknown[] }>().dms).toHaveLength(0);
    expect((await api(bob, 'GET', '/dms')).json<{ dms: { id: string }[] }>().dms.map((d) => d.id)).toContain(dm.id);
    // Unread counts include DMs.
    const unread = (await api(bob, 'GET', '/reads')).json<{ reads: { channelId: string; unread: number }[] }>().reads.find((r) => r.channelId === dm.id);
    expect(unread?.unread).toBe(1);
    // Group DM.
    const group = await api(alice, 'POST', '/dms', { userIds: [bob.user.id, carol.user.id], title: 'Squad' });
    const g = group.json<{ dm: { id: string; title: string; memberIds: string[] } }>().dm;
    expect(g).toMatchObject({ title: 'Squad' });
    expect(g.memberIds).toHaveLength(3);
    expect((await api(carol, 'GET', `/channels/${g.id}/messages`)).statusCode).toBe(200);
    // Calls: ring the others; voice token checks membership (LiveKit itself is not running in tests).
    const ring = waitForEvent<{ channelId: string; fromUserId: string }>(bobSocket, 'call.ring');
    expect((await api(alice, 'POST', `/dms/${dm.id}/call`)).statusCode).toBe(204);
    expect(await ring).toEqual({ channelId: dm.id, fromUserId: alice.user.id });
    expect((await api(carol, 'POST', '/voice/token', { channelId: dm.id })).statusCode).toBe(404);
    expect((await api(bob, 'POST', '/voice/token', { channelId: dm.id })).statusCode).toBe(200);
    // Leave a group; 1:1 cannot be left.
    expect((await api(carol, 'DELETE', `/dms/${g.id}/members/me`)).statusCode).toBe(204);
    expect((await api(carol, 'GET', `/channels/${g.id}/messages`)).statusCode).toBe(404);
    expect((await api(bob, 'DELETE', `/dms/${dm.id}/members/me`)).statusCode).toBe(400);
  });

  it('profiles: banner / accent / frame / tags validated; status emoji', async () => {
    const ok = await api(alice, 'PATCH', '/users/me', { accentColor: '#FF8800', profileFrame: 'neon', profileTags: ['Helldivers 2', 'Tarkov'] });
    expect(ok.json<{ user: Record<string, unknown> }>().user).toMatchObject({ accentColor: '#ff8800', profileFrame: 'neon', profileTags: ['Helldivers 2', 'Tarkov'] });
    expect((await api(alice, 'PATCH', '/users/me', { profileFrame: 'rainbow-explosion' })).statusCode).toBe(400);
    expect((await api(alice, 'PATCH', '/users/me', { profileTags: ['1', '2', '3', '4', '5', '6'] })).statusCode).toBe(400);
    expect((await api(alice, 'PATCH', '/users/me', { accentColor: 'red' })).statusCode).toBe(400);
    // A banner must be an image you uploaded; text is refused by its bytes.
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('not an image')], { type: 'image/png' }), 'fake.png');
    const upload = await fetch(`${baseUrl}/api/v1/attachments`, { method: 'POST', headers: bearer(alice.accessToken), body: form });
    const fake = ((await upload.json()) as { attachment: { id: string } }).attachment.id;
    expect((await api(alice, 'PATCH', '/users/me', { bannerAttachmentId: fake })).json<{ error: { code: string } }>().error.code).toBe('BANNER_FORMAT');
    const status = await api(alice, 'PATCH', '/users/me/status', { customStatus: { text: 'Играю', expiresAt: null, emoji: '🎮' } });
    expect(status.json<{ customStatus: { emoji: string } }>().customStatus.emoji).toBe('🎮');
    expect((await api(alice, 'PATCH', '/users/me/status', { customStatus: { text: 'x', expiresAt: null, emoji: 'abc' } })).statusCode).toBe(400);
  });

  it('voice moderation needs MOVE_USERS / DISCONNECT_USERS', async () => {
    const voice = await env.prisma.channel.findMany({ where: { type: 'VOICE', guildId: env.guildId }, orderBy: { position: 'asc' } });
    const [a, b] = voice;
    expect((await api(alice, 'POST', `/voice/channels/${a?.id}/participants/${bob.user.id}/move`, { targetChannelId: b?.id })).statusCode).toBe(403);
    expect((await api(alice, 'POST', `/voice/channels/${a?.id}/participants/${bob.user.id}/disconnect`)).statusCode).toBe(403);
  });
});
