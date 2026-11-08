import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

const MARGIN = 8;

/**
 * Positions a fixed popover near (x, y), keeps it inside the window, and closes it on an outside
 * click, Escape, resize or window blur. One set of listeners per open popover, removed on close.
 * `above`: the popover's bottom edge sits at y (menus opened from the bottom bar).
 */
export function usePopover(x: number, y: number, onClose: () => void, above = false) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ left: x, top: y, visibility: 'hidden' });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const position = () => {
      const { width, height } = el.getBoundingClientRect();
      const left = Math.max(MARGIN, Math.min(x, window.innerWidth - width - MARGIN));
      const top = Math.max(MARGIN, Math.min(above ? y - height : y, window.innerHeight - height - MARGIN));
      setStyle((current) => current.left === left && current.top === top && !current.visibility ? current : { left, top });
    };
    position();
    // Editing a custom status (or loading profile content) changes the size without moving
    // the anchor. Re-measure the same element so focused inputs are never remounted.
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(position);
    observer.observe(el, { box: 'border-box' });
    return () => observer.disconnect();
  }, [x, y, above]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  return { ref, style };
}
