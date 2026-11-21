import { Download } from 'lucide-react';
import { useI18n } from '@/i18n/useLocaleStore';
import { useJobStore } from '@/stores/useJobStore';
import { useProjectStore } from '@/stores/useProjectStore';
import { EmptyState } from '@/components/common/CommonUI';
import { RenderQueueList } from '@/components/common/RenderQueueList';

export function RenderQueuePanel({ onOpenExport }: { onOpenExport: () => void }) {
  const { t } = useI18n();
  const project = useProjectStore((s) => s.project);
  const jobs = useJobStore((s) => s.jobs);

  if (!project) {
    return <EmptyState title={t('stage.noProjectTitle')} description={t('stage.noProjectDesc')} />;
  }

  return (
    <>
      <button className="btn-primary" onClick={onOpenExport} data-testid="render-queue-new-export">
        <Download size={13} /> {t('renderQueue.newExport')}
      </button>
      {jobs.length === 0 ? (
        <EmptyState title={t('renderQueue.emptyTitle')} description={t('renderQueue.emptyDesc')} />
      ) : (
        <RenderQueueList jobs={jobs} />
      )}
    </>
  );
}
