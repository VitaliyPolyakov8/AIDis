import { BrowserWindow, dialog, shell } from 'electron';
import { ICON_PATH, IS_DEV, PRELOAD_PATH, RENDERER_ENTRY } from './config';
import { tr } from './i18n';
import { logger } from './logger';
import { isRendererUrl } from './permissions';
import { MIN_SIZE, type WindowStateKeeper } from './windowState';
import { isPopoutRequest, type StreamPopouts } from './streamPopouts';

/** Only these external links leave the app (opened in the default browser). */
export function isSafeExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'mailto:';
  } catch {
    return false;
  }
}

function openExternal(url: string): void {
  if (!isSafeExternalUrl(url)) {
    logger.warn('window', 'Blocked opening a non-web link');
    return;
  }
  shell.openExternal(url).catch((error: unknown) => logger.warn('window', 'Could not open external link', error));
}

/** 0.4.2: height of the themed title bar (the page draws its content, Windows draws the controls). */
export const TITLE_BAR_HEIGHT = 32;
const DEFAULT_TITLE_BAR = { color: '#0b0d12', symbolColor: '#c4cad8' };

/** "#rrggbb" only: anything else from the renderer is ignored. */
export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}

/**
 * 0.4.2: recolors the native window controls to the AIDis theme (Electron titleBarOverlay; the
 * minimize / maximize / close buttons, Snap layouts and resizing stay Windows' own).
 */
export function setTitleBarColors(win: BrowserWindow, colors: { color: string; symbolColor: string }): void {
  if (process.platform !== 'win32' || win.isDestroyed()) return;
  try {
    win.setTitleBarOverlay({ color: colors.color, symbolColor: colors.symbolColor, height: TITLE_BAR_HEIGHT });
  } catch (error) {
    logger.warn('window', 'Could not recolor the title bar', error);
  }
}

export function createMainWindow(state: WindowStateKeeper, options: { show: boolean; popouts?: StreamPopouts }): BrowserWindow {
  const { initial } = state;
  const win = new BrowserWindow({
    x: initial.x,
    y: initial.y,
    width: initial.width,
    height: initial.height,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false,
    title: 'AIDis',
    icon: ICON_PATH,
    backgroundColor: '#15171c',
    autoHideMenuBar: true,
    // 0.4.2: themed title bar. The frame stays native (resize borders, Snap, Aero shake); only the
    // caption is drawn by the page, and Windows keeps drawing the real window controls on top.
    ...(process.platform === 'win32' ? { titleBarStyle: 'hidden' as const, titleBarOverlay: { ...DEFAULT_TITLE_BAR, height: TITLE_BAR_HEIGHT } } : {}),
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      // Both chat languages are configured once on the shared session in main.ts.
      spellcheck: true,
      // Push-to-talk timing and voice must not be throttled while AIDis sits in the tray.
      backgroundThrottling: false,
      devTools: IS_DEV,
    },
  });
  win.setMenu(null);
  state.track(win);

  win.once('ready-to-show', () => {
    if (initial.maximized) win.maximize();
    if (options.show) win.show();
  });

  // ---- navigation lockdown: the window only ever shows AIDis ----
  win.webContents.setWindowOpenHandler(({ url, frameName }) => {
    // 0.4.5: blank stream pop-out windows the page fills itself (see streamPopouts.ts).
    if (options.popouts && isPopoutRequest(url, frameName)) return { action: 'allow', overrideBrowserWindowOptions: options.popouts.options(frameName) };
    openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('did-create-window', (child, details) => {
    if (options.popouts && isPopoutRequest(details.url, details.frameName)) options.popouts.register(child, details.frameName);
    else child.close();
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isRendererUrl(url)) return;
    event.preventDefault();
    openExternal(url);
  });
  win.webContents.on('will-redirect', (event, url) => {
    if (!isRendererUrl(url)) event.preventDefault();
  });
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());

  if (IS_DEV) {
    win.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) {
        win.webContents.toggleDevTools();
      }
    });
  }

  // ---- recoverable failures ----
  win.webContents.on('render-process-gone', (_event, details) => {
    logger.error('window', `Renderer process gone: ${details.reason} (exit ${details.exitCode})`);
    if (details.reason === 'clean-exit') return;
    void dialog
      .showMessageBox(win, {
        type: 'error',
        title: tr('crashTitle'),
        message: tr('crashMessage'),
        detail: tr('crashDetail'),
        buttons: [tr('reload')],
        noLink: true,
      })
      .then(() => {
        if (!win.isDestroyed()) win.webContents.reload();
      });
  });
  win.webContents.on('unresponsive', () => logger.warn('window', 'Renderer became unresponsive'));
  win.webContents.on('responsive', () => logger.info('window', 'Renderer responsive again'));
  win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame) return;
    logger.error('window', `Failed to load ${isRendererUrl(url) ? 'app' : 'page'}: ${code} ${description}`);
    if (!IS_DEV) {
      void dialog.showMessageBox(win, { type: 'error', title: tr('crashTitle'), message: tr('loadFailedMessage'), detail: tr('loadFailedDetail') });
    }
  });

  win.loadURL(RENDERER_ENTRY).catch((error: unknown) => logger.error('window', 'loadURL failed', error));
  return win;
}

/** Restores, shows and focuses the window (tray click, second instance, notification click). */
export function showWindow(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}
