import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app-context.js';
import { getAuth } from '../auth/auth.hooks.js';
import { parseInput } from '../common/validation.js';

const guildParams = z.object({ guildId: z.uuid() });
const codeParams = z.object({ code: z.string().min(1).max(200) });
const guessLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

/** 0.7.0 invites. Preview and accept are rate limited (codes must not be guessable by brute force). */
export function invitesRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { invites, audit } = ctx.services;
  const { requireAuth } = ctx.hooks;

  app.post('/guilds/:guildId/invites', { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { guildId } = parseInput(guildParams, request.params);
    const user = getAuth(request).user;
    const invite = await invites.create(user, guildId, request.body);
    await audit.record(user.id, 'invite.created', { type: 'invite', id: invite.code }, { maxUses: invite.maxUses, expiresAt: invite.expiresAt }, guildId);
    return reply.status(201).send({ invite });
  });

  app.get('/guilds/:guildId/invites', { preHandler: requireAuth }, async (request) => {
    const { guildId } = parseInput(guildParams, request.params);
    return { invites: await invites.list(getAuth(request).user, guildId) };
  });

  app.delete('/invites/:code', { preHandler: requireAuth }, async (request, reply) => {
    const { code } = parseInput(codeParams, request.params);
    const user = getAuth(request).user;
    const invite = await invites.revoke(user, code);
    await audit.record(user.id, 'invite.revoked', { type: 'invite', id: invite.code }, {}, invite.guildId);
    return reply.status(204).send();
  });

  app.get('/invites/:code', { preHandler: requireAuth, config: guessLimit }, async (request) => {
    const { code } = parseInput(codeParams, request.params);
    return { invite: await invites.preview(getAuth(request).user, code) };
  });

  app.post('/invites/:code/accept', { preHandler: requireAuth, config: guessLimit }, async (request) => {
    const { code } = parseInput(codeParams, request.params);
    return invites.accept(getAuth(request).user, code);
  });
}
