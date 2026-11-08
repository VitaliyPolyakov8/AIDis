import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app-context.js';
import { getAuth } from '../auth/auth.hooks.js';
import { parseInput } from '../common/validation.js';
import { Errors } from '../common/errors.js';
import { toPublicUser } from '../users/user.dto.js';

const guildParams = z.object({ guildId: z.uuid() });
const roleParams = z.object({ guildId: z.uuid(), roleId: z.uuid() });
const memberParams = z.object({ guildId: z.uuid(), userId: z.uuid() });
const userParams = z.object({ userId: z.uuid() });
const permsQuery = z.object({ channelId: z.uuid().optional() });
const auditQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), before: z.uuid().optional(), guildId: z.uuid().optional() });

/** 0.7.0 server roles, moderation, effective permissions, badges and audit logs. */
export function rolesRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { roles, permissions, audit, users, moderation, channels } = ctx.services;
  const { requireAuth, requireAdmin } = ctx.hooks;

  /** Own effective permissions on a server, or in one of its channels (the UI hides what you cannot do). */
  app.get('/guilds/:guildId/permissions', { preHandler: requireAuth }, async (request) => {
    const { guildId } = parseInput(guildParams, request.params);
    const { channelId } = parseInput(permsQuery, request.query);
    const user = getAuth(request).user;
    await permissions.requireGuild(user, guildId);
    if (!channelId) return { permissions: [...(await permissions.guildPermissions(user, guildId))], all: permissions.all() };
    const channel = await channels.getVisible(user, channelId);
    if (channel.guildId !== guildId) throw Errors.notFound('Channel');
    return { permissions: [...(await permissions.channelPermissions(user, channel))], all: permissions.all() };
  });

  app.get('/guilds/:guildId/roles', { preHandler: requireAuth }, async (request) => {
    const { guildId } = parseInput(guildParams, request.params);
    return { roles: await roles.list(getAuth(request).user, guildId) };
  });

  app.post('/guilds/:guildId/roles', { preHandler: requireAuth }, async (request, reply) => {
    const { guildId } = parseInput(guildParams, request.params);
    const user = getAuth(request).user;
    const role = await roles.create(user, guildId, request.body);
    await audit.record(user.id, 'role.created', { type: 'role', id: role.id }, { name: role.name, permissions: role.permissions }, guildId);
    ctx.publisher.rolesChanged(guildId);
    return reply.status(201).send({ role });
  });

  app.put('/guilds/:guildId/roles/order', { preHandler: requireAuth }, async (request, reply) => {
    const { guildId } = parseInput(guildParams, request.params);
    const user = getAuth(request).user;
    await roles.reorder(user, guildId, request.body);
    await audit.record(user.id, 'role.reordered', null, {}, guildId);
    ctx.publisher.rolesChanged(guildId);
    return reply.status(204).send();
  });

  app.patch('/guilds/:guildId/roles/:roleId', { preHandler: requireAuth }, async (request) => {
    const { guildId, roleId } = parseInput(roleParams, request.params);
    const user = getAuth(request).user;
    const { before, after } = await roles.update(user, guildId, roleId, request.body);
    await audit.record(user.id, 'role.updated', { type: 'role', id: roleId }, { name: after.name, ...(before.name !== after.name ? { renamedFrom: before.name } : {}), permissions: after.permissions }, guildId);
    ctx.publisher.rolesChanged(guildId);
    return { role: after };
  });

  app.delete('/guilds/:guildId/roles/:roleId', { preHandler: requireAuth }, async (request, reply) => {
    const { guildId, roleId } = parseInput(roleParams, request.params);
    const user = getAuth(request).user;
    const role = await roles.delete(user, guildId, roleId);
    await audit.record(user.id, 'role.deleted', { type: 'role', id: roleId }, { name: role.name }, guildId);
    ctx.publisher.rolesChanged(guildId);
    return reply.status(204).send();
  });

  app.put('/guilds/:guildId/members/:userId/roles', { preHandler: requireAuth }, async (request) => {
    const { guildId, userId } = parseInput(memberParams, request.params);
    const user = getAuth(request).user;
    const { before, after } = await roles.setMemberRoles(user, guildId, userId, request.body);
    const target = await users.getById(userId);
    await audit.record(user.id, 'user.roles_changed', { type: 'user', id: userId }, { user: target.displayName, before, after }, guildId);
    ctx.publisher.rolesChanged(guildId);
    const member = await ctx.services.guilds.member(guildId, userId);
    if (member) ctx.publisher.memberUpdated(guildId, member, await permissions.guildAudience(guildId));
    return { roleIds: after };
  });

  // ---- moderation ------------------------------------------------------------------------------

  app.patch('/guilds/:guildId/members/:userId', { preHandler: requireAuth }, async (request) => {
    const { guildId, userId } = parseInput(memberParams, request.params);
    return { member: await moderation.setNickname(getAuth(request).user, guildId, userId, request.body) };
  });

  app.delete('/guilds/:guildId/members/:userId', { preHandler: requireAuth }, async (request, reply) => {
    const { guildId, userId } = parseInput(memberParams, request.params);
    await moderation.kick(getAuth(request).user, guildId, userId);
    return reply.status(204).send();
  });

  app.get('/guilds/:guildId/bans', { preHandler: requireAuth }, async (request) => {
    const { guildId } = parseInput(guildParams, request.params);
    return { bans: await moderation.bans(getAuth(request).user, guildId) };
  });

  app.put('/guilds/:guildId/bans/:userId', { preHandler: requireAuth }, async (request, reply) => {
    const { guildId, userId } = parseInput(memberParams, request.params);
    await moderation.ban(getAuth(request).user, guildId, userId, request.body);
    return reply.status(204).send();
  });

  app.delete('/guilds/:guildId/bans/:userId', { preHandler: requireAuth }, async (request, reply) => {
    const { guildId, userId } = parseInput(memberParams, request.params);
    await moderation.unban(getAuth(request).user, guildId, userId);
    return reply.status(204).send();
  });

  // ---- badges (instance-wide, superadmin) and audit logs -----------------------------------------

  app.get('/badges', { preHandler: requireAuth }, async () => ({ badges: await roles.badges() }));

  app.put('/users/:userId/badges', { preHandler: requireAdmin }, async (request) => {
    const user = getAuth(request).user;
    const { userId } = parseInput(userParams, request.params);
    const badges = await roles.setUserBadges(userId, request.body);
    const target = await users.getById(userId);
    await audit.record(user.id, 'user.badges_changed', { type: 'user', id: userId }, { user: target.displayName, badges });
    ctx.publisher.userUpdated(toPublicUser(await users.getFull(userId)));
    return { badges };
  });

  app.get('/guilds/:guildId/audit', { preHandler: requireAuth }, async (request) => {
    const { guildId } = parseInput(guildParams, request.params);
    await permissions.requireGuild(getAuth(request).user, guildId, 'VIEW_AUDIT_LOG');
    const { limit, before } = parseInput(auditQuery, request.query);
    return { entries: await audit.list(limit, before, guildId) };
  });

  /** Superadmin: instance-wide entries, or one server's with ?guildId=. */
  app.get('/admin/audit', { preHandler: requireAdmin }, async (request) => {
    const { limit, before, guildId } = parseInput(auditQuery, request.query);
    return { entries: await audit.list(limit, before, guildId ?? null) };
  });
}
