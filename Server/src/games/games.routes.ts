import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app-context.js';
import { getAuth } from '../auth/auth.hooks.js';
import { Errors } from '../common/errors.js';
import { parseInput } from '../common/validation.js';

const userParams = z.object({ userId: z.uuid() });
const gameParams = z.object({ gameId: z.uuid() });

/** Game tracker. Others see a person's games like the rest of the profile (and not when hidden). */
export function gamesRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { requireAuth } = ctx.hooks;
  const { tracker } = ctx.services;

  app.get('/users/me/games/prompts', { preHandler: requireAuth }, async (request) => ({ games: await tracker.prompts(getAuth(request).user) }));

  app.get('/users/:userId/games', { preHandler: requireAuth }, async (request) => {
    const { userId } = parseInput(userParams, request.params);
    if (!(await ctx.services.friends.canSee(getAuth(request).user, userId))) throw Errors.notFound('User');
    return tracker.list(getAuth(request).user, userId);
  });

  app.post('/users/me/games', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const game = await tracker.add(getAuth(request).user, request.body);
    return reply.status(201).send({ game });
  });

  app.patch('/users/me/games/:gameId', { preHandler: requireAuth }, async (request) => {
    const { gameId } = parseInput(gameParams, request.params);
    return { game: await tracker.update(getAuth(request).user, gameId, request.body) };
  });

  app.delete('/users/me/games/:gameId', { preHandler: requireAuth }, async (request, reply) => {
    const { gameId } = parseInput(gameParams, request.params);
    await tracker.remove(getAuth(request).user, gameId);
    return reply.status(204).send();
  });

  app.post('/users/me/games/:gameId/prompted', { preHandler: requireAuth }, async (request, reply) => {
    const { gameId } = parseInput(gameParams, request.params);
    await tracker.markPrompted(getAuth(request).user, gameId);
    return reply.status(204).send();
  });
}
