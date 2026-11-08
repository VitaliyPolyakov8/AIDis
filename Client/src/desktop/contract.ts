/**
 * Contract between the shared React client and the AIDis Desktop (Electron) shell.
 *
 * This file is pure TypeScript (no DOM, no Electron, no Node imports) because it is compiled
 * into BOTH programs: the React client imports it normally and Desktop's main/preload bundles
 * import it from ../Client/src/desktop/contract.ts. Keeping the types, defaults and validation
 * rules in one place means the renderer and the main process can never disagree about what a
 * valid keybind or streaming preset is. The main process re-validates everything it receives.
 */

// ---- hotkeys ------------------------------------------------------------------------

export const HOTKEY_ACTIONS = [
  { id: 'toggleMute', group: 'voice', kind: 'toggle' },
  { id: 'pushToTalk', group: 'voice', kind: 'hold' },
  { id: 'toggleDeafen', group: 'voice', kind: 'toggle' },
  { id: 'disconnectVoice', group: 'voice', kind: 'toggle' },
  { id: 'toggleScreenShare', group: 'streaming', kind: 'toggle' },
  { id: 'toggleWindow', group: 'application', kind: 'toggle' },
  { id: 'toggleOverlay', group: 'overlay', kind: 'toggle' },
  { id: 'overlayInteract', group: 'overlay', kind: 'toggle' },
  { id: 'overlayRecent', group: 'overlay', kind: 'toggle' },
] as const;

export type HotkeyAction = (typeof HOTKEY_ACTIONS)[number]['id'];
export type HotkeyGroup = (typeof HOTKEY_ACTIONS)[number]['group'];
export type HotkeyKind = 'toggle' | 'hold';

/** Commands the shell sends to the renderer (from a global hotkey or the tray menu). */
export type ShellCommand = Exclude<HotkeyAction, 'pushToTalk' | 'toggleWindow' | 'toggleOverlay' | 'overlayInteract' | 'overlayRecent'>;

/** Canonical binding strings, e.g. "Ctrl+Shift+M", "F13", "Mouse4". null = unassigned. */
export type Keybinds = Record<HotkeyAction, string | null>;

export const DEFAULT_KEYBINDS: Keybinds = {
  toggleMute: 'Ctrl+Shift+M',
  pushToTalk: null,
  toggleDeafen: 'Ctrl+Shift+D',
  disconnectVoice: null,
  toggleScreenShare: null,
  toggleWindow: 'Ctrl+Alt+Shift+A',
  toggleOverlay: 'Ctrl+Shift+O',
  overlayInteract: 'Ctrl+Shift+L',
  overlayRecent: null,
};

export function hotkeyKind(action: HotkeyAction): HotkeyKind {
  return HOTKEY_ACTIONS.find((a) => a.id === action)?.kind ?? 'toggle';
}

export function isHotkeyAction(value: unknown): value is HotkeyAction {
  return typeof value === 'string' && HOTKEY_ACTIONS.some((a) => a.id === value);
}

export const MODIFIERS = ['Ctrl', 'Alt', 'Shift'] as const;
export type Modifier = (typeof MODIFIERS)[number];

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const DIGITS = '0123456789'.split('');
const FUNCTION_KEYS = Array.from({ length: 24 }, (_, i) => `F${i + 1}`);
const NUMPAD = [...DIGITS.map((d) => `Num${d}`), 'NumAdd', 'NumSubtract', 'NumMultiply', 'NumDivide', 'NumDecimal'];
const NAMED = [
  'Space', 'Tab', 'Enter', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown',
  'Up', 'Down', 'Left', 'Right', 'CapsLock', 'ScrollLock',
  'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash', 'Semicolon', 'Quote', 'Comma', 'Period', 'Slash', 'Backquote',
];
/** Mouse buttons are only usable for Push-to-Talk (global shortcuts cannot register them). */
export const MOUSE_KEYS = ['Mouse3', 'Mouse4', 'Mouse5'] as const;
/**
 * 0.4.2: a modifier key on its own, left / right distinguished ("RightCtrl" for mute). Always a
 * bare binding (no "Ctrl+" prefix). The desktop app handles these with its low-level input hook,
 * because Windows RegisterHotKey (Electron globalShortcut) cannot register a modifier alone.
 */
export const MODIFIER_KEYS = ['LeftCtrl', 'RightCtrl', 'LeftShift', 'RightShift', 'LeftAlt', 'RightAlt'] as const;

/** Every key a binding may use (besides modifiers). */
export const KEY_NAMES: readonly string[] = [...LETTERS, ...DIGITS, ...FUNCTION_KEYS, ...NUMPAD, ...NAMED, ...MOUSE_KEYS, ...MODIFIER_KEYS];

export function isModifierKey(key: string): boolean {
  return (MODIFIER_KEYS as readonly string[]).includes(key);
}

/** DOM KeyboardEvent.code of a modifier -> its side-specific binding key (ControlRight -> RightCtrl). */
export function modifierKeyFromCode(code: string): string | null {
  const map: Record<string, string> = {
    ControlLeft: 'LeftCtrl',
    ControlRight: 'RightCtrl',
    ShiftLeft: 'LeftShift',
    ShiftRight: 'RightShift',
    AltLeft: 'LeftAlt',
    AltRight: 'RightAlt',
  };
  return map[code] ?? null;
}
const KEY_SET = new Set(KEY_NAMES);

