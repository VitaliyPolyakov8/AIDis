import type { MouseEvent as ReactMouseEvent } from 'react';
import { create } from 'zustand';
import { useAuthStore } from '../../stores/authStore';
import { useVoiceStore } from '../../voice/voiceStore';

export interface MenuTarget {
  identity: string;
  name: string;
  channelId: string;
  x: number;
  y: number;
}

export const useParticipantMenu = create<{ target: MenuTarget | null; confirm: MenuTarget | null }>(() => ({ target: null, confirm: null }));

/**
 * Right-click handler for participant rows/tiles. Opens the menu only for someone else who is in
 * the same voice channel as us right now; otherwise the browser's normal behaviour is kept.
 */
export function openParticipantMenu(event: ReactMouseEvent, identity: string, name: string): void {
  const voiceState = useVoiceStore.getState();
  const selfId = useAuthStore.getState().user?.id;
  const inCall = voiceState.status === 'connected' || voiceState.status === 'reconnecting';
  if (!inCall || !voiceState.channelId || identity === selfId) return;
  if (!voiceState.participants.some((p) => p.identity === identity && !p.isLocal)) return;
  event.preventDefault();
  useParticipantMenu.setState({ target: { identity, name, channelId: voiceState.channelId, x: event.clientX, y: event.clientY } });
}

export function closeParticipantMenu(): void {
  useParticipantMenu.setState({ target: null });
}
