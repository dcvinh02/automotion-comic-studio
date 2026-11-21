import { contextBridge, ipcRenderer } from 'electron';

export interface ElectronAPI {
  getBackendConfig: () => Promise<{ baseUrl: string; wsUrl: string; token: string; port: number }>;
  selectExportDirectory: () => Promise<string | null>;
  revealInFolder: (filePath: string) => Promise<void>;
  openPath?: (filePath: string) => Promise<string>;
  recoveryWrite: (payload: unknown) => Promise<string>;
  recoveryList: () => Promise<unknown[]>;
  recoveryDelete: (file: string) => Promise<boolean>;
  recoveryClearProject: (projectId: string) => Promise<number>;
  sessionStatus: () => Promise<{ previousRunCrashed: boolean; previousStartedAt: string | null }>;
  onCloseRequested: (handler: () => Promise<{ ok: boolean; error?: string }>) => () => void;
  setRenderActive: (active: boolean) => Promise<void>;
  platform: NodeJS.Platform;
}

const api: ElectronAPI = {
  getBackendConfig: () => ipcRenderer.invoke('amcs:get-backend-config'),
  selectExportDirectory: () => ipcRenderer.invoke('amcs:select-export-dir'),
  revealInFolder: (filePath: string) => ipcRenderer.invoke('amcs:reveal-in-folder', filePath),
  openPath: (filePath: string) => ipcRenderer.invoke('amcs:open-path', filePath),
  recoveryWrite: (payload: unknown) => ipcRenderer.invoke('amcs:recovery-write', payload),
  recoveryList: () => ipcRenderer.invoke('amcs:recovery-list'),
  recoveryDelete: (file: string) => ipcRenderer.invoke('amcs:recovery-delete', file),
  recoveryClearProject: (projectId: string) => ipcRenderer.invoke('amcs:recovery-clear-project', projectId),
  sessionStatus: () => ipcRenderer.invoke('amcs:session-status'),
  onCloseRequested: (handler) => {
    const listener = async () => {
      let res: { ok: boolean; error?: string };
      try {
        res = await handler();
      } catch (err) {
        res = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      ipcRenderer.send('amcs:close-response', res);
    };
    ipcRenderer.on('amcs:close-requested', listener);
    return () => ipcRenderer.removeListener('amcs:close-requested', listener);
  },
  setRenderActive: (active: boolean) => ipcRenderer.invoke('amcs:set-render-active', active),
  platform: process.platform,
};

contextBridge.exposeInMainWorld('electronAPI', api);
