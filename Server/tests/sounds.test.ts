/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- inject().json() bodies are untyped; the assertions check their shape. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import { bearer, connectSocket, createTestEnv, createUser, getVoiceChannelId, listen, login, waitForEvent } from './helpers.js';

type Env = Awaited<ReturnType<typeof createTestEnv>>;
type Login = Awaited<ReturnType<typeof login>>;

/** A PCM WAV of silence: 8 kHz, mono, 8-bit, so 1 s = 8000 bytes. */
function wav(seconds: number): Buffer {
  const rate = 8000;
  const data = Math.round(rate * seconds);
  const b = Buffer.alloc(44 + data, 0x80);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + data, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate, 28); // byte rate
  b.writeUInt16LE(1, 32); // block align
  b.writeUInt16LE(8, 34); // bits
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(data, 40);
  return b;
}

describe('0.7.1 server sounds (soundboard)', () => {
  let env: Env;
  let base: string;
  let owner: Login;
  let bob: Login;
  let carol: Login;
  let voiceId: string;
  let otherVoiceId: string;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    env = await createTestEnv();
    await createUser(env, 'Bob');
    await createUser(env, 'Carol');
    owner = await login(env, 'test-owner');
    bob = await login(env, 'Bob');
    carol = await login(env, 'Carol');
    voiceId = await getVoiceChannelId(env);
    const other = await env.app.inject({ method: 'POST', url: `/api/v1/guilds/${env.guildId}/channels`, headers: bearer(owner.accessToken), payload: { name: 'Second', type: 'VOICE' } });
    otherVoiceId = other.json().channel.id;
    base = await listen(env);
  });
  afterAll(async () => {
    for (const s of sockets) s.disconnect();
    await env.close();
  });

  const upload = (token: string, body: Buffer, name = 'boom', extra = '') =>
    env.app.inject({ method: 'POST', url: `/api/v1/guilds/${env.guildId}/sounds?name=${encodeURIComponent(name)}${extra}`, headers: { ...bearer(token), 'content-type': 'application/octet-stream' }, payload: body });
  const everyoneId = async () => (await env.prisma.roleDef.findFirstOrThrow({ where: { guildId: env.guildId, key: 'everyone' } })).id;

  let soundId = '';
  it('the owner uploads a short WAV; members list it and fetch the file', async () => {
    const res = await upload(owner.accessToken, wav(1), 'boom', '&emoji=%F0%9F%92%A5&volume=70');
    expect(res.statusCode).toBe(201);
    const sound = res.json().sound;
    expect(sound).toMatchObject({ guildId: env.guildId, name: 'boom', emoji: '💥', volume: 70 });
    expect(sound.durationMs).toBeGreaterThanOrEqual(990);
    expect(sound.durationMs).toBeLessThanOrEqual(1010);
    soundId = sound.id;
    const list = await env.app.inject({ method: 'GET', url: `/api/v1/guilds/${env.guildId}/sounds`, headers: bearer(bob.accessToken) });
    expect(list.json().sounds.map((s: { id: string }) => s.id)).toEqual([soundId]);
    const file = await env.app.inject({ method: 'GET', url: `/api/v1/sounds/${soundId}/content`, headers: bearer(bob.accessToken) });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('audio/wav');
  });

  it('rejects long and unknown files', async () => {
    const long = await upload(owner.accessToken, wav(6), 'long');
    expect(long.statusCode).toBe(400);
    expect(long.json().error.code).toBe('SOUND_TOO_LONG');
    const junk = await upload(owner.accessToken, Buffer.from('definitely not audio, just some bytes here'), 'junk');
    expect(junk.statusCode).toBe(400);
    expect(junk.json().error.code).toBe('SOUND_TYPE');
    expect((await upload(owner.accessToken, wav(1), 'boom')).json().error.code).toBe('SOUND_NAME_TAKEN');
  });

  it('needs CREATE_SOUNDS to upload and MANAGE_SOUNDS to delete someone else’s', async () => {
    expect((await upload(bob.accessToken, wav(1), 'bob')).statusCode).toBe(403);
    expect((await env.app.inject({ method: 'DELETE', url: `/api/v1/sounds/${soundId}`, headers: bearer(bob.accessToken) })).statusCode).toBe(403);
    expect((await env.app.inject({ method: 'PATCH', url: `/api/v1/sounds/${soundId}`, headers: bearer(bob.accessToken), payload: { name: 'mine' } })).statusCode).toBe(403);
    const patched = await env.app.inject({ method: 'PATCH', url: `/api/v1/sounds/${soundId}`, headers: bearer(owner.accessToken), payload: { name: 'bang', volume: 50, emoji: null } });
    expect(patched.json().sound).toMatchObject({ name: 'bang', volume: 50, emoji: null });
  });

  it('respects the guild.sounds limit', async () => {
    await env.ctx.services.limits.setOverride('guild.sounds', 'GUILD', env.guildId, 1);
    const res = await upload(owner.accessToken, wav(1), 'second');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('LIMIT_REACHED');
    await env.ctx.services.limits.setOverride('guild.sounds', 'GUILD', env.guildId, null);
  });

  it('Review Focus 5: presses from outside the channel, of deleted sounds or too often are refused', async () => {
    const where: Record<string, string | null> = { [owner.user.id]: voiceId, [bob.user.id]: voiceId, [carol.user.id]: otherVoiceId };
    vi.spyOn(env.ctx.services.voice, 'channelOf').mockImplementation((id) => where[id] ?? null);
    vi.spyOn(env.ctx.services.voice, 'participantIdsOf').mockImplementation((channelId) => Object.keys(where).filter((id) => where[id] === channelId));

    const connect = async (token: string) => {
      const s = connectSocket(base, token);
      sockets.push(s);
      await waitForEvent(s, 'ready');
      return s;
    };
    const ownerSocket = await connect(owner.accessToken);
    const bobSocket = await connect(bob.accessToken);
    const carolSocket = await connect(carol.accessToken);
    const heard: { who: string; payload: unknown }[] = [];
    bobSocket.on('voice.sound', (p: unknown) => heard.push({ who: 'bob', payload: p }));
    carolSocket.on('voice.sound', (p: unknown) => heard.push({ who: 'carol', payload: p }));
    const press = (s: Socket, id: string) => s.timeout(3000).emitWithAck('voice.sound.play', { soundId: id }) as Promise<{ ok: boolean; code?: string }>;

    // Not in a voice channel.
    where[owner.user.id] = null;
    expect(await press(ownerSocket, soundId)).toEqual({ ok: false, code: 'NOT_IN_VOICE' });
    where[owner.user.id] = voiceId;

    // Pressed: Bob (same channel) hears it, Carol (another channel) does not.
    expect(await press(ownerSocket, soundId)).toEqual({ ok: true });
    await vi.waitFor(() => {
      expect(heard).toHaveLength(1);
    });
    expect(heard[0]).toEqual({ who: 'bob', payload: { channelId: voiceId, soundId, userId: owner.user.id } });

    // Again within 2 s.
    expect(await press(ownerSocket, soundId)).toEqual({ ok: false, code: 'RATE_LIMITED' });

    // Forbidden in this channel.
    await env.app.inject({ method: 'PUT', url: `/api/v1/channels/${voiceId}/overwrites/ROLE/${await everyoneId()}`, headers: bearer(owner.accessToken), payload: { allow: [], deny: ['USE_SOUNDBOARD'] } });
    expect(await press(bobSocket, soundId)).toEqual({ ok: false, code: 'FORBIDDEN' });

    // A deleted sound.
    expect((await env.app.inject({ method: 'DELETE', url: `/api/v1/sounds/${soundId}`, headers: bearer(owner.accessToken) })).statusCode).toBe(204);
    expect(await press(carolSocket, soundId)).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(heard).toHaveLength(1);
  });

  it('new servers give @everyone USE_SOUNDBOARD; existing ones got it from the migration', async () => {
    const everyone = await env.prisma.roleDef.findFirstOrThrow({ where: { guildId: env.guildId, key: 'everyone' } });
    expect(everyone.permissions).toContain('USE_SOUNDBOARD');
  });
});
