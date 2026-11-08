import { app, BrowserWindow, dialog, ipcMain, screen, session, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import type { DesktopAppInfo, DesktopSettings, ShellCommand, ShellVoiceState } from '../../../Client/src/desktop/contract';
import { join } from 'node:path';
import { IPC } from '../shared/ipc';
import { CaptureService } from './capture';
import { GameDetector, type GameInfo } from './gameDetector';
import { gameIcon, listWindowedProcesses, pickGameSource } from './gameWindows';
import type { DesktopGameInfo } from '../../../Client/src/desktop/contract';
import { IdleMonitor } from './idle';
import { OverlayService, sanitizeOverlayMessage, sanitizeOverlayState } from './overlay';
import { APP_ID, AUTOSTART_ARG, IS_DEV, RENDERER_ORIGIN } from './config';
import { isAttachmentDownloadUrl } from './downloads';
import { HotkeyManager } from './hotkeys';
import { setMainLanguage, tr } from './i18n';
import { initLogger, logger } from './logger';
import { createMainWindow, isHexColor, setTitleBarColors, showWindow } from './mainWindow';
import { StreamPopouts } from './streamPopouts';
import { StreamHints } from './streamHints';
import { AppAudio } from './appAudio';
import { installApiCorsBridge } from './network';
import { Notifier } from './notifications';
import { ToastService } from './toasts';
import { installPermissionHandlers, isRendererUrl } from './permissions';
import { handleAppScheme, registerAppScheme } from './protocol';
import { SecureSessionStore } from './secureSession';
import { ServerError, ServerStore } from './servers';
import { SettingsStore } from './settings';
import { AppTray } from './tray';
import { StreamPriority } from './streamPriority';
import { UpdateService } from './updater';
import { WindowStateKeeper } from './windowState';
import { configureSpellcheck } from './spellcheck';

// ---- process-level setup (before 'ready') ------------------------------------------------

app.setAppUserModelId(APP_ID);

// Development/testing only: an isolated profile (never honoured by the installed app). Must be set
// before the single-instance lock, which lives in the profile folder.
if (!app.isPackaged && process.env.AIDIS_USER_DATA_DIR) app.setPath('userData', process.env.AIDIS_USER_DATA_DIR);

// A second launch only wakes the running instance (it gets 'second-instance' and shows its window).
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  start();
}

