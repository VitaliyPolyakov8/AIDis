import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The LiveKit admin API is mocked: the test checks who may call it and with which room/identity.
const removeParticipant = vi.fn((_room: string, _identity: string) => Promise.resolve());
vi.mock('livekit-server-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('livekit-server-sdk')>();
  return {
    ...actual,
    RoomServiceClient: class {
      removeParticipant = removeParticipant;
      listParticipants = () => Promise.resolve([]);
    },
  };
});

const { bearer, createTestEnv, createUser, getTextChannelId, getVoiceChannelId, login } = await import('./helpers.js');
type Env = Awaited<ReturnType<typeof createTestEnv>>;
type Login = Awaited<ReturnType<typeof login>>;

describe('admin voice disconnect', () => {
  let env: Env;
  let admin: Login;
  let bob: Login;
  let carol: Login;

  beforeAll(async () => {
    env = await createTestEnv();
    await createUser(env, 'Root', 'ADMIN');
    await createUser(env, 'Bob');
    await createUser(env, 'Carol');
    admin = await login(env, 'Root');
    bob = await login(env, 'Bob');
    carol = await login(env, 'Carol');
  });

  afterAll(async () => {
    await env.close();
  });

  beforeEach(() => {
    removeParticipant.mockReset();
    removeParticipant.mockImplementation(() => Promise.resolve());
  });

  const url = (channelId: string, userId: string) => `/api/v1/voice/channels/${channelId}/participants/${userId}/disconnect`;

  it('lets an ADMIN remove a participant from the LiveKit room and nothing else', async () => {
    const channelId = await getVoiceChannelId(env);
    const res = await env.app.inject({ method: 'POST', url: url(channelId, bob.user.id), headers: bearer(admin.accessToken) });
    expect(res.statusCode).toBe(204);
    expect(removeParticipant).toHaveBeenCalledWith(`voice-${channelId}`, bob.user.id);

    // Not a ban: Bob's account and session still work, and he can get a new voice token.
    const user = await env.prisma.user.findUniqueOrThrow({ where: { id: bob.user.id } });
    expect(user.disabled).toBe(false);
    const me = await env.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bearer(bob.accessToken) });
    expect(me.statusCode).toBe(200);
    const token = await env.app.inject({ method: 'POST', url: '/api/v1/voice/token', headers: bearer(bob.accessToken), payload: { channelId } });
    expect(token.statusCode).toBe(200);
  });

  it('refuses normal users, anonymous requests and self-disconnect', async () => {
    const channelId = await getVoiceChannelId(env);
    const asUser = await env.app.inject({ method: 'POST', url: url(channelId, carol.user.id), headers: bearer(bob.accessToken) });
    expect(asUser.statusCode).toBe(403);
    const anon = await env.app.inject({ method: 'POST', url: url(channelId, carol.user.id) });
    expect(anon.statusCode).toBe(401);
    const self = await env.app.inject({ method: 'POST', url: url(channelId, admin.user.id), headers: bearer(admin.accessToken) });
    expect(self.statusCode).toBe(400);
    expect(removeParticipant).not.toHaveBeenCalled();
  });

  it('validates the channel and reports participants who are not in the room', async () => {
    const text = await getTextChannelId(env);
    const wrongType = await env.app.inject({ method: 'POST', url: url(text, bob.user.id), headers: bearer(admin.accessToken) });
    expect(wrongType.statusCode).toBe(404);
    const bad = await env.app.inject({ method: 'POST', url: url('nope', bob.user.id), headers: bearer(admin.accessToken) });
    expect(bad.statusCode).toBe(400);

    removeParticipant.mockRejectedValueOnce(Object.assign(new Error('not found'), { status: 404 }));
    const voiceId = await getVoiceChannelId(env);
    const missing = await env.app.inject({ method: 'POST', url: url(voiceId, carol.user.id), headers: bearer(admin.accessToken) });
    expect(missing.statusCode).toBe(404);
    expect(missing.json<{ error: { code: string } }>().error.code).toBe('VOICE_PARTICIPANT_NOT_FOUND');
  });
});
