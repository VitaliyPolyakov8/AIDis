import { globalShortcut } from 'electron';
import { HOTKEY_ACTIONS, hotkeyKind, type HotkeyAction, type HotkeyStatus, type Keybinds } from '../../../Client/src/desktop/contract';
import { modifiersSatisfied, needsHook, toAccelerator, toHookMatcher, type HookMatcher } from './keymap';
import { logger } from './logger';

type UiohookModule = typeof import('uiohook-napi');
type KeyboardEvent = import('uiohook-napi').UiohookKeyboardEvent;
type MouseEvent = import('uiohook-napi').UiohookMouseEvent;

/** Without the input hook: Windows repeats WM_HOTKEY while a combination is held; one press = one action. */
const REPEAT_GUARD_MS = 350;

type ToggleAction = Exclude<HotkeyAction, 'pushToTalk'>;

export interface HotkeyHandlers {
  onAction: (action: ToggleAction) => void;
  onPushToTalk: (pressed: boolean) => void;
  onStatus: (status: HotkeyStatus) => void;
}

/**
 * Global hotkeys.
 *
 * Toggle actions use Electron globalShortcut (Windows RegisterHotKey): they fire while AIDis is
 * minimized, in the tray or behind a fullscreen game, and registration reports when another
 * application already owns a combination.
 *
 * Push-to-Talk needs key-down AND key-up, which RegisterHotKey cannot report, so it uses a
 * low-level keyboard/mouse hook (uiohook-napi). The hook only observes: the game still receives
 * the key, nothing is injected.
 *
 * 0.4.2:
 * - A modifier key on its own (Right Ctrl, Left Alt...) cannot be registered with RegisterHotKey,
 *   so such toggles are handled by the hook too: it distinguishes left / right modifiers by key code.
 * - One physical press = one toggle: the hook remembers which keys are down; a toggle fires on the
 *   first key-down only and again only after that key was released. While the hook runs it also
 *   filters RegisterHotKey's auto-repeat (holding a key past Windows' repeat delay used to toggle twice).
 * The hook runs while any hotkey is bound (it is event-driven and costs nothing while idle) and is
 * stopped while a new hotkey is being recorded and on quit.
 */
export class HotkeyManager {
  private keybinds: Keybinds | null = null;
  private pttMode = false;
  private inCall = false;
  private capturing = false;
  private failed: HotkeyAction[] = [];
  private lastFired = new Map<HotkeyAction, number>();

  private hookModule: UiohookModule | null | undefined;
  private hookRunning = false;
  private matcher: HookMatcher | null = null;
  private pttDown = false;
  /** Toggles handled by the hook (lone modifier keys). */
  private hookToggles: { action: ToggleAction; matcher: HookMatcher }[] = [];
  /** Key codes for every registered toggle (for auto-repeat filtering of globalShortcut). */
  private toggleKeycodes = new Map<ToggleAction, number[]>();
  /** Key code -> when its current physical press began (absent = key is up). */
  private readonly pressed = new Map<number, number>();
  private readonly handlers: HotkeyHandlers;

  constructor(handlers: HotkeyHandlers) {
    this.handlers = handlers;
  }

  get status(): HotkeyStatus {
    return { failed: [...this.failed], pttAvailable: this.loadHook() !== null };
  }

  configure(keybinds: Keybinds, pttMode: boolean): void {
    const changed = JSON.stringify(keybinds) !== JSON.stringify(this.keybinds);
    this.keybinds = keybinds;
    this.pttMode = pttMode;
    if (changed) this.registerShortcuts();
    this.updateHook();
  }

  setInCall(inCall: boolean): void {
    if (this.inCall === inCall) return;
    this.inCall = inCall;
    this.updateHook();
  }

  /** While the settings page records a new combination, every global hotkey is released. */
  setCapturing(capturing: boolean): void {
    if (this.capturing === capturing) return;
    this.capturing = capturing;
    this.registerShortcuts();
    this.updateHook();
  }

  dispose(): void {
    globalShortcut.unregisterAll();
    this.stopHook();
  }

  private registerShortcuts(): void {
    globalShortcut.unregisterAll();
    this.failed = [];
    this.hookToggles = [];
    this.toggleKeycodes.clear();
    if (!this.keybinds || this.capturing) {
      this.handlers.onStatus(this.status);
      return;
    }
    const hook = this.loadHook();
    for (const { id } of HOTKEY_ACTIONS) {
      if (hotkeyKind(id) !== 'toggle' || id === 'pushToTalk') continue;
      const binding = this.keybinds[id];
      if (!binding) continue;
      const matcher = hook ? toHookMatcher(binding, hook.UiohookKey) : null;
      if (matcher) this.toggleKeycodes.set(id, matcher.keycodes);
      if (needsHook(binding)) {
        if (matcher) {
          this.hookToggles.push({ action: id, matcher });
        } else {
          this.failed.push(id);
          logger.warn('hotkeys', `${binding} for ${id} needs the input hook, which is unavailable`);
        }
        continue;
      }
      const accelerator = toAccelerator(binding);
      let ok = false;
      try {
        ok = accelerator !== null && globalShortcut.register(accelerator, () => this.fireShortcut(id));
      } catch (error) {
        logger.warn('hotkeys', `Registering ${binding} threw`, error);
      }
      if (!ok) {
        this.failed.push(id);
        logger.warn('hotkeys', `Could not register ${binding} for ${id} (used by another application?)`);
      }
    }
    this.handlers.onStatus(this.status);
  }