export interface ParsedBinding {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

export function formatBinding(b: ParsedBinding): string {
  return [b.ctrl && 'Ctrl', b.alt && 'Alt', b.shift && 'Shift', b.key].filter(Boolean).join('+');
}

/** Parses a canonical binding; returns null for anything malformed or unknown. */
export function parseBinding(value: unknown): ParsedBinding | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 40) return null;
  const parts = value.split('+');
  const key = parts.pop();
  if (!key || !KEY_SET.has(key)) return null;
  const result: ParsedBinding = { ctrl: false, alt: false, shift: false, key };
  for (const part of parts) {
    if (part === 'Ctrl' && !result.ctrl) result.ctrl = true;
    else if (part === 'Alt' && !result.alt) result.alt = true;
    else if (part === 'Shift' && !result.shift) result.shift = true;
    else return null;
  }
  // A modifier key is bound on its own ("RightCtrl"), never as "Ctrl+RightCtrl".
  if (isModifierKey(key) && (result.ctrl || result.alt || result.shift)) return null;
  // Canonical form only (fixed modifier order), so string equality means "same hotkey".
  return formatBinding(result) === value ? result : null;
}

export function isMouseKey(key: string): boolean {
  return (MOUSE_KEYS as readonly string[]).includes(key);
}

/** Combos Windows or nearly every application already uses. */
const RESERVED = new Set([
  'Alt+F4', 'Alt+Tab', 'Alt+Shift+Tab', 'Alt+Space', 'Alt+Escape', 'Ctrl+Escape', 'Ctrl+Shift+Escape', 'Ctrl+Alt+Delete',
  'Ctrl+A', 'Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+Z', 'Ctrl+Y', 'Ctrl+S', 'Ctrl+F', 'Ctrl+P', 'Ctrl+N', 'Ctrl+W', 'Ctrl+T',
  'Ctrl+Tab', 'Ctrl+Shift+Tab',
  // Swallowing these alone would break typing and navigation in every application.
  'Space', 'Enter', 'Tab', 'Backspace', 'Delete',
]);

export type BindingError = 'invalid' | 'reserved' | 'mouseNotAllowed' | 'conflict';

/**
 * Structural rules. Toggle hotkeys are registered with the OS (RegisterHotKey), which swallows the
 * keystroke in every application, so a bare letter or Shift+letter would break typing everywhere:
 * they need Ctrl or Alt unless the key is a function key. Push-to-Talk only observes keys (games
 * still receive them), so any single key or a mouse side button is fine.
 */
export function validateBinding(action: HotkeyAction, binding: string): BindingError | null {
  const parsed = parseBinding(binding);
  if (!parsed) return 'invalid';
  const kind = hotkeyKind(action);
  if (isMouseKey(parsed.key)) {
    if (kind !== 'hold') return 'mouseNotAllowed';
    return parsed.ctrl || parsed.alt || parsed.shift ? 'invalid' : null;
  }
  if (kind === 'hold') return null;
  if (RESERVED.has(binding)) return 'reserved';
  // Single keys (F8, Insert, Num5, even M) are allowed: modifiers are optional since 0.2.3.
  return null;
}

/**
 * A toggle bound to a single key that types a character (M, 5, Shift+M...) is swallowed by Windows
 * in every application while AIDis runs. Allowed, but the UI warns about it.
 */
export function blocksTyping(action: HotkeyAction, binding: string): boolean {
  const parsed = parseBinding(binding);
  if (!parsed || hotkeyKind(action) === 'hold' || parsed.ctrl || parsed.alt) return false;
  return /^([A-Z0-9]|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|Backquote)$/.test(parsed.key);
}

/** The other action already using this binding, if any. */
export function findConflict(keybinds: Keybinds, action: HotkeyAction, binding: string): HotkeyAction | null {
  for (const { id } of HOTKEY_ACTIONS) {
    if (id !== action && keybinds[id] === binding) return id;
  }
  return null;
}

/** Maps a DOM KeyboardEvent.code (layout independent) to a binding key name. */
export function keyFromCode(code: string): string | null {
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1] ?? null;
  m = /^Digit(\d)$/.exec(code);
  if (m) return m[1] ?? null;
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
  m = /^Numpad(\d)$/.exec(code);
  if (m) return `Num${m[1] ?? ''}`;
  const named: Record<string, string> = {
    NumpadAdd: 'NumAdd',
    NumpadSubtract: 'NumSubtract',
    NumpadMultiply: 'NumMultiply',
    NumpadDivide: 'NumDivide',
    NumpadDecimal: 'NumDecimal',
    NumpadEnter: 'Enter',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
  };
  if (code in named) return named[code] ?? null;
  return KEY_SET.has(code) && !isMouseKey(code) ? code : null;
}

/** DOM MouseEvent.button -> binding key (middle and the two side buttons). */
export function keyFromMouseButton(button: number): string | null {
  if (button === 1) return 'Mouse3';
  if (button === 3) return 'Mouse4';
  if (button === 4) return 'Mouse5';
  return null;
}

/** Sanitizes a stored/received keybind map: unknown or invalid entries fall back to defaults/null. */
export function sanitizeKeybinds(raw: unknown): Keybinds {
  const source = isRecord(raw) ? raw : {};
  const result = { ...DEFAULT_KEYBINDS };
  const used = new Set<string>();
  for (const { id } of HOTKEY_ACTIONS) {
    if (!(id in source)) continue;
    const value = source[id];
    if (value === null) {
      result[id] = null;
    } else if (typeof value === 'string' && validateBinding(id, value) === null) {
      result[id] = value;
    }
  }
  // Drop later duplicates instead of registering one hotkey for two actions.
  for (const { id } of HOTKEY_ACTIONS) {
    const value = result[id];
    if (value === null) continue;
    if (used.has(value)) result[id] = null;
    else used.add(value);
  }
  return result;
}

// ---- streaming -----------------------------------------------------------------------

