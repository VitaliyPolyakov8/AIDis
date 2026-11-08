import { create } from 'zustand';

export type SettingsTab =
  | 'emojis'
  | 'account'
  | 'voice'
  | 'streaming'
  | 'keybinds'
  | 'language'
  | 'interface'
  | 'appearance'
  | 'desktop'
  | 'overlay'
  | 'profile'
  | 'server'
  | 'diagnostics'
  | 'admin'
  | 'about';
export type ToastTone = 'info' | 'success' | 'warning' | 'error';

export interface Toast {
  id: number;
  /** Toasts with the same key replace each other instead of stacking. */
  key: string;
  tone: ToastTone;
  message: string;
}

interface UiState {
  channelDrawerOpen: boolean;
  membersOpen: boolean;
  membersDrawerOpen: boolean;
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  /** Desktop screen-source picker. */
  sourcePickerOpen: boolean;
  /** 'change': the picker edits the running share ("Change stream") instead of starting one. */
  sourcePickerMode: 'start' | 'change';
  /** 0.4.1 "Stream <game>": the capture source to preselect (the game's window), or null. */
  sourcePickerPreselect: string | null;
  /** Text chat panel next to the voice channel view. */
  voiceChatOpen: boolean;
  /** The stream viewer is fullscreen: the voice chat then opens inside it instead of next to it. */
  streamFullscreen: boolean;
  /** The stream viewer's bottom voice bar is collapsed to a small handle (kept for the session). */
  streamBarCollapsed: boolean;
  toasts: Toast[];
  /** 0.4.0 message search panel (replaces the member list while open). */
  search: { open: boolean; query: string; channelId: string | null };
  openSearch: (query: string, channelId: string | null) => void;
  closeSearch: () => void;
  /** 0.7.0: the server refused this app version (CLIENT_OUTDATED): show the mandatory update screen. */
  updateRequired: boolean;
  setChannelDrawer: (open: boolean) => void;
  setMembersDrawer: (open: boolean) => void;
  toggleMembers: () => void;
  openSettings: (tab?: SettingsTab) => void;
  closeSettings: () => void;
  setSourcePicker: (open: boolean, mode?: 'start' | 'change', preselect?: string | null) => void;
  setVoiceChat: (open: boolean) => void;
  setStreamFullscreen: (fullscreen: boolean) => void;
  setStreamBarCollapsed: (collapsed: boolean) => void;
  pushToast: (toast: Omit<Toast, 'id' | 'key'> & { key?: string }, durationMs?: number) => void;
  dismissToast: (id: number) => void;
}

let nextToastId = 1;
const MAX_TOASTS = 3;

export const useUiStore = create<UiState>((set, get) => ({
  channelDrawerOpen: false,
  membersOpen: true,
  membersDrawerOpen: false,
  settingsOpen: false,
  settingsTab: 'account',
  sourcePickerOpen: false,
  sourcePickerMode: 'start',
  sourcePickerPreselect: null,
  voiceChatOpen: false,
  streamFullscreen: false,
  streamBarCollapsed: false,
  toasts: [],
  search: { open: false, query: '', channelId: null },
  openSearch: (query, channelId) => set({ search: { open: true, query, channelId } }),
  closeSearch: () => set((s) => ({ search: { ...s.search, open: false } })),
  updateRequired: false,
  setChannelDrawer: (open) => set({ channelDrawerOpen: open }),
  setMembersDrawer: (open) => set({ membersDrawerOpen: open }),
  toggleMembers: () => set((s) => ({ membersOpen: !s.membersOpen })),
  openSettings: (tab = 'account') => set({ settingsOpen: true, settingsTab: tab }),
  closeSettings: () => set({ settingsOpen: false }),
  setSourcePicker: (open, mode = 'start', preselect = null) => set({ sourcePickerOpen: open, sourcePickerMode: mode, sourcePickerPreselect: open ? preselect : null }),
  setVoiceChat: (open) => set({ voiceChatOpen: open }),
  setStreamFullscreen: (fullscreen) => set({ streamFullscreen: fullscreen }),
  setStreamBarCollapsed: (collapsed) => set({ streamBarCollapsed: collapsed }),
  pushToast: (toast, durationMs = 5000) => {
    const id = nextToastId++;
    const key = toast.key ?? `${toast.tone}:${toast.message}`;
    set((s) => ({
      toasts: [...s.toasts.filter((t) => t.key !== key), { ...toast, id, key }].slice(-MAX_TOASTS),
    }));
    setTimeout(() => {
      get().dismissToast(id);
    }, durationMs);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const toast = {
  info: (message: string, key?: string) => useUiStore.getState().pushToast({ tone: 'info', message, key }),
  success: (message: string, key?: string) => useUiStore.getState().pushToast({ tone: 'success', message, key }),
  warning: (message: string, key?: string) => useUiStore.getState().pushToast({ tone: 'warning', message, key }),
  error: (message: string, key?: string) => useUiStore.getState().pushToast({ tone: 'error', message, key }, 7000),
};
