import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app-context.js';
import { getAuth } from '../auth/auth.hooks.js';
import { parseInput } from '../common/validation.js';
import { toChannelView } from './channels.service.js';

const guildParams = z.object({ guildId: z.uuid() });
const channelParams = z.object({ channelId: z.uuid() });

export function channelsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { channels, reads, audit, messages, overwrites } = ctx.services;
  const { requireAuth } = ctx.hooks;

  /** Channels and categories of a server the caller may see (hidden ones are filtered on the server). */
  app.get('/guilds/:guildId/channels', { preHandler: requireAuth }, async (request) => {
    const { guildId } = parseInput(guildParams, request.params);
    return { channels: await channels.listVisible(getAuth(request).user, guildId) };
  });

  app.get('/channels/:channelId', { preHandler: requireAuth }, async (request) => {
    const { channelId } = parseInput(channelParams, request.params);
    const user = getAuth(request).user;
    const channel = await channels.getVisible(user, channelId);
    return { channel: await channels.viewFor(user, channel) };
  });

  // ---- management (MANAGE_CHANNELS / MANAGE_ROLES, checked by the services) ---------------------

  app.post('/guilds/:guildId/channels', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { guildId } = parseInput(guildParams, request.params);
    const user = getAuth(request).user;
    const channel = await channels.create(user, guildId, request.body);
    await audit.record(user.id, 'channel.created', { type: 'channel', id: channel.id }, { name: channel.name, type: channel.type }, guildId);
    ctx.publisher.channelsChanged('channels', undefined, guildId);
    return reply.status(201).send({ channel: toChannelView(channel) });
  });

  app.patch('/channels/:channelId', { preHandler: requireAuth }, async (request) => {
    const user = getAuth(request).user;
    const { channelId } = parseInput(channelParams, request.params);
    const { before, after } = await channels.update(user, channelId, request.body);
    await audit.record(
      user.id,
      'channel.updated',
      { type: 'channel', id: channelId },
      {
        name: after.name,
        ...(before.name !== after.name ? { renamedFrom: before.name } : {}),
        ...(before.parentId !== after.parentId ? { parentId: after.parentId } : {}),
        ...(before.permissionsSynced !== after.permissionsSynced ? { permissionsSynced: after.permissionsSynced } : {}),
        ...(before.voiceBitrate !== after.voiceBitrate ? { voiceBitrate: after.voiceBitrate } : {}),
        ...(before.voiceLayout !== after.voiceLayout ? { voiceLayout: after.voiceLayout } : {}),
      },
      after.guildId,
    );
    ctx.publisher.channelsChanged('channels', undefined, after.guildId ?? undefined);
    return { channel: await channels.viewFor(user, after) };
  });

  app.delete('/channels/:channelId', { preHandler: requireAuth }, async (request, reply) => {
    const user = getAuth(request).user;
    const { channelId } = parseInput(channelParams, request.params);
    const channel = await channels.delete(user, channelId);
    await audit.record(user.id, 'channel.deleted', { type: 'channel', id: channelId }, { name: channel.name, type: channel.type }, channel.guildId);
    // Members may lose a channel they were in: everyone of the server recomputes.
    ctx.publisher.channelsChanged('channels', undefined, channel.guildId ?? undefined);
    return reply.status(204).send();
  });

  app.put('/guilds/:guildId/channels/order', { preHandler: requireAuth }, async (request, reply) => {
    const { guildId } = parseInput(guildParams, request.params);
    const user = getAuth(request).user;
    await channels.reorder(user, guildId, request.body);
    await audit.record(user.id, 'channel.reordered', null, {}, guildId);
    ctx.publisher.channelsChanged('channels', undefined, guildId);
    return reply.status(204).send();
  });

  app.put('/channels/:channelId/overwrites/:targetType/:targetId', { preHandler: requireAuth }, async (request) => {
    const user = getAuth(request).user;
    const overwrite = await overwrites.set(user, request.params, request.body);
    const channel = await channels.get((request.params as { channelId: string }).channelId);
    await audit.record(user.id, 'channel.overwrite_changed', { type: 'channel', id: channel.id }, { ...overwrite }, channel.guildId);
    ctx.publisher.channelsChanged('channels', undefined, channel.guildId ?? undefined);
    return { overwrite };
  });

  app.delete('/channels/:channelId/overwrites/:targetType/:targetId', { preHandler: requireAuth }, async (request, reply) => {
    const user = getAuth(request).user;
    const channel = await overwrites.remove(user, request.params);
    await audit.record(user.id, 'channel.overwrite_changed', { type: 'channel', id: channel.id }, { removed: request.params }, channel.guildId);
    ctx.publisher.channelsChanged('channels', undefined, channel.guildId ?? undefined);
    return reply.status(204).send();
  });

  // ---- read state & notifications (0.4.0) -----------------------------------------------------

  /** Unread / mention counts, read markers and notification modes for every visible channel and DM. */
  app.get('/reads', { preHandler: requireAuth }, async (request) => {
    const user = getAuth(request).user;
    const [chats, dms] = await Promise.all([channels.listAllVisible(user), channels.listDms(user)]);
    const list = [...chats, ...dms].map((c) => ({ id: c.id, createdAt: new Date(c.createdAt), guildId: c.guildId }));
    return { reads: await reads.states(user, list) };
  });

  app.post('/channels/:channelId/read', { preHandler: requireAuth, config: { rateLimit: { max: 240, timeWindow: '1 minute' } } }, async (request) => {
    const user = getAuth(request).user;
    const { channelId } = parseInput(channelParams, request.params);
    const channel = await channels.getVisible(user, channelId);
    const state = await reads.markRead(user, channel, request.body);
    ctx.publisher.readUpdated(user.id, state);
    return { read: state };
  });

  app.put('/channels/:channelId/notify', { preHandler: requireAuth }, async (request) => {
    const user = getAuth(request).user;
    const { channelId } = parseInput(channelParams, request.params);
    const channel = await channels.getVisible(user, channelId);
    const state = await reads.setNotifyMode(user, channel, request.body);
    ctx.publisher.readUpdated(user.id, state);
    return { read: state };
  });

  app.get('/channels/:channelId/pins', { preHandler: requireAuth }, async (request) => {
    const { channelId } = parseInput(channelParams, request.params);
    return { messages: await messages.pins(getAuth(request).user, channelId) };
  });
}
