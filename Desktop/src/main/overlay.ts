import { BrowserWindow, screen, type Display, type IpcMainEvent, type Rectangle } from 'electron';
import { effectiveOverlay, type OverlayAction, type OverlayMessage, type OverlayReply, type OverlaySettings, type OverlayVoiceState } from '../../../Client/src/desktop/contract';
import { IPC } from '../shared/ipc';
import { OVERLAY_HTML, OVERLAY_PRELOAD_PATH } from './config';
import type { StreamHint } from './streamHints';

/** 0.4.1: profile frames the overlay can draw (anything else is dropped). */
const OVERLAY_FRAMES = new Set(['neon', 'scifi', 'gold', 'pulse', 'violet']);
import { logger } from './logger';

/** The two overlay windows: the voice list and (0.4.0) the message panel, placed independently. */
export type OverlayPanel = 'list' | 'chat';

/** What the overlay page receives (see src/overlay/overlay.ts). */
export type OverlayUpdate =
  | { type: 'stream-hint'; hint: StreamHint }
  | { type: 'config'; settings: OverlaySettings; interactive: boolean; language: 'ru' | 'en'; panel: OverlayPanel; game: string | null }
  | { type: 'state'; state: OverlayVoiceState }
  | { type: 'message'; message: OverlayMessage }
  | { type: 'recent'; messages: OverlayMessage[] };

const SIZES: Record<OverlayPanel, { width: number; height: number }> = {
  list: { width: 300, height: 420 },
  chat: { width: 340, height: 300 },
};
const MARGIN = 16;
const GAP = 8;
const RECENT_LIMIT = 10;

const EMPTY_STATE: OverlayVoiceState = { inCall: false, channelName: '', participants: [], micEnabled: true, deafened: false };

export interface OverlayDeps {
  /** Keep video overlays in the same interaction mode, including Done and preview. */
  onInteractiveChange?: (on: boolean) => void;
  /** Saves a position dragged by hand (interaction mode): globally, or into the running game's profile. */
  savePosition: (panel: OverlayPanel, position: NonNullable<OverlaySettings['custom']>, game: string | null) => void;
  /** Mute / deafen / "watch this stream" pressed on the overlay: forwarded to the main window. */
  onAction: (action: OverlayAction) => void;
  /** 0.4.0 quick reply typed in the overlay: forwarded to the main window, which sends it. */
  onReply: (reply: OverlayReply) => void;
}

/**
 * In-game overlay: SEPARATE transparent, frameless, always-on-top Electron windows above the game
 * (borderless / windowed games; true exclusive fullscreen bypasses the desktop compositor, so no
 * normal window can appear there). Nothing is injected into, hooked into or read from any game:
 * no DLLs, no hooks, no memory access, no drivers.
 *
 * Normally the windows ignore the mouse (click-through) and cannot take focus, so the game keeps
 * keyboard and mouse. The "interaction" hotkey makes them clickable and draggable (and the message
 * panel accepts a quick reply) until it is pressed again or "Done" is clicked. Event driven: they
 * only repaint when the call state, a message or the settings change.
 *
 * 0.4.0: two windows (voice list + message panel, dragged independently), per-game layouts
 * (profiles keyed by the detected game), "show only while a game runs".
 */
export class OverlayService {
  private readonly wins: Record<OverlayPanel, BrowserWindow | null> = { list: null, chat: null };
  private readonly ready: Record<OverlayPanel, boolean> = { list: false, chat: false };
  private settings: OverlaySettings | null = null;
  private language: 'ru' | 'en' = 'en';
  private hiddenByUser = false;
  private interactive = false;
  private game: string | null = null;
  private state: OverlayVoiceState = EMPTY_STATE;
  private recent: OverlayMessage[] = [];
  private readonly deps: OverlayDeps;
  private readonly onDisplaysChanged = () => this.placeAll();
  private displayEvents = false;

  constructor(deps: OverlayDeps) {
    this.deps = deps;
  }

  /** The settings in effect now (the running game's profile, if it has one). */
  private get effective(): OverlaySettings | null {
    return this.settings ? effectiveOverlay(this.settings, this.game) : null;
  }

  /** Call after app 'ready' (the screen module is unavailable before). */
  configure(settings: OverlaySettings, language: 'ru' | 'en'): void {
    if (!this.displayEvents) {
      this.displayEvents = true;
      screen.on('display-added', this.onDisplaysChanged);
      screen.on('display-removed', this.onDisplaysChanged);
      screen.on('display-metrics-changed', this.onDisplaysChanged);
    }
    this.settings = settings;
    this.language = language;
    if (!settings.enabled) {
      this.interactive = false;
      this.deps.onInteractiveChange?.(false);
      this.destroyWindows();
      return;
    }
    this.applyLayout();
  }

