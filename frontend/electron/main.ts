import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { BackendManager } from './backendManager';
import { RenderWindowManager } from './renderWindowManager';
import { RecoveryStore, type RecoveryPayload } from './recoveryStore';

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
// Phase 09.3: crash-recovery journal + session marker, independent of the backend and project.db
let recoveryStore: RecoveryStore | null = null;
let sessionStatus: { previousRunCrashed: boolean; previousStartedAt: string | null } = {
  previousRunCrashed: false,
  previousStartedAt: null,
};
let allowClose = false;
const CLOSE_SAVE_TIMEOUT_MS = 15000;

function getRecoveryStore(): RecoveryStore {
  if (!recoveryStore) recoveryStore = new RecoveryStore(path.join(app.getPath('userData'), 'recovery'));
  return recoveryStore;
}

/** Ask the editor to save before the window closes; never discard unsaved work silently. */
function requestRendererSave(win: BrowserWindow): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ipcMain.removeAllListeners('amcs:close-response');
      resolve({ ok: false, error: 'The editor did not finish saving in time.' });
    }, CLOSE_SAVE_TIMEOUT_MS);
    ipcMain.once('amcs:close-response', (_e, res: { ok: boolean; error?: string }) => {
      clearTimeout(timer);
      resolve(res ?? { ok: false, error: 'No response from the editor.' });
    });
    win.webContents.send('amcs:close-requested');
  });
}

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

  mainWindow.on('close', (event) => {
    if (allowClose || !mainWindow) return;
    event.preventDefault();
    const win = mainWindow;
    void requestRendererSave(win).then(async (res) => {
      if ((res as { cancelled?: boolean }).cancelled) return; // user chose Cancel: keep working
      if (!res.ok) {
        const choice = await dialog.showMessageBox(win, {
          type: 'warning',
          buttons: ['Cancel', 'Quit anyway'],
          defaultId: 0,
          cancelId: 0,
          title: 'Unsaved changes',
          message: 'Your latest changes could not be saved.',
          detail: `${res.error ?? 'Unknown error.'}\n\nThey are kept as recovery data and will be offered the next time you open AutoMotion Comic Studio.`,
        });
        if (choice.response !== 1) return;
      }
      allowClose = true;
      win.close();
    });
  });

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

ipcMain.handle('amcs:recovery-write', (_e, payload: RecoveryPayload) => getRecoveryStore().write(payload));
ipcMain.handle('amcs:recovery-list', () => getRecoveryStore().list());
ipcMain.handle('amcs:recovery-delete', (_e, file: string) => getRecoveryStore().delete(file));
ipcMain.handle('amcs:recovery-clear-project', (_e, projectId: string) => getRecoveryStore().clearProject(projectId));
ipcMain.handle('amcs:session-status', () => sessionStatus);

ipcMain.handle('amcs:set-render-active', async (_e, active: boolean) => {
  renderWindowManager.setRenderActive(Boolean(active));
});

app.whenReady().then(async () => {
  try {
    try {
      sessionStatus = getRecoveryStore().beginSession();
    } catch (err) {
      console.error('[Main] Recovery store unavailable:', err);
    }
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
  // Route Cmd+Q / app quit through the window's save-before-close handshake first.
  if (!allowClose && mainWindow && !mainWindow.isDestroyed()) {
    event.preventDefault();
    mainWindow.close();
    return;
  }
  event.preventDefault();
  isShuttingDown = true;
  renderWindowManager.destroy();
  await backendManager.stop();
  try {
    recoveryStore?.endSession(); // clean shutdown marker (recovery files are kept if unsaved work remains)
  } catch {
    // ignore
  }
  app.exit(0);
});
