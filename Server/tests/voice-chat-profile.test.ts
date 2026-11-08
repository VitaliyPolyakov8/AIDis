import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bearer,
  connectSocket,
  createTestEnv,
  createUser,
  getVoiceChannelId,
  listen,
  login,
  waitForEvent,
  type LoginResult,
  type TestEnv,
} from './helpers.js';

interface MessageBody {
  id: string;
  channelId: string;
  content: string;
  author: { id: string; username: string };
}

describe('voice channel chat and profile updates', () => {
  let env: TestEnv;
  let baseUrl: string;
  let alice: LoginResult;
  let bob: LoginResult;
  let voice: string;

  beforeAll(async () => {
    env = await createTestEnv();
    await createUser(env, 'Alice');
    await createUser(env, 'Bob');
    alice = await login(env, 'Alice');
    bob = await login(env, 'Bob');
    voice = await getVoiceChannelId(env);
    baseUrl = await listen(env);
  });

  afterAll(async () => {
    await env.close();
  });

  it('stores and serves messages of a voice channel like a text channel, in realtime', async () => {
    const bobSocket = connectSocket(baseUrl, bob.accessToken);
    await waitForEvent(bobSocket, 'ready');
    const received = waitForEvent<MessageBody>(bobSocket, 'message.created');
    const res = await env.app.inject({
      method: 'POST',
      url: `/api/v1/channels/${voice}/messages`,
      headers: bearer(alice.accessToken),
      payload: { content: 'hello from the voice chat' },
    });
    expect(res.statusCode).toBe(201);
    const pushed = await received;
    expect(pushed).toMatchObject({ channelId: voice, content: 'hello from the voice chat' });
    bobSocket.close();

    // Persisted in PostgreSQL: a fresh history request (any user, in voice or not) returns it.
    const history = await env.app.inject({ method: 'GET', url: `/api/v1/channels/${voice}/messages`, headers: bearer(bob.accessToken) });
    expect(history.statusCode).toBe(200);
    expect(history.json<{ messages: MessageBody[] }>().messages.map((m) => m.content)).toContain('hello from the voice chat');
    expect(await env.prisma.message.count({ where: { channelId: voice } })).toBe(1);
  });

  it('allows typing indicators in a voice channel chat', async () => {
    const aliceSocket = connectSocket(baseUrl, alice.accessToken);
    const bobSocket = connectSocket(baseUrl, bob.accessToken);
    await Promise.all([waitForEvent(aliceSocket, 'ready'), waitForEvent(bobSocket, 'ready')]);
    const typing = waitForEvent<{ channelId: string }>(bobSocket, 'typing.started');
    aliceSocket.emit('typing.start', { channelId: voice });
    expect((await typing).channelId).toBe(voice);
    aliceSocket.close();
    bobSocket.close();
  });

  it('broadcasts user.updated with the public profile when a user changes it', async () => {
    const bobSocket = connectSocket(baseUrl, bob.accessToken);
    await waitForEvent(bobSocket, 'ready');
    const updated = waitForEvent<Record<string, unknown>>(bobSocket, 'user.updated');
    const res = await env.app.inject({ method: 'PATCH', url: '/api/v1/users/me', headers: bearer(alice.accessToken), payload: { displayName: 'Alice Two' } });
    expect(res.statusCode).toBe(200);
    const payload = await updated;
    expect(payload).toMatchObject({ id: alice.user.id, displayName: 'Alice Two', avatarAttachmentId: null });
    expect(payload).not.toHaveProperty('passwordHash');
    expect(payload).not.toHaveProperty('disabled');
    bobSocket.close();
  });
});
