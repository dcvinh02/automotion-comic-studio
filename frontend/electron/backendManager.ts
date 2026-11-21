import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export interface BackendConnectionInfo {
  baseUrl: string;
  wsUrl: string;
  token: string;
  port: number;
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close(() => reject(new Error('Failed to allocate port')));
        return;
      }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });
}

function resolvePythonExecutable(repoRoot: string): string {
  if (process.env.AMCS_PYTHON_BIN && fs.existsSync(process.env.AMCS_PYTHON_BIN)) {
    return process.env.AMCS_PYTHON_BIN;
  }
  const isWin = process.platform === 'win32';
  const venvPython = isWin
    ? path.join(repoRoot, 'backend', '.venv', 'Scripts', 'python.exe')
    : path.join(repoRoot, 'backend', '.venv', 'bin', 'python');
  if (fs.existsSync(venvPython)) {
    return venvPython;
  }
  return isWin ? 'python' : 'python3';
}

export class BackendManager {
  private child: ChildProcess | null = null;
  private info: BackendConnectionInfo | null = null;
  private readonly repoRoot: string;

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
  }

  getConnectionInfo(): BackendConnectionInfo {
    if (!this.info) {
      throw new Error('Backend has not been started yet.');
    }
    return this.info;
  }

  async start(): Promise<BackendConnectionInfo> {
    // Allow external backend reuse during automated testing if AMCS_EXTERNAL_BACKEND_URL is provided
    if (process.env.AMCS_EXTERNAL_BACKEND_URL) {
      const baseUrl = process.env.AMCS_EXTERNAL_BACKEND_URL.replace(/\/+$/, '');
      const u = new URL(baseUrl);
      const wsProtocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
      this.info = {
        baseUrl,
        wsUrl: `${wsProtocol}//${u.host}`,
        token: process.env.AMCS_TOKEN ?? '',
        port: Number(u.port || 8765),
      };
      return this.info;
    }

    const port = await findFreePort();
    const token = crypto.randomBytes(24).toString('hex');
    const pythonBin = resolvePythonExecutable(this.repoRoot);
    const backendDir = path.join(this.repoRoot, 'backend');
    const workspaceDir = process.env.AMCS_WORKSPACE_DIR || path.join(this.repoRoot, 'workspace');

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AMCS_HOST: '127.0.0.1',
      AMCS_PORT: String(port),
      AMCS_TOKEN: token,
      AMCS_PARENT_PID: String(process.pid),
      AMCS_WORKSPACE_DIR: workspaceDir,
      PYTHONUNBUFFERED: '1',
    };

    // Ensure Homebrew bin is in PATH on macOS packaged/GUI apps
    if (process.platform === 'darwin') {
      const currentPath = env.PATH || '';
      const extras = ['/opt/homebrew/bin', '/usr/local/bin'].filter((p) => !currentPath.includes(p));
      if (extras.length > 0) {
        env.PATH = `${extras.join(':')}:${currentPath}`;
      }
    }

    console.log(`[BackendManager] Spawning ${pythonBin} on 127.0.0.1:${port}`);
    this.child = spawn(
      pythonBin,
      ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(port), '--log-level', 'info'],
      {
        cwd: backendDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    this.child.stdout?.on('data', (chunk) => {
      process.stdout.write(`[backend] ${chunk.toString()}`);
    });
    this.child.stderr?.on('data', (chunk) => {
      process.stderr.write(`[backend] ${chunk.toString()}`);
    });
    this.child.on('exit', (code, signal) => {
      console.log(`[BackendManager] Python backend exited (code=${code}, signal=${signal})`);
      this.child = null;
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    await this.waitForHealth(baseUrl, 20000);

    this.info = {
      baseUrl,
      wsUrl: `ws://127.0.0.1:${port}`,
      token,
      port,
    };
    return this.info;
  }

  private async waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.child) {
        throw new Error('Python backend terminated unexpectedly during startup.');
      }
      try {
        const res = await fetch(`${baseUrl}/api/v1/health`);
        if (res.ok) {
          return;
        }
      } catch {
        // Retry until ready
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`Timed out waiting for Python backend health at ${baseUrl}`);
  }

  async stop(): Promise<void> {
    if (!this.child) return;
    const proc = this.child;
    this.child = null;
    await new Promise<void>((resolve) => {
      const killer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          // Ignore already exited
        }
        resolve();
      }, 3000);
      proc.once('exit', () => {
        clearTimeout(killer);
        resolve();
      });
      try {
        proc.kill('SIGTERM');
      } catch {
        clearTimeout(killer);
        resolve();
      }
    });
  }
}
