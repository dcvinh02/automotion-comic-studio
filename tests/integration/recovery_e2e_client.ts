/**
 * Phase 09.3 crash-recovery E2E client (driven by test_phase09_3_recovery_e2e.py).
 * Runs the REAL editor store (useProjectStore), REAL recovery logic and the REAL Electron-main
 * RecoveryStore in Node against a REAL backend process.
 *
 *   node client.cjs <phase> <baseUrl> <token> <recoveryDir> <projectId> [otherProjectId]
 */
import { RecoveryStore } from '../../frontend/electron/recoveryStore';

const [, , phase, baseUrl, token, recoveryDir, projectId, otherProjectId] = process.argv;
const store = new RecoveryStore(recoveryDir);
const mem = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  setTimeout,
  clearTimeout,
  localStorage: {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
    key: () => null,
    length: 0,
  },
  electronAPI: {
    getBackendConfig: async () => ({ baseUrl, wsUrl: baseUrl.replace('http', 'ws'), token, port: 0 }),
    recoveryWrite: async (p: never) => store.write(p),
    recoveryList: async () => store.list(),
    recoveryDelete: async (f: string) => store.delete(f),
    recoveryClearProject: async (id: string) => store.clearProject(id),
    sessionStatus: async () => session,
  },
};
let session = { previousRunCrashed: false, previousStartedAt: null as string | null };

const out = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);
const unhandled: string[] = [];
process.on('unhandledRejection', (err) => {
  unhandled.push(err instanceof Error ? `${err.message} ${err.stack?.split('\n').slice(0, 12).join(' | ')}` : String(err));
});
const waitLine = () => new Promise<string>((res) => process.stdin.once('data', (d) => res(String(d).trim())));

async function main() {
  session = store.beginSession();
  const { useProjectStore } = await import('../../frontend/src/stores/useProjectStore');
  const { apiClient } = await import('../../frontend/src/services/apiClient');
  const { applyRecoveredSections } = await import('../../frontend/src/engine/recoveryJournal');
  const { recoveryClient } = await import('../../frontend/src/services/recoveryClient');
  const S = () => useProjectStore.getState();

  if (phase === 'session') {
    // Test A + B + C(part 1): autosave, unsaved detection, then a crash while unsaved.
    await S().openProject(projectId);
    const scene = S().project!.scenes[0];
    S().updateScene(scene.scene_id, { name: 'Cảnh đã autosave' });
    out({ step: 'dirty_after_edit', isDirty: S().isDirty });
    await S().saveProject(false); // what the 2.2 s autosave timer calls
    out({ step: 'autosaved', isDirty: S().isDirty, saveError: S().saveError });

    S().addSubtitleSegment({ text: 'Lời thoại chưa kịp lưu', start_ms: 100, end_ms: 900 });
    out({ step: 'unsaved_detected', isDirty: S().isDirty });
    out({ step: 'ready_for_backend_crash' });
    await waitLine(); // python SIGKILLs the backend now
    let failed = false;
    try {
      await S().saveProject(false);
    } catch {
      failed = true;
    }
    await new Promise((r) => setTimeout(r, 300)); // journal write is fire-and-forget after a failure
    out({ step: 'save_after_backend_crash', unhandled, failed, saveError: Boolean(S().saveError), isDirty: S().isDirty, recoveryFiles: store.list().length });
    out({ step: 'ready_for_app_crash' });
    setInterval(() => {}, 1000); // python SIGKILLs this "app" process (no clean shutdown)
    return;
  }

  if (phase === 'restart') {
    // Test C(part 2) + D + E: restart, detect, validate, recover, verify.
    const candidates = await recoveryClient.list();
    const valid = candidates.filter((c) => c.valid);
    out({
      step: 'startup',
      previousRunCrashed: session.previousRunCrashed,
      valid: valid.map((c) => ({ project: c.payload!.project_id, sections: c.payload!.dirty_sections, at: c.payload!.created_at })),
      invalid: candidates.filter((c) => !c.valid).map((c) => ({ file: c.file, error: c.error })),
    });
    const mine = valid.find((c) => c.payload!.project_id === projectId)!;
    // exactly what RecoveryDialog "Recover" does:
    const saved = await apiClient.getProject(projectId);
    const applied = applyRecoveredSections(saved, mine.payload!);
    await apiClient.createBackup(projectId, 'pre_recovery');
    await S().openProject(projectId);
    S().applyRecoveredState(applied.state);
    await S().saveProject(false);
    const after = await apiClient.getProject(projectId);
    const remaining = (await recoveryClient.list()).filter((c) => c.valid && c.payload!.project_id === projectId).length;
    const other = otherProjectId ? (await recoveryClient.list()).filter((c) => c.valid && c.payload!.project_id === otherProjectId).length : -1;
    out({
      step: 'recovered',
      newerOnServer: applied.newerOnServer,
      sceneName: after.scenes[0].name,
      subtitles: after.subtitles?.segments.map((s) => s.text),
      remainingForProject: remaining,
      otherProjectCandidates: other,
      backups: (await apiClient.listBackups(projectId)).map((b) => b.tag),
    });
    store.endSession();
    process.exit(0);
  }
}

main().catch((err) => {
  out({ step: 'error', message: err instanceof Error ? `${err.message}\n${err.stack}` : String(err) });
  process.exit(1);
});
