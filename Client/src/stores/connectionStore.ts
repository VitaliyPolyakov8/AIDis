import { create } from 'zustand';

export type SocketStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting';

interface ConnectionState {
  socket: SocketStatus;
  setSocket: (status: SocketStatus) => void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  socket: 'idle',
  setSocket: (socket) => set({ socket }),
}));
