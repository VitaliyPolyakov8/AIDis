import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io-client';
import { bearer, connectSocket, createTestEnv, createUser, listen, login, waitForEvent, type LoginResult, type TestEnv } from './helpers.js';
import { checkAvatar, parseImageInfo } from '../src/users/avatar-image.js';

interface Presence {
  userId: string;
  status: string;
  state: string;
  lastSeenAt: string | null;
  customStatus: { text: string; expiresAt: string | null } | null;
  activity: { type: string; name: string } | null;
}

function multipartBody(filename: string, contentType: string, content: Buffer) {
  const boundary = '----aidisTestBoundary';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  return { payload: Buffer.concat([head, content, Buffer.from(`\r\n--${boundary}--\r\n`)]), contentType: `multipart/form-data; boundary=${boundary}` };
}

// Minimal real headers (enough for the size/format/animation checks).
function png(w: number, h: number): Buffer {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
function gif(w: number, h: number, frames: number): Buffer {
  const parts = [Buffer.from('GIF89a', 'latin1'), Buffer.from([w & 255, w >> 8, h & 255, h >> 8, 0, 0, 0])];
  for (let i = 0; i < frames; i += 1) parts.push(Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0]));
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}
function webpAnimated(w: number, h: number): Buffer {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'latin1');
  b.write('WEBP', 8, 'latin1');
  b.write('VP8X', 12, 'latin1');
  b[20] = 0x02; // animation flag
  b.writeUIntLE(w - 1, 24, 3);
  b.writeUIntLE(h - 1, 27, 3);
  return b;
}

