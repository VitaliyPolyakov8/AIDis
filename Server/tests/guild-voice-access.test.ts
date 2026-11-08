import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bearer, connectSocket, createTestEnv, createUser, getVoiceChannelId, listen, loginAll, waitForEvent, type LoginResult, type TestEnv } from './helpers.js';

interface Tracker {
  apply(channelId: string, participants: { identity: string; name: string; joinedAt: string | null }[]): void;
}

describe('voice is cut when access is lost', () => {
  let env: TestEnv;
  let owner: LoginResult, member: LoginResult, other: LoginResult;
  const removed: { room: string; identity: string }[] = [];

  const api = (user: LoginResult, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    env.app.inject({ method, url: `/api/v1${url}`, headers: bearer(user.accessToken), ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
  const inVoice = (channelId: string, ...users: LoginResult[]) => {
    const tracker = (env.ctx.services.voice as unknown as { sessions: Tracker }).sessions;
    tracker.apply(
      channelId,
      users.map((u) => ({ identity: u.user.id, name: u.user.username, joinedAt: new Date().toISOString() })),
    );
  };

  beforeAll(async () => {
    env = await createTestEnv();
    await createUser(env, 'vaMember');
    await createUser(env, 'vaOther', 'USER', { join: false });
    [owner, member, other] = await loginAll(env, ['test-owner', 'vaMember', 'vaOther']);
    // A fake LiveKit records removals.
    Object.assign(env.ctx.services.voice as unknown as Record<string, unknown>, {
      roomClient: {
        removeParticipant: (room: string, identity: string) => {
          removed.push({ room, identity });
          return Promise.resolve();
        },
        listParticipants: () => Promise.resolve([]),
        listRooms: () => Promise.resolve([]),
      },
    });
  });
  afterAll(async () => {
    await env.close();
  });

  it('disconnects people who lose VIEW_CHANNEL on the voice channel, not the others', async () => {
    const voiceId = await getVoiceChannelId(env);
    inVoice(voiceId, owner, member);
    const everyone = await env.prisma.roleDef.findFirstOrThrow({ where: { guildId: env.guildId, key: 'everyone' } });
    expect((await api(owner, 'PUT', `/channels/${voiceId}/overwrites/ROLE/${everyone.id}`, { allow: [], deny: ['VIEW_CHANNEL'] })).statusCode).toBe(200);
    await vi.waitFor(() => {
      expect(removed).toContainEqual({ room: `voice-${voiceId}`, identity: member.user.id });
    });
    expect(removed.some((r) => r.identity === owner.user.id)).toBe(false);
    await api(owner, 'DELETE', `/channels/${voiceId}/overwrites/ROLE/${everyone.id}`);
  });

  it('disconnects a member who leaves the server', async () => {
    removed.length = 0;
    const voiceId = await getVoiceChannelId(env, 'Gaming');
    inVoice(voiceId, owner, member);
    expect((await api(member, 'DELETE', `/guilds/${env.guildId}/members/me`)).statusCode).toBe(204);
    await vi.waitFor(() => {
      expect(removed).toContainEqual({ room: `voice-${voiceId}`, identity: member.user.id });
    });
    expect(removed.some((r) => r.identity === owner.user.id)).toBe(false);
  });

  it('lets only people who see the streamer’s channel watch the stream', async () => {
    const base = await listen(env);
    const voiceId = await getVoiceChannelId(env);
    vi.spyOn(env.ctx.services.voice, 'channelOf').mockImplementation((id) => (id === owner.user.id ? voiceId : null));
    const [outsiderSocket, memberSocket] = [connectSocket(base, other.accessToken), connectSocket(base, member.accessToken)];
    await Promise.all([waitForEvent(outsiderSocket, 'ready'), waitForEvent(memberSocket, 'ready')]);
    try {
      let outsiderGot = false;
      outsiderSocket.on('stream.viewers', () => {
        outsiderGot = true;
      });
      outsiderSocket.emit('stream.watch', { streamerId: owner.user.id, source: 'screen', watching: true });
      // member rejoins the AIDis server for this check
      await env.ctx.services.guilds.join(member.user.id, env.guildId);
      const viewers = waitForEvent<{ streamerId: string; viewers: string[] }>(memberSocket, 'stream.viewers');
      memberSocket.emit('stream.watch', { streamerId: owner.user.id, source: 'screen', watching: true });
      const got = await viewers;
      expect(got.viewers).toEqual([member.user.id]);
      await new Promise((r) => setTimeout(r, 200));
      expect(outsiderGot).toBe(false);
    } finally {
      outsiderSocket.disconnect();
      memberSocket.disconnect();
      vi.restoreAllMocks();
    }
  });

  it('empties the calls of a deleted server', async () => {
    removed.length = 0;
    const guild = (await api(other, 'POST', '/guilds', { name: 'Gone' })).json<{ guild: { id: string } }>().guild;
    const voiceId = await getVoiceChannelId(env, 'General', guild.id);
    inVoice(voiceId, other);
    expect((await api(other, 'DELETE', `/guilds/${guild.id}`, { confirmName: 'Gone' })).statusCode).toBe(204);
    await vi.waitFor(() => {
      expect(removed).toContainEqual({ room: `voice-${voiceId}`, identity: other.user.id });
    });
  });
});