export const STREAM_RESOLUTIONS = {
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '1440p': { width: 2560, height: 1440 },
} as const;
export type StreamResolution = keyof typeof STREAM_RESOLUTIONS;
export const STREAM_FRAME_RATES = [30, 60] as const;
export type StreamFrameRate = (typeof STREAM_FRAME_RATES)[number];
export const STREAM_BITRATE_PRESETS = [5, 8, 12, 16, 20] as const;
export type StreamBitrateMode = 'auto' | 'custom' | `${(typeof STREAM_BITRATE_PRESETS)[number]}`;
export const CUSTOM_BITRATE_MIN_MBPS = 1;
export const CUSTOM_BITRATE_MAX_MBPS = 30;

/**
 * game: smooth motion first (motion content hint, keep the frame rate under pressure, higher bitrate);
 * text: sharp static detail first (text content hint, keep the resolution, lower bitrate).
 */
export type StreamContentMode = 'game' | 'text';

export interface StreamingSettings {
  contentMode: StreamContentMode;
  resolution: StreamResolution;
  frameRate: StreamFrameRate;
  bitrateMode: StreamBitrateMode;
  /** Used when bitrateMode is "custom"; whole Mbps within the custom range. */
  customBitrateMbps: number;
  /** Capture Windows system audio together with the screen. */
  systemAudio: boolean;
  /**
   * 0.4.2 "Quality priority". resolution (default): the selected resolution is held (WebRTC
   * degradationPreference maintain-resolution; under pressure the encoder lowers quality / frame
   * rate instead). auto: game mode keeps the frame rate and lets WebRTC scale the picture down.
   */
  qualityPriority: StreamQualityPriority;
  /**
   * 0.4.5: for a window capture with audio, send only that application's audio (Windows process
   * loopback) instead of the whole system mix. Screens always use system audio.
   */
  appAudio: boolean;
}

export type StreamQualityPriority = 'resolution' | 'auto';

/**
 * RTCRtpSender.degradationPreference values. 'maintain-framerate-and-resolution' (Chromium 125+)
 * turns WebRTC's resolution / frame-rate adaptation off: the encoder keeps both and only the
 * bitrate (quality) and, when it truly cannot keep up, single dropped frames give way.
 */
export type StreamDegradation = RTCDegradationPreference | 'maintain-framerate-and-resolution';

/**
 * The RTCRtpSender degradationPreference for a stream setting.
 * 0.4.5: "Maintain Resolution" in game mode = keep BOTH 1080p and the frame rate. With
 * 'maintain-resolution' WebRTC's CPU overuse detector halved the frame rate of the software VP8
 * encoder (1080p60 ~ 55 -> 24-38 FPS) after a load spike such as Alt+Tab, and never raised it again.
 */
export function streamDegradation(s: Pick<StreamingSettings, 'contentMode' | 'qualityPriority'>): StreamDegradation {
  if (s.contentMode === 'text') return 'maintain-resolution';
  return s.qualityPriority === 'auto' ? 'maintain-framerate' : 'maintain-framerate-and-resolution';
}

export const DEFAULT_STREAMING: StreamingSettings = {
  contentMode: 'game',
  resolution: '1080p',
  frameRate: 60,
  bitrateMode: 'auto',
  customBitrateMbps: 10,
  systemAudio: true,
  qualityPriority: 'resolution',
  appAudio: true,
};

/**
 * "Auto": the encoder ceiling for this mode; WebRTC adapts below it. Game values come from
 * measurements of VP8 on high-motion 1080p content: 8 Mbps at 60 FPS still smears noticeably
 * (PSNR ~39 dB), 12 Mbps is clean (~44 dB); more gives little (16 Mbps ~45 dB).
 */
const AUTO_BITRATE_MBPS: Record<StreamContentMode, Record<StreamResolution, Record<StreamFrameRate, number>>> = {
  game: {
    '720p': { 30: 4, 60: 6 },
    '1080p': { 30: 8, 60: 12 },
    '1440p': { 30: 12, 60: 18 },
  },
  text: {
    '720p': { 30: 2.5, 60: 4 },
    '1080p': { 30: 5, 60: 8 },
    '1440p': { 30: 8, 60: 12 },
  },
};

export function streamBitrateMbps(s: StreamingSettings): number {
  if (s.bitrateMode === 'auto') return AUTO_BITRATE_MBPS[s.contentMode][s.resolution][s.frameRate];
  if (s.bitrateMode === 'custom') return clampCustomBitrate(s.customBitrateMbps);
  return Number(s.bitrateMode);
}

export function clampCustomBitrate(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_STREAMING.customBitrateMbps;
  return Math.min(CUSTOM_BITRATE_MAX_MBPS, Math.max(CUSTOM_BITRATE_MIN_MBPS, Math.round(value)));
}

/** Rough upload needed: video ceiling + RTP/simulcast overhead + system audio. Whole Mbps only. */
export function estimatedUploadMbps(s: StreamingSettings): number {
  return Math.ceil(streamBitrateMbps(s) * 1.2 + (s.systemAudio ? 0.15 : 0));
}

