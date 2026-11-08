import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app-context.js';
import { getAuth } from '../auth/auth.hooks.js';
import { Errors } from '../common/errors.js';
import { parseInput } from '../common/validation.js';
import { MAX_SOUND_BYTES } from './sounds.service.js';

const params = z.object({ soundId: z.uuid() });
const guildParams = z.object({ guildId: z.uuid() });

/** 0.7.1 server soundboard sounds. */
export function soundsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { requireAuth } = ctx.hooks;
  const { sounds } = ctx.services;

  app.get('/guilds/:guildId/sounds', { preHandler: requireAuth }, async (request, reply) => {
    const { guildId } = parseInput(guildParams, request.params);
    reply.header('Cache-Control', 'no-store');
    return { sounds: await sounds.list(getAuth(request).user, guildId) };
  });

  // The file is the body (application/octet-stream); name / emoji / volume are in the query.
  app.post('/guilds/:guildId/sounds', { preHandler: requireAuth, bodyLimit: MAX_SOUND_BYTES, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { guildId } = parseInput(guildParams, request.params);
    if (!request.headers['content-type']?.startsWith('application/octet-stream') || !(request.body instanceof Readable)) throw Errors.badRequest('SOUND_TYPE', 'Send an audio file');
    const sound = await sounds.create(getAuth(request).user, guildId, request.query, request.body);
    return reply.status(201).send({ sound });
  });

  app.get('/sounds/:soundId/content', { preHandler: requireAuth, config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { soundId } = parseInput(params, request.params);
    const row = await sounds.readable(getAuth(request).user, soundId);
    const { stream } = await sounds.storage.open(row.storedName);
    return reply
      .header('Content-Type', row.mimeType)
      .header('Content-Length', row.size)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cache-Control', 'private, max-age=86400')
      .send(stream);
  });

  app.patch('/sounds/:soundId', { preHandler: requireAuth }, async (request) => {
    const { soundId } = parseInput(params, request.params);
    return { sound: await sounds.update(getAuth(request).user, soundId, request.body) };
  });

  app.delete('/sounds/:soundId', { preHandler: requireAuth }, async (request, reply) => {
    const { soundId } = parseInput(params, request.params);
    await sounds.remove(getAuth(request).user, soundId);
    return reply.status(204).send();
  });
}
