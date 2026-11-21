import { X } from 'lucide-react';
import { useI18n } from '@/i18n/useLocaleStore';
import { useJobStore } from '@/stores/useJobStore';
import { RenderQueueList } from '@/components/common/RenderQueueList';

export function JobQueueDrawer() {
  const { t } = useI18n();
  const open = useJobStore((s) => s.drawerOpen);
  const setDrawerOpen = useJobStore((s) => s.setDrawerOpen);
  const jobs = useJobStore((s) => s.jobs);

  if (!open) return null;

  return (
    <div
      style={{
        position: 'fixed',
        right: 12,
        bottom: 32,
        width: 460,
        maxHeight: '60vh',
        background: 'var(--surface-panel)',
        border: '1px solid var(--border-strong)',
        borderRadius: 8,
        boxShadow: 'var(--shadow-lg)',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 90,
        overflow: 'hidden',
      }}
      data-testid="job-queue-drawer"
    >
      <div className="modal-header" style={{ padding: '8px 12px' }}>
        <span>{t('renderQueue.drawerTitle', { count: jobs.length })}</span>
        <button className="btn-ghost btn-icon" onClick={() => setDrawerOpen(false)} aria-label={t('common.close')}>
          <X size={13} />
        </button>
      </div>
      <div style={{ padding: 10, overflowY: 'auto' }}>
        {jobs.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 14 }}>{t('renderQueue.emptyTitle')}</div>
        ) : (
          <RenderQueueList jobs={jobs} compact />
        )}
      </div>
    </div>
  );
}
