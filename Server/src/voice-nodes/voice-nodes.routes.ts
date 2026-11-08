import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app-context.js';
import { getAuth } from '../auth/auth.hooks.js';
import { parseInput } from '../common/validation.js';

const idParams = z.object({ id: z.uuid() });
const guildParams = z.object({ guildId: z.uuid() });

/** 0.7.1 extra voice servers: managed by the superadmin; servers see the nodes given to them. */
export function voiceNodesRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { voiceNodes, audit, permissions } = ctx.services;
  const { requireAdmin, requireAuth } = ctx.hooks;

  app.get('/admin/voice-nodes', { preHandler: requireAdmin }, async () => ({ main: voiceNodes.main(), nodes: await voiceNodes.list() }));

  app.post('/admin/voice-nodes', { preHandler: requireAdmin }, async (request, reply) => {
    const node = await voiceNodes.create(request.body);
    await audit.record(getAuth(request).user.id, 'voice_node.created', { type: 'voice_node', id: node.id }, { name: node.name, url: node.url });
    return reply.status(201).send({ node });
  });

  app.patch('/admin/voice-nodes/:id', { preHandler: requireAdmin }, async (request) => {
    const { id } = parseInput(idParams, request.params);
    const node = await voiceNodes.update(id, request.body);
    await audit.record(getAuth(request).user.id, 'voice_node.updated', { type: 'voice_node', id }, { name: node.name, enabled: node.enabled, guildIds: node.guildIds });
    return { node };
  });

  app.delete('/admin/voice-nodes/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = parseInput(idParams, request.params);
    const row = await voiceNodes.remove(id);
    await audit.record(getAuth(request).user.id, 'voice_node.deleted', { type: 'voice_node', id }, { name: row.name, url: row.url });
    return reply.status(204).send();
  });

  app.post('/admin/voice-nodes/:id/check', { preHandler: requireAdmin }, async (request) => {
    const { id } = parseInput(idParams, request.params);
    await voiceNodes.check(id);
    return { node: await voiceNodes.get(id) };
  });

  // Channel settings: the nodes this server may put a voice channel on.
  app.get('/guilds/:guildId/voice-nodes', { preHandler: requireAuth }, async (request) => {
    const { guildId } = parseInput(guildParams, request.params);
    await permissions.requireGuild(getAuth(request).user, guildId, 'MANAGE_CHANNELS');
    return { nodes: await voiceNodes.forGuild(guildId) };
  });
}
