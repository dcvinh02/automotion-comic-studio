/**
 * Phase 09.3 — Crash-recovery journal and session marker (Electron main process, plain Node fs).
 *
 * Unsaved editor changes normally reach project.db within seconds via autosave. When that cannot
 * happen (save failing, backend down, app killed during the autosave delay), the renderer sends its
 * unsaved project sections here. They are written atomically (temp file + fsync + rename) into
 * `<userData>/recovery/`, independent of the backend and of project.db — the original project is
 * never modified by recovery data. A session marker detects abnormal termination of the previous run.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export const RECOVERY_FORMAT = 'amcs-recovery';
export const RECOVERY_VERSION = 1;
export const KEEP_PER_PROJECT = 3;

export interface RecoveryPayload {
  format: typeof RECOVERY_FORMAT;
  version: number;
  project_id: string;
  project_name: string;
  created_at: string;
  reason: string;
  base_revisions: Record<string, number>;
  dirty_sections: string[];
  sections: Record<string, unknown>;
}

export interface RecoveryCandidate {
  file: string;
  valid: boolean;
  error?: string;
  size_bytes: number;
  payload?: RecoveryPayload;
}

const SECTIONS = new Set(['meta', 'scenes', 'timeline', 'script', 'subtitles', 'director', 'storyboard', 'production_plan', 'production_queue', 'qc_report']);
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export function validatePayload(raw: unknown, file?: string): RecoveryPayload {
  const p = raw as Partial<RecoveryPayload> | null;
  if (!p || typeof p !== 'object') throw new Error('not an object');
  if (p.format !== RECOVERY_FORMAT) throw new Error('not an AutoMotion recovery file');
  if (typeof p.version !== 'number' || p.version > RECOVERY_VERSION) throw new Error(`unsupported recovery version ${String(p.version)}`);
  if (typeof p.project_id !== 'string' || !SAFE_ID.test(p.project_id)) throw new Error('invalid project id');
  if (file && !file.startsWith(`${p.project_id}__`)) throw new Error('file name does not match its project');
  if (typeof p.created_at !== 'string' || Number.isNaN(Date.parse(p.created_at))) throw new Error('invalid timestamp');
  if (!Array.isArray(p.dirty_sections) || p.dirty_sections.some((s) => !SECTIONS.has(String(s)))) throw new Error('invalid section list');
  if (!p.sections || typeof p.sections !== 'object') throw new Error('missing sections');
  for (const s of p.dirty_sections) if (!(s in p.sections)) throw new Error(`section ${s} missing`);
  return p as RecoveryPayload;
}

export class RecoveryStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  /** Write (atomically) the latest unsaved state of a project; keeps the newest few per project. */
  write(payload: RecoveryPayload): string {
    validatePayload(payload);
    const stamp = new Date(payload.created_at).toISOString().replace(/[:.]/g, '-');
    const file = `${payload.project_id}__${stamp}.json`;
    atomicWrite(join(this.dir, file), JSON.stringify(payload));
    const mine = readdirSync(this.dir)
      .filter((f) => f.startsWith(`${payload.project_id}__`) && f.endsWith('.json'))
      .sort()
      .reverse();
    for (const old of mine.slice(KEEP_PER_PROJECT)) this.safeUnlink(old);
    return file;
  }

  /** Every candidate, newest first. Corrupt files are reported (valid=false), never thrown. */
  list(): RecoveryCandidate[] {
    if (!existsSync(this.dir)) return [];
    const out: RecoveryCandidate[] = [];
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith('.json') || file === 'session.json') continue;
      const full = join(this.dir, file);
      let size = 0;
      try {
        size = statSync(full).size;
        const payload = validatePayload(JSON.parse(readFileSync(full, 'utf-8')), file);
        out.push({ file, valid: true, size_bytes: size, payload });
      } catch (err) {
        out.push({ file, valid: false, size_bytes: size, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return out.sort((a, b) => (b.payload?.created_at ?? '').localeCompare(a.payload?.created_at ?? ''));
  }

  /** Delete one candidate (only `*.json` files inside the recovery folder). */
  delete(file: string): boolean {
    if (!/^[A-Za-z0-9_.-]+\.json$/.test(file) || file === 'session.json') return false;
    return this.safeUnlink(file);
  }

  /** Delete all candidates of a project (after its changes were saved successfully). */
  clearProject(projectId: string): number {
    if (!SAFE_ID.test(projectId)) return 0;
    let n = 0;
    for (const f of readdirSync(this.dir)) if (f.startsWith(`${projectId}__`) && f.endsWith('.json') && this.safeUnlink(f)) n++;
    return n;
  }

  /**
   * Mark this run as active. Returns whether the previous run ended without a clean shutdown
   * (its marker is still present and its process is gone).
   */
  beginSession(pid = process.pid): { previousRunCrashed: boolean; previousStartedAt: string | null } {
    const marker = join(this.dir, 'session.json');
    let previousRunCrashed = false;
    let previousStartedAt: string | null = null;
    if (existsSync(marker)) {
      try {
        const prev = JSON.parse(readFileSync(marker, 'utf-8')) as { pid?: number; started_at?: string };
        previousStartedAt = prev.started_at ?? null;
        previousRunCrashed = !(typeof prev.pid === 'number' && prev.pid !== pid && isAlive(prev.pid));
      } catch {
        previousRunCrashed = true; // unreadable marker = interrupted write during a crash
      }
    }
    atomicWrite(marker, JSON.stringify({ pid, started_at: new Date().toISOString() }));
    return { previousRunCrashed, previousStartedAt };
  }

  /** Clean shutdown: remove the session marker. */
  endSession(): void {
    this.safeUnlink('session.json');
  }

  private safeUnlink(file: string): boolean {
    try {
      unlinkSync(join(this.dir, file));
      return true;
    } catch {
      return false;
    }
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
