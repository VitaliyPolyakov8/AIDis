import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app-context.js';
import { getAuth } from '../auth/auth.hooks.js';
import { parseInput } from '../common/validation.js';
import { GalleryService } from './gallery.service.js';

const params = z.object({ channelId: z.uuid() });
export function galleryRoutes(app: FastifyInstance, ctx: AppContext): void {
  const gallery = new GalleryService(ctx.prisma, ctx.services.channels, ctx.services.permissions);
  app.get('/channels/:channelId/gallery', { preHandler: ctx.hooks.requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request) => {
    const { channelId } = parseInput(params, request.params);
    return gallery.list(getAuth(request).user, channelId, request.query);
  });
}
