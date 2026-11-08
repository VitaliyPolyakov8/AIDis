import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app-context.js';
import { getAuth } from '../auth/auth.hooks.js';
import { parseInput } from '../common/validation.js';

const params = z.object({ attachmentId: z.uuid() });
export function voiceMessageRoutes(app: FastifyInstance, ctx: AppContext): void {
  const service = ctx.services.voiceMessages;
  if (!service) return;
  app.post('/attachments/:attachmentId/voice-message', { preHandler: ctx.hooks.requireAuth, config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async request => {
    const { attachmentId } = parseInput(params, request.params);
    return { voiceMessage: await service.register(getAuth(request).user, attachmentId) };
  });
  app.get('/attachments/:attachmentId/voice-message', { preHandler: ctx.hooks.requireAuth }, async request => {
    const { attachmentId } = parseInput(params, request.params);
    return { voiceMessage: await service.get(getAuth(request).user, attachmentId) };
  });
}
