import { config } from '../config';
import { request } from './client';
import type { PublicUser, SessionView, TokenPair } from './types';

export function deviceName(): string | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return `${browser}${os ? ` on ${os}` : ''}`;
}

export const authApi = {
  login(username: string, password: string): Promise<TokenPair> {
    return request<TokenPair>('/api/v1/auth/login', {
      method: 'POST',
      auth: false,
      body: { username, password, clientType: config.clientType, deviceName: deviceName() },
    });
  },
  me(): Promise<{ user: PublicUser; sessionId: string }> {
    return request('/api/v1/auth/me');
  },
  logout(): Promise<void> {
    return request('/api/v1/auth/logout', { method: 'POST', timeoutMs: 5_000 });
  },
  changePassword(currentPassword: string, newPassword: string): Promise<void> {
    return request('/api/v1/auth/password', { method: 'POST', body: { currentPassword, newPassword } });
  },
  sessions(): Promise<{ sessions: SessionView[] }> {
    return request('/api/v1/auth/sessions');
  },
  revokeSession(sessionId: string): Promise<void> {
    return request(`/api/v1/auth/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
  },
};
