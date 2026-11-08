import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { desktop } from '../../desktop/bridge';
import { startDesktopIntegration } from '../../desktop/integration';
import { useAuthStore } from '../../stores/authStore';
import { useUiStore } from '../../stores/uiStore';
import { pathForChannelId } from '../guilds/links';
import { useChatStore } from '../../stores/chatStore';
import { ScreenSourcePicker } from './ScreenSourcePicker';
import { StreamPopoutHost } from '../voice/StreamPopout';
import { showUpdateUi } from '../../desktop/updates';

/** Mounted only inside AIDis Desktop: hotkeys, tray, PTT and notification clicks. Renders the source picker. */
export function DesktopBridge() {
  const navigate = useNavigate();
  const pickerOpen = useUiStore((s) => s.sourcePickerOpen);
  const authenticated = useAuthStore((s) => s.status === 'authenticated');

  useEffect(() => startDesktopIntegration(), []);

  useEffect(() => {
    if (!desktop) return;
    return desktop.app.onNavigate((channelId) => {
      useUiStore.getState().closeSettings();
      const channel = useChatStore.getState().channels.find((c) => c.id === channelId);
      if (channel?.type === 'VOICE') useUiStore.getState().setVoiceChat(true);
      void navigate(pathForChannelId(channelId));
    });
  }, [navigate]);

  useEffect(() => desktop?.updates.onOpen(showUpdateUi), []);

  return (
    <>
      {pickerOpen && authenticated && <ScreenSourcePicker />}
      {authenticated && <StreamPopoutHost />}
    </>
  );
}
