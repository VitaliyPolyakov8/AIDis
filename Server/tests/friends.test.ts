import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, connectSocket, createTestEnv, createUser, listen, loginAll, waitForEvent, type LoginResult, type TestEnv } from './helpers.js';

interface FriendsState {
  friends: { userId: string }[];
  incoming: { userId: string }[];
  outgoing: { userId: string }[];
}

describe('friends, DMs and who can see whom', () => {
  let env: TestEnv;
  let base: string;
  let alice: LoginResult, bob: LoginResult, carol: LoginResult, stranger: LoginResult, superadmin: LoginResult;

  const api = (user: LoginResult, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    env.app.inject({ method, url: `/api/v1${url}`, headers: bearer(user.accessToken), ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
  const state = async (user: LoginResult) => (await api(user, 'GET', '/friends')).json<FriendsState>();

  beforeAll(async () => {
    env = await createTestEnv();
    // alice, bob and carol share the AIDis server; the stranger shares nothing with anyone
    await createUser(env, 'fAlice');
    await createUser(env, 'fBob');
    await createUser(env, 'fCarol');
    await createUser(env, 'fStranger', 'USER', { join: false });
    await createUser(env, 'fSuper', 'ADMIN', { join: false });
    [alice, bob, carol, stranger, superadmin] = await loginAll(env, ['fAlice', 'fBob', 'fCarol', 'fStranger', 'fSuper']);
    base = await listen(env);
  });
  afterAll(async () => {
    await env.close();
  });

  it('sends a request by username and tells both sides', async () => {
    const socket = connectSocket(base, bob.accessToken);
    await waitForEvent(socket, 'ready');
    try {
      const changed = waitForEvent(socket, 'friends.changed');
      const res = await api(alice, 'POST', '/friends/requests', { username: 'FBOB' });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<{ status: string }>().status).toBe('sent');
      await changed;
    } finally {
      socket.disconnect();
    }
    expect((await state(bob)).incoming.map((r) => r.userId)).toEqual([alice.user.id]);
    expect((await state(alice)).outgoing.map((r) => r.userId)).toEqual([bob.user.id]);
  });

  it('rejects yourself and unknown names', async () => {
    expect((await api(alice, 'POST', '/friends/requests', { username: 'fAlice' })).statusCode).toBe(400);
    const unknown = await api(alice, 'POST', '/friends/requests', { username: 'nobody-here' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json<{ error: { code: string } }>().error.code).toBe('USER_NOT_FOUND');
  });

  it('accepts at once when the other side already asked', async () => {
    const res = await api(bob, 'POST', '/friends/requests', { username: 'fAlice' });
    expect(res.json<{ status: string }>().status).toBe('accepted');
    expect((await state(alice)).friends.map((f) => f.userId)).toEqual([bob.user.id]);
    expect((await state(bob)).incoming).toEqual([]);
    expect((await api(alice, 'POST', '/friends/requests', { username: 'fBob' })).statusCode).toBe(409);
  });

  it('accepts and declines through the request endpoints', async () => {
    await api(carol, 'POST', '/friends/requests', { username: 'fAlice' });
    expect((await api(alice, 'DELETE', `/friends/requests/${carol.user.id}`)).statusCode).toBe(204);
    expect((await state(carol)).outgoing).toEqual([]);
    await api(carol, 'POST', '/friends/requests', { username: 'fAlice' });
    expect((await api(alice, 'POST', `/friends/requests/${carol.user.id}/accept`)).statusCode).toBe(204);
    expect((await state(carol)).friends.map((f) => f.userId)).toEqual([alice.user.id]);
  });

  it('opens a DM only with a friend', async () => {
    const denied = await api(bob, 'POST', '/dms', { userIds: [carol.user.id] });
    expect(denied.statusCode).toBe(403);
    expect(denied.json<{ error: { code: string } }>().error.code).toBe('NOT_FRIENDS');
    expect((await api(alice, 'POST', '/dms', { userIds: [bob.user.id] })).statusCode).toBe(201);
  });

  it('keeps a 1:1 history readable but closed after unfriending; a group stays open', async () => {
    const dm = (await api(alice, 'POST', '/dms', { userIds: [bob.user.id] })).json<{ dm: { id: string } }>().dm;
    const group = (await api(alice, 'POST', '/dms', { userIds: [bob.user.id, carol.user.id] })).json<{ dm: { id: string } }>().dm;
    expect((await api(bob, 'POST', `/channels/${dm.id}/messages`, { content: 'hi' })).statusCode).toBe(201);
    expect((await api(alice, 'DELETE', `/friends/${bob.user.id}`)).statusCode).toBe(204);
    expect((await api(bob, 'GET', `/channels/${dm.id}/messages`)).statusCode).toBe(200);
    const send = await api(bob, 'POST', `/channels/${dm.id}/messages`, { content: 'still there?' });
    expect(send.statusCode).toBe(403);
    expect(send.json<{ error: { code: string } }>().error.code).toBe('NOT_FRIENDS');
    expect((await api(bob, 'POST', `/dms/${dm.id}/call`)).statusCode).toBe(403);
    expect((await api(bob, 'POST', `/channels/${group.id}/messages`, { content: 'group ok' })).statusCode).toBe(201);
  });

  it('shows people only to friends and server neighbours; the superadmin sees everyone', async () => {
    const listed = (await api(alice, 'GET', '/users')).json<{ users: { id: string }[] }>().users.map((u) => u.id);
    expect(listed).toContain(bob.user.id);
    expect(listed).not.toContain(stranger.user.id);
    expect((await api(alice, 'GET', `/users/${stranger.user.id}`)).statusCode).toBe(404);
    expect((await api(alice, 'GET', `/users/${stranger.user.id}/games`)).statusCode).toBe(404);
    expect((await api(superadmin, 'GET', '/users')).json<{ users: { id: string }[] }>().users.map((u) => u.id)).toContain(stranger.user.id);
    // a friend outside every shared server stays visible
    await api(stranger, 'POST', '/friends/requests', { username: 'fAlice' });
    await api(alice, 'POST', `/friends/requests/${stranger.user.id}/accept`);
    expect((await api(alice, 'GET', `/users/${stranger.user.id}`)).statusCode).toBe(200);
  });

  it('shows who sent a request, who shares a DM, and an ex-friend in an old DM', async () => {
    await createUser(env, 'fLoner', 'USER', { join: false });
    const [loner] = await loginAll(env, ['fLoner']);
    expect((await api(alice, 'GET', `/users/${loner.user.id}`)).statusCode).toBe(404);
    await api(loner, 'POST', '/friends/requests', { username: 'fAlice' });
    expect((await api(alice, 'GET', `/users/${loner.user.id}`)).statusCode).toBe(200);
    expect((await api(loner, 'GET', `/users/${alice.user.id}`)).statusCode).toBe(200);
    await api(alice, 'POST', `/friends/requests/${loner.user.id}/accept`);
    // carol shares no server with loner, but they end up in one group DM through alice (friends with both)
    expect((await api(carol, 'GET', `/users/${loner.user.id}`)).statusCode).toBe(404);
    const groupRes = await api(alice, 'POST', '/dms', { userIds: [carol.user.id, loner.user.id] });
    expect(groupRes.statusCode, groupRes.body).toBe(201);
    const group = groupRes.json<{ dm: { id: string } }>().dm;
    expect((await api(carol, 'GET', `/users/${loner.user.id}`)).statusCode).toBe(200);
    // after unfriending, the 1:1 DM partner is still shown
    await api(alice, 'POST', '/dms', { userIds: [loner.user.id] });
    await api(alice, 'DELETE', `/friends/${loner.user.id}`);
    await api(carol, 'DELETE', `/dms/${group.id}/members/me`);
    await api(loner, 'DELETE', `/dms/${group.id}/members/me`);
    expect((await api(alice, 'GET', `/users/${loner.user.id}`)).statusCode).toBe(200);
    expect((await api(alice, 'GET', '/users')).json<{ users: { id: string }[] }>().users.map((u) => u.id)).toContain(loner.user.id);
  });

  it('caps pending requests', async () => {
    await env.ctx.services.limits.setOverride('friends.pending', 'USER', carol.user.id, 0);
    const res = await api(carol, 'POST', '/friends/requests', { username: 'fBob' });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('LIMIT_REACHED');
  });
});
