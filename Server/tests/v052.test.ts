import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { bearer, createTestEnv, createUser, getTextChannelId, getVoiceChannelId, login, type LoginResult, type TestEnv } from './helpers.js';
import { LinkPreviewService } from '../src/embeds/link-preview.service.js';
import type { safeFetch } from '../src/embeds/safe-fetch.js';

const quietLog = { info: () => undefined, warn: () => undefined, debug: () => undefined } as unknown as FastifyBaseLogger;

describe('0.5.2 TTS messages', () => {
  let env: TestEnv;
  let bob: LoginResult;
  beforeAll(async () => {
    env = await createTestEnv();
    await createUser(env, 'bob');
    bob = await login(env, 'bob');
  });
  afterAll(async () => {
    await env.close();
  });

  type Sent = { message: { content: string; tts: boolean } };
  const send = (channelId: string, body: Record<string, unknown>) =>
    env.app.inject({ method: 'POST', url: `/api/v1/channels/${channelId}/messages`, headers: bearer(bob.accessToken), payload: body });

  it('stores tts for voice channel chats only, and returns it in history', async () => {
    const voice = await getVoiceChannelId(env);
    const text = await getTextChannelId(env);
    const spoken = await send(voice, { content: 'привет', tts: true });
    expect(spoken.statusCode).toBe(201);
    expect(spoken.json<Sent>().message.tts).toBe(true);
    expect((await send(text, { content: 'hi', tts: true })).json<Sent>().message.tts).toBe(false);
    expect((await send(voice, { content: 'plain' })).json<Sent>().message.tts).toBe(false);
    const history = await env.app.inject({ method: 'GET', url: `/api/v1/channels/${voice}/messages`, headers: bearer(bob.accessToken) });
    expect(history.json<{ messages: Sent['message'][] }>().messages.map((m) => [m.content, m.tts])).toEqual([
      ['привет', true],
      ['plain', false],
    ]);
  });

  it('rejects a non-boolean tts', async () => {
    const voice = await getVoiceChannelId(env);
    expect((await send(voice, { content: 'x', tts: 'yes' })).statusCode).toBe(400);
  });

  it('serves Steam art only to signed-in users and validates the app id', async () => {
    expect((await env.app.inject({ method: 'GET', url: '/api/v1/steam/apps/730/art' })).statusCode).toBe(401);
    expect((await env.app.inject({ method: 'GET', url: '/api/v1/steam/apps/abc/art', headers: bearer(bob.accessToken) })).statusCode).toBe(400);
  });
});

describe('0.5.2 Steam art lookup (LinkPreviewService.steamArt)', () => {
  const body = (data: Record<string, unknown>) => ({
    url: '',
    status: 200,
    contentType: 'application/json',
    truncated: false,
    body: Buffer.from(JSON.stringify({ '2968420': { success: true, data } })),
  });

  it('returns the hashed CDN URLs, drops anything off Steam, and caches the answer', async () => {
    let calls = 0;
    const fetcher = (() => {
      calls += 1;
      return Promise.resolve(body({
        header_image: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2968420/91fe/header.jpg?t=1',
        capsule_image: 'https://evil.example.com/capsule.jpg',
      }));
    }) as unknown as typeof safeFetch;
    const service = new LinkPreviewService({ enabled: false, steamCountry: 'ru', steamLanguage: 'russian', fetcher }, quietLog);
    const art = await service.steamArt(2968420);
    expect(art).toEqual({ header: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2968420/91fe/header.jpg?t=1', capsule: null });
    await service.steamArt(2968420);
    expect(calls).toBe(1);
  });

  it('answers null when Steam fails', async () => {
    const fetcher = (() => Promise.reject(new Error('down'))) as unknown as typeof safeFetch;
    const service = new LinkPreviewService({ enabled: true, steamCountry: 'ru', steamLanguage: 'russian', fetcher }, quietLog);
    expect(await service.steamArt(5)).toBeNull();
  });
});
