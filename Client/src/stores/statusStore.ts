import { create } from 'zustand';
import { usersApi } from '../api/users';
import type { CustomStatusView, StatusPreference } from '../api/types';

/**
 * Our own status choice (Online / Away / Do Not Disturb / Invisible) and custom status. Stored on
 * the server; `supported` is false against a 0.2.x server, where the picker is hidden.
 */
interface StatusState {
  status: StatusPreference;
  customStatus: CustomStatusView | null;
  supported: boolean;
  load: () => Promise<void>;
  setStatus: (status: StatusPreference) => Promise<void>;
  setCustomStatus: (custom: CustomStatusView | null) => Promise<void>;
  reset: () => void;
}

export const useStatusStore = create<StatusState>((set) => ({
  status: 'ONLINE',
  customStatus: null,
  supported: false,
  load: async () => {
    try {
      const own = await usersApi.getStatus();
      set({ status: own.status, customStatus: own.customStatus, supported: true });
    } catch {
      set({ supported: false });
    }
  },
  setStatus: async (status) => {
    const previous = useStatusStore.getState().status;
    set({ status });
    try {
      const own = await usersApi.setStatus({ status });
      set({ status: own.status, customStatus: own.customStatus });
    } catch (error) {
      set({ status: previous });
      throw error;
    }
  },
  setCustomStatus: async (custom) => {
    const own = await usersApi.setStatus({ customStatus: custom });
    set({ status: own.status, customStatus: own.customStatus });
  },
  reset: () => set({ status: 'ONLINE', customStatus: null, supported: false }),
}));