  /** The detected game (display name) or null; selects its overlay profile. */
  setGame(game: string | null): void {
    if (this.game === game) return;
    this.game = game;
    if (this.settings?.enabled) this.applyLayout();
  }

  setState(state: OverlayVoiceState): void {
    this.state = state;
    this.send('list', { type: 'state', state });
    this.send('chat', { type: 'state', state });
    this.updateVisibility();
  }

  pushMessage(message: OverlayMessage): void {
    this.recent = [...this.recent.filter((m) => m.id !== message.id), message].slice(-RECENT_LIMIT);
    if (this.settings?.messageMode !== 'off') this.send('chat', { type: 'message', message });
    this.updateVisibility();
  }

  /** Global hotkey: hide / show for this session. */
  toggleVisible(): void {
    this.hiddenByUser = !this.hiddenByUser;
    logger.info('overlay', this.hiddenByUser ? 'Hidden by hotkey' : 'Shown by hotkey');
    this.updateVisibility();
  }

  /** Global hotkey: interaction mode on/off (clickable, draggable, buttons, quick reply). */
  toggleInteractive(): void {
    this.setInteractive(!this.interactive);
  }

  /** Settings button: show the overlay now in interaction mode so it can be placed. */
  preview(): void {
    if (!this.settings?.enabled) return;
    this.hiddenByUser = false;
    this.setInteractive(true);
  }

  /** Global hotkey: show the last messages for a few seconds. */
  showRecent(): void {
    if (!this.settings?.enabled) return;
    this.send('chat', { type: 'recent', messages: this.recent.slice(-5) });
    this.updateVisibility(true);
  }

  isOverlaySender(event: IpcMainEvent): boolean {
    return (['list', 'chat'] as const).some((p) => {
      const win = this.wins[p];
      return win !== null && !win.isDestroyed() && event.sender === win.webContents;
    });
  }

  handleFromOverlay(message: unknown): void {
    if (message === 'toggleMute' || message === 'toggleDeafen') {
      this.deps.onAction(message);
      return;
    }
    if (message === 'done') {
      this.setInteractive(false);
      return;
    }
    if (typeof message !== 'object' || message === null) return;
    const m = message as Record<string, unknown>;
    if (m.type === 'watch' && typeof m.id === 'string' && /^[0-9a-f-]{36}$/i.test(m.id)) {
      this.deps.onAction(`watch:${m.id}`);
      return;
    }
    // Quick reply: only while interactive, only to a channel the overlay was told about.
    if (m.type === 'reply' && this.interactive) {
      const reply = sanitizeOverlayReply(m, this.recent);
      if (reply) this.deps.onReply(reply);
    }
  }

  dispose(): void {
    if (this.displayEvents) {
      screen.off('display-added', this.onDisplaysChanged);
      screen.off('display-removed', this.onDisplaysChanged);
      screen.off('display-metrics-changed', this.onDisplaysChanged);
      this.displayEvents = false;
    }
    this.destroyWindows();
  }

  // ---- internals -------------------------------------------------------------------

  private applyLayout(): void {
    for (const panel of ['list', 'chat'] as const) {
      const win = this.wins[panel];
      if (win && !win.isDestroyed()) win.webContents.setZoomFactor((this.effective?.scale ?? 100) / 100);
    }
    this.placeAll();
    this.sendConfig();
    this.updateVisibility();
  }

  /** "Show only when a game is running": no overlay on the desktop; it appears with the game. */
  private visibleBySettings(): boolean {
    const s = this.settings;
    if (!s?.enabled || this.hiddenByUser) return false;
    return !s.onlyInGames || this.game !== null;
  }

  private wanted(panel: OverlayPanel, forceChat = false): boolean {
    const s = this.settings;
    if (!s?.enabled) return false;
    if (this.interactive) return true;
    if (!this.visibleBySettings()) return false;
    if (panel === 'list') return this.state.inCall && s.showParticipants;
    return forceChat || (s.messageMode !== 'off' && (this.state.inCall || this.recent.length > 0));
  }

