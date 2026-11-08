import { request } from './client';
import type { AdminConnection, AdminFile, AdminOverview, AdminStorage, AdminUser, Announcement, GuildView, SessionView } from './types';

/** 0.5.8 admin panel (ADMIN accounts only; the server checks every call). */
export const adminApi = {
  overview(): Promise<AdminOverview> {
    return request('/api/v1/admin/overview');
  },
  users(): Promise<{ users: AdminUser[] }> {
    return request('/api/v1/admin/users');
  },
  /** 0.7.0: guildIds = servers the new account joins right away. */
  createUser(input: { username: string; displayName: string; password: string; role: 'ADMIN' | 'USER'; guildIds?: string[]; email?: string }): Promise<{ user: AdminUser }> {
    return request('/api/v1/admin/users', { method: 'POST', body: input });
  },
  setDisabled(userId: string, disabled: boolean): Promise<{ user: AdminUser }> {
    return request(`/api/v1/admin/users/${userId}/disabled`, { method: 'PATCH', body: { disabled } });
  },
  setPassword(userId: string, password: string): Promise<{ user: AdminUser }> {
    return request(`/api/v1/admin/users/${userId}/password`, { method: 'PUT', body: { password } });
  },
  setRole(userId: string, role: 'ADMIN' | 'USER'): Promise<{ user: AdminUser }> {
    return request(`/api/v1/admin/users/${userId}/role`, { method: 'PATCH', body: { role } });
  },
  sessions(userId: string): Promise<{ sessions: SessionView[] }> {
    return request(`/api/v1/admin/users/${userId}/sessions`);
  },
  revokeSessions(userId: string): Promise<{ revokedSessions: number }> {
    return request(`/api/v1/admin/users/${userId}/sessions`, { method: 'DELETE' });
  },
  revokeSession(sessionId: string): Promise<void> {
    return request(`/api/v1/admin/sessions/${sessionId}`, { method: 'DELETE' });
  },
  connections(): Promise<{ connections: AdminConnection[] }> {
    return request('/api/v1/admin/connections');
  },
  storage(): Promise<AdminStorage> {
    return request('/api/v1/admin/storage');
  },
  largestFiles(limit = 30): Promise<{ files: AdminFile[] }> {
    return request('/api/v1/admin/storage/files', { query: { limit } });
  },
  deleteFile(attachmentId: string): Promise<void> {
    return request(`/api/v1/admin/attachments/${attachmentId}`, { method: 'DELETE' });
  },
  purgePartials(): Promise<{ removed: number }> {
    return request('/api/v1/admin/storage/purge-partials', { method: 'POST' });
  },
  announcement(): Promise<{ announcement: Announcement | null }> {
    return request('/api/v1/announcement');
  },
  setAnnouncement(text: string, level: 'info' | 'warning'): Promise<{ announcement: Announcement }> {
    return request('/api/v1/admin/announcement', { method: 'PUT', body: { text, level } });
  },
  clearAnnouncement(): Promise<void> {
    return request('/api/v1/admin/announcement', { method: 'DELETE' });
  },
  /** 0.7.0: every server of the instance. */
  guilds(): Promise<{ guilds: GuildView[] }> {
    return request('/api/v1/admin/guilds');
  },
};
