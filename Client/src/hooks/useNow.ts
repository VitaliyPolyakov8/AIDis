import { useCallback, useSyncExternalStore } from 'react';

/**
 * 0.4.1: ONE shared 1-second clock for every live timer (voice sessions, game durations).
 * It runs only while at least one component uses it, ticks on whole seconds, and each component
 * re-renders only when its own resolution changes (a minute-resolution game timer re-renders once
 * a minute, not every second). No per-participant or per-row timers.
 */
const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setTimeout> | null = null;

function tick(): void {
  now = Date.now();
  for (const listener of listeners) listener();
  // Re-align to the next whole second every time, so displays never drift or skip.
  timer = setTimeout(tick, 1000 - (now % 1000) + 5);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!timer) {
    now = Date.now();
    timer = setTimeout(tick, 1000 - (now % 1000) + 5);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

/** Number of active subscribers (tests). */
export function clockSubscribers(): number {
  return listeners.size;
}

/** Current time in ms, rounded down to `resolutionMs` (1000 = every second, 60000 = every minute). 0 when disabled. */
export function useNow(resolutionMs = 1000, enabled = true): number {
  // Before the clock runs (first render), read the real time instead of a stale tick.
  const getSnapshot = useCallback(() => (enabled ? Math.floor((timer ? now : Date.now()) / resolutionMs) * resolutionMs : 0), [resolutionMs, enabled]);
  const sub = useCallback((listener: () => void) => (enabled ? subscribe(listener) : () => undefined), [enabled]);
  return useSyncExternalStore(sub, getSnapshot);
}
