import { create } from 'zustand';
import { setTokenStore } from '../api/client';
import { config, setApiOrigin } from '../config';
import { useServerConfig } from '../api/clientConfig';
import { desktop } from './bridge';
import { DEFAULT_DESKTOP_SETTINGS, type DesktopAppInfo, type DesktopServer, type DesktopSettings, type DesktopSettingsPatch, type HotkeyStatus, type SettingsUpdateResult, type UpdateState } from './contract';
import { DesktopTokenStore } from './desktopTokenStore';

interface DesktopState {
  info: DesktopAppInfo | null;
  settings: DesktopSettings;
  hotkeyStatus: HotkeyStatus;
  updateState: UpdateState;
  /** Version whose "ready" banner the user dismissed with "Later" (until the next one). */
  updateBannerDismissed: string | null;
  /** The AIDis server this window talks to (null in the browser and before the user picked one). */
  server: DesktopServer | null;
  servers: DesktopServer[];
  /** Desktop app without a chosen server: show the "server address" screen instead of the app. */
  needsServer: boolean;
  update: (patch: DesktopSettingsPatch) => Promise<SettingsUpdateResult>;
}

/** Desktop-only settings (keybinds, streaming, PTT, tray/startup). Owned and persisted by the main process. */
export const useDesktopStore = create<DesktopState>((set) => ({
  info: null,
  settings: DEFAULT_DESKTOP_SETTINGS,
  hotkeyStatus: { failed: [], pttAvailable: true },
  updateState: { status: 'unsupported' },
  updateBannerDismissed: null,
  server: null,
  servers: [],
  needsServer: false,
  update: async (patch) => {
    if (!desktop) return { ok: false, error: 'invalid' };
    const result = await desktop.settings.update(patch);
    if (result.ok) set({ settings: result.settings });
    return result;
  },
}));

let initialized = false;

/**
 * Runs before the first render inside AIDis Desktop: swaps in the encrypted token store and loads
 * the shell's settings and version info. A no-op in the browser.
 */
export async function initDesktop(): Promise<void> {
  if (!desktop || initialized) return;
  initialized = true;
  config.clientType = 'desktop';
  config.platform = 'desktop';

  // One universal app: point the UI at the server the user picked (the window reloads on a switch).
  if (desktop.servers) {
    const [server, servers] = await Promise.all([desktop.servers.current().catch(() => null), desktop.servers.list().catch(() => [])]);
    useDesktopStore.setState({ server, servers, needsServer: !server });
    if (server) {
      setApiOrigin(server.origin);
      if (server.config.livekitUrl) config.livekitUrl = server.config.livekitUrl;
      useServerConfig.setState({ steamArt: server.config.steamArt, voiceNodeDomain: server.config.voiceNodeDomain, loaded: true });
    }
  }

  const [session, settings, info, hotkeyStatus, updateState] = await Promise.all([
    desktop.auth.load().catch(() => null),
    desktop.settings.get().catch(() => DEFAULT_DESKTOP_SETTINGS),
    desktop.app.getInfo().catch(() => null),
    desktop.hotkeys.getStatus().catch(() => ({ failed: [], pttAvailable: false })),
    desktop.updates.getState().catch((): UpdateState => ({ status: 'unsupported' })),
  ]);
  setTokenStore(new DesktopTokenStore(desktop.auth, session));
  useDesktopStore.setState({ settings, info, hotkeyStatus, updateState });

  desktop.settings.onChange((next) => useDesktopStore.setState({ settings: next }));
  desktop.hotkeys.onStatus((status) => useDesktopStore.setState({ hotkeyStatus: status }));
  desktop.updates.onState((state) => useDesktopStore.setState({ updateState: state }));
}
