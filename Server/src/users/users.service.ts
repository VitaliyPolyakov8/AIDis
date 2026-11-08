import { AVATAR_LIMITS, BANNER_LIMITS, checkAvatar, checkBanner, parseImageInfo } from './avatar-image.js';
import { AVATAR_FRAME_IDS, PROFILE_BANNER_IDS } from './cosmetics.js';
import { z } from 'zod';
import type { PrismaClient } from '../db/prisma.js';
import { isUniqueViolation } from '../db/prisma.js';
import type { Role, User } from '../generated/prisma/client.js';
import { Errors } from '../common/errors.js';
import { isPrintable, parseInput, sanitizeText } from '../common/validation.js';
import { fullUserInclude } from './user.dto.js';
import { NICKNAME_FONTS, isValidBirthday } from './name-styles.js';
import { hashPassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../auth/password.js';

export const usernameSchema = z
  .string()
  .trim()
  .min(2, 'Username must be at least 2 characters')
  .max(32, 'Username must be at most 32 characters')
  .regex(/^[A-Za-z0-9_.-]+$/, 'Username may contain only letters, digits, "_", "." and "-"');

export const displayNameSchema = z.string().transform(sanitizeText).pipe(z.string().min(1, 'Display name is required').max(64, 'Display name must be at most 64 characters'));

export const passwordSchema = z.string().min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`).max(MAX_PASSWORD_LENGTH, `Password must be at most ${MAX_PASSWORD_LENGTH} characters`);

export const roleSchema = z.enum(['ADMIN', 'USER']);

export const createUserSchema = z.object({
  username: usernameSchema,
  displayName: displayNameSchema,
  password: passwordSchema,
  role: roleSchema.default('USER'),
  /** 0.7.1: optional; an e-mail given by the superadmin counts as confirmed. */
  email: z.email().max(254).optional(),
});

export type CreateUserInput = z.input<typeof createUserSchema>;

export const emailTaken = () => Errors.conflict('EMAIL_TAKEN', 'This e-mail is already used by another account');

export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

/** 0.7.1: e-mails are stored lower-cased, so "Alice@Mail.ru" and "alice@mail.ru" are one address. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * User administration shared by the CLI and the ADMIN-only HTTP API.
 * 0.7.1 self-registration (registration/, off by default) also creates accounts through here.
 */
export class UsersService {
  constructor(
    private readonly prisma: PrismaClient,
    /** Reads the start of an uploaded file, for avatar checks (absent in CLI use). */
    private readonly readUpload?: (storedName: string, maxBytes: number) => Promise<Buffer>,
  ) {}

  /** 0.7.1 `pending`: self-registration, the e-mail still has to be confirmed. */
  async create(input: CreateUserInput | Record<string, unknown>, opts: { pending?: boolean } = {}): Promise<User> {
    const data = parseInput(createUserSchema, input);
    const email = data.email ? normalizeEmail(data.email) : null;
    if (email && (await this.prisma.user.count({ where: { email } })) > 0) throw emailTaken();
    const passwordHash = await hashPassword(data.password);
    try {
      return await this.prisma.user.create({
        data: {
          username: data.username,
          usernameNormalized: normalizeUsername(data.username),
          displayName: data.displayName,
          passwordHash,
          role: data.role,
          email,
          emailVerifiedAt: email && !opts.pending ? new Date() : null,
          pendingVerification: !!opts.pending,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const target = JSON.stringify((error as { meta?: unknown }).meta ?? '');
        if (email && target.includes('email')) throw emailTaken();
        throw Errors.conflict('USERNAME_TAKEN', `Username "${data.username}" already exists`);
      }
      throw error;
    }
  }

  list(): Promise<User[]> {
    return this.prisma.user.findMany({ orderBy: { createdAt: 'asc' } });
  }

  /** 0.4.0: with badges and roles (member list, admin panel). */
  listFull() {
    return this.prisma.user.findMany({ orderBy: { createdAt: 'asc' }, include: fullUserInclude });
  }

  async getFull(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id }, include: fullUserInclude });
    if (!user) throw Errors.notFound('User');
    return user;
  }

  async findByUsername(username: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { usernameNormalized: normalizeUsername(username) } });
  }

  async getByUsername(username: string): Promise<User> {
    const user = await this.findByUsername(username);
    if (!user) throw Errors.notFound(`User "${username}"`);
    return user;
  }

  async getById(id: string): Promise<User> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw Errors.notFound('User');
    return user;
  }

  /** Disabling a user also revokes all of their sessions. */
  async setDisabled(userId: string, disabled: boolean): Promise<User> {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.update({ where: { id: userId }, data: { disabled } });
      if (disabled) {
        await tx.session.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: new Date(), revokedReason: 'user_disabled' },
        });
      }
      return user;
    });
  }

  /** Changing a password revokes all existing sessions of that user. */
  async setPassword(userId: string, password: string): Promise<User> {
    const parsed = parseInput(passwordSchema, password);
    const passwordHash = await hashPassword(parsed);
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.update({ where: { id: userId }, data: { passwordHash } });
      await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'password_changed' },
      });
      return user;
    });
  }

  async setRole(userId: string, role: Role): Promise<User> {
    const parsed = parseInput(roleSchema, role);
    if (parsed === 'USER') {
      const target = await this.getById(userId);
      if (target.role === 'ADMIN') {
        const admins = await this.prisma.user.count({ where: { role: 'ADMIN', disabled: false } });
        if (admins <= 1 && !target.disabled) {
          throw Errors.conflict('LAST_ADMIN', 'Cannot demote the last active ADMIN');
        }
      }
    }
    return this.prisma.user.update({ where: { id: userId }, data: { role: parsed } });
  }

  async updateProfile(userId: string, input: unknown): Promise<User> {
    const data = parseInput(profileSchema, input);
    if (data.avatarAttachmentId) await this.checkImage(userId, data.avatarAttachmentId, 'avatar');
    if (data.bannerAttachmentId) await this.checkImage(userId, data.bannerAttachmentId, 'banner');
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(data.displayName !== undefined ? { displayName: data.displayName } : {}),
        ...(data.avatarAttachmentId !== undefined ? { avatarAttachmentId: data.avatarAttachmentId } : {}),
        ...(data.bannerAttachmentId !== undefined ? { bannerAttachmentId: data.bannerAttachmentId } : {}),
        ...(data.accentColor !== undefined ? { accentColor: data.accentColor?.toLowerCase() ?? null } : {}),
        ...(data.profileFrame !== undefined ? { profileFrame: data.profileFrame } : {}),
        ...(data.profileTags !== undefined ? { profileTags: [...new Set(data.profileTags)] } : {}),
        ...(data.nicknameColor !== undefined ? { nicknameColor: data.nicknameColor?.toLowerCase() ?? null } : {}),
        ...(data.profileBannerId !== undefined ? { profileBannerId: data.profileBannerId } : {}),
        ...(data.avatarFrameId !== undefined ? { avatarFrameId: data.avatarFrameId } : {}),
        ...(data.accentColor2 !== undefined ? { accentColor2: data.accentColor2?.toLowerCase() ?? null } : {}),
        ...(data.nicknameColor2 !== undefined ? { nicknameColor2: data.nicknameColor2?.toLowerCase() ?? null } : {}),
        ...(data.nicknameGlow !== undefined ? { nicknameGlow: data.nicknameGlow } : {}),
        ...(data.nicknameFont !== undefined ? { nicknameFont: data.nicknameFont } : {}),
        ...(data.birthday !== undefined ? { birthdayMonth: data.birthday?.month ?? null, birthdayDay: data.birthday?.day ?? null } : {}),
        ...(data.showRecentGames !== undefined ? { showRecentGames: data.showRecentGames } : {}),
        ...(data.bio !== undefined ? { bio: data.bio || null } : {}),
      },
    });
  }

  /** Real format / size / animation from the bytes (never the client's MIME type). Also used for server profiles. */
  async checkImage(userId: string, attachmentId: string, kind: 'avatar' | 'banner'): Promise<void> {
    const attachment = await this.prisma.attachment.findUnique({ where: { id: attachmentId } });
    const code = kind === 'avatar' ? 'AVATAR' : 'BANNER';
    const label = kind === 'avatar' ? 'Avatar' : 'Banner';
    if (!attachment || attachment.uploaderId !== userId || !attachment.mimeType.startsWith('image/')) {
      throw Errors.badRequest(`INVALID_${code}`, `${label} must be an image you uploaded`);
    }
    if (!this.readUpload) return;
    const limits = kind === 'avatar' ? AVATAR_LIMITS : BANNER_LIMITS;
    const size = Number(attachment.size);
    const head = size <= limits.maxStaticSize ? await this.readUpload(attachment.storedName, size) : Buffer.alloc(0);
    const info = parseImageInfo(head);
    const problem = kind === 'avatar' ? checkAvatar(info, size) : checkBanner(info, size);
    if (problem === 'format') throw Errors.badRequest(`${code}_FORMAT`, `${label} must be a PNG, JPEG, GIF or WebP image`);
    if (problem === 'size') throw Errors.badRequest(`${code}_TOO_LARGE`, `${label} file is too large (max ${Math.round(limits.maxStaticSize / 1024 / 1024)} MB)`);
    if (problem === 'dimensions') {
      throw Errors.badRequest(`${code}_DIMENSIONS`, kind === 'avatar' ? 'Avatar is too large (max 4096 px, animated max 1024 px)' : 'Banner is too large (max 4096 x 2048 px, animated max 1600 px wide)');
    }
  }
}

/** 0.4.0 built-in profile frames (decorations drawn by the client; ids only here). */
export const PROFILE_FRAMES = ['neon', 'scifi', 'gold', 'pulse', 'violet'] as const;

const tag = z.string().transform(sanitizeText).pipe(z.string().min(1).max(32).refine(isPrintable));

export const profileSchema = z.object({
  displayName: displayNameSchema.optional(),
  avatarAttachmentId: z.uuid().nullable().optional(),
  bannerAttachmentId: z.uuid().nullable().optional(),
  accentColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Color must be #rrggbb')
    .nullable()
    .optional(),
  profileFrame: z.enum(PROFILE_FRAMES).nullable().optional(),
  profileTags: z.array(tag).max(5, 'At most 5 tags').optional(),
  /** 0.5.0: only #rrggbb (never CSS), and readable on the dark UI (see isReadableNicknameColor). */
  nicknameColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Color must be #rrggbb')
    .refine(isReadableNicknameColor, 'This color is too dark to read on the AIDis background')
    .nullable()
    .optional(),
  /** 0.5.1: built-in cosmetics, catalog ids only. */
  profileBannerId: z.enum(PROFILE_BANNER_IDS).nullable().optional(),
  avatarFrameId: z.enum(AVATAR_FRAME_IDS).nullable().optional(),
  /** 0.5.5 profile theme and name style. */
  accentColor2: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Color must be #rrggbb')
    .nullable()
    .optional(),
  nicknameColor2: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Color must be #rrggbb')
    .refine(isReadableNicknameColor, 'This color is too dark to read on the AIDis background')
    .nullable()
    .optional(),
  nicknameGlow: z.boolean().optional(),
  nicknameFont: z.enum(NICKNAME_FONTS).nullable().optional(),
  birthday: z
    .object({ month: z.number().int(), day: z.number().int() })
    .refine((b) => isValidBirthday(b.month, b.day), 'Not a real date')
    .nullable()
    .optional(),
  showRecentGames: z.boolean().optional(),
  /** 0.7.0: "About me". */
  bio: z
    .string()
    .max(400)
    .transform((v) => v.replace(/\r\n?/g, '\n').trim())
    .pipe(
      z
        .string()
        .max(190, 'At most 190 characters')
        .refine((v) => isPrintable(v.replace(/\n/g, ' ')), 'Invalid characters'),
    )
    .nullable()
    .optional(),
});

/** 0.7.0: server profile "About me" (same rules as the global one). */
export const bioSchema = profileSchema.shape.bio;

/** WCAG relative luminance of #rrggbb. */
function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** Darkest AIDis surface a name is drawn on (the dark themes' sidebar). */
const NAME_BACKGROUND = '#111214';
/** Minimum contrast for a name (WCAG "large / UI text" level). */
export const MIN_NICKNAME_CONTRAST = 3;

export function isReadableNicknameColor(hex: string): boolean {
  const l = luminance(hex);
  const bg = luminance(NAME_BACKGROUND);
  return (Math.max(l, bg) + 0.05) / (Math.min(l, bg) + 0.05) >= MIN_NICKNAME_CONTRAST;
}
