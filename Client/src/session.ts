import { clearAttachmentCache } from './api/attachments';
import { usersApi } from './api/users';
import { realtime } from './realtime/socket';
import { onLogout, useAuthStore } from './stores/authStore';
import { useChatStore } from './stores/chatStore';
import { usePresenceStore } from './stores/presenceStore';
import { useStatusStore } from './stores/statusStore';
import { useUiStore } from './stores/uiStore';
import { useReadStore } from './stores/readStore';
import { usePermsStore } from './stores/permsStore';
import { useFriendsStore } from './stores/friendsStore';
import { useGuildStore } from './stores/guildStore';
import { useCallStore } from './stores/callStore';
import { startOccupancyPolling, stopOccupancyPolling } from './voice/occupancy';
import { voice } from './voice/voiceService';
import { useVoiceStore } from './voice/voiceStore';
import { startVoicePrefs } from './voice/voicePrefs';
import { useEmojiStore } from './emojis/store';

/**
 * Initial application load after login (or session restore):
 * channels + members + presence in parallel, then the realtime connection.
 * Message history is loaded by the channel view itself.
 */
let starting: Promise<void> | null = null;
let stopVoicePresence: (() => void) | null = null;
let stopVoicePrefs: (() => void) | null = null;

/** Concurrent calls (React StrictMode runs effects twice in development) share one start. */
export function startSession(): Promise<void> {
  starting ??= runSession().finally(() => {
    starting = null;
  });
  return starting;
}

async function runSession(): Promise<void> {
  const chat = useChatStore.getState();
  const presence = usePresenceStore.getState();
  const [, usersResult, presenceResult] = await Promise.all([
    chat.loadChannels(),
    usersApi.list(),
    usersApi.presence().catch(() => null),
    // 0.4.0: DMs, unread state, own permissions / roles / badges (older servers: skipped quietly).
    chat.loadDms().catch(() => []),
    useReadStore
      .getState()
      .load()
      .catch(() => undefined),
    usePermsStore
      .getState()
      .load()
      .catch(() => undefined),
    // 0.7.0: friends (DMs are between friends).
    useFriendsStore
      .getState()
      .load()
      .catch(() => undefined),
    useEmojiStore.getState().load(),
  ]);
  presence.setUsers(usersResult.users);
  // Never overwrite the live realtime snapshot with this (older) REST answer.
  if (presenceResult && !realtime.hasSnapshot) presence.applySnapshot(presenceResult.presence);
  void useStatusStore.getState().load();
  // 0.4.5: remembered mic mute / deafen of this account.
  stopVoicePrefs?.();
  const userId = useAuthStore.getState().user?.id;
  stopVoicePrefs = userId ? startVoicePrefs(userId) : null;
  realtime.connect();
  startOccupancyPolling();
  // 0.4.1: "joined / left voice" hints for the server's voice session timer.
  stopVoicePresence?.();
  // 0.4.2: authoritative resync after joining / switching / a LiveKit reconnect and on resume.
  let lastKey = '';
  let syncTimer: ReturnType<typeof setTimeout> | null = null;
  const resyncSoon = (delayMs: number) => {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      syncTimer = null;
      realtime.requestVoiceSync();
    }, delayMs);
  };
  const reportVoice = () => {
    const { status, channelId } = useVoiceStore.getState();
    realtime.setVoiceChannel(status === 'connected' || status === 'reconnecting' ? channelId : null);
    const key = `${status}:${channelId ?? ''}`;
    if (key === lastKey) return;
    const wasReconnecting = lastKey.startsWith('reconnecting:');
    lastKey = key;
    // The server needs a moment to see the LiveKit change; ask after it had time.
    if (status === 'connected' || status === 'idle') resyncSoon(wasReconnecting ? 300 : 1500);
  };
  reportVoice();
  const unsubscribe = useVoiceStore.subscribe(reportVoice);
  let hiddenAt = 0;
  const onVisibility = () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt > 10_000) resyncSoon(0);
  };
  document.addEventListener('visibilitychange', onVisibility);
  stopVoicePresence = () => {
    unsubscribe();
    document.removeEventListener('visibilitychange', onVisibility);
    if (syncTimer) clearTimeout(syncTimer);
  };
}

/** Everything that must be torn down when the user logs out or the session dies. */
export function endSession(): void {
  stopVoicePresence?.();
  stopVoicePresence = null;
  stopVoicePrefs?.();
  stopVoicePrefs = null;
  realtime.setVoiceChannel(null);
  realtime.disconnect();
  stopOccupancyPolling();
  void voice.reset();
  useChatStore.getState().reset();
  usePresenceStore.getState().reset();
  useStatusStore.getState().reset();
  useReadStore.getState().reset();
  usePermsStore.getState().reset();
  useFriendsStore.getState().reset();
  useGuildStore.getState().reset();
  useCallStore.getState().dismiss();
  useUiStore.setState({ settingsOpen: false, sourcePickerOpen: false, channelDrawerOpen: false, membersDrawerOpen: false });
  clearAttachmentCache();
  useEmojiStore.getState().reset();
}

onLogout(endSession);
