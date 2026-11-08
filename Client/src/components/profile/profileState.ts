import type { MouseEvent as ReactMouseEvent } from 'react';
import { create } from 'zustand';

export interface ProfileTarget {
  userId: string;
  x: number;
  y: number;
}

export const useProfilePopout = create<{ target: ProfileTarget | null }>(() => ({ target: null }));

/** Something to anchor the card to: a live click event, an element, or a rectangle captured earlier. */
export type ProfileAnchor = ReactMouseEvent | Element | DOMRect;

/** Reads the anchor rectangle. Call it while the event is being dispatched: React clears `currentTarget` afterwards. */
export function anchorRect(anchor: ProfileAnchor): DOMRect {
  if (anchor instanceof DOMRect) return anchor;
  if (anchor instanceof Element) return anchor.getBoundingClientRect();
  const current: unknown = anchor.currentTarget;
  const el: unknown = current instanceof Element ? current : anchor.target;
  return el instanceof Element ? el.getBoundingClientRect() : new DOMRect(anchor.clientX, anchor.clientY, 0, 0);
}

/** Opens the compact profile card next to the clicked element (the one popout for every entry point). */
export function openProfile(anchor: ProfileAnchor, userId: string): void {
  const rect = anchorRect(anchor);
  // To the right of the element, or to its left when there is no room (member list on the right edge).
  const CARD_WIDTH = 320;
  const x = rect.right + 8 + CARD_WIDTH <= window.innerWidth ? rect.right + 8 : Math.max(8, rect.left - 8 - CARD_WIDTH);
  useProfilePopout.setState({ target: { userId, x, y: rect.top } });
}

