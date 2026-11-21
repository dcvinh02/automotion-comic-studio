import { useEffect, useMemo } from 'react';
import {
  CheckCircle2,
  ListChecks,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Square,
} from 'lucide-react';
import { computeQueueSummary } from '@/engine/productionQueueHelpers';
import { useI18n } from '@/i18n/useLocaleStore';
import { useJobStore } from '@/stores/useJobStore';
import { useProductionQueueStore } from '@/stores/useProductionQueueStore';
import { useProjectStore } from '@/stores/useProjectStore';

export function ProductionQueueSidebarPanel() {
  const { t } = useI18n();
  const project = useProjectStore((s) => s.project);
  const isDirty = useProjectStore((s) => s.isDirty);
  const saveProject = useProjectStore((s) => s.saveProject);

  const activeSubTab = useProductionQueueStore((s) => s.activeSubTab);
  const setActiveSubTab = useProductionQueueStore((s) => s.setActiveSubTab);
  const queue = useProductionQueueStore((s) => s.queue);
  const qcReport = useProductionQueueStore((s) => s.qcReport);
  const loadingQueue = useProductionQueueStore((s) => s.loadingQueue);
  const runningQC = useProductionQueueStore((s) => s.runningQC);
  const refreshQueueAndQC = useProductionQueueStore((s) => s.refreshQueueAndQC);
  const pauseProduction = useProductionQueueStore((s) => s.pauseProduction);
  const resumeProduction = useProductionQueueStore((s) => s.resumeProduction);
  const cancelProduction = useProductionQueueStore((s) => s.cancelProduction);
  const runQC = useProductionQueueStore((s) => s.runQC);
  const pushToast = useJobStore((s) => s.pushToast);

  useEffect(() => {
    if (project) {
      void refreshQueueAndQC(project.meta.project_id);
    }
  }, [project?.meta.project_id]);

  const effectiveQueue = queue ?? project?.production_queue ?? null;
  const effectiveQC = qcReport ?? project?.qc_report ?? null;
  const summary = useMemo(
    () => computeQueueSummary(effectiveQueue?.tasks ?? []),
    [effectiveQueue?.tasks],
  );

  if (!project) {
    return (
      <div className="empty-state" style={{ padding: 16 }}>
        <ListChecks size={24} color="var(--text-muted)" />
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t('common.noProject')}</div>
      </div>
    );
  }

  const handleRunQC = async () => {
    try {
      if (isDirty) await saveProject(false);
      const rep = await runQC(project.meta.project_id);
      setActiveSubTab('qc');
      pushToast(
        rep.error_count === 0 ? 'success' : 'warning',
        t('qc.completedToast', {
          errors: rep.error_count,
          warnings: rep.warning_count,
          score: rep.readiness_score,
        }),
      );
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : 'QC failed');
    }
  };

  return (
    <div className="director-sidebar" data-testid="production-queue-sidebar">
      {/* Sub-view Switcher */}
      <div className="inspector-section" style={{ paddingBottom: 8 }}>
        <div style={{ display: 'flex', gap: 5 }}>
          <button
            type="button"
            className={`btn-xs ${activeSubTab === 'queue' ? 'btn-primary' : ''}`}
            style={{ flex: 1, justifyContent: 'center' }}
            onClick={() => setActiveSubTab('queue')}
            data-testid="pq-sidebar-tab-queue"
          >
            <ListChecks size={11} /> {t('pq.tabQueue')}
          </button>
          <button
            type="button"
            className={`btn-xs ${activeSubTab === 'qc' ? 'btn-primary' : ''}`}
            style={{ flex: 1, justifyContent: 'center' }}
            onClick={() => setActiveSubTab('qc')}
            data-testid="pq-sidebar-tab-qc"
          >
            <ShieldCheck size={11} /> {t('pq.tabQC')}
          </button>
        </div>
      </div>

      {/* Queue Overview Card */}
      <div className="inspector-section">
        <div className="inspector-section-title">
          <span>{t('pq.queueStatusTitle')}</span>
          <button
            type="button"
            className="btn-ghost btn-icon btn-xs"
            disabled={loadingQueue}
            onClick={() => void refreshQueueAndQC(project.meta.project_id)}
            title={t('common.refresh')}
          >
            <RefreshCw size={11} className={loadingQueue ? 'spin' : ''} />
          </button>
        </div>

        <div className="card" style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 11, fontWeight: 600 }}>
              {t(`pq.runStatus.${effectiveQueue?.status ?? 'idle'}`)}
            </span>
            <span className="mono" style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent-text)' }}>
              {summary.pct}% ({summary.settled}/{summary.total})
            </span>
          </div>
          <div className="director-progress-bar">
            <div className="director-progress-fill" style={{ width: `${summary.pct}%` }} />
          </div>
          <div className="prod-sidebar-kpis" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            <div className="prod-sidebar-kpi">
              <span className="mono" style={{ fontWeight: 700, color: 'var(--success)' }}>
                {summary.counts.completed}
              </span>
              <span>{t('pq.state.completed')}</span>
            </div>
            <div className="prod-sidebar-kpi">
              <span className="mono" style={{ fontWeight: 700, color: 'var(--danger)' }}>
                {summary.counts.failed}
              </span>
              <span>{t('pq.state.failed')}</span>
            </div>
            <div className="prod-sidebar-kpi">
              <span className="mono" style={{ fontWeight: 700, color: 'var(--warning)' }}>
                {summary.counts.needs_review}
              </span>
              <span>{t('pq.state.needs_review')}</span>
            </div>
          </div>

          {effectiveQueue?.status === 'running' && (
            <div style={{ display: 'flex', gap: 5 }}>
              <button
                type="button"
                className="btn-xs"
                style={{ flex: 1, justifyContent: 'center' }}
                onClick={() => void pauseProduction(project.meta.project_id)}
              >
                <Pause size={10} /> {t('pq.pauseBtn')}
              </button>
              <button
                type="button"
                className="btn-xs btn-danger"
                style={{ flex: 1, justifyContent: 'center' }}
                onClick={() => void cancelProduction(project.meta.project_id)}
              >
                <Square size={10} /> {t('pq.cancelBtn')}
              </button>
            </div>
          )}

          {effectiveQueue?.status === 'paused' && (
            <div style={{ display: 'flex', gap: 5 }}>
              <button
                type="button"
                className="btn-xs btn-primary"
                style={{ flex: 1, justifyContent: 'center' }}
                onClick={() => void resumeProduction(project.meta.project_id)}
              >
                <Play size={10} /> {t('pq.resumeBtn')}
              </button>
              <button
                type="button"
                className="btn-xs btn-danger"
                style={{ flex: 1, justifyContent: 'center' }}
                onClick={() => void cancelProduction(project.meta.project_id)}
              >
                <Square size={10} /> {t('pq.cancelBtn')}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* QC Overview Card */}
      <div className="inspector-section">
        <div className="inspector-section-title">
          <span>{t('qc.summaryTitle')}</span>
          {effectiveQC && (
            <span className={`director-badge ${effectiveQC.production_ready ? 'accepted' : 'rejected'}`}>
              {effectiveQC.production_ready ? t('qc.readyBadge') : t('qc.blockedBadge')}
            </span>
          )}
        </div>

        <div className="card" style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {effectiveQC ? (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{t('qc.readinessScore')}</span>
                <span
                  className="mono"
                  style={{
                    fontSize: 14,
                    fontWeight: 700,
                    color: effectiveQC.error_count === 0 ? 'var(--success)' : 'var(--danger)',
                  }}
                >
                  {effectiveQC.readiness_score}%
                </span>
              </div>
              <div className="prod-sidebar-kpis">
                <div className="prod-sidebar-kpi">
                  <span className="mono" style={{ fontWeight: 700, color: 'var(--danger)' }}>
                    {effectiveQC.error_count}
                  </span>
                  <span>{t('qc.errors')}</span>
                </div>
                <div className="prod-sidebar-kpi">
                  <span className="mono" style={{ fontWeight: 700, color: 'var(--warning)' }}>
                    {effectiveQC.warning_count}
                  </span>
                  <span>{t('qc.warnings')}</span>
                </div>
                <div className="prod-sidebar-kpi">
                  <span className="mono" style={{ fontWeight: 700, color: '#38bdf8' }}>
                    {effectiveQC.info_count}
                  </span>
                  <span>{t('qc.info')}</span>
                </div>
                <div className="prod-sidebar-kpi">
                  <span className="mono" style={{ fontWeight: 700, color: 'var(--success)' }}>
                    {effectiveQC.passed_checks}
                  </span>
                  <span>{t('qc.passed')}</span>
                </div>
              </div>
            </>
          ) : (
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t('qc.notRunYet')}</div>
          )}

          <button
            type="button"
            className="btn-primary btn-xs"
            style={{ width: '100%', justifyContent: 'center' }}
            disabled={runningQC}
            onClick={() => void handleRunQC()}
            data-testid="qc-sidebar-run-btn"
          >
            {runningQC ? (
              <Loader2 size={11} className="spin" />
            ) : effectiveQC?.error_count ? (
              <ShieldAlert size={11} />
            ) : (
              <CheckCircle2 size={11} />
            )}
            {t('qc.validateProjectBtn')}
          </button>
        </div>
      </div>
    </div>
  );
}
