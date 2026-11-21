import { Pause, Play } from 'lucide-react';
import { useI18n } from '@/i18n/useLocaleStore';
import { apiClient } from '@/services/apiClient';
import { useJobStore } from '@/stores/useJobStore';
import { ACTIVE_JOB_STATUSES, WAITING_JOB_STATUSES, type RenderJob } from '@/types/models';
import { RenderJobCard } from './RenderJobCard';

/** Render Queue grouped as Active → Waiting (queue order) → Export History. */
export function RenderQueueList({ jobs, compact = false }: { jobs: RenderJob[]; compact?: boolean }) {
  const { t } = useI18n();
  const queueState = useJobStore((s) => s.queueState);
  const setQueueState = useJobStore((s) => s.setQueueState);
  const pushToast = useJobStore((s) => s.pushToast);
  const requestExportModal = useJobStore((s) => s.requestExportModal);

  const active = jobs.filter((j) => ACTIVE_JOB_STATUSES.includes(j.status));
  const waiting = jobs
    .filter((j) => WAITING_JOB_STATUSES.includes(j.status) || j.status === 'paused')
    .sort((a, b) => (a.queue_position ?? 0) - (b.queue_position ?? 0) || a.created_at.localeCompare(b.created_at));
  const history = jobs.filter((j) => ['completed', 'failed', 'cancelled'].includes(j.status));
  const queuedCount = jobs.filter((j) => WAITING_JOB_STATUSES.includes(j.status)).length;
  const running = Boolean(queueState?.running);

  const toggleQueue = async () => {
    try {
      setQueueState(running ? await apiClient.stopRenderQueue() : await apiClient.startRenderQueue());
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : String(err));
    }
  };

  const section = (title: string, list: RenderJob[]) =>
    list.length > 0 && (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
          {title} ({list.length})
        </div>
        {list.map((job) => (
          <RenderJobCard key={job.job_id} job={job} compact={compact} onReexport={(s) => requestExportModal(s)} />
        ))}
      </div>
    );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="list-card" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
        <span style={{ fontSize: 11 }} data-testid="render-queue-state">
          {active.length > 0
            ? t('rq.queueRendering', { count: queuedCount })
            : running
              ? t('rq.queueIdle')
              : queuedCount > 0
                ? t('rq.queuePaused', { count: queuedCount })
                : t('rq.queueIdle')}
        </span>
        {(queuedCount > 0 || active.length > 0) && (
          <button className={running ? 'btn-xs' : 'btn-primary btn-xs'} onClick={() => void toggleQueue()} title={running ? t('rq.stopQueueHint') : undefined} data-testid="render-queue-toggle">
            {running ? <Pause size={10} /> : <Play size={10} />} {running ? t('rq.stopQueue') : t('rq.startQueue')}
          </button>
        )}
      </div>
      {section(t('rq.active'), active)}
      {section(t('rq.waiting'), waiting)}
      {section(t('rq.history'), history)}
    </div>
  );
}
