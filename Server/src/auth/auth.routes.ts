import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app-context.js';
import { AppError, Errors } from '../common/errors.js';
import { parseInput, sanitizeText } from '../common/validation.js';
import { toPublicUser } from '../users/user.dto.js';
import { normalizeUsername, passwordSchema } from '../users/users.service.js';
import { verifyPassword } from './password.js';
import { getAuth } from './auth.hooks.js';
import { CLIENT_TYPES } from './auth.service.js';
import { LoginThrottle } from './login-throttle.js';

const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
  clientType: z.enum(CLIENT_TYPES).default('unknown'),
  deviceName: z
    .string()
    .transform(sanitizeText)
    .pipe(z.string().max(100))
    .optional(),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(10).max(200),
});

const sessionIdParams = z.object({ sessionId: z.uuid() });

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: passwordSchema,
});

/**
 * Authentication endpoints. Accounts are created by an administrator (CLI or ADMIN API);
 * 0.7.1 optional self-registration lives in registration/ (off by default).
 */
export function authRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { auth } = ctx.services;
  const { requireAuth } = ctx.hooks;
  const throttle = new LoginThrottle();

  app.post(
    '/auth/login',
    { config: { rateLimit: { max: ctx.config.loginRateLimitMax, timeWindow: '1 minute' } } },
    async (request) => {
      const body = parseInput(loginSchema, request.body);
      const key = normalizeUsername(body.username);
      if (throttle.isBlocked(key)) {
        request.log.warn({ event: 'auth.login_throttled', ip: request.ip }, 'Login throttled for username');
        throw Errors.rateLimited('Too many failed login attempts, try again later');
      }
      try {
        const tokens = await auth.login(body.username, body.password, {
          clientType: body.clientType,
          deviceName: body.deviceName,
          userAgent: request.headers['user-agent'],
          ipAddress: request.ip,
        });
        throttle.reset(key);
        return tokens;
      } catch (error) {
        if (error instanceof AppError && error.code === 'INVALID_CREDENTIALS') {
          throttle.recordFailure(key);
        }
        throw error;
      }
    },
  );

  app.post(
    '/auth/refresh',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request) => {
      const body = parseInput(refreshSchema, request.body);
      return auth.refresh(body.refreshToken, { ipAddress: request.ip, userAgent: request.headers['user-agent'] });
    },
  );

  app.post('/auth/logout', { preHandler: requireAuth }, async (request, reply) => {
    await auth.logout(getAuth(request).sessionId);
    return reply.status(204).send();
  });

  app.post('/auth/logout-all', { preHandler: requireAuth }, async (request) => {
    const revoked = await auth.logoutAll(getAuth(request).user.id);
    return { revokedSessions: revoked };
  });

  app.get('/auth/me', { preHandler: requireAuth }, (request) => {
    const { user, sessionId } = getAuth(request);
    return { user: toPublicUser(user), sessionId };
  });

  /** Lets a user change their own password. All of their sessions are revoked afterwards. */
  app.post(
    '/auth/password',
    { preHandler: requireAuth, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = parseInput(changePasswordSchema, request.body);
      const { user } = getAuth(request);
      if (!(await verifyPassword(user.passwordHash, body.currentPassword))) {
        throw Errors.invalidCredentials();
      }
      await ctx.services.users.setPassword(user.id, body.newPassword);
      ctx.publisher.disconnectUser(user.id, 'password_changed');
      return reply.status(204).send();
    },
  );

  app.get('/auth/sessions', { preHandler: requireAuth }, async (request) => {
    const { user, sessionId } = getAuth(request);
    return { sessions: await auth.listSessions(user.id, sessionId) };
  });

  app.delete('/auth/sessions/:sessionId', { preHandler: requireAuth }, async (request, reply) => {
    const { sessionId } = parseInput(sessionIdParams, request.params);
    await auth.revokeOwnSession(getAuth(request).user.id, sessionId);
    return reply.status(204).send();
  });
}
