import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  CheckCircle2,
  Clapperboard,
  Copy,
  Eye,
  Film,
  LayoutGrid,
  Loader2,
  Lock,
  MessageSquareQuote,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings,
  ShieldAlert,
  Sparkles,
  Trash2,
  Unlock,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { WorkflowPipelineStepper } from '@/components/common/WorkflowPipelineStepper';
import {
  CAMERA_ANGLES,
  CAMERA_MOVEMENTS,
  SHOT_SIZES,
} from '@/engine/storyboardEngine';
import { useI18n } from '@/i18n/useLocaleStore';
import { apiClient } from '@/services/apiClient';
import { useJobStore } from '@/stores/useJobStore';
import { useLibraryStore } from '@/stores/useLibraryStore';
import { useProjectStore } from '@/stores/useProjectStore';
import { useStoryboardStore } from '@/stores/useStoryboardStore';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';
import type {
  CameraAngle,
  CameraMovement,
  DepthLayer,
  FacingDirection,
  ScreenPosition,
  ShotSize,
  ShotTransition,
  StoryboardShot,
} from '@/types/models';
import { ShotCompositionPreview } from './ShotCompositionPreview';

const SCREEN_POSITIONS: ScreenPosition[] = [
  'far_left',
  'left',
  'center_left',
  'center',
  'center_right',
  'right',
  'far_right',
  'offscreen',
];

const DEPTH_LAYERS: DepthLayer[] = ['foreground', 'midground', 'background'];

const FACING_DIRECTIONS: FacingDirection[] = [
  'left',
  'three_quarter_left',
  'front',
  'three_quarter_right',
  'right',
  'back',
];

const SHOT_TRANSITIONS: ShotTransition[] = [
  'cut',
  'fade',
  'cross_dissolve',
  'match_cut',
  'whip_pan',
  'sound_bridge',
];

