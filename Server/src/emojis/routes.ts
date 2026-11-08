import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app-context.js';
import { getAuth } from '../auth/auth.hooks.js';
import { parseInput } from '../common/validation.js';
import { Errors } from '../common/errors.js';
import { MAX_EMOJI_BYTES } from './service.js';

const params = z.object({ emojiId: z.uuid() });
const guildParams = z.object({ guildId: z.uuid() });
const nameInput = z.object({ name: z.string().max(128) });

export function emojisRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { requireAuth } = ctx.hooks;
  const { emojis } = ctx.services;

  /** Emojis of all my servers. */
  app.get('/emojis', { preHandler: requireAuth }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { emojis: await emojis.list(getAuth(request).user) };
  });

  app.post('/guilds/:guildId/emojis', { preHandler: requireAuth, bodyLimit: MAX_EMOJI_BYTES, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { guildId } = parseInput(guildParams, request.params);
    const { name } = parseInput(nameInput, request.query);
    if (!request.headers['content-type']?.startsWith('application/octet-stream') || !(request.body instanceof Readable)) throw Errors.badRequest('EMOJI_FORMAT', 'Send an image file');
    const emoji = await emojis.create(getAuth(request).user, guildId, name, request.body);
    return reply.status(201).send({ emoji });
  });

  app.get('/emojis/:emojiId/content', { preHandler: requireAuth, config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { emojiId } = parseInput(params, request.params);
    const row = await emojis.get(emojiId);
    const { stream } = await emojis.storage.open(row.storedName);
    return reply
      .header('Content-Type', row.mimeType)
      .header('Content-Length', row.size)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cache-Control', 'private, max-age=86400')
      .send(stream);
  });

  app.patch('/emojis/:emojiId', { preHandler: requireAuth }, async (request) => {
    const { emojiId } = parseInput(params, request.params);
    const { name } = parseInput(nameInput, request.body);
    return { emoji: await emojis.rename(getAuth(request).user, emojiId, name) };
  });

  app.delete('/emojis/:emojiId', { preHandler: requireAuth }, async (request, reply) => {
    const { emojiId } = parseInput(params, request.params);
    await emojis.remove(getAuth(request).user, emojiId);
    return reply.status(204).send();
  });
}
