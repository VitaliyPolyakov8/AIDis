import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app-context.js';
import { getAuth } from '../auth/auth.hooks.js';
import { parseInput } from '../common/validation.js';

const guildParams = z.object({ guildId: z.uuid() });

/** 0.7.0 servers. */
export function guildsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { guilds } = ctx.services;
  const { requireAuth, requireAdmin } = ctx.hooks;

  app.get('/guilds', { preHandler: requireAuth }, async (request) => ({ guilds: await guilds.listMine(getAuth(request).user) }));

  app.post('/guilds', { preHandler: requireAuth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const guild = await guilds.create(getAuth(request).user, request.body);
    return reply.status(201).send({ guild });
  });

  app.get('/guilds/:guildId', { preHandler: requireAuth }, async (request) => {
    const { guildId } = parseInput(guildParams, request.params);
    return { guild: await guilds.myView(getAuth(request).user, guildId) };
  });

  app.patch('/guilds/:guildId', { preHandler: requireAuth }, async (request) => {
    const { guildId } = parseInput(guildParams, request.params);
    return { guild: await guilds.update(getAuth(request).user, guildId, request.body) };
  });

  app.delete('/guilds/:guildId', { preHandler: requireAuth }, async (request, reply) => {
    const { guildId } = parseInput(guildParams, request.params);
    await guilds.delete(getAuth(request).user, guildId, request.body ?? {});
    return reply.status(204).send();
  });

  app.post('/guilds/:guildId/transfer', { preHandler: requireAuth }, async (request) => {
    const { guildId } = parseInput(guildParams, request.params);
    return { guild: await guilds.transfer(getAuth(request).user, guildId, request.body) };
  });

  app.delete('/guilds/:guildId/members/me', { preHandler: requireAuth }, async (request, reply) => {
    const { guildId } = parseInput(guildParams, request.params);
    await guilds.leave(getAuth(request).user, guildId);
    return reply.status(204).send();
  });

  app.patch('/guilds/:guildId/members/me/profile', { preHandler: requireAuth }, async (request) => {
    const { guildId } = parseInput(guildParams, request.params);
    return { member: await guilds.updateMyProfile(getAuth(request).user, guildId, request.body) };
  });

  app.patch('/guilds/:guildId/members/me/settings', { preHandler: requireAuth }, async (request, reply) => {
    const { guildId } = parseInput(guildParams, request.params);
    await guilds.updateMySettings(getAuth(request).user, guildId, request.body);
    return reply.status(204).send();
  });

  app.get('/guilds/:guildId/members', { preHandler: requireAuth }, async (request) => {
    const { guildId } = parseInput(guildParams, request.params);
    return { members: await guilds.members(getAuth(request).user, guildId) };
  });

  app.put('/me/guild-order', { preHandler: requireAuth }, async (request, reply) => {
    await guilds.setRailOrder(getAuth(request).user, request.body);
    return reply.status(204).send();
  });

  app.get('/admin/guilds', { preHandler: requireAdmin }, async () => ({ guilds: await guilds.listAll() }));
}