export function sanitizeStreaming(raw: unknown): StreamingSettings {
  const r = isRecord(raw) ? raw : {};
  const resolution = typeof r.resolution === 'string' && r.resolution in STREAM_RESOLUTIONS ? (r.resolution as StreamResolution) : DEFAULT_STREAMING.resolution;
  const frameRate = r.frameRate === 30 || r.frameRate === 60 ? r.frameRate : DEFAULT_STREAMING.frameRate;
  const modes: string[] = ['auto', 'custom', ...STREAM_BITRATE_PRESETS.map(String)];
  const bitrateMode = typeof r.bitrateMode === 'string' && modes.includes(r.bitrateMode) ? (r.bitrateMode as StreamBitrateMode) : DEFAULT_STREAMING.bitrateMode;
  const customBitrateMbps = typeof r.customBitrateMbps === 'number' ? clampCustomBitrate(r.customBitrateMbps) : DEFAULT_STREAMING.customBitrateMbps;
  const systemAudio = typeof r.systemAudio === 'boolean' ? r.systemAudio : DEFAULT_STREAMING.systemAudio;
  const contentMode = r.contentMode === 'text' || r.contentMode === 'game' ? r.contentMode : DEFAULT_STREAMING.contentMode;
  const qualityPriority = r.qualityPriority === 'auto' || r.qualityPriority === 'resolution' ? r.qualityPriority : DEFAULT_STREAMING.qualityPriority;
  const appAudio = typeof r.appAudio === 'boolean' ? r.appAudio : DEFAULT_STREAMING.appAudio;
  return { contentMode, resolution, frameRate, bitrateMode, customBitrateMbps, systemAudio, qualityPriority, appAudio };
}

// ---- voice input / desktop preferences ------------------------------------------------

export type VoiceInputMode = 'voiceActivity' | 'pushToTalk';
export const PTT_RELEASE_DELAY_MAX_MS = 500;

export interface VoiceInputSettings {
  mode: VoiceInputMode;
  /** How long the mic stays open after the PTT key is released (0..500 ms). */
  pttReleaseDelayMs: number;
}

export const DEFAULT_VOICE_INPUT: VoiceInputSettings = { mode: 'voiceActivity', pttReleaseDelayMs: 50 };

export interface DesktopPreferences {
  /** Close button hides to the tray instead of quitting. */
  closeToTray: boolean;
  startWithWindows: boolean;
  /** Takes effect after a restart. */
  hardwareAcceleration: boolean;
  /** Native notifications for new messages while AIDis is in the background. */
  notifications: boolean;
  /** Switch to Away after no keyboard/mouse input for autoAwayMinutes (never over Do Not Disturb). */
  autoAway: boolean;
  autoAwayMinutes: AutoAwayMinutes;
  /** Show "Playing <game>" to others (0.3.0). Detection itself stays local. */
  showGameActivity: boolean;
  /** Games never shown to others (display names as detected). */
  hiddenGames: string[];
}

export const AUTO_AWAY_MINUTES = [5, 10, 15, 30] as const;
export type AutoAwayMinutes = (typeof AUTO_AWAY_MINUTES)[number];
export const MAX_HIDDEN_GAMES = 50;

export const DEFAULT_PREFERENCES: DesktopPreferences = {
  closeToTray: true,
  startWithWindows: false,
  hardwareAcceleration: true,
  notifications: true,
  autoAway: true,
  autoAwayMinutes: 10,
  showGameActivity: true,
  hiddenGames: [],
};

/** What others may see of the detected game: nothing when disabled or hidden by the user. */
export function publicGameName(detected: string | null, prefs: Pick<DesktopPreferences, 'showGameActivity' | 'hiddenGames'>): string | null {
  if (!detected || !prefs.showGameActivity) return null;
  return prefs.hiddenGames.some((g) => g.toLowerCase() === detected.toLowerCase()) ? null : detected;
}

// ---- game overlay (0.3.0) ------------------------------------------------------------

export const OVERLAY_POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;
export type OverlayCorner = (typeof OVERLAY_POSITIONS)[number];
export const OVERLAY_MESSAGE_COUNTS = [1, 3, 5] as const;
export const OVERLAY_MESSAGE_SECONDS = [3, 5, 10] as const;
export const OVERLAY_SCALE_MIN = 75;
export const OVERLAY_SCALE_MAX = 150;
export const OVERLAY_OPACITY_MIN = 20;
export const OVERLAY_OPACITY_MAX = 100;

/**
 * The overlay is a separate transparent, always-on-top, click-through Electron window over the
 * game. Nothing is injected into any game process.
 */
export interface OverlaySettings {
  enabled: boolean;
  /** Only while a recognised game is running (otherwise whenever you are in a voice call). */
  onlyInGames: boolean;
  /** minimal: speaking people only; extended: everyone in the call (+ chat messages). */
  mode: 'minimal' | 'extended';
  showParticipants: boolean;
  showSpeaking: boolean;
  showMessages: boolean;
  messageCount: (typeof OVERLAY_MESSAGE_COUNTS)[number];
  messageSeconds: (typeof OVERLAY_MESSAGE_SECONDS)[number];
  /** Extended mode: hide people who have not spoken for a while. */
  hideInactive: boolean;
  corner: OverlayCorner;
  /** Display the overlay lives on; null = primary. */
  displayId: number | null;
  /**
   * Position dragged by hand in interaction mode (relative to that display), or null for the corner.
   * 0.5.0: `bounds` is that display's rectangle when it was saved. Windows display ids are not
   * stable across app starts (an update restarts the app), so the display is found again by id,
   * then by its rectangle, then by the saved point; the overlay is always clamped onto a screen.
   */
  custom: OverlayPosition | null;
  /** Percent. */
  scale: number;
  /** Background opacity, percent (text stays fully opaque). */
  opacity: number;
  /**
   * 0.4.0 message notifications in the overlay: every message that would notify, only mentions
   * (and DMs), or none. The channel's own notification mode and Do Not Disturb still apply.
   */
  messageMode: 'all' | 'mentions' | 'off';
  /** 0.4.0: the message panel is its own window, placed independently (null = under the list). */
  chatCustom: OverlayPosition | null;
  /** 0.4.0 per-game layouts, keyed by the detected game's display name (max OVERLAY_MAX_PROFILES). */
  profiles: Record<string, OverlayProfile>;
}

/** A hand-placed overlay window: offset on a display (+ that display's rectangle, 0.5.0). */
export interface OverlayPosition {
  displayId: number;
  x: number;
  y: number;
  bounds?: { x: number; y: number; width: number; height: number };
}

