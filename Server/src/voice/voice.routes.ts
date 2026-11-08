import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app-context.js';
import { getAuth } from '../auth/auth.hooks.js';
import { parseInput } from '../common/validation.js';
import { Errors } from '../common/errors.js';
import { THUMBNAIL_MAX_BYTES } from './voice.service.js';
import type { User } from '../generated/prisma/client.js';
import type { Permission } from '../permissions/catalog.js';
import { outranks } from '../permissions/resolve.js';

const tokenBody = z.object({ channelId: z.uuid() });
const channelParams = z.object({ channelId: z.uuid() });
const participantParams = z.object({ channelId: z.uuid(), userId: z.uuid() });
const moveBody = z.object({ targetChannelId: z.uuid() });
const userParams = z.object({ userId: z.uuid() });

/** The bytes really are a JPEG / WebP (never trust the header alone). */
export function isPreviewImage(type: string, body: Buffer): boolean {
  if (type === 'image/jpeg') return body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff;
  if (type === 'image/webp') return body.subarray(0, 4).toString('latin1') === 'RIFF' && body.subarray(8, 12).toString('latin1') === 'WEBP';
  return false;
}

export function voiceRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { voice, channels, permissions, audit, users } = ctx.services;
  const { requireAuth } = ctx.hooks;

  // 0.5.5 stream previews: small JPEG / WebP snapshots as the raw request body.
  app.addContentTypeParser(['image/jpeg', 'image/webp'], { parseAs: 'buffer', bodyLimit: THUMBNAIL_MAX_BYTES }, (_request, body, done) => {
    done(null, body);
  });

  /** The streamer's client posts a small snapshot every few seconds while it shares its screen. */
  app.put('/voice/stream-thumbnail', { preHandler: requireAuth, config: { rateLimit: { max: 40, timeWindow: '1 minute' } } }, async (request, reply) => {
    const type = (request.headers['content-type'] ?? '').split(';')[0]?.trim() ?? '';
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length < 100 || !isPreviewImage(type, body)) throw Errors.badRequest('INVALID_THUMBNAIL', 'Send a JPEG or WebP image');
    if (!voice.setThumbnail(getAuth(request).user.id, type, body)) throw Errors.conflict('NOT_IN_VOICE', 'Join a voice channel first');
    return reply.status(204).send();
  });

  app.delete('/voice/stream-thumbnail', { preHandler: requireAuth }, async (request, reply) => {
    voice.clearThumbnail(getAuth(request).user.id);
    return reply.status(204).send();
  });

  /** Hovering a LIVE badge: the streamer's newest preview (404 when there is none or it is stale). */
  app.get('/voice/streams/:userId/thumbnail', { preHandler: requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { userId } = parseInput(userParams, request.params);
    const preview = await voice.thumbnailFor(getAuth(request).user, userId);
    if (!preview) throw Errors.notFound('Stream preview');
    return reply.header('Content-Type', preview.type).header('Cache-Control', 'no-store').header('X-Captured-At', new Date(preview.at).toISOString()).header('X-Content-Type-Options', 'nosniff').send(preview.data);
  });

  /** VOICE channels and (0.4.0) DM calls. Checks visibility and CONNECT_VOICE. */
  app.post('/voice/token', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
    const { channelId } = parseInput(tokenBody, request.body);
    return voice.createToken(getAuth(request).user, channelId);
  });

  app.get('/voice/channels/:channelId/participants', { preHandler: requireAuth }, async (request) => {
    const { channelId } = parseInput(channelParams, request.params);
    return { participants: await voice.participants(getAuth(request).user, channelId) };
  });

  /**
   * 0.7.0: a voice moderation action needs the permission in that channel and the target ranked
   * below the actor (the owner and the superadmin are above everyone). Returns the channel.
   */
  const moderate = async (actor: User, channelId: string, userId: string, permission: Permission) => {
    const channel = await channels.getOfType(channelId, 'VOICE');
    await permissions.requireChannel(actor, channel, permission);
    const guildId = channel.guildId ?? '';
    // Only members of this server can be moderated here (never someone elsewhere on the instance).
    if (!(await permissions.isMember(userId, guildId))) throw Errors.notFound('Member');
    if (await permissions.isOwner(userId, guildId)) throw Errors.forbidden('The server owner cannot be moderated');
    if (!outranks(await permissions.topPosition(actor, guildId), await permissions.memberTopPosition(userId, guildId))) throw Errors.forbidden('This member is not below you');
    return channel;
  };

  // DISCONNECT_USERS: remove someone from a voice channel (not a ban: account, sessions and chat stay).
  app.post('/voice/channels/:channelId/participants/:userId/disconnect', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { channelId, userId } = parseInput(participantParams, request.params);
    const actor = getAuth(request).user;
    if (userId === actor.id) throw Errors.badRequest('CANNOT_DISCONNECT_SELF', 'Leave the voice channel instead');
    const channel = await moderate(actor, channelId, userId, 'DISCONNECT_USERS');
    await voice.disconnectParticipant(channelId, userId);
    const target = await users.getById(userId).catch(() => null);
    await audit.record(actor.id, 'voice.disconnected', { type: 'user', id: userId }, { user: target?.displayName ?? null, channel: channel.name }, channel.guildId);
    request.log.info({ event: 'voice.participant_disconnected', adminId: actor.id, userId, channelId }, 'Voice participant disconnected');
    return reply.status(204).send();
  });

  /**
   * 0.4.0 MOVE_USERS: move someone to another voice channel. Authoritative on the server: LiveKit
   * moves their connection (or, if that is not possible, removes them from the old room and their
   * client is told to join the new one). The target must be allowed into the new channel.
   */
  app.post('/voice/channels/:channelId/participants/:userId/move', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
    const { channelId, userId } = parseInput(participantParams, request.params);
    const { targetChannelId } = parseInput(moveBody, request.body);
    const actor = getAuth(request).user;
    if (targetChannelId === channelId) throw Errors.badRequest('SAME_CHANNEL', 'The user is already in this channel');
    const from = await moderate(actor, channelId, userId, 'MOVE_USERS');
    const [to, target] = await Promise.all([channels.getOfType(targetChannelId, 'VOICE'), users.getById(userId)]);
    if (to.guildId !== from.guildId) throw Errors.badRequest('TARGET_NOT_ALLOWED', 'Pick a voice channel of the same server');
    await permissions.requireChannel(actor, to, 'MOVE_USERS');
    if (!(await permissions.canConnect(target, to))) throw Errors.badRequest('TARGET_NOT_ALLOWED', 'This user cannot join the target channel');
    const moved = await voice.moveParticipant(channelId, targetChannelId, userId);
    // Either way the client switches its UI (and, in the fallback, reconnects) to the new channel.
    // 0.5.9: in the fallback the client is told to rejoin right away (no waiting for a LiveKit move).
    ctx.publisher.voiceMove(userId, targetChannelId, !moved);
    await audit.record(actor.id, 'voice.moved', { type: 'user', id: userId }, { user: target.displayName, from: from.name, to: to.name, method: moved ? 'livekit' : 'rejoin' }, from.guildId);
    return { moved: true, method: moved ? 'livekit' : 'rejoin' };
  });

  /** 0.7.0 MUTE_MEMBERS / DEAFEN_MEMBERS: server mute (no microphone) and server deafen (the client must go silent). */
  for (const [path, flag, permission, action] of [
    ['server-mute', 'muted', 'MUTE_MEMBERS', 'voice.server_muted'],
    ['server-deafen', 'deafened', 'DEAFEN_MEMBERS', 'voice.server_deafened'],
  ] as const) {
    const body = z.object({ [flag]: z.boolean() });
    app.put(`/voice/channels/:channelId/participants/:userId/${path}`, { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
      const { channelId, userId } = parseInput(participantParams, request.params);
      const value = (parseInput(body, request.body) as Record<string, boolean>)[flag] ?? false;
      const actor = getAuth(request).user;
      const channel = await moderate(actor, channelId, userId, permission);
      const guildId = channel.guildId ?? '';
      const flags = await voice.setServerFlag(guildId, await users.getById(userId), flag, value);
      ctx.publisher.voiceServerState(guildId, userId, flags);
      await audit.record(actor.id, action, { type: 'user', id: userId }, { [flag]: value }, guildId);
      return reply.status(204).send();
    });
  }
}
