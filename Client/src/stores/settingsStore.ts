import { create } from 'zustand';
import type { SeasonSetting } from '../utils/season';

/** Per-device preferences, kept in localStorage (not sensitive). */

/** 0.5.8 interface sound sets. */
export interface Settings {
  inputDeviceId: string;
  outputDeviceId: string;
  echoCancellation: boolean;
  /** Pre-0.3.1 on/off switch; only read to migrate old settings (noiseSuppressionMode is the setting). */
  noiseSuppression: boolean;
  /**
   * off: none. standard: WebRTC's built-in noise suppression (Chromium audio processing).
   * strong: RNNoise in our own pipeline (removes fans, hiss, keyboard clicks; ~10 ms more latency).
   */
  noiseSuppressionMode: NoiseSuppressionMode;
  autoGainControl: boolean;
  messageDensity: 'cozy' | 'compact';
  interfaceSounds: boolean;
  /** Breathing glow on a speaking avatar (0.3.0). Off = static ring only. */
  speakingAnimation: boolean;
  lastTextChannelId: string | null;
  /** Outgoing microphone volume, percent (0..200). */
  inputVolume: number;
  /** Voice activity threshold chosen automatically from the background noise. */
  autoSensitivity: boolean;
  /** Manual voice activity threshold, dBFS (-80..0). */
  sensitivityDb: number;
  /** Local playback volume per user id, percent (0..200). Only affects what this device hears. */
  userVolumes: Record<string, number>;
  /** Users muted locally on this device (by user id). */
  userMutes: Record<string, boolean>;
  /** Local volume of each streamer's screen-share (game/system) audio, percent (0..200). Separate from their voice. */
  streamVolumes: Record<string, number>;
  /** 0.4.0: where streams (screen-share audio) play; 'same' = the voice output device. */
  streamOutputDeviceId: string;
  /** 0.4.0: animated profile frames / decorations (also off with the OS "reduce motion"). */
  profileAnimations: boolean;
  /** 0.4.1: interface gradient theme (Settings → Appearance), applied live as CSS variables. */
  uiTheme: UiTheme;
  /** 0.4.2: sounds when OTHER people join / leave our voice channel (needs interfaceSounds). */
  participantSounds: boolean;
  /** 0.4.2: voice chat panel width (px) next to the voice / stream view. */
  voiceChatWidth: number;
  /** 0.5.0: sounds when someone starts / stops watching a stream we stream or watch. */
  streamViewerSounds: boolean;
  /** 0.5.0: the new-message notification sound and its volume (percent). */
  notificationSound: boolean;
  notificationVolume: number;
  /** 0.5.0 webcam: preferred device and preset (remembered; the camera NEVER starts by itself). */
  cameraDeviceId: string | null;
  cameraResolution: CameraResolution;
  cameraFps: CameraFps;
  /** 0.5.2 TTS: my messages in voice chats / DMs are sent as "read aloud" (composer toggle). */
  ttsSend: boolean;
  /** 0.5.2 TTS: read other people's TTS messages aloud while I am in that call. */
  ttsListen: boolean;
  /** 0.5.2 TTS: chosen system voice (voiceURI); null = one matching the message's language. */
  ttsVoiceUri: string | null;
  /** 0.5.2 TTS: volume percent (0..100) and rate percent (50..200). */
  ttsVolume: number;
  ttsRate: number;
  /** 0.7.1 soundboard: volume percent (0..100) and "do not play sounds". */
  soundboardVolume: number;
  soundboardMuted: boolean;
  /** 0.5.5 seasonal decorations: auto (by date), off, or one season forced. */
  seasonalTheme: SeasonSetting;
  /**
   * 0.5.9 iPhone / iPad: keep the call audible in the background and on the lock screen (voices
   * through <audio> elements, microphone captured during the whole call). iOS ignores per-person
   * volume then; turning this off brings volumes back but the sound stops in the background.
   */
  iosBackgroundAudio: boolean;
}

export type CameraResolution = '720p' | '1080p';
export type CameraFps = 30 | 60;

/** 0.4.1 interface gradient themes (v041.css). Status colors never change with a theme. */
export const UI_THEMES = ['default', 'aurora', 'sunset', 'emerald', 'crimson', 'midnight', 'neutral'] as const;
export type UiTheme = (typeof UI_THEMES)[number];

export function isUiTheme(value: unknown): value is UiTheme {
  return typeof value === 'string' && (UI_THEMES as readonly string[]).includes(value);
}

export type NoiseSuppressionMode = 'off' | 'standard' | 'strong';

const KEY = 'aidis.settings';

export const DEFAULT_SETTINGS: Settings = {
  inputDeviceId: 'default',
  outputDeviceId: 'default',
  echoCancellation: true,
  noiseSuppression: true,
  noiseSuppressionMode: 'standard',
  autoGainControl: true,
  messageDensity: 'cozy',
  interfaceSounds: true,
  speakingAnimation: true,
  lastTextChannelId: null,
  inputVolume: 100,
  autoSensitivity: true,
  sensitivityDb: -50,
  userVolumes: {},
  userMutes: {},
  streamVolumes: {},
  streamOutputDeviceId: 'same',
  profileAnimations: true,
  uiTheme: 'default',
  participantSounds: true,
  voiceChatWidth: 340,
  streamViewerSounds: true,
  notificationSound: true,
  notificationVolume: 80,
  cameraDeviceId: null,
  cameraResolution: '720p',
  cameraFps: 30,
  ttsSend: false,
  ttsListen: true,
  ttsVoiceUri: null,
  ttsVolume: 100,
  ttsRate: 100,
  soundboardVolume: 80,
  soundboardMuted: false,
  seasonalTheme: 'auto',
  iosBackgroundAudio: true,
};

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function cleanMap<T>(value: unknown, keep: (v: unknown) => v is T): Record<string, T> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k.length > 0 && k.length <= 64 && keep(v)) out[k] = v;
  }
  return out;
}

