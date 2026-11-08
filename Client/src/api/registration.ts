import { config } from '../config';
import { getLanguage } from '../i18n';
import { deviceName } from './auth';
import { request } from './client';
import type { TokenPair } from './types';

/** 0.7.1 self-registration switch (superadmin): off / by invite / open. */
export type RegistrationMode = 'off' | 'invite' | 'open';
export interface RegistrationState {
  mode: RegistrationMode;
  /** Mail is set up and checked (password reset works). */
  mail: boolean;
}

export type VerifyResult = (TokenPair & { guildId: string | null; channelId: string | null }) | { emailChanged: true; email: string };

export type MailSecurity = 'none' | 'starttls' | 'tls';
export interface MailSettings {
  host: string;
  port: number;
  security: MailSecurity;
  username: string;
  hasPassword: boolean;
  fromName: string;
  fromAddress: string;
  verifiedAt: string | null;
}
export interface MailSettingsInput {
  host: string;
  port: number;
  security: MailSecurity;
  username: string;
  /** Omitted = keep the stored password. */
  password?: string;
  fromName: string;
  fromAddress: string;
}

export interface PublicInvite {
  code: string;
  guild: { id: string; name: string };
  memberCount: number;
}

export interface RegisterInput {
  username: string;
  displayName: string;
  email: string;
  password: string;
  inviteCode?: string;
}

export const registrationApi = {
  state(): Promise<RegistrationState> {
    return request('/api/v1/auth/registration', { auth: false });
  },
  register(input: RegisterInput): Promise<{ ok: true }> {
    return request('/api/v1/auth/register', { method: 'POST', auth: false, body: { ...input, lang: getLanguage() } });
  },
  verifyEmail(token: string): Promise<VerifyResult> {
    return request('/api/v1/auth/verify-email', { method: 'POST', auth: false, body: { token, clientType: config.clientType, deviceName: deviceName() } });
  },
  requestReset(email: string): Promise<{ ok: true }> {
    return request('/api/v1/auth/password-reset', { method: 'POST', auth: false, body: { email, lang: getLanguage() } });
  },
  confirmReset(token: string, password: string): Promise<void> {
    return request('/api/v1/auth/password-reset/confirm', { method: 'POST', auth: false, body: { token, password } });
  },
  publicInvite(code: string): Promise<{ invite: PublicInvite }> {
    return request(`/api/v1/invites/${encodeURIComponent(code)}/public`, { auth: false });
  },
  myEmail(): Promise<{ email: string | null; verified: boolean }> {
    return request('/api/v1/users/me/email');
  },
  changeEmail(email: string): Promise<{ ok: true }> {
    return request('/api/v1/users/me/email', { method: 'PUT', body: { email, lang: getLanguage() } });
  },
  setMode(mode: RegistrationMode): Promise<RegistrationState> {
    return request('/api/v1/admin/registration', { method: 'PUT', body: { mode } });
  },
  mail(): Promise<{ mail: MailSettings | null }> {
    return request('/api/v1/admin/mail');
  },
  saveMail(input: MailSettingsInput): Promise<{ mail: MailSettings }> {
    return request('/api/v1/admin/mail', { method: 'PUT', body: input });
  },
  testMail(to: string): Promise<{ mail: MailSettings }> {
    return request('/api/v1/admin/mail/test', { method: 'POST', body: { to }, timeoutMs: 60_000 });
  },
};
