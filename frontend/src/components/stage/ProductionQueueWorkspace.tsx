import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clapperboard,
  ExternalLink,
  Eye,
  Film,
  Info,
  ListChecks,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  SkipForward,
  Square,
  Wrench,
  XCircle,
} from 'lucide-react';
import { WorkflowPipelineStepper } from '@/components/common/WorkflowPipelineStepper';
import { msToFrame } from '@/engine/evaluator';
import {
  filterQCIssues,
  filterQueueTasks,
  getValidTaskActions,
  type QueueFilterTab,
} from '@/engine/productionQueueHelpers';
import { useI18n } from '@/i18n/useLocaleStore';
import { useJobStore } from '@/stores/useJobStore';
import { usePlaybackStore } from '@/stores/usePlaybackStore';
import { useProductionQueueStore } from '@/stores/useProductionQueueStore';
import { useProjectStore } from '@/stores/useProjectStore';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';
import type {
  ProductionExecutionMode,
  ProductionQCCategory,
  ProductionQCIssue,
  ProductionQCSeverity,
  ProductionQueueTask,
  ProductionTaskStatus,
} from '@/types/models';

const QC_CATEGORIES: ProductionQCCategory[] = [
  'asset',
  'scene',
  'canvas',
  'animation',
  'camera',
  'audio',
  'subtitle',
  'production',
];

function taskBadgeClass(status: ProductionTaskStatus): string {
  if (status === 'completed') return 'accepted';
  if (status === 'failed' || status === 'cancelled') return 'rejected';
  if (status === 'needs_review' || status === 'skipped') return 'warning';
  if (status === 'processing' || status === 'validating') return 'edited';
  return 'pending';
}

