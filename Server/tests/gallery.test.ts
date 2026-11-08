import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createPrivateChannel, createTestEnv, createUser, getTextChannelId, getVoiceChannelId, login, type LoginResult, type TestEnv } from './helpers.js';

interface Page {
  items: { id: string; messageId: string; attachment?: { originalName: string; url: string }; links?: string[] }[];
  nextCursor: string | null;
}

describe('channel gallery', () => {
  let env: TestEnv;
  let alice: LoginResult;
  let bob: LoginResult;
  let admin: LoginResult;
  let channelId: string;
  const page = (channel: string, category: string, extra = '', session = alice) =>
    env.app.inject({ method: 'GET', url: `/api/v1/channels/${channel}/gallery?category=${category}${extra}`, headers: bearer(session.accessToken) });
  const message = (channel: string, content = '', deleted = false) => env.prisma.message.create({ data: { channelId: channel, authorId: alice.user.id, content, ...(deleted ? { deletedAt: new Date() } : {}) } });
  const file = (messageId: string | null, mimeType: string, name: string, createdAt = new Date()) =>
    env.prisma.attachment.create({ data: { messageId, uploaderId: alice.user.id, mimeType, originalName: name, storedName: randomUUID(), size: 10n, sha256: 'a'.repeat(64), createdAt } });

  beforeAll(async () => {
    env = await createTestEnv();
    await createUser(env, 'Alice');
    await createUser(env, 'Bob');
    await createUser(env, 'Admin', 'ADMIN');
    alice = await login(env, 'Alice');
    bob = await login(env, 'Bob');
    admin = await login(env, 'Admin');
    channelId = await getTextChannelId(env);
  });
  afterAll(async () => {
    await env.close();
  });

  it('requires authentication and preserves private channel and DM membership guards', async () => {
    const privateChannel = await createPrivateChannel(env, 'private-gallery', { userIds: [alice.user.id] });
    const dm = await env.prisma.channel.create({ data: { name: randomUUID(), type: 'DM', members: { create: [{ userId: alice.user.id }, { userId: bob.user.id }] } } });
    expect((await env.app.inject({ method: 'GET', url: `/api/v1/channels/${channelId}/gallery?category=images` })).statusCode).toBe(401);
    expect((await page(privateChannel.id, 'images', '', bob)).statusCode).toBe(404);
    expect((await page(privateChannel.id, 'images')).statusCode).toBe(200);
    expect((await page(dm.id, 'links', '', admin)).statusCode).toBe(404);
    const m = await message(dm.id, 'https://example.com/dm');
    expect((await page(dm.id, 'links')).json<Page>().items[0]?.messageId).toBe(m.id);
    const voice = await getVoiceChannelId(env);
    await file((await message(voice)).id, 'image/png', 'voice.png');
    expect((await page(voice, 'images')).json<Page>().items[0]?.attachment?.originalName).toBe('voice.png');
  });

  it('filters mixed files, excludes deleted/orphan/other-channel files and paginates equal timestamps without duplicates', async () => {
    const m = await message(channelId);
    const at = new Date('2026-10-01T12:00:00Z');
    const images = await Promise.all(['one.png', 'two.jpg', 'three.gif'].map((name) => file(m.id, 'image/png', name, at)));
    await file(m.id, 'video/mp4', 'movie.mp4');
    await file(m.id, 'application/pdf', 'notes.pdf');
    await file(m.id, 'audio/ogg', 'sound.ogg');
    await file((await message(channelId, '', true)).id, 'image/png', 'deleted.png');
    await file(null, 'image/png', 'orphan.png');
    await file((await message(await getTextChannelId(env, 'games'))).id, 'image/png', 'elsewhere.png');
    const first = (await page(channelId, 'images', '&limit=2')).json<Page>();
    expect(first.items.map((i) => i.id)).toEqual(
      images
        .map((i) => i.id)
        .sort()
        .reverse()
        .slice(0, 2),
    );
    expect(first.items.every((i) => i.attachment?.url.startsWith('/api/v1/attachments/'))).toBe(true);
    expect(first.nextCursor).toBeTruthy();
    // The anchor can disappear while browsing; the cursor still advances by its immutable tuple.
    const anchorId = first.items[1]?.id;
    if (!anchorId) throw new Error('Expected a full first gallery page');
    await env.prisma.attachment.delete({ where: { id: anchorId } });
    const second = (await page(channelId, 'images', `&limit=2&cursor=${first.nextCursor}`)).json<Page>();
    expect(second.items.map((i) => i.id)).toEqual(
      images
        .map((i) => i.id)
        .sort()
        .reverse()
        .slice(2),
    );
    expect(second.nextCursor).toBeNull();
    expect((await page(channelId, 'videos')).json<Page>().items.map((i) => i.attachment?.originalName)).toEqual(['movie.mp4']);
    expect(
      (await page(channelId, 'documents'))
        .json<Page>()
        .items.map((i) => i.attachment?.originalName)
        .sort(),
    ).toEqual(['notes.pdf', 'sound.ogg']);
    expect((await page(channelId, 'videos', `&cursor=${first.nextCursor}`)).statusCode).toBe(400);
    expect((await page(await getTextChannelId(env, 'games'), 'images', `&cursor=${first.nextCursor}`)).statusCode).toBe(400);
  });

  it('finds deduplicated safe text links independently of preview generation and advances sparse pages', async () => {
    const linksChannel = await getTextChannelId(env, 'random');
    const valid = await message(linksChannel, 'Read https://example.com/a, https://example.com/a and HTTP://example.org/b. javascript:alert(1)');
    await message(linksChannel, 'http:// malformed');
    await message(linksChannel, 'https://deleted.example', true);
    const first = (await page(linksChannel, 'links', '&limit=1')).json<Page>();
    expect(first.items).toEqual([]);
    expect(first.nextCursor).toBeTruthy();
    const second = (await page(linksChannel, 'links', `&limit=1&cursor=${first.nextCursor}`)).json<Page>();
    expect(second.items).toMatchObject([{ messageId: valid.id, links: ['https://example.com/a', 'http://example.org/b'] }]);
    expect(second.nextCursor).toBeNull();
  });

  it('rejects unbounded requests, unknown categories and malformed cursors', async () => {
    expect((await page(channelId, 'images', '&limit=101')).statusCode).toBe(400);
    expect((await page(channelId, 'all')).statusCode).toBe(400);
    expect((await page(channelId, 'links', '&cursor=garbage')).statusCode).toBe(400);
  });
});
