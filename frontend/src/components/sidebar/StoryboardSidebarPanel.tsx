import { useEffect, useMemo } from 'react';
import {
  AlertTriangle,
  Clapperboard,
  Clock,
  Cpu,
  LayoutGrid,
  Loader2,
  Lock,
  Play,
  RefreshCw,
  Settings,
  ShieldAlert,
  Square,
} from 'lucide-react';
import { useI18n } from '@/i18n/useLocaleStore';
import { apiClient } from '@/services/apiClient';
import { useDirectorStore } from '@/stores/useDirectorStore';
import { useJobStore } from '@/stores/useJobStore';
import { useProjectStore } from '@/stores/useProjectStore';
import { useStoryboardStore } from '@/stores/useStoryboardStore';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';

export function StoryboardSidebarPanel({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useI18n();
  const project = useProjectStore((s) => s.project);
  const isDirty = useProjectStore((s) => s.isDirty);
  const saveProject = useProjectStore((s) => s.saveProject);
  const setStoryboardDocument = useProjectStore((s) => s.setStoryboardDocument);
  const reconcileSceneDurationToStoryboard = useProjectStore(
    (s) => s.reconcileSceneDurationToStoryboard,
  );

  const aiConfig = useDirectorStore((s) => s.config);
  const providers = useDirectorStore((s) => s.providers);
  const refreshProviders = useDirectorStore((s) => s.refreshProviders);

  const approvedScenes = useStoryboardStore((s) => s.approvedScenes);
  const activeSceneId = useStoryboardStore((s) => s.activeSceneId);
  const generating = useStoryboardStore((s) => s.generating);
  const progress = useStoryboardStore((s) => s.progress);
  const lastError = useStoryboardStore((s) => s.lastError);
  const showContinuityDrawer = useStoryboardStore((s) => s.showContinuityDrawer);

  const refreshApprovedScenes = useStoryboardStore((s) => s.refreshApprovedScenes);
  const setActiveSceneId = useStoryboardStore((s) => s.setActiveSceneId);
  const setSelectedShotId = useStoryboardStore((s) => s.setSelectedShotId);
  const setShowContinuityDrawer = useStoryboardStore((s) => s.setShowContinuityDrawer);
  const generateAll = useStoryboardStore((s) => s.generateAll);
  const cancelGeneration = useStoryboardStore((s) => s.cancelGeneration);

  const switchWorkspace = useWorkspaceStore((s) => s.switchWorkspace);
  const pushToast = useJobStore((s) => s.pushToast);

  useEffect(() => {
    void refreshProviders();
  }, [refreshProviders]);

  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    const syncAndLoad = async () => {
      if (isDirty) {
        await saveProject(false).catch(() => {});
      }
      if (!cancelled) {
        await refreshApprovedScenes(project.meta.project_id);
      }
    };
    void syncAndLoad();
    return () => {
      cancelled = true;
    };
  }, [
    project?.meta.project_id,
    project?.director?.updated_at,
    project?.scenes.length,
    project?.storyboard?.shots.length,
  ]);

  const storyboardOverride = aiConfig?.feature_models?.storyboard;
  const effectiveProviderId = storyboardOverride?.provider_id || aiConfig?.provider_id || 'openai';
  const effectiveModelName = storyboardOverride?.model || aiConfig?.model || '—';
  const activeProviderMeta = useMemo(
    () => providers.find((p) => p.provider_id === effectiveProviderId),
    [providers, effectiveProviderId],
  );

  const storyboard = project?.storyboard ?? null;
  const activeWarnings = useMemo(
    () => (storyboard?.continuity_warnings ?? []).filter((w) => !w.dismissed),
    [storyboard?.continuity_warnings],
  );

  if (!project) {
    return (
      <div className="empty-state" style={{ padding: 16 }}>
        <LayoutGrid size={24} color="var(--text-muted)" />
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t('common.noProject')}</div>
      </div>
    );
  }

  const handleGenerateAll = async (force: boolean) => {
    if (generating) return;
    try {
      if (isDirty) {
        await saveProject(false);
      }
      const doc = await generateAll(project.meta.project_id, {
        force,
        strategy: 'preserve_locked',
      });
      setStoryboardDocument(doc);
      pushToast(
        'success',
        t('storyboard.generatedAllToast', {
          shots: doc.shots.length,
          warnings: doc.continuity_warnings.filter((w) => !w.dismissed).length,
        }),
      );
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : t('storyboard.generationFailed'));
    }
  };

  const handleContinuityCheck = async () => {
    try {
      if (isDirty) {
        await saveProject(false);
      }
      const res = await apiClient.runStoryboardContinuityCheck(project.meta.project_id);
      if (storyboard) {
        setStoryboardDocument({ ...storyboard, continuity_warnings: res.warnings });
      }
      setShowContinuityDrawer(true);
      pushToast(
        'info',
        t('storyboard.continuityCheckDoneToast', {
          shots: res.total_shots_checked,
          count: res.warnings.filter((w) => !w.dismissed).length,
        }),
      );
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : 'Continuity check failed');
    }
  };

  const activeSceneSummary = approvedScenes.find((s) => s.scene_id === activeSceneId) ?? approvedScenes[0];
  const activeSceneShots = useMemo(
    () =>
      activeSceneSummary
        ? (storyboard?.shots ?? []).filter((sh) => sh.scene_id === activeSceneSummary.scene_id)
        : [],
    [storyboard?.shots, activeSceneSummary],
  );
  const activeSceneTotalMs = activeSceneShots.reduce((acc, s) => acc + s.duration_ms, 0);

  return (
    <div className="director-sidebar" data-testid="storyboard-sidebar-panel">
      {/* AI Provider Status */}
      <div className="inspector-section" style={{ paddingBottom: 8 }}>
        <div className="inspector-section-title">
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <Cpu size={12} color="var(--accent-text)" /> {t('director.providerStatusTitle')}
          </span>
          <button type="button" className="btn-xs" onClick={onOpenSettings}>
            <Settings size={11} /> {t('director.configureAi')}
          </button>
        </div>
        <div className="director-provider-pill">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
            <strong style={{ fontSize: 11 }}>{effectiveProviderId}</strong>
            <span className={`director-badge ${activeProviderMeta?.is_configured ? 'accepted' : 'warning'}`}>
              {activeProviderMeta?.is_configured
                ? t('director.providerReady')
                : t('director.providerNotConfigured')}
            </span>
          </div>
          <div className="mono" style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 2 }}>
            {effectiveModelName}
          </div>
        </div>
      </div>

      {/* Storyboard Generation Controls */}
      <div className="inspector-section">
        <div className="inspector-section-title">
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <Clapperboard size={12} color="var(--accent-text)" /> {t('storyboard.generateSectionTitle')}
          </span>
          <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
            {storyboard?.shots.length ?? 0} {t('storyboard.shotsShort')}
          </span>
        </div>

        <div style={{ display: 'flex', gap: 6 }}>
          {!generating ? (
            <>
              <button
                type="button"
                className="btn-primary"
                style={{ flex: 1 }}
                disabled={approvedScenes.length === 0}
                onClick={() => void handleGenerateAll(false)}
                data-testid="storyboard-generate-all-btn"
              >
                <Play size={12} /> {t('storyboard.generateAllBtn')}
              </button>
              {storyboard && storyboard.shots.length > 0 && (
                <button
                  type="button"
                  title={t('storyboard.forceRegeneratePreserveLockedTip')}
                  onClick={() => void handleGenerateAll(true)}
                  data-testid="storyboard-force-all-btn"
                >
                  <RefreshCw size={12} />
                </button>
              )}
            </>
          ) : (
            <button
              type="button"
              className="btn-danger"
              style={{ flex: 1 }}
              onClick={() => void cancelGeneration(project.meta.project_id)}
              data-testid="storyboard-cancel-btn"
            >
              <Square size={11} /> {t('storyboard.cancelGenerationBtn')}
            </button>
          )}
        </div>

        {/* Continuity check consolidated into StoryboardWorkspace top bar (eliminating duplicate buttons) */}
        {generating && progress && (
          <div className="director-progress-box" data-testid="storyboard-progress-box">
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <Loader2 size={11} className="spin" /> {progress.stage || 'running'}
              </span>
              <span className="mono">
                {progress.current_scene}/{progress.total_scenes} • {Math.round(progress.progress_pct)}%
              </span>
            </div>
            <div className="director-progress-bar">
              <div
                className="director-progress-fill"
                style={{ width: `${Math.max(4, Math.min(100, progress.progress_pct))}%` }}
              />
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{progress.message}</div>
          </div>
        )}

        {lastError && (
          <div className="director-callout error" style={{ marginTop: 6 }} data-testid="storyboard-error-banner">
            <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: 1 }} />
            <span style={{ fontSize: 11 }}>{lastError}</span>
          </div>
        )}
      </div>

      {/* Approved Scenes List */}
      <div className="inspector-section" style={{ flex: 1 }}>
        <div className="inspector-section-title">
          <span>{t('storyboard.approvedScenesTitle', { count: approvedScenes.length })}</span>
          <button
            type="button"
            className="btn-xs"
            onClick={() => void refreshApprovedScenes(project.meta.project_id)}
            title={t('common.refresh')}
          >
            <RefreshCw size={10} />
          </button>
        </div>

        {approvedScenes.length === 0 ? (
          <div className="director-callout warning" style={{ flexDirection: 'column', gap: 6 }}>
            <span>{t('storyboard.noApprovedScenesHint')}</span>
            <button
              type="button"
              className="btn-xs btn-primary"
              onClick={() => switchWorkspace('director')}
            >
              {t('storyboard.openAiDirectorBtn')}
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {approvedScenes.map((sc) => {
              const isSelected = activeSceneSummary?.scene_id === sc.scene_id;
              const liveShots = (storyboard?.shots ?? []).filter((sh) => sh.scene_id === sc.scene_id);
              const liveDur = liveShots.reduce((acc, sh) => acc + sh.duration_ms, 0);
              const liveLocked = liveShots.filter((sh) => sh.locked).length;
              const sceneWarns = activeWarnings.filter((w) => w.scene_id === sc.scene_id).length;

              return (
                <button
                  key={sc.scene_id}
                  type="button"
                  data-testid={`storyboard-scene-row-${sc.scene_number}`}
                  className={`director-list-item sb-scene-btn ${isSelected ? 'active' : ''}`}
                  onClick={() => {
                    setActiveSceneId(sc.scene_id);
                    const firstShot = liveShots[0]?.shot_id ?? null;
                    setSelectedShotId(firstShot);
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, width: '100%' }}>
                    <span className="mono" style={{ fontSize: 10, color: 'var(--accent-text)', fontWeight: 700 }}>
                      S{String(sc.scene_number).padStart(2, '0')}
                    </span>
                    <strong
                      style={{
                        flex: 1,
                        fontSize: 11,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {sc.title}
                    </strong>
                    <span className="director-badge pending">{liveShots.length}</span>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      fontSize: 10,
                      color: 'var(--text-secondary)',
                      marginTop: 3,
                    }}
                  >
                    <span className="mono">
                      {(liveDur / 1000).toFixed(1)}s / {(sc.target_duration_ms / 1000).toFixed(1)}s
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      {liveLocked > 0 && (
                        <span className="director-badge edited">
                          <Lock size={9} /> {liveLocked}
                        </span>
                      )}
                      {sceneWarns > 0 && (
                        <span className="director-badge warning">
                          <AlertTriangle size={9} /> {sceneWarns}
                        </span>
                      )}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {/* Reconcile Scene Duration Control */}
        {activeSceneSummary && activeSceneShots.length > 0 && activeSceneSummary.stage_scene_id && (
          <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--border-subtle)' }}>
            <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 5 }}>
              <Clock size={10} style={{ display: 'inline', marginRight: 4 }} />
              {t('storyboard.durationReconcileHint', {
                shots: (activeSceneTotalMs / 1000).toFixed(1),
                scene: (activeSceneSummary.target_duration_ms / 1000).toFixed(1),
              })}
            </div>
            <button
              type="button"
              className="btn-xs"
              style={{ width: '100%' }}
              data-testid="storyboard-reconcile-duration-btn"
              onClick={() => {
                const res = reconcileSceneDurationToStoryboard(activeSceneSummary.scene_id);
                if (res.updated) {
                  pushToast(
                    'success',
                    t('storyboard.reconciledDurationToast', {
                      seconds: (res.newDurationMs / 1000).toFixed(1),
                    }),
                  );
                }
              }}
            >
              <Clock size={11} /> {t('storyboard.syncSceneDurationBtn')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
