import { request } from './client';
import type { NicknameFont, OwnStatus, PresenceView, PublicUser, StatusPreference } from './types';

export const usersApi = {
  /** Enabled accounts of the workspace. */
  list(): Promise<{ users: PublicUser[] }> {
    return request('/api/v1/users');
  },
  get(userId: string): Promise<{ user: PublicUser }> {
    return request(`/api/v1/users/${userId}`);
  },
  /** Own profile (username / role / password are admin-managed). */
  updateMe(input: {
    displayName?: string;
    avatarAttachmentId?: string | null;
    bannerAttachmentId?: string | null;
    accentColor?: string | null;
    profileFrame?: string | null;
    profileTags?: string[];
    nicknameColor?: string | null;
    profileBannerId?: string | null;
    avatarFrameId?: string | null;
    /** 0.5.5 */
    accentColor2?: string | null;
    nicknameColor2?: string | null;
    nicknameGlow?: boolean;
    nicknameFont?: NicknameFont | null;
    birthday?: { month: number; day: number } | null;
    showRecentGames?: boolean;
    /** 0.7.0 */
    bio?: string | null;
  }): Promise<{ user: PublicUser }> {
    return request('/api/v1/users/me', { method: 'PATCH', body: input });
  },
  presence(): Promise<{ presence: PresenceView[] }> {
    return request('/api/v1/presence');
  },
  /** Own status preference (server 0.3.0+). */
  getStatus(): Promise<OwnStatus> {
    return request('/api/v1/users/me/status');
  },
  setStatus(input: { status?: StatusPreference; customStatus?: { text: string; expiresAt: string | null; emoji?: string | null } | null }): Promise<OwnStatus> {
    return request('/api/v1/users/me/status', { method: 'PATCH', body: input });
  },
};
