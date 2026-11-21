import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Brain,
  Camera,
  Captions,
  Check,
  CheckCircle2,
  ChevronRight,
  Clapperboard,
  ClipboardCheck,
  FileText,
  Image as ImageIcon,
  Layers,
  LayoutGrid,
  Loader2,
  Lock,
  Music,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Unlock,
  Users,
  XCircle,
} from 'lucide-react';
import { WorkflowPipelineStepper } from '@/components/common/WorkflowPipelineStepper';
import { isSoundLicenseSafe } from '@/engine/productionEngine';
import { useI18n } from '@/i18n/useLocaleStore';
import { useAnimationExecStore } from '@/stores/useAnimationExecStore';
import { useJobStore } from '@/stores/useJobStore';
import { useLibraryStore } from '@/stores/useLibraryStore';
import { useProductionStore } from '@/stores/useProductionStore';
import { useProjectStore } from '@/stores/useProjectStore';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';
import type {
  AnimationActionCategory,
  CameraMovement,
  ProductionReadinessStatus,
  ProductionShotPlan,
} from '@/types/models';

const ANIMATION_CATEGORIES: AnimationActionCategory[] = [
  'idle',
  'stand',
  'walk',
  'run',
  'blink',
  'talk',
  'wave',
  'look',
  'turn',
  'jump',
  'react',
  'sit',
  'fall',
  'attack',
  'custom',
];

const CAMERA_MOVEMENTS: CameraMovement[] = [
  'static',
  'pan_left',
  'pan_right',
  'tilt_up',
  'tilt_down',
  'zoom_in',
  'zoom_out',
  'dolly_in',
  'dolly_out',
  'tracking',
  'camera_follow',
  'shake',
  'parallax',
];

function readinessBadgeClass(status: ProductionReadinessStatus): string {
  if (status === 'ready') return 'accepted';
  if (status === 'unsupported' || status === 'needs_character' || status === 'needs_rig') {
    return 'rejected';
  }
  return 'warning';
}

function assetClassBadge(cls: string): string {
  if (cls === 'existing_compatible') return 'accepted';
  if (cls === 'existing_potentially_compatible' || cls === 'requires_review') return 'warning';
  return 'rejected';
}