export function ProductionQueueWorkspace() {
  const { t } = useI18n();
  const project = useProjectStore((s) => s.project);
  const isDirty = useProjectStore((s) => s.isDirty);
  const saveProject = useProjectStore((s) => s.saveProject);
  const setActiveSceneId = useProjectStore((s) => s.setActiveSceneId);
  const setActiveShotId = useProjectStore((s) => s.setActiveShotId);
  const setSelectedSubtitleIds = useProjectStore((s) => s.setSelectedSubtitleIds);

  const setCurrentFrame = usePlaybackStore((s) => s.setCurrentFrame);
  const setPlaying = usePlaybackStore((s) => s.setPlaying);
  const switchWorkspace = useWorkspaceStore((s) => s.switchWorkspace);
  const setSidebarTab = useWorkspaceStore((s) => s.setSidebarTab);
  const setCenterMode = useWorkspaceStore((s) => s.setCenterMode);
  const setTimelineCollapsed = useWorkspaceStore((s) => s.setTimelineCollapsed);
  const pushToast = useJobStore((s) => s.pushToast);

  const activeSubTab = useProductionQueueStore((s) => s.activeSubTab);
  const setActiveSubTab = useProductionQueueStore((s) => s.setActiveSubTab);
  const queue = useProductionQueueStore((s) => s.queue);
  const planPreview = useProductionQueueStore((s) => s.planPreview);
  const qcReport = useProductionQueueStore((s) => s.qcReport);
  const selectedMode = useProductionQueueStore((s) => s.selectedMode);
  const setSelectedMode = useProductionQueueStore((s) => s.setSelectedMode);
  const selectedSceneIds = useProductionQueueStore((s) => s.selectedSceneIds);
  const setSelectedSceneIds = useProductionQueueStore((s) => s.setSelectedSceneIds);
  const selectedShotIds = useProductionQueueStore((s) => s.selectedShotIds);
  const setSelectedShotIds = useProductionQueueStore((s) => s.setSelectedShotIds);
  const planning = useProductionQueueStore((s) => s.planning);
  const starting = useProductionQueueStore((s) => s.starting);
  const runningQC = useProductionQueueStore((s) => s.runningQC);
  const fixingIssueId = useProductionQueueStore((s) => s.fixingIssueId);
  const lastError = useProductionQueueStore((s) => s.lastError);

  const refreshQueueAndQC = useProductionQueueStore((s) => s.refreshQueueAndQC);
  const buildPlanPreview = useProductionQueueStore((s) => s.buildPlanPreview);
  const startProduction = useProductionQueueStore((s) => s.startProduction);
  const pauseProduction = useProductionQueueStore((s) => s.pauseProduction);
  const resumeProduction = useProductionQueueStore((s) => s.resumeProduction);
  const cancelProduction = useProductionQueueStore((s) => s.cancelProduction);
  const retryTask = useProductionQueueStore((s) => s.retryTask);
  const skipTask = useProductionQueueStore((s) => s.skipTask);
  const cancelTask = useProductionQueueStore((s) => s.cancelTask);
  const runQC = useProductionQueueStore((s) => s.runQC);
  const fixQCIssue = useProductionQueueStore((s) => s.fixQCIssue);

  // Queue filter & options state
  const [statusFilter, setStatusFilter] = useState<QueueFilterTab>('all');
  const [includeAnim, setIncludeAnim] = useState(true);
  const [includeCam, setIncludeCam] = useState(true);
  const [includeAudioSubs, setIncludeAudioSubs] = useState(true);
  const [runQcAfter, setRunQcAfter] = useState(true);
  const [includeUnapproved, setIncludeUnapproved] = useState(true);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);

  // QC filters
  const [qcSeverity, setQcSeverity] = useState<'all' | ProductionQCSeverity>('all');
  const [qcCategory, setQcCategory] = useState<'all' | ProductionQCCategory>('all');
  const [qcSceneFilter, setQcSceneFilter] = useState<string>('');
  const [qcShotFilter, setQcShotFilter] = useState<string>('');
  const [qcScopeSceneId, setQcScopeSceneId] = useState<string>('');

  useEffect(() => {
    if (project) {
      void refreshQueueAndQC(project.meta.project_id);
    }
  }, [project?.meta.project_id]);

  const effectiveQueue = queue ?? project?.production_queue ?? null;
  const effectiveQC = qcReport ?? project?.qc_report ?? null;

  const planShots = project?.production_plan?.shots ?? [];
  const planSceneOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const sh of planShots) {
      if (!map.has(sh.scene_id)) {
        const dir = project?.director?.scenes.find(
          (d) => d.scene_breakdown_id === sh.scene_id || d.applied_stage_scene_id === sh.scene_id,
        );
        map.set(sh.scene_id, dir ? `S${String(dir.scene_number).padStart(2, '0')} — ${dir.title}` : sh.scene_id);
      }
    }
    return Array.from(map.entries()).map(([id, label]) => ({ id, label }));
  }, [planShots, project?.director?.scenes]);

  const filteredTasks = useMemo(
    () => filterQueueTasks(effectiveQueue?.tasks ?? [], statusFilter),
    [effectiveQueue?.tasks, statusFilter],
  );

  const filteredQCIssues = useMemo(
    () =>
      filterQCIssues(effectiveQC?.issues ?? [], {
        severity: qcSeverity,
        category: qcCategory,
        sceneId: qcSceneFilter || undefined,
        shotId: qcShotFilter || undefined,
      }),
    [effectiveQC?.issues, qcSeverity, qcCategory, qcSceneFilter, qcShotFilter],
  );

  if (!project) {
    return (
      <div className="empty-state" style={{ flex: 1 }}>
        <ListChecks size={36} color="var(--text-muted)" />
        <div>{t('common.noProject')}</div>
      </div>
    );
  }

  const fps = project.timeline.fps;

  const buildRequest = () => ({
    mode: selectedMode,
    scene_ids: selectedMode === 'scene' ? (selectedSceneIds.length ? selectedSceneIds : planSceneOptions[0] ? [planSceneOptions[0].id] : []) : [],
    production_shot_ids:
      selectedMode === 'single_shot'
        ? selectedShotIds.slice(0, 1).length
          ? selectedShotIds.slice(0, 1)
          : planShots[0]
            ? [planShots[0].production_shot_id]
            : []
        : selectedMode === 'selected_shots'
          ? selectedShotIds
          : [],
    include_unapproved: includeUnapproved,
    include_animation: includeAnim,
    include_camera: includeCam,
    include_audio_subtitles: includeAudioSubs,
    run_qc_after: runQcAfter,
    preserve_user_modified: true,
  });

  const handlePreviewPlan = async () => {
    try {
      if (isDirty) await saveProject(false);
      await buildPlanPreview(project.meta.project_id, buildRequest());
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : 'Plan preview failed');
    }
  };

  const handleStartProduction = async () => {
    try {
      if (isDirty) await saveProject(false);
      await startProduction(project.meta.project_id, buildRequest());
      pushToast('success', t('pq.startedToast'));
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : 'Start failed');
    }
  };

  const handleNavigateToTask = (task: ProductionQueueTask, openShot: boolean) => {
    const targetSceneId = task.stage_scene_id || task.scene_id;
    if (targetSceneId && project.scenes.some((s) => s.scene_id === targetSceneId)) {
      setActiveSceneId(targetSceneId);
    }
    if (openShot && task.shot_id) {
      setActiveShotId(task.shot_id);
    }
    if (task.timeline_time_ms !== null && task.timeline_time_ms !== undefined) {
      setPlaying(false);
      setCurrentFrame(msToFrame(task.timeline_time_ms, fps));
    }
    switchWorkspace('animation');
    setTimelineCollapsed(false);
  };

  const handleNavigateToQCIssue = (issue: ProductionQCIssue) => {
    if (issue.scene_id && project.scenes.some((s) => s.scene_id === issue.scene_id)) {
      setActiveSceneId(issue.scene_id);
    }
    if (issue.shot_id) {
      setActiveShotId(issue.shot_id);
    }
    if (issue.time_ms !== null && issue.time_ms !== undefined) {
      setPlaying(false);
      setCurrentFrame(msToFrame(issue.time_ms, fps));
    }
    if (issue.subtitle_id) {
      setSelectedSubtitleIds([issue.subtitle_id], issue.subtitle_id);
    }
    if (issue.nav_target === 'production') {
      switchWorkspace('production');
    } else if (issue.nav_target === 'storyboard') {
      switchWorkspace('storyboard');
    } else if (issue.nav_target === 'subtitles') {
      setSidebarTab('subtitles');
      setCenterMode('subtitles');
    } else if (issue.nav_target === 'assets') {
      switchWorkspace('assets');
    } else if (issue.nav_target === 'characters') {
      switchWorkspace('animation');
      setSidebarTab('characters');
    } else if (issue.nav_target === 'audio') {
      switchWorkspace('audio');
    } else if (issue.nav_target === 'queue') {
      setActiveSubTab('queue');
    } else {
      switchWorkspace('animation');
      setTimelineCollapsed(false);
    }
  };

  const handleFixIssue = async (issue: ProductionQCIssue) => {
    try {
      const msg = await fixQCIssue(project.meta.project_id, issue);
      pushToast('success', msg);
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : 'Fix failed');
    }
  };

  const isRunning = effectiveQueue?.status === 'running';
  const isPaused = effectiveQueue?.status === 'paused';

  return (
    <div className="prod-workspace" data-testid="production-queue-workspace">
      <WorkflowPipelineStepper activeStage={activeSubTab === 'qc' ? 'qc' : 'production_queue'} />

      {/* Top Mode Tabs + Global Controls */}
      <div className="prod-topbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            type="button"
            className={`btn-xs ${activeSubTab === 'queue' ? 'btn-primary' : ''}`}
            onClick={() => setActiveSubTab('queue')}
            data-testid="pq-main-tab-queue"
          >
            <ListChecks size={12} /> {t('pq.tabQueue')} ({effectiveQueue?.tasks.length ?? 0})
          </button>
          <button
            type="button"
            className={`btn-xs ${activeSubTab === 'qc' ? 'btn-primary' : ''}`}
            onClick={() => setActiveSubTab('qc')}
            data-testid="pq-main-tab-qc"
          >
            <ShieldCheck size={12} /> {t('pq.tabQC')}
            {effectiveQC && (
              <span
                className="mono"
                style={{
                  marginLeft: 4,
                  color: effectiveQC.error_count > 0 ? '#fca5a5' : '#86efac',
                }}
              >
                ({effectiveQC.error_count}E/{effectiveQC.warning_count}W)
              </span>
            )}
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {activeSubTab === 'queue' ? (
            <>
              <button
                type="button"
                className="btn-xs"
                disabled={planning || isRunning}
                onClick={() => void handlePreviewPlan()}
                data-testid="pq-preview-plan-btn"
              >
                {planning ? <Loader2 size={11} className="spin" /> : <Eye size={11} />}{' '}
                {t('pq.previewPlanBtn')}
              </button>
              {!isRunning && !isPaused && (
                <button
                  type="button"
                  className="btn-xs btn-primary"
                  disabled={starting || planShots.length === 0}
                  onClick={() => void handleStartProduction()}
                  data-testid="pq-start-btn"
                >
                  {starting ? <Loader2 size={11} className="spin" /> : <Play size={11} />}{' '}
                  {t('pq.startBtn')}
                </button>
              )}
              {isRunning && (
                <button
                  type="button"
                  className="btn-xs"
                  onClick={() => void pauseProduction(project.meta.project_id)}
                  data-testid="pq-pause-btn"
                >
                  <Pause size={11} /> {t('pq.pauseBtn')}
                </button>
              )}
              {isPaused && (
                <button
                  type="button"
                  className="btn-xs btn-primary"
                  onClick={() => void resumeProduction(project.meta.project_id)}
                  data-testid="pq-resume-btn"
                >
                  <Play size={11} /> {t('pq.resumeBtn')}
                </button>
              )}
              {(isRunning || isPaused) && (
                <button
                  type="button"
                  className="btn-xs btn-danger"
                  onClick={() => void cancelProduction(project.meta.project_id)}
                  data-testid="pq-cancel-btn"
                >
                  <Square size={11} /> {t('pq.cancelBtn')}
                </button>
              )}
            </>
          ) : (
            <>
              <select
                value={qcScopeSceneId}
                onChange={(e) => setQcScopeSceneId(e.target.value)}
                style={{ fontSize: 11, maxWidth: 180 }}
                data-testid="qc-scope-scene-select"
              >
                <option value="">{t('qc.allScenesScope')}</option>
                {project.scenes.map((sc) => (
                  <option key={sc.scene_id} value={sc.scene_id}>
                    S{sc.order_index + 1}: {sc.name}
                  </option>
                ))}
              </select>
              {qcScopeSceneId && (
                <button
                  type="button"
                  className="btn-xs"
                  disabled={runningQC}
                  onClick={() => void runQC(project.meta.project_id, [qcScopeSceneId])}
                  data-testid="qc-validate-scene-btn"
                >
                  {t('qc.validateSelectedSceneBtn')}
                </button>
              )}
              <button
                type="button"
                className="btn-xs btn-primary"
                disabled={runningQC}
                onClick={() => void runQC(project.meta.project_id, null)}
                data-testid="qc-validate-project-btn"
              >
                {runningQC ? <Loader2 size={11} className="spin" /> : <ShieldCheck size={11} />}{' '}
                {t('qc.validateProjectBtn')}
              </button>
            </>
          )}
        </div>
      </div>

      {lastError && (
        <div className="director-callout error" style={{ margin: '8px 12px 0', fontSize: 11 }}>
          <AlertCircle size={12} />
          <span>{lastError}</span>
        </div>
      )}

      {/* ==================== TAB 1: PRODUCTION QUEUE ==================== */}
      {activeSubTab === 'queue' ? (
        <div style={{ flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* Execution Mode & Scope Bar */}
          <div className="card" style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)' }}>
                  {t('pq.modeLabel')}:
                </span>
                {(
                  [
                    'single_shot',
                    'selected_shots',
                    'scene',
                    'project',
                    'production_plan',
                  ] as ProductionExecutionMode[]
                ).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={`btn-xs ${selectedMode === mode ? 'btn-primary' : ''}`}
                    onClick={() => setSelectedMode(mode)}
                    data-testid={`pq-mode-${mode}`}
                  >
                    {t(`pq.mode.${mode}`)}
                  </button>
                ))}
              </div>
            </div>

            {/* Scope Picker for Mode A / B / C */}
            {selectedMode === 'single_shot' && planShots.length > 0 && (
              <div className="field-row">
                <label className="field-label">{t('pq.selectShotLabel')}</label>
                <select
                  data-testid="pq-single-shot-select"
                  value={selectedShotIds[0] ?? planShots[0]?.production_shot_id ?? ''}
                  onChange={(e) => setSelectedShotIds([e.target.value])}
                >
                  {planShots.map((sh) => (
                    <option key={sh.production_shot_id} value={sh.production_shot_id}>
                      Shot #{sh.shot_order} — {sh.title} ({sh.readiness_status})
                    </option>
                  ))}
                </select>
              </div>
            )}

            {selectedMode === 'selected_shots' && planShots.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                {planShots.map((sh) => {
                  const checked = selectedShotIds.includes(sh.production_shot_id);
                  return (
                    <label
                      key={sh.production_shot_id}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                        fontSize: 11,
                        padding: '3px 7px',
                        borderRadius: 4,
                        background: checked ? 'rgba(99,102,241,0.18)' : 'var(--surface-base)',
                        border: checked ? '1px solid var(--accent)' : '1px solid var(--border-subtle)',
                        cursor: 'pointer',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setSelectedShotIds(
                            checked
                              ? selectedShotIds.filter((id) => id !== sh.production_shot_id)
                              : [...selectedShotIds, sh.production_shot_id],
                          )
                        }
                      />
                      #{sh.shot_order} {sh.title}
                    </label>
                  );
                })}
              </div>
            )}

            {selectedMode === 'scene' && planSceneOptions.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                {planSceneOptions.map((sc) => {
                  const checked = selectedSceneIds.includes(sc.id);
                  return (
                    <label
                      key={sc.id}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                        fontSize: 11,
                        padding: '3px 7px',
                        borderRadius: 4,
                        background: checked ? 'rgba(99,102,241,0.18)' : 'var(--surface-base)',
                        border: checked ? '1px solid var(--accent)' : '1px solid var(--border-subtle)',
                        cursor: 'pointer',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setSelectedSceneIds(
                            checked
                              ? selectedSceneIds.filter((id) => id !== sc.id)
                              : [...selectedSceneIds, sc.id],
                          )
                        }
                      />
                      {sc.label}
                    </label>
                  );
                })}
              </div>
            )}

            {/* Execution Pipeline Options */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: 11, color: 'var(--text-secondary)' }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <input type="checkbox" checked={includeAnim} onChange={(e) => setIncludeAnim(e.target.checked)} />
                {t('pq.optAnimation')}
              </label>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <input type="checkbox" checked={includeCam} onChange={(e) => setIncludeCam(e.target.checked)} />
                {t('pq.optCamera')}
              </label>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <input
                  type="checkbox"
                  checked={includeAudioSubs}
                  onChange={(e) => setIncludeAudioSubs(e.target.checked)}
                />
                {t('pq.optAudioSubtitles')}
              </label>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <input type="checkbox" checked={runQcAfter} onChange={(e) => setRunQcAfter(e.target.checked)} />
                {t('pq.optRunQCAfter')}
              </label>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <input
                  type="checkbox"
                  checked={includeUnapproved}
                  onChange={(e) => setIncludeUnapproved(e.target.checked)}
                />
                {t('pq.optIncludeUnapproved')}
              </label>
            </div>
          </div>

          {/* Pre-Execution DAG Plan Preview */}
          {planPreview && (
            <div
              className="card"
              data-testid="pq-plan-preview-box"
              style={{
                padding: 10,
                border: '1px solid var(--accent)',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <strong style={{ fontSize: 12 }}>
                  {t('pq.planPreviewTitle', {
                    tasks: planPreview.total_tasks,
                    shots: planPreview.total_shots,
                    scenes: planPreview.total_scenes,
                  })}
                </strong>
                <button
                  type="button"
                  className="btn-xs btn-primary"
                  disabled={!planPreview.can_start || starting}
                  onClick={() => void handleStartProduction()}
                  data-testid="pq-confirm-start-btn"
                >
                  <Play size={11} /> {t('pq.confirmStartBtn')}
                </button>
              </div>
              {planPreview.blocking_errors.map((err, i) => (
                <div key={i} className="director-callout error" style={{ fontSize: 11 }}>
                  <XCircle size={12} /> <span>{err}</span>
                </div>
              ))}
              {planPreview.warnings.map((w, i) => (
                <div key={i} className="director-callout warning" style={{ fontSize: 11 }}>
                  <AlertTriangle size={12} /> <span>{w}</span>
                </div>
              ))}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 160, overflowY: 'auto' }}>
                {planPreview.tasks.map((tk) => (
                  <div
                    key={tk.task_id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      fontSize: 11,
                      padding: '4px 7px',
                      borderRadius: 4,
                      background: 'var(--surface-base)',
                    }}
                  >
                    <span>{tk.task_name}</span>
                    <span className="mono" style={{ fontSize: 9.5, color: 'var(--text-muted)' }}>
                      {tk.depends_on_task_ids.length > 0
                        ? `${t('pq.depsCount', { count: tk.depends_on_task_ids.length })}`
                        : t('pq.noDeps')}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Status Filter Bar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
            {(
              ['all', 'queued', 'processing', 'completed', 'failed', 'needs_review'] as QueueFilterTab[]
            ).map((ft) => (
              <button
                key={ft}
                type="button"
                className={`btn-xs ${statusFilter === ft ? 'btn-primary' : ''}`}
                onClick={() => setStatusFilter(ft)}
                data-testid={`pq-filter-${ft}`}
              >
                {t(`pq.filter.${ft}`)}
              </button>
            ))}
          </div>

          {/* Real Production Queue Task List */}
          {filteredTasks.length === 0 ? (
            <div className="empty-state" style={{ padding: 28 }}>
              <ListChecks size={30} color="var(--text-muted)" />
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {effectiveQueue?.tasks.length
                  ? t('pq.noTasksMatchingFilter')
                  : t('pq.emptyQueueHint')}
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="pq-task-list">
              {filteredTasks.map((task) => {
                const actions = getValidTaskActions(task);
                const isExpanded = expandedTaskId === task.task_id;
                return (
                  <div
                    key={task.task_id}
                    data-testid={`pq-task-card-${task.task_id}`}
                    data-task-status={task.status}
                    className="card"
                    style={{
                      padding: '8px 10px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 5,
                      borderColor:
                        task.status === 'failed'
                          ? 'rgba(239,68,68,0.45)'
                          : task.status === 'needs_review'
                            ? 'rgba(245,158,11,0.45)'
                            : undefined,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1 }}>
                        <span className={`director-badge ${taskBadgeClass(task.status)}`}>
                          {t(`pq.state.${task.status}`)}
                        </span>
                        <span className="badge mono" style={{ fontSize: 9.5 }}>
                          {t(`pq.taskType.${task.task_type}`)}
                        </span>
                        {task.scene_number > 0 && (
                          <span className="mono" style={{ fontSize: 10, color: 'var(--accent-text)' }}>
                            S{String(task.scene_number).padStart(2, '0')}
                            {task.shot_number > 0 ? `/#${task.shot_number}` : ''}
                          </span>
                        )}
                        <strong
                          style={{
                            fontSize: 11.5,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {task.task_name}
                        </strong>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                        {task.retry_count > 0 && (
                          <span className="badge mono" style={{ fontSize: 9 }}>
                            ×{task.retry_count}
                          </span>
                        )}
                        {actions.canRetry && (
                          <button
                            type="button"
                            className="btn-xs btn-primary"
                            disabled={isRunning}
                            onClick={() => void retryTask(project.meta.project_id, task.task_id)}
                            data-testid={`pq-retry-${task.task_id}`}
                          >
                            <RotateCcw size={10} /> {t('pq.retryBtn')}
                          </button>
                        )}
                        {actions.canSkip && (
                          <button
                            type="button"
                            className="btn-xs"
                            onClick={() => void skipTask(project.meta.project_id, task.task_id)}
                            data-testid={`pq-skip-${task.task_id}`}
                          >
                            <SkipForward size={10} /> {t('pq.skipBtn')}
                          </button>
                        )}
                        {actions.canCancel && (
                          <button
                            type="button"
                            className="btn-xs btn-danger"
                            onClick={() => void cancelTask(project.meta.project_id, task.task_id)}
                            data-testid={`pq-cancel-task-${task.task_id}`}
                          >
                            <XCircle size={10} /> {t('common.cancel')}
                          </button>
                        )}
                        {actions.canOpenScene && (
                          <button
                            type="button"
                            className="btn-xs"
                            onClick={() => handleNavigateToTask(task, false)}
                            title={t('pq.openSceneBtn')}
                          >
                            <Clapperboard size={10} />
                          </button>
                        )}
                        {actions.canOpenShot && (
                          <button
                            type="button"
                            className="btn-xs"
                            onClick={() => handleNavigateToTask(task, true)}
                            title={t('pq.openShotBtn')}
                          >
                            <Film size={10} />
                          </button>
                        )}
                        {actions.canInspectError && (
                          <button
                            type="button"
                            className="btn-xs"
                            onClick={() => setExpandedTaskId(isExpanded ? null : task.task_id)}
                            data-testid={`pq-inspect-${task.task_id}`}
                          >
                            {isExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                            {t('pq.inspectErrorBtn')}
                          </button>
                        )}
                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 10.5, color: 'var(--text-secondary)' }}>
                      <span>{task.message || '—'}</span>
                      <span className="mono" style={{ fontSize: 9.5, color: 'var(--text-muted)' }}>
                        {task.depends_on_task_ids.length > 0 &&
                          `${t('pq.depsCount', { count: task.depends_on_task_ids.length })} • `}
                        {Math.round(task.progress_pct)}%
                        {task.completed_at ? ` • ${task.completed_at.slice(11, 19)}` : ''}
                      </span>
                    </div>

                    {isExpanded && (
                      <div
                        style={{
                          padding: 7,
                          borderRadius: 4,
                          background: 'var(--surface-base)',
                          border: '1px solid var(--border-subtle)',
                          fontSize: 10.5,
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 4,
                        }}
                      >
                        {task.error_details && (
                          <div style={{ color: '#fca5a5' }}>
                            <strong>{t('pq.errorLabel')}:</strong> {task.error_details}
                          </div>
                        )}
                        {task.blocked_by_task_ids.length > 0 && (
                          <div style={{ color: '#fcd34d' }}>
                            <strong>{t('pq.blockedByLabel')}:</strong> {task.blocked_by_task_ids.join(', ')}
                          </div>
                        )}
                        {task.warnings.length > 0 && (
                          <ul style={{ margin: 0, paddingLeft: 16, color: 'var(--text-secondary)' }}>
                            {task.warnings.map((w, idx) => (
                              <li key={idx}>{w}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        /* ==================== TAB 2: 8-CATEGORY QUALITY CONTROL ==================== */
        <div
          style={{ flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}
          data-testid="qc-panel-workspace"
        >
          {/* KPI Cards */}
          {effectiveQC && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8 }}>
              <div className="card" style={{ padding: 9, textAlign: 'center' }} data-testid="qc-kpi-errors">
                <div className="mono" style={{ fontSize: 18, fontWeight: 700, color: 'var(--danger)' }}>
                  {effectiveQC.error_count}
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--text-secondary)' }}>{t('qc.totalErrors')}</div>
              </div>
              <div className="card" style={{ padding: 9, textAlign: 'center' }} data-testid="qc-kpi-warnings">
                <div className="mono" style={{ fontSize: 18, fontWeight: 700, color: 'var(--warning)' }}>
                  {effectiveQC.warning_count}
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--text-secondary)' }}>{t('qc.totalWarnings')}</div>
              </div>
              <div className="card" style={{ padding: 9, textAlign: 'center' }} data-testid="qc-kpi-info">
                <div className="mono" style={{ fontSize: 18, fontWeight: 700, color: '#38bdf8' }}>
                  {effectiveQC.info_count}
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--text-secondary)' }}>{t('qc.totalInfo')}</div>
              </div>
              <div className="card" style={{ padding: 9, textAlign: 'center' }} data-testid="qc-kpi-passed">
                <div className="mono" style={{ fontSize: 18, fontWeight: 700, color: 'var(--success)' }}>
                  {effectiveQC.passed_checks}
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--text-secondary)' }}>{t('qc.passedChecks')}</div>
              </div>
              <div className="card" style={{ padding: 9, textAlign: 'center' }} data-testid="qc-kpi-readiness">
                <div
                  className="mono"
                  style={{
                    fontSize: 18,
                    fontWeight: 700,
                    color: effectiveQC.production_ready ? 'var(--success)' : 'var(--danger)',
                  }}
                >
                  {effectiveQC.readiness_score}%
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--text-secondary)' }}>
                  {effectiveQC.production_ready ? t('qc.readyBadge') : t('qc.blockedBadge')}
                </div>
              </div>
            </div>
          )}

          {/* Filters: Severity, Category (8), Scene, Shot */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            {(['all', 'error', 'warning', 'info'] as const).map((sev) => (
              <button
                key={sev}
                type="button"
                className={`btn-xs ${qcSeverity === sev ? 'btn-primary' : ''}`}
                onClick={() => setQcSeverity(sev)}
                data-testid={`qc-filter-sev-${sev}`}
              >
                {t(`qc.sev.${sev}`)}
              </button>
            ))}

            <select
              value={qcCategory}
              onChange={(e) => setQcCategory(e.target.value as 'all' | ProductionQCCategory)}
              style={{ fontSize: 11 }}
              data-testid="qc-filter-category"
            >
              <option value="all">{t('qc.allCategories')}</option>
              {QC_CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>
                  {t(`qc.cat.${cat}`)}
                </option>
              ))}
            </select>

            <select
              value={qcSceneFilter}
              onChange={(e) => {
                setQcSceneFilter(e.target.value);
                setQcShotFilter('');
              }}
              style={{ fontSize: 11 }}
              data-testid="qc-filter-scene"
            >
              <option value="">{t('qc.allScenesScope')}</option>
              {project.scenes.map((sc) => (
                <option key={sc.scene_id} value={sc.scene_id}>
                  S{sc.order_index + 1}: {sc.name}
                </option>
              ))}
            </select>
          </div>

          {/* Issue List */}
          {filteredQCIssues.length === 0 ? (
            <div className="empty-state" style={{ padding: 28 }} data-testid="qc-empty-clean">
              <CheckCircle2 size={32} color="var(--success)" />
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>{t('qc.noIssuesTitle')}</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{t('qc.noIssuesDesc')}</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="qc-issue-list">
              {filteredQCIssues.map((iss) => (
                <div
                  key={iss.issue_id}
                  data-testid={`qc-issue-${iss.code}`}
                  className="card"
                  style={{
                    padding: '9px 10px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 5,
                    borderLeft: `3px solid ${
                      iss.severity === 'error'
                        ? 'var(--danger)'
                        : iss.severity === 'warning'
                          ? 'var(--warning)'
                          : '#38bdf8'
                    }`,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      {iss.severity === 'error' ? (
                        <ShieldAlert size={13} color="var(--danger)" />
                      ) : iss.severity === 'warning' ? (
                        <AlertTriangle size={13} color="var(--warning)" />
                      ) : (
                        <Info size={13} color="#38bdf8" />
                      )}
                      <span
                        className={`director-badge ${
                          iss.severity === 'error'
                            ? 'rejected'
                            : iss.severity === 'warning'
                              ? 'warning'
                              : 'pending'
                        }`}
                      >
                        {t(`qc.sev.${iss.severity}`)}
                      </span>
                      <span className="badge mono" style={{ fontSize: 9.5 }}>
                        {t(`qc.cat.${iss.category}`)}
                      </span>
                      <strong style={{ fontSize: 11.5 }}>{iss.title}</strong>
                      {iss.scene_number && (
                        <span className="mono" style={{ fontSize: 10, color: 'var(--accent-text)' }}>
                          S{String(iss.scene_number).padStart(2, '0')}
                          {iss.shot_number ? `/#${iss.shot_number}` : ''}
                        </span>
                      )}
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
                      {iss.fix_action && (
                        <button
                          type="button"
                          className="btn-xs btn-primary"
                          disabled={fixingIssueId === iss.issue_id}
                          onClick={() => void handleFixIssue(iss)}
                          data-testid={`qc-fix-${iss.code}`}
                        >
                          {fixingIssueId === iss.issue_id ? (
                            <Loader2 size={10} className="spin" />
                          ) : (
                            <Wrench size={10} />
                          )}
                          {t('qc.fixBtn')}
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn-xs"
                        onClick={() => handleNavigateToQCIssue(iss)}
                        data-testid={`qc-nav-${iss.code}`}
                      >
                        <ExternalLink size={10} /> {t('qc.goToSourceBtn')}
                      </button>
                    </div>
                  </div>

                  <div style={{ fontSize: 11, color: 'var(--text-primary)' }}>{iss.description}</div>
                  {(iss.root_cause || iss.recommended_action) && (
                    <div style={{ fontSize: 10, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 2 }}>
                      {iss.root_cause && (
                        <span>
                          <strong>{t('qc.rootCauseLabel')}:</strong> {iss.root_cause}
                        </span>
                      )}
                      {iss.recommended_action && (
                        <span>
                          <strong>{t('qc.recommendedLabel')}:</strong> {iss.recommended_action}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
