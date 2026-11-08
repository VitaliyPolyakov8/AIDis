import { normalizeInviteInput } from '../../api/invites';

/** Invite links (http(s)://host/invite/<code>) in a message -> their codes, first occurrence order, no repeats. */
export function findInviteCodes(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/https?:\/\/[^\s/]+\/invite\/([A-Za-z0-9]+)(?=[\s?#.,!)]|$)/g)) {
    const code = normalizeInviteInput(match[1] ?? '');
    if (code && !found.includes(code)) found.push(code);
  }
  return found;
}

// ---- an invite opened before logging in (kept for this tab) -------------------------------------

const PENDING_KEY = 'aidis.pendingInvite';

export function savePendingInvite(code: string): void {
  try {
    sessionStorage.setItem(PENDING_KEY, code);
  } catch {
    // Without storage the login page still returns to the invite through the router state.
  }
}

/** Reads and forgets the pending invite (only a valid code). */
export function takePendingInvite(): string | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    sessionStorage.removeItem(PENDING_KEY);
    return raw ? normalizeInviteInput(raw) : null;
  } catch {
    return null;
  }
}
