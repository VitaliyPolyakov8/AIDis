import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { PrismaClient } from '../db/prisma.js';
import type { Session, User } from '../generated/prisma/client.js';
import { Errors } from '../common/errors.js';
import { generateToken, safeEqualHex, sha256Hex } from '../common/crypto.js';
import type { EventPublisher } from '../realtime/events.js';
import { normalizeUsername } from '../users/users.service.js';
import { toPublicUser, type PublicUser } from '../users/user.dto.js';
import { burnPasswordCheck, verifyPassword } from './password.js';
import type { AccessTokenService } from './tokens.js';

export const CLIENT_TYPES = ['web', 'desktop', 'android', 'unknown'] as const;
export type ClientType = (typeof CLIENT_TYPES)[number];

export interface DeviceInfo {
  clientType: ClientType;
  deviceName?: string | undefined;
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
}

export interface TokenPair {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  tokenType: 'Bearer';
  sessionId: string;
  user: PublicUser;
}

export interface AuthContext {
  user: User;
  sessionId: string;
}

export interface SessionView {
  id: string;
  clientType: string;
  deviceName: string | null;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  current: boolean;
}

/**
 * Refresh tokens look like "<sessionId>.<random secret>". Only SHA-256(token) is stored.
 * Every refresh rotates the token; presenting the previous (already rotated) token
 * is treated as theft and revokes the whole session.
 */
