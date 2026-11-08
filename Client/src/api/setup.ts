import { config } from '../config';
import { getLanguage } from '../i18n';
import { request } from './client';
import type { TokenPair } from './types';

export type RegistrationMode = 'off' | 'invite' | 'open';

export interface SetupInput {
  code: string;
  username: string;
  displayName: string;
  password: string;
  email?: string;
  guildName: string;
  registrationMode: RegistrationMode;
}

export type SetupResult = TokenPair & { guildId: string; inviteCode: string };

/** First-run wizard of a fresh AIDis (open only while the server has no account). */
export const setupApi = {
  status(): Promise<{ needed: boolean }> {
    return request('/api/v1/setup/status', { auth: false, timeoutMs: 8_000 });
  },
  complete(input: SetupInput): Promise<SetupResult> {
    return request('/api/v1/setup/complete', { method: 'POST', auth: false, body: { ...input, lang: getLanguage(), clientType: config.clientType } });
  },
};