  private setInteractive(on: boolean): void {
    if (!this.settings?.enabled) return;
    this.interactive = on;
    this.deps.onInteractiveChange?.(on);
    for (const panel of ['list', 'chat'] as const) {
      const win = this.ensureWindow(panel);
      if (on) {
        win.setIgnoreMouseEvents(false);
        win.setFocusable(true);
      } else {
        win.setIgnoreMouseEvents(true, { forward: false });
        win.setFocusable(false);
      }
    }
    logger.info('overlay', on ? 'Interaction mode on' : 'Interaction mode off (click-through)');
    this.sendConfig();
    if (on) this.send('chat', { type: 'recent', messages: this.recent.slice(-5) });
    this.updateVisibility();
    const chat = this.wins.chat;
    if (on) chat?.focus();
    else for (const panel of ['list', 'chat'] as const) this.wins[panel]?.blur();
  }

  private updateVisibility(forceChat = false): void {
    for (const panel of ['list', 'chat'] as const) {
      if (!this.wanted(panel, forceChat)) {
        const hidden = this.wins[panel];
        if (hidden?.isVisible()) hidden.hide();
        continue;
      }
      const win = this.ensureWindow(panel);
      if (!win.isVisible() && this.ready[panel]) {
        this.place(panel);
        // showInactive: never takes keyboard focus from the game.
        win.showInactive();
        win.setAlwaysOnTop(true, 'screen-saver');
      }
    }
  }

  private ensureWindow(panel: OverlayPanel): BrowserWindow {
    const existing = this.wins[panel];
    if (existing && !existing.isDestroyed()) return existing;
    const scale = (this.effective?.scale ?? 100) / 100;
    const size = SIZES[panel];
    const win = new BrowserWindow({
      width: Math.round(size.width * scale),
      height: Math.round(size.height * scale),
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      alwaysOnTop: true,
      title: panel === 'list' ? 'AIDis Overlay' : 'AIDis Overlay Messages',
      webPreferences: {
        preload: OVERLAY_PRELOAD_PATH,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: panel === 'chat',
        devTools: false,
      },
    });
    win.setIgnoreMouseEvents(!this.interactive, { forward: false });
    win.setFocusable(this.interactive);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setMenu(null);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    // Keep the per-panel window title (the page's <title> is shared by both panels).
    win.on('page-title-updated', (event) => event.preventDefault());
    win.webContents.on('did-finish-load', () => {
      this.ready[panel] = true;
      win.webContents.setZoomFactor((this.effective?.scale ?? 100) / 100);
      this.sendConfig();
      this.send(panel, { type: 'state', state: this.state });
      if (panel === 'chat' && this.interactive) this.send('chat', { type: 'recent', messages: this.recent.slice(-5) });
      this.updateVisibility();
    });
    win.on('moved', () => {
      if (!this.interactive) return;
      const bounds = win.getBounds();
      const display = screen.getDisplayMatching(bounds);
      // 0.5.0: the display's rectangle too, so the place is found again after a restart / update.
      this.deps.savePosition(panel, { displayId: display.id, x: bounds.x - display.bounds.x, y: bounds.y - display.bounds.y, bounds: { ...display.bounds } }, this.game);
    });
    win.on('closed', () => {
      if (this.wins[panel] === win) {
        this.wins[panel] = null;
        this.ready[panel] = false;
      }
    });
    this.wins[panel] = win;
    this.ready[panel] = false;
    this.place(panel);
    void win.loadFile(OVERLAY_HTML, { hash: panel });
    return win;
  }

  private destroyWindows(): void {
    for (const panel of ['list', 'chat'] as const) {
      const win = this.wins[panel];
      this.wins[panel] = null;
      this.ready[panel] = false;
      if (win && !win.isDestroyed()) win.destroy();
    }
  }

  private placeAll(): void {
    this.place('list');
    this.place('chat');
  }

  /** Display + position from the settings; a display that is gone falls back to the primary one. */
  private place(panel: OverlayPanel): void {
    const win = this.wins[panel];
    const s = this.effective;
    if (!win || win.isDestroyed() || !s) return;
    const scale = s.scale / 100;
    const listSize = { width: Math.round(SIZES.list.width * scale), height: Math.round(SIZES.list.height * scale) };
    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    const listBounds = computeOverlayBounds(s, listSize, displays, primary);
    if (panel === 'list') {
      win.setBounds(listBounds);
      return;
    }
    const chatSize = { width: Math.round(SIZES.chat.width * scale), height: Math.round(SIZES.chat.height * scale) };
    win.setBounds(computeChatBounds(s, chatSize, listBounds, displays, primary));
  }