  /** RegisterHotKey fired (also on auto-repeat while the key is held). */
  private fireShortcut(action: ToggleAction): void {
    const now = Date.now();
    const last = this.lastFired.get(action) ?? 0;
    // Key codes of this binding that the hook currently sees held down.
    const held = this.hookRunning ? (this.toggleKeycodes.get(action) ?? []).filter((code) => this.pressed.has(code)) : [];
    if (held.length > 0) {
      // Still the same physical press as the last toggle: an auto-repeat, ignore it.
      if (held.some((code) => (this.pressed.get(code) ?? Infinity) <= last)) return;
    } else {
      // The hook cannot see the key (no hook, or an elevated window has focus): time guard.
      this.lastFired.set(action, now);
      if (now - last < REPEAT_GUARD_MS) return;
    }
    this.fire(action, now);
  }

  private fire(action: ToggleAction, now = Date.now()): void {
    this.lastFired.set(action, now);
    logger.info('hotkeys', `Hotkey: ${action}`);
    this.handlers.onAction(action);
  }

  // ---- input hook (push-to-talk, lone modifier toggles, repeat filtering) ---------------------

  private loadHook(): UiohookModule | null {
    if (this.hookModule !== undefined) return this.hookModule;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      this.hookModule = require('uiohook-napi') as UiohookModule;
    } catch (error) {
      this.hookModule = null;
      logger.error('hotkeys', 'Global input hook unavailable; push-to-talk disabled', error);
    }
    return this.hookModule;
  }

  private get pttActive(): boolean {
    return this.pttMode && this.inCall && (this.keybinds?.pushToTalk ?? null) !== null;
  }

  private updateHook(): void {
    if (this.capturing || !this.keybinds) {
      this.stopHook();
      return;
    }
    const hook = this.loadHook();
    if (!hook) return;
    const binding = this.keybinds.pushToTalk;
    this.matcher = this.pttActive && binding ? toHookMatcher(binding, hook.UiohookKey) : null;
    if (this.pttActive && !this.matcher) logger.warn('hotkeys', `Push-to-talk key ${binding ?? ''} is not supported by the input hook`);
    if (!this.pttActive) this.releasePtt();
    const anyToggle = this.toggleKeycodes.size > 0 || this.hookToggles.length > 0;
    if (!this.matcher && !anyToggle) {
      this.stopHook();
      return;
    }
    if (this.hookRunning) return;
    try {
      hook.uIOhook.on('keydown', this.onKeyDown);
      hook.uIOhook.on('keyup', this.onKeyUp);
      hook.uIOhook.on('mousedown', this.onMouseDown);
      hook.uIOhook.on('mouseup', this.onMouseUp);
      hook.uIOhook.start();
      this.hookRunning = true;
      logger.info('hotkeys', 'Input hook started');
    } catch (error) {
      this.removeHookListeners(hook);
      logger.error('hotkeys', 'Could not start the input hook', error);
    }
  }

  private stopHook(): void {
    this.releasePtt();
    this.pressed.clear();
    const hook = this.hookModule;
    if (!hook || !this.hookRunning) return;
    this.removeHookListeners(hook);
    try {
      hook.uIOhook.stop();
    } catch (error) {
      logger.warn('hotkeys', 'Stopping the input hook failed', error);
    }
    this.hookRunning = false;
    logger.info('hotkeys', 'Input hook stopped');
  }

  private removeHookListeners(hook: UiohookModule): void {
    hook.uIOhook.off('keydown', this.onKeyDown);
    hook.uIOhook.off('keyup', this.onKeyUp);
    hook.uIOhook.off('mousedown', this.onMouseDown);
    hook.uIOhook.off('mouseup', this.onMouseUp);
  }

  private pressPtt(): void {
    if (this.pttDown) return;
    this.pttDown = true;
    this.handlers.onPushToTalk(true);
  }

  private releasePtt(): void {
    if (!this.pttDown) return;
    this.pttDown = false;
    this.handlers.onPushToTalk(false);
  }

  /** Exposed for tests: feeds one hook key event. */
  handleKey(type: 'down' | 'up', event: KeyboardEvent): void {
    if (type === 'down') this.onKeyDown(event);
    else this.onKeyUp(event);
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const firstDown = !this.pressed.has(event.keycode);
    if (firstDown) this.pressed.set(event.keycode, Date.now());
    const m = this.matcher;
    if (m && m.keycodes.includes(event.keycode) && modifiersSatisfied(m.binding, event)) this.pressPtt();
    // Lone modifier toggles: once per physical press (the OS repeats key-down while held).
    if (!firstDown) return;
    for (const { action, matcher } of this.hookToggles) {
      if (matcher.keycodes.includes(event.keycode)) this.fire(action);
    }
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.pressed.delete(event.keycode);
    if (this.matcher?.keycodes.includes(event.keycode)) this.releasePtt();
  };

  private readonly onMouseDown = (event: MouseEvent): void => {
    if (this.matcher && this.matcher.mouseButton !== null && event.button === this.matcher.mouseButton) this.pressPtt();
  };

  private readonly onMouseUp = (event: MouseEvent): void => {
    if (this.matcher && this.matcher.mouseButton !== null && event.button === this.matcher.mouseButton) this.releasePtt();
  };
}
