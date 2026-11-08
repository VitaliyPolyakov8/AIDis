import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { AidisDesktopApi, Unsubscribe } from '../../../Client/src/desktop/contract';
import { IPC } from '../shared/ipc';

/**
 * The only bridge between the page and Electron. It exposes window.aidisDesktop: a narrow, typed
 * API with fixed channels. No ipcRenderer, no Node.js, no generic "invoke anything" escape hatch.
 * Runs sandboxed with contextIsolation; every argument is validated again in the main process.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- ties each channel to its callback type
function subscribe<T>(channel: string, callback: (payload: T) => void): Unsubscribe {
  const listener = (_event: IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api: AidisDesktopApi = {
  isDesktop: true,
  apiVersion: 1,
  app: {
    getInfo: () => ipcRenderer.invoke(IPC.appGetInfo),
    log: (level, message) => ipcRenderer.send(IPC.appLog, level, message),
    setTitleBar: (colors) => ipcRenderer.send(IPC.appSetTitleBar, colors),
    relaunch: () => ipcRenderer.send(IPC.appRelaunch),
    openLogsFolder: () => ipcRenderer.send(IPC.appOpenLogs),
    downloadUrl: (url) => ipcRenderer.send(IPC.appDownloadUrl, url),
    onNavigate: (callback) => subscribe(IPC.appNavigate, callback),
  },
  servers: {
    list: () => ipcRenderer.invoke(IPC.serversList),
    current: () => ipcRenderer.invoke(IPC.serversCurrent),
    add: (address) => ipcRenderer.invoke(IPC.serversAdd, address),
    select: (origin) => ipcRenderer.invoke(IPC.serversSelect, origin),
    remove: (origin) => ipcRenderer.invoke(IPC.serversRemove, origin),
  },
  auth: {
    load: () => ipcRenderer.invoke(IPC.authLoad),
    save: (session) => ipcRenderer.invoke(IPC.authSave, session),
    clear: () => ipcRenderer.invoke(IPC.authClear),
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    update: (patch) => ipcRenderer.invoke(IPC.settingsUpdate, patch),
    onChange: (callback) => subscribe(IPC.settingsChanged, callback),
  },
  hotkeys: {
    getStatus: () => ipcRenderer.invoke(IPC.hotkeysGetStatus),
    setCapturing: (active) => ipcRenderer.send(IPC.hotkeysSetCapturing, active),
    onCommand: (callback) => subscribe(IPC.hotkeysCommand, callback),
    onPushToTalk: (callback) => subscribe(IPC.hotkeysPtt, callback),
    onStatus: (callback) => subscribe(IPC.hotkeysStatus, callback),
  },
  voice: {
    reportState: (state) => ipcRenderer.send(IPC.voiceState, state),
  },
  appAudio: {
    start: (sourceId) => ipcRenderer.invoke(IPC.appAudioStart, sourceId),
    stop: () => ipcRenderer.send(IPC.appAudioStop),
  },
  streams: {
    setAlwaysOnTop: (windowName, onTop) => ipcRenderer.send(IPC.streamsSetAlwaysOnTop, windowName, onTop),
  },
  capture: {
    getSources: () => ipcRenderer.invoke(IPC.captureGetSources),
    select: (selection) => ipcRenderer.invoke(IPC.captureSelect, selection),
    findGameSource: () => ipcRenderer.invoke(IPC.captureFindGameSource),
  },
  notifications: {
    show: (notification) => ipcRenderer.send(IPC.notificationsShow, notification),
    toast: (notification) => ipcRenderer.send(IPC.notificationsToast, notification),
  },
  presence: {
    onIdle: (callback) => subscribe(IPC.presenceIdle, callback),
    onActivity: (callback) => subscribe(IPC.presenceActivity, callback),
    getDetectedGame: () => ipcRenderer.invoke(IPC.presenceGetGame),
    getGameInfo: () => ipcRenderer.invoke(IPC.presenceGetGameInfo),
    onGameInfo: (callback) => subscribe(IPC.presenceGameInfo, callback),
  },
  overlay: {
    pushStreamHint: (hint) => ipcRenderer.send(IPC.overlayStreamHint, hint),
    pushState: (state) => ipcRenderer.send(IPC.overlayState, state),
    pushMessage: (message) => ipcRenderer.send(IPC.overlayMessage, message),
    onAction: (callback) => subscribe(IPC.overlayAction, callback),
    onReply: (callback) => subscribe(IPC.overlayReply, callback),
    getDisplays: () => ipcRenderer.invoke(IPC.overlayGetDisplays),
    preview: () => ipcRenderer.send(IPC.overlayPreview),
  },
  updates: {
    getState: () => ipcRenderer.invoke(IPC.updatesGetState),
    check: () => ipcRenderer.send(IPC.updatesCheck),
    install: () => ipcRenderer.send(IPC.updatesInstall),
    download: () => ipcRenderer.send(IPC.updatesDownload),
    onState: (callback) => subscribe(IPC.updatesState, callback),
    onOpen: (callback) => subscribe(IPC.updatesOpen, () => callback()),
  },
};

contextBridge.exposeInMainWorld('aidisDesktop', Object.freeze(api));

// 0.4.5: MessagePorts cannot cross contextBridge; hand the application-audio port to the page.
ipcRenderer.on(IPC.appAudioPort, (event) => {
  window.postMessage('aidis-app-audio-port', '*', event.ports);
});
