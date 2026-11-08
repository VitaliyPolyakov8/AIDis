import { screen, type BrowserWindow, type Rectangle } from 'electron';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './jsonFile';

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

export const DEFAULT_SIZE = { width: 1280, height: 800 };
export const MIN_SIZE = { width: 940, height: 600 };

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Pure: keeps a saved state only if it is sane and still overlaps a connected display. */
export function sanitizeWindowState(raw: unknown, workAreas: Rectangle[]): WindowState {
  const fallback: WindowState = { ...DEFAULT_SIZE, maximized: false };
  if (typeof raw !== 'object' || raw === null) return fallback;
  const r = raw as Record<string, unknown>;
  const width = isNumber(r.width) ? Math.max(MIN_SIZE.width, Math.round(r.width)) : DEFAULT_SIZE.width;
  const height = isNumber(r.height) ? Math.max(MIN_SIZE.height, Math.round(r.height)) : DEFAULT_SIZE.height;
  const maximized = r.maximized === true;
  if (!isNumber(r.x) || !isNumber(r.y)) return { width, height, maximized };
  const x = Math.round(r.x);
  const y = Math.round(r.y);
  // At least 120x80 px of the title bar area must be on some display, else let Windows place it.
  const visible = workAreas.some((a) => x + width - 120 > a.x && x + 120 < a.x + a.width && y + 80 > a.y && y < a.y + a.height - 40);
  return visible ? { x, y, width, height, maximized } : { width, height, maximized };
}

/** Remembers size, position and maximized state across restarts (%APPDATA%\AIDis\window-state.json). */
export class WindowStateKeeper {
  private readonly file: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  readonly initial: WindowState;

  constructor(userDataDir: string) {
    this.file = join(userDataDir, 'window-state.json');
    this.initial = sanitizeWindowState(
      readJson(this.file),
      screen.getAllDisplays().map((d) => d.workArea),
    );
  }

  track(win: BrowserWindow): void {
    const schedule = () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.save(win), 500);
    };
    win.on('resize', schedule);
    win.on('move', schedule);
    win.on('maximize', schedule);
    win.on('unmaximize', schedule);
    win.on('close', () => this.save(win));
  }

  save(win: BrowserWindow): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (win.isDestroyed() || win.isMinimized()) return;
    // getNormalBounds: the restored size, even while maximized.
    const bounds = win.getNormalBounds();
    const state: WindowState = { ...bounds, maximized: win.isMaximized() };
    try {
      writeJsonAtomic(this.file, state);
    } catch {
      /* not critical */
    }
  }
}