/** 0.3.1 mode, or the pre-0.3.1 on/off switch mapped to off / standard. */
function sanitizeNoiseMode(raw: Partial<Settings>): NoiseSuppressionMode {
  const mode: unknown = raw.noiseSuppressionMode;
  if (mode === 'off' || mode === 'standard' || mode === 'strong') return mode;
  return raw.noiseSuppression === false ? 'off' : 'standard';
}

/** Repairs values read from storage (older versions, manual edits). */
export function sanitizeSettings(raw: Partial<Settings>): Settings {
  const s = { ...DEFAULT_SETTINGS, ...raw };
  return {
    ...s,
    inputVolume: Math.round(clamp(s.inputVolume, 0, 200, 100)),
    autoSensitivity: typeof s.autoSensitivity === 'boolean' ? s.autoSensitivity : true,
    speakingAnimation: typeof s.speakingAnimation === 'boolean' ? s.speakingAnimation : true,
    profileAnimations: typeof s.profileAnimations === 'boolean' ? s.profileAnimations : true,
    uiTheme: isUiTheme(s.uiTheme) ? s.uiTheme : 'default',
    participantSounds: typeof s.participantSounds === 'boolean' ? s.participantSounds : true,
    voiceChatWidth: Math.round(clamp(s.voiceChatWidth, 280, 2000, 340)),
    streamViewerSounds: typeof s.streamViewerSounds === 'boolean' ? s.streamViewerSounds : true,
    notificationSound: typeof s.notificationSound === 'boolean' ? s.notificationSound : true,
    notificationVolume: Math.round(clamp(s.notificationVolume, 0, 100, 80)),
    cameraDeviceId: typeof s.cameraDeviceId === 'string' && s.cameraDeviceId.length <= 256 ? s.cameraDeviceId : null,
    cameraResolution: s.cameraResolution === '1080p' ? '1080p' : '720p',
    cameraFps: s.cameraFps === 60 ? 60 : 30,
    ttsSend: typeof s.ttsSend === 'boolean' ? s.ttsSend : false,
    ttsListen: typeof s.ttsListen === 'boolean' ? s.ttsListen : true,
    ttsVoiceUri: typeof s.ttsVoiceUri === 'string' && s.ttsVoiceUri.length <= 512 ? s.ttsVoiceUri : null,
    ttsVolume: Math.round(clamp(s.ttsVolume, 0, 100, 100)),
    ttsRate: Math.round(clamp(s.ttsRate, 50, 200, 100)),
    soundboardVolume: Math.round(clamp(s.soundboardVolume, 0, 100, 80)),
    soundboardMuted: (s.soundboardMuted as unknown) === true,
    seasonalTheme: s.seasonalTheme === 'off' || s.seasonalTheme === 'newyear' || s.seasonalTheme === 'halloween' ? s.seasonalTheme : 'auto',
    iosBackgroundAudio: (s.iosBackgroundAudio as unknown) !== false,
    streamOutputDeviceId: typeof s.streamOutputDeviceId === 'string' && s.streamOutputDeviceId.length <= 256 ? s.streamOutputDeviceId : 'same',
    noiseSuppressionMode: sanitizeNoiseMode(raw),
    sensitivityDb: clamp(s.sensitivityDb, -80, 0, -50),
    userVolumes: cleanMap(s.userVolumes, (v): v is number => typeof v === 'number' && v >= 0 && v <= 200),
    userMutes: cleanMap(s.userMutes, (v): v is boolean => v === true),
    streamVolumes: cleanMap(s.streamVolumes, (v): v is number => typeof v === 'number' && v >= 0 && v <= 200),
  };
}

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return sanitizeSettings(JSON.parse(raw) as Partial<Settings>);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

interface SettingsState extends Settings {
  update: (patch: Partial<Settings>) => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...load(),
  update: (patch) => {
    set(patch);
    const { update: _ignored, ...rest } = { ...get(), ...patch };
    try {
      localStorage.setItem(KEY, JSON.stringify(rest));
    } catch {
      /* storage full or blocked: settings stay in memory */
    }
  },
}));

/** Interface preferences that are applied as classes on <html>. */
function applyDocumentClasses(s: Settings): void {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('no-speaking-anim', !s.speakingAnimation);
  document.documentElement.classList.toggle('no-profile-anim', !s.profileAnimations);
  if (s.uiTheme === 'default') document.documentElement.removeAttribute('data-ui-theme');
  else document.documentElement.setAttribute('data-ui-theme', s.uiTheme);
}
applyDocumentClasses(useSettingsStore.getState());
useSettingsStore.subscribe((s, prev) => {
  if (s.speakingAnimation !== prev.speakingAnimation || s.profileAnimations !== prev.profileAnimations || s.uiTheme !== prev.uiTheme) applyDocumentClasses(s);
});
