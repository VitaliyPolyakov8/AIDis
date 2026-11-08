import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bearer,
  connectSocket,
  createTestEnv,
  createUser,
  getTextChannelId,
  listen,
  login,
  waitForEvent,
  type LoginResult,
  type TestEnv,
} from './helpers.js';

interface PresenceEvent {
  userId: string;
  status: 'online' | 'offline';
}

describe('realtime (Socket.IO)', () => {
  let env: TestEnv;
  let baseUrl: string;
  let alice: LoginResult;
  let bob: LoginResult;
  let general: string;

  beforeAll(async () => {
    env = await createTestEnv();
    await createUser(env, 'Alice');
    await createUser(env, 'Bob');
    alice = await login(env, 'Alice');
    bob = await login(env, 'Bob');
    general = await getTextChannelId(env);
    baseUrl = await listen(env);
  });

  afterAll(async () => {
    await env.close();
  });

  it('refuses connections without a token', async () => {
    const socket = connectSocket(baseUrl);
    const error = await waitForEvent<Error & { data?: { code: string } }>(socket, 'connect_error');
    expect(error.data?.code).toBe('UNAUTHORIZED');
    expect(socket.connected).toBe(false);
    socket.close();
  });

  it('refuses connections with an invalid token', async () => {
    const socket = connectSocket(baseUrl, 'not-a-real-token');
    const error = await waitForEvent<Error & { data?: { code: string } }>(socket, 'connect_error');
    expect(error.data?.code).toBe('UNAUTHORIZED');
    socket.close();
  });

  it('delivers message events and keeps users online while any connection remains', async () => {
    const bobSocket = connectSocket(baseUrl, bob.accessToken);
    const ready = await waitForEvent<{ user: { username: string } }>(bobSocket, 'ready');
    expect(ready.user.username).toBe('Bob');

    // Alice connects from two devices.
    const aliceOnline = waitForEvent<PresenceEvent>(bobSocket, 'presence.updated');
    const aliceDesktop = connectSocket(baseUrl, alice.accessToken);
    await waitForEvent(aliceDesktop, 'ready');
    expect(await aliceOnline).toMatchObject({ userId: alice.user.id, status: 'online' });
    const alicePhone = connectSocket(baseUrl, alice.accessToken);
    await waitForEvent(alicePhone, 'ready');

    // Typing indicator goes to other users.
    const typing = waitForEvent<{ userId: string; channelId: string }>(bobSocket, 'typing.started');
    aliceDesktop.emit('typing.start', { channelId: general });
    expect(await typing).toMatchObject({ userId: alice.user.id, channelId: general });

    // A REST send is broadcast as message.created.
    const created = waitForEvent<{ id: string; content: string }>(bobSocket, 'message.created');
    const res = await env.app.inject({
      method: 'POST',
      url: `/api/v1/channels/${general}/messages`,
      headers: bearer(alice.accessToken),
      payload: { content: 'realtime hello' },
    });
    expect(res.statusCode).toBe(201);
    const event = await created;
    expect(event.content).toBe('realtime hello');

    const updated = waitForEvent<{ id: string; content: string }>(bobSocket, 'message.updated');
    await env.app.inject({
      method: 'PATCH',
      url: `/api/v1/messages/${event.id}`,
      headers: bearer(alice.accessToken),
      payload: { content: 'edited hello' },
    });
    expect((await updated).content).toBe('edited hello');

    const deleted = waitForEvent<{ id: string }>(bobSocket, 'message.deleted');
    await env.app.inject({ method: 'DELETE', url: `/api/v1/messages/${event.id}`, headers: bearer(alice.accessToken) });
    expect((await deleted).id).toBe(event.id);

    // Desktop disconnects: Alice must stay online because the phone is still connected.
    let sawOffline = false;
    const onPresence = (p: PresenceEvent) => {
      if (p.userId === alice.user.id && p.status === 'offline') sawOffline = true;
    };
    bobSocket.on('presence.updated', onPresence);
    aliceDesktop.close();
    await new Promise((r) => setTimeout(r, 300));
    expect(sawOffline).toBe(false);
    expect(env.ctx.services.presence.isOnline(alice.user.id)).toBe(true);

    // Last connection gone: offline.
    const offline = waitForEvent<PresenceEvent>(bobSocket, 'presence.updated');
    alicePhone.close();
    expect(await offline).toMatchObject({ userId: alice.user.id, status: 'offline' });
    bobSocket.off('presence.updated', onPresence);

    const presence = await env.app.inject({ method: 'GET', url: '/api/v1/presence', headers: bearer(bob.accessToken) });
    const list = presence.json<{ presence: { userId: string; status: string; lastSeenAt: string | null }[] }>().presence;
    const aliceEntry = list.find((p) => p.userId === alice.user.id);
    expect(aliceEntry?.status).toBe('offline');
    expect(aliceEntry?.lastSeenAt).not.toBeNull();
    bobSocket.close();
  });

  it('disconnects the socket when its session is logged out', async () => {
    const s = await login(env, 'Bob');
    const socket = connectSocket(baseUrl, s.accessToken);
    await waitForEvent(socket, 'ready');
    const revoked = waitForEvent<{ reason: string }>(socket, 'session.revoked');
    const disconnected = waitForEvent(socket, 'disconnect');
    await env.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: bearer(s.accessToken) });
    expect((await revoked).reason).toBe('logout');
    await disconnected;
    socket.close();
  });
});
