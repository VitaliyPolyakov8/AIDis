import { BrowserWindow, nativeImage, screen, type IpcMainEvent } from 'electron';
import { ICON_PATH, TOAST_HTML, TOAST_PRELOAD_PATH } from './config';
import { IPC } from '../shared/ipc';
import { logger } from './logger';

/**
 * 0.5.0 AIDis notifications (replace the Windows toasts for chat messages).
 *
 * ONE small transparent, frameless, always-on-top window in the bottom-right corner of the primary
 * screen's work area (above the taskbar) renders a vertical stack of AIDis cards: app icon, sender
 * avatar and name (nickname color), channel / DM and a short preview. It never takes focus
 * (focusable: false, shown inactive) and is click-through except over a card. It sits above normal
 * desktop windows and borderless games; nothing is injected into any game. Exclusive-fullscreen
 * games bypass the desktop compositor, so no window can appear there.
 *
 * At most MAX_VISIBLE cards are on screen; the rest wait in a short queue (oldest dropped beyond
 * MAX_QUEUED). Each card stays TOAST_MS (paused while the mouse is over the stack), clicking opens
 * AIDis at that chat, × closes it.
 */
export const MAX_VISIBLE = 3;
export const MAX_QUEUED = 20;
export const TOAST_MS = 5500;
const WIDTH = 380;
const CARD_HEIGHT = 92;
const GAP = 10;
const MARGIN = 14;

export interface ToastRequest {
  author: string;
  channelLabel: string;
  body: string;
  channelId: string;
  /** data:image/... (64 px) or null for initials. */
  avatar: string | null;
  initials: string;
  color: string;
  nameColor: string | null;
  mention: boolean;
}

export interface ToastItem extends ToastRequest {
  id: number;
}

const CHANNEL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;

function str(value: unknown, max: number): string | null {
  return typeof value === 'string' ? value.trim().slice(0, max) : null;
}

/** Pure: validates a renderer request (it comes from our own page, still never trusted blindly). */
export function sanitizeToast(value: unknown): ToastRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const author = str(v.author, 80);
  const channelId = typeof v.channelId === 'string' && CHANNEL_ID.test(v.channelId) ? v.channelId : null;
  if (!author || !channelId) return null;
  const avatar = typeof v.avatar === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(v.avatar) && v.avatar.length < 300_000 ? v.avatar : null;
  return {
    author,
    channelLabel: str(v.channelLabel, 80) ?? '',
    body: str(v.body, 240) ?? '',
    channelId,
    avatar,
    initials: (str(v.initials, 3) ?? '?') || '?',
    color: typeof v.color === 'string' && HEX.test(v.color) ? v.color : '#5b7cff',
    nameColor: typeof v.nameColor === 'string' && HEX.test(v.nameColor) ? v.nameColor : null,
    mention: v.mention === true,
  };
}

/** Pure queue logic (unit-tested): what is visible, what waits. */
export class ToastQueue {
  private nextId = 1;
  visible: ToastItem[] = [];
  waiting: ToastItem[] = [];

  push(request: ToastRequest): ToastItem {
    const item = { ...request, id: this.nextId++ };
    if (this.visible.length < MAX_VISIBLE) this.visible = [...this.visible, item];
    else this.waiting = [...this.waiting, item].slice(-MAX_QUEUED);
    return item;
  }

  /** Removes a card; the oldest waiting one takes its place. Returns the card that became visible. */
  remove(id: number): ToastItem | null {
    const before = this.visible.length;
    this.visible = this.visible.filter((t) => t.id !== id);
    this.waiting = this.waiting.filter((t) => t.id !== id);
    if (this.visible.length < before && this.waiting.length > 0 && this.visible.length < MAX_VISIBLE) {
      const [next, ...rest] = this.waiting;
      this.waiting = rest;
      if (next) {
        this.visible = [...this.visible, next];
        return next;
      }
    }
    return null;
  }

  get(id: number): ToastItem | undefined {
    return this.visible.find((t) => t.id === id);
  }

  clear(): void {
    this.visible = [];
    this.waiting = [];
  }
}

export type ToastUpdate = { type: 'list'; toasts: ToastItem[]; icon: string | null };

export class ToastService {
  private win: BrowserWindow | null = null;
  private ready = false;
  private readonly queue = new ToastQueue();
  private readonly timers = new Map<number, { timer: ReturnType<typeof setTimeout> | null; left: number; started: number }>();
  private hovering = false;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private icon: string | null = null;

  constructor(private readonly onOpen: (channelId: string) => void) {}

  show(value: unknown): void {
    const request = sanitizeToast(value);
    if (!request) return;
    const item = this.queue.push(request);
    if (this.queue.get(item.id)) this.startTimer(item.id);
    this.render();
  }

