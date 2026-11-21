import { BrowserWindow, powerSaveBlocker } from 'electron';
import path from 'node:path';

export class RenderWindowManager {
  private renderWin: BrowserWindow | null = null;
  private blockerId: number | null = null;

  create(preloadPath: string, devServerUrl: string | null, distIndexPath: string): void {
    if (this.renderWin && !this.renderWin.isDestroyed()) {
      return;
    }

    this.renderWin = new BrowserWindow({
      width: 640,
      height: 360,
      show: false,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });

    if (devServerUrl) {
      this.renderWin.loadURL(`${devServerUrl}?mode=render-worker`);
    } else {
      this.renderWin.loadFile(distIndexPath, { query: { mode: 'render-worker' } });
    }

    this.renderWin.webContents.on('console-message', (event) => {
      console.log(`[RenderWorker] ${event.message}`);
    });

    this.renderWin.on('closed', () => {
      this.renderWin = null;
    });
  }

  setRenderActive(active: boolean): void {
    if (active) {
      if (this.blockerId === null) {
        this.blockerId = powerSaveBlocker.start('prevent-app-suspension');
      }
    } else if (this.blockerId !== null) {
      if (powerSaveBlocker.isStarted(this.blockerId)) {
        powerSaveBlocker.stop(this.blockerId);
      }
      this.blockerId = null;
    }
  }

  destroy(): void {
    this.setRenderActive(false);
    if (this.renderWin && !this.renderWin.isDestroyed()) {
      this.renderWin.destroy();
    }
    this.renderWin = null;
  }
}
