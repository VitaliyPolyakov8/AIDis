import { request } from './client';
import type { AuditEntry, BadgeView } from './types';

/** 0.7.0: server roles live in guildsApi; badges and the instance audit log stay instance-wide. */
export const rolesApi = {
  badges(): Promise<{ badges: BadgeView[] }> {
    return request('/api/v1/badges');
  },
  /** Superadmin. */
  setUserBadges(userId: string, badgeIds: string[]): Promise<{ badges: string[] }> {
    return request(`/api/v1/users/${userId}/badges`, { method: 'PUT', body: { badgeIds } });
  },
  /** Superadmin: instance-wide entries (or one server's with guildId). */
  audit(before?: string, guildId?: string): Promise<{ entries: AuditEntry[] }> {
    return request('/api/v1/admin/audit', { query: { before, limit: 50, guildId } });
  },
};
