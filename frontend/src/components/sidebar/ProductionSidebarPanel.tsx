import { useEffect, useMemo } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  Cpu,
  ListChecks,
  Loader2,
  Lock,
  Play,
  RefreshCw,
  Settings,
  ShieldCheck,
  Square,
} from 'lucide-react';
import { useI18n } from '@/i18n/useLocaleStore';
import { useDirectorStore } from '@/stores/useDirectorStore';
import { useJobStore } from '@/stores/useJobStore';
import { useProductionStore } from '@/stores/useProductionStore';
import { useProjectStore } from '@/stores/useProjectStore';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';

export function ProductionSidebarPanel({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useI18n();
  const project = useProjectStore((s) => s.project);
  const isDirty = useProjectStore((s) => s.isDirty);
  const saveProject = useProjectStore((s) => s.saveProject);
  const setProductionPlanDocument = useProjectStore((s) => s.setProductionPlanDocument);

  const aiConfig = useDirectorStore((s) => s.config);
  const providers = useDirectorStore((s) => s.providers);
  const refreshProviders = useDirectorStore((s) => s.refreshProviders);

  const generating = useProductionStore((s) => s.generating);
  const refreshingReadiness = useProductionStore((s) => s.refreshingReadiness);
  const progress = useProductionStore((s) => s.progress);
  const lastError = useProductionStore((s) => s.lastError);
  const activeSceneId = useProductionStore((s) => s.activeSceneId);
  const setActiveSceneId = useProductionStore((s) => s.setActiveSceneId);
  const setSelectedProductionShotId = useProductionStore((s) => s.setSelectedProductionShotId);
  const generateAll = useProductionStore((s) => s.generateAll);
  const refreshReadiness = useProductionStore((s) => s.refreshReadiness);
  const cancelGeneration = useProductionStore((s) => s.cancelGeneration);

  const switchWorkspace = useWorkspaceStore((s) => s.switchWorkspace);
  const pushToast = useJobStore((s) => s.pushToast);

  useEffect(() => {
    void refreshProviders();
  }, [refreshProviders]);

  const prodOverride = aiConfig?.feature_models?.production_plan;
  const effectiveProviderId = prodOverride?.provider_id || aiConfig?.provider_id || 'openai';
  const effectiveModelName = prodOverride?.model || aiConfig?.model || '—';
  const activeProviderMeta = useMemo(
    () => providers.find((p) => p.provider_id === effectiveProviderId),
    [providers, effectiveProviderId],
  );

  const planDoc = project?.production_plan ?? null;
  const storyboardShots = project?.storyboard?.shots ?? [];

  // Build ordered scene groups from Production Plan (or fall back to Storyboard scenes)
  const sceneGroups = useMemo(() => {
    const map = new Map<
      string,
      {
        sceneId: string;
        title: string;
        sceneNumber: number;
        totalShots: number;
        readyCount: number;
        approvedCount: number;
        lockedCount: number;
        appliedCount: number;
      }
    >();

    const directorScenes = project?.director?.scenes ?? [];
    const stageScenes = project?.scenes ?? [];
    const lookupTitle = (sid: string, idx: number) => {
      const dir = directorScenes.find(
        (s) => s.scene_breakdown_id === sid || s.applied_stage_scene_id === sid,
      );
      if (dir) return { title: dir.title, num: dir.scene_number };
      const stg = stageScenes.find((s) => s.scene_id === sid);
      if (stg) return { title: stg.name, num: stg.order_index + 1 };
      return { title: `Scene ${idx + 1}`, num: idx + 1 };
    };

    const sourceShots = planDoc?.shots ?? [];
    for (const sh of sourceShots) {
      let g = map.get(sh.scene_id);
      if (!g) {
        const meta = lookupTitle(sh.scene_id, map.size);
        g = {
          sceneId: sh.scene_id,
          title: meta.title,
          sceneNumber: meta.num,
          totalShots: 0,
          readyCount: 0,
          approvedCount: 0,
          lockedCount: 0,
          appliedCount: 0,
        };
        map.set(sh.scene_id, g);
      }
      g.totalShots += 1;
      if (sh.readiness_status === 'ready') g.readyCount += 1;
      if (sh.approval_status === 'approved') g.approvedCount += 1;
      if (sh.locked) g.lockedCount += 1;
      if (sh.timeline_refs.applied) g.appliedCount += 1;
    }

    return Array.from(map.values()).sort((a, b) => a.sceneNumber - b.sceneNumber);
  }, [planDoc?.shots, project?.director?.scenes, project?.scenes]);

  const kpis = useMemo(() => {
    const shots = planDoc?.shots ?? [];
    const ready = shots.filter((s) => s.readiness_status === 'ready').length;
    const approved = shots.filter((s) => s.approval_status === 'approved').length;
    const applied = shots.filter((s) => s.timeline_refs.applied).length;
    return {
      total: shots.length,
      ready,
      needsWork: shots.length - ready,
      approved,
      applied,
    };
  }, [planDoc?.shots]);

  if (!project) {
    return (
      <div className="empty-state" style={{ padding: 16 }}>
        <ClipboardCheck size={24} color="var(--text-muted)" />
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t('common.noProject')}</div>
      </div>
    );
  }

  const handleGenerate = async (force: boolean) => {
    if (generating) return;
    try {
      if (isDirty) {
        await saveProject(false);
      }
      const doc = await generateAll(project.meta.project_id, {
        force,
        preserve_locked: true,
      });
      setProductionPlanDocument(doc);
      const readyN = doc.shots.filter((s) => s.readiness_status === 'ready').length;
      pushToast(
        'success',
        t('production.generatedToast', {
          shots: doc.shots.length,
          ready: readyN,
        }),
      );
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : t('production.generationFailed'));
    }
  };

  const handleRefreshReadiness = async () => {
    if (!planDoc || refreshingReadiness) return;
    try {
      if (isDirty) {
        await saveProject(false);
      }
      const doc = await refreshReadiness(project.meta.project_id);
      setProductionPlanDocument(doc);
      const readyN = doc.shots.filter((s) => s.readiness_status === 'ready').length;
      pushToast(
        'info',
        t('production.readinessRefreshedToast', { ready: readyN, total: doc.shots.length }),
      );
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : 'Readiness refresh failed');
    }
  };

  return (
    <div className="director-sidebar" data-testid="production-sidebar-panel">
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

      {/* Production Plan Generation Controls */}
      <div className="inspector-section">
        <div className="inspector-section-title">
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <ClipboardCheck size={12} color="var(--accent-text)" /> {t('production.generateSectionTitle')}
          </span>
          <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
            {kpis.total} {t('storyboard.shotsShort')}
          </span>
        </div>

        <div style={{ display: 'flex', gap: 6 }}>
          {!generating ? (
            <>
              <button
                type="button"
                className="btn-primary"
                style={{ flex: 1 }}
                disabled={storyboardShots.length === 0}
                onClick={() => void handleGenerate(false)}
                data-testid="production-generate-btn"
              >
                <Play size={12} /> {t('production.generateBtn')}
              </button>
              {kpis.total > 0 && (
                <button
                  type="button"
                  title={t('production.forceRegenerateTip')}
                  onClick={() => void handleGenerate(true)}
                  data-testid="production-force-generate-btn"
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
              data-testid="production-cancel-btn"
            >
              <Square size={11} /> {t('production.cancelBtn')}
            </button>
          )}
        </div>

        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <button
            type="button"
            className="btn-xs"
            style={{ flex: 1 }}
            disabled={!planDoc || kpis.total === 0 || refreshingReadiness}
            onClick={() => void handleRefreshReadiness()}
            data-testid="production-refresh-readiness-btn"
          >
            {refreshingReadiness ? <Loader2 size={11} className="spin" /> : <ShieldCheck size={11} />}
            {t('production.refreshReadinessBtn')}
          </button>
        </div>

        {generating && progress && (
          <div className="director-progress-box" data-testid="production-progress-box">
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
          <div className="director-callout error" style={{ marginTop: 6 }} data-testid="production-error-banner">
            <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: 1 }} />
            <span style={{ fontSize: 11 }}>{lastError}</span>
          </div>
        )}
      </div>

      {/* Readiness Summary & Apply CTA */}
      {kpis.total > 0 && (
        <div className="inspector-section" style={{ paddingBottom: 10 }}>
          <div className="prod-sidebar-kpis">
            <div className="prod-sidebar-kpi">
              <span className="mono" style={{ fontWeight: 700, color: 'var(--success)' }}>
                {kpis.ready}
              </span>
              <span>{t('production.kpiReady')}</span>
            </div>
            <div className="prod-sidebar-kpi">
              <span
                className="mono"
                style={{ fontWeight: 700, color: kpis.needsWork > 0 ? 'var(--warning)' : 'var(--text-muted)' }}
              >
                {kpis.needsWork}
              </span>
              <span>{t('production.kpiNeedsWork')}</span>
            </div>
            <div className="prod-sidebar-kpi">
              <span className="mono" style={{ fontWeight: 700, color: 'var(--accent-text)' }}>
                {kpis.approved}
              </span>
              <span>{t('production.kpiApproved')}</span>
            </div>
            <div className="prod-sidebar-kpi">
              <span className="mono" style={{ fontWeight: 700, color: '#38bdf8' }}>
                {kpis.applied}
              </span>
              <span>{t('production.kpiApplied')}</span>
            </div>
          </div>

          {/* Single clear next-step CTA — removed 3 duplicate Assembly/Animation/Timeline buttons already in ProductionWorkspace header */}
          <button
            type="button"
            className="btn-primary"
            style={{ width: '100%', marginTop: 8 }}
            onClick={() => switchWorkspace('production_queue')}
            data-testid="production-open-queue-btn"
          >
            <ListChecks size={13} /> {t('pipeline.nextProductionQueue')}
          </button>
        </div>
      )}

      {/* Scene List */}
      <div className="inspector-section" style={{ flex: 1 }}>
        <div className="inspector-section-title">
          <span>{t('production.scenesListTitle', { count: sceneGroups.length })}</span>
        </div>

        {storyboardShots.length === 0 ? (
          <div className="director-callout warning" style={{ flexDirection: 'column', gap: 6 }}>
            <span>{t('production.noStoryboardHint')}</span>
            <button
              type="button"
              className="btn-xs btn-primary"
              onClick={() => switchWorkspace('storyboard')}
            >
              {t('production.openStoryboardBtn')}
            </button>
          </div>
        ) : sceneGroups.length === 0 ? (
          <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.45 }}>
            {t('production.readyToGenerateHint', { count: storyboardShots.length })}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {sceneGroups.map((g) => {
              const isSelected = (activeSceneId ?? sceneGroups[0]?.sceneId) === g.sceneId;
              return (
                <button
                  key={g.sceneId}
                  type="button"
                  data-testid={`production-scene-row-${g.sceneNumber}`}
                  className={`director-list-item sb-scene-btn ${isSelected ? 'active' : ''}`}
                  onClick={() => {
                    setActiveSceneId(g.sceneId);
                    const first = (planDoc?.shots ?? []).find((s) => s.scene_id === g.sceneId);
                    setSelectedProductionShotId(first?.production_shot_id ?? null);
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, width: '100%' }}>
                    <span className="mono" style={{ fontSize: 10, color: 'var(--accent-text)', fontWeight: 700 }}>
                      S{String(g.sceneNumber).padStart(2, '0')}
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
                      {g.title}
                    </strong>
                    <span className="director-badge pending">{g.totalShots}</span>
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
                      {g.readyCount}/{g.totalShots} {t('production.readyShort')}
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      {g.lockedCount > 0 && (
                        <span className="director-badge edited">
                          <Lock size={9} /> {g.lockedCount}
                        </span>
                      )}
                      {g.appliedCount > 0 && (
                        <span className="director-badge accepted">
                          <CheckCircle2 size={9} /> {g.appliedCount}
                        </span>
                      )}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
