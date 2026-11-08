import type { FastifyRequest } from 'fastify';
import { Errors } from '../common/errors.js';
import type { AuthContext, AuthService } from './auth.service.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1] ?? null;
}

export interface AuthHooks {
  requireAuth: (request: FastifyRequest) => Promise<void>;
  requireAdmin: (request: FastifyRequest) => Promise<void>;
}

export function createAuthHooks(auth: AuthService): AuthHooks {
  const requireAuth = async (request: FastifyRequest): Promise<void> => {
    const token = extractBearerToken(request.headers.authorization);
    if (!token) {
      throw Errors.unauthorized();
    }
    request.auth = await auth.authenticate(token);
  };
  const requireAdmin = async (request: FastifyRequest): Promise<void> => {
    await requireAuth(request);
    if (request.auth?.user.role !== 'ADMIN') {
      throw Errors.forbidden('ADMIN role required');
    }
  };
  return { requireAuth, requireAdmin };
}

/** Returns the authenticated context; only valid inside routes guarded by requireAuth. */
export function getAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) {
    throw Errors.unauthorized();
  }
  return request.auth;
}
