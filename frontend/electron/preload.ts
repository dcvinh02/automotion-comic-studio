import { contextBridge, ipcRenderer } from 'electron';

export interface ElectronAPI {
  getBackendConfig: () => Promise<{ baseUrl: string; wsUrl: string; token: string; port: number }>;
  selectExportDirectory: () => Promise<string | null>;
  revealInFolder: (filePath: string) => Promise<void>;
  openPath?: (filePath: string) => Promise<string>;
  setRenderActive: (active: boolean) => Promise<void>;
  platform: NodeJS.Platform;
}

const api: ElectronAPI = {
  getBackendConfig: () => ipcRenderer.invoke('amcs:get-backend-config'),
  selectExportDirectory: () => ipcRenderer.invoke('amcs:select-export-dir'),
  revealInFolder: (filePath: string) => ipcRenderer.invoke('amcs:reveal-in-folder', filePath),
  openPath: (filePath: string) => ipcRenderer.invoke('amcs:open-path', filePath),
  setRenderActive: (active: boolean) => ipcRenderer.invoke('amcs:set-render-active', active),
  platform: process.platform,
};

contextBridge.exposeInMainWorld('electronAPI', api);
