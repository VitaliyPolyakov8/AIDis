import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { SettingsService } from '../admin/settings.service.js';
import { CLIENT_TYPES, type AuthService, type DeviceInfo, type TokenPair } from '../auth/auth.service.js';
import { LoginThrottle } from '../auth/login-throttle.js';
import { AppError, Errors } from '../common/errors.js';
import { generateToken, sha256Hex } from '../common/crypto.js';
import { parseInput, sanitizeText } from '../common/validation.js';
import type { PrismaClient } from '../db/prisma.js';
import type { User } from '../generated/prisma/client.js';
import type { InvitesService } from '../invites/invites.service.js';
import { mailNotConfigured, type MailLang, type MailService } from '../mail/mail.service.js';
import type { EventPublisher } from '../realtime/events.js';
import { displayNameSchema, emailTaken, normalizeEmail, passwordSchema, usernameSchema, type UsersService } from '../users/users.service.js';

export type RegistrationMode = 'off' | 'invite' | 'open';
type Purpose = 'verify' | 'reset' | 'email-change';

const KEY = 'registration';
const HOUR = 3600_000;
const TTL: Record<Purpose, number> = { verify: 24 * HOUR, reset: HOUR, 'email-change': 24 * HOUR };
/** Unconfirmed registrations are removed after this. */
const PENDING_TTL = 7 * 24 * HOUR;

const lang = z.enum(['ru', 'en']).default('ru');
const email = z.email().max(254);
const modeInput = z.object({ mode: z.enum(['off', 'invite', 'open']) });
const registerInput = z.object({
  username: usernameSchema,
  displayName: displayNameSchema,
  email,
  password: passwordSchema,
  inviteCode: z.string().trim().max(200).optional(),
  lang,
});
const tokenInput = z.object({
  token: z.string().min(10).max(200),
  clientType: z.enum(CLIENT_TYPES).default('unknown'),
  deviceName: z.string().transform(sanitizeText).pipe(z.string().max(100)).optional(),
});
const resetInput = z.object({ email, lang });
const confirmInput = z.object({ token: z.string().min(10).max(200), password: passwordSchema });
const changeEmailInput = z.object({ email, lang });

const tokenInvalid = () => Errors.badRequest('TOKEN_INVALID', 'This link is invalid, already used or expired');

export type VerifyResult = (TokenPair & { guildId: string | null; channelId: string | null }) | { emailChanged: true; email: string };

/**
 * 0.7.1 self-registration (a superadmin switch: off / by invite / open), e-mail confirmation,
 * password reset and e-mail change. Links carry 32 random bytes; the database keeps only SHA-256.
 */