/** What a per-game overlay profile overrides (everything else comes from the global settings). */
export interface OverlayProfile {
  corner: OverlayCorner;
  custom: OverlaySettings['custom'];
  chatCustom: OverlaySettings['chatCustom'];
  scale: number;
  opacity: number;
  mode: OverlaySettings['mode'];
}

export const OVERLAY_MAX_PROFILES = 30;

/** The settings in effect while `game` runs: its profile over the global settings. */
export function effectiveOverlay(settings: OverlaySettings, game: string | null): OverlaySettings {
  const profile = game ? settings.profiles[game] : undefined;
  return profile ? { ...settings, ...profile } : settings;
}

export function profileFromSettings(s: OverlaySettings): OverlayProfile {
  return { corner: s.corner, custom: s.custom, chatCustom: s.chatCustom, scale: s.scale, opacity: s.opacity, mode: s.mode };
}

export const DEFAULT_OVERLAY: OverlaySettings = {
  enabled: true,
  onlyInGames: true,
  mode: 'extended',
  showParticipants: true,
  showSpeaking: true,
  showMessages: true,
  messageCount: 3,
  messageSeconds: 5,
  hideInactive: false,
  corner: 'top-left',
  displayId: null,
  custom: null,
  scale: 100,
  opacity: 70,
  messageMode: 'all',
  chatCustom: null,
  profiles: {},
};

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function sanitizeOverlay(raw: unknown): OverlaySettings {
  const r = isRecord(raw) ? raw : {};
  const d = DEFAULT_OVERLAY;
  const bool = (key: 'enabled' | 'onlyInGames' | 'showParticipants' | 'showSpeaking' | 'showMessages' | 'hideInactive') =>
    typeof r[key] === 'boolean' ? r[key] : d[key];
  const position = (value: unknown): OverlayPosition | null => {
    const c = isRecord(value) ? value : null;
    if (!c || !finite(c.displayId) || !finite(c.x) || !finite(c.y)) return null;
    const b = isRecord(c.bounds) ? c.bounds : null;
    const bounds =
      b && finite(b.x) && finite(b.y) && finite(b.width) && finite(b.height) && b.width > 0 && b.height > 0
        ? { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }
        : undefined;
    return { displayId: Math.round(c.displayId), x: Math.round(c.x), y: Math.round(c.y), ...(bounds ? { bounds } : {}) };
  };
  const custom = position(r.custom);
  const corners0: readonly unknown[] = OVERLAY_POSITIONS;
  const profiles: Record<string, OverlayProfile> = {};
  if (isRecord(r.profiles)) {
    for (const [game, raw] of Object.entries(r.profiles).slice(0, OVERLAY_MAX_PROFILES)) {
      if (!isRecord(raw) || game.trim().length === 0 || game.length > 80) continue;
      profiles[game] = {
        corner: corners0.includes(raw.corner) ? (raw.corner as OverlayCorner) : d.corner,
        custom: position(raw.custom),
        chatCustom: position(raw.chatCustom),
        scale: clampInt(raw.scale, OVERLAY_SCALE_MIN, OVERLAY_SCALE_MAX, d.scale),
        opacity: clampInt(raw.opacity, OVERLAY_OPACITY_MIN, OVERLAY_OPACITY_MAX, d.opacity),
        mode: raw.mode === 'minimal' || raw.mode === 'extended' ? raw.mode : d.mode,
      };
    }
  }
  // 0.3.x "showMessages: false" becomes "off"; 0.4.0 stores messageMode.
  const messageMode = r.messageMode === 'all' || r.messageMode === 'mentions' || r.messageMode === 'off' ? r.messageMode : r.showMessages === false ? 'off' : d.messageMode;
  const counts: readonly unknown[] = OVERLAY_MESSAGE_COUNTS;
  const seconds: readonly unknown[] = OVERLAY_MESSAGE_SECONDS;
  const corners: readonly unknown[] = OVERLAY_POSITIONS;
  return {
    enabled: bool('enabled'),
    onlyInGames: bool('onlyInGames'),
    mode: r.mode === 'minimal' || r.mode === 'extended' ? r.mode : d.mode,
    showParticipants: bool('showParticipants'),
    showSpeaking: bool('showSpeaking'),
    showMessages: bool('showMessages'),
    messageCount: counts.includes(r.messageCount) ? (r.messageCount as OverlaySettings['messageCount']) : d.messageCount,
    messageSeconds: seconds.includes(r.messageSeconds) ? (r.messageSeconds as OverlaySettings['messageSeconds']) : d.messageSeconds,
    hideInactive: bool('hideInactive'),
    corner: corners.includes(r.corner) ? (r.corner as OverlayCorner) : d.corner,
    displayId: finite(r.displayId) ? Math.round(r.displayId) : null,
    custom,
    scale: clampInt(r.scale, OVERLAY_SCALE_MIN, OVERLAY_SCALE_MAX, d.scale),
    opacity: clampInt(r.opacity, OVERLAY_OPACITY_MIN, OVERLAY_OPACITY_MAX, d.opacity),
    messageMode,
    chatCustom: position(r.chatCustom),
    profiles,
  };
}

/** One person in the call as the overlay shows it (avatar already a small data URL). */
export interface OverlayParticipant {
  id: string;
  name: string;
  /** data:image/... (64 px) or null for initials. */
  avatar: string | null;
  color: string;
  initials: string;
  speaking: boolean;
  micMuted: boolean;
  deafened: boolean;
  isSelf: boolean;
  /** 0.4.0: sharing their screen (the overlay can switch the main window to that stream). */
  streaming?: boolean;
  /** Watching a stream, from the server's canonical viewer list. */
  watching?: boolean;
  /** 0.4.1: profile frame id, drawn only while they speak. */
  frame?: string | null;
  /** 0.5.0: their nickname color (#rrggbb, readable) or null. */
  nameColor?: string | null;
  /** 0.5.6: the rest of their name style (gradient end color, glow, font id). */
  nameColor2?: string | null;
  nameGlow?: boolean;
  nameFont?: string | null;
  /** 0.5.1: their built-in avatar frame id (the overlay ships the same frame files) or null. */
  cosmeticFrame?: string | null;
}

