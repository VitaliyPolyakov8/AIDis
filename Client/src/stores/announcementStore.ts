import { create } from 'zustand';
import type { Announcement } from '../api/types';

const DISMISSED_KEY = 'aidis.announcement.dismissed';

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

interface AnnouncementState {
  announcement: Announcement | null;
  /** Id of the banner this device closed (a new text gets a new id and shows again). */
  dismissedId: string | null;
  set: (announcement: Announcement | null) => void;
  dismiss: () => void;
}

/** 0.5.8: the admin banner (loaded at start, then realtime `announcement` events). */
export const useAnnouncementStore = create<AnnouncementState>((set, get) => ({
  announcement: null,
  dismissedId: readDismissed(),
  set: (announcement) => set({ announcement }),
  dismiss: () => {
    const id = get().announcement?.id ?? null;
    if (!id) return;
    try {
      localStorage.setItem(DISMISSED_KEY, id);
    } catch {
      // storage blocked: the banner just comes back after a reload
    }
    set({ dismissedId: id });
  },
}));
