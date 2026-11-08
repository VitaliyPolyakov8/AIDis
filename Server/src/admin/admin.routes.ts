import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app-context.js';
import { getAuth } from '../auth/auth.hooks.js';
import { Errors } from '../common/errors.js';
import { parseInput } from '../common/validation.js';
import { toAdminUserView, toPublicUser } from '../users/user.dto.js';
import { passwordSchema, roleSchema } from '../users/users.service.js';
import { SERVER_VERSION } from '../health/health.routes.js';

const userParams = z.object({ userId: z.uuid() });
const disabledBody = z.object({ disabled: z.boolean() });
const passwordBody = z.object({ password: passwordSchema });
const roleBody = z.object({ role: roleSchema });

/**
 * ADMIN-only account management over HTTP (the same operations as the CLI).
 * This is not registration: only an authenticated ADMIN can create accounts.
 */
export function adminRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { users, auth } = ctx.services;
  const { requireAdmin } = ctx.hooks;

  app.get('/admin/users', { preHandler: requireAdmin }, async () => {
    return { users: (await users.listFull()).map(toAdminUserView) };
  });

  app.post('/admin/users', { preHandler: requireAdmin }, async (request, reply) => {
    // 0.7.0: until self-registration exists, the superadmin picks the servers a new account joins.
    const { guildIds } = parseInput(z.object({ guildIds: z.array(z.uuid()).max(50).default([]) }), request.body ?? {});
    const user = await users.create(request.body as Record<string, unknown>);
    for (const guildId of [...new Set(guildIds)]) await ctx.services.guilds.join(user.id, guildId);
    ctx.services.permissions.invalidate();
    request.log.info({ event: 'admin.user_created', userId: user.id, by: getAuth(request).user.id }, 'User created');
    await ctx.services.audit.record(getAuth(request).user.id, 'user.created', { type: 'user', id: user.id }, { user: user.displayName });
    return reply.status(201).send({ user: toAdminUserView(user) });
  });

  app.patch('/admin/users/:userId/disabled', { preHandler: requireAdmin }, async (request) => {
    const { userId } = parseInput(userParams, request.params);
    const { disabled } = parseInput(disabledBody, request.body);
    if (disabled && userId === getAuth(request).user.id) {
      throw Errors.badRequest('CANNOT_DISABLE_SELF', 'You cannot disable your own account');
    }
    const user = await users.setDisabled(userId, disabled);
    ctx.services.permissions.invalidate();
    if (disabled) ctx.publisher.disconnectUser(userId, 'user_disabled');
    await ctx.services.audit.record(getAuth(request).user.id, disabled ? 'user.disabled' : 'user.enabled', { type: 'user', id: userId }, { user: user.displayName });
    return { user: toAdminUserView(user) };
  });

  app.put('/admin/users/:userId/password', { preHandler: requireAdmin }, async (request) => {
    const { userId } = parseInput(userParams, request.params);
    const { password } = parseInput(passwordBody, request.body);
    const user = await users.setPassword(userId, password);
    ctx.publisher.disconnectUser(userId, 'password_changed');
    await ctx.services.audit.record(getAuth(request).user.id, 'user.password_reset', { type: 'user', id: userId }, { user: user.displayName });
    return { user: toAdminUserView(user) };
  });

  app.patch('/admin/users/:userId/role', { preHandler: requireAdmin }, async (request) => {
    const { userId } = parseInput(userParams, request.params);
    const { role } = parseInput(roleBody, request.body);
    const before = await users.getById(userId);
    await users.setRole(userId, role);
    ctx.services.permissions.invalidate();
    if (before.role !== role) {
      await ctx.services.audit.record(getAuth(request).user.id, 'user.roles_changed', { type: 'user', id: userId }, { user: before.displayName, accountRole: role });
      // Becoming / leaving superadmin changes what this person may see everywhere: reconnect them.
      ctx.publisher.userUpdated(toPublicUser(await users.getFull(userId)));
      ctx.publisher.disconnectUser(userId, 'role_changed');
    }
    return { user: toAdminUserView(await users.getFull(userId)) };
  });

  app.get('/admin/users/:userId/sessions', { preHandler: requireAdmin }, async (request) => {
    const { userId } = parseInput(userParams, request.params);
    return { sessions: await auth.listSessions(userId) };
  });

  app.delete('/admin/users/:userId/sessions', { preHandler: requireAdmin }, async (request) => {
    const { userId } = parseInput(userParams, request.params);
    const revokedSessions = await auth.logoutAll(userId, 'revoked_by_admin');
    await ctx.services.audit.record(getAuth(request).user.id, 'user.sessions_revoked', { type: 'user', id: userId }, { count: revokedSessions });
    return { revokedSessions };
  });

  app.delete('/admin/sessions/:sessionId', { preHandler: requireAdmin }, async (request, reply) => {
    const { sessionId } = parseInput(z.object({ sessionId: z.uuid() }), request.params);
    await auth.revokeSession(sessionId, 'revoked_by_admin');
    return reply.status(204).send();
  });

  // ---- 0.5.8 admin panel --------------------------------------------------------------------

  const { attachments, settings, chunkedUploads, voice } = ctx.services;

  /** System card: versions, uptime, database / LiveKit health, counts. */
  app.get('/admin/overview', { preHandler: requireAdmin }, async () => {
    const dbStarted = performance.now();
    let database: { ok: boolean; latencyMs: number | null };
    try {
      await ctx.prisma.$queryRaw`SELECT 1`;
      database = { ok: true, latencyMs: Math.round(performance.now() - dbStarted) };
    } catch {
      database = { ok: false, latencyMs: null };
    }
    let livekit: { configured: boolean; ok: boolean | null; latencyMs: number | null } = { configured: ctx.config.livekit.enabled, ok: null, latencyMs: null };
    if (ctx.config.livekit.enabled) {
      const started = performance.now();
      try {
        await Promise.race([
          voice.occupiedChannels(),
          new Promise((_, reject) => {
            setTimeout(() => {
              reject(new Error('timeout'));
            }, 3000);
          }),
        ]);
        livekit = { configured: true, ok: true, latencyMs: Math.round(performance.now() - started) };
      } catch {
        livekit = { configured: true, ok: false, latencyMs: null };
      }
    }
    const [userCount, disabledCount, channelCount, messageCount, files] = await Promise.all([
      ctx.prisma.user.count(),
      ctx.prisma.user.count({ where: { disabled: true } }),
      ctx.prisma.channel.count({ where: { type: { in: ['TEXT', 'VOICE'] } } }),
      ctx.prisma.message.count({ where: { deletedAt: null } }),
      attachments.totals(),
    ]);
    const connections = ctx.realtime.connections();
    const memory = process.memoryUsage();
    return {
      server: {
        version: SERVER_VERSION,
        node: process.version,
        environment: ctx.config.nodeEnv,
        startedAt: new Date(ctx.startedAt).toISOString(),
        uptimeSeconds: Math.round((Date.now() - ctx.startedAt) / 1000),
        memoryMb: Math.round(memory.rss / 1024 / 1024),
      },
      database,
      livekit,
      realtime: { connections: connections.length, users: new Set(connections.map((c) => c.userId)).size },
      counts: { users: userCount, disabledUsers: disabledCount, channels: channelCount, messages: messageCount, files: files.count, fileBytes: files.bytes },
    };
  });

  /** Who is connected right now, on which client and app version. */
  app.get('/admin/connections', { preHandler: requireAdmin }, () => ({ connections: ctx.realtime.connections() }));

  app.get('/admin/storage', { preHandler: requireAdmin }, async () => {
    const [files, partial, disk] = await Promise.all([attachments.totals(), chunkedUploads.stats(), chunkedUploads.disk()]);
    return { files, partial, disk, maxUploadSize: ctx.config.maxUploadSize, maxLargeUploadSize: ctx.config.maxLargeUploadSize };
  });

  app.get('/admin/storage/files', { preHandler: requireAdmin }, async (request) => {
    const { limit } = parseInput(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }), request.query);
    return { files: await attachments.largest(limit) };
  });

  app.delete('/admin/attachments/:attachmentId', { preHandler: requireAdmin }, async (request, reply) => {
    const { attachmentId } = parseInput(z.object({ attachmentId: z.uuid() }), request.params);
    const removed = await attachments.adminRemove(attachmentId);
    if (removed.messageId) await ctx.services.messages.republish(removed.messageId);
    await ctx.services.audit.record(getAuth(request).user.id, 'attachment.deleted', { type: 'attachment', id: attachmentId }, { name: removed.originalName });
    return reply.status(204).send();
  });

  app.post('/admin/storage/purge-partials', { preHandler: requireAdmin }, async () => ({ removed: await chunkedUploads.purgeIdle() }));

  /** The banner itself is readable by everyone; only admins change it. */
  app.get('/announcement', { preHandler: ctx.hooks.requireAuth }, async () => ({ announcement: await settings.announcement() }));

  app.put('/admin/announcement', { preHandler: requireAdmin }, async (request) => {
    const announcement = await settings.setAnnouncement(request.body);
    ctx.publisher.announcementChanged(announcement);
    await ctx.services.audit.record(getAuth(request).user.id, 'announcement.set', null, { text: announcement.text.slice(0, 120) });
    return { announcement };
  });

  app.delete('/admin/announcement', { preHandler: requireAdmin }, async (request, reply) => {
    await settings.clearAnnouncement();
    ctx.publisher.announcementChanged(null);
    await ctx.services.audit.record(getAuth(request).user.id, 'announcement.cleared', null);
    return reply.status(204).send();
  });
  // 0.7.0: news channels moved to each server's integrations (PATCH /guilds/:id/integrations/:module).
}
