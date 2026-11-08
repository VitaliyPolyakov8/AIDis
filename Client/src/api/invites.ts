import { request } from './client';
import { getApiOrigin } from '../config';
import type { InvitePreview, InviteView, MyGuildView } from './types';

/** Same alphabet and length as Server/src/invites/code.ts. */
const CODE_PATTERN = /^[abcdefghjkmnpqrstuvwxyz23456789]{8}$/;

/** A code or a link ending in /invite/<code> (any case) -> the code, or null. */
export function normalizeInviteInput(input: string): string | null {
  const trimmed = input.trim();
  const fromLink = /\/invite\/([^/?#\s]+)/i.exec(trimmed)?.[1] ?? trimmed;
  const code = fromLink.toLowerCase();
  return CODE_PATTERN.test(code) ? code : null;
}

/** Where invite links point: the public web address (the desktop's API origin is that same address). */
export function inviteBaseUrl(): string {
  return getApiOrigin() || window.location.origin;
}

export function inviteUrl(code: string): string {
  return `${inviteBaseUrl()}/invite/${code}`;
}

export const MAX_AGES = [1800, 3600, 21600, 43200, 86400, 604800, 0] as const;
export const MAX_USES = [0, 1, 5, 10, 25, 50, 100] as const;

export const invitesApi = {
  create(guildId: string, input: { maxAgeSeconds?: number; maxUses?: number; channelId?: string | null }): Promise<{ invite: InviteView }> {
    return request(`/api/v1/guilds/${encodeURIComponent(guildId)}/invites`, { method: 'POST', body: input });
  },
  list(guildId: string): Promise<{ invites: InviteView[] }> {
    return request(`/api/v1/guilds/${encodeURIComponent(guildId)}/invites`);
  },
  revoke(code: string): Promise<void> {
    return request(`/api/v1/invites/${encodeURIComponent(code)}`, { method: 'DELETE' });
  },
  preview(code: string): Promise<{ invite: InvitePreview }> {
    return request(`/api/v1/invites/${encodeURIComponent(code)}`);
  },
  accept(code: string): Promise<{ guild: MyGuildView; channelId: string | null }> {
    return request(`/api/v1/invites/${encodeURIComponent(code)}/accept`, { method: 'POST' });
  },
};
