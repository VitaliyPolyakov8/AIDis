import joinUrl from '../assets/sounds/join.wav?url';
import leaveUrl from '../assets/sounds/leave.wav?url';
import muteUrl from '../assets/sounds/mute.wav?url';
import unmuteUrl from '../assets/sounds/unmute.wav?url';
import shareStartUrl from '../assets/sounds/share-start.wav?url';
import shareStopUrl from '../assets/sounds/share-stop.wav?url';
import streamWatchUrl from '../assets/sounds/stream-watch.wav?url';
import userJoinUrl from '../assets/sounds/user-join.wav?url';
import userLeaveUrl from '../assets/sounds/user-leave.wav?url';
import viewerJoinUrl from '../assets/sounds/viewer-join.wav?url';
import viewerLeaveUrl from '../assets/sounds/viewer-leave.wav?url';
import notifyUrl from '../assets/sounds/notify.wav?url';
import { useSettingsStore } from '../stores/settingsStore';

/**
 * Interface sounds: short local feedback played through an <audio> element on this device.
 * They never go through LiveKit (no track is published), so other participants cannot hear them
 * except acoustically. One sound plays at a time; a new one replaces the previous.
 * Autoplay rejections are ignored silently (they only happen without a prior user gesture).
 */
export type SoundName = 'join' | 'leave' | 'mute' | 'unmute' | 'shareStart' | 'shareStop' | 'streamWatch' | 'userJoin' | 'userLeave' | 'viewerJoin' | 'viewerLeave' | 'notify';

const SOURCES: Record<SoundName, string> = {
  join: joinUrl,
  leave: leaveUrl,
  mute: muteUrl,
  unmute: unmuteUrl,
  shareStart: shareStartUrl,
  shareStop: shareStopUrl,
  streamWatch: streamWatchUrl,
  // 0.4.2: someone else entered / left our voice channel (softer than our own join / leave).
  userJoin: userJoinUrl,
  userLeave: userLeaveUrl,
  // 0.5.0 (all synthesized for AIDis, see Client/scripts/make-sounds-050.py): someone started /
  // stopped watching a stream we stream or watch, and the new-message notification ("quack").
  viewerJoin: viewerJoinUrl,
  viewerLeave: viewerLeaveUrl,
  notify: notifyUrl,
};

const VOLUME = 0.38;
/** The same sound is not replayed within this window (e.g. double clicks). */
const REPEAT_GUARD_MS = 120;

const elements = new Map<string, HTMLAudioElement>();
let current: HTMLAudioElement | null = null;
const lastPlayed = new Map<SoundName, number>();

function element(name: SoundName): HTMLAudioElement | null {
  if (typeof Audio === 'undefined') return null;
  const url = SOURCES[name];
  let el = elements.get(url);
  if (!el) {
    el = new Audio(url);
    el.preload = 'auto';
    elements.set(url, el);
  }
  el.volume = VOLUME;
  return el;
}

function applyOutputDevice(el: HTMLAudioElement): void {
  const deviceId = useSettingsStore.getState().outputDeviceId;
  const withSink = el as HTMLAudioElement & { sinkId?: string; setSinkId?: (id: string) => Promise<void> };
  const target = deviceId === 'default' ? '' : deviceId;
  if (typeof withSink.setSinkId === 'function' && withSink.sinkId !== target) {
    withSink.setSinkId(target).catch(() => undefined);
  }
}

export function playSound(name: SoundName, options: { force?: boolean } = {}): void {
  const settings = useSettingsStore.getState();
  if (!options.force && !settings.interfaceSounds) return;
  if (!options.force && (name === 'userJoin' || name === 'userLeave') && !settings.participantSounds) return;
  if (!options.force && (name === 'viewerJoin' || name === 'viewerLeave') && !settings.streamViewerSounds) return;
  if (name === 'notify') {
    // Its own switch and volume, and it never cuts off another sound.
    if (!options.force && !settings.notificationSound) return;
    playNotify(settings.notificationVolume);
    return;
  }
  const now = Date.now();
  if (now - (lastPlayed.get(name) ?? 0) < REPEAT_GUARD_MS) return;
  lastPlayed.set(name, now);

  const el = element(name);
  if (!el) return;
  try {
    if (current && current !== el) {
      current.pause();
      current.currentTime = 0;
    }
    current = el;
    el.currentTime = 0;
    applyOutputDevice(el);
    const result = el.play() as Promise<void> | undefined;
    result?.catch(() => undefined);
  } catch {
    /* audio unavailable: interface sounds are optional */
  }
}

/** Warms the cache so the first sound has no delay. */
export function preloadSounds(): void {
  for (const name of Object.keys(SOURCES) as SoundName[]) element(name);
}

/** 0.5.8: forget the other set's elements when the set changes (the new one loads on next play). */
export function resetSoundCache(): void {
  elements.clear();
  notifyEl = null;
  current = null;
}

let notifyEl: HTMLAudioElement | null = null;
let lastNotify = 0;
/** 0.5.0 notification sound: separate element (overlaps other sounds), own volume, max ~1 per second. */
function playNotify(volumePercent: number): void {
  if (typeof Audio === 'undefined') return;
  const now = Date.now();
  if (now - lastNotify < 900) return;
  lastNotify = now;
  notifyEl ??= new Audio(SOURCES.notify);
  notifyEl.volume = Math.max(0, Math.min(1, VOLUME * 1.6 * (volumePercent / 100)));
  applyOutputDevice(notifyEl);
  try {
    notifyEl.currentTime = 0;
    const result = notifyEl.play() as Promise<void> | undefined;
    result?.catch(() => undefined);
  } catch {
    /* ignore */
  }
}
