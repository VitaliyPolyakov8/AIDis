import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app-context.js';
import { getAuth } from '../auth/auth.hooks.js';

/** 0.7.1 SMTP settings for the superadmin. */
export function mailRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { mail, audit } = ctx.services;
  const { requireAdmin } = ctx.hooks;

  app.get('/admin/mail', { preHandler: requireAdmin }, async () => ({ mail: await mail.get() }));

  app.put('/admin/mail', { preHandler: requireAdmin }, async (request) => {
    const view = await mail.save(request.body);
    await audit.record(getAuth(request).user.id, 'mail.updated', { type: 'settings', id: 'mail' }, { host: view.host, port: view.port, fromAddress: view.fromAddress });
    return { mail: view };
  });

  app.post('/admin/mail/test', { preHandler: requireAdmin }, async (request) => ({ mail: await mail.sendTest(request.body) }));
}
