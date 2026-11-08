import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app-context.js';
import { getAuth } from '../auth/auth.hooks.js';
import { parseInput } from '../common/validation.js';

const userParams = z.object({ userId: z.uuid() });

/** 0.7.0 friends and friend requests. */
export function friendsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { friends } = ctx.services;
  const { requireAuth } = ctx.hooks;

  app.get('/friends', { preHandler: requireAuth }, async (request) => friends.state(getAuth(request).user));

  app.post('/friends/requests', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => friends.request(getAuth(request).user, request.body));

  app.post('/friends/requests/:userId/accept', { preHandler: requireAuth }, async (request, reply) => {
    const { userId } = parseInput(userParams, request.params);
    await friends.accept(getAuth(request).user, userId);
    return reply.status(204).send();
  });

  app.delete('/friends/requests/:userId', { preHandler: requireAuth }, async (request, reply) => {
    const { userId } = parseInput(userParams, request.params);
    await friends.decline(getAuth(request).user, userId);
    return reply.status(204).send();
  });

  app.delete('/friends/:userId', { preHandler: requireAuth }, async (request, reply) => {
    const { userId } = parseInput(userParams, request.params);
    await friends.remove(getAuth(request).user, userId);
    return reply.status(204).send();
  });
}
