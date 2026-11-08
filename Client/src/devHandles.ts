import { useAuthStore } from './stores/authStore';
import { useGuildStore } from './stores/guildStore';
import { useChatStore } from './stores/chatStore';
import { usePresenceStore } from './stores/presenceStore';
import { useReadStore } from './stores/readStore';
import { useUiStore } from './stores/uiStore';
import { useVoiceStore } from './voice/voiceStore';
import { useSettingsStore } from './stores/settingsStore';
import { useLocalGame } from './desktop/localGame';
import { alignedTrack } from './desktop/frameAlign';
import { isHardwareEncoder } from './voice/voiceService';
import { useDesktopStore } from './desktop/desktopStore';
import { messagesApi } from './api/messages';

/**
 * Development builds only (import.meta.env.DEV): the live store instances for automated UI checks.
 * Not part of production bundles (the import is tree-shaken out behind the DEV check).
 */
export function exposeDevHandles(): void {
  (window as unknown as Record<string, unknown>).__aidis = {
    useAuthStore,
    useChatStore,
    useGuildStore,
    usePresenceStore,
    useReadStore,
    useUiStore,
    useVoiceStore,
    useDesktopStore,
    messagesApi,
    useSettingsStore,
    useLocalGame,
    alignedTrack,
    isHardwareEncoder,
  };
}
