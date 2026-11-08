import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import type { Role } from '../generated/prisma/client.js';
import { Errors } from '../common/errors.js';

const ISSUER = 'aidis';
const AUDIENCE = 'aidis-api';

export interface AccessTokenClaims {
  userId: string;
  sessionId: string;
  role: Role;
}

/** Short-lived HS256 access token. It carries the session id so revocation is checked on use. */
export class AccessTokenService {
  private readonly key: Uint8Array;

  constructor(
    secret: string,
    private readonly ttlSeconds: number,
  ) {
    this.key = new TextEncoder().encode(secret);
  }

  async sign(claims: AccessTokenClaims): Promise<{ token: string; expiresAt: Date }> {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const exp = nowSeconds + this.ttlSeconds;
    const token = await new SignJWT({ sid: claims.sessionId, role: claims.role })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(claims.userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(nowSeconds)
      .setExpirationTime(exp)
      .sign(this.key);
    return { token, expiresAt: new Date(exp * 1000) };
  }

  async verify(token: string): Promise<AccessTokenClaims> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ['HS256'],
      });
      const sid = payload.sid;
      const role = payload.role;
      if (typeof payload.sub !== 'string' || typeof sid !== 'string' || (role !== 'ADMIN' && role !== 'USER')) {
        throw Errors.unauthorized('Invalid access token');
      }
      return { userId: payload.sub, sessionId: sid, role };
    } catch (error) {
      if (error instanceof joseErrors.JWTExpired) {
        throw Errors.unauthorized('Access token expired');
      }
      throw Errors.unauthorized('Invalid access token');
    }
  }
}
