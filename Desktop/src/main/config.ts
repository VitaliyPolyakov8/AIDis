import { app } from 'electron';
import { join } from 'node:path';

/** Stable Windows identity. Never change it: installer upgrades, notifications and autostart depend on it. */
export const APP_ID = 'io.aidis.app';
export const APP_NAME = 'AIDis';

/** The bundled client is served from this privileged custom scheme (secure context, path routing). */
export const APP_SCHEME = 'aidis';
export const APP_ORIGIN = `${APP_SCHEME}://app`;

/** Development only: load the Vite dev server instead of the bundled files. Ignored when packaged. */
export const DEV_SERVER_URL = !app.isPackaged ? (process.env.AIDIS_DEV_SERVER_URL ?? null) : null;
export const IS_DEV = DEV_SERVER_URL !== null;

/** Origin the renderer runs on (requests from it get the CORS bridge, permissions are granted to it). */
export const RENDERER_ORIGIN = DEV_SERVER_URL ? new URL(DEV_SERVER_URL).origin : APP_ORIGIN;
export const RENDERER_ENTRY = DEV_SERVER_URL ?? `${APP_ORIGIN}/`;

/** build/main/main.cjs -> app root (Desktop/ in dev, app.asar when packaged). */
export const APP_ROOT = app.getAppPath();
export const RENDERER_DIR = join(APP_ROOT, 'build', 'renderer');
export const PRELOAD_PATH = join(APP_ROOT, 'build', 'preload', 'preload.cjs');

/**
 * Icons live outside app.asar (electron-builder extraResources -> resources/assets) so Windows
 * APIs that need a real file path (tray, notifications) can read them. In development they come
 * straight from Desktop/assets.
 */
export const ASSETS_DIR = app.isPackaged ? join(process.resourcesPath, 'assets') : join(APP_ROOT, 'assets');
export const ICON_PATH = join(ASSETS_DIR, 'aidis.ico');
export const LOGO_PATH = join(ASSETS_DIR, 'aidis-logo.png');

/** Launched by Windows at sign-in ("Start with Windows"): start in the tray. */
export const AUTOSTART_ARG = '--autostart';

/** In-game overlay (0.3.0): its own small page + preload, loaded from the app files (no network). */
export const OVERLAY_HTML = join(APP_ROOT, 'build', 'overlay', 'overlay.html');
/** 0.5.0 AIDis notification window (bottom-right cards). */
export const TOAST_HTML = join(APP_ROOT, 'build', 'toast', 'toast.html');
export const TOAST_PRELOAD_PATH = join(APP_ROOT, 'build', 'toast', 'toast-preload.cjs');
export const OVERLAY_PRELOAD_PATH = join(APP_ROOT, 'build', 'overlay', 'overlay-preload.cjs');
