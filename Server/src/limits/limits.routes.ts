import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app-context.js';
import { getAuth } from '../auth/auth.hooks.js';
import { parseInput } from '../common/validation.js';

const globalBody = z.object({ values: z.record(z.string().max(48), z.number().int().nullable()) });
const overrideBody = z.object({ key: z.string().max(48), scope: z.enum(['GUILD', 'USER']), targetId: z.uuid(), value: z.number().int().nullable() });

/** 0.7.0 superadmin limits: global values and exceptions for one server or one user. */
export function limitsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { limits, audit } = ctx.services;
  const { requireAdmin } = ctx.hooks;

  app.get('/admin/limits', { preHandler: requireAdmin }, async () => limits.view());

  app.put('/admin/limits', { preHandler: requireAdmin }, async (request, reply) => {
    const { values } = parseInput(globalBody, request.body);
    await limits.setGlobal(values);
    await audit.record(getAuth(request).user.id, 'limits.changed', null, { values });
    return reply.status(204).send();
  });

  app.put('/admin/limits/overrides', { preHandler: requireAdmin }, async (request, reply) => {
    const body = parseInput(overrideBody, request.body);
    await limits.setOverride(body.key, body.scope, body.targetId, body.value);
    await audit.record(getAuth(request).user.id, 'limits.changed', { type: body.scope === 'GUILD' ? 'guild' : 'user', id: body.targetId }, { key: body.key, value: body.value });
    return reply.status(204).send();
  });
}
