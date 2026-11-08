/**
 * 0.5.9 voice in the background on iPhone / iPad (best effort: iOS decides in the end).
 *
 * What keeps a call audible when the app is minimised or the phone is locked:
 *  - the audio session is a call ("play-and-record", Safari 16.4+ Audio Session API), like a
 *    phone app, so iOS keeps the audio running;
 *  - a live microphone capture during the whole call (voiceService publishes the microphone muted
 *    instead of not at all on iOS): WebKit keeps a page with active capture running;
 *  - remote voices play through <audio> elements, not Web Audio (voiceService, setting
 *    "Звук в фоне"): iOS suspends Web Audio in the background;
 *  - Media Session: the lock screen shows the call (channel name, AIDis icon); its play / pause
 *    button deafens / undeafens, "stop" leaves.
 * Back in the foreground, playback that iOS paused is resumed.
 */
import { useVoiceStore } from '../voice/voiceStore';
import { useChatStore } from '../stores/chatStore';

type AudioSessionType = 'auto' | 'playback' | 'transient' | 'transient-solo' | 'ambient' | 'play-and-record';
interface AudioSessionLike {
  type: AudioSessionType;
}

function audioSession(): AudioSessionLike | null {
  const session = (navigator as Navigator & { audioSession?: AudioSessionLike }).audioSession;
  return session && typeof session === 'object' ? session : null;
}

function setSessionType(type: AudioSessionType): void {
  const session = audioSession();
  if (!session) return;
  try {
    if (session.type !== type) session.type = type;
  } catch {
    // Older iOS: no Audio Session API, nothing to do.
  }
}

let started = false;

export function startIosCallAudio(): void {
  if (started) return;
  started = true;
  let inCall = false;
  let lastTitle = '';

  const apply = () => {
    const s = useVoiceStore.getState();
    const active = s.status === 'connecting' || s.status === 'connected' || s.status === 'reconnecting';
    if (active !== inCall) {
      inCall = active;
      setSessionType(active ? 'play-and-record' : 'auto');
      setMediaSession(active);
      lastTitle = '';
    }
    if (active && 'mediaSession' in navigator) {
      const channel = useChatStore.getState().channels.find((c) => c.id === s.channelId)?.name ?? 'AIDis';
      const title = `${channel}${s.deafened ? ' · 🔇' : ''}`;
      if (title !== lastTitle) {
        lastTitle = title;
        try {
          navigator.mediaSession.metadata = new MediaMetadata({
            title,
            artist: 'AIDis',
            artwork: [
              { src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
              { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
            ],
          });
          navigator.mediaSession.playbackState = s.deafened ? 'paused' : 'playing';
        } catch {
          // Media Session missing or refused: only the lock screen card is affected.
        }
      }
    }
  };
  useVoiceStore.subscribe(apply);
  useChatStore.subscribe(apply);
  apply();

  // Back from the background or the lock screen: resume what iOS paused.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !inCall) return;
    void import('../voice/voiceService').then(({ voice }) => voice.resumeAfterBackground());
  });
}

function setMediaSession(active: boolean): void {
  if (!('mediaSession' in navigator)) return;
  const session = navigator.mediaSession;
  const handle = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
    try {
      session.setActionHandler(action, handler);
    } catch {
      // This action is not supported by this iOS version.
    }
  };
  if (!active) {
    for (const action of ['play', 'pause', 'stop'] as MediaSessionAction[]) handle(action, null);
    try {
      session.metadata = null;
      session.playbackState = 'none';
    } catch {
      /* ignore */
    }
    return;
  }
  const voice = () => import('../voice/voiceService').then((m) => m.voice);
  handle('play', () => {
    void voice().then((v) => {
      if (useVoiceStore.getState().deafened) void v.toggleDeafen();
    });
  });
  handle('pause', () => {
    void voice().then((v) => {
      if (!useVoiceStore.getState().deafened) void v.toggleDeafen();
    });
  });
  handle('stop', () => {
    void voice().then((v) => v.leave());
  });
}