export interface OverlayVoiceState {
  inCall: boolean;
  channelName: string;
  participants: OverlayParticipant[];
  micEnabled: boolean;
  deafened: boolean;
}

export interface OverlayMessage {
  id: string;
  authorName: string;
  avatar: string | null;
  color: string;
  initials: string;
  /** 0.5.0: the author's nickname color (#rrggbb, readable) or null. */
  nameColor?: string | null;
  /** 0.5.6: the rest of the author's name style (gradient end color, glow, font id). */
  nameColor2?: string | null;
  nameGlow?: boolean;
  nameFont?: string | null;
  /** Plain text, already shortened. */
  text: string;
  /** ms since epoch. */
  at: number;
  /** 0.4.0: where it was posted ("#general", "🔊 Gaming", "DM") and whether it mentions us. */
  channelId?: string;
  channelLabel?: string;
  mention?: boolean;
}

/** 0.4.0 quick reply typed in the overlay (interaction mode); the main window sends it. */
export interface OverlayReply {
  channelId: string;
  replyToId: string | null;
  text: string;
}

/** Voice actions the overlay may trigger in interaction mode ("watch:<userId>" focuses their stream). */
export type OverlayAction = 'toggleMute' | 'toggleDeafen' | `watch:${string}`;

export type DesktopLanguage = 'ru' | 'en';

export interface DesktopSettings {
  keybinds: Keybinds;
  streaming: StreamingSettings;
  voiceInput: VoiceInputSettings;
  preferences: DesktopPreferences;
  overlay: OverlaySettings;
  language: DesktopLanguage;
}

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  keybinds: DEFAULT_KEYBINDS,
  streaming: DEFAULT_STREAMING,
  voiceInput: DEFAULT_VOICE_INPUT,
  preferences: DEFAULT_PREFERENCES,
  overlay: DEFAULT_OVERLAY,
  language: 'en',
};

/** A partial update; each section is merged into the current value. */
export interface DesktopSettingsPatch {
  keybinds?: Partial<Keybinds>;
  streaming?: Partial<StreamingSettings>;
  voiceInput?: Partial<VoiceInputSettings>;
  preferences?: Partial<DesktopPreferences>;
  overlay?: Partial<OverlaySettings>;
  language?: DesktopLanguage;
}

export function sanitizeVoiceInput(raw: unknown): VoiceInputSettings {
  const r = isRecord(raw) ? raw : {};
  const mode = r.mode === 'pushToTalk' || r.mode === 'voiceActivity' ? r.mode : DEFAULT_VOICE_INPUT.mode;
  const delay =
    typeof r.pttReleaseDelayMs === 'number' && Number.isFinite(r.pttReleaseDelayMs)
      ? Math.min(PTT_RELEASE_DELAY_MAX_MS, Math.max(0, Math.round(r.pttReleaseDelayMs)))
      : DEFAULT_VOICE_INPUT.pttReleaseDelayMs;
  return { mode, pttReleaseDelayMs: delay };
}

export function sanitizePreferences(raw: unknown): DesktopPreferences {
  const r = isRecord(raw) ? raw : {};
  const bool = (key: 'closeToTray' | 'startWithWindows' | 'hardwareAcceleration' | 'notifications' | 'autoAway' | 'showGameActivity') =>
    typeof r[key] === 'boolean' ? r[key] : DEFAULT_PREFERENCES[key];
  const minutes: readonly unknown[] = AUTO_AWAY_MINUTES;
  return {
    closeToTray: bool('closeToTray'),
    startWithWindows: bool('startWithWindows'),
    hardwareAcceleration: bool('hardwareAcceleration'),
    notifications: bool('notifications'),
    autoAway: bool('autoAway'),
    autoAwayMinutes: minutes.includes(r.autoAwayMinutes) ? (r.autoAwayMinutes as AutoAwayMinutes) : DEFAULT_PREFERENCES.autoAwayMinutes,
    showGameActivity: bool('showGameActivity'),
    hiddenGames: Array.isArray(r.hiddenGames)
      ? [...new Set(r.hiddenGames.filter((g): g is string => typeof g === 'string' && g.trim().length > 0 && g.length <= 80).map((g) => g.trim()))].slice(0, MAX_HIDDEN_GAMES)
      : [],
  };
}

export function sanitizeDesktopSettings(raw: unknown): DesktopSettings {
  const r = isRecord(raw) ? raw : {};
  return {
    keybinds: sanitizeKeybinds(r.keybinds),
    streaming: sanitizeStreaming(r.streaming),
    voiceInput: sanitizeVoiceInput(r.voiceInput),
    preferences: sanitizePreferences(r.preferences),
    overlay: sanitizeOverlay(r.overlay),
    language: r.language === 'ru' ? 'ru' : 'en',
  };
}

export type SettingsUpdateResult =
  | { ok: true; settings: DesktopSettings }
  | { ok: false; error: BindingError; action?: HotkeyAction; conflictWith?: HotkeyAction };

/**
 * Applies a patch. Keybinds are checked strictly (invalid or conflicting -> error, nothing saved);
 * other sections are sanitized (out-of-range numbers are clamped).
 */
