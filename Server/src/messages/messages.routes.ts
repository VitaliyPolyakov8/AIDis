import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app-context.js';
import { getAuth } from '../auth/auth.hooks.js';
import { parseInput } from '../common/validation.js';

const channelParams = z.object({ channelId: z.uuid() });
const messageParams = z.object({ messageId: z.uuid() });
const reactionParams = z.object({ messageId: z.uuid(), emoji: z.string().min(1).max(64) });

export function messagesRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { messages } = ctx.services;
  const { requireAuth } = ctx.hooks;

  app.get('/channels/:channelId/messages', { preHandler: requireAuth }, async (request) => {
    const { channelId } = parseInput(channelParams, request.params);
    return messages.history(getAuth(request).user, channelId, request.query);
  });

  app.post(
    '/channels/:channelId/messages',
    { preHandler: requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { channelId } = parseInput(channelParams, request.params);
      const result = await messages.send(getAuth(request).user, channelId, request.body);
      // Audio is already safely attached. A transcription/storage failure must not lose the message.
      await ctx.services.voiceMessages?.queueAttached(result.message.attachments.map(a => a.id)).catch((error: unknown) => {
        request.log.error({ err: error }, 'Could not queue local voice transcription');
      });
      // 201 for a new message, 200 when the nonce matched an already stored message.
      return reply.status(result.created ? 201 : 200).send({ message: result.message });
    },
  );

  app.get('/messages/:messageId', { preHandler: requireAuth }, async (request) => {
    const { messageId } = parseInput(messageParams, request.params);
    return { message: await messages.getView(getAuth(request).user, messageId) };
  });

  app.patch('/messages/:messageId', { preHandler: requireAuth }, async (request) => {
    const { messageId } = parseInput(messageParams, request.params);
    return { message: await messages.edit(getAuth(request).user, messageId, request.body) };
  });

  app.delete('/messages/:messageId', { preHandler: requireAuth }, async (request, reply) => {
    const { messageId } = parseInput(messageParams, request.params);
    await messages.delete(getAuth(request).user, messageId);
    return reply.status(204).send();
  });

  // ---- 0.4.0 -------------------------------------------------------------------------------

  /** Add a reaction (emoji is URL-encoded in the path). Idempotent. */
  app.put('/messages/:messageId/reactions/:emoji', { preHandler: requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request) => {
    const { messageId, emoji } = parseInput(reactionParams, request.params);
    return messages.react(getAuth(request).user, messageId, emoji, true);
  });

  app.delete('/messages/:messageId/reactions/:emoji', { preHandler: requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request) => {
    const { messageId, emoji } = parseInput(reactionParams, request.params);
    return messages.react(getAuth(request).user, messageId, emoji, false);
  });

  app.put('/messages/:messageId/pin', { preHandler: requireAuth }, async (request) => {
    const { messageId } = parseInput(messageParams, request.params);
    return { message: await messages.setPinned(getAuth(request).user, messageId, true) };
  });

  app.delete('/messages/:messageId/pin', { preHandler: requireAuth }, async (request) => {
    const { messageId } = parseInput(messageParams, request.params);
    return { message: await messages.setPinned(getAuth(request).user, messageId, false) };
  });

  /** Search: ?q=&channelId=&authorId=&from=&to=&limit= over channels / DMs the caller can see. */
  app.get('/search/messages', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request) => {
    return { messages: await messages.search(getAuth(request).user, request.query) };
  });
}
