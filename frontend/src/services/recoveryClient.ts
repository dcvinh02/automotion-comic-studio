/**
 * Phase 09.3 — Access to crash-recovery data. In the desktop app the Electron main process stores
 * it (independent of the backend); in a plain browser (dev) it falls back to localStorage.
 */
import type { RecoveryPayload } from '@/engine/recoveryJournal';

export interface RecoveryCandidate {
  file: string;
  valid: boolean;
  error?: string;
  size_bytes: number;
  payload?: RecoveryPayload;
}

const LS_PREFIX = 'amcs.recovery.';

function ls(): Storage | null {
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

export const recoveryClient = {
  async write(payload: RecoveryPayload): Promise<void> {
    if (window.electronAPI?.recoveryWrite) {
      await window.electronAPI.recoveryWrite(payload);
      return;
    }
    const key = `${LS_PREFIX}${payload.project_id}__${payload.created_at}`;
    const store = ls();
    if (!store) throw new Error('No place to store recovery data');
    for (const k of Object.keys(store)) if (k.startsWith(`${LS_PREFIX}${payload.project_id}__`)) store.removeItem(k);
    store.setItem(key, JSON.stringify(payload));
  },

  /** Synchronous best-effort write used only by the browser `beforeunload` fallback. */
  writeSyncFallback(payload: RecoveryPayload): void {
    const store = ls();
    if (!store) return;
    try {
      store.setItem(`${LS_PREFIX}${payload.project_id}__${payload.created_at}`, JSON.stringify(payload));
    } catch {
      // quota exceeded — nothing more we can do synchronously
    }
  },

  async list(): Promise<RecoveryCandidate[]> {
    if (window.electronAPI?.recoveryList) return (await window.electronAPI.recoveryList()) as RecoveryCandidate[];
    const store = ls();
    if (!store) return [];
    const out: RecoveryCandidate[] = [];
    for (const k of Object.keys(store)) {
      if (!k.startsWith(LS_PREFIX)) continue;
      const raw = store.getItem(k) ?? '';
      try {
        const p = JSON.parse(raw) as RecoveryPayload;
        const ok = p && p.format === 'amcs-recovery' && typeof p.project_id === 'string' && Array.isArray(p.dirty_sections);
        out.push(ok ? { file: k, valid: true, size_bytes: raw.length, payload: p } : { file: k, valid: false, size_bytes: raw.length, error: 'invalid recovery data' });
      } catch {
        out.push({ file: k, valid: false, size_bytes: raw.length, error: 'unreadable recovery data' });
      }
    }
    return out.sort((a, b) => (b.payload?.created_at ?? '').localeCompare(a.payload?.created_at ?? ''));
  },

  async remove(file: string): Promise<void> {
    if (window.electronAPI?.recoveryDelete) {
      await window.electronAPI.recoveryDelete(file);
      return;
    }
    ls()?.removeItem(file);
  },

  async clearProject(projectId: string): Promise<void> {
    if (window.electronAPI?.recoveryClearProject) {
      await window.electronAPI.recoveryClearProject(projectId);
      return;
    }
    const store = ls();
    if (!store) return;
    for (const k of Object.keys(store)) if (k.startsWith(`${LS_PREFIX}${projectId}__`)) store.removeItem(k);
  },

  async sessionStatus(): Promise<{ previousRunCrashed: boolean; previousStartedAt: string | null }> {
    if (window.electronAPI?.sessionStatus) return window.electronAPI.sessionStatus();
    return { previousRunCrashed: false, previousStartedAt: null };
  },
};
