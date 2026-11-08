import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app-context.js';
import { getAuth } from '../auth/auth.hooks.js';
import { isPrintable, parseInput } from '../common/validation.js';
import { Errors } from '../common/errors.js';
import { toPublicUser } from './user.dto.js';
import { emojiSchema } from '../messages/messages.service.js';

const userParams = z.object({ userId: z.uuid() });

const statusBody = z.object({
  status: z.enum(['ONLINE', 'AWAY', 'DND', 'INVISIBLE']).optional(),
  customStatus: z
    .object({
      text: z.string().trim().min(1).max(128).refine(isPrintable),
      expiresAt: z.iso.datetime().nullable(),
      /** 0.4.0: one emoji before the text. */
      emoji: emojiSchema.nullable().optional(),
    })
    .nullable()
    .optional(),
});

function statusView(pref: { status: string; customText: string | null; customExpiresAt: Date | null; customEmoji: string | null }) {
  return {
    status: pref.status,
    customStatus: pref.customText ? { text: pref.customText, expiresAt: pref.customExpiresAt?.toISOString() ?? null, emoji: pref.customEmoji } : null,
  };
}

export function usersRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { users } = ctx.services;
  const { requireAuth } = ctx.hooks;

  /** 0.7.0: people the caller may see (friends + members of shared servers; the superadmin sees all). Enabled accounts only. */
  app.get('/users', { preHandler: requireAuth }, async (request) => {
    const visible = await ctx.services.friends.visibleUserIds(getAuth(request).user);
    const list = await users.listFull();
    return { users: list.filter((u) => !u.disabled && (visible === 'all' || visible.has(u.id))).map(toPublicUser) };
  });

  app.get('/users/:userId', { preHandler: requireAuth }, async (request) => {
    const { userId } = parseInput(userParams, request.params);
    if (!(await ctx.services.friends.canSee(getAuth(request).user, userId))) throw Errors.notFound('User');
    return { user: toPublicUser(await users.getFull(userId)) };
  });

  /** Own status preference (Online / Away / DND / Invisible) and custom status. */
  app.get('/users/me/status', { preHandler: requireAuth }, async (request) => {
    return statusView(await ctx.services.presence.getPreference(getAuth(request).user.id));
  });

  app.patch('/users/me/status', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
    const body = parseInput(statusBody, request.body);
    const expiresAt = body.customStatus?.expiresAt ? new Date(body.customStatus.expiresAt) : null;
    const { preference, change } = await ctx.services.presence.setPreference(getAuth(request).user.id, {
      status: body.status,
      customStatus:
        body.customStatus === undefined ? undefined : body.customStatus && (!expiresAt || expiresAt.getTime() > Date.now()) ? { text: body.customStatus.text, expiresAt, emoji: body.customStatus.emoji ?? null } : null,
    });
    if (change) ctx.publisher.presenceUpdated(change);
    return statusView(preference);
  });

  /** Users may change their own display name and avatar. Username/role/password are admin-managed. */
  app.patch('/users/me', { preHandler: requireAuth }, async (request) => {
    const updated = await users.updateProfile(getAuth(request).user.id, request.body);
    const user = toPublicUser(await users.getFull(updated.id));
    // Other clients update the avatar/name everywhere at once. The avatar is a new attachment id on
    // every change, so its URL is new as well and no cached image is reused.
    try {
      ctx.publisher.userUpdated(user);
    } catch (error) {
      request.log.warn({ err: error, event: 'realtime.user_updated_failed', userId: user.id }, 'Could not broadcast profile update');
    }
    return { user };
  });
}
