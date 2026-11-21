import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { BackendManager } from './backendManager';
import { RenderWindowManager } from './renderWindowManager';

const isDev = !app.isPackaged && Boolean(process.env.VITE_DEV_SERVER_URL || process.env.AMCS_DEV !== '0');
const devServerUrl = process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5173';

// frontend/dist-electron/main.cjs -> repo root is ../..
const frontendRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(frontendRoot, '..');
const preloadPath = path.join(__dirname, 'preload.cjs');
const distIndexPath = path.join(frontendRoot, 'dist', 'index.html');

const backendManager = new BackendManager(repoRoot);
const renderWindowManager = new RenderWindowManager();

let mainWindow: BrowserWindow | null = null;
let isShuttingDown = false;

async function checkDevServerReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url);
    return res.ok;
  } catch {
    return false;
  }
}

async function createWindows(): Promise<void> {
  const useDevUrl = isDev && (await checkDevServerReachable(devServerUrl));

  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1024,
    minHeight: 660,
    backgroundColor: '#101216',
    title: 'AutoMotion Comic Studio',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  if (useDevUrl) {
    await mainWindow.loadURL(devServerUrl);
  } else {
    await mainWindow.loadFile(distIndexPath);
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Launch hidden PixiJS WebGL offscreen render worker window
  renderWindowManager.create(preloadPath, useDevUrl ? devServerUrl : null, distIndexPath);
}

ipcMain.handle('amcs:get-backend-config', () => {
  return backendManager.getConnectionInfo();
});

ipcMain.handle('amcs:select-export-dir', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    title: 'Select Export Directory',
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
});

ipcMain.handle('amcs:reveal-in-folder', async (_e, filePath: string) => {
  if (filePath) {
    shell.showItemInFolder(filePath);
  }
});

ipcMain.handle('amcs:open-path', async (_e, filePath: string) => {
  if (!filePath) return 'No path';
  // Returns '' on success, otherwise the OS error message
  return shell.openPath(filePath);
});

ipcMain.handle('amcs:set-render-active', async (_e, active: boolean) => {
  renderWindowManager.setRenderActive(Boolean(active));
});

app.whenReady().then(async () => {
  try {
    await backendManager.start();
    await createWindows();
  } catch (err) {
    console.error('[Main] Startup error:', err);
    dialog.showErrorBox(
      'AutoMotion Comic Studio — Startup Error',
      err instanceof Error ? err.message : String(err),
    );
    app.quit();
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', async (event) => {
  if (isShuttingDown) return;
  event.preventDefault();
  isShuttingDown = true;
  renderWindowManager.destroy();
  await backendManager.stop();
  app.exit(0);
});