export class AuthService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly accessTokens: AccessTokenService,
    private readonly refreshTtlSeconds: number,
    private readonly publisher: EventPublisher,
    private readonly log: FastifyBaseLogger,
  ) {}

  async login(username: string, password: string, device: DeviceInfo): Promise<TokenPair> {
    const user = await this.prisma.user.findUnique({ where: { usernameNormalized: normalizeUsername(username) } });
    if (!user) {
      await burnPasswordCheck(password);
      this.log.warn({ event: 'auth.login_failed', reason: 'unknown_user', ip: device.ipAddress }, 'Failed login attempt');
      throw Errors.invalidCredentials();
    }
    const valid = await verifyPassword(user.passwordHash, password);
    if (!valid) {
      this.log.warn({ event: 'auth.login_failed', reason: 'bad_password', userId: user.id, ip: device.ipAddress }, 'Failed login attempt');
      throw Errors.invalidCredentials();
    }
    if (user.disabled) {
      this.log.warn({ event: 'auth.login_failed', reason: 'disabled', userId: user.id }, 'Login to disabled account');
      throw Errors.accountDisabled();
    }
    if (user.pendingVerification) throw Errors.emailNotVerified();
    return this.startSession(user, device);
  }

  /** A new session for a user who has already proven who they are (password, or a 0.7.1 e-mail link). */
  async startSession(user: User, device: DeviceInfo): Promise<TokenPair> {
    const sessionId = randomUUID();
    const refreshToken = this.buildRefreshToken(sessionId);
    const expiresAt = this.refreshExpiry();
    await this.prisma.session.create({
      data: {
        id: sessionId,
        userId: user.id,
        refreshTokenHash: sha256Hex(refreshToken),
        clientType: device.clientType,
        deviceName: device.deviceName ?? null,
        userAgent: device.userAgent?.slice(0, 300) ?? null,
        ipAddress: device.ipAddress ?? null,
        expiresAt,
      },
    });
    this.log.info({ event: 'auth.login', userId: user.id, sessionId, clientType: device.clientType }, 'User logged in');
    return this.issueTokens(user, sessionId, refreshToken, expiresAt);
  }

  async refresh(refreshToken: string, device: Pick<DeviceInfo, 'ipAddress' | 'userAgent'>): Promise<TokenPair> {
    const sessionId = this.parseSessionId(refreshToken);
    const session = await this.prisma.session.findUnique({ where: { id: sessionId }, include: { user: true } });
    if (!session || session.revokedAt !== null || session.expiresAt <= new Date()) {
      throw Errors.invalidRefreshToken();
    }
    const presentedHash = sha256Hex(refreshToken);

    if (session.previousTokenHash !== null && safeEqualHex(presentedHash, session.previousTokenHash)) {
      await this.revokeSession(session.id, 'token_reuse');
      this.log.warn({ event: 'auth.refresh_reuse', userId: session.userId, sessionId }, 'Refresh token reuse detected');
      throw Errors.refreshTokenReused();
    }
    if (!safeEqualHex(presentedHash, session.refreshTokenHash)) {
      throw Errors.invalidRefreshToken();
    }
    if (session.user.disabled) {
      await this.revokeSession(session.id, 'user_disabled');
      throw Errors.accountDisabled();
    }

    const newRefreshToken = this.buildRefreshToken(session.id);
    const expiresAt = this.refreshExpiry();
    // Conditional update guards against two concurrent refreshes with the same token.
    const updated = await this.prisma.session.updateMany({
      where: { id: session.id, refreshTokenHash: session.refreshTokenHash, revokedAt: null },
      data: {
        refreshTokenHash: sha256Hex(newRefreshToken),
        previousTokenHash: session.refreshTokenHash,
        lastUsedAt: new Date(),
        expiresAt,
        ...(device.ipAddress !== undefined ? { ipAddress: device.ipAddress } : {}),
        ...(device.userAgent !== undefined ? { userAgent: device.userAgent.slice(0, 300) } : {}),
      },
    });
    if (updated.count !== 1) {
      throw Errors.invalidRefreshToken();
    }
    return this.issueTokens(session.user, session.id, newRefreshToken, expiresAt);
  }

  /** Validates an access token and checks that its session and user are still active. */
  async authenticate(accessToken: string): Promise<AuthContext> {
    const claims = await this.accessTokens.verify(accessToken);
    const session = await this.prisma.session.findUnique({ where: { id: claims.sessionId }, include: { user: true } });
    if (!session || session.userId !== claims.userId || session.revokedAt !== null || session.expiresAt <= new Date()) {
      throw Errors.unauthorized('Session is no longer valid');
    }
    if (session.user.disabled) {
      throw Errors.accountDisabled();
    }
    return { user: session.user, sessionId: session.id };
  }

  /** Cheap check used by the realtime gateway to drop sockets of revoked sessions. */
  async isSessionActive(sessionId: string): Promise<boolean> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { revokedAt: true, expiresAt: true, user: { select: { disabled: true } } },
    });
    return !!session && session.revokedAt === null && session.expiresAt > new Date() && !session.user.disabled;
  }

  async logout(sessionId: string): Promise<void> {
    await this.revokeSession(sessionId, 'logout');
  }

  async logoutAll(userId: string, reason = 'logout_all'): Promise<number> {
    const result = await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    this.publisher.disconnectUser(userId, reason);
    this.log.info({ event: 'auth.logout_all', userId, revoked: result.count }, 'All sessions revoked');
    return result.count;
  }

  async listSessions(userId: string, currentSessionId?: string): Promise<SessionView[]> {
    const sessions = await this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastUsedAt: 'desc' },
    });
    return sessions.map((s) => toSessionView(s, currentSessionId));
  }

  /** Revokes one session that belongs to the given user. */
  async revokeOwnSession(userId: string, sessionId: string): Promise<void> {
    const session = await this.prisma.session.findUnique({ where: { id: sessionId } });
    if (!session || session.userId !== userId) {
      throw Errors.notFound('Session');
    }
    await this.revokeSession(sessionId, 'revoked_by_user');
  }

  async revokeSession(sessionId: string, reason: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    this.publisher.disconnectSession(sessionId, reason);
  }

  /** Housekeeping: removes sessions that expired or were revoked more than 30 days ago. */
  async purgeOldSessions(): Promise<number> {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const result = await this.prisma.session.deleteMany({
      where: { OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }] },
    });
    return result.count;
  }

  private async issueTokens(user: User, sessionId: string, refreshToken: string, refreshExpiresAt: Date): Promise<TokenPair> {
    const access = await this.accessTokens.sign({ userId: user.id, sessionId, role: user.role });
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      refreshToken,
      refreshTokenExpiresAt: refreshExpiresAt.toISOString(),
      tokenType: 'Bearer',
      sessionId,
      user: toPublicUser(user),
    };
  }

  private buildRefreshToken(sessionId: string): string {
    return `${sessionId}.${generateToken(32)}`;
  }

  private parseSessionId(refreshToken: string): string {
    const dot = refreshToken.indexOf('.');
    const sessionId = dot > 0 ? refreshToken.slice(0, dot) : '';
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) {
      throw Errors.invalidRefreshToken();
    }
    return sessionId;
  }

  private refreshExpiry(): Date {
    return new Date(Date.now() + this.refreshTtlSeconds * 1000);
  }
}

function toSessionView(session: Session, currentSessionId?: string): SessionView {
  return {
    id: session.id,
    clientType: session.clientType,
    deviceName: session.deviceName,
    userAgent: session.userAgent,
    ipAddress: session.ipAddress,
    createdAt: session.createdAt.toISOString(),
    lastUsedAt: session.lastUsedAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
    current: session.id === currentSessionId,
  };
}
