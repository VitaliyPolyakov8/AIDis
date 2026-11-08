import { join } from 'node:path';
import { screen, type BrowserWindow, type BrowserWindowConstructorOptions, type Rectangle } from 'electron';
import { ICON_PATH, IS_DEV } from './config';
import { readJson, writeJsonAtomic } from './jsonFile';
import { logger } from './logger';

/**
 * 0.4.5 stream pop-out windows.
 *
 * The page opens them itself with window.open('about:blank', 'aidis-popout-<id>') and renders the
 * stream tile into them (same document origin, same MediaStream: the stream is never restarted).
 * Only blank windows with exactly that name pattern are allowed; everything else keeps being
 * denied / opened in the browser. Size and position are remembered (one record for all pop-outs)
 * and always land on a connected monitor.
 */
const NAME = /^aidis-popout-[a-zA-Z0-9-]{1,80}$/;
const DEFAULT = { width: 960, height: 560 };
const MIN = { width: 320, height: 200 };

export function isPopoutRequest(url: string, frameName: string): boolean {
  return url === 'about:blank' && NAME.test(frameName);
}

/** Keeps saved bounds only when they are sane and visible on one of the connected work areas. Pure. */
export function sanitizePopoutBounds(raw: unknown, workAreas: Rectangle[]): Rectangle | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
  const x = n(r.x);
  const y = n(r.y);
  const width = n(r.width);
  const height = n(r.height);
  if (x === null || y === null || width === null || height === null) return null;
  if (width < MIN.width || height < MIN.height || width > 10000 || height > 10000) return null;
  // At least 100 x 50 px of the window (its top part) must be on a connected monitor.
  const visible = workAreas.some((a) => x + width - 100 >= a.x && x + 100 <= a.x + a.width && y >= a.y - 10 && y + 50 <= a.y + a.height);
  return visible ? { x, y, width, height } : null;
}

export class StreamPopouts {
  private readonly windows = new Map<string, BrowserWindow>();
  private readonly file: string;
  private saveTimer: NodeJS.Timeout | null = null;
  private overlayInteractive = false;

  constructor(userData: string) {
    this.file = join(userData, 'stream-popout.json');
  }

  /** BrowserWindow options for an allowed pop-out (used by setWindowOpenHandler). */
  options(frameName = ''): BrowserWindowConstructorOptions {
    const overlay = frameName.startsWith('aidis-popout-overlay-');
    const saved = sanitizePopoutBounds(
      readJson(this.file),
      screen.getAllDisplays().map((d) => d.workArea),
    );
    return {
      ...(overlay ? { width: 480, height: 300 } : (saved ?? DEFAULT)),
      ...(overlay ? { frame: false, skipTaskbar: true, alwaysOnTop: true, focusable: false, resizable: true } : {}),
      minWidth: MIN.width,
      minHeight: MIN.height,
      title: 'AIDis',
      icon: ICON_PATH,
      backgroundColor: '#000000',
      autoHideMenuBar: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: true, backgroundThrottling: false, devTools: IS_DEV },
    };
  }

  /** Called from 'did-create-window' for an allowed pop-out. */
  register(win: BrowserWindow, frameName: string): void {
    this.windows.set(frameName, win);
    win.setMenu(null);
    if (frameName.startsWith('aidis-popout-overlay-')) {
      win.setAlwaysOnTop(true, 'screen-saver');
      win.setIgnoreMouseEvents(!this.overlayInteractive, { forward: true });
      win.setFocusable(this.overlayInteractive);
    }
    // The pop-out shows only the stream: it never navigates anywhere.
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const save = () => {
      if (frameName.startsWith('aidis-popout-overlay-')) return;
      if (win.isDestroyed() || win.isMinimized() || win.isFullScreen() || win.isMaximized()) return;
      if (this.saveTimer) clearTimeout(this.saveTimer);
      const bounds = win.getBounds();
      this.saveTimer = setTimeout(() => {
        try {
          writeJsonAtomic(this.file, bounds);
        } catch (error) {
          logger.warn('window', 'Could not save the pop-out position', error);
        }
      }, 500);
    };
    win.on('move', save);
    win.on('resize', save);
    win.on('closed', () => {
      if (this.windows.get(frameName) === win) this.windows.delete(frameName);
    });
    logger.info('window', 'Stream pop-out opened');
  }

  setAlwaysOnTop(frameName: unknown, onTop: unknown): void {
    if (typeof frameName !== 'string' || typeof onTop !== 'boolean') return;
    const win = this.windows.get(frameName);
    if (win && !win.isDestroyed()) win.setAlwaysOnTop(onTop, 'floating');
  }

  /** Shared overlay interaction hotkey: make video overlays draggable/clickable again. */
  toggleOverlayInteractive(): void {
    this.setOverlayInteractive(!this.overlayInteractive);
  }

  setOverlayInteractive(on: boolean): void {
    this.overlayInteractive = on;
    for (const [name, win] of this.windows) {
      if (!name.startsWith('aidis-popout-overlay-') || win.isDestroyed()) continue;
      win.setIgnoreMouseEvents(!this.overlayInteractive, { forward: true });
      win.setFocusable(this.overlayInteractive);
    }
  }
}
