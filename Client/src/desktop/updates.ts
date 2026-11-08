import { useUiStore } from '../stores/uiStore';
import { useVoiceStore } from '../voice/voiceStore';
import { voice } from '../voice/voiceService';
import { desktop } from './bridge';
import { useDesktopStore } from './desktopStore';

/**
 * "Restart and update": only ever started by the user. Leaves voice first (which stops a screen
 * share and every local media track) so nobody sees a frozen participant, then asks the main
 * process to quit, run the downloaded installer silently and start AIDis again. Settings, the
 * encrypted login and per-user volumes live in %APPDATA%\AIDis and are kept by the installer.
 */
export async function restartAndUpdate(): Promise<void> {
  if (!desktop || useDesktopStore.getState().updateState.status !== 'downloaded') return;
  const status = useVoiceStore.getState().status;
  if (status !== 'idle') await voice.leave();
  desktop.updates.install();
}

/** 0.4.2: the user clicked the green update button while an update is available. */
export function downloadUpdate(): void {
  if (useDesktopStore.getState().updateState.status === 'available') desktop?.updates.download?.();
}

export function checkForUpdates(): void {
  desktop?.updates.check();
}

/** Opens Settings -> About, where the update state lives (used by the notification). */
export function showUpdateUi(): void {
  useUiStore.getState().openSettings('about');
}