describe('avatar image checks', () => {
  it('reads real format, size and animation from the bytes', () => {
    expect(parseImageInfo(png(256, 256))).toEqual({ format: 'png', width: 256, height: 256, animated: false });
    expect(parseImageInfo(gif(128, 128, 1))).toMatchObject({ format: 'gif', animated: false });
    expect(parseImageInfo(gif(128, 128, 3))).toMatchObject({ format: 'gif', width: 128, animated: true });
    expect(parseImageInfo(webpAnimated(512, 400))).toEqual({ format: 'webp', width: 512, height: 400, animated: true });
    expect(parseImageInfo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
  });

  it('applies limits: format, file size and pixel size (stricter for animations)', () => {
    expect(checkAvatar(parseImageInfo(png(4096, 4096)), 1000)).toBeNull();
    expect(checkAvatar(parseImageInfo(png(5000, 100)), 1000)).toBe('dimensions');
    expect(checkAvatar(parseImageInfo(gif(1024, 1024, 2)), 1000)).toBeNull();
    expect(checkAvatar(parseImageInfo(gif(1500, 1500, 2)), 1000)).toBe('dimensions');
    expect(checkAvatar(parseImageInfo(gif(256, 256, 2)), 9 * 1024 * 1024)).toBe('size');
    expect(checkAvatar(null, 10)).toBe('format');
  });
});

describe('presence, status, activity and last seen', () => {
  let env: TestEnv;
  let baseUrl: string;
  let alice: LoginResult;
  let bob: LoginResult;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    env = await createTestEnv();
    await createUser(env, 'Alice');
    await createUser(env, 'Bob');
    alice = await login(env, 'Alice');
    bob = await login(env, 'Bob');
    baseUrl = await listen(env);
  });

  afterAll(async () => {
    for (const s of sockets) s.close();
    await env.close();
  });

  /** Next presence event for Alice that matches (earlier connection events are skipped). */
  function nextAlice(socket: Socket, match: (p: Presence) => boolean, timeoutMs = 5000): Promise<Presence> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.off('presence.updated', on);
        reject(new Error('Timed out waiting for a matching presence.updated'));
      }, timeoutMs);
      const on = (p: Presence) => {
        if (p.userId !== alice.user.id || !match(p)) return;
        clearTimeout(timer);
        socket.off('presence.updated', on);
        resolve(p);
      };
      socket.on('presence.updated', on);
    });
  }

  async function connect(token: string): Promise<Socket> {
    const s = connectSocket(baseUrl, token);
    sockets.push(s);
    await waitForEvent(s, 'ready');
    return s;
  }
  const setStatus = (token: string, payload: object) =>
    env.app.inject({ method: 'PATCH', url: '/api/v1/users/me/status', headers: bearer(token), payload });

  it('broadcasts DND / away / custom status with stable values, and stores the preference', async () => {
    const bobSocket = await connect(bob.accessToken);
    await connect(alice.accessToken);

    let next = nextAlice(bobSocket, (p) => p.state === 'dnd');
    expect((await setStatus(alice.accessToken, { status: 'DND' })).json()).toEqual({ status: 'DND', customStatus: null });
    expect(await next).toMatchObject({ userId: alice.user.id, status: 'online', state: 'dnd' });

    next = nextAlice(bobSocket, (p) => p.customStatus !== null);
    await setStatus(alice.accessToken, { customStatus: { text: 'Пошёл есть', expiresAt: null } });
    expect((await next).customStatus).toEqual({ text: 'Пошёл есть', expiresAt: null, emoji: null });

    const stored = await env.prisma.user.findUniqueOrThrow({ where: { id: alice.user.id } });
    expect(stored).toMatchObject({ presenceStatus: 'DND', customStatusText: 'Пошёл есть' });
    const own = await env.app.inject({ method: 'GET', url: '/api/v1/users/me/status', headers: bearer(alice.accessToken) });
    expect(own.json()).toEqual({ status: 'DND', customStatus: { text: 'Пошёл есть', expiresAt: null, emoji: null } });

    next = nextAlice(bobSocket, (p) => p.state === 'online');
    await setStatus(alice.accessToken, { status: 'ONLINE', customStatus: null });
    expect(await next).toMatchObject({ state: 'online', customStatus: null });

    expect((await setStatus(alice.accessToken, { status: 'BUSY' })).statusCode).toBe(400);
    expect((await setStatus(alice.accessToken, { customStatus: { text: 'x'.repeat(200), expiresAt: null } })).statusCode).toBe(400);
  });

  it('automatic away from idle, but never over Do Not Disturb', async () => {
    const bobSocket = await connect(bob.accessToken);
    const aliceSocket = await connect(alice.accessToken);
    await new Promise((r) => setTimeout(r, 100));
    let next = nextAlice(bobSocket, (p) => p.state === 'away');
    // Every one of Alice's connections must be idle (earlier tests left one open too).
    for (const x of sockets) x.emit('presence.idle', { idle: true });
    expect((await next).state).toBe('away');
    next = nextAlice(bobSocket, (p) => p.state === 'online');
    aliceSocket.emit('presence.idle', { idle: false });
    expect((await next).state).toBe('online');

    await setStatus(alice.accessToken, { status: 'DND' });
    aliceSocket.emit('presence.idle', { idle: true });
    await new Promise((r) => setTimeout(r, 150));
    const snap = await env.app.inject({ method: 'GET', url: '/api/v1/presence', headers: bearer(bob.accessToken) });
    expect(snap.json<{ presence: Presence[] }>().presence.find((p) => p.userId === alice.user.id)?.state).toBe('dnd');
    await setStatus(alice.accessToken, { status: 'ONLINE' });
    aliceSocket.emit('presence.idle', { idle: false });
  });

  it('publishes only a validated activity name, clears it, and hides it from offline/invisible views', async () => {
    const bobSocket = await connect(bob.accessToken);
    const aliceSocket = await connect(alice.accessToken);
    let next = nextAlice(bobSocket, (p) => p.activity !== null);
    aliceSocket.emit('activity.set', { name: 'Helldivers 2' });
    expect((await next).activity).toMatchObject({ type: 'playing', name: 'Helldivers 2' });

    // Paths / control characters are rejected outright.
    aliceSocket.emit('activity.set', { name: 'C:\\Games\\eldenring.exe' });
    next = nextAlice(bobSocket, (p) => p.activity === null);
    aliceSocket.emit('activity.set', { name: null });
    expect((await next).activity).toBeNull();

    await new Promise((r) => setTimeout(r, 1100));
    next = nextAlice(bobSocket, (p) => p.activity !== null);
    aliceSocket.emit('activity.set', { name: 'Helldivers 2' });
    await next;
    // Invisible: looks offline, no activity or custom status.
    next = nextAlice(bobSocket, (p) => p.state === 'offline');
    await setStatus(alice.accessToken, { status: 'INVISIBLE', customStatus: { text: 'secret', expiresAt: null } });
    const hidden = await next;
    expect(hidden).toMatchObject({ status: 'offline', state: 'offline', activity: null, customStatus: null });
    expect(hidden.lastSeenAt).not.toBeNull();
    const seen = hidden.lastSeenAt;
    // Activity changes while invisible are not broadcast.
    let leaked = false;
    const spy = () => {
      leaked = true;
    };
    bobSocket.on('presence.updated', spy);
    aliceSocket.emit('activity.set', { name: null });
    await new Promise((r) => setTimeout(r, 200));
    bobSocket.off('presence.updated', spy);
    expect(leaked).toBe(false);
    await env.ctx.services.presence.refreshOnlineUsers();
    const row = await env.prisma.user.findUniqueOrThrow({ where: { id: alice.user.id } });
    expect(row.lastSeenAt?.toISOString()).toBe(seen); // not advanced while invisible
    await setStatus(alice.accessToken, { status: 'ONLINE', customStatus: null });
  });

  it('expires a custom status by itself', async () => {
    const bobSocket = await connect(bob.accessToken);
    await connect(alice.accessToken);
    await setStatus(alice.accessToken, { customStatus: { text: 'Работаю', expiresAt: new Date(Date.now() + 60_000).toISOString() } });
    const next = nextAlice(bobSocket, (p) => p.customStatus === null);
    const changes = await env.ctx.services.presence.expireCustomStatuses(new Date(Date.now() + 120_000));
    expect(changes.map((c) => c.userId)).toContain(alice.user.id);
    for (const c of changes) env.ctx.publisher.presenceUpdated(c);
    expect((await next).customStatus).toBeNull();
  });

  it('updates last seen when the last connection closes', async () => {
    for (const s of sockets.splice(0)) s.close();
    const bobSocket = await connect(bob.accessToken);
    const aliceSocket = await connect(alice.accessToken);
    await new Promise((r) => setTimeout(r, 100));
    const before = Date.now();
    const offline = nextAlice(bobSocket, (p) => p.state === 'offline');
    aliceSocket.close();
    const event = await offline;
    expect(event).toMatchObject({ userId: alice.user.id, state: 'offline' });
    expect(new Date(event.lastSeenAt ?? 0).getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it('rejects non-image or oversized avatars by their real bytes', async () => {
    const upload = async (content: Buffer, type: string) => {
      const { payload, contentType } = multipartBody('a.png', type, content);
      const res = await env.app.inject({ method: 'POST', url: '/api/v1/attachments', headers: { ...bearer(alice.accessToken), 'content-type': contentType }, payload });
      return res.json<{ attachment: { id: string } }>().attachment.id;
    };
    const fake = await upload(Buffer.from('<svg onload=alert(1)>'), 'image/png');
    const res = await env.app.inject({ method: 'PATCH', url: '/api/v1/users/me', headers: bearer(alice.accessToken), payload: { avatarAttachmentId: fake } });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('AVATAR_FORMAT');
    const big = await upload(gif(2000, 2000, 2), 'image/gif');
    const res2 = await env.app.inject({ method: 'PATCH', url: '/api/v1/users/me', headers: bearer(alice.accessToken), payload: { avatarAttachmentId: big } });
    expect(res2.json<{ error: { code: string } }>().error.code).toBe('AVATAR_DIMENSIONS');
    const animated = await upload(gif(256, 256, 3), 'image/gif');
    const ok = await env.app.inject({ method: 'PATCH', url: '/api/v1/users/me', headers: bearer(alice.accessToken), payload: { avatarAttachmentId: animated } });
    expect(ok.statusCode).toBe(200);
  });
});