  /** Only the toast window may send actions. */
  isToastSender(event: IpcMainEvent): boolean {
    return this.win !== null && !this.win.isDestroyed() && event.sender === this.win.webContents;
  }

  handleFromToast(value: unknown): void {
    if (typeof value !== 'object' || value === null) return;
    const v = value as Record<string, unknown>;
    if (v.type === 'hover') {
      this.setHover(v.hover === true);
      return;
    }
    if (typeof v.id !== 'number') return;
    const item = this.queue.get(v.id);
    if (!item) return;
    if (v.type === 'open') this.onOpen(item.channelId);
    if (v.type === 'open' || v.type === 'close') this.dismiss(item.id);
  }

  /** The main window got focus while cards are shown: they are no longer needed. */
  clearAll(): void {
    for (const entry of this.timers.values()) if (entry.timer) clearTimeout(entry.timer);
    this.timers.clear();
    this.queue.clear();
    this.render();
  }

  destroy(): void {
    this.clearAll();
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }

  private dismiss(id: number): void {
    const entry = this.timers.get(id);
    if (entry?.timer) clearTimeout(entry.timer);
    this.timers.delete(id);
    const next = this.queue.remove(id);
    if (next) this.startTimer(next.id);
    this.render();
  }

  private startTimer(id: number, left = TOAST_MS): void {
    const timer = this.hovering ? null : setTimeout(() => this.dismiss(id), left);
    this.timers.set(id, { timer, left, started: Date.now() });
  }

  /** The mouse over the stack pauses every timer (so a card can be read and clicked). */
  private setHover(hover: boolean): void {
    if (this.hovering === hover) return;
    this.hovering = hover;
    if (this.win && !this.win.isDestroyed()) this.win.setIgnoreMouseEvents(!hover, { forward: true });
    for (const [id, entry] of this.timers) {
      if (hover && entry.timer) {
        clearTimeout(entry.timer);
        this.timers.set(id, { timer: null, left: Math.max(1500, entry.left - (Date.now() - entry.started)), started: Date.now() });
      } else if (!hover && !entry.timer) {
        this.timers.set(id, { timer: setTimeout(() => this.dismiss(id), entry.left), left: entry.left, started: Date.now() });
      }
    }
  }

  private render(): void {
    const toasts = this.queue.visible;
    if (toasts.length === 0) {
      this.send({ type: 'list', toasts, icon: this.icon });
      if (this.hideTimer) clearTimeout(this.hideTimer);
      // Let the last card slide out before the window goes away.
      this.hideTimer = setTimeout(() => {
        if (this.queue.visible.length === 0 && this.win && !this.win.isDestroyed()) {
          this.win.hide();
          this.setHover(false);
        }
      }, 400);
      return;
    }
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    const win = this.ensureWindow();
    this.place(win);
    this.send({ type: 'list', toasts, icon: this.icon });
    if (!win.isVisible()) win.showInactive();
    win.setAlwaysOnTop(true, 'screen-saver');
  }

  private place(win: BrowserWindow): void {
    const area = screen.getPrimaryDisplay().workArea;
    const height = MAX_VISIBLE * (CARD_HEIGHT + GAP) + MARGIN;
    win.setBounds({ x: area.x + area.width - WIDTH - MARGIN, y: area.y + area.height - height - MARGIN, width: WIDTH, height });
  }

  private send(update: ToastUpdate): void {
    if (this.win && this.ready && !this.win.isDestroyed()) this.win.webContents.send(IPC.toastUpdate, update);
  }

  private ensureWindow(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    if (!this.icon) {
      try {
        const image = nativeImage.createFromPath(ICON_PATH);
        this.icon = image.isEmpty() ? null : image.resize({ width: 32, height: 32 }).toDataURL();
      } catch {
        this.icon = null;
      }
    }
    const win = new BrowserWindow({
      width: WIDTH,
      height: 300,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      alwaysOnTop: true,
      title: 'AIDis Notifications',
      webPreferences: {
        preload: TOAST_PRELOAD_PATH,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
        devTools: false,
      },
    });
    win.setIgnoreMouseEvents(true, { forward: true });
    win.setVisibleOnAllWorkspaces(true);
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.once('did-finish-load', () => {
      this.ready = true;
      this.send({ type: 'list', toasts: this.queue.visible, icon: this.icon });
    });
    win.on('closed', () => {
      this.win = null;
      this.ready = false;
    });
    void win.loadFile(TOAST_HTML).catch((error: unknown) => logger.warn('toasts', 'Could not load the notification window', error));
    this.win = win;
    return win;
  }
}
