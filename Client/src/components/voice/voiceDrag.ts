import type { DragEvent } from 'react';

/**
 * 0.5.2: dragging people between voice channels in the channel list (MOVE_USERS; anyone may drag
 * themselves, which is the same as joining the other channel). Uses its own data type, so it never
 * mixes with the channel reordering drag of the same list.
 */
export const VOICE_USER_MIME = 'application/x-aidis-voice-user';

export interface DraggedOccupant {
  userId: string;
  name: string;
  fromChannelId: string;
}

// dataTransfer payloads are unreadable during dragover, so the dragged person is kept here.
let current: DraggedOccupant | null = null;

export function startOccupantDrag(e: DragEvent, occupant: DraggedOccupant): void {
  // The channel row around it is draggable too (reordering): this drag is the person's only.
  e.stopPropagation();
  current = occupant;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData(VOICE_USER_MIME, occupant.userId);
  e.dataTransfer.setData('text/plain', occupant.name);
}

export function endOccupantDrag(): void {
  current = null;
}

/** The person being dragged over a target, or null for any other drag (e.g. channel reordering). */
export function draggedOccupant(e: Pick<DragEvent, 'dataTransfer'>): DraggedOccupant | null {
  return current && Array.from(e.dataTransfer.types).includes(VOICE_USER_MIME) ? current : null;
}

export type OccupantDropAction = 'none' | 'join' | 'move';

/** What dropping `dragged` on the voice channel `targetChannelId` does. Pure (unit-tested). */
export function occupantDropAction(dragged: DraggedOccupant | null, targetChannelId: string, selfId: string | null | undefined, canMove: boolean): OccupantDropAction {
  if (!dragged || dragged.fromChannelId === targetChannelId) return 'none';
  if (dragged.userId === selfId) return 'join';
  return canMove ? 'move' : 'none';
}