export function applySettingsPatch(current: DesktopSettings, patch: unknown): SettingsUpdateResult {
  if (!isRecord(patch)) return { ok: false, error: 'invalid' };
  const next: DesktopSettings = { ...current };
  if (patch.keybinds !== undefined) {
    if (!isRecord(patch.keybinds)) return { ok: false, error: 'invalid' };
    const keybinds = { ...current.keybinds };
    for (const [action, value] of Object.entries(patch.keybinds)) {
      if (!isHotkeyAction(action)) return { ok: false, error: 'invalid' };
      if (value === null) {
        keybinds[action] = null;
        continue;
      }
      if (typeof value !== 'string') return { ok: false, error: 'invalid', action };
      const error = validateBinding(action, value);
      if (error) return { ok: false, error, action };
      keybinds[action] = value;
    }
    for (const { id } of HOTKEY_ACTIONS) {
      const value = keybinds[id];
      const conflictWith = value ? findConflict(keybinds, id, value) : null;
      if (conflictWith) return { ok: false, error: 'conflict', action: id, conflictWith };
    }
    next.keybinds = keybinds;
  }
  if (patch.streaming !== undefined) next.streaming = sanitizeStreaming({ ...current.streaming, ...asRecord(patch.streaming) });
  if (patch.voiceInput !== undefined) next.voiceInput = sanitizeVoiceInput({ ...current.voiceInput, ...asRecord(patch.voiceInput) });
  if (patch.preferences !== undefined) next.preferences = sanitizePreferences({ ...current.preferences, ...asRecord(patch.preferences) });
  if (patch.overlay !== undefined) next.overlay = sanitizeOverlay({ ...current.overlay, ...asRecord(patch.overlay) });
  if (patch.language !== undefined) next.language = patch.language === 'ru' ? 'ru' : 'en';
  return { ok: true, settings: next };
}

// ---- game (0.4.1) ----------------------------------------------------------------------

/** What the desktop app tells the page about the detected game. Paths never cross this bridge. */
export interface DesktopGameInfo {
  name: string;
  /** Steam AppID when known (Steam's own record or the built-in table). */
  steamAppId: number | null;
  /** When the game started (ISO). Kept while the same game runs. */
  startedAt: string;
  /** The executable's icon as a data URL, for this PC only (never uploaded). */
  icon: string | null;
}

// ---- capture -------------------------------------------------------------------------

export interface CaptureSource {
  /** desktopCapturer id, e.g. "screen:0:0" or "window:1234:0". */
  id: string;
  kind: 'screen' | 'window';
  /** Window title, or "" for screens (the UI numbers them). */
  name: string;
  /** JPEG data URL (may be empty when Windows gives no preview). */
  thumbnail: string;
  /** Small PNG data URL of the application icon (windows only). */
  appIcon: string | null;
}

export interface CaptureSelection {
  sourceId: string;
  /** Request Windows system audio (loopback) with the video. */
  audio: boolean;
}

// ---- servers (one universal app for every AIDis installation) -------------------------

/** What the app learned about a server from GET /api/v1/client/config (or defaults for an older server). */
export interface DesktopServerConfig {
  serverVersion: string;
  /** '' when the server did not say (the voice token carries it anyway). */
  livekitUrl: string;
  /** Extra voice servers are subdomains of this. */
  voiceNodeDomain: string;
  steamArt: boolean;
  /** '' = no minimum. */
  minimumVersion: string;
  /** Desktop updates from the owner's server instead of GitHub Releases. */
  updateMirrorUrl: string | null;
}

export interface DesktopServer {
  /** https://chat.example.com */
  origin: string;
  name: string;
  config: DesktopServerConfig;
}

export type DesktopAddServerResult = { ok: true; server: DesktopServer } | { ok: false; code: 'NOT_HTTPS' | 'INVALID' | 'UNREACHABLE' | 'NOT_AIDIS' };

// ---- auth / misc ---------------------------------------------------------------------

/** What the desktop shell persists (encrypted) for an authenticated session. */
export interface DesktopStoredSession {
  refreshToken: string;
  sessionId: string;
}

export interface DesktopAppInfo {
  appVersion: string;
  electronVersion: string;
  chromeVersion: string;
  platform: string;
  arch: string;
  /** False when OS encryption is unavailable: the session is then kept in memory only. */
  secureStorage: boolean;
  /** Hardware acceleration as actually applied at startup (the setting applies after restart). */
  hardwareAccelerationActive: boolean;
  /**
   * 0.4.7: Chromium's GPU feature status for video encoding (app.getGPUFeatureStatus().video_encode),
   * e.g. "enabled", "unavailable_software", "disabled_software". Optional: older shells.
   */
  videoEncodeStatus?: string;
}

export interface HotkeyStatus {
  /** Actions whose binding could not be registered (taken by another app). */
  failed: HotkeyAction[];
  /** Global Push-to-Talk hook is available on this system. */
  pttAvailable: boolean;
}

/** Voice state mirrored into the tray menu. */
export interface ShellVoiceState {
  inCall: boolean;
  micEnabled: boolean;
  deafened: boolean;
  screenSharing: boolean;
  /** 0.4.2: we are speaking right now (local, fast detection with its release delay). */
  speaking?: boolean;
  /** 0.4.2: voice channel name for the tray tooltip. */
  channelName?: string;
}

export interface DesktopNotification {
  title: string;
  body: string;
  channelId: string;
}