export class RegistrationService {
  private readonly registerPerIp = new LoginThrottle(5, HOUR);
  private readonly resetPerIp = new LoginThrottle(10, HOUR);
  private readonly resetPerAddress = new LoginThrottle(3, HOUR);
  private readonly emailChangePerUser = new LoginThrottle(5, HOUR);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly settings: SettingsService,
    private readonly mail: MailService,
    private readonly users: UsersService,
    private readonly auth: AuthService,
    private readonly invites: InvitesService,
    private readonly publisher: EventPublisher,
    private readonly publicBaseUrl: string,
    private readonly log: FastifyBaseLogger,
  ) {}

  start(): void {
    this.timer = setInterval(
      () =>
        void this.cleanup().catch((err: unknown) => {
          this.log.warn({ err }, 'registration: cleanup failed');
        }),
      HOUR,
    );
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async storedMode(): Promise<RegistrationMode> {
    const raw = await this.settings.getValue<{ mode?: unknown }>(KEY);
    return raw?.mode === 'invite' || raw?.mode === 'open' ? raw.mode : 'off';
  }

  /** Registration needs working mail: while it is not checked, the switch counts as "off". */
  async state(): Promise<{ mode: RegistrationMode; mail: boolean }> {
    const mail = await this.mail.configured();
    return { mode: mail ? await this.storedMode() : 'off', mail };
  }

  async setMode(input: unknown): Promise<{ mode: RegistrationMode; mail: boolean }> {
    const { mode } = parseInput(modeInput, input);
    if (mode !== 'off' && !(await this.mail.configured())) throw mailNotConfigured();
    await this.settings.setValue(KEY, { mode });
    return this.state();
  }

  async register(input: unknown, ip: string): Promise<void> {
    const { mode } = await this.state();
    if (mode === 'off') throw new AppError(403, 'REGISTRATION_CLOSED', 'Registration is closed');
    if (this.registerPerIp.isBlocked(ip)) throw Errors.rateLimited('Too many registrations from this address, try again later');
    this.registerPerIp.recordFailure(ip);
    const data = parseInput(registerInput, input);

    let inviteCode: string | null = null;
    if (data.inviteCode) inviteCode = await this.invites.assertUsable(data.inviteCode).catch(() => null);
    if (mode === 'invite' && !inviteCode) throw new AppError(403, 'INVITE_REQUIRED', 'Registration is by invite only');

    const address = normalizeEmail(data.email);
    const holder = await this.prisma.user.findUnique({ where: { email: address } });
    if (holder && !holder.pendingVerification) throw emailTaken();
    // An unconfirmed registration with this address (a lost letter): the new one replaces it.
    if (holder) await this.prisma.user.delete({ where: { id: holder.id } });

    const user = await this.users.create({ username: data.username, displayName: data.displayName, password: data.password, role: 'USER', email: address }, { pending: true });
    try {
      const token = await this.issue(user.id, 'verify', { inviteCode });
      await this.mail.send(address, { kind: 'verify', link: `${this.publicBaseUrl}/verify?token=${token}`, username: user.username }, data.lang);
    } catch (error) {
      // The letter did not go out: free the name and the address so the person can try again.
      await this.prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
      throw error;
    }
    this.log.info({ event: 'registration.created', userId: user.id, invite: !!inviteCode }, 'Registration waiting for e-mail confirmation');
  }

  /** Confirms a registration (and logs in) or a new e-mail. */
  async verify(input: unknown, device: Omit<DeviceInfo, 'clientType' | 'deviceName'>): Promise<VerifyResult> {
    const data = parseInput(tokenInput, input);
    const row = await this.consume(data.token, ['verify', 'email-change']);
    if (row.purpose === 'email-change') {
      const address = row.newEmail ?? '';
      const holder = await this.prisma.user.findUnique({ where: { email: address } });
      if (holder && holder.id !== row.userId) {
        if (!holder.pendingVerification) throw emailTaken();
        await this.prisma.user.delete({ where: { id: holder.id } });
      }
      await this.prisma.user.update({ where: { id: row.userId }, data: { email: address, emailVerifiedAt: new Date() } });
      return { emailChanged: true, email: address };
    }

    let user: User = await this.prisma.user.update({ where: { id: row.userId }, data: { pendingVerification: false, emailVerifiedAt: new Date() } });
    if (user.disabled) throw Errors.accountDisabled();
    let guildId: string | null = null;
    let channelId: string | null = null;
    if (row.inviteCode) {
      try {
        const joined = await this.invites.accept(user, row.inviteCode);
        guildId = joined.guild.id;
        channelId = joined.channelId;
      } catch (error) {
        // The invite ran out meanwhile: the account still works, just without that server.
        this.log.info({ event: 'registration.invite_failed', userId: user.id, code: error instanceof AppError ? error.code : 'error' }, 'Invite could not be used after confirmation');
      }
    }
    user = await this.users.getById(user.id);
    const tokens = await this.auth.startSession(user, { clientType: data.clientType, deviceName: data.deviceName, ...device });
    this.log.info({ event: 'registration.confirmed', userId: user.id }, 'Registration confirmed');
    return { ...tokens, guildId, channelId };
  }

  /** Always "accepted": never tells whether an address has an account. */
  async requestReset(input: unknown, ip: string): Promise<void> {
    const data = parseInput(resetInput, input);
    if (this.resetPerIp.isBlocked(ip)) return;
    this.resetPerIp.recordFailure(ip);
    const address = normalizeEmail(data.email);
    if (!(await this.mail.configured())) return;
    const user = await this.prisma.user.findUnique({ where: { email: address } });
    if (!user || user.pendingVerification || user.disabled) return;
    if (this.resetPerAddress.isBlocked(address)) return;
    this.resetPerAddress.recordFailure(address);
    const token = await this.issue(user.id, 'reset');
    try {
      await this.mail.send(address, { kind: 'reset', link: `${this.publicBaseUrl}/reset-password?token=${token}`, username: user.username }, data.lang);
    } catch (error) {
      this.log.warn({ event: 'registration.reset_mail_failed', userId: user.id, code: error instanceof AppError ? error.code : 'error' }, 'Password reset letter failed');
    }
  }

  async confirmReset(input: unknown): Promise<void> {
    const data = parseInput(confirmInput, input);
    const row = await this.consume(data.token, ['reset']);
    await this.users.setPassword(row.userId, data.password);
    // The link proved the address belongs to them.
    await this.prisma.user.updateMany({ where: { id: row.userId, emailVerifiedAt: null }, data: { emailVerifiedAt: new Date() } });
    this.publisher.disconnectUser(row.userId, 'password_changed');
    this.log.info({ event: 'registration.password_reset', userId: row.userId }, 'Password reset by e-mail');
  }

  async emailOf(userId: string): Promise<{ email: string | null; verified: boolean }> {
    const user = await this.users.getById(userId);
    return { email: user.email, verified: !!user.email && !!user.emailVerifiedAt };
  }

  /** Sends a confirmation link to the new address; the e-mail changes only after it is opened. */
  async changeEmail(user: User, input: unknown): Promise<void> {
    const data = parseInput(changeEmailInput, input);
    if (!(await this.mail.configured())) throw mailNotConfigured();
    const address = normalizeEmail(data.email);
    const holder = await this.prisma.user.findUnique({ where: { email: address } });
    if (holder && holder.id !== user.id && !holder.pendingVerification) throw emailTaken();
    if (this.emailChangePerUser.isBlocked(user.id)) throw Errors.rateLimited('Too many e-mail changes, try again later');
    this.emailChangePerUser.recordFailure(user.id);
    const token = await this.issue(user.id, 'email-change', { newEmail: address });
    await this.mail.send(address, { kind: 'email-change', link: `${this.publicBaseUrl}/verify?token=${token}`, username: user.username }, data.lang);
  }

  /** Hourly: unconfirmed registrations older than 7 days, expired and old used links. */
  async cleanup(now = new Date()): Promise<void> {
    const pending = await this.prisma.user.deleteMany({ where: { pendingVerification: true, createdAt: { lt: new Date(now.getTime() - PENDING_TTL) } } });
    await this.prisma.emailToken.deleteMany({ where: { OR: [{ expiresAt: { lt: now } }, { usedAt: { lt: new Date(now.getTime() - 24 * HOUR) } }] } });
    if (pending.count > 0) this.log.info({ event: 'registration.cleanup', removed: pending.count }, 'Removed unconfirmed registrations');
  }

  /** A new one-time link; older unused links of the same kind for this person stop working. */
  private async issue(userId: string, purpose: Purpose, extra: { inviteCode?: string | null; newEmail?: string } = {}): Promise<string> {
    const token = generateToken(32);
    await this.prisma.emailToken.deleteMany({ where: { userId, purpose, usedAt: null } });
    await this.prisma.emailToken.create({
      data: { userId, purpose, tokenHash: sha256Hex(token), inviteCode: extra.inviteCode ?? null, newEmail: extra.newEmail ?? null, expiresAt: new Date(Date.now() + TTL[purpose]) },
    });
    return token;
  }

  /** Takes a link atomically: two requests with the same token cannot both pass. */
  private async consume(token: string, purposes: Purpose[]) {
    const tokenHash = sha256Hex(token);
    const now = new Date();
    const taken = await this.prisma.emailToken.updateMany({ where: { tokenHash, purpose: { in: purposes }, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
    if (taken.count !== 1) throw tokenInvalid();
    return this.prisma.emailToken.findUniqueOrThrow({ where: { tokenHash } });
  }
}

export type { MailLang };
