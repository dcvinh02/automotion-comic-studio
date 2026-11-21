import { Activity, Layers, PanelBottom, PanelRight } from 'lucide-react';
import { useI18n } from '@/i18n/useLocaleStore';
import { useJobStore } from '@/stores/useJobStore';
import { useProjectStore } from '@/stores/useProjectStore';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';
import { StatusBadge } from '@/components/ui/StatusBadge';

export function StatusBar() {
  const { t } = useI18n();
  const health = useJobStore((s) => s.health);
  const backendConnected = useJobStore((s) => s.backendConnected);
  const pixiConnected = useJobStore((s) => s.pixiWorkerConnected);
  const jobs = useJobStore((s) => s.jobs);
  const drawerOpen = useJobStore((s) => s.drawerOpen);
  const setDrawerOpen = useJobStore((s) => s.setDrawerOpen);

  const selection = useProjectStore((s) => s.selection);
  const workspace = useWorkspaceStore((s) => s.workspace);
  const rightCollapsed = useWorkspaceStore((s) => s.rightCollapsed);
  const timelineCollapsed = useWorkspaceStore((s) => s.timelineCollapsed);
  const setRightCollapsed = useWorkspaceStore((s) => s.setRightCollapsed);
  const setTimelineCollapsed = useWorkspaceStore((s) => s.setTimelineCollapsed);

  const runningJob = jobs.find((j) => j.status === 'running' || j.status === 'pending');

  return (
    <footer className="status-bar" role="contentinfo">
      <div className="toolbar-group" style={{ gap: 7 }}>
        <StatusBadge
          tone={backendConnected ? 'ok' : 'err'}
          label={
            backendConnected
              ? t('status.apiOk', { ver: health?.python_version ?? '' })
              : t('status.apiOffline')
          }
          title={backendConnected ? health?.workspace_dir : t('status.apiOffline')}
        />
        <StatusBadge
          tone={health?.ffmpeg.available ? 'ok' : 'warn'}
          label={
            health?.ffmpeg.available
              ? t('status.ffmpegOk', { enc: health.ffmpeg.recommended_h264_encoder })
              : t('status.ffmpegMissing')
          }
          title={health?.ffmpeg.version ?? t('status.ffmpegMissing')}
        />
        <StatusBadge
          tone={pixiConnected ? 'ok' : 'neutral'}
          label={pixiConnected ? t('status.webglWorker') : t('status.softwareFallback')}
        />
      </div>

      <div className="toolbar-group" style={{ gap: 8 }}>
        <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
          <Layers size={10} style={{ verticalAlign: 'middle', marginRight: 4 }} />
          {t(`workspace.${workspace}`).toUpperCase()} •{' '}
          {(selection.type === 'none'
            ? t('common.none')
            : t(`app.selectionType.${selection.type}`)
          ).toUpperCase()}
        </span>

        <button
          type="button"
          className={`btn-ghost btn-xs ${!timelineCollapsed ? 'active' : ''}`}
          title={t('timeline.collapse')}
          onClick={() => setTimelineCollapsed(!timelineCollapsed)}
        >
          <PanelBottom size={11} /> {t('status.timelineBtn')}
        </button>

        <button
          type="button"
          className={`btn-ghost btn-xs ${!rightCollapsed ? 'active' : ''}`}
          title={t('panel.collapseRight')}
          onClick={() => setRightCollapsed(!rightCollapsed)}
        >
          <PanelRight size={11} /> {t('status.inspectorBtn')}
        </button>

        <button
          type="button"
          className={`btn-ghost btn-xs ${drawerOpen || runningJob ? 'active' : ''}`}
          onClick={() => setDrawerOpen(!drawerOpen)}
          title={t('nav.renderQueueTip')}
        >
          <Activity size={11} />
          {runningJob
            ? t('status.exportingPct', { pct: runningJob.progress_pct.toFixed(0) })
            : t('status.jobsBtn', { count: jobs.length })}
        </button>
      </div>
    </footer>
  );
}
