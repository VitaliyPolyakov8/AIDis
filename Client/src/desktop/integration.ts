import { i18next } from '../i18n';
import { useVoiceStore } from '../voice/voiceStore';
import { voice } from '../voice/voiceService';
import { desktop } from './bridge';
import type { ShellCommand, ShellVoiceState } from './contract';
import { useDesktopStore } from './desktopStore';
import { toggleScreenShareFromHotkey } from './screenCapture';
import { publicGameName } from './contract';
import { startOverlayFeed } from './overlayFeed';
import { useLocalGame } from './localGame';
import { realtime } from '../realtime/socket';
import { useAuthStore } from '../stores/authStore';
import { useChatStore } from '../stores/chatStore';

/**
 * Wires the Electron shell into the shared client:
 *  - global hotkeys and tray commands -> the same voice service methods the buttons call
 *    (so UI state, interface sounds and LiveKit always change together);
 *  - global Push-to-Talk key state -> voice.setPushToTalk;
 *  - voice state -> tray menu; UI language -> tray / native dialogs.
 * Returns a function that removes every listener (StrictMode mounts effects twice).
 */
export function startDesktopIntegration(): () => void {
  if (!desktop) return () => undefined;
  const api = desktop;
  const cleanups: (() => void)[] = [];

  cleanups.push(api.hotkeys.onCommand((command) => runCommand(command)));
  cleanups.push(api.hotkeys.onPushToTalk((pressed) => voice.setPushToTalk(pressed)));

  // Input mode follows the desktop settings.
  const applyInput = () => {
    const { mode, pttReleaseDelayMs } = useDesktopStore.getState().settings.voiceInput;
    voice.setInputMode(mode, pttReleaseDelayMs);
  };
  applyInput();
  cleanups.push(useDesktopStore.subscribe(applyInput));

  // Tray mirrors the voice state; only send real changes.
  let last = '';
  const report = () => {
    const s = useVoiceStore.getState();
    const state: ShellVoiceState = {
      inCall: s.status === 'connected' || s.status === 'connecting' || s.status === 'reconnecting',
      micEnabled: s.micEnabled,
      deafened: s.deafened,
      screenSharing: s.localScreenSharing,
      // 0.4.2 tray icon: the local speaking state LiveKit already computes (no polling; this
      // subscription only sends when a logical value changes, see `last` below).
      speaking: s.status === 'connected' && s.participants.some((p) => p.isLocal && p.isSpeaking),
      channelName: useChatStore.getState().channels.find((c) => c.id === s.channelId)?.name ?? '',
    };
    const key = JSON.stringify(state);
    if (key === last) return;
    last = key;
    api.voice.reportState(state);
  };
  report();
  cleanups.push(useVoiceStore.subscribe(report));

  // Presence (0.3.0): automatic Away from Windows idle time; the game being played, published
  // only as its display name and only if the user allows it (filtered here, before sending).
  cleanups.push(api.presence.onIdle((idle) => realtime.setIdle(idle)));
  // 0.4.1: with the game's Steam AppID and start time (older shells: name only).
  let detectedGame: string | null = null;
  const applyGame = () => {
    const name = publicGameName(detectedGame, useDesktopStore.getState().settings.preferences);
    const info = useLocalGame.getState().info;
    realtime.setActivity(name && info?.name === name ? { name, steamAppId: info.steamAppId, startedAt: info.startedAt } : name);
  };
  cleanups.push(
    api.presence.onActivity((name) => {
      detectedGame = name;
      applyGame();
    }),
  );
  void api.presence.getDetectedGame().then((name) => {
    detectedGame = name;
    applyGame();
  });
  if (api.presence.onGameInfo) {
    cleanups.push(
      api.presence.onGameInfo((info) => {
        useLocalGame.setState({ info });
        applyGame();
      }),
    );
  }
  void api.presence.getGameInfo?.().then((info) => {
    useLocalGame.setState({ info });
    applyGame();
  });
  cleanups.push(useDesktopStore.subscribe(applyGame));

  // In-game overlay: state feed + mute / deafen pressed on the overlay.
  cleanups.push(startOverlayFeed());
  cleanups.push(
    api.overlay.onAction((action) => {
      if (action === 'toggleMute') void voice.toggleMic();
      else if (action === 'toggleDeafen') void voice.toggleDeafen();
      else if (action.startsWith('watch:')) {
        // Overlay "switch to this stream": focus it in the main window's stream view.
        const identity = action.slice('watch:'.length);
        if (useVoiceStore.getState().participants.some((p) => p.identity === identity && p.screenSharing)) voice.focusShare(identity);
      }
    }),
  );
  // 0.4.0 quick reply typed in the overlay: sent like any message (same checks on the server).
  cleanups.push(
    api.overlay.onReply((reply) => {
      const user = useAuthStore.getState().user;
      const text = reply.text.trim();
      if (!user || !text) return;
      const chat = useChatStore.getState();
      const target = reply.replyToId ? Object.values(chat.byChannel).flatMap((c) => c.messages).find((m) => m.id === reply.replyToId) : undefined;
      void chat.sendMessage(reply.channelId, user, text.slice(0, 4000), [], undefined, target ?? null);
    }),
  );

  const syncLanguage = (lng: string) => {
    const language = lng === 'ru' ? 'ru' : 'en';
    if (useDesktopStore.getState().settings.language !== language) void useDesktopStore.getState().update({ language });
  };
  syncLanguage(i18next.language);
  i18next.on('languageChanged', syncLanguage);
  cleanups.push(() => i18next.off('languageChanged', syncLanguage));

  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}

function runCommand(command: ShellCommand): void {
  switch (command) {
    case 'toggleMute':
      void voice.toggleMic();
      break;
    case 'toggleDeafen':
      void voice.toggleDeafen();
      break;
    case 'disconnectVoice':
      if (useVoiceStore.getState().status !== 'idle') void voice.leave();
      break;
    case 'toggleScreenShare':
      void toggleScreenShareFromHotkey();
      break;
  }
}