/** 0.5.0 AIDis notification card (validated again by the shell). */
export interface DesktopToast {
  author: string;
  /** "#general", "🔊 Gaming", group DM name; "" for a 1:1 DM. */
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

export type Unsubscribe = () => void;

/**
 * Automatic updates (electron-updater, generic provider, main process only).
 * "unsupported": development build, or not an installed copy.
 */
export type UpdateState =
  | { status: 'unsupported' }
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available'; version: string }
  | { status: 'downloading'; version: string; percent: number; transferred: number; total: number; bytesPerSecond: number }
  | { status: 'downloaded'; version: string }
  | { status: 'not-available'; checkedAt: number }
  | { status: 'error'; message: string };

/** The API exposed as window.aidisDesktop by the preload script. Nothing else is exposed. */
export interface AidisDesktopApi {
  readonly isDesktop: true;
  readonly apiVersion: 1;
  app: {
    getInfo(): Promise<DesktopAppInfo>;
    /** Writes a line to the desktop log (never pass secrets). */
    log(level: 'info' | 'warn' | 'error', message: string): void;
    /** 0.4.2: colors of the native window controls (themed title bar). Optional: older shells. */
    setTitleBar?(colors: { color: string; symbolColor: string }): void;
    relaunch(): void;
    openLogsFolder(): void;
    /** 0.5.5: saves a signed attachment link (large files) with the native "Save as" dialog. Optional: older shells. */
    downloadUrl?(url: string): void;
    /** A notification was clicked: open this channel. */
    onNavigate(callback: (channelId: string) => void): Unsubscribe;
  };
  /** Servers: the window reloads after select() / a successful add(). Optional: older shells. */
  servers?: {
    list(): Promise<DesktopServer[]>;
    current(): Promise<DesktopServer | null>;
    add(address: string): Promise<DesktopAddServerResult>;
    select(origin: string): Promise<void>;
    remove(origin: string): Promise<void>;
  };
  auth: {
    load(): Promise<DesktopStoredSession | null>;
    save(session: DesktopStoredSession): Promise<void>;
    clear(): Promise<void>;
  };
  settings: {
    get(): Promise<DesktopSettings>;
    update(patch: DesktopSettingsPatch): Promise<SettingsUpdateResult>;
    onChange(callback: (settings: DesktopSettings) => void): Unsubscribe;
  };
  hotkeys: {
    getStatus(): Promise<HotkeyStatus>;
    /** While capturing a new binding the global hotkeys are paused so the keys reach the page. */
    setCapturing(active: boolean): void;
    onCommand(callback: (command: ShellCommand) => void): Unsubscribe;
    onPushToTalk(callback: (pressed: boolean) => void): Unsubscribe;
    onStatus(callback: (status: HotkeyStatus) => void): Unsubscribe;
  };
  voice: {
    reportState(state: ShellVoiceState): void;
  };
  /** 0.4.5 application-only stream audio (Windows process loopback). Optional: older shells. */
  appAudio?: {
    start(sourceId: string): Promise<{ ok: true } | { ok: false; reason: string }>;
    stop(): void;
  };
  /** 0.4.5 stream pop-out windows (child windows named aidis-popout-*). Optional: older shells. */
  streams?: {
    setAlwaysOnTop(windowName: string, onTop: boolean): void;
  };
  capture: {
    getSources(): Promise<CaptureSource[]>;
    /** Arms the next getDisplayMedia() call with this source. Resolves false if it no longer exists. */
    select(selection: CaptureSelection): Promise<boolean>;
    /**
     * 0.4.1: the capture source id of the detected game's window (matched by its process: Steam
     * folder or executable, the exact title only as a fallback), or null. Optional: older builds.
     */
    findGameSource?(): Promise<string | null>;
  };
  notifications: {
    show(notification: DesktopNotification): void;
    /** 0.5.0: an AIDis notification card (bottom-right). Optional: older shells use show(). */
    toast?(notification: DesktopToast): void;
  };
  /** 0.3.0: automatic Away (system idle time) and the detected game (local detection only). */
  presence: {
    onIdle(callback: (idle: boolean) => void): Unsubscribe;
    /**
     * The detected game (display name), or null. Local only: the page decides with the user's
     * settings ("Display current game", hidden games) what, if anything, is published.
     */
    onActivity(callback: (name: string | null) => void): Unsubscribe;
    getDetectedGame(): Promise<string | null>;
    /** 0.4.1: details of the detected game (local; the page decides what is published). */
    getGameInfo?(): Promise<DesktopGameInfo | null>;
    onGameInfo?(callback: (info: DesktopGameInfo | null) => void): Unsubscribe;
  };
  /** 0.3.0: in-game overlay (a separate window; nothing is injected into games). */
  overlay: {
    pushStreamHint?(hint: null | ({ sourceId: string; expiresAt?: number } & ({ type: 'pointer'; x: number; y: number } | { type: 'reaction'; reaction: 'laugh' | 'clap' | 'f' }))): void;
    pushState(state: OverlayVoiceState): void;
    pushMessage(message: OverlayMessage): void;
    /** Mute / deafen pressed on the overlay in interaction mode. */
    onAction(callback: (action: OverlayAction) => void): Unsubscribe;
    /** 0.4.0: a quick reply typed in the overlay. */
    onReply(callback: (reply: OverlayReply) => void): Unsubscribe;
    getDisplays(): Promise<{ id: number; label: string; primary: boolean }[]>;
    /** Shows the overlay in interaction mode now (from settings) so it can be placed. */
    preview(): void;
  };
  updates: {
    getState(): Promise<UpdateState>;
    /** Fresh check against the fixed AIDis update server (the URL cannot be changed from the page). */
    check(): void;
    /** Quits and installs a downloaded update, then restarts. Only valid in the "downloaded" state. */
    install(): void;
    /** 0.4.2: start downloading the available update (user click). Optional: older shells. */
    download?(): void;
    onState(callback: (state: UpdateState) => void): Unsubscribe;
    /** The "update ready" notification was clicked: show the update UI. */
    onOpen(callback: () => void): Unsubscribe;
  };
}

// ---- helpers -------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
