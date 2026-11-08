import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { jwtVerify } from 'jose';
import { bearer, createTestEnv, createUser, getTextChannelId, getVoiceChannelId, login, LIVEKIT_TEST_SECRET, type LoginResult, type TestEnv } from './helpers.js';

function multipartBody(filename: string, contentType: string, content: Buffer) {
  const boundary = '----aidisTestBoundary';
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, content, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}

describe('voice, attachments, health and client version', () => {
  let env: TestEnv;
  let alice: LoginResult;
  let bob: LoginResult;

  beforeAll(async () => {
    env = await createTestEnv();
    await createUser(env, 'Alice');
    await createUser(env, 'Bob');
    alice = await login(env, 'Alice');
    bob = await login(env, 'Bob');
  });

  afterAll(async () => {
    await env.close();
  });

  describe('voice', () => {
    it('issues a short-lived LiveKit token without leaking the API secret', async () => {
      const channelId = await getVoiceChannelId(env, 'Gaming');
      const res = await env.app.inject({
        method: 'POST',
        url: '/api/v1/voice/token',
        headers: bearer(alice.accessToken),
        payload: { channelId },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(LIVEKIT_TEST_SECRET);
      const body = res.json<{ url: string; token: string; roomName: string; identity: string }>();
      expect(body.url).toBe('wss://rtc.aidis.test');
      expect(body.roomName).toBe(`voice-${channelId}`);
      expect(body.identity).toBe(alice.user.id);

      const { payload } = await jwtVerify(body.token, new TextEncoder().encode(LIVEKIT_TEST_SECRET));
      expect(payload.iss).toBe('test-key');
      expect(payload.sub).toBe(alice.user.id);
      const video = payload.video as { room: string; roomJoin: boolean; canPublishSources: string[] };
      expect(video.room).toBe(`voice-${channelId}`);
      expect(video.roomJoin).toBe(true);
      expect(video.canPublishSources).toContain('screen_share');
      const ttl = (payload.exp ?? 0) - (payload.nbf ?? payload.iat ?? 0);
      expect(ttl).toBeLessThanOrEqual(env.config.livekit.tokenTtlSeconds);
    });

    it('rejects text channels, unknown channels and anonymous requests', async () => {
      const text = await getTextChannelId(env);
      const asText = await env.app.inject({
        method: 'POST',
        url: '/api/v1/voice/token',
        headers: bearer(alice.accessToken),
        payload: { channelId: text },
      });
      expect(asText.statusCode).toBe(404);
      const anon = await env.app.inject({ method: 'POST', url: '/api/v1/voice/token', payload: { channelId: text } });
      expect(anon.statusCode).toBe(401);
    });

    it('lists voice channels of the server', async () => {
      const res = await env.app.inject({ method: 'GET', url: `/api/v1/guilds/${env.guildId}/channels`, headers: bearer(bob.accessToken) });
      expect(
        res
          .json<{ channels: { name: string; type: string }[] }>()
          .channels.filter((c) => c.type === 'VOICE')
          .map((c) => c.name),
      ).toEqual(['General', 'Gaming', 'AFK']);
    });
  });

  describe('attachments', () => {
    it('uploads, attaches to a message and downloads a file without trusting its name', async () => {
      const { payload, contentType } = multipartBody('../../etc/passwd.png', 'image/png', Buffer.from('fake png bytes'));
      const up = await env.app.inject({
        method: 'POST',
        url: '/api/v1/attachments',
        headers: { ...bearer(alice.accessToken), 'content-type': contentType },
        payload,
      });
      expect(up.statusCode).toBe(201);
      const attachment = up.json<{ attachment: { id: string; originalName: string; size: number; url: string } }>().attachment;
      expect(attachment.originalName).toBe('passwd.png');
      expect(attachment.size).toBe(14);
      const row = await env.prisma.attachment.findUniqueOrThrow({ where: { id: attachment.id } });
      expect(row.storedName).toMatch(/^[0-9a-f-]{36}$/);

      const general = await getTextChannelId(env);
      // Bob cannot attach Alice's upload.
      const steal = await env.app.inject({
        method: 'POST',
        url: `/api/v1/channels/${general}/messages`,
        headers: bearer(bob.accessToken),
        payload: { content: 'mine now', attachmentIds: [attachment.id] },
      });
      expect(steal.statusCode).toBe(400);

      const msg = await env.app.inject({
        method: 'POST',
        url: `/api/v1/channels/${general}/messages`,
        headers: bearer(alice.accessToken),
        payload: { content: '', attachmentIds: [attachment.id] },
      });
      expect(msg.statusCode).toBe(201);
      expect(msg.json<{ message: { attachments: { id: string }[] } }>().message.attachments[0]?.id).toBe(attachment.id);

      const download = await env.app.inject({ method: 'GET', url: attachment.url, headers: bearer(bob.accessToken) });
      expect(download.statusCode).toBe(200);
      expect(download.body).toBe('fake png bytes');
      expect(download.headers['x-content-type-options']).toBe('nosniff');
      expect(download.headers['content-disposition']).toContain('inline');

      const anon = await env.app.inject({ method: 'GET', url: attachment.url });
      expect(anon.statusCode).toBe(401);
    });

    it('forces risky types (HTML/SVG) to download instead of rendering inline', async () => {
      const { payload, contentType } = multipartBody('x.svg', 'image/svg+xml', Buffer.from('<svg onload="alert(1)"/>'));
      const up = await env.app.inject({
        method: 'POST',
        url: '/api/v1/attachments',
        headers: { ...bearer(alice.accessToken), 'content-type': contentType },
        payload,
      });
      const { url } = up.json<{ attachment: { url: string } }>().attachment;
      const download = await env.app.inject({ method: 'GET', url, headers: bearer(alice.accessToken) });
      expect(download.headers['content-type']).toBe('application/octet-stream');
      expect(download.headers['content-disposition']).toMatch(/^attachment;/);
    });

    it('rejects files larger than MAX_UPLOAD_SIZE', async () => {
      const { payload, contentType } = multipartBody('big.bin', 'application/octet-stream', Buffer.alloc(env.config.maxUploadSize + 10));
      const up = await env.app.inject({
        method: 'POST',
        url: '/api/v1/attachments',
        headers: { ...bearer(alice.accessToken), 'content-type': contentType },
        payload,
      });
      expect(up.statusCode).toBe(413);
      expect(up.json()).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
    });

    it('refuses stored names that could escape the upload directory', () => {
      const storage = env.ctx.services.attachments.storage;
      for (const name of ['../secret', '..\\secret', '/etc/passwd', 'a/b', '']) {
        expect(() => storage.resolve(name)).toThrow();
      }
    });
  });

  describe('health and metadata', () => {
    it('reports liveness and readiness without leaking details', async () => {
      const health = await env.app.inject({ method: 'GET', url: '/health' });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({ status: 'ok' });
      const ready = await env.app.inject({ method: 'GET', url: '/ready' });
      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toEqual({ status: 'ready', checks: { database: 'ok' } });
    });

    it('serves desktop client version metadata', async () => {
      const res = await env.app.inject({ method: 'GET', url: '/api/v1/client/version' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ latestVersion: '0.1.0', minimumVersion: '0.1.0', mandatory: false });
    });

    it('returns consistent JSON errors for unknown routes and bad JSON', async () => {
      const missing = await env.app.inject({ method: 'GET', url: '/api/v1/nope' });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
      const badJson = await env.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: '{not json',
      });
      expect(badJson.statusCode).toBe(400);
      expect(badJson.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } });
    });

    it('sets security headers and only allows configured CORS origins', async () => {
      const allowed = await env.app.inject({
        method: 'GET',
        url: '/health',
        headers: { origin: 'http://localhost:5173' },
      });
      expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
      expect(allowed.headers['x-content-type-options']).toBe('nosniff');
      const denied = await env.app.inject({ method: 'GET', url: '/health', headers: { origin: 'https://evil.example' } });
      expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    });
  });
});
