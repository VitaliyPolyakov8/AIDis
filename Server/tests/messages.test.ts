import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { bearer, createTestEnv, createUser, getTextChannelId, login, type LoginResult, type TestEnv } from './helpers.js';

interface MessageBody {
  id: string;
  content: string;
  channelId: string;
  edited: boolean;
  author: { id: string; username: string };
}

describe('channels and messages', () => {
  let env: TestEnv;
  let admin: LoginResult;
  let alice: LoginResult;
  let bob: LoginResult;
  let general: string;

  const send = (session: LoginResult, content: string, extra: Record<string, unknown> = {}, channelId = general) =>
    env.app.inject({
      method: 'POST',
      url: `/api/v1/channels/${channelId}/messages`,
      headers: bearer(session.accessToken),
      payload: { content, ...extra },
    });

  beforeAll(async () => {
    env = await createTestEnv();
    await createUser(env, 'Admin', 'ADMIN');
    await createUser(env, 'Alice');
    await createUser(env, 'Bob');
    admin = await login(env, 'Admin');
    alice = await login(env, 'Alice');
    bob = await login(env, 'Bob');
    general = await getTextChannelId(env, 'general');
  });

  afterAll(async () => {
    await env.close();
  });

  it('lists the channels of the server, in categories', async () => {
    const res = await env.app.inject({ method: 'GET', url: `/api/v1/guilds/${env.guildId}/channels`, headers: bearer(alice.accessToken) });
    expect(res.statusCode).toBe(200);
    const channels = res.json<{ channels: { name: string; type: string; parentId: string | null }[] }>().channels;
    expect(channels.filter((c) => c.type === 'TEXT').map((c) => c.name)).toEqual(['general', 'games', 'random']);
    expect(channels.filter((c) => c.type === 'VOICE').map((c) => c.name)).toEqual(['General', 'Gaming', 'AFK']);
    expect(channels.filter((c) => c.type === 'CATEGORY')).toHaveLength(2);
    expect(channels.filter((c) => c.type !== 'CATEGORY').every((c) => c.parentId !== null)).toBe(true);
  });

  it('sends a message and stores it as plain text', async () => {
    const res = await send(alice, '  <b>hello</b>\r\nworld  ');
    expect(res.statusCode).toBe(201);
    const { message } = res.json<{ message: MessageBody }>();
    expect(message.content).toBe('<b>hello</b>\nworld');
    expect(message.author.username).toBe('Alice');
    expect(message.edited).toBe(false);
  });

  it('rejects empty, oversized and invalid messages', async () => {
    expect((await send(alice, '   ')).statusCode).toBe(400);
    expect((await send(alice, 'x'.repeat(env.config.maxMessageLength + 1))).statusCode).toBe(400);
    expect((await send(alice, 'hi', {}, '00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
  });

  it('deduplicates retries that reuse the same nonce', async () => {
    const first = await send(bob, 'retry me', { nonce: 'client-123' });
    const second = await send(bob, 'retry me', { nonce: 'client-123' });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json<{ message: MessageBody }>().message.id).toBe(first.json<{ message: MessageBody }>().message.id);
  });

  it('paginates history with cursors, oldest first within a page', async () => {
    const random = await getTextChannelId(env, 'random');
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await send(alice, `msg ${i}`, {}, random);
      ids.push(res.json<{ message: MessageBody }>().message.id);
    }
    const page1 = await env.app.inject({
      method: 'GET',
      url: `/api/v1/channels/${random}/messages?limit=3`,
      headers: bearer(bob.accessToken),
    });
    expect(page1.statusCode).toBe(200);
    const body1 = page1.json<{ messages: MessageBody[]; hasMore: boolean }>();
    expect(body1.messages.map((m) => m.content)).toEqual(['msg 4', 'msg 5', 'msg 6']);
    expect(body1.hasMore).toBe(true);

    const oldest = body1.messages[0]?.id ?? '';
    const page2 = await env.app.inject({
      method: 'GET',
      url: `/api/v1/channels/${random}/messages?limit=3&before=${oldest}`,
      headers: bearer(bob.accessToken),
    });
    expect(page2.json<{ messages: MessageBody[] }>().messages.map((m) => m.content)).toEqual(['msg 1', 'msg 2', 'msg 3']);

    const catchUp = await env.app.inject({
      method: 'GET',
      url: `/api/v1/channels/${random}/messages?after=${ids[4] ?? ''}`,
      headers: bearer(bob.accessToken),
    });
    const body3 = catchUp.json<{ messages: MessageBody[]; hasMore: boolean }>();
    expect(body3.messages.map((m) => m.content)).toEqual(['msg 5', 'msg 6']);
    expect(body3.hasMore).toBe(false);

    const tooBig = await env.app.inject({
      method: 'GET',
      url: `/api/v1/channels/${random}/messages?limit=1000`,
      headers: bearer(bob.accessToken),
    });
    expect(tooBig.statusCode).toBe(400);
  });

  it('lets authors edit their own messages', async () => {
    const id = (await send(alice, 'typo')).json<{ message: MessageBody }>().message.id;
    const res = await env.app.inject({
      method: 'PATCH',
      url: `/api/v1/messages/${id}`,
      headers: bearer(alice.accessToken),
      payload: { content: 'fixed' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ message: MessageBody }>().message).toMatchObject({ content: 'fixed', edited: true });
  });

  it("does not let a user edit or delete another user's message", async () => {
    const id = (await send(alice, 'mine')).json<{ message: MessageBody }>().message.id;
    const edit = await env.app.inject({
      method: 'PATCH',
      url: `/api/v1/messages/${id}`,
      headers: bearer(bob.accessToken),
      payload: { content: 'hacked' },
    });
    expect(edit.statusCode).toBe(403);
    const del = await env.app.inject({ method: 'DELETE', url: `/api/v1/messages/${id}`, headers: bearer(bob.accessToken) });
    expect(del.statusCode).toBe(403);
    // ADMIN may delete but not edit someone else's message.
    const adminEdit = await env.app.inject({
      method: 'PATCH',
      url: `/api/v1/messages/${id}`,
      headers: bearer(admin.accessToken),
      payload: { content: 'admin edit' },
    });
    expect(adminEdit.statusCode).toBe(403);
  });

  it('lets authors delete their own messages (hidden from history)', async () => {
    const games = await getTextChannelId(env, 'games');
    const id = (await send(bob, 'delete me', {}, games)).json<{ message: MessageBody }>().message.id;
    const del = await env.app.inject({ method: 'DELETE', url: `/api/v1/messages/${id}`, headers: bearer(bob.accessToken) });
    expect(del.statusCode).toBe(204);
    const history = await env.app.inject({
      method: 'GET',
      url: `/api/v1/channels/${games}/messages`,
      headers: bearer(bob.accessToken),
    });
    expect(history.json<{ messages: MessageBody[] }>().messages.some((m) => m.id === id)).toBe(false);
    const again = await env.app.inject({ method: 'DELETE', url: `/api/v1/messages/${id}`, headers: bearer(bob.accessToken) });
    expect(again.statusCode).toBe(404);
    const row = await env.prisma.message.findUniqueOrThrow({ where: { id } });
    expect(row.deletedAt).not.toBeNull();
    expect(row.content).toBe('');
  });

  it("lets an ADMIN delete another user's message", async () => {
    const id = (await send(alice, 'moderate me')).json<{ message: MessageBody }>().message.id;
    const del = await env.app.inject({ method: 'DELETE', url: `/api/v1/messages/${id}`, headers: bearer(admin.accessToken) });
    expect(del.statusCode).toBe(204);
  });

  it('supports replies to a message in the same channel', async () => {
    const parent = (await send(alice, 'question?')).json<{ message: MessageBody }>().message.id;
    const reply = await send(bob, 'answer', { replyToId: parent });
    expect(reply.statusCode).toBe(201);
    expect(reply.json<{ message: { replyToId: string } }>().message.replyToId).toBe(parent);
  });

  it('serves stored history from a freshly started app instance (restart / client reload)', async () => {
    const fresh = await buildApp({ config: env.config, prisma: env.prisma, logger: false });
    try {
      const res = await fresh.app.inject({
        method: 'GET',
        url: `/api/v1/channels/${general}/messages`,
        headers: bearer(alice.accessToken),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ messages: MessageBody[] }>().messages.some((m) => m.content === 'answer')).toBe(true);
    } finally {
      await fresh.app.close();
    }
  });
});