function start(): void {
  const userData = app.getPath('userData');
  app.setAppLogsPath(join(userData, 'logs'));
  const logFile = initLogger(app.getPath('logs'));
  const settings = new SettingsStore(userData, app.getLocale().toLowerCase().startsWith('ru') ? 'ru' : 'en');
  setMainLanguage(settings.get().language);

  const hardwareAcceleration = settings.get().preferences.hardwareAcceleration;
  if (!hardwareAcceleration) app.disableHardwareAcceleration();
  // Screen sharing (0.3.0): Windows Graphics Capture hands frames over as GPU textures instead of
  // copying each one into system memory. The copy (~7 ms per 1080p frame) together with Chromium's
  // rule of spending at most half a CPU core on capture made real windows deliver only ~33 of 60
  // FPS. Measured: window 33 -> 52, screen 32 -> 47-58 FPS (see RELEASE_0.3.0_REPORT.md).
  else {
    // Development experiments only: extra Chromium features (ignored in the installed app).
    const devFeatures = !app.isPackaged ? process.env.AIDIS_DEV_FEATURES : undefined;
    const devNoTexture = !app.isPackaged && process.env.AIDIS_DEV_NO_WGC_TEXTURE === '1';
    app.commandLine.appendSwitch('enable-features', [...(devNoTexture ? [] : ['WebRtcAllowWgcUsingTexture']), ...(devFeatures ? devFeatures.split(',') : [])].join(','));
    // Development diagnostics only: Chromium verbose log to a file (ignored in the installed app).
    const devLog = !app.isPackaged ? process.env.AIDIS_DEV_CHROMIUM_LOG : undefined;
    if (devLog) {
      app.commandLine.appendSwitch('enable-logging', 'file');
      app.commandLine.appendSwitch('log-file', devLog);
      app.commandLine.appendSwitch('vmodule', process.env.AIDIS_DEV_VMODULE ?? '*encoder*=3,*video_encode*=3,*gpu_video*=2,*media_foundation*=3');
    }
    const devDisabled = !app.isPackaged ? process.env.AIDIS_DEV_DISABLE_FEATURES : undefined;
    if (devDisabled) app.commandLine.appendSwitch('disable-features', devDisabled);
  }
  // 0.5.2 streaming while gaming: AIDis is usually hidden in the tray or behind the game then.
  // Chromium treats such a renderer as "backgrounded" (lower priority, Windows 11 EcoQoS = efficiency
  // cores), and it runs the capture-to-encoder pipeline (frame alignment worker, WebRTC send threads).
  // Voice and streams keep their priority whatever the window state. (The bigger win under game
  // load is the process priority while streaming, see streamPriority.ts.)
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  registerAppScheme();

  logger.info(
    'app',
    `AIDis Desktop ${app.getVersion()} starting (Electron ${process.versions.electron}, Chromium ${process.versions.chrome}, ` +
      `${process.platform} ${process.arch}${IS_DEV ? ', development' : ''}${hardwareAcceleration ? '' : ', GPU acceleration off'})`,
  );

  let mainWindow: BrowserWindow | null = null;
  const streamPopouts = new StreamPopouts(userData);
  const appAudio = new AppAudio();
  let tray: AppTray | null = null;
  const streamPriority = new StreamPriority();
  let quitting = false;
  let trayNoticeShown = false;
  const getWindow = () => mainWindow;

  // One universal app: the user picks the server; every server has its own stored session.
  const servers = new ServerStore(userData, (url, init) => fetch(url, init), IS_DEV);
  const sessionStores = new Map<string, SecureSessionStore>();
  const sessionStore = (): SecureSessionStore | null => {
    const origin = servers.current()?.origin;
    if (!origin) return null;
    let store = sessionStores.get(origin);
    if (!store) {
      store = new SecureSessionStore(userData, origin);
      sessionStores.set(origin, store);
    }
    return store;
  };
  const reloadForServer = () => {
    mainWindow?.webContents.reload();
  };
  const capture = new CaptureService(getWindow);
  const streamHints = new StreamHints((sourceId) => capture.hintBounds(sourceId));
  const notifier = new Notifier((channelId) => {
    showWindow(mainWindow);
    send(IPC.appNavigate, channelId);
  });
  // 0.5.0: chat notifications are AIDis cards (bottom-right), not Windows toasts.
  const toasts = new ToastService((channelId) => {
    showWindow(mainWindow);
    send(IPC.appNavigate, channelId);
  });

  const updates = new UpdateService();
  updates.on('state', (state) => send(IPC.updatesState, state));
  updates.on('downloaded', (version) => {
    notifier.notice(tr('updateReadyTitle'), tr('updateReadyBody').replace('{version}', version), () => {
      showWindow(mainWindow);
      send(IPC.updatesOpen, null);
    });
  });

  // ---- presence (0.3.0): automatic Away and game activity -------------------------------
  const idle = new IdleMonitor((isIdle) => send(IPC.presenceIdle, isIdle));
  const games = new GameDetector();
  // The renderer applies "Display current game" / hidden games before anything is published.
  games.on('change', (game) => {
    overlay.setGame(game);
    send(IPC.presenceActivity, game);
  });
  // 0.4.1: AppID, start time and the local executable icon (paths stay in the main process).
  let gameInfo: DesktopGameInfo | null = null;
  const publicGame = (info: GameInfo, icon: string | null): DesktopGameInfo => ({
    name: info.name,
    steamAppId: info.steamAppId,
    startedAt: new Date(info.startedAt).toISOString(),
    icon,
  });
  games.on('info', (info) => {
    gameInfo = info ? publicGame(info, gameInfo?.name === info.name ? gameInfo.icon : null) : null;
    send(IPC.presenceGameInfo, gameInfo);
    if (!info || gameInfo?.icon) return;
    void gameIcon(info).then((icon) => {
      if (!icon || games.info?.name !== info.name) return;
      gameInfo = publicGame(games.info, icon);
      send(IPC.presenceGameInfo, gameInfo);
    });
  });

  // ---- in-game overlay (separate window, see overlay.ts) -----------------------------------
  const overlay = new OverlayService({
    onInteractiveChange: (on) => streamPopouts.setOverlayInteractive(on),
    // A layout dragged while a game with its own profile runs is saved into that profile.
    savePosition: (panel, position, game) => {
      const current = settings.get().overlay;
      const key = panel === 'list' ? 'custom' : 'chatCustom';
      const profile = game ? current.profiles[game] : undefined;
      if (game && profile) settings.update({ overlay: { profiles: { ...current.profiles, [game]: { ...profile, [key]: position } } } });
      else settings.update({ overlay: { [key]: position } });
    },
    onAction: (action) => send(IPC.overlayAction, action),
    onReply: (reply) => send(IPC.overlayReply, reply),
  });

  const hotkeys = new HotkeyManager({
    onAction: (action) => {
      if (action === 'toggleWindow') toggleWindow();
      else if (action === 'toggleOverlay') overlay.toggleVisible();
      else if (action === 'overlayInteract') {
        if (settings.get().overlay.enabled) overlay.toggleInteractive();
        else streamPopouts.toggleOverlayInteractive();
      } else if (action === 'overlayRecent') overlay.showRecent();
      else send(IPC.hotkeysCommand, action);
    },
    onPushToTalk: (pressed) => send(IPC.hotkeysPtt, pressed),
    onStatus: (status) => send(IPC.hotkeysStatus, status),
  });

  function send(channel: string, payload: unknown): void {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  }

  function toggleWindow(): void {
    if (!mainWindow) return;
    if (mainWindow.isVisible() && mainWindow.isFocused() && !mainWindow.isMinimized()) mainWindow.hide();
    else showWindow(mainWindow);
  }

  function quit(): void {
    quitting = true;
    app.quit();
  }

  function applyAutostart(enabled: boolean): void {
    if (!app.isPackaged) {
      logger.info('app', `Start with Windows ${enabled ? 'on' : 'off'} (not written to Windows in development)`);
      return;
    }
    try {
      app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath, args: [AUTOSTART_ARG] });
    } catch (error) {
      logger.error('app', 'Could not update the Windows startup entry', error);
    }
  }

  function onSettingsChanged(next: DesktopSettings, previous: DesktopSettings): void {
    hotkeys.configure(next.keybinds, next.voiceInput.mode === 'pushToTalk');
    if (next.preferences.startWithWindows !== previous.preferences.startWithWindows) applyAutostart(next.preferences.startWithWindows);
    if (next.language !== previous.language) {
      setMainLanguage(next.language);
      tray?.rebuild();
    }
    idle.configure(next.preferences.autoAway, next.preferences.autoAwayMinutes);
    overlay.configure(next.overlay, next.language);
    send(IPC.settingsChanged, next);
  }
  settings.on('change', onSettingsChanged);

  // ---- IPC -------------------------------------------------------------------------------

  /** Only our own top-level page may use the bridge. */
  function trusted(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    const ok = mainWindow !== null && event.sender === mainWindow.webContents && isRendererUrl(event.senderFrame?.url);
    if (!ok) logger.warn('ipc', 'Rejected IPC from an unexpected sender');
    return ok;
  }

  function handle(channel: string, fn: (...args: unknown[]) => unknown): void {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (!trusted(event)) throw new Error('Forbidden');
      try {
        return await fn(...args);
      } catch (error) {
        logger.error('ipc', `${channel} failed`, error);
        throw new Error(`${channel} failed`, { cause: error });
      }
    });
  }

  function on(channel: string, fn: (...args: unknown[]) => void): void {
    ipcMain.on(channel, (event, ...args: unknown[]) => {
      if (!trusted(event)) return;
      try {
        fn(...args);
      } catch (error) {
        logger.error('ipc', `${channel} failed`, error);
      }
    });
  }

  /**
   * 0.5.0: the user is looking at AIDis right now. Windows can still report a minimized (or hidden
   * to tray) window as focused until another window activates, which swallowed notifications.
   */
  function isLookingAtApp(): boolean {
    return mainWindow !== null && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized() && mainWindow.isFocused();
  }

  function isVoiceState(value: unknown): value is ShellVoiceState {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    if (!['inCall', 'micEnabled', 'deafened', 'screenSharing'].every((k) => typeof v[k] === 'boolean')) return false;
    // 0.4.2 optional fields (tray icon / tooltip).
    if (v.speaking !== undefined && typeof v.speaking !== 'boolean') return false;
    if (v.channelName !== undefined && (typeof v.channelName !== 'string' || v.channelName.length > 100)) return false;
    return true;
  }

  function registerIpc(): void {
    handle(
      IPC.appGetInfo,
      (): DesktopAppInfo => ({
        appVersion: app.getVersion(),
        electronVersion: process.versions.electron,
        chromeVersion: process.versions.chrome,
        platform: process.platform,
        arch: process.arch,
        secureStorage: new SecureSessionStore(userData, 'probe').encryptionAvailable,
        hardwareAccelerationActive: hardwareAcceleration,
        // 0.4.7: read at call time (the GPU process reports it after start), for stream diagnostics.
        videoEncodeStatus: app.getGPUFeatureStatus().video_encode,
      }),
    );
    handle(IPC.authLoad, () => sessionStore()?.load() ?? null);
    handle(IPC.authSave, (value) => sessionStore()?.save(value));
    handle(IPC.authClear, () => sessionStore()?.clear());
    handle(IPC.serversList, () => servers.list());
    handle(IPC.serversCurrent, () => servers.current());
    handle(IPC.serversAdd, async (address) => {
      if (typeof address !== 'string' || address.length > 300) return { ok: false, code: 'INVALID' };
      try {
        const server = await servers.add(address);
        setTimeout(reloadForServer, 50);
        return { ok: true, server };
      } catch (error) {
        return { ok: false, code: error instanceof ServerError ? error.code : 'UNREACHABLE' };
      }
    });
    handle(IPC.serversSelect, (origin) => {
      if (typeof origin !== 'string') return;
      servers.select(origin);
      setTimeout(reloadForServer, 50);
    });
    handle(IPC.serversRemove, (origin) => {
      if (typeof origin !== 'string') return;
      const wasCurrent = servers.current()?.origin === origin;
      sessionStores.get(origin)?.clear();
      servers.remove(origin);
      if (wasCurrent) setTimeout(reloadForServer, 50);
    });
    handle(IPC.settingsGet, () => settings.get());
    handle(IPC.settingsUpdate, (patch) => settings.update(patch));
    handle(IPC.hotkeysGetStatus, () => hotkeys.status);
    handle(IPC.captureGetSources, () => capture.getSources());
    handle(IPC.captureSelect, (selection) => capture.select(selection));
    handle(IPC.captureFindGameSource, async () => {
      const info = games.info;
      if (!info) return null;
      const [sources, processes] = await Promise.all([capture.listIds(), listWindowedProcesses()]);
      const id = pickGameSource(sources, info, processes);
      logger.info('capture', id ? 'Game window found for "Stream game"' : 'Game window not found; opening the normal picker');
      return id;
    });

    on(IPC.appLog, (level, message) => {
      if ((level === 'info' || level === 'warn' || level === 'error') && typeof message === 'string') {
        logger[level]('renderer', message.slice(0, 2000));
      }
    });
    on(IPC.appRelaunch, () => {
      logger.info('app', 'Relaunch requested');
      app.relaunch();
      quit();
    });
    on(IPC.appOpenLogs, () => {
      void shell.openPath(app.getPath('logs'));
    });
    // 0.5.5: only signed attachment links of our own API are downloaded (never arbitrary URLs).
    on(IPC.appDownloadUrl, (url) => {
      if (typeof url !== 'string' || !isAttachmentDownloadUrl(url, servers.current()?.origin ?? null)) return;
      mainWindow?.webContents.downloadURL(url);
    });
    on(IPC.hotkeysSetCapturing, (active) => {
      if (typeof active === 'boolean') hotkeys.setCapturing(active);
    });
    on(IPC.voiceState, (state) => {
      if (!isVoiceState(state)) return;
      if (!state.inCall || !state.screenSharing) streamHints.clear();
      tray?.setVoiceState(state);
      hotkeys.setInCall(state.inCall);
      streamPriority.set(state.inCall && state.screenSharing);
    });
    handle(IPC.updatesGetState, () => updates.current);
    handle(IPC.presenceGetGame, () => games.current);
    handle(IPC.presenceGetGameInfo, () => gameInfo);
    handle(IPC.overlayGetDisplays, () => {
      const primary = screen.getPrimaryDisplay().id;
      return screen.getAllDisplays().map((d, i) => ({
        id: d.id,
        label: `${i + 1}: ${d.size.width}×${d.size.height}`,
        primary: d.id === primary,
      }));
    });
    on(IPC.overlayState, (value) => {
      const state = sanitizeOverlayState(value);
      if (state) overlay.setState(state);
    });
    on(IPC.overlayMessage, (value) => {
      const message = sanitizeOverlayMessage(value);
      if (message) overlay.pushMessage(message);
    });
    on(IPC.overlayPreview, () => overlay.preview());
    on(IPC.overlayStreamHint, (value) => {
      void streamHints.show(value);
    });
    // The overlay window has its own preload; only that window may send these.
    ipcMain.on(IPC.overlayFromOverlay, (event, action: unknown) => {
      if (overlay.isOverlaySender(event)) overlay.handleFromOverlay(action);
    });
    on(IPC.updatesCheck, () => updates.check());
    on(IPC.updatesDownload, () => updates.download());
    handle(IPC.appAudioStart, (sourceId) => (mainWindow ? appAudio.start(sourceId, mainWindow.webContents) : { ok: false, reason: 'no-window' }));
    on(IPC.appAudioStop, () => appAudio.stop());
    on(IPC.streamsSetAlwaysOnTop, (name, onTop) => streamPopouts.setAlwaysOnTop(name, onTop));
    on(IPC.appSetTitleBar, (value) => {
      if (typeof value !== 'object' || value === null) return;
      const { color, symbolColor } = value as Record<string, unknown>;
      if (mainWindow && isHexColor(color) && isHexColor(symbolColor)) setTitleBarColors(mainWindow, { color, symbolColor });
    });
    on(IPC.updatesInstall, () => {
      updates.install(() => {
        quitting = true;
        hotkeys.dispose();
      });
    });
    on(IPC.notificationsShow, (value) => {
      if (!settings.get().preferences.notifications) return;
      if (isLookingAtApp()) return;
      notifier.show(value);
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) mainWindow.flashFrame(true);
    });
    on(IPC.notificationsToast, (value) => {
      if (!settings.get().preferences.notifications) return;
      if (isLookingAtApp()) return;
      toasts.show(value);
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) mainWindow.flashFrame(true);
    });
    // The notification window has its own preload; only that window may send these.
    ipcMain.on(IPC.toastFromToast, (event, action: unknown) => {
      if (toasts.isToastSender(event)) toasts.handleFromToast(action);
    });
  }

  // ---- lifecycle -------------------------------------------------------------------------

  app.on('second-instance', () => showWindow(mainWindow));

  app.on('child-process-gone', (_event, details) => {
    // Chromium restarts a crashed GPU process by itself (and falls back to software rendering
    // if it keeps crashing); we only record it.
    logger.error('app', `${details.type} process gone: ${details.reason} (exit ${details.exitCode})`);
  });

  app.on('web-contents-created', (_event, contents) => {
    // Defense in depth: no other page may ever be opened inside the app.
    contents.on('will-navigate', (navEvent, url) => {
      if (!isRendererUrl(url)) navEvent.preventDefault();
    });
  });

  app.on('before-quit', () => {
    quitting = true;
  });

  app.on('will-quit', () => {
    appAudio.stop();
    streamHints.clear();
    overlay.dispose();
    toasts.destroy();
    games.stop();
    idle.stop();
    updates.dispose();
    hotkeys.dispose();
    tray?.destroy();
    tray = null;
    logger.info('app', 'Quit');
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  void app
    .whenReady()
    .then(() => {
      const ses = session.defaultSession;
      configureSpellcheck(ses);
      if (!IS_DEV) handleAppScheme(() => servers.current());
      installApiCorsBridge(ses, () => servers.current()?.origin ?? null);
      // The server's settings (voice domain, update mirror, minimum version) may have changed since last time.
      void servers.refreshCurrent();
      installPermissionHandlers(ses);
      capture.install(ses);
      registerIpc();

      const windowState = new WindowStateKeeper(userData);
      const startHidden = process.argv.includes(AUTOSTART_ARG);
      mainWindow = createMainWindow(windowState, { show: !startHidden, popouts: streamPopouts });
      mainWindow.on('close', (event) => {
        if (quitting || !settings.get().preferences.closeToTray) return;
        event.preventDefault();
        mainWindow?.hide();
        if (!trayNoticeShown) {
          trayNoticeShown = true;
          notifier.notice(tr('stillRunningTitle'), tr('stillRunningBody'), () => showWindow(mainWindow));
        }
      });
      mainWindow.on('focus', () => {
        mainWindow?.flashFrame(false);
        // 0.5.0: back in AIDis: the notification cards are no longer needed.
        toasts.clearAll();
      });
      mainWindow.on('closed', () => {
        mainWindow = null;
      });

      tray = new AppTray({
        show: () => showWindow(mainWindow),
        command: (command: ShellCommand) => send(IPC.hotkeysCommand, command),
        quit,
      });

      const current = settings.get();
      hotkeys.configure(current.keybinds, current.voiceInput.mode === 'pushToTalk');
      idle.configure(current.preferences.autoAway, current.preferences.autoAwayMinutes);
      overlay.configure(current.overlay, current.language);
      games.start();
      // Only (re)write the startup entry when it is wanted; turning it off happens when the setting changes.
      if (current.preferences.startWithWindows) applyAutostart(true);

      logger.info(
        'app',
        `Ready (renderer ${RENDERER_ORIGIN}, logs ${logFile}, server ${servers.current()?.origin ?? 'not chosen'}, secure storage ${new SecureSessionStore(userData, 'probe').encryptionAvailable ? 'on' : 'unavailable'})`,
      );
      updates.start(servers.current());
    })
    .catch((error: unknown) => {
      logger.error('app', 'Startup failed', error);
      dialog.showErrorBox('AIDis', 'AIDis could not start. See the log for details.');
      app.exit(1);
    });
}
