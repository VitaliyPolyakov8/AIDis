import { create } from 'zustand';

/** 0.4.0 incoming DM call ("X is calling"); dismissed after a while if nobody answers. */
export interface IncomingCall {
  channelId: string;
  fromUserId: string;
  at: number;
}

const RING_MS = 30_000;
let timer: ReturnType<typeof setTimeout> | null = null;

interface CallStore {
  incoming: IncomingCall | null;
  ring: (channelId: string, fromUserId: string) => void;
  dismiss: () => void;
}

export const useCallStore = create<CallStore>((set) => ({
  incoming: null,
  ring: (channelId, fromUserId) => {
    if (timer) clearTimeout(timer);
    set({ incoming: { channelId, fromUserId, at: Date.now() } });
    timer = setTimeout(() => set({ incoming: null }), RING_MS);
  },
  dismiss: () => {
    if (timer) clearTimeout(timer);
    timer = null;
    set({ incoming: null });
  },
}));
