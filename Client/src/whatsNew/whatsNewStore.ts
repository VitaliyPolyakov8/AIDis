import { create } from 'zustand';
import { config } from '../config';
import { changelogFor } from './changelog';

/** localStorage key: the last version whose notes were shown (or dismissed). */
export const WHATS_NEW_SEEN_KEY = 'aidis.whatsNew.seen';

interface WhatsNewState {
  open: boolean;
  show: () => void;
  hide: () => void;
}

export const useWhatsNewStore = create<WhatsNewState>((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => {
    markSeen(config.clientVersion);
    set({ open: false });
  },
}));

export function openWhatsNew(): void {
  useWhatsNewStore.getState().show();
}

export function readSeen(): string | null {
  try {
    return localStorage.getItem(WHATS_NEW_SEEN_KEY);
  } catch {
    return null;
  }
}

function markSeen(version: string): void {
  try {
    localStorage.setItem(WHATS_NEW_SEEN_KEY, version);
  } catch {
    // Private mode / blocked storage: the window may simply show again next time.
  }
}

/** True when this version has notes the user has not seen yet. Pure enough to unit-test. */
export function shouldShowWhatsNew(version: string, seen: string | null): boolean {
  return seen !== version && changelogFor(version) !== null;
}
