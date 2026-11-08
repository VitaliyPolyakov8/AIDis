import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC } from '../shared/ipc';
import type { ToastUpdate } from '../main/toasts';

/** Bridge for the notification window only: receive the card list, report clicks / hover. */
contextBridge.exposeInMainWorld(
  'aidisToast',
  Object.freeze({
    onUpdate(callback: (update: ToastUpdate) => void) {
      const listener = (_event: IpcRendererEvent, update: ToastUpdate) => callback(update);
      ipcRenderer.on(IPC.toastUpdate, listener);
      return () => {
        ipcRenderer.removeListener(IPC.toastUpdate, listener);
      };
    },
    send(action: unknown) {
      // Validated by the main process (open / close a card, hover).
      ipcRenderer.send(IPC.toastFromToast, action);
    },
  }),
);
