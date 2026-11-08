import { jwtVerify } from 'jose';
import { TrackSource } from 'livekit-server-sdk';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { bearer, createTestEnv, createUser, getVoiceChannelId, LIVEKIT_TEST_SECRET, login, type LoginResult, type TestEnv } from './helpers.js';

describe('voice permissions per server', () => {
  let env: TestEnv;
  let owner: LoginResult, mod: LoginResult, member: LoginResult, high: LoginResult;
  let voiceId: string, everyoneId: string;

  const api = (user: LoginResult, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    env.app.inject({ method, url: `/api/v1${url}`, headers: bearer(user.accessToken), ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
  const sources = async (user: LoginResult) => {
    const res = await api(user, 'POST', '/voice/token', { channelId: voiceId });
    expect(res.statusCode, res.body).toBe(200);
    const { payload } = await jwtVerify(res.json<{ token: string }>().token, new TextEncoder().encode(LIVEKIT_TEST_SECRET));
    return (payload.video as { canPublishSources: string[] }).canPublishSources;
  };

  beforeAll(async () => {
    env = await createTestEnv();
    await createUser(env, 'vMod');
    await createUser(env, 'vMember');
    await createUser(env, 'vHigh');
    [owner, mod, member, high] = await Promise.all([login(env, 'test-owner'), login(env, 'vMod'), login(env, 'vMember'), login(env, 'vHigh')]);
    voiceId = await getVoiceChannelId(env);
    everyoneId = (await env.prisma.roleDef.findFirstOrThrow({ where: { guildId: env.guildId, key: 'everyone' } })).id;
    const modRole = (await api(owner, 'POST', `/guilds/${env.guildId}/roles`, { name: 'VMod', permissions: ['MUTE_MEMBERS', 'DEAFEN_MEMBERS', 'MOVE_USERS', 'DISCONNECT_USERS'] })).json<{ role: { id: string } }>().role
      .id;
    const highRole = (await api(owner, 'POST', `/guilds/${env.guildId}/roles`, { name: 'VHigh' })).json<{ role: { id: string } }>().role.id;
    await api(owner, 'PUT', `/guilds/${env.guildId}/roles/order`, { ids: [modRole, highRole] });
    await api(owner, 'PUT', `/guilds/${env.guildId}/members/${mod.user.id}/roles`, { roleIds: [modRole] });
    await api(owner, 'PUT', `/guilds/${env.guildId}/members/${high.user.id}/roles`, { roleIds: [highRole] });
  });
  afterAll(async () => {
    await env.close();
  });

  it('gives microphone, camera and screen by default', async () => {
    expect((await sources(member)).sort()).toEqual(['camera', 'microphone', 'screen_share', 'screen_share_audio']);
  });

  it('drops screen and camera without STREAM, and the microphone without SPEAK', async () => {
    await api(owner, 'PUT', `/channels/${voiceId}/overwrites/ROLE/${everyoneId}`, { allow: [], deny: ['STREAM'] });
    expect(await sources(member)).toEqual(['microphone']);
    await api(owner, 'PUT', `/channels/${voiceId}/overwrites/ROLE/${everyoneId}`, { allow: [], deny: ['STREAM', 'SPEAK'] });
    expect(await sources(member)).toEqual([]);
    await api(owner, 'DELETE', `/channels/${voiceId}/overwrites/ROLE/${everyoneId}`);
  });

  it('server-mutes by permission and hierarchy and keeps new tokens without a microphone', async () => {
    expect((await api(member, 'PUT', `/voice/channels/${voiceId}/participants/${mod.user.id}/server-mute`, { muted: true })).statusCode).toBe(403);
    expect((await api(mod, 'PUT', `/voice/channels/${voiceId}/participants/${high.user.id}/server-mute`, { muted: true })).statusCode).toBe(403);
    expect((await api(mod, 'PUT', `/voice/channels/${voiceId}/participants/${member.user.id}/server-mute`, { muted: true })).statusCode).toBe(204);
    expect(await sources(member)).not.toContain('microphone');
    expect((await api(mod, 'PUT', `/voice/channels/${voiceId}/participants/${member.user.id}/server-mute`, { muted: false })).statusCode).toBe(204);
    expect(await sources(member)).toContain('microphone');
  });

  it('server-deafens by permission', async () => {
    expect((await api(member, 'PUT', `/voice/channels/${voiceId}/participants/${mod.user.id}/server-deafen`, { deafened: true })).statusCode).toBe(403);
    expect((await api(mod, 'PUT', `/voice/channels/${voiceId}/participants/${member.user.id}/server-deafen`, { deafened: true })).statusCode).toBe(204);
    expect(env.ctx.services.voice.serverFlags(env.guildId, member.user.id)).toMatchObject({ deafened: true });
  });

  describe('live server mute (fake LiveKit)', () => {
    const calls: { room: string; identity: string; sources: number[] }[] = [];
    let outsider: LoginResult;
    let otherGuildVoice: string;
    beforeAll(async () => {
      expect(env.config.livekit.enabled).toBe(true);
      // A fake room client records what the server asks LiveKit to do.
      Object.assign(env.ctx.services.voice as unknown as Record<string, unknown>, {
        roomClient: {
          updateParticipant: (room: string, identity: string, options: { permission: { canPublishSources: number[] } }) => {
            calls.push({ room, identity, sources: options.permission.canPublishSources });
            return Promise.resolve({});
          },
        },
      });
      await createUser(env, 'vOutsider', 'USER', { join: false });
      outsider = await login(env, 'vOutsider');
      const other = (await api(outsider, 'POST', '/guilds', { name: 'Elsewhere' })).json<{ guild: { id: string } }>().guild.id;
      otherGuildVoice = await getVoiceChannelId(env, 'General', other);
    });
    afterEach(() => {
      vi.restoreAllMocks();
      calls.length = 0;
    });

    it('refuses to server-mute someone who is not a member of that server', async () => {
      const res = await api(outsider, 'PUT', `/voice/channels/${otherGuildVoice}/participants/${member.user.id}/server-mute`, { muted: true });
      expect(res.statusCode).toBe(404);
      expect(env.ctx.services.voice.serverFlags(env.guildId, member.user.id).muted).toBe(false);
    });

    it('touches the live connection only in a voice channel of the same server', async () => {
      vi.spyOn(env.ctx.services.voice, 'channelOf').mockReturnValue(otherGuildVoice);
      expect((await api(mod, 'PUT', `/voice/channels/${voiceId}/participants/${member.user.id}/server-mute`, { muted: true })).statusCode).toBe(204);
      expect(calls).toEqual([]);
      await api(mod, 'PUT', `/voice/channels/${voiceId}/participants/${member.user.id}/server-mute`, { muted: false });
    });

    it('unmuting gives back only what the member may publish there', async () => {
      vi.spyOn(env.ctx.services.voice, 'channelOf').mockReturnValue(voiceId);
      await api(owner, 'PUT', `/channels/${voiceId}/overwrites/ROLE/${everyoneId}`, { allow: [], deny: ['STREAM'] });
      expect((await api(mod, 'PUT', `/voice/channels/${voiceId}/participants/${member.user.id}/server-mute`, { muted: true })).statusCode).toBe(204);
      expect((await api(mod, 'PUT', `/voice/channels/${voiceId}/participants/${member.user.id}/server-mute`, { muted: false })).statusCode).toBe(204);
      await api(owner, 'DELETE', `/channels/${voiceId}/overwrites/ROLE/${everyoneId}`);
      expect(calls.map((c) => c.sources)).toEqual([[], [TrackSource.MICROPHONE]]);
      expect(calls.every((c) => c.room === `voice-${voiceId}` && c.identity === member.user.id)).toBe(true);
    });
  });

  it('does not let a moderator disconnect or move someone ranked higher', async () => {
    expect((await api(mod, 'POST', `/voice/channels/${voiceId}/participants/${high.user.id}/disconnect`)).statusCode).toBe(403);
    const other = await getVoiceChannelId(env, 'Gaming');
    expect((await api(mod, 'POST', `/voice/channels/${voiceId}/participants/${high.user.id}/move`, { targetChannelId: other })).statusCode).toBe(403);
    expect((await api(member, 'POST', `/voice/channels/${voiceId}/participants/${high.user.id}/disconnect`)).statusCode).toBe(403);
  });
});
