import type { PresenceState, PresenceView, StatusPreference } from '../api/types';

/** What to show for someone: the server's state, or online/offline from a 0.2.x server. */
export function presenceState(view: PresenceView | undefined): PresenceState {
  if (!view) return 'offline';
  return view.state ?? (view.status === 'online' ? 'online' : 'offline');
}

/** Our own dot follows what we chose (others see Invisible as offline). */
export function ownPresenceState(pref: StatusPreference, connected: boolean): PresenceState | 'invisible' {
  if (!connected) return 'offline';
  if (pref === 'INVISIBLE') return 'invisible';
  if (pref === 'DND') return 'dnd';
  if (pref === 'AWAY') return 'away';
  return 'online';
}

export type CustomStatusExpiry = 'never' | '1h' | '4h' | 'today';

/** When a custom status chosen now with this option should disappear (ISO), or null for never. */
export function customStatusExpiresAt(option: CustomStatusExpiry, now: Date = new Date()): string | null {
  switch (option) {
    case '1h':
      return new Date(now.getTime() + 3_600_000).toISOString();
    case '4h':
      return new Date(now.getTime() + 4 * 3_600_000).toISOString();
    case 'today': {
      const end = new Date(now);
      end.setHours(23, 59, 59, 0);
      return end.toISOString();
    }
    default:
      return null;
  }
}

/** A custom status still valid now (the server clears expired ones within a minute). */
export function activeCustomStatus(view: { customStatus?: { text: string; expiresAt: string | null; emoji?: string | null } | null } | undefined, now = Date.now()) {
  const c = view?.customStatus;
  if (!c) return null;
  if (c.expiresAt && new Date(c.expiresAt).getTime() <= now) return null;
  return c;
}
