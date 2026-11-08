import { randomInt } from 'node:crypto';

/** 0.7.0 invite codes: lower case, without look-alikes (no i, l, o, 0, 1). */
export const INVITE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const INVITE_LENGTH = 8;
const CODE_PATTERN = new RegExp(`^[${INVITE_ALPHABET}]{${INVITE_LENGTH}}$`);

export function generateInviteCode(): string {
  let out = '';
  for (let i = 0; i < INVITE_LENGTH; i += 1) out += INVITE_ALPHABET.charAt(randomInt(INVITE_ALPHABET.length));
  return out;
}

/** A code or a full link (".../invite/<code>"), any case -> the code, or null when it cannot be one. */
export function normalizeInviteCode(input: string): string | null {
  const trimmed = input.trim();
  const fromLink = /\/invite\/([^/?#\s]+)/i.exec(trimmed)?.[1] ?? trimmed;
  const code = fromLink.toLowerCase();
  return CODE_PATTERN.test(code) ? code : null;
}
