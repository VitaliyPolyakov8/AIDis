import { isModifierKey, isMouseKey, parseBinding, type ParsedBinding } from '../../../Client/src/desktop/contract';

/** 0.4.2: toggle bindings that need the low-level hook instead of globalShortcut. */
export function needsHook(binding: string): boolean {
  const parsed = parseBinding(binding);
  return parsed !== null && isModifierKey(parsed.key);
}

/**
 * Pure translation of canonical bindings ("Ctrl+Shift+M", "Num5", "Mouse4") into
 * - Electron accelerators for globalShortcut (toggle actions), and
 * - uiohook key codes / mouse buttons for Push-to-Talk.
 */

const ACCELERATOR_KEYS: Record<string, string> = {
  NumAdd: 'numadd',
  NumSubtract: 'numsub',
  NumMultiply: 'nummult',
  NumDivide: 'numdiv',
  NumDecimal: 'numdec',
  CapsLock: 'Capslock',
  ScrollLock: 'Scrolllock',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
};

/** Null for mouse buttons and lone modifier keys: RegisterHotKey cannot represent those (the hook does). */
export function toAccelerator(binding: string): string | null {
  const parsed = parseBinding(binding);
  if (!parsed || isMouseKey(parsed.key) || isModifierKey(parsed.key)) return null;
  const num = /^Num(\d)$/.exec(parsed.key);
  const key = num ? `num${num[1] ?? ''}` : (ACCELERATOR_KEYS[parsed.key] ?? parsed.key);
  return [parsed.ctrl && 'Ctrl', parsed.alt && 'Alt', parsed.shift && 'Shift', key].filter(Boolean).join('+');
}

/** Binding key -> UiohookKey property name. */
const HOOK_KEY_NAMES: Record<string, string> = {
  NumAdd: 'NumpadAdd',
  NumSubtract: 'NumpadSubtract',
  NumMultiply: 'NumpadMultiply',
  NumDivide: 'NumpadDivide',
  NumDecimal: 'NumpadDecimal',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  // 0.4.2: modifier keys on their own, left / right distinguished.
  LeftCtrl: 'Ctrl',
  RightCtrl: 'CtrlRight',
  LeftShift: 'Shift',
  RightShift: 'ShiftRight',
  LeftAlt: 'Alt',
  RightAlt: 'AltRight',
};

export interface HookMatcher {
  /** uiohook keycodes that count as this key (e.g. Enter + NumpadEnter), or empty for mouse. */
  keycodes: number[];
  /** uiohook mouse button (3 middle, 4/5 side buttons), or null for keyboard. */
  mouseButton: number | null;
  binding: ParsedBinding;
}

export function toHookMatcher(binding: string, keyTable: Record<string, number>): HookMatcher | null {
  const parsed = parseBinding(binding);
  if (!parsed) return null;
  const mouse = /^Mouse(\d)$/.exec(parsed.key);
  if (mouse) return { keycodes: [], mouseButton: Number(mouse[1]), binding: parsed };
  const num = /^Num(\d)$/.exec(parsed.key);
  const name = num ? `Numpad${num[1] ?? ''}` : (HOOK_KEY_NAMES[parsed.key] ?? parsed.key);
  const code = keyTable[name];
  if (code === undefined) return null;
  const keycodes = [code];
  if (parsed.key === 'Enter' && keyTable.NumpadEnter !== undefined) keycodes.push(keyTable.NumpadEnter);
  return { keycodes, mouseButton: null, binding: parsed };
}

/** Required modifiers must be held; extra ones are fine (holding Shift to sprint while talking). */
export function modifiersSatisfied(binding: ParsedBinding, event: { ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): boolean {
  return (!binding.ctrl || event.ctrlKey) && (!binding.alt || event.altKey) && (!binding.shift || event.shiftKey);
}
