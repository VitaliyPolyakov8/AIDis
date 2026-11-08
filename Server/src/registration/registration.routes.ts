import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app-context.js';
import { getAuth } from '../auth/auth.hooks.js';
import { AppError } from '../common/errors.js';
import { parseInput } from '../common/validation.js';

const codeParams = z.object({ code: z.string().min(1).max(200) });
const linkLimit = { rateLimit: { max: 20, timeWindow: '1 minute' } };

/** 0.7.1 registration, e-mail links and password reset (all public except the e-mail change). */
export function registrationRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { registration, audit, invites } = ctx.services;
  const { requireAuth, requireAdmin } = ctx.hooks;

  app.get('/auth/registration', async () => registration.state());

  app.put('/admin/registration', { preHandler: requireAdmin }, async (request) => {
    const state = await registration.setMode(request.body);
    await audit.record(getAuth(request).user.id, 'registration.updated', { type: 'settings', id: 'registration' }, { mode: state.mode });
    return state;
  });

  app.post('/auth/register', { config: linkLimit }, async (request, reply) => {
    await registration.register(request.body, request.ip);
    return reply.status(202).send({ ok: true });
  });

  app.post('/auth/verify-email', { config: linkLimit }, async (request) => registration.verify(request.body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }));

  app.post('/auth/password-reset', { config: linkLimit }, async (request, reply) => {
    await registration.requestReset(request.body, request.ip);
    return reply.status(202).send({ ok: true });
  });

  app.post('/auth/password-reset/confirm', { config: linkLimit }, async (request, reply) => {
    await registration.confirmReset(request.body);
    return reply.status(204).send();
  });

  app.get('/users/me/email', { preHandler: requireAuth }, async (request) => registration.emailOf(getAuth(request).user.id));

  app.put('/users/me/email', { preHandler: requireAuth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    await registration.changeEmail(getAuth(request).user, request.body);
    return reply.status(202).send({ ok: true });
  });

  // The invite page for someone without an account (only while registration is on).
  app.get('/invites/:code/public', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request) => {
    const { code } = parseInput(codeParams, request.params);
    if ((await registration.state()).mode === 'off') throw new AppError(404, 'INVITE_INVALID', 'This invite is invalid or has expired');
    return { invite: await invites.publicPreview(code) };
  });
}