export function StoryboardWorkspace({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useI18n();
  const project = useProjectStore((s) => s.project);
  const isDirty = useProjectStore((s) => s.isDirty);
  const saveProject = useProjectStore((s) => s.saveProject);
  const setStoryboardDocument = useProjectStore((s) => s.setStoryboardDocument);
  const replaceStoryboardShot = useProjectStore((s) => s.replaceStoryboardShot);
  const addStoryboardShot = useProjectStore((s) => s.addStoryboardShot);
  const duplicateStoryboardShot = useProjectStore((s) => s.duplicateStoryboardShot);
  const deleteStoryboardShot = useProjectStore((s) => s.deleteStoryboardShot);
  const editStoryboardShot = useProjectStore((s) => s.editStoryboardShot);
  const toggleLockStoryboardShot = useProjectStore((s) => s.toggleLockStoryboardShot);
  const moveStoryboardShot = useProjectStore((s) => s.moveStoryboardShot);
  const addShotCharacter = useProjectStore((s) => s.addShotCharacter);
  const updateShotCharacter = useProjectStore((s) => s.updateShotCharacter);
  const removeShotCharacter = useProjectStore((s) => s.removeShotCharacter);
  const restoreOriginalStoryboardShot = useProjectStore((s) => s.restoreOriginalStoryboardShot);
  const markStoryboardContinuityWarning = useProjectStore(
    (s) => s.markStoryboardContinuityWarning,
  );

  const libraryCharacters = useLibraryStore((s) => s.characters);
  const pushToast = useJobStore((s) => s.pushToast);
  const switchWorkspace = useWorkspaceStore((s) => s.switchWorkspace);

  const approvedScenes = useStoryboardStore((s) => s.approvedScenes);
  const activeSceneId = useStoryboardStore((s) => s.activeSceneId);
  const selectedShotId = useStoryboardStore((s) => s.selectedShotId);
  const generating = useStoryboardStore((s) => s.generating);
  const generatingSceneId = useStoryboardStore((s) => s.generatingSceneId);
  const regeneratingShotId = useStoryboardStore((s) => s.regeneratingShotId);
  const showContinuityDrawer = useStoryboardStore((s) => s.showContinuityDrawer);

  const setActiveSceneId = useStoryboardStore((s) => s.setActiveSceneId);
  const setSelectedShotId = useStoryboardStore((s) => s.setSelectedShotId);
  const setShowContinuityDrawer = useStoryboardStore((s) => s.setShowContinuityDrawer);
  const generateScene = useStoryboardStore((s) => s.generateScene);
  const regenerateShot = useStoryboardStore((s) => s.regenerateShot);

  const [regenShotInstructions, setRegenShotInstructions] = useState('');
  const [preserveEditsOnRegen, setPreserveEditsOnRegen] = useState(true);
  const [confirmReplaceSceneModal, setConfirmReplaceSceneModal] = useState(false);
  const [stageCharChoice, setStageCharChoice] = useState('');

  const storyboard = project?.storyboard ?? null;
  const activeScene = useMemo(
    () => approvedScenes.find((s) => s.scene_id === activeSceneId) ?? approvedScenes[0] ?? null,
    [approvedScenes, activeSceneId],
  );

  const sceneShots = useMemo(() => {
    if (!storyboard || !activeScene) return [];
    return storyboard.shots
      .filter((sh) => sh.scene_id === activeScene.scene_id)
      .sort((a, b) => a.shot_order - b.shot_order);
  }, [storyboard, activeScene]);

  const selectedShot: StoryboardShot | null = useMemo(() => {
    if (sceneShots.length === 0) return null;
    return sceneShots.find((s) => s.shot_id === selectedShotId) ?? sceneShots[0];
  }, [sceneShots, selectedShotId]);

  const sceneWarnings = useMemo(() => {
    if (!storyboard) return [];
    return storyboard.continuity_warnings.filter(
      (w) => !w.dismissed && (!activeScene || w.scene_id === activeScene.scene_id),
    );
  }, [storyboard, activeScene]);

  const warningsByShotId = useMemo(() => {
    const map = new Map<string, number>();
    for (const w of sceneWarnings) {
      map.set(w.shot_id, (map.get(w.shot_id) ?? 0) + 1);
    }
    return map;
  }, [sceneWarnings]);

  // Grounded selectable character pool (Director Characters + Library Characters, deduplicated — never inventing assets!)
  const availableCharacterChoices = useMemo(() => {
    const out: Array<{
      key: string;
      name: string;
      libraryCharacterId: string | null;
      characterAnalysisId: string | null;
    }> = [];
    const seen = new Set<string>();
    for (const ch of project?.director?.characters ?? []) {
      const k = ch.canonical_name.trim().toLowerCase();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push({
        key: `dir:${ch.character_analysis_id}`,
        name: ch.canonical_name,
        libraryCharacterId: ch.linked_character_id ?? null,
        characterAnalysisId: ch.character_analysis_id,
      });
    }
    for (const lc of libraryCharacters) {
      const k = lc.name.trim().toLowerCase();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push({
        key: `lib:${lc.character_id}`,
        name: lc.name,
        libraryCharacterId: lc.character_id,
        characterAnalysisId: null,
      });
    }
    return out;
  }, [project?.director?.characters, libraryCharacters]);

  if (!project) {
    return (
      <div className="director-empty-workspace">
        <LayoutGrid size={36} color="var(--accent-text)" />
        <h3>{t('storyboard.workspaceTitle')}</h3>
        <p>{t('common.noProject')}</p>
      </div>
    );
  }

  const handleGenerateActiveScene = async (
    strategy: 'preserve_locked' | 'replace_all',
    confirmReplaceAll: boolean,
  ) => {
    if (!activeScene) return;
    try {
      if (isDirty) {
        await saveProject(false);
      }
      const doc = await generateScene(project.meta.project_id, activeScene.scene_id, {
        force: true,
        strategy,
        confirm_replace_all: confirmReplaceAll,
      });
      setStoryboardDocument(doc);
      setConfirmReplaceSceneModal(false);
      pushToast(
        'success',
        t('storyboard.sceneGeneratedToast', {
          title: activeScene.title,
          count: doc.shots.filter((s) => s.scene_id === activeScene.scene_id).length,
        }),
      );
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : t('storyboard.generationFailed'));
    }
  };

  const handleRegenerateSelectedShot = async () => {
    if (!selectedShot) return;
    if (selectedShot.locked) {
      pushToast('info', t('storyboard.unlockBeforeRegenHint'));
      return;
    }
    try {
      if (isDirty) {
        await saveProject(false);
      }
      const updated = await regenerateShot(
        project.meta.project_id,
        selectedShot.shot_id,
        regenShotInstructions,
        preserveEditsOnRegen,
      );
      replaceStoryboardShot(updated);
      setRegenShotInstructions('');
      pushToast('success', t('storyboard.shotRegeneratedToast', { num: updated.shot_order }));
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : 'Regeneration failed');
    }
  };

  const handleAddShot = () => {
    if (!activeScene) return;
    const newId = addStoryboardShot({
      sceneId: activeScene.scene_id,
      sceneBreakdownId: activeScene.scene_breakdown_id,
      scriptSceneId: activeScene.script_scene_id,
      afterShotId: selectedShot?.shot_id ?? null,
      environment: activeScene.location,
    });
    setSelectedShotId(newId);
    pushToast('success', t('storyboard.shotAddedToast'));
  };

  const handleStageCharacter = () => {
    if (!selectedShot || !stageCharChoice) return;
    const found = availableCharacterChoices.find((c) => c.key === stageCharChoice);
    if (!found) return;
    addShotCharacter(selectedShot.shot_id, {
      characterName: found.name,
      libraryCharacterId: found.libraryCharacterId,
      characterAnalysisId: found.characterAnalysisId,
    });
    setStageCharChoice('');
  };

  const handleRunAndToggleContinuity = async () => {
    if (showContinuityDrawer) {
      setShowContinuityDrawer(false);
      return;
    }
    try {
      if (isDirty) await saveProject(false);
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
      setShowContinuityDrawer(true);
      pushToast('error', err instanceof Error ? err.message : 'Continuity check failed');
    }
  };

  const totalSceneShotMs = sceneShots.reduce((acc, s) => acc + s.duration_ms, 0);
  const lockedInSceneCount = sceneShots.filter((s) => s.locked).length;

  return (
    <div className="sb-workspace" data-testid="storyboard-workspace">
      <WorkflowPipelineStepper activeStage="storyboard" />
      {/* Top Scene Bar — consolidated single continuity check + clean primary/secondary actions */}
      <div className="director-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <Clapperboard size={14} color="var(--accent-text)" style={{ flexShrink: 0 }} />
          {activeScene ? (
            <>
              <span className="mono" style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent-text)' }}>
                S{String(activeScene.scene_number).padStart(2, '0')}
              </span>
              <strong style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {activeScene.title}
              </strong>
              <span className="director-badge pending mono">
                {sceneShots.length} {t('storyboard.shotsShort')} • {(totalSceneShotMs / 1000).toFixed(1)}s
              </span>
              {activeScene.location && (
                <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                  • {activeScene.location}
                </span>
              )}
            </>
          ) : (
            <strong style={{ fontSize: 12 }}>{t('storyboard.workspaceTitle')}</strong>
          )}
        </div>

        <div className="director-header-actions">
          {activeScene && (
            <>
              <button
                type="button"
                className="btn-xs"
                onClick={handleAddShot}
                data-testid="storyboard-add-shot-btn"
              >
                <Plus size={11} /> {t('storyboard.addShotBtn')}
              </button>
              <button
                type="button"
                className="btn-xs btn-primary"
                disabled={generating}
                onClick={() => void handleGenerateActiveScene('preserve_locked', false)}
                data-testid="storyboard-gen-scene-preserve-btn"
              >
                {generatingSceneId === activeScene.scene_id ? (
                  <Loader2 size={11} className="spin" />
                ) : (
                  <Sparkles size={11} />
                )}
                {sceneShots.length > 0
                  ? t('storyboard.regenScenePreserveLockedBtn')
                  : t('storyboard.genSceneBtn')}
              </button>
              {sceneShots.length > 0 && (
                <button
                  type="button"
                  className="btn-xs btn-icon"
                  disabled={generating}
                  onClick={() => setConfirmReplaceSceneModal(true)}
                  title={t('storyboard.replaceEntireSceneBtn')}
                  data-testid="storyboard-replace-scene-btn"
                >
                  <RefreshCw size={11} />
                </button>
              )}
            </>
          )}
          <button
            type="button"
            className={`btn-xs ${sceneWarnings.length > 0 ? 'btn-warning' : ''}`}
            disabled={!storyboard || storyboard.shots.length === 0}
            onClick={() => void handleRunAndToggleContinuity()}
            data-testid="storyboard-toggle-continuity-btn"
          >
            <ShieldAlert size={11} />{' '}
            {t('storyboard.continuityShortBtn', { count: sceneWarnings.length })}
          </button>
          {sceneShots.length > 0 && (
            <button
              type="button"
              className="btn-xs"
              onClick={() => switchWorkspace('production')}
              data-testid="storyboard-next-production-btn"
            >
              {t('pipeline.nextProductionPlan')}
            </button>
          )}
        </div>
      </div>

      {/* Explicit Confirmation Banner for Replacing Entire Scene (including Locked Shots) */}
      {confirmReplaceSceneModal && activeScene && (
        <div className="sb-confirm-bar" data-testid="storyboard-replace-confirm-bar">
          <AlertTriangle size={14} color="var(--warning)" style={{ flexShrink: 0 }} />
          <div style={{ flex: 1, fontSize: 11 }}>
            <strong>{t('storyboard.confirmReplaceTitle', { title: activeScene.title })}</strong>{' '}
            {t('storyboard.confirmReplaceDesc', { locked: lockedInSceneCount })}
          </div>
          <button
            type="button"
            className="btn-xs btn-danger"
            disabled={generating}
            onClick={() => void handleGenerateActiveScene('replace_all', true)}
            data-testid="storyboard-confirm-replace-yes"
          >
            {t('storyboard.confirmReplaceYesBtn')}
          </button>
          <button
            type="button"
            className="btn-xs"
            onClick={() => setConfirmReplaceSceneModal(false)}
          >
            {t('common.cancel')}
          </button>
        </div>
      )}

      {/* Main Split: Grid + Timeline on Left, Shot Inspector on Right */}
      {sceneShots.length === 0 ? (
        <div className="director-empty-workspace" data-testid="storyboard-empty-state">
          <div className="director-empty-card">
            <LayoutGrid size={34} color="var(--accent-text)" />
            <h3>{t('storyboard.emptyTitle')}</h3>
            <p>{t('storyboard.emptySubtitle')}</p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
              {activeScene && (
                <>
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={generating}
                    onClick={() => void handleGenerateActiveScene('preserve_locked', false)}
                  >
                    <Sparkles size={13} /> {t('storyboard.genSceneBtn')}
                  </button>
                  <button type="button" onClick={handleAddShot}>
                    <Plus size={13} /> {t('storyboard.addManualShotBtn')}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="sb-main-split">
          {/* Left/Center Column: Continuity Drawer + Shot Cards Grid + Scene Timeline Strip */}
          <div className="sb-board-col">
            {showContinuityDrawer && (
              <div className="sb-continuity-drawer" data-testid="storyboard-continuity-drawer">
                <div className="director-tier-title" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <ShieldAlert size={12} color="var(--warning)" />
                    {t('storyboard.continuityPanelTitle', { count: sceneWarnings.length })}
                  </span>
                  <button
                    type="button"
                    className="btn-ghost btn-xs"
                    onClick={() => setShowContinuityDrawer(false)}
                  >
                    <X size={12} />
                  </button>
                </div>
                {sceneWarnings.length === 0 ? (
                  <div className="director-callout success">
                    <CheckCircle2 size={12} /> {t('storyboard.noContinuityIssues')}
                  </div>
                ) : (
                  <div className="sb-continuity-list">
                    {sceneWarnings.map((w) => {
                      const sh = sceneShots.find((s) => s.shot_id === w.shot_id);
                      return (
                        <div
                          key={w.warning_id}
                          className={`sb-continuity-item ${w.severity}`}
                          data-testid={`continuity-warning-${w.category}`}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span className={`director-badge ${w.severity === 'error' ? 'rejected' : w.severity === 'warning' ? 'warning' : 'pending'}`}>
                              {w.category}
                            </span>
                            <strong style={{ fontSize: 11, flex: 1 }}>{w.title}</strong>
                            {sh && (
                              <button
                                type="button"
                                className="btn-xs"
                                onClick={() => {
                                  setActiveSceneId(w.scene_id);
                                  setSelectedShotId(w.shot_id);
                                }}
                              >
                                {t('storyboard.jumpToShot', { num: sh.shot_order })}
                              </button>
                            )}
                            <button
                              type="button"
                              className={`btn-xs ${w.reviewed ? 'btn-primary' : ''}`}
                              title={t('storyboard.markReviewedBtn')}
                              onClick={() =>
                                markStoryboardContinuityWarning(w.warning_id, {
                                  reviewed: !w.reviewed,
                                })
                              }
                            >
                              <Check size={10} />
                            </button>
                            <button
                              type="button"
                              className="btn-xs"
                              title={t('storyboard.dismissWarningBtn')}
                              onClick={() =>
                                markStoryboardContinuityWarning(w.warning_id, { dismissed: true })
                              }
                            >
                              <X size={10} />
                            </button>
                          </div>
                          <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 3 }}>
                            {w.description}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Shot Cards Grid */}
            <div className="sb-grid-scroll">
              <div className="sb-shot-grid" data-testid="storyboard-shot-grid">
                {sceneShots.map((sh, idx) => {
                  const isSel = selectedShot?.shot_id === sh.shot_id;
                  const warnCount = warningsByShotId.get(sh.shot_id) ?? 0;
                  const supportClass =
                    sh.camera_support_status === 'supported'
                      ? 'accepted'
                      : sh.camera_support_status === '2d_approximation'
                        ? 'warning'
                        : 'rejected';

                  return (
                    <div
                      key={sh.shot_id}
                      className={`sb-shot-card ${isSel ? 'selected' : ''} ${sh.locked ? 'locked' : ''}`}
                      data-testid={`storyboard-shot-card-${sh.shot_order}`}
                      onClick={() => setSelectedShotId(sh.shot_id)}
                    >
                      <ShotCompositionPreview shot={sh} compact />

                      <div className="sb-shot-card-body">
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          <span className="mono" style={{ fontSize: 10, fontWeight: 700, color: 'var(--accent-text)' }}>
                            #{String(sh.shot_order).padStart(2, '0')}
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
                            {sh.title}
                          </strong>
                          <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                            {(sh.duration_ms / 1000).toFixed(1)}s
                          </span>
                        </div>

                        <div className="director-chip-row" style={{ marginTop: 4 }}>
                          <span className="director-badge pending">
                            {t(`storyboard.size.${sh.shot_size}`)}
                          </span>
                          <span className="director-badge pending">
                            {t(`storyboard.angle.${sh.camera_angle}`)}
                          </span>
                          <span className={`director-badge ${supportClass}`} title={sh.camera_support_note}>
                            {t(`storyboard.move.${sh.camera_movement}`)}
                          </span>
                        </div>

                        {sh.characters.length > 0 && (
                          <div className="sb-card-meta-line">
                            <Users size={10} style={{ flexShrink: 0 }} />
                            <span>{sh.characters.map((c) => c.character_name).join(', ')}</span>
                          </div>
                        )}

                        {(sh.purpose || sh.characters[0]?.action) && (
                          <div className="sb-card-action-excerpt">
                            {sh.characters.find((c) => c.action)?.action || sh.purpose}
                          </div>
                        )}
                      </div>

                      <div
                        className="sb-shot-card-footer"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          className={`btn-xs ${sh.locked ? 'btn-primary' : ''}`}
                          title={sh.locked ? t('storyboard.unlockShotTip') : t('storyboard.lockShotTip')}
                          data-testid={`storyboard-lock-shot-${sh.shot_order}`}
                          onClick={() => toggleLockStoryboardShot(sh.shot_id)}
                        >
                          {sh.locked ? <Lock size={10} /> : <Unlock size={10} />}
                        </button>
                        <button
                          type="button"
                          className="btn-xs"
                          title={t('storyboard.duplicateShotTip')}
                          data-testid={`storyboard-dup-shot-${sh.shot_order}`}
                          onClick={() => {
                            const cid = duplicateStoryboardShot(sh.shot_id);
                            if (cid) setSelectedShotId(cid);
                          }}
                        >
                          <Copy size={10} />
                        </button>
                        <button
                          type="button"
                          className="btn-xs"
                          disabled={idx === 0}
                          title={t('storyboard.moveShotPrev')}
                          onClick={() => moveStoryboardShot(sh.shot_id, -1)}
                        >
                          <ArrowLeft size={10} />
                        </button>
                        <button
                          type="button"
                          className="btn-xs"
                          disabled={idx === sceneShots.length - 1}
                          title={t('storyboard.moveShotNext')}
                          onClick={() => moveStoryboardShot(sh.shot_id, 1)}
                        >
                          <ArrowRight size={10} />
                        </button>
                        <div style={{ flex: 1 }} />
                        {warnCount > 0 && (
                          <span
                            className="director-badge warning"
                            title={t('storyboard.continuityShortBtn', { count: warnCount })}
                          >
                            <AlertTriangle size={9} /> {warnCount}
                          </span>
                        )}
                        <button
                          type="button"
                          className="btn-xs btn-danger"
                          title={t('common.delete')}
                          onClick={() => deleteStoryboardShot(sh.shot_id)}
                        >
                          <Trash2 size={10} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Proportional Scene Shot Timeline Strip */}
            <div className="sb-timeline-strip" data-testid="storyboard-timeline-strip">
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>
                <span>{t('storyboard.sceneShotTimelineLabel')}</span>
                <span className="mono">
                  0.0s → {(totalSceneShotMs / 1000).toFixed(1)}s ({sceneShots.length}{' '}
                  {t('storyboard.shotsShort')})
                </span>
              </div>
              <div className="sb-timeline-bar">
                {sceneShots.map((sh) => {
                  const pct = totalSceneShotMs > 0 ? (sh.duration_ms / totalSceneShotMs) * 100 : 100 / sceneShots.length;
                  const isSel = selectedShot?.shot_id === sh.shot_id;
                  return (
                    <button
                      key={sh.shot_id}
                      type="button"
                      className={`sb-timeline-block ${isSel ? 'selected' : ''} ${sh.locked ? 'locked' : ''}`}
                      style={{ width: `${Math.max(8, pct)}%` }}
                      title={`#${sh.shot_order} ${sh.title} (${(sh.start_time_ms / 1000).toFixed(1)}s–${(sh.end_time_ms / 1000).toFixed(1)}s)`}
                      onClick={() => setSelectedShotId(sh.shot_id)}
                    >
                      <span className="mono" style={{ fontWeight: 700 }}>
                        #{sh.shot_order}
                      </span>
                      <span className="sb-timeline-block-dur mono">
                        {(sh.duration_ms / 1000).toFixed(1)}s
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Right Column: Detailed Shot Inspector */}
          <aside className="sb-inspector-col" data-testid="storyboard-shot-inspector">
            {selectedShot ? (
              <div className="sb-inspector-scroll">
                <div className="sb-inspector-header">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span className="mono" style={{ fontWeight: 700, color: 'var(--accent-text)' }}>
                      {t('storyboard.shotNumberTitle', { num: selectedShot.shot_order })}
                    </span>
                    <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                      {(selectedShot.start_time_ms / 1000).toFixed(1)}s–
                      {(selectedShot.end_time_ms / 1000).toFixed(1)}s
                    </span>
                    {selectedShot.locked && (
                      <span className="director-badge edited">
                        <Lock size={9} /> {t('storyboard.lockedBadge')}
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button
                      type="button"
                      className={`btn-xs ${selectedShot.locked ? 'btn-primary' : ''}`}
                      onClick={() => toggleLockStoryboardShot(selectedShot.shot_id)}
                      data-testid="storyboard-inspector-lock-btn"
                    >
                      {selectedShot.locked ? <Lock size={11} /> : <Unlock size={11} />}
                    </button>
                    <button
                      type="button"
                      className="btn-xs"
                      disabled={!selectedShot.original_ai_snapshot}
                      title={t('storyboard.restoreShotTip')}
                      onClick={() => {
                        restoreOriginalStoryboardShot(selectedShot.shot_id);
                        pushToast('info', t('storyboard.shotRestoredToast'));
                      }}
                    >
                      <RotateCcw size={11} />
                    </button>
                  </div>
                </div>

                {/* Live 2D Schematic Composition Preview */}
                <ShotCompositionPreview shot={selectedShot} />

                {/* 1. Core Shot Info & Duration */}
                <div className="inspector-section" style={{ marginTop: 8 }}>
                  <div className="inspector-section-title">
                    <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <Film size={12} color="var(--accent-text)" /> {t('storyboard.shotDetailsSection')}
                    </span>
                  </div>
                  <div className="field-row">
                    <label className="field-label">{t('storyboard.shotTitleLabel')}</label>
                    <input
                      data-testid="storyboard-shot-title-input"
                      value={selectedShot.title}
                      onChange={(e) =>
                        editStoryboardShot(selectedShot.shot_id, { title: e.target.value })
                      }
                    />
                  </div>
                  <div className="field-row">
                    <label className="field-label">{t('storyboard.shotPurposeLabel')}</label>
                    <textarea
                      rows={2}
                      value={selectedShot.purpose}
                      onChange={(e) =>
                        editStoryboardShot(selectedShot.shot_id, { purpose: e.target.value })
                      }
                    />
                  </div>
                  <div className="field-grid">
                    <div className="field-row">
                      <label className="field-label">{t('storyboard.durationSecLabel')}</label>
                      <input
                        type="number"
                        step={0.1}
                        min={0.5}
                        max={60}
                        data-testid="storyboard-shot-duration-input"
                        value={Number((selectedShot.duration_ms / 1000).toFixed(1))}
                        onChange={(e) => {
                          const sec = Number(e.target.value);
                          if (!Number.isNaN(sec) && sec >= 0.5) {
                            editStoryboardShot(selectedShot.shot_id, {
                              duration_ms: Math.round(sec * 1000),
                            });
                          }
                        }}
                      />
                    </div>
                    <div className="field-row">
                      <label className="field-label">{t('storyboard.transitionOutLabel')}</label>
                      <select
                        value={selectedShot.transition_out}
                        onChange={(e) =>
                          editStoryboardShot(selectedShot.shot_id, {
                            transition_out: e.target.value as ShotTransition,
                          })
                        }
                      >
                        {SHOT_TRANSITIONS.map((tr) => (
                          <option key={tr} value={tr}>
                            {t(`storyboard.trans.${tr}`)}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="field-grid">
                    <div className="field-row">
                      <label className="field-label">{t('storyboard.visualFocusLabel')}</label>
                      <input
                        value={selectedShot.visual_focus}
                        onChange={(e) =>
                          editStoryboardShot(selectedShot.shot_id, { visual_focus: e.target.value })
                        }
                      />
                    </div>
                    <div className="field-row">
                      <label className="field-label">{t('storyboard.emotionalEmphasisLabel')}</label>
                      <input
                        value={selectedShot.emotional_emphasis}
                        onChange={(e) =>
                          editStoryboardShot(selectedShot.shot_id, {
                            emotional_emphasis: e.target.value,
                          })
                        }
                      />
                    </div>
                  </div>
                  <div className="field-row">
                    <label className="field-label">{t('storyboard.environmentLabel')}</label>
                    <input
                      value={selectedShot.environment}
                      onChange={(e) =>
                        editStoryboardShot(selectedShot.shot_id, { environment: e.target.value })
                      }
                    />
                  </div>
                  <div className="field-row">
                    <label className="field-label">{t('storyboard.aiRationaleLabel')}</label>
                    <textarea
                      rows={2}
                      value={selectedShot.ai_rationale}
                      onChange={(e) =>
                        editStoryboardShot(selectedShot.shot_id, { ai_rationale: e.target.value })
                      }
                    />
                  </div>
                </div>

                {/* 2. Camera Direction & Honest 2D Feasibility */}
                <div className="inspector-section">
                  <div className="inspector-section-title">
                    <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <Camera size={12} color="var(--accent-text)" /> {t('storyboard.cameraSectionTitle')}
                    </span>
                    <span
                      className={`director-badge ${
                        selectedShot.camera_support_status === 'supported'
                          ? 'accepted'
                          : selectedShot.camera_support_status === '2d_approximation'
                            ? 'warning'
                            : 'rejected'
                      }`}
                      data-testid="storyboard-camera-support-badge"
                    >
                      {t(`storyboard.camSupport.${selectedShot.camera_support_status}`)}
                    </span>
                  </div>

                  <div className="field-row">
                    <label className="field-label">{t('storyboard.shotSizeLabel')}</label>
                    <select
                      data-testid="storyboard-shot-size-select"
                      value={selectedShot.shot_size}
                      onChange={(e) =>
                        editStoryboardShot(selectedShot.shot_id, {
                          shot_size: e.target.value as ShotSize,
                        })
                      }
                    >
                      {SHOT_SIZES.map((sz) => (
                        <option key={sz} value={sz}>
                          {t(`storyboard.size.${sz}`)}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="field-row">
                    <label className="field-label">{t('storyboard.cameraAngleLabel')}</label>
                    <select
                      data-testid="storyboard-camera-angle-select"
                      value={selectedShot.camera_angle}
                      onChange={(e) =>
                        editStoryboardShot(selectedShot.shot_id, {
                          camera_angle: e.target.value as CameraAngle,
                        })
                      }
                    >
                      {CAMERA_ANGLES.map((ang) => (
                        <option key={ang} value={ang}>
                          {t(`storyboard.angle.${ang}`)}
                        </option>
                      ))}
                    </select>
                    {selectedShot.camera_angle_note && (
                      <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                        {selectedShot.camera_angle_note}
                      </span>
                    )}
                  </div>

                  <div className="field-row">
                    <label className="field-label">{t('storyboard.cameraMovementLabel')}</label>
                    <select
                      data-testid="storyboard-camera-move-select"
                      value={selectedShot.camera_movement}
                      onChange={(e) =>
                        editStoryboardShot(selectedShot.shot_id, {
                          camera_movement: e.target.value as CameraMovement,
                        })
                      }
                    >
                      {CAMERA_MOVEMENTS.map((mv) => (
                        <option key={mv} value={mv}>
                          {t(`storyboard.move.${mv}`)}
                        </option>
                      ))}
                    </select>
                    <div
                      className={`director-callout ${
                        selectedShot.camera_support_status === 'supported'
                          ? 'success'
                          : selectedShot.camera_support_status === '2d_approximation'
                            ? 'warning'
                            : 'error'
                      }`}
                      style={{ marginTop: 4, fontSize: 10 }}
                    >
                      <span>{selectedShot.camera_support_note}</span>
                    </div>
                  </div>
                </div>

                {/* 3. Character Staging Editor */}
                <div className="inspector-section">
                  <div className="inspector-section-title">
                    <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <Users size={12} color="var(--accent-text)" />{' '}
                      {t('storyboard.stagingSectionTitle', { count: selectedShot.characters.length })}
                    </span>
                  </div>

                  <div style={{ display: 'flex', gap: 5, marginBottom: 8 }}>
                    <select
                      style={{ flex: 1 }}
                      value={stageCharChoice}
                      onChange={(e) => setStageCharChoice(e.target.value)}
                    >
                      <option value="">{t('storyboard.addCharToShotPlaceholder')}</option>
                      {availableCharacterChoices.map((ch) => (
                        <option key={ch.key} value={ch.key}>
                          {ch.name} {ch.libraryCharacterId ? '' : `(${t('storyboard.unlinkedShort')})`}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn-xs"
                      disabled={!stageCharChoice}
                      onClick={handleStageCharacter}
                    >
                      <UserPlus size={11} /> {t('common.add')}
                    </button>
                  </div>

                  {selectedShot.characters.length === 0 ? (
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {t('storyboard.noStagedCharacters')}
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {selectedShot.characters.map((st) => (
                        <div key={st.staging_id} className="sb-staging-card">
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                            <strong style={{ fontSize: 11, flex: 1 }}>{st.character_name}</strong>
                            {st.is_missing_asset && (
                              <span className="director-badge warning">
                                {t('storyboard.missingAssetBadge')}
                              </span>
                            )}
                            <button
                              type="button"
                              className="btn-ghost btn-xs"
                              onClick={() =>
                                removeShotCharacter(selectedShot.shot_id, st.staging_id)
                              }
                            >
                              <Trash2 size={10} />
                            </button>
                          </div>

                          {/* Link to existing library character */}
                          <div className="field-row" style={{ marginBottom: 5 }}>
                            <select
                              style={{ fontSize: 10 }}
                              value={st.library_character_id ?? ''}
                              onChange={(e) =>
                                updateShotCharacter(
                                  selectedShot.shot_id,
                                  st.staging_id,
                                  { library_character_id: e.target.value || null },
                                  libraryCharacters,
                                )
                              }
                            >
                              <option value="">{t('director.unlinkedOption')}</option>
                              {libraryCharacters.map((lc) => (
                                <option key={lc.character_id} value={lc.character_id}>
                                  {lc.name}
                                </option>
                              ))}
                            </select>
                          </div>

                          <div className="sb-staging-toggles">
                            <label>
                              <input
                                type="checkbox"
                                checked={st.visible}
                                onChange={(e) =>
                                  updateShotCharacter(selectedShot.shot_id, st.staging_id, {
                                    visible: e.target.checked,
                                  })
                                }
                              />
                              <Eye size={10} /> {t('storyboard.visibleLabel')}
                            </label>
                            <label>
                              <input
                                type="checkbox"
                                checked={st.speaking}
                                onChange={(e) =>
                                  updateShotCharacter(selectedShot.shot_id, st.staging_id, {
                                    speaking: e.target.checked,
                                  })
                                }
                              />
                              {t('storyboard.speakingLabel')}
                            </label>
                            <label>
                              <input
                                type="checkbox"
                                checked={st.reacting}
                                onChange={(e) =>
                                  updateShotCharacter(selectedShot.shot_id, st.staging_id, {
                                    reacting: e.target.checked,
                                  })
                                }
                              />
                              {t('storyboard.reactingLabel')}
                            </label>
                          </div>

                          <div className="field-grid" style={{ gridTemplateColumns: '1fr 1fr 1fr', marginTop: 5 }}>
                            <select
                              style={{ fontSize: 10 }}
                              data-testid={`staging-pos-${st.character_name}`}
                              value={st.screen_position}
                              onChange={(e) =>
                                updateShotCharacter(selectedShot.shot_id, st.staging_id, {
                                  screen_position: e.target.value as ScreenPosition,
                                })
                              }
                            >
                              {SCREEN_POSITIONS.map((p) => (
                                <option key={p} value={p}>
                                  {p}
                                </option>
                              ))}
                            </select>
                            <select
                              style={{ fontSize: 10 }}
                              value={st.depth_layer}
                              onChange={(e) =>
                                updateShotCharacter(selectedShot.shot_id, st.staging_id, {
                                  depth_layer: e.target.value as DepthLayer,
                                })
                              }
                            >
                              {DEPTH_LAYERS.map((d) => (
                                <option key={d} value={d}>
                                  {d}
                                </option>
                              ))}
                            </select>
                            <select
                              style={{ fontSize: 10 }}
                              value={st.facing_direction}
                              onChange={(e) =>
                                updateShotCharacter(selectedShot.shot_id, st.staging_id, {
                                  facing_direction: e.target.value as FacingDirection,
                                })
                              }
                            >
                              {FACING_DIRECTIONS.map((f) => (
                                <option key={f} value={f}>
                                  {f}
                                </option>
                              ))}
                            </select>
                          </div>

                          <div className="field-grid" style={{ marginTop: 5 }}>
                            <input
                              style={{ fontSize: 10 }}
                              placeholder={t('storyboard.charExpressionPlaceholder')}
                              value={st.expression}
                              onChange={(e) =>
                                updateShotCharacter(selectedShot.shot_id, st.staging_id, {
                                  expression: e.target.value,
                                })
                              }
                            />
                            <input
                              style={{ fontSize: 10 }}
                              placeholder={t('storyboard.charMovementPlaceholder')}
                              value={st.movement}
                              onChange={(e) =>
                                updateShotCharacter(selectedShot.shot_id, st.staging_id, {
                                  movement: e.target.value,
                                })
                              }
                            />
                          </div>
                          <input
                            style={{ fontSize: 10, marginTop: 4 }}
                            placeholder={t('storyboard.charActionPlaceholder')}
                            value={st.action}
                            onChange={(e) =>
                              updateShotCharacter(selectedShot.shot_id, st.staging_id, {
                                action: e.target.value,
                              })
                            }
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* 4. Grounded Dialogue & Narration References */}
                {(selectedShot.dialogue_refs.length > 0 || selectedShot.narration_refs.length > 0) && (
                  <div className="inspector-section">
                    <div className="inspector-section-title">
                      <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <MessageSquareQuote size={12} color="var(--accent-text)" />{' '}
                        {t('storyboard.scriptRefsSection')}
                      </span>
                    </div>
                    <div className="director-mini-lines">
                      {[...selectedShot.dialogue_refs, ...selectedShot.narration_refs].map((r) => (
                        <div key={r.ref_id} className="director-mini-line">
                          <span className="director-badge pending">{r.item_type}</span>
                          {r.speaker_name && (
                            <strong style={{ color: 'var(--accent-text)' }}>{r.speaker_name}:</strong>
                          )}
                          <span>{r.text_excerpt}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* 5. Regenerate Selected Shot (Preserving User Edits) */}
                <div className="inspector-section">
                  <div className="inspector-section-title">
                    <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <RefreshCw size={12} color="var(--accent-text)" />{' '}
                      {t('storyboard.regenShotSectionTitle')}
                    </span>
                  </div>
                  {selectedShot.user_edited_fields.length > 0 && (
                    <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 5 }}>
                      {t('director.protectedFieldsLabel')}:{' '}
                      <span className="mono">{selectedShot.user_edited_fields.join(', ')}</span>
                    </div>
                  )}
                  <input
                    placeholder={t('storyboard.regenShotInstructionsPlaceholder')}
                    value={regenShotInstructions}
                    onChange={(e) => setRegenShotInstructions(e.target.value)}
                  />
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 5,
                      fontSize: 11,
                      marginTop: 5,
                      marginBottom: 6,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={preserveEditsOnRegen}
                      onChange={(e) => setPreserveEditsOnRegen(e.target.checked)}
                    />
                    <span>{t('director.preserveUserEditsLabel')}</span>
                  </label>
                  <button
                    type="button"
                    style={{ width: '100%' }}
                    disabled={
                      selectedShot.locked || regeneratingShotId === selectedShot.shot_id
                    }
                    onClick={() => void handleRegenerateSelectedShot()}
                    data-testid="storyboard-regen-shot-btn"
                  >
                    {regeneratingShotId === selectedShot.shot_id ? (
                      <Loader2 size={12} className="spin" />
                    ) : (
                      <RefreshCw size={12} />
                    )}
                    {selectedShot.locked
                      ? t('storyboard.lockedCannotRegenBtn')
                      : t('storyboard.regenShotBtn')}
                  </button>
                </div>
              </div>
            ) : (
              <div className="director-empty-inline">{t('storyboard.selectShotHint')}</div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
