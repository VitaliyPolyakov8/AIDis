import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, createUser, getTextChannelId, type TestEnv } from './helpers.js';

describe('concurrent read markers', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await createTestEnv(); });
  afterAll(async () => { await env.close(); });

  it('accepts simultaneous first acknowledgements without a unique constraint failure', async () => {
    const user = await createUser(env, 'first-reader');
    const channel = await env.prisma.channel.findUniqueOrThrow({ where: { id: await getTextChannelId(env) } });
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => env.ctx.services.reads.markRead(user, channel, {})));
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
  });

  it('never rolls back to an older message when devices acknowledge concurrently', async () => {
    const user = await createUser(env, 'returning-reader');
    const author = await createUser(env, 'read-author');
    const channel = await env.prisma.channel.findUniqueOrThrow({ where: { id: await getTextChannelId(env) } });
    const before = new Date();
    const first = await env.prisma.message.create({ data: { channelId: channel.id, authorId: author.id, content: 'older', createdAt: new Date(before.getTime() + 1000) } });
    const second = await env.prisma.message.create({ data: { channelId: channel.id, authorId: author.id, content: 'newer', createdAt: new Date(before.getTime() + 2000) } });
    await env.prisma.channelRead.create({ data: { userId: user.id, channelId: channel.id, lastReadAt: before, notifyMode: 'MENTIONS' } });
    await Promise.all([
      env.ctx.services.reads.markRead(user, channel, { messageId: second.id }),
      env.ctx.services.reads.markRead(user, channel, { messageId: first.id }),
    ]);
    const [read] = await env.ctx.services.reads.states(user, [channel]);
    expect(read).toMatchObject({ lastReadAt: second.createdAt.toISOString(), unread: 0, notifyMode: 'MENTIONS' });
  });

  it('does not turn a missing explicit message into a mark-all request', async () => {
    const user = await createUser(env, 'missing-target');
    const channel = await env.prisma.channel.findUniqueOrThrow({ where: { id: await getTextChannelId(env) } });
    await expect(env.ctx.services.reads.markRead(user, channel, { messageId: '00000000-0000-4000-8000-000000000000' })).rejects.toMatchObject({ statusCode: 404 });
    expect(await env.prisma.channelRead.findUnique({ where: { userId_channelId: { userId: user.id, channelId: channel.id } } })).toBeNull();
  });
});
