import { describe, expect, it, vi } from 'vitest';

const registered = new Map<string, () => void>();
vi.mock('electron', () => ({
  app: { isPackaged: true, getAppPath: () => 'C:/app', getVersion: () => '0.4.2', getPath: () => 'C:/tmp' },
  BrowserWindow: vi.fn(),
  Menu: { buildFromTemplate: vi.fn(() => ({})) },
  Tray: vi.fn(),
  dialog: {},
  shell: {},
  globalShortcut: {
    register: vi.fn((acc: string, cb: () => void) => {
      registered.set(acc, cb);
      return true;
    }),
    unregisterAll: vi.fn(() => registered.clear()),
  },
  powerMonitor: { on: vi.fn(), off: vi.fn(), getSystemIdleTime: () => 0 },
  screen: { on: vi.fn(), off: vi.fn() },
}));
// The real native hook module is replaced by a fake that never touches the keyboard.
const hookHandlers = new Map<string, (e: unknown) => void>();
vi.mock('uiohook-napi', () => ({
  UiohookKey: { Ctrl: 29, CtrlRight: 3613, Alt: 56, AltRight: 3640, Shift: 42, ShiftRight: 54, M: 50, F8: 66 },
  uIOhook: {
    on: (name: string, fn: (e: unknown) => void) => hookHandlers.set(name, fn),
    off: (name: string) => hookHandlers.delete(name),
    start: vi.fn(),
    stop: vi.fn(),
  },
}));
Object.assign(process, { resourcesPath: 'C:/app/resources' });

const { HotkeyManager } = await import('../src/main/hotkeys');
const { toAccelerator, needsHook, toHookMatcher } = await import('../src/main/keymap');
const { trayIconState, trayTooltip } = await import('../src/main/tray');
const { isHexColor } = await import('../src/main/mainWindow');
const { DEFAULT_KEYBINDS } = await import('../../Client/src/desktop/contract');

const key = (keycode: number) => ({ keycode, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, type: 4, time: 0, x: 0, y: 0 }) as never;

describe('0.4.2 hotkeys: Right Ctrl and one toggle per physical press', () => {
  it('lone modifiers bypass RegisterHotKey and use the hook (left / right distinguished)', () => {
    expect(toAccelerator('RightCtrl')).toBeNull();
    expect(needsHook('RightCtrl')).toBe(true);
    expect(needsHook('Ctrl+Shift+M')).toBe(false);
    expect(toHookMatcher('RightCtrl', { Ctrl: 29, CtrlRight: 3613 })?.keycodes).toEqual([3613]);
    expect(toHookMatcher('LeftCtrl', { Ctrl: 29, CtrlRight: 3613 })?.keycodes).toEqual([29]);
  });

  it('Right Ctrl toggles mute once per press, holding does not repeat, Left Ctrl does nothing', () => {
    const actions: string[] = [];
    const m = new HotkeyManager({ onAction: (a) => actions.push(a), onPushToTalk: vi.fn(), onStatus: vi.fn() });
    m.configure({ ...DEFAULT_KEYBINDS, toggleMute: 'RightCtrl' }, false);
    m.handleKey('down', key(3613));
    m.handleKey('down', key(3613)); // OS auto-repeat while held
    m.handleKey('down', key(3613));
    expect(actions).toEqual(['toggleMute']);
    m.handleKey('up', key(3613));
    m.handleKey('down', key(29)); // Left Ctrl
    m.handleKey('up', key(29));
    m.handleKey('down', key(3613)); // second physical press
    m.handleKey('up', key(3613));
    expect(actions).toEqual(['toggleMute', 'toggleMute']);
    expect(m.status.failed).toEqual([]);
    m.dispose();
  });

  it('RegisterHotKey auto-repeat while the key is still held does not toggle again (F8)', () => {
    const actions: string[] = [];
    const m = new HotkeyManager({ onAction: (a) => actions.push(a), onPushToTalk: vi.fn(), onStatus: vi.fn() });
    m.configure({ ...DEFAULT_KEYBINDS, toggleDeafen: 'F8' }, false);
    const fire = registered.get('F8');
    expect(fire).toBeDefined();
    m.handleKey('down', key(66));
    fire?.();
    vi.useFakeTimers();
    vi.advanceTimersByTime(600); // past Windows' initial repeat delay
    fire?.(); // WM_HOTKEY repeat while still held
    m.handleKey('up', key(66));
    m.handleKey('down', key(66));
    vi.advanceTimersByTime(10);
    fire?.(); // a new press
    vi.useRealTimers();
    expect(actions.filter((a) => a === 'toggleDeafen')).toHaveLength(2);
    m.dispose();
  });
});

describe('0.4.2 tray icon states', () => {
  const base = { inCall: true, micEnabled: true, deafened: false, screenSharing: false, channelName: 'General' };
  it('priority: deafened > muted > speaking > voice > normal', () => {
    expect(trayIconState({ ...base, inCall: false })).toBe('normal');
    expect(trayIconState(base)).toBe('voice');
    expect(trayIconState({ ...base, speaking: true })).toBe('speaking');
    expect(trayIconState({ ...base, speaking: true, micEnabled: false })).toBe('muted');
    expect(trayIconState({ ...base, speaking: true, micEnabled: false, deafened: true })).toBe('deafened');
  });
  it('tooltip names the channel and state', () => {
    const t = (k: string) => ({ trayTooltip: 'AIDis', trayInVoice: 'Voice', trayMuted: 'Microphone muted', trayDeafened: 'Sound off', traySpeaking: 'Speaking' })[k] ?? k;
    expect(trayTooltip(base, t)).toBe('AIDis — General');
    expect(trayTooltip({ ...base, micEnabled: false }, t)).toBe('AIDis — General — Microphone muted');
    expect(trayTooltip({ ...base, speaking: true }, t)).toBe('AIDis — General — Speaking');
    expect(trayTooltip({ ...base, inCall: false }, t)).toBe('AIDis');
  });
});

describe('0.4.2 title bar colors', () => {
  it('accepts only #rrggbb from the renderer', () => {
    expect(isHexColor('#0f0b1d')).toBe(true);
    expect(isHexColor('red')).toBe(false);
    expect(isHexColor('#fff')).toBe(false);
    expect(isHexColor('url(javascript:1)')).toBe(false);
  });
});
