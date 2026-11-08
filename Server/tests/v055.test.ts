import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestEnv, createUser, getTextChannelId, getVoiceChannelId, login, type LoginResult, type TestEnv } from './helpers.js';
import { parseRange } from '../src/attachments/storage.js';
import { CHUNK_SIZE } from '../src/attachments/chunked.js';
import { isPreviewImage } from '../src/voice/voice.routes.js';
import type { VoiceSessionTracker } from '../src/voice/voice-sessions.js';

type Status = { uploadId: string; size: number; received: number; chunkSize: number };
type AttachmentBody = { attachment: { id: string; size: number; originalName: string } };

describe('0.5.5 server', () => {
  let env: TestEnv;
  let admin: LoginResult;
  let bob: LoginResult;
  beforeAll(async () => {
    env = await createTestEnv();
    await createUser(env, 'admin', 'ADMIN');
    await createUser(env, 'bob');
    admin = await login(env, 'admin');
    bob = await login(env, 'bob');
  });
  afterAll(async () => {
    await env.close();
  });

  describe('profile theme, name style, birthday', () => {
    it('stores and returns the new fields, and validates them', async () => {
      const patch = (payload: Record<string, unknown>) => env.app.inject({ method: 'PATCH', url: '/api/v1/users/me', headers: bearer(bob.accessToken), payload });
      const ok = await patch({ accentColor: '#112233', accentColor2: '#AABBCC', nicknameColor: '#ff8800', nicknameColor2: '#33ccff', nicknameGlow: true, nicknameFont: 'lobster', birthday: { month: 2, day: 29 }, showRecentGames: false });
      expect(ok.statusCode).toBe(200);
      expect(ok.json<{ user: Record<string, unknown> }>().user).toMatchObject({ accentColor2: '#aabbcc', nicknameColor2: '#33ccff', nicknameGlow: true, nicknameFont: 'lobster', birthday: { month: 2, day: 29 }, showRecentGames: false });
      expect((await patch({ birthday: { month: 2, day: 30 } })).statusCode).toBe(400);
      expect((await patch({ nicknameFont: 'comic-sans' })).statusCode).toBe(400);
      expect((await patch({ nicknameColor2: '#000000' })).statusCode).toBe(400);
      const cleared = await patch({ birthday: null, nicknameFont: null });
      expect(cleared.json<{ user: Record<string, unknown> }>().user).toMatchObject({ birthday: null, nicknameFont: null, nicknameGlow: true });
    });
  });

  describe('voice channel settings', () => {
    it('lets channel managers set the bitrate and the room layout of voice channels', async () => {
      const voice = await getVoiceChannelId(env);
      const res = await env.app.inject({ method: 'PATCH', url: `/api/v1/channels/${voice}`, headers: bearer(admin.accessToken), payload: { voiceBitrate: 128, voiceLayout: 'room' } });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ channel: Record<string, unknown> }>().channel).toMatchObject({ voiceBitrate: 128, voiceLayout: 'room' });
      expect((await env.app.inject({ method: 'PATCH', url: `/api/v1/channels/${voice}`, headers: bearer(admin.accessToken), payload: { voiceBitrate: 512 } })).statusCode).toBe(400);
      expect((await env.app.inject({ method: 'PATCH', url: `/api/v1/channels/${voice}`, headers: bearer(bob.accessToken), payload: { voiceBitrate: 32 } })).statusCode).toBe(403);
      const text = await getTextChannelId(env);
      const textView = await env.app.inject({ method: 'GET', url: `/api/v1/channels/${text}`, headers: bearer(bob.accessToken) });
      expect(textView.json<{ channel: Record<string, unknown> }>().channel.voiceBitrate).toBeUndefined();
    });
  });

  describe('recently played', () => {
    it('records game sessions from presence and hides the shelf when the owner wants', async () => {
      const presence = env.ctx.services.presence;
      const bobId = bob.user.id;
      await presence.connect(bobId, 'sock-1', 'desktop');
      const startedAt = new Date(Date.now() - 2 * 3600_000).toISOString();
      const tick = () => new Promise((r) => setTimeout(r, 30));
      presence.setActivity(bobId, 'sock-1', { type: 'playing', name: 'Deep Rock Galactic', steamAppId: 548430, startedAt } as never);
      await tick();
      presence.setActivity(bobId, 'sock-1', { type: 'playing', name: 'Portal 2', steamAppId: 620 } as never);
      await tick();
      await presence.disconnect(bobId, 'sock-1');
      // Writes are fire-and-forget: give them a moment.
      await new Promise((r) => setTimeout(r, 200));
      const own = await env.app.inject({ method: 'GET', url: `/api/v1/users/${bobId}/games`, headers: bearer(bob.accessToken) });
      const shelf = own.json<{ games: { name: string; totalSeconds: number; steamAppId: number | null }[]; hidden: boolean }>();
      expect(shelf.games.map((g) => g.name)).toEqual(['Portal 2', 'Deep Rock Galactic']);
      expect(shelf.games[1]?.totalSeconds).toBeGreaterThan(7000);
      expect(shelf.games[1]?.steamAppId).toBe(548430);
      // Bob hid the shelf in the profile test above: others see nothing.
      const other = await env.app.inject({ method: 'GET', url: `/api/v1/users/${bobId}/games`, headers: bearer(admin.accessToken) });
      expect(other.json()).toEqual({ games: [], hidden: true });
    });
  });

  describe('stream previews', () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, 1)]);

    it('accepts only real JPEG / WebP bytes', () => {
      expect(isPreviewImage('image/jpeg', jpeg)).toBe(true);
      expect(isPreviewImage('image/jpeg', Buffer.from('<svg>'))).toBe(false);
      expect(isPreviewImage('image/png', jpeg)).toBe(false);
    });

    it('serves the newest preview of a streamer to people who can see the channel', async () => {
      const voice = await getVoiceChannelId(env);
      const put = (token: string) => env.app.inject({ method: 'PUT', url: '/api/v1/voice/stream-thumbnail', headers: { ...bearer(token), 'content-type': 'image/jpeg' }, payload: jpeg });
      // Not in a voice channel: refused.
      expect((await put(bob.accessToken)).statusCode).toBe(409);
      env.ctx.services.voice.attachSessions({ channelOf: (id: string) => (id === bob.user.id ? voice : null), touch: () => undefined } as unknown as VoiceSessionTracker);
      expect((await put(bob.accessToken)).statusCode).toBe(204);
      const got = await env.app.inject({ method: 'GET', url: `/api/v1/voice/streams/${bob.user.id}/thumbnail`, headers: bearer(admin.accessToken) });
      expect(got.statusCode).toBe(200);
      expect(got.headers['content-type']).toBe('image/jpeg');
      expect(got.rawPayload.equals(jpeg)).toBe(true);
      await env.app.inject({ method: 'DELETE', url: '/api/v1/voice/stream-thumbnail', headers: bearer(bob.accessToken) });
      expect((await env.app.inject({ method: 'GET', url: `/api/v1/voice/streams/${bob.user.id}/thumbnail`, headers: bearer(admin.accessToken) })).statusCode).toBe(404);
    });
  });

  describe('large files', () => {
    it('parses Range headers', () => {
      expect(parseRange(undefined, 100)).toBeNull();
      expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
      expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
      expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
      expect(parseRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 });
      expect(() => parseRange('bytes=100-', 100)).toThrow();
      expect(parseRange('bytes=0-1,5-6', 100)).toBeNull();
    });

    it('uploads in pieces, resumes after an interruption, and streams with Range via a signed link', async () => {
      const size = CHUNK_SIZE + 1000;
      const data = Buffer.alloc(size);
      for (let i = 0; i < size; i++) data[i] = i % 251;
      const auth = bearer(bob.accessToken);
      const start = await env.app.inject({ method: 'POST', url: '/api/v1/attachments/uploads', headers: auth, payload: { filename: 'clip.mp4', mimeType: 'video/mp4', size } });
      expect(start.statusCode).toBe(201);
      const { uploadId, chunkSize } = start.json<Status>();
      expect(chunkSize).toBe(CHUNK_SIZE);
      const piece = (offset: number, body: Buffer) =>
        env.app.inject({ method: 'PUT', url: `/api/v1/attachments/uploads/${uploadId}?offset=${String(offset)}`, headers: { ...auth, 'content-type': 'application/octet-stream' }, payload: body });
      // First half of the first piece, then a wrong offset, then resume from what the server reports.
      expect((await piece(0, data.subarray(0, 1000))).json<Status>().received).toBe(1000);
      const wrong = await piece(0, data.subarray(0, 10));
      expect(wrong.statusCode).toBe(409);
      const status = await env.app.inject({ method: 'GET', url: `/api/v1/attachments/uploads/${uploadId}`, headers: auth });
      let received = status.json<Status>().received;
      expect(received).toBe(1000);
      // A piece larger than allowed is refused and cut back.
      const tooBig = await piece(received, Buffer.alloc(CHUNK_SIZE + 1));
      expect(tooBig.statusCode).toBe(413);
      for (let guard = 0; received < size && guard < 5; guard++) {
        const next = data.subarray(received, Math.min(size, received + CHUNK_SIZE));
        const res = await piece(received, next);
        expect(res.statusCode).toBe(200);
        received = res.json<Status>().received;
      }
      const done = await env.app.inject({ method: 'POST', url: `/api/v1/attachments/uploads/${uploadId}/complete`, headers: auth });
      expect(done.statusCode).toBe(201);
      const attachment = done.json<AttachmentBody>().attachment;
      expect(attachment).toMatchObject({ size, originalName: 'clip.mp4' });

      const link = await env.app.inject({ method: 'GET', url: `/api/v1/attachments/${attachment.id}/link`, headers: auth });
      const { url } = link.json<{ url: string }>();
      const partial = await env.app.inject({ method: 'GET', url, headers: { range: 'bytes=10-19' } });
      expect(partial.statusCode).toBe(206);
      expect(partial.headers['content-range']).toBe(`bytes 10-19/${String(size)}`);
      expect(partial.rawPayload.equals(data.subarray(10, 20))).toBe(true);
      // The link is bound to bob and to this attachment.
      expect((await env.app.inject({ method: 'GET', url: url.replace(/t=[^&]+/, 't=forged.1.x') })).statusCode).toBe(401);
      expect((await env.app.inject({ method: 'GET', url: url.replace(attachment.id, '00000000-0000-4000-8000-000000000000') })).statusCode).toBe(401);
      expect((await env.app.inject({ method: 'GET', url: `/api/v1/attachments/${attachment.id}/content` })).statusCode).toBe(401);
    });

    it('refuses files over the limit and lets the uploader cancel', async () => {
      const auth = bearer(bob.accessToken);
      const huge = await env.app.inject({ method: 'POST', url: '/api/v1/attachments/uploads', headers: auth, payload: { filename: 'big.bin', size: 6 * 1024 ** 3 } });
      expect(huge.statusCode).toBe(413);
      const start = await env.app.inject({ method: 'POST', url: '/api/v1/attachments/uploads', headers: auth, payload: { filename: 'x.bin', size: 10 } });
      const { uploadId } = start.json<Status>();
      expect((await env.app.inject({ method: 'GET', url: `/api/v1/attachments/uploads/${uploadId}`, headers: bearer(admin.accessToken) })).statusCode).toBe(404);
      expect((await env.app.inject({ method: 'DELETE', url: `/api/v1/attachments/uploads/${uploadId}`, headers: auth })).statusCode).toBe(204);
      expect((await env.app.inject({ method: 'GET', url: `/api/v1/attachments/uploads/${uploadId}`, headers: auth })).statusCode).toBe(404);
    });
  });
});