  private sendConfig(): void {
    const s = this.effective;
    if (!s) return;
    for (const panel of ['list', 'chat'] as const) {
      this.send(panel, { type: 'config', settings: s, interactive: this.interactive, language: this.language, panel, game: this.game });
    }
  }

  private send(panel: OverlayPanel, update: OverlayUpdate): void {
    const win = this.wins[panel];
    if (win && !win.isDestroyed() && this.ready[panel]) win.webContents.send(IPC.overlayUpdate, update);
  }
}

type Area = Pick<Display, 'id' | 'bounds' | 'workArea'>;

function clampTo(area: Rectangle, x: number, y: number, size: { width: number; height: number }): Rectangle {
  return {
    x: Math.min(Math.max(x, area.x), area.x + Math.max(0, area.width - size.width)),
    y: Math.min(Math.max(y, area.y), area.y + Math.max(0, area.height - size.height)),
    ...size,
  };
}

/**
 * 0.5.0: the display a hand-placed overlay belongs to. Windows display ids change between app
 * starts (an update restarts AIDis), which made the overlay jump back to its corner. Order: the same
 * id with the same rectangle; the same rectangle (new id); the same id; the display containing the
 * saved point; the nearest display. The caller clamps the result onto that display. Pure.
 */
export function findSavedDisplay(saved: NonNullable<OverlaySettings['custom']>, displays: Area[]): Area | null {
  if (displays.length === 0) return null;
  const same = (d: Area) => saved.bounds !== undefined && d.bounds.x === saved.bounds.x && d.bounds.y === saved.bounds.y && d.bounds.width === saved.bounds.width && d.bounds.height === saved.bounds.height;
  const byIdAndRect = displays.find((d) => d.id === saved.displayId && same(d));
  if (byIdAndRect) return byIdAndRect;
  const byRect = displays.find(same);
  if (byRect) return byRect;
  if (!saved.bounds) return displays.find((d) => d.id === saved.displayId) ?? null;
  const px = saved.bounds.x + saved.x;
  const py = saved.bounds.y + saved.y;
  const containing = displays.find((d) => px >= d.bounds.x && px < d.bounds.x + d.bounds.width && py >= d.bounds.y && py < d.bounds.y + d.bounds.height);
  if (containing) return containing;
  const byId = displays.find((d) => d.id === saved.displayId);
  if (byId) return byId;
  const distance = (d: Area) => {
    const dx = Math.max(d.bounds.x - px, 0, px - (d.bounds.x + d.bounds.width));
    const dy = Math.max(d.bounds.y - py, 0, py - (d.bounds.y + d.bounds.height));
    return dx * dx + dy * dy;
  };
  return [...displays].sort((a, b) => distance(a) - distance(b))[0] ?? null;
}

/** Pure placement (unit-tested): custom position on its display, else a corner of the chosen display. */
export function computeOverlayBounds(s: Pick<OverlaySettings, 'corner' | 'displayId' | 'custom'>, size: { width: number; height: number }, displays: Area[], primary: Area): Rectangle {
  if (s.custom) {
    const display = findSavedDisplay(s.custom, displays);
    if (display) return clampTo(display.workArea, display.bounds.x + s.custom.x, display.bounds.y + s.custom.y, size);
  }
  const display = displays.find((d) => d.id === s.displayId) ?? primary;
  const area = display.workArea;
  const left = s.corner.endsWith('left');
  const top = s.corner.startsWith('top');
  return clampTo(area, left ? area.x + MARGIN : area.x + area.width - size.width - MARGIN, top ? area.y + MARGIN : area.y + area.height - size.height - MARGIN, size);
}

/**
 * Message panel placement (unit-tested): its own dragged position, else right below the voice list
 * (above it for bottom corners), on the same display.
 */
export function computeChatBounds(s: Pick<OverlaySettings, 'corner' | 'chatCustom'>, size: { width: number; height: number }, list: Rectangle, displays: Area[], primary: Area): Rectangle {
  if (s.chatCustom) {
    const display = findSavedDisplay(s.chatCustom, displays);
    if (display) return clampTo(display.workArea, display.bounds.x + s.chatCustom.x, display.bounds.y + s.chatCustom.y, size);
  }
  const display = displays.find((d) => list.x >= d.bounds.x && list.x < d.bounds.x + d.bounds.width && list.y >= d.bounds.y && list.y < d.bounds.y + d.bounds.height) ?? primary;
  const top = s.corner.startsWith('top');
  const left = s.corner.endsWith('left');
  const x = left ? list.x : list.x + list.width - size.width;
  const y = top ? list.y + list.height + GAP : list.y - size.height - GAP;
  return clampTo(display.workArea, x, y, size);
}

