import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app-context.js';
import { getAuth } from '../auth/auth.hooks.js';
import { parseInput } from '../common/validation.js';
import { notFriends } from './channels.service.js';

const dmParams = z.object({ channelId: z.uuid() });

/**
 * 0.4.0 direct messages. A DM is a channel of type DM with a member list; messages, reactions,
 * pins, attachments, unread state and calls (LiveKit room per channel) reuse the channel machinery.
 * Only members can see a DM, fetch its messages or files, or receive its realtime events.
 */
export function dmsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { channels } = ctx.services;
  const { requireAuth } = ctx.hooks;

  app.get('/dms', { preHandler: requireAuth }, async (request) => {
    return { dms: await channels.listDms(getAuth(request).user) };
  });

  /** { userIds: [one] } opens (or reuses) a 1:1 DM; several ids create a group DM. */
  app.post('/dms', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { channel, created } = await channels.openDm(getAuth(request).user, request.body);
    if (created) ctx.publisher.channelsChanged('dms', channel.memberIds ?? []);
    return reply.status(created ? 201 : 200).send({ dm: channel });
  });

  app.patch('/dms/:channelId', { preHandler: requireAuth }, async (request) => {
    const { channelId } = parseInput(dmParams, request.params);
    const dm = await channels.updateGroupDm(getAuth(request).user, channelId, request.body);
    ctx.publisher.channelsChanged('dms', dm.memberIds ?? []);
    return { dm };
  });

  app.delete('/dms/:channelId/members/me', { preHandler: requireAuth }, async (request, reply) => {
    const { channelId } = parseInput(dmParams, request.params);
    const user = getAuth(request).user;
    const { memberIds } = await channels.leaveDm(user, channelId);
    ctx.publisher.channelsChanged('dms', [...memberIds, user.id]);
    return reply.status(204).send();
  });

  /** Rings the other members ("X is calling"); the caller joins the DM's voice room as usual. */
  app.post('/dms/:channelId/call', { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { channelId } = parseInput(dmParams, request.params);
    const user = getAuth(request).user;
    const channel = await channels.getVisible(user, channelId);
    if (!(await channels.canWriteDm(user, channel))) throw notFriends();
    const dm = await channels.getDmView(channel.id);
    ctx.publisher.callRing(channelId, user.id, dm.memberIds ?? []);
    return reply.status(204).send();
  });
}
