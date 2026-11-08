import { useVoiceStore } from './voiceStore';

/**
 * 0.4.5: microphone mute and deafen are remembered per local AIDis account (localStorage, this
 * device only). Restored as soon as the session starts, so the buttons show the right state and
 * the next voice join starts muted / deafened. Only valid combinations are restored: deafened
 * always means the microphone is off too (the same rule as the deafen button).
 */
const key = (userId: string) => `aidis.voiceState.${userId}`;

export interface StoredVoiceState {
  micEnabled: boolean;
  deafened: boolean;
  /** Mic state to return to when undeafening. */
  micBeforeDeafen: boolean;
}

/** Pure (unit-tested): repairs whatever was stored. */
export function sanitizeVoicePrefs(raw: unknown): StoredVoiceState | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.micEnabled !== 'boolean' || typeof r.deafened !== 'boolean') return null;
  const micBeforeDeafen = typeof r.micBeforeDeafen === 'boolean' ? r.micBeforeDeafen : true;
  if (r.deafened) return { micEnabled: false, deafened: true, micBeforeDeafen };
  return { micEnabled: r.micEnabled, deafened: false, micBeforeDeafen: r.micEnabled };
}

export function loadVoicePrefs(userId: string): StoredVoiceState | null {
  try {
    const raw = localStorage.getItem(key(userId));
    return raw ? sanitizeVoicePrefs(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/** Applies the stored state and keeps saving changes; returns the unsubscribe function. */
export function startVoicePrefs(userId: string): () => void {
  const stored = loadVoicePrefs(userId);
  if (stored) useVoiceStore.setState(stored);
  let last = '';
  const save = () => {
    const { micEnabled, deafened, micBeforeDeafen } = useVoiceStore.getState();
    const value = JSON.stringify({ micEnabled, deafened, micBeforeDeafen });
    if (value === last) return;
    last = value;
    try {
      localStorage.setItem(key(userId), value);
    } catch {
      /* storage blocked: the state just is not remembered */
    }
  };
  save();
  return useVoiceStore.subscribe(save);
}