// ---- IPC validation (the page is trusted, but nothing is taken for granted) ---------------

function str(value: unknown, max: number): string | null {
  return typeof value === 'string' ? value.slice(0, max) : null;
}

function dataUrl(value: unknown): string | null {
  // Small avatar images only (64 px renders are ~5-15 kB).
  return typeof value === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value) && value.length < 200_000 ? value : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sanitizeOverlayState(value: unknown): OverlayVoiceState | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.inCall !== 'boolean' || !Array.isArray(v.participants)) return null;
  const participants = v.participants.slice(0, 50).flatMap((raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) return [];
    const p = raw as Record<string, unknown>;
    const id = str(p.id, 64);
    const name = str(p.name, 80);
    if (!id || name === null) return [];
    return [
      {
        id,
        name,
        avatar: dataUrl(p.avatar),
        color: str(p.color, 32) ?? '#5865f2',
        initials: str(p.initials, 3) ?? '',
        speaking: p.speaking === true,
        micMuted: p.micMuted === true,
        deafened: p.deafened === true,
        isSelf: p.isSelf === true,
        streaming: p.streaming === true,
        watching: p.watching === true,
        frame: typeof p.frame === 'string' && OVERLAY_FRAMES.has(p.frame) ? p.frame : null,
        // 0.5.1: a built-in frame id (plain identifier; the overlay page builds the file name).
        cosmeticFrame: typeof p.cosmeticFrame === 'string' && /^[a-z_]{1,32}$/.test(p.cosmeticFrame) ? p.cosmeticFrame : null,
        // 0.5.6: the name style (it was dropped here before, so names were never colored in the overlay).
        ...nameStyle(p),
      },
    ];
  });
  return {
    inCall: v.inCall,
    channelName: str(v.channelName, 100) ?? '',
    participants,
    micEnabled: v.micEnabled !== false,
    deafened: v.deafened === true,
  };
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const NAME_FONT = /^[a-z-]{1,24}$/;

/** 0.5.6: name color, gradient, glow and font id: only #rrggbb and plain ids pass. */
function nameStyle(v: Record<string, unknown>): { nameColor: string | null; nameColor2: string | null; nameGlow: boolean; nameFont: string | null } {
  return {
    nameColor: typeof v.nameColor === 'string' && HEX_COLOR.test(v.nameColor) ? v.nameColor : null,
    nameColor2: typeof v.nameColor2 === 'string' && HEX_COLOR.test(v.nameColor2) ? v.nameColor2 : null,
    nameGlow: v.nameGlow === true,
    nameFont: typeof v.nameFont === 'string' && NAME_FONT.test(v.nameFont) ? v.nameFont : null,
  };
}

export function sanitizeOverlayMessage(value: unknown): OverlayMessage | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const id = str(v.id, 64);
  const text = str(v.text, 300);
  if (!id || text === null) return null;
  const channelId = typeof v.channelId === 'string' && UUID.test(v.channelId) ? v.channelId : undefined;
  return {
    id,
    authorName: str(v.authorName, 80) ?? '',
    avatar: dataUrl(v.avatar),
    color: str(v.color, 32) ?? '#5865f2',
    initials: str(v.initials, 3) ?? '',
    text,
    ...nameStyle(v),
    at: typeof v.at === 'number' && Number.isFinite(v.at) ? v.at : Date.now(),
    ...(channelId ? { channelId } : {}),
    ...(typeof v.channelLabel === 'string' ? { channelLabel: v.channelLabel.slice(0, 80) } : {}),
    mention: v.mention === true,
  };
}

/** A quick reply may only target a channel (and message) the overlay was actually shown. */
export function sanitizeOverlayReply(value: Record<string, unknown>, shown: OverlayMessage[]): OverlayReply | null {
  const text = typeof value.text === 'string' ? value.text.trim().slice(0, 2000) : '';
  const channelId = typeof value.channelId === 'string' && UUID.test(value.channelId) ? value.channelId : null;
  if (!text || !channelId) return null;
  if (!shown.some((m) => m.channelId === channelId)) return null;
  const replyToId = typeof value.replyToId === 'string' && UUID.test(value.replyToId) && shown.some((m) => m.id === value.replyToId) ? value.replyToId : null;
  return { channelId, replyToId, text };
}
