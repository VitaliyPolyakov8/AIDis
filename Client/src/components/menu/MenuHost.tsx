import { useCallback, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { usePopover } from '../profile/usePopover';
import { EmojiPicker } from '../chat/EmojiPicker';

/**
 * 0.4.0 shared context menu and floating emoji picker (one of each, mounted once in the shell).
 * Used for messages, channels, members and DMs, so every menu looks and behaves the same.
 */
export type MenuEntry =
  | { kind?: 'item'; label: string; icon?: ReactNode; onSelect: () => void; danger?: boolean; checked?: boolean; disabled?: boolean; hint?: string }
  | { kind: 'separator' }
  | { kind: 'title'; label: string }
  | { kind: 'custom'; render: () => ReactNode };

interface MenuState {
  menu: { x: number; y: number; entries: MenuEntry[]; label?: string } | null;
  emoji: { x: number; y: number; onPick: (emoji: string) => void } | null;
}

export const useMenuStore = create<MenuState>(() => ({ menu: null, emoji: null }));

/** Opens a menu at the pointer (right click) or under the clicked button. */
export function openMenu(event: ReactMouseEvent | { clientX: number; clientY: number }, entries: MenuEntry[], label?: string): void {
  if ('preventDefault' in event) {
    event.preventDefault();
    event.stopPropagation();
  }
  let x = event.clientX;
  let y = event.clientY;
  if ('currentTarget' in event && event.type === 'click') {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    x = rect.left;
    y = rect.bottom + 4;
  }
  useMenuStore.setState({ menu: { x, y, entries: entries.filter(Boolean), label }, emoji: null });
}

export function closeMenu(): void {
  useMenuStore.setState({ menu: null });
}

export function openEmojiPicker(event: ReactMouseEvent, onPick: (emoji: string) => void): void {
  event.preventDefault();
  event.stopPropagation();
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  useMenuStore.setState({ emoji: { x: rect.left, y: rect.top, onPick }, menu: null });
}

function Menu() {
  const menu = useMenuStore((s) => s.menu);
  const close = useCallback(() => closeMenu(), []);
  const { ref, style } = usePopover(menu?.x ?? 0, menu?.y ?? 0, close);
  if (!menu) return null;
  return (
    <div ref={ref} className="context-menu" role="menu" aria-label={menu.label} style={style} onContextMenu={(e) => e.preventDefault()}>
      {menu.entries.map((entry, i) => {
        if (entry.kind === 'separator') return <div key={i} className="context-menu-separator" role="separator" />;
        if (entry.kind === 'title') return <div key={i} className="context-menu-title">{entry.label}</div>;
        if (entry.kind === 'custom') return <div key={i}>{entry.render()}</div>;
        return (
          <button
            key={i}
            type="button"
            role={entry.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
            aria-checked={entry.checked}
            disabled={entry.disabled}
            className={`context-menu-item${entry.danger ? ' is-danger' : ''}${entry.checked ? ' is-checked' : ''}`}
            onClick={() => {
              closeMenu();
              entry.onSelect();
            }}
          >
            {entry.icon}
            <span>{entry.label}</span>
            {entry.hint && <span className="context-menu-hint-inline">{entry.hint}</span>}
            {entry.checked !== undefined && (
              <span className="context-menu-check" aria-hidden="true">
                {entry.checked ? '✓' : ''}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function FloatingEmoji() {
  const emoji = useMenuStore((s) => s.emoji);
  const close = useCallback(() => useMenuStore.setState({ emoji: null }), []);
  if (!emoji) return null;
  // Above the button when there is room, else below; kept inside the window.
  const width = 340;
  const height = 380;
  const left = Math.max(8, Math.min(emoji.x - width + 40, window.innerWidth - width - 8));
  const top = emoji.y - height - 8 > 8 ? emoji.y - height - 8 : Math.min(emoji.y + 36, window.innerHeight - height - 8);
  return (
    <div className="floating-emoji" style={{ left, top }}>
      <EmojiPicker
        customMode="reaction"
        onPick={(e) => {
          emoji.onPick(e);
          close();
        }}
        onClose={close}
      />
    </div>
  );
}

export function MenuHost() {
  const open = useMenuStore((s) => s.menu !== null || s.emoji !== null);
  if (!open) return null;
  return createPortal(
    <>
      <Menu />
      <FloatingEmoji />
    </>,
    document.body,
  );
}
