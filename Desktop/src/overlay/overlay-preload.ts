import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC } from '../shared/ipc';
import type { OverlayUpdate } from '../main/overlay';

/**
 * Bridge for the overlay page only: receive updates from the main process and send back the two
 * voice actions, "watch" a stream, a quick reply (or "done" to leave interaction mode). No Node,
 * no generic IPC.
 */
contextBridge.exposeInMainWorld(
  'aidisOverlay',
  Object.freeze({
    onUpdate(callback: (update: OverlayUpdate) => void) {
      const listener = (_event: IpcRendererEvent, update: OverlayUpdate) => callback(update);
      ipcRenderer.on(IPC.overlayUpdate, listener);
      return () => {
        ipcRenderer.removeListener(IPC.overlayUpdate, listener);
      };
    },
    send(action: unknown) {
      // The main process validates everything (voice actions, "watch", quick reply).
      ipcRenderer.send(IPC.overlayFromOverlay, action);
    },
  }),
);
