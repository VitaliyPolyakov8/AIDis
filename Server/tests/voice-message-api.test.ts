import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bearer, createPrivateChannel, createTestEnv, createUser, getTextChannelId, login, type LoginResult, type TestEnv } from './helpers.js';
import type { VoiceMessage } from '../src/voice-messages/service.js';

describe('protected voice-message HTTP integration', () => {
  let env: TestEnv;
  let alice: LoginResult;
  let bob: LoginResult;
  let channel: string;
  const read = (id: string, actor = alice) => env.app.inject({ method: 'GET', url: `/api/v1/attachments/${id}/voice-message`, headers: bearer(actor.accessToken) });
  const register = (id: string, actor = alice) => env.app.inject({ method: 'POST', url: `/api/v1/attachments/${id}/voice-message`, headers: bearer(actor.accessToken) });
  const upload = async (data = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0])) => {
    const boundary = 'voice-boundary';
    const response = await env.app.inject({
      method: 'POST',
      url: '/api/v1/attachments',
      headers: { ...bearer(alice.accessToken), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="voice.webm"\r\nContent-Type: audio/webm\r\n\r\n`), data, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ attachment: { id: string; url: string } }>().attachment;
  };
  beforeAll(async () => {
    env = await createTestEnv();
    await createUser(env, 'Alice');
    await createUser(env, 'Bob');
    alice = await login(env, 'Alice');
    bob = await login(env, 'Bob');
    channel = await getTextChannelId(env);
  });
  afterAll(async () => {
    await env.close();
  });

  it('requires authentication, rejects spoofed audio and prevents another user registering an upload', async () => {
    const attachment = await upload();
    expect((await env.app.inject({ method: 'GET', url: `/api/v1/attachments/${attachment.id}/voice-message` })).statusCode).toBe(401);
    expect((await register(attachment.id, bob)).statusCode).toBe(404);
    expect((await register((await upload(Buffer.from('not real audio'))).id)).statusCode).toBe(400);
    expect((await read(attachment.id, bob)).statusCode).toBe(404);
  });

  it('queues only after Send and keeps protected audio playable with an unavailable local worker', async () => {
    const attachment = await upload();
    expect((await register(attachment.id)).json<{ voiceMessage: VoiceMessage }>().voiceMessage.status).toBe('draft');
    expect((await read(attachment.id)).json<{ voiceMessage: VoiceMessage }>().voiceMessage.status).toBe('draft');
    const sent = await env.app.inject({ method: 'POST', url: `/api/v1/channels/${channel}/messages`, headers: bearer(alice.accessToken), payload: { content: '', nonce: randomUUID(), attachmentIds: [attachment.id] } });
    expect(sent.statusCode).toBe(201);
    await vi.waitFor(async () => {
      expect((await read(attachment.id, bob)).json<{ voiceMessage: VoiceMessage }>().voiceMessage.error).toBe('transcription-failed');
    });
    const audio = await env.app.inject({ method: 'GET', url: attachment.url, headers: bearer(bob.accessToken) });
    expect(audio.statusCode).toBe(200);
    expect(audio.rawPayload.length).toBe(8);
    const message = sent.json<{ message: { id: string } }>().message;
    await env.app.inject({ method: 'DELETE', url: `/api/v1/messages/${message.id}`, headers: bearer(alice.accessToken) });
    expect((await read(attachment.id)).statusCode).toBe(404);
    expect((await read(attachment.id, bob)).statusCode).toBe(404);
    expect((await register(attachment.id)).statusCode).toBe(404);
  });

  it('rechecks membership for the original uploader after attachment in a private channel', async () => {
    const privateChannel = await createPrivateChannel(env, 'private-voice', { userIds: [alice.user.id] });
    const attachment = await upload();
    await register(attachment.id);
    const sent = await env.app.inject({ method: 'POST', url: `/api/v1/channels/${privateChannel.id}/messages`, headers: bearer(alice.accessToken), payload: { content: '', attachmentIds: [attachment.id] } });
    expect(sent.statusCode).toBe(201);
    expect((await read(attachment.id, bob)).statusCode).toBe(404);
    await env.prisma.permissionOverwrite.deleteMany({ where: { channelId: privateChannel.id, targetType: 'MEMBER', targetId: alice.user.id } });
    env.ctx.services.permissions.invalidate();
    expect((await read(attachment.id)).statusCode).toBe(404);
  });
});