export function ProductionWorkspace({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useI18n();
  const project = useProjectStore((s) => s.project);
  const isDirty = useProjectStore((s) => s.isDirty);
  const saveProject = useProjectStore((s) => s.saveProject);
  const setProductionPlanDocument = useProjectStore((s) => s.setProductionPlanDocument);
  const replaceProductionShotPlan = useProjectStore((s) => s.replaceProductionShotPlan);
  const toggleLockProductionShot = useProjectStore((s) => s.toggleLockProductionShot);
  const setProductionShotApproval = useProjectStore((s) => s.setProductionShotApproval);
  const approveSceneProductionShots = useProjectStore((s) => s.approveSceneProductionShots);
  const approveAllProductionShots = useProjectStore((s) => s.approveAllProductionShots);
  const assignProductionBackground = useProjectStore((s) => s.assignProductionBackground);
  const assignProductionPropAsset = useProjectStore((s) => s.assignProductionPropAsset);
  const assignProductionCharacter = useProjectStore((s) => s.assignProductionCharacter);
  const assignProductionAudio = useProjectStore((s) => s.assignProductionAudio);
  const updateProductionCameraMovement = useProjectStore((s) => s.updateProductionCameraMovement);
  const updateProductionAnimationCategory = useProjectStore(
    (s) => s.updateProductionAnimationCategory,
  );
  const editProductionShotPlan = useProjectStore((s) => s.editProductionShotPlan);

  const characters = useLibraryStore((s) => s.characters);
  const assets = useLibraryStore((s) => s.assets);
  const sounds = useLibraryStore((s) => s.sounds);

  const activeSceneId = useProductionStore((s) => s.activeSceneId);
  const selectedProductionShotId = useProductionStore((s) => s.selectedProductionShotId);
  const generating = useProductionStore((s) => s.generating);
  const regeneratingShotId = useProductionStore((s) => s.regeneratingShotId);
  const setActiveSceneId = useProductionStore((s) => s.setActiveSceneId);
  const setSelectedProductionShotId = useProductionStore((s) => s.setSelectedProductionShotId);
  const openTimelinePreview = useProductionStore((s) => s.openTimelinePreview);
  const openSceneExecutionPreview = useProductionStore((s) => s.openSceneExecutionPreview);
  const openAnimationExecModal = useAnimationExecStore((s) => s.openAnimationExecModal);
  const generateAll = useProductionStore((s) => s.generateAll);
  const generateScene = useProductionStore((s) => s.generateScene);
  const regenerateShot = useProductionStore((s) => s.regenerateShot);

  const switchWorkspace = useWorkspaceStore((s) => s.switchWorkspace);
  const setTimelineCollapsed = useWorkspaceStore((s) => s.setTimelineCollapsed);
  const pushToast = useJobStore((s) => s.pushToast);

  const [regenInstructions, setRegenInstructions] = useState('');
  const [preserveEdits, setPreserveEdits] = useState(true);

  const libCtx = useMemo(() => ({ characters, assets, sounds }), [characters, assets, sounds]);
  const licenseSafeSounds = useMemo(() => sounds.filter(isSoundLicenseSafe), [sounds]);
  const bgAssets = useMemo(
    () => assets.filter((a) => a.type === 'background' || a.type === 'prop'),
    [assets],
  );

  const planDoc = project?.production_plan ?? null;
  const allShots = planDoc?.shots ?? [];

  const resolvedSceneId = useMemo(() => {
    if (activeSceneId && allShots.some((s) => s.scene_id === activeSceneId)) {
      return activeSceneId;
    }
    return allShots[0]?.scene_id ?? null;
  }, [activeSceneId, allShots]);

  const sceneShots = useMemo(
    () => (resolvedSceneId ? allShots.filter((s) => s.scene_id === resolvedSceneId) : []),
    [allShots, resolvedSceneId],
  );

  const selectedShot: ProductionShotPlan | null = useMemo(() => {
    if (selectedProductionShotId) {
      const exact = allShots.find((s) => s.production_shot_id === selectedProductionShotId);
      if (exact) return exact;
    }
    return sceneShots[0] ?? allShots[0] ?? null;
  }, [allShots, sceneShots, selectedProductionShotId]);

  useEffect(() => {
    if (resolvedSceneId && resolvedSceneId !== activeSceneId) {
      setActiveSceneId(resolvedSceneId);
    }
  }, [resolvedSceneId, activeSceneId, setActiveSceneId]);

  useEffect(() => {
    if (selectedShot && selectedShot.production_shot_id !== selectedProductionShotId) {
      setSelectedProductionShotId(selectedShot.production_shot_id);
    }
  }, [selectedShot?.production_shot_id, selectedProductionShotId, setSelectedProductionShotId]);

  const activeSceneTitle = useMemo(() => {
    if (!resolvedSceneId || !project) return '';
    const dir = project.director?.scenes.find(
      (s) => s.scene_breakdown_id === resolvedSceneId || s.applied_stage_scene_id === resolvedSceneId,
    );
    if (dir) return `S${String(dir.scene_number).padStart(2, '0')} — ${dir.title}`;
    const stg = project.scenes.find((s) => s.scene_id === resolvedSceneId);
    if (stg) return stg.name;
    return resolvedSceneId;
  }, [resolvedSceneId, project]);

  if (!project) {
    return (
      <div className="empty-state" style={{ flex: 1 }}>
        <ClipboardCheck size={34} color="var(--text-muted)" />
        <div>{t('common.noProject')}</div>
      </div>
    );
  }

  const hasScript = Boolean(
    project.script?.raw_source_text?.trim() || (project.script?.scenes.length ?? 0) > 0,
  );
  const hasDirector = Boolean((project.director?.scenes.length ?? 0) > 0);
  const hasStoryboard = Boolean((project.storyboard?.shots.length ?? 0) > 0);
  const hasPlan = allShots.length > 0;
  const hasApplied = allShots.some((s) => s.timeline_refs.applied);

  const handleGenerateScene = async () => {
    if (!resolvedSceneId || generating) return;
    try {
      if (isDirty) await saveProject(false);
      const doc = await generateScene(project.meta.project_id, resolvedSceneId, {
        preserve_locked: true,
      });
      setProductionPlanDocument(doc);
      pushToast('success', t('production.sceneRegeneratedToast'));
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : t('production.generationFailed'));
    }
  };

  const handleRegenerateSelectedShot = async () => {
    if (!selectedShot || selectedShot.locked || regeneratingShotId) return;
    try {
      if (isDirty) await saveProject(false);
      const updated = await regenerateShot(
        project.meta.project_id,
        selectedShot.production_shot_id,
        regenInstructions.trim(),
        preserveEdits,
      );
      replaceProductionShotPlan(updated);
      setRegenInstructions('');
      pushToast('success', t('production.shotRegeneratedToast', { order: updated.shot_order }));
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : t('production.shotRegenFailed'));
    }
  };

  return (
    <div className="prod-workspace" data-testid="production-workspace">
      {/* 1. UNIFIED 7-STAGE WORKFLOW PIPELINE STEPPER */}
      <WorkflowPipelineStepper activeStage="production" />

      {/* Empty State when no Production Plan yet */}
      {!hasPlan ? (
        <div className="empty-state" style={{ flex: 1, padding: 32, gap: 12 }}>
          <ClipboardCheck size={42} color="var(--accent-text)" style={{ opacity: 0.8 }} />
          <div style={{ fontSize: 15, fontWeight: 700 }}>{t('production.emptyTitle')}</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', maxWidth: 520, textAlign: 'center', lineHeight: 1.55 }}>
            {hasStoryboard ? t('production.emptyReadyDesc') : t('production.emptyNeedsStoryboardDesc')}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            {hasStoryboard ? (
              <button
                type="button"
                className="btn-primary"
                disabled={generating}
                onClick={async () => {
                  try {
                    if (isDirty) await saveProject(false);
                    const doc = await generateAll(project.meta.project_id, {
                      force: false,
                      preserve_locked: true,
                    });
                    setProductionPlanDocument(doc);
                    pushToast(
                      'success',
                      t('production.generatedToast', {
                        shots: doc.shots.length,
                        ready: doc.shots.filter((s) => s.readiness_status === 'ready').length,
                      }),
                    );
                  } catch (err) {
                    pushToast(
                      'error',
                      err instanceof Error ? err.message : t('production.generationFailed'),
                    );
                  }
                }}
                data-testid="production-empty-generate-btn"
              >
                {generating ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
                {t('production.generateBtn')}
              </button>
            ) : (
              <button
                type="button"
                className="btn-primary"
                onClick={() => switchWorkspace('storyboard')}
              >
                <LayoutGrid size={13} /> {t('production.openStoryboardBtn')}
              </button>
            )}
          </div>
        </div>
      ) : (
        <>
          {/* 2. TOP ACTION BAR */}
          <div className="prod-topbar">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <strong style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {activeSceneTitle || t('production.title')}
              </strong>
              <span className="director-badge pending">
                {sceneShots.length} {t('storyboard.shotsShort')}
              </span>
              {planDoc?.status === 'partial' && (
                <span className="director-badge warning">{t('production.partialStatusBadge')}</span>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              {resolvedSceneId && (
                <button
                  type="button"
                  className="btn-xs"
                  onClick={() => {
                    approveSceneProductionShots(resolvedSceneId);
                    pushToast('success', t('production.sceneApprovedToast'));
                  }}
                  data-testid="production-approve-scene-btn"
                >
                  <Check size={11} /> {t('production.approveSceneBtn')}
                </button>
              )}
              <button
                type="button"
                className="btn-xs"
                onClick={() => {
                  approveAllProductionShots();
                  pushToast('success', t('production.allApprovedToast'));
                }}
                data-testid="production-approve-all-btn"
              >
                <CheckCircle2 size={11} /> {t('production.approveAllBtn')}
              </button>
              {resolvedSceneId && (
                <button
                  type="button"
                  className="btn-xs"
                  disabled={generating}
                  onClick={() => void handleGenerateScene()}
                  data-testid="production-regen-scene-btn"
                >
                  <RefreshCw size={11} /> {t('production.regenSceneKeepLockedBtn')}
                </button>
              )}
              <button
                type="button"
                className="btn-xs btn-primary"
                onClick={() => openSceneExecutionPreview('scene')}
                data-testid="production-assemble-scene-btn"
              >
                <Clapperboard size={11} /> {t('sceneExec.assembleSceneShortBtn')}
              </button>
              <button
                type="button"
                className="btn-xs"
                onClick={() =>
                  openAnimationExecModal(resolvedSceneId ? { sceneIds: [resolvedSceneId] } : {})
                }
                data-testid="production-anim-exec-scene-btn"
              >
                <Sparkles size={11} /> {t('motionExec.executeShortBtn')}
              </button>
              <button
                type="button"
                className="btn-xs"
                onClick={() => openTimelinePreview('scene')}
                data-testid="production-preview-scene-btn"
              >
                <Layers size={11} /> {t('production.previewSceneBtn')}
              </button>
            </div>
          </div>

          {/* 3. MASTER-DETAIL SPLIT: Shot Production Queue + Detailed Production Inspector */}
          <div className="prod-main-split">
            {/* LEFT SHOT LIST */}
            <div className="prod-shot-list-col" data-testid="production-shot-list">
              {sceneShots.map((sh) => {
                const isSelected = selectedShot?.production_shot_id === sh.production_shot_id;
                const badgeCls = readinessBadgeClass(sh.readiness_status);
                return (
                  <div
                    key={sh.production_shot_id}
                    className={`prod-shot-item ${isSelected ? 'selected' : ''} ${sh.locked ? 'locked' : ''}`}
                    onClick={() => setSelectedProductionShotId(sh.production_shot_id)}
                    data-testid={`production-shot-card-${sh.shot_order}`}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 5 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                        <span className="mono" style={{ fontSize: 10, fontWeight: 700, color: 'var(--accent-text)' }}>
                          #{sh.shot_order}
                        </span>
                        <strong
                          style={{
                            fontSize: 11,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {sh.title}
                        </strong>
                      </div>
                      <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>
                        {(sh.duration_ms / 1000).toFixed(1)}s
                      </span>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', marginTop: 5 }}>
                      <span className={`director-badge ${badgeCls}`} data-testid={`shot-readiness-${sh.shot_order}`}>
                        {t(`production.readiness.${sh.readiness_status}`)}
                      </span>
                      <span
                        className={`director-badge ${
                          sh.approval_status === 'approved'
                            ? 'accepted'
                            : sh.approval_status === 'rejected'
                              ? 'rejected'
                              : sh.approval_status === 'edited'
                                ? 'edited'
                                : 'pending'
                        }`}
                      >
                        {t(`production.approval.${sh.approval_status}`)}
                      </span>
                      {sh.timeline_refs.applied && (
                        <span className="director-badge accepted" data-testid={`shot-applied-badge-${sh.shot_order}`}>
                          <CheckCircle2 size={9} /> {t('production.appliedShort')}
                        </span>
                      )}
                    </div>

                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 4,
                        marginTop: 6,
                        paddingTop: 5,
                        borderTop: '1px solid var(--border-subtle)',
                      }}
                    >
                      <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                        {t(`production.capability.${sh.execution_capability}`)}
                      </span>
                      <div style={{ display: 'flex', gap: 4 }} onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          className={`btn-xs ${sh.locked ? 'btn-primary' : ''}`}
                          title={sh.locked ? t('storyboard.unlockShot') : t('storyboard.lockShot')}
                          onClick={() => toggleLockProductionShot(sh.production_shot_id)}
                          data-testid={`prod-lock-btn-${sh.shot_order}`}
                        >
                          {sh.locked ? <Lock size={10} /> : <Unlock size={10} />}
                        </button>
                        <button
                          type="button"
                          className={`btn-xs ${sh.approval_status === 'approved' ? 'btn-primary' : ''}`}
                          title={t('production.approveShotBtn')}
                          onClick={() =>
                            setProductionShotApproval(
                              sh.production_shot_id,
                              sh.approval_status === 'approved' ? 'pending' : 'approved',
                            )
                          }
                          data-testid={`prod-approve-btn-${sh.shot_order}`}
                        >
                          <Check size={10} />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* RIGHT PRODUCTION PLAN INSPECTOR */}
            <div className="prod-inspector-col" data-testid="production-shot-inspector">
              {!selectedShot ? (
                <div className="empty-state" style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {t('production.selectShotPrompt')}
                  </div>
                </div>
              ) : (
                <div className="prod-inspector-scroll">
                  {/* Shot Header Bar */}
                  <div className="director-detail-topbar" style={{ marginBottom: 10 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span className="mono" style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent-text)' }}>
                          #{selectedShot.shot_order}
                        </span>
                        <strong style={{ fontSize: 13 }}>{selectedShot.title}</strong>
                        <span
                          className={`director-badge ${readinessBadgeClass(selectedShot.readiness_status)}`}
                          data-testid="inspector-readiness-badge"
                        >
                          {t(`production.readiness.${selectedShot.readiness_status}`)}
                        </span>
                        <span className="director-badge pending mono">
                          {(selectedShot.start_time_ms / 1000).toFixed(1)}s →{' '}
                          {(selectedShot.end_time_ms / 1000).toFixed(1)}s
                        </span>
                      </div>
                      {selectedShot.action_summary && (
                        <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                          {selectedShot.action_summary}
                        </div>
                      )}
                    </div>

                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        className={`btn-xs ${selectedShot.locked ? 'btn-primary' : ''}`}
                        onClick={() => toggleLockProductionShot(selectedShot.production_shot_id)}
                        data-testid="inspector-lock-btn"
                      >
                        {selectedShot.locked ? <Lock size={11} /> : <Unlock size={11} />}
                        {selectedShot.locked ? t('production.locked') : t('production.unlocked')}
                      </button>
                      <button
                        type="button"
                        className={`btn-xs ${selectedShot.approval_status === 'approved' ? 'btn-primary' : ''}`}
                        onClick={() =>
                          setProductionShotApproval(selectedShot.production_shot_id, 'approved')
                        }
                        data-testid="inspector-approve-btn"
                      >
                        <Check size={11} /> {t('production.approveShotBtn')}
                      </button>
                      <button
                        type="button"
                        className="btn-xs"
                        onClick={() =>
                          setProductionShotApproval(selectedShot.production_shot_id, 'rejected')
                        }
                      >
                        <XCircle size={11} /> {t('production.rejectShotBtn')}
                      </button>
                      <button
                        type="button"
                        className="btn-xs btn-primary"
                        onClick={() => openSceneExecutionPreview('shot')}
                        data-testid="inspector-assemble-shot-btn"
                      >
                        <Clapperboard size={11} /> {t('sceneExec.assembleShotBtn')}
                      </button>
                      <button
                        type="button"
                        className="btn-xs"
                        onClick={() => openTimelinePreview('shot')}
                        data-testid="inspector-preview-shot-btn"
                      >
                        <Layers size={11} /> {t('production.previewShotBtn')}
                      </button>
                    </div>
                  </div>

                  {/* SECTION 1: READINESS & MISSING DEPENDENCIES */}
                  <div className="prod-card" style={{ marginBottom: 10 }}>
                    <div className="inspector-section-title">
                      <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        {selectedShot.missing_dependencies.length === 0 ? (
                          <ShieldCheck size={13} color="var(--success)" />
                        ) : (
                          <ShieldAlert size={13} color="var(--warning)" />
                        )}
                        {t('production.readinessSectionTitle')}
                      </span>
                      <span className="director-badge pending">
                        {t(`production.capability.${selectedShot.execution_capability}`)}
                      </span>
                    </div>

                    {selectedShot.missing_dependencies.length === 0 ? (
                      <div className="director-callout success" data-testid="inspector-ready-callout">
                        <CheckCircle2 size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                        <span>{t('production.allDependenciesReadyMsg')}</span>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="inspector-missing-deps">
                        {selectedShot.missing_dependencies.map((dep) => (
                          <div
                            key={dep.dependency_id}
                            className={`director-callout ${dep.severity === 'blocking' ? 'error' : 'warning'}`}
                          >
                            <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                              <strong style={{ fontSize: 11 }}>{dep.label}</strong>
                              <span style={{ fontSize: 11 }}>{dep.reason}</span>
                              {dep.suggested_action && (
                                <span style={{ fontSize: 10, opacity: 0.9 }}>
                                  → {dep.suggested_action}
                                </span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* SECTION 2: CHARACTERS & STAGING */}
                  <div className="prod-card" style={{ marginBottom: 10 }}>
                    <div className="inspector-section-title">
                      <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <Users size={13} color="var(--accent-text)" />
                        {t('production.charactersSectionTitle')} ({selectedShot.characters.length})
                      </span>
                    </div>
                    {selectedShot.characters.length === 0 ? (
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {t('production.noCharactersInShot')}
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                        {selectedShot.characters.map((ch) => (
                          <div key={ch.staging_id} className="sb-staging-card">
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <strong style={{ fontSize: 11 }}>{ch.character_name}</strong>
                                {ch.character_missing ? (
                                  <span className="director-badge rejected">{t('production.unlinkedBadge')}</span>
                                ) : ch.rig_missing ? (
                                  <span className="director-badge warning">{t('production.missingRigBadge')}</span>
                                ) : (
                                  <span className="director-badge accepted">{t('production.linkedReadyBadge')}</span>
                                )}
                              </div>
                              <select
                                value={ch.library_character_id ?? ''}
                                style={{ fontSize: 11, maxWidth: 210 }}
                                data-testid={`prod-char-select-${ch.character_name}`}
                                onChange={(e) => {
                                  const found =
                                    characters.find((c) => c.character_id === e.target.value) ?? null;
                                  assignProductionCharacter(
                                    selectedShot.production_shot_id,
                                    ch.staging_id,
                                    found,
                                    libCtx,
                                  );
                                }}
                              >
                                <option value="">{t('production.selectCharacterPlaceholder')}</option>
                                {characters.map((c) => (
                                  <option key={c.character_id} value={c.character_id}>
                                    {c.name} ({c.parts.length} parts)
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div className="director-chip-row" style={{ marginTop: 6 }}>
                              <span className="director-chip">pos: {ch.screen_position}</span>
                              <span className="director-chip">depth: {ch.depth_layer}</span>
                              <span className="director-chip">facing: {ch.facing_direction}</span>
                              {ch.initial_pose && <span className="director-chip">pose: {ch.initial_pose}</span>}
                              {ch.expression && <span className="director-chip">expr: {ch.expression}</span>}
                              {ch.entrance && ch.entrance !== 'none' && (
                                <span className="director-chip">in: {ch.entrance}</span>
                              )}
                              {ch.exit && ch.exit !== 'none' && (
                                <span className="director-chip">out: {ch.exit}</span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* SECTION 3: ASSET MATCHING (BACKGROUND & PROPS) */}
                  <div className="prod-card" style={{ marginBottom: 10 }}>
                    <div className="inspector-section-title">
                      <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <ImageIcon size={13} color="var(--accent-text)" />
                        {t('production.assetsSectionTitle')}
                      </span>
                    </div>

                    {/* Background Row */}
                    {selectedShot.background && (
                      <div className="sb-staging-card" style={{ marginBottom: 7 }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                            <span className="director-badge pending">BG</span>
                            <strong style={{ fontSize: 11 }}>{selectedShot.background.label}</strong>
                            <span className={`director-badge ${assetClassBadge(selectedShot.background.classification)}`}>
                              {t(`production.assetClass.${selectedShot.background.classification}`)}
                            </span>
                          </div>
                          <select
                            value={selectedShot.background.matched_asset_id ?? ''}
                            style={{ fontSize: 11, maxWidth: 220 }}
                            data-testid="prod-bg-asset-select"
                            onChange={(e) => {
                              const found =
                                assets.find((a) => a.asset_id === e.target.value) ?? null;
                              assignProductionBackground(
                                selectedShot.production_shot_id,
                                found,
                                libCtx,
                              );
                            }}
                          >
                            <option value="">{t('production.selectAssetPlaceholder')}</option>
                            {bgAssets.map((a) => (
                              <option key={a.asset_id} value={a.asset_id}>
                                [{a.type}] {a.name}
                              </option>
                            ))}
                          </select>
                        </div>
                        {selectedShot.background.notes && (
                          <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 4 }}>
                            {selectedShot.background.notes}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Prop / Effect Assets */}
                    {selectedShot.assets.length > 0 && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {selectedShot.assets.map((assetReq) => (
                          <div key={assetReq.requirement_id} className="sb-staging-card">
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <span className="director-badge pending">{assetReq.kind.toUpperCase()}</span>
                                <strong style={{ fontSize: 11 }}>{assetReq.label}</strong>
                                <span className={`director-badge ${assetClassBadge(assetReq.classification)}`}>
                                  {t(`production.assetClass.${assetReq.classification}`)}
                                </span>
                              </div>
                              <select
                                value={assetReq.matched_asset_id ?? ''}
                                style={{ fontSize: 11, maxWidth: 220 }}
                                onChange={(e) => {
                                  const found =
                                    assets.find((a) => a.asset_id === e.target.value) ?? null;
                                  assignProductionPropAsset(
                                    selectedShot.production_shot_id,
                                    assetReq.requirement_id,
                                    found,
                                    libCtx,
                                  );
                                }}
                              >
                                <option value="">{t('production.selectAssetPlaceholder')}</option>
                                {assets.map((a) => (
                                  <option key={a.asset_id} value={a.asset_id}>
                                    [{a.type}] {a.name}
                                  </option>
                                ))}
                              </select>
                            </div>
                            {assetReq.notes && (
                              <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 4 }}>
                                {assetReq.notes}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* SECTION 4: ANIMATION PLAN */}
                  <div className="prod-card" style={{ marginBottom: 10 }}>
                    <div className="inspector-section-title">
                      <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <Sparkles size={13} color="var(--accent-text)" />
                        {t('production.animationSectionTitle')} ({selectedShot.animation_plans.length})
                      </span>
                    </div>
                    {selectedShot.animation_plans.length === 0 ? (
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {t('production.noAnimationsInShot')}
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                        {selectedShot.animation_plans.map((ap, idx) => (
                          <div key={ap.action_plan_id} className="sb-staging-card">
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <strong style={{ fontSize: 11 }}>{ap.character_name}</strong>
                                <span className={`director-badge ${ap.supported ? 'accepted' : 'rejected'}`}>
                                  {ap.supported
                                    ? t('production.animSupportedBadge')
                                    : t('production.animUnsupportedBadge')}
                                </span>
                                {ap.mapped_animation_state && (
                                  <span className="director-badge pending mono">
                                    {ap.mapped_animation_state}
                                  </span>
                                )}
                                {ap.mapped_preset_id && (
                                  <span className="director-badge edited mono">
                                    {ap.mapped_preset_id}
                                  </span>
                                )}
                              </div>
                              <select
                                value={ap.category}
                                style={{ fontSize: 11 }}
                                data-testid={`prod-anim-category-${idx}`}
                                onChange={(e) =>
                                  updateProductionAnimationCategory(
                                    selectedShot.production_shot_id,
                                    ap.action_plan_id,
                                    e.target.value as AnimationActionCategory,
                                    libCtx,
                                  )
                                }
                              >
                                {ANIMATION_CATEGORIES.map((cat) => (
                                  <option key={cat} value={cat}>
                                    {cat}
                                  </option>
                                ))}
                              </select>
                            </div>
                            {ap.description && (
                              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
                                {ap.description}
                              </div>
                            )}
                            {!ap.supported && (
                              <div style={{ fontSize: 10, color: 'var(--warning)', marginTop: 4 }}>
                                ⚠ {ap.unsupported_reason}
                                {ap.manual_alternative ? ` — ${ap.manual_alternative}` : ''}
                              </div>
                            )}
                            {ap.missing_parts.length > 0 && (
                              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3 }}>
                                {t('production.missingRigPartsLabel')}: {ap.missing_parts.join(', ')}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* SECTION 5: CAMERA PRODUCTION PLAN */}
                  <div className="prod-card" style={{ marginBottom: 10 }}>
                    <div className="inspector-section-title">
                      <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <Camera size={13} color="var(--accent-text)" />
                        {t('production.cameraSectionTitle')}
                      </span>
                      <span
                        className={`director-badge ${
                          selectedShot.camera_plan.support_status === 'supported'
                            ? 'accepted'
                            : selectedShot.camera_plan.support_status === '2d_approximation'
                              ? 'warning'
                              : 'rejected'
                        }`}
                        data-testid="prod-camera-support-badge"
                      >
                        {t(`storyboard.camSupport.${selectedShot.camera_plan.support_status}`)}
                      </span>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 6 }}>
                      <div>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 3 }}>
                          {t('production.cameraMovementLabel')}
                        </div>
                        <select
                          value={selectedShot.camera_plan.camera_movement}
                          style={{ width: '100%', fontSize: 11 }}
                          data-testid="prod-camera-movement-select"
                          onChange={(e) =>
                            updateProductionCameraMovement(
                              selectedShot.production_shot_id,
                              e.target.value as CameraMovement,
                              libCtx,
                            )
                          }
                        >
                          {CAMERA_MOVEMENTS.map((mv) => (
                            <option key={mv} value={mv}>
                              {mv}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 3 }}>
                          {t('production.cameraFramingLabel')}
                        </div>
                        <div className="mono" style={{ fontSize: 10, color: 'var(--text-secondary)', paddingTop: 4 }}>
                          {selectedShot.camera_plan.shot_size} • {selectedShot.camera_plan.camera_angle}
                          <br />
                          z: {selectedShot.camera_plan.camera_plan.start_zoom}→
                          {selectedShot.camera_plan.camera_plan.end_zoom}, x:{' '}
                          {selectedShot.camera_plan.camera_plan.start_x}→
                          {selectedShot.camera_plan.camera_plan.end_x}
                        </div>
                      </div>
                    </div>

                    <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                      {selectedShot.camera_plan.support_note}
                    </div>
                  </div>

                  {/* SECTION 6: AUDIO PLAN (LICENSE-SAFE SFX & BGM) */}
                  <div className="prod-card" style={{ marginBottom: 10 }}>
                    <div className="inspector-section-title">
                      <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <Music size={13} color="var(--accent-text)" />
                        {t('production.audioSectionTitle')} (
                        {selectedShot.sfx_plans.length + selectedShot.bgm_plans.length})
                      </span>
                      <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                        {t('production.licenseSafeOnlyNote')}
                      </span>
                    </div>

                    {selectedShot.sfx_plans.length === 0 && selectedShot.bgm_plans.length === 0 ? (
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {t('production.noAudioInShot')}
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                        {[
                          ...selectedShot.sfx_plans.map((a) => ({ kind: 'sfx' as const, item: a })),
                          ...selectedShot.bgm_plans.map((a) => ({ kind: 'bgm' as const, item: a })),
                        ].map(({ kind, item }) => (
                          <div key={item.audio_plan_id} className="sb-staging-card">
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <span className="director-badge pending">
                                  {item.audio_type.toUpperCase()}
                                </span>
                                <strong style={{ fontSize: 11 }}>
                                  {item.category || item.description}
                                </strong>
                                <span
                                  className={`director-badge ${
                                    item.matched_sound_id && item.license_verified
                                      ? 'accepted'
                                      : 'warning'
                                  }`}
                                >
                                  {item.matched_sound_id && item.license_verified
                                    ? t('production.licenseVerifiedBadge')
                                    : t('production.audioUnmatchedBadge')}
                                </span>
                              </div>
                              <select
                                value={item.matched_sound_id ?? ''}
                                style={{ fontSize: 11, maxWidth: 220 }}
                                data-testid={`prod-audio-select-${kind}`}
                                onChange={(e) => {
                                  const found =
                                    licenseSafeSounds.find((s) => s.sound_id === e.target.value) ??
                                    null;
                                  assignProductionAudio(
                                    selectedShot.production_shot_id,
                                    kind,
                                    item.audio_plan_id,
                                    found,
                                    libCtx,
                                  );
                                }}
                              >
                                <option value="">{t('production.selectVerifiedSoundPlaceholder')}</option>
                                {licenseSafeSounds.map((s) => (
                                  <option key={s.sound_id} value={s.sound_id}>
                                    [{s.audio_type}] {s.name} ({s.license.source})
                                  </option>
                                ))}
                              </select>
                            </div>
                            {item.license_note && (
                              <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 4 }}>
                                {item.license_note}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* SECTION 7: VOICE & SUBTITLES */}
                  <div className="prod-card" style={{ marginBottom: 10 }}>
                    <div className="inspector-section-title">
                      <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <Captions size={13} color="var(--accent-text)" />
                        {t('production.voiceSubtitleSectionTitle')} (
                        {selectedShot.voice_subtitle_plans.length})
                      </span>
                    </div>
                    {selectedShot.voice_subtitle_plans.length === 0 ? (
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {t('production.noDialogueInShot')}
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {selectedShot.voice_subtitle_plans.map((vs) => (
                          <div key={vs.item_plan_id} className="sb-staging-card">
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 3 }}>
                              <strong style={{ fontSize: 11 }}>
                                {vs.speaker_name || t('production.narrationLabel')}
                              </strong>
                              <span
                                className={`director-badge ${
                                  vs.sync_mode === 'exact_voice' ? 'accepted' : 'pending'
                                }`}
                              >
                                {vs.sync_mode === 'exact_voice'
                                  ? t('production.syncExactVoice')
                                  : t('production.syncEstimated')}
                              </span>
                              <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                                {(vs.duration_ms / 1000).toFixed(1)}s
                              </span>
                              {vs.spans_multiple_shots && (
                                <span className="director-badge edited">
                                  {t('production.spansMultiShotsBadge')}
                                </span>
                              )}
                            </div>
                            <div style={{ fontSize: 11, color: 'var(--text-primary)', lineHeight: 1.45 }}>
                              {vs.text}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* SECTION 8: NOTES & EDIT-PROTECTED SHOT REGENERATION */}
                  <div className="prod-card" style={{ marginBottom: 10 }}>
                    <div className="inspector-section-title">
                      <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <RefreshCw size={13} color="var(--accent-text)" />
                        {t('production.notesAndRegenTitle')}
                      </span>
                      {selectedShot.user_edited_fields.length > 0 && (
                        <span className="director-badge edited">
                          {t('production.userEditedFieldsCount', {
                            count: selectedShot.user_edited_fields.length,
                          })}
                        </span>
                      )}
                    </div>

                    <textarea
                      rows={2}
                      value={selectedShot.ai_notes}
                      placeholder={t('production.notesPlaceholder')}
                      style={{ width: '100%', fontSize: 11, marginBottom: 8 }}
                      data-testid="prod-shot-notes-input"
                      onChange={(e) =>
                        editProductionShotPlan(
                          selectedShot.production_shot_id,
                          { ai_notes: e.target.value },
                          libCtx,
                        )
                      }
                    />

                    {selectedShot.locked ? (
                      <div className="director-callout warning" style={{ fontSize: 11 }}>
                        <Lock size={12} style={{ flexShrink: 0, marginTop: 1 }} />
                        <span>{t('production.lockedRegenBlockedHint')}</span>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <input
                          type="text"
                          value={regenInstructions}
                          placeholder={t('production.regenInstructionsPlaceholder')}
                          onChange={(e) => setRegenInstructions(e.target.value)}
                          style={{ fontSize: 11 }}
                          data-testid="prod-regen-instructions-input"
                        />
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, cursor: 'pointer' }}>
                            <input
                              type="checkbox"
                              checked={preserveEdits}
                              onChange={(e) => setPreserveEdits(e.target.checked)}
                            />
                            {t('production.preserveEditsLabel')}
                          </label>
                          <button
                            type="button"
                            className="btn-xs"
                            disabled={Boolean(regeneratingShotId)}
                            onClick={() => void handleRegenerateSelectedShot()}
                            data-testid="prod-regen-shot-btn"
                          >
                            {regeneratingShotId === selectedShot.production_shot_id ? (
                              <Loader2 size={11} className="spin" />
                            ) : (
                              <RefreshCw size={11} />
                            )}
                            {t('production.regenShotBtn')}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* SECTION 9: APPLIED TIMELINE REFS SUMMARY */}
                  {selectedShot.timeline_refs.applied && (
                    <div className="prod-card" data-testid="inspector-applied-refs">
                      <div className="inspector-section-title">
                        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          <CheckCircle2 size={13} color="var(--success)" />
                          {t('production.appliedRefsTitle')}
                        </span>
                        <span className="mono" style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                          {(selectedShot.timeline_refs.applied_start_ms / 1000).toFixed(1)}s →{' '}
                          {(selectedShot.timeline_refs.applied_end_ms / 1000).toFixed(1)}s
                        </span>
                      </div>
                      <div className="director-chip-row">
                        <span className="director-chip">
                          {selectedShot.timeline_refs.character_instance_ids.length}{' '}
                          {t('production.charsShort')}
                        </span>
                        <span className="director-chip">
                          {selectedShot.timeline_refs.keyframe_ids.length}{' '}
                          {t('production.keyframesShort')}
                        </span>
                        <span className="director-chip">
                          {selectedShot.timeline_refs.animation_clip_ids.length}{' '}
                          {t('production.animsShort')}
                        </span>
                        <span className="director-chip">
                          {selectedShot.timeline_refs.sound_event_ids.length}{' '}
                          {t('production.audioShort')}
                        </span>
                        <span className="director-chip">
                          {selectedShot.timeline_refs.subtitle_ids.length}{' '}
                          {t('production.subsShort')}
                        </span>
                      </div>
                      {selectedShot.timeline_refs.skipped_operations.length > 0 && (
                        <div style={{ marginTop: 6, fontSize: 10, color: 'var(--warning)' }}>
                          {selectedShot.timeline_refs.skipped_operations.map((op, i) => (
                            <div key={i}>• {op}</div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
