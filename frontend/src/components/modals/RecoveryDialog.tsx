import { useEffect, useState } from 'react';
import { AlertTriangle, FolderOpen, LifeBuoy, Save, Trash2, X } from 'lucide-react';
import { useI18n } from '@/i18n/useLocaleStore';
import { apiClient } from '@/services/apiClient';
import { recoveryClient, type RecoveryCandidate } from '@/services/recoveryClient';
import { applyRecoveredSections } from '@/engine/recoveryJournal';
import { useJobStore } from '@/stores/useJobStore';
import { useProjectStore } from '@/stores/useProjectStore';

/**
 * Phase 09.3 — Startup recovery. Recovery data is never applied automatically: the original
 * project stays unchanged until the user chooses Recover (after a `pre_recovery` backup) or
 * Save as new project.
 */
export function RecoveryDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const pushToast = useJobStore((s) => s.pushToast);
  const projects = useProjectStore((s) => s.projects);
  const [candidates, setCandidates] = useState<RecoveryCandidate[] | null>(null);
  const [crashed, setCrashed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = async () => {
    const [list, status] = await Promise.all([recoveryClient.list(), recoveryClient.sessionStatus()]);
    setCandidates(list);
    setCrashed(status.previousRunCrashed);
    if (list.length === 0) onClose();
  };

  useEffect(() => {
    void reload();
  }, []);

  if (!candidates || candidates.length === 0) return null;

  const projectName = (c: RecoveryCandidate) => c.payload?.project_name ?? c.file;
  const exists = (c: RecoveryCandidate) => projects.some((p) => p.project_id === c.payload?.project_id && p.health !== 'damaged');

  const run = async (c: RecoveryCandidate, fn: () => Promise<void>) => {
    setBusy(c.file);
    try {
      await fn();
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const recoverInto = (c: RecoveryCandidate) =>
    run(c, async () => {
      const p = c.payload!;
      const saved = await apiClient.getProject(p.project_id);
      const applied = applyRecoveredSections(saved, p);
      if (applied.newerOnServer.length > 0 && !window.confirm(t('recovery.newerWarning', { sections: applied.newerOnServer.join(', ') }))) return;
      await apiClient.createBackup(p.project_id, 'pre_recovery');
      await useProjectStore.getState().openProject(p.project_id);
      useProjectStore.getState().applyRecoveredState(applied.state);
      pushToast('success', t('recovery.recovered', { name: p.project_name }));
      onClose(); // recovery file is removed automatically once the recovered state is saved
    });

  const saveAsNew = (c: RecoveryCandidate) =>
    run(c, async () => {
      const p = c.payload!;
      const saved = await apiClient.getProject(p.project_id);
      const { state } = applyRecoveredSections(saved, p);
      const created = await apiClient.duplicateProject(p.project_id, `${p.project_name} (${t('recovery.suffix')})`, state);
      await recoveryClient.remove(c.file);
      await useProjectStore.getState().loadProjectList();
      await useProjectStore.getState().openProject(created.meta.project_id);
      pushToast('success', t('recovery.savedAsNew', { name: created.meta.name }));
      await reload();
    });

  const openOriginal = (c: RecoveryCandidate) =>
    run(c, async () => {
      await useProjectStore.getState().openProject(c.payload!.project_id);
      onClose();
    });

  const discard = (c: RecoveryCandidate) =>
    run(c, async () => {
      if (!window.confirm(t('recovery.discardConfirm', { name: projectName(c) }))) return;
      await recoveryClient.remove(c.file);
      await reload();
    });

  return (
    <div className="modal-backdrop">
      <div className="modal-box" style={{ width: 'min(680px, 94vw)' }} data-testid="recovery-dialog">
        <div className="modal-header">
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <LifeBuoy size={14} /> {t('recovery.title')}
          </span>
          <button className="btn-ghost btn-icon" onClick={onClose} aria-label={t('recovery.later')} title={t('recovery.later')}>
            <X size={14} />
          </button>
        </div>
        <div className="modal-body" style={{ overflowY: 'auto' }}>
          {crashed && (
            <div className="error-banner" style={{ fontSize: 11 }}>
              <AlertTriangle size={12} /> {t('recovery.crashed')}
            </div>
          )}
          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{t('recovery.explain')}</div>
          {candidates.map((c) => (
            <div key={c.file} className="list-card" data-testid="recovery-candidate">
              {c.valid && c.payload ? (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <strong>{projectName(c)}</strong>
                    <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                      {new Date(c.payload.created_at).toLocaleString()}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                    {t('recovery.contains', { sections: c.payload.dirty_sections.map((s) => t(`recovery.section_${s}`)).join(', ') })}
                  </div>
                  {!exists(c) && <div style={{ fontSize: 11, color: 'var(--warning-text)' }}>{t('recovery.projectMissing')}</div>}
                  <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                    <button className="btn-primary btn-xs" disabled={busy !== null || !exists(c)} onClick={() => void recoverInto(c)} data-testid="recovery-recover">
                      <LifeBuoy size={10} /> {t('recovery.recover')}
                    </button>
                    <button className="btn-xs" disabled={busy !== null || !exists(c)} onClick={() => void saveAsNew(c)}>
                      <Save size={10} /> {t('recovery.saveAsNew')}
                    </button>
                    <button className="btn-xs" disabled={busy !== null || !exists(c)} onClick={() => void openOriginal(c)}>
                      <FolderOpen size={10} /> {t('recovery.openOriginal')}
                    </button>
                    <button className="btn-danger btn-xs" disabled={busy !== null} onClick={() => void discard(c)}>
                      <Trash2 size={10} /> {t('recovery.discard')}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontSize: 11 }}>
                    <AlertTriangle size={11} color="var(--warning-text)" /> {t('recovery.invalid', { file: c.file })}
                  </div>
                  <div className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>{c.error}</div>
                  <div>
                    <button className="btn-xs" disabled={busy !== null} onClick={() => void discard(c)}>
                      <Trash2 size={10} /> {t('recovery.discard')}
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{t('recovery.originalSafe')}</div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose}>{t('recovery.later')}</button>
        </div>
      </div>
    </div>
  );
}
