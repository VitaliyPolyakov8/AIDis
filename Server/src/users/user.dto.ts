import type { Role, User } from '../generated/prisma/client.js';

/** The only shape in which users leave the server. passwordHash is never included. */
export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  avatarAttachmentId: string | null;
  role: Role;
  lastSeenAt: string | null;
  /** 0.4.0 profile. */
  bannerAttachmentId: string | null;
  accentColor: string | null;
  profileFrame: string | null;
  profileTags: string[];
  /** 0.5.0: color of this user's name (#rrggbb) or null for the default. */
  nicknameColor: string | null;
  /** 0.5.1: built-in animated banner / avatar frame ids (users/cosmetics.ts) or null. */
  profileBannerId: string | null;
  avatarFrameId: string | null;
  /** 0.5.5: profile theme gradient end color (#rrggbb) or null. */
  accentColor2: string | null;
  /** 0.5.5 name style: gradient end color, glow and font id (users/name-styles.ts). */
  nicknameColor2: string | null;
  nicknameGlow: boolean;
  nicknameFont: string | null;
  /** 0.5.5: day and month only (never the year), or null. */
  birthday: { month: number; day: number } | null;
  showRecentGames: boolean;
  /** 0.7.0: "About me" (a server profile can override it). */
  bio: string | null;
  /** 0.4.0: badge keys (see GET /badges). Absent on message authors. Server roles: GET /guilds/:id/members. */
  badges?: string[];
}

export interface AdminUserView extends PublicUser {
  disabled: boolean;
  /** 0.7.1 */
  email: string | null;
  emailVerifiedAt: string | null;
  pendingVerification: boolean;
  createdAt: string;
  updatedAt: string;
}

type UserFields = Pick<
  User,
  | 'id'
  | 'username'
  | 'displayName'
  | 'avatarAttachmentId'
  | 'role'
  | 'lastSeenAt'
  | 'bannerAttachmentId'
  | 'accentColor'
  | 'profileFrame'
  | 'profileTags'
  | 'nicknameColor'
  | 'profileBannerId'
  | 'avatarFrameId'
  | 'accentColor2'
  | 'nicknameColor2'
  | 'nicknameGlow'
  | 'nicknameFont'
  | 'birthdayMonth'
  | 'birthdayDay'
  | 'showRecentGames'
  | 'bio'
> & {
  badges?: { badge: { key: string } }[];
};

export function toPublicUser(user: UserFields): PublicUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarAttachmentId: user.avatarAttachmentId,
    role: user.role,
    lastSeenAt: user.lastSeenAt?.toISOString() ?? null,
    bannerAttachmentId: user.bannerAttachmentId,
    accentColor: user.accentColor,
    profileFrame: user.profileFrame,
    profileTags: user.profileTags,
    nicknameColor: user.nicknameColor,
    profileBannerId: user.profileBannerId,
    avatarFrameId: user.avatarFrameId,
    accentColor2: user.accentColor2,
    nicknameColor2: user.nicknameColor2,
    nicknameGlow: user.nicknameGlow,
    nicknameFont: user.nicknameFont,
    birthday: user.birthdayMonth && user.birthdayDay ? { month: user.birthdayMonth, day: user.birthdayDay } : null,
    showRecentGames: user.showRecentGames,
    bio: user.bio,
    ...(user.badges ? { badges: user.badges.map((b) => b.badge.key) } : {}),
  };
}

export function toAdminUserView(user: User & Pick<UserFields, 'badges'>): AdminUserView {
  return {
    ...toPublicUser(user),
    disabled: user.disabled,
    email: user.email,
    emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
    pendingVerification: user.pendingVerification,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

/** Prisma `select` for author/user summaries that never touches passwordHash. */
export const publicUserSelect = {
  id: true,
  username: true,
  displayName: true,
  avatarAttachmentId: true,
  role: true,
  lastSeenAt: true,
  bannerAttachmentId: true,
  accentColor: true,
  profileFrame: true,
  profileTags: true,
  nicknameColor: true,
  profileBannerId: true,
  avatarFrameId: true,
  accentColor2: true,
  nicknameColor2: true,
  nicknameGlow: true,
  nicknameFont: true,
  birthdayMonth: true,
  birthdayDay: true,
  showRecentGames: true,
  bio: true,
} as const;

/** Full profile: also badges (member list, profile updates). */
export const fullUserInclude = {
  badges: { select: { badge: { select: { key: true } } }, orderBy: { badge: { position: 'asc' } } },
} as const;
