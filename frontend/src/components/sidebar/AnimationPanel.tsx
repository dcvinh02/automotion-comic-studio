import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  Check,
  Copy,
  Diamond,
  Edit3,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Save,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Users,
  Wand2,
  X,
} from 'lucide-react';
import {
  checkPresetCompatibilityLocal,
  inspectCharacterCapabilitiesLocal,
} from '@/engine/animationExecutionEngine';
import { findActiveScene, frameToMs, msToFrame } from '@/engine/evaluator';
import { findActiveShotInScene } from '@/engine/sceneExecutionEngine';
import { useI18n } from '@/i18n/useLocaleStore';
import { apiClient } from '@/services/apiClient';
import { useAnimationExecStore } from '@/stores/useAnimationExecStore';
import { useJobStore } from '@/stores/useJobStore';
import { useLibraryStore } from '@/stores/useLibraryStore';
import { usePlaybackStore } from '@/stores/usePlaybackStore';
import { useProjectStore } from '@/stores/useProjectStore';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';
import type {
  CameraMovement,
  EasingType,
  MotionDirection,
  MotionParameters,
  MotionPreset,
} from '@/types/models';
import { EmptyState, formatTimecode } from '@/components/common/CommonUI';
import { CollapsibleSection } from '@/components/ui/CollapsibleSection';
import { SearchInput } from '@/components/ui/SearchInput';

const EASING_OPTIONS: EasingType[] = ['hold', 'linear', 'ease_in', 'ease_out', 'ease_in_out'];
const DIRECTION_OPTIONS: MotionDirection[] = [
  'right',
  'left',
  'up',
  'down',
  'forward',
  'backward',
  'in_place',
];
const CAMERA_MOVEMENT_OPTIONS: CameraMovement[] = [
  'static',
  'pan_left',
  'pan_right',
  'tilt_up',
  'tilt_down',
  'zoom_in',
  'zoom_out',
  'dolly_in',
  'dolly_out',
  'shake',
  'tracking',
  'camera_follow',
  'parallax',
];

export function AnimationPanel() {
  const { t } = useI18n();
  const project = useProjectStore((s) => s.project);
  const selection = useProjectStore((s) => s.selection);
  const selectedKeyframeIds = useProjectStore((s) => s.selectedKeyframeIds);
  const mutateProject = useProjectStore((s) => s.mutateProject);
  const applyExecutedProjectState = useProjectStore((s) => s.applyExecutedProjectState);
  const saveProject = useProjectStore((s) => s.saveProject);
  const deleteKeyframe = useProjectStore((s) => s.deleteKeyframe);
  const deleteAnimationClip = useProjectStore((s) => s.deleteAnimationClip);
  const setSelection = useProjectStore((s) => s.setSelection);
  const selectKeyframe = useProjectStore((s) => s.selectKeyframe);

  const characters = useLibraryStore((s) => s.characters);
  const motionPresets = useLibraryStore((s) => s.motionPresets);
  const upsertMotionPreset = useLibraryStore((s) => s.upsertMotionPreset);
  const removeMotionPreset = useLibraryStore((s) => s.removeMotionPreset);

  const isPlaying = usePlaybackStore((s) => s.isPlaying);
  const currentFrame = usePlaybackStore((s) => s.currentFrame);
  const setPlaying = usePlaybackStore((s) => s.setPlaying);
  const setCurrentFrame = usePlaybackStore((s) => s.setCurrentFrame);

  const setCenterMode = useWorkspaceStore((s) => s.setCenterMode);
  const pushToast = useJobStore((s) => s.pushToast);

  const previewOverlay = useAnimationExecStore((s) => s.previewOverlay);
  const previewResponse = useAnimationExecStore((s) => s.previewResponse);
  const previewTargetKind = useAnimationExecStore((s) => s.previewTargetKind);
  const previewPresetId = useAnimationExecStore((s) => s.previewPresetId);
  const previewInstanceId = useAnimationExecStore((s) => s.previewInstanceId);
  const previewParams = useAnimationExecStore((s) => s.previewParams);
  const previewCameraParams = useAnimationExecStore((s) => s.previewCameraParams);
  const syncCameraFollow = useAnimationExecStore((s) => s.syncCameraFollow);
  const previewReturnFrame = useAnimationExecStore((s) => s.previewReturnFrame);
  const previewLoading = useAnimationExecStore((s) => s.previewLoading);
  const previewError = useAnimationExecStore((s) => s.previewError);

  const setPreviewOverlay = useAnimationExecStore((s) => s.setPreviewOverlay);
  const setPreviewTarget = useAnimationExecStore((s) => s.setPreviewTarget);
  const updatePreviewParams = useAnimationExecStore((s) => s.updatePreviewParams);
  const updatePreviewCameraParams = useAnimationExecStore((s) => s.updatePreviewCameraParams);
  const setSyncCameraFollow = useAnimationExecStore((s) => s.setSyncCameraFollow);
  const setPreviewLoading = useAnimationExecStore((s) => s.setPreviewLoading);
  const setPreviewError = useAnimationExecStore((s) => s.setPreviewError);
  const clearPreview = useAnimationExecStore((s) => s.clearPreview);
  const openAnimationExecModal = useAnimationExecStore((s) => s.openAnimationExecModal);

  const [query, setQuery] = useState('');
  const [presetQuery, setPresetQuery] = useState('');
  const [savingPresetName, setSavingPresetName] = useState('');
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [renamingPresetId, setRenamingPresetId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [applying, setApplying] = useState(false);

  const fps = project?.timeline.fps ?? 30;
  const activeScene = useMemo(() => {
    if (!project) return null;
    return findActiveScene(project.scenes, frameToMs(currentFrame, fps)) ?? project.scenes[0] ?? null;
  }, [project, currentFrame, fps]);

  const activeShot = useMemo(() => {
    if (!activeScene) return null;
    return findActiveShotInScene(activeScene, frameToMs(currentFrame, fps));
  }, [activeScene, currentFrame, fps]);

  const sceneCharInstances = activeScene?.characters ?? [];
  const effectiveInstanceId = useMemo(() => {
    if (
      selection.type === 'character' &&
      selection.id &&
      sceneCharInstances.some((c) => c.instance_id === selection.id)
    ) {
      return selection.id;
    }
    if (previewInstanceId && sceneCharInstances.some((c) => c.instance_id === previewInstanceId)) {
      return previewInstanceId;
    }
    if (activeShot && activeShot.character_states.length > 0) {
      return activeShot.character_states[0].instance_id;
    }
    return sceneCharInstances[0]?.instance_id ?? null;
  }, [selection, previewInstanceId, sceneCharInstances, activeShot]);

  const activeInstance = useMemo(
    () => sceneCharInstances.find((c) => c.instance_id === effectiveInstanceId) ?? null,
    [sceneCharInstances, effectiveInstanceId],
  );
  const activeCharacter = useMemo(
    () =>
      activeInstance
        ? characters.find((c) => c.character_id === activeInstance.character_id) ?? null
        : null,
    [characters, activeInstance],
  );
  const activeCaps = useMemo(
    () => inspectCharacterCapabilitiesLocal(activeCharacter),
    [activeCharacter],
  );

  const selectedPreset = useMemo(
    () => motionPresets.find((p) => p.preset_id === previewPresetId) ?? motionPresets[0] ?? null,
    [motionPresets, previewPresetId],
  );

  // Ensure initial preset selection once Motion Library loads
  useEffect(() => {
    if (previewTargetKind === 'character' && !previewPresetId && motionPresets.length > 0) {
      setPreviewTarget(
        'character',
        motionPresets[0].preset_id,
        effectiveInstanceId,
        motionPresets[0].default_parameters,
      );
    }
  }, [motionPresets, previewPresetId, previewTargetKind, effectiveInstanceId, setPreviewTarget]);

  if (!project) {
    return (
      <EmptyState
        title={t('stage.noProjectTitle')}
        description={t('stage.noProjectDesc')}
      />
    );
  }

  const runLivePreview = async (
    overrides?: {
      targetKind?: 'character' | 'camera';
      preset?: MotionPreset | null;
      instanceId?: string | null;
      params?: MotionParameters;
      autoPlay?: boolean;
    },
  ) => {
    if (!activeScene) return;
    const tKind = overrides?.targetKind ?? previewTargetKind;
    const chosenPreset = overrides?.preset !== undefined ? overrides.preset : selectedPreset;
    const instId = overrides?.instanceId !== undefined ? overrides.instanceId : effectiveInstanceId;
    const params = overrides?.params ?? previewParams;

    if (tKind === 'character' && (!instId || !chosenPreset)) {
      setPreviewError(t('motionExec.selectCharAndPreset'));
      return;
    }

    setPreviewLoading(true);
    setPreviewError(null);
    setCenterMode('stage');
    try {
      if (useProjectStore.getState().isDirty) {
        await saveProject(false);
      }
      const res = await apiClient.previewMotion(project.meta.project_id, {
        scene_id: activeScene.scene_id,
        shot_id: activeShot?.shot_id ?? null,
        target_kind: tKind,
        instance_id: tKind === 'character' ? instId : null,
        preset_id: tKind === 'character' ? chosenPreset?.preset_id ?? null : null,
        start_time_ms: activeShot ? null : Math.round(frameToMs(currentFrame, fps)),
        parameters: params,
        camera_parameters: tKind === 'camera' ? previewCameraParams : null,
        sync_camera_follow: tKind === 'character' ? syncCameraFollow : false,
      });

      if (!res.compatible || res.errors.length > 0) {
        setPreviewOverlay(null, res);
        setPreviewError(res.errors[0] || t('motionExec.incompatibleRig'));
        setPlaying(false);
        return;
      }

      const prevReturn = previewReturnFrame ?? currentFrame;
      setPreviewOverlay(
        {
          projectId: project.meta.project_id,
          sceneId: activeScene.scene_id,
          shotId: activeShot?.shot_id ?? null,
          targetKind: tKind,
          instanceId: tKind === 'character' ? instId : null,
          presetId: tKind === 'character' ? chosenPreset?.preset_id ?? null : null,
          startMs: res.start_ms,
          endMs: res.end_ms,
          loop: params.loop,
          keyframes: res.keyframes,
          animationClips: res.animation_clips,
        },
        res,
        prevReturn,
      );
      setCurrentFrame(msToFrame(res.start_ms, fps));
      if (overrides?.autoPlay !== false) {
        setPlaying(true);
      }
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : t('motionExec.previewFailed'));
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleCancelPreview = () => {
    setPlaying(false);
    if (previewReturnFrame !== null) {
      setCurrentFrame(previewReturnFrame);
    }
    clearPreview();
  };

  const handleStopPreview = () => {
    setPlaying(false);
    if (previewOverlay) {
      setCurrentFrame(msToFrame(previewOverlay.startMs, fps));
    }
  };

  const handleResetParams = () => {
    if (previewTargetKind === 'character' && selectedPreset) {
      updatePreviewParams({ ...selectedPreset.default_parameters });
      if (previewOverlay) {
        void runLivePreview({ params: { ...selectedPreset.default_parameters }, autoPlay: false });
      }
    }
  };

  const handleApplyMotion = async (
    overridePreset?: MotionPreset,
  ) => {
    if (!activeScene || applying) return;
    const tKind = overridePreset ? 'character' : previewTargetKind;
    const chosenPreset = overridePreset ?? selectedPreset;
    const params = overridePreset ? overridePreset.default_parameters : previewParams;

    if (tKind === 'character' && (!effectiveInstanceId || !chosenPreset)) {
      pushToast('warning', t('motionExec.selectCharAndPreset'));
      return;
    }

    setApplying(true);
    setPreviewError(null);
    try {
      if (useProjectStore.getState().isDirty) {
        await saveProject(false);
      }
      const res = await apiClient.applyMotion(project.meta.project_id, {
        scene_id: activeScene.scene_id,
        shot_id: activeShot?.shot_id ?? null,
        target_kind: tKind,
        instance_id: tKind === 'character' ? effectiveInstanceId : null,
        preset_id: tKind === 'character' ? chosenPreset?.preset_id ?? null : null,
        start_time_ms: activeShot ? null : Math.round(frameToMs(currentFrame, fps)),
        parameters: params,
        camera_parameters: tKind === 'camera' ? previewCameraParams : null,
        sync_camera_follow: tKind === 'character' ? syncCameraFollow : false,
        allow_partial: true,
      });

      if (!res.applied || !res.updated_project) {
        const msg = res.errors[0] || t('motionExec.incompatibleRig');
        setPreviewError(msg);
        pushToast('error', msg);
        return;
      }

      setPlaying(false);
      clearPreview();
      applyExecutedProjectState(res.updated_project, true);
      pushToast(
        'success',
        t('motionExec.appliedSingleToast', {
          name:
            tKind === 'camera'
              ? `Camera (${previewCameraParams.movement})`
              : chosenPreset?.name ?? '',
          kfs: res.keyframes_written,
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('motionExec.executeFailed');
      setPreviewError(msg);
      pushToast('error', msg);
    } finally {
      setApplying(false);
    }
  };

  const handleSaveCustomPreset = async () => {
    const cleanName = savingPresetName.trim();
    if (!cleanName || !selectedPreset) return;
    try {
      const created = await apiClient.createMotionPreset({
        name: cleanName,
        category: selectedPreset.category,
        description: selectedPreset.description,
        base_preset_id: selectedPreset.preset_id,
        default_parameters: { ...previewParams },
        tags: ['custom', selectedPreset.category],
      });
      upsertMotionPreset(created);
      setSavingPresetName('');
      setShowSaveForm(false);
      setPreviewTarget('character', created.preset_id, effectiveInstanceId, created.default_parameters);
      pushToast('success', t('motionLib.savedToast', { name: created.name }));
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : t('motionLib.saveFailed'));
    }
  };

  const handleDuplicatePreset = async (preset: MotionPreset) => {
    try {
      const dup = await apiClient.duplicateMotionPreset(preset.preset_id);
      upsertMotionPreset(dup);
      pushToast('success', t('motionLib.duplicatedToast', { name: dup.name }));
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : t('motionLib.saveFailed'));
    }
  };

  const handleCommitRename = async (presetId: string) => {
    const clean = renameDraft.trim();
    if (!clean) {
      setRenamingPresetId(null);
      return;
    }
    try {
      const updated = await apiClient.updateMotionPreset(presetId, { name: clean });
      upsertMotionPreset(updated);
      setRenamingPresetId(null);
      pushToast('success', t('motionLib.renamedToast', { name: updated.name }));
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : t('motionLib.saveFailed'));
    }
  };

  const handleDeletePreset = async (preset: MotionPreset) => {
    try {
      await apiClient.deleteMotionPreset(preset.preset_id);
      removeMotionPreset(preset.preset_id);
      pushToast('info', t('motionLib.deletedToast', { name: preset.name }));
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : t('motionLib.deleteFailed'));
    }
  };

  const filteredPresets = motionPresets.filter((p) => {
    if (!presetQuery.trim()) return true;
    const q = presetQuery.trim().toLowerCase();
    return (
      p.name.toLowerCase().includes(q) ||
      p.category.toLowerCase().includes(q) ||
      p.description.toLowerCase().includes(q)
    );
  });

  const sortedKfs = [...project.timeline.keyframes]
    .sort((a, b) => a.time_ms - b.time_ms)
    .filter((k) => {
      if (!query.trim()) return true;
      const q = query.trim().toLowerCase();
      return (
        k.property.toLowerCase().includes(q) ||
        k.target_id.toLowerCase().includes(q) ||
        String(k.value).toLowerCase().includes(q)
      );
    });

  const hasAssembledShots = project.scenes.some((s) => (s.shots?.length ?? 0) > 0);

  return (
    <>
      {/* Top Action: Execute AI Production Animations & Camera */}
      {hasAssembledShots && project.production_plan && (
        <button
          type="button"
          className="btn-primary"
          style={{ width: '100%', justifyContent: 'center' }}
          onClick={() => openAnimationExecModal({})}
          data-testid="anim-panel-open-exec-btn"
        >
          <Sparkles size={13} />
          {t('motionExec.openModalBtn')}
        </button>
      )}

      {/* 1. LIVE MOTION PREVIEW & PARAMETER CONTROLS */}
      <CollapsibleSection
        title={t('motionExec.previewSectionTitle')}
        icon={<Wand2 size={12} color="var(--accent-text)" />}
        badge={previewOverlay ? 'LIVE' : undefined}
        defaultOpen
      >
        {/* Mode Switch: Character vs Camera */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
          <button
            type="button"
            className={`btn-xs ${previewTargetKind === 'character' ? 'btn-primary' : ''}`}
            onClick={() => setPreviewTarget('character', previewPresetId, effectiveInstanceId)}
            data-testid="motion-mode-character"
          >
            <Users size={11} /> {t('motionExec.modeCharacter')}
          </button>
          <button
            type="button"
            className={`btn-xs ${previewTargetKind === 'camera' ? 'btn-primary' : ''}`}
            onClick={() => setPreviewTarget('camera', previewPresetId, effectiveInstanceId)}
            data-testid="motion-mode-camera"
          >
            <Camera size={11} /> {t('motionExec.modeCamera')}
          </button>
        </div>

        {previewTargetKind === 'character' ? (
          <>
            {/* Target Character Selector & Real Rig Capability Readout */}
            <div className="field-row">
              <label className="field-label">{t('motionExec.targetCharacter')}</label>
              <select
                value={effectiveInstanceId ?? ''}
                onChange={(e) => {
                  const nextId = e.target.value || null;
                  setPreviewTarget('character', previewPresetId, nextId);
                  if (nextId) setSelection({ type: 'character', id: nextId });
                }}
                data-testid="motion-target-char-select"
              >
                {sceneCharInstances.length === 0 ? (
                  <option value="">{t('motionExec.noCharInScene')}</option>
                ) : (
                  sceneCharInstances.map((ci) => (
                    <option key={ci.instance_id} value={ci.instance_id}>
                      {ci.display_name}
                    </option>
                  ))
                )}
              </select>
            </div>

            {activeCharacter && (
              <div className="motion-cap-box" data-testid="motion-rig-capabilities">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <span style={{ fontSize: 10, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <ShieldCheck size={11} color="var(--success)" />
                    {t('motionExec.rigCapsTitle')}
                  </span>
                  <span className="tag-pill mono">{activeCaps.rig_type}</span>
                </div>
                <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                  {activeCaps.capabilities.map((cap) => (
                    <span key={cap} className="tag-pill" style={{ fontSize: 9 }}>
                      {cap}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Parameter Controls */}
            <div className="field-grid">
              <div className="field-row">
                <label className="field-label">{t('motionExec.paramDuration')}</label>
                <input
                  type="number"
                  step={0.1}
                  min={0.3}
                  max={30}
                  value={Number((previewParams.duration_ms / 1000).toFixed(2))}
                  onChange={(e) => {
                    const sec = parseFloat(e.target.value);
                    if (Number.isFinite(sec) && sec >= 0.25 && sec <= 60) {
                      updatePreviewParams({ duration_ms: Math.round(sec * 1000) });
                    }
                  }}
                  data-testid="motion-param-duration"
                />
              </div>
              <div className="field-row">
                <label className="field-label">{t('motionExec.paramSpeed')}</label>
                <input
                  type="number"
                  step={0.1}
                  min={0.25}
                  max={3}
                  value={previewParams.speed}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    if (Number.isFinite(v) && v >= 0.25 && v <= 3) {
                      updatePreviewParams({ speed: v });
                    }
                  }}
                  data-testid="motion-param-speed"
                />
              </div>
              <div className="field-row">
                <label className="field-label">{t('motionExec.paramIntensity')}</label>
                <input
                  type="number"
                  step={0.1}
                  min={0.1}
                  max={2.5}
                  value={previewParams.intensity}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    if (Number.isFinite(v) && v >= 0.1 && v <= 2.5) {
                      updatePreviewParams({ intensity: v });
                    }
                  }}
                  data-testid="motion-param-intensity"
                />
              </div>
              <div className="field-row">
                <label className="field-label">{t('motionExec.paramDistance')}</label>
                <input
                  type="number"
                  step={20}
                  min={-2400}
                  max={2400}
                  value={previewParams.distance_px}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    if (Number.isFinite(v)) updatePreviewParams({ distance_px: v });
                  }}
                  data-testid="motion-param-distance"
                />
              </div>
              <div className="field-row">
                <label className="field-label">{t('motionExec.paramDirection')}</label>
                <select
                  value={previewParams.direction}
                  onChange={(e) =>
                    updatePreviewParams({ direction: e.target.value as MotionDirection })
                  }
                >
                  {DIRECTION_OPTIONS.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field-row">
                <label className="field-label">{t('motionExec.paramEasing')}</label>
                <select
                  value={previewParams.easing}
                  onChange={(e) => updatePreviewParams({ easing: e.target.value as EasingType })}
                >
                  {EASING_OPTIONS.map((ea) => (
                    <option key={ea} value={ea}>
                      {t(`easing.${ea}`)}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {activeCharacter && activeCharacter.poses.length > 0 && (
              <div className="field-grid">
                <div className="field-row">
                  <label className="field-label">{t('motionExec.paramStartPose')}</label>
                  <select
                    value={previewParams.start_pose_id ?? ''}
                    onChange={(e) =>
                      updatePreviewParams({ start_pose_id: e.target.value || null })
                    }
                  >
                    <option value="">—</option>
                    {activeCharacter.poses.map((p) => (
                      <option key={p.pose_id} value={p.pose_id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field-row">
                  <label className="field-label">{t('motionExec.paramEndPose')}</label>
                  <select
                    value={previewParams.end_pose_id ?? ''}
                    onChange={(e) => updatePreviewParams({ end_pose_id: e.target.value || null })}
                  >
                    <option value="">—</option>
                    {activeCharacter.poses.map((p) => (
                      <option key={p.pose_id} value={p.pose_id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, fontSize: 10, flexWrap: 'wrap' }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={previewParams.loop}
                  onChange={(e) => updatePreviewParams({ loop: e.target.checked })}
                />
                {t('motionExec.paramLoop')}
              </label>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={syncCameraFollow}
                  onChange={(e) => setSyncCameraFollow(e.target.checked)}
                />
                {t('motionExec.optSyncCam')}
              </label>
            </div>
          </>
        ) : (
          /* Camera Motion Mode */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div className="field-row">
              <label className="field-label">{t('motionExec.cameraMovement')}</label>
              <select
                value={previewCameraParams.movement}
                onChange={(e) =>
                  updatePreviewCameraParams({ movement: e.target.value as CameraMovement })
                }
                data-testid="motion-camera-movement-select"
              >
                {CAMERA_MOVEMENT_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
            <div className="field-grid">
              <div className="field-row">
                <label className="field-label">{t('motionExec.paramDuration')}</label>
                <input
                  type="number"
                  step={0.1}
                  min={0.3}
                  max={30}
                  value={Number((previewCameraParams.duration_ms / 1000).toFixed(2))}
                  onChange={(e) => {
                    const sec = parseFloat(e.target.value);
                    if (Number.isFinite(sec) && sec >= 0.25 && sec <= 60) {
                      updatePreviewCameraParams({ duration_ms: Math.round(sec * 1000) });
                    }
                  }}
                />
              </div>
              <div className="field-row">
                <label className="field-label">{t('motionExec.paramEasing')}</label>
                <select
                  value={previewCameraParams.easing}
                  onChange={(e) =>
                    updatePreviewCameraParams({ easing: e.target.value as EasingType })
                  }
                >
                  {EASING_OPTIONS.map((ea) => (
                    <option key={ea} value={ea}>
                      {t(`easing.${ea}`)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field-row">
                <label className="field-label">Start X / End X</label>
                <div style={{ display: 'flex', gap: 3 }}>
                  <input
                    type="number"
                    value={previewCameraParams.start_x}
                    onChange={(e) =>
                      updatePreviewCameraParams({ start_x: parseFloat(e.target.value) || 0 })
                    }
                  />
                  <input
                    type="number"
                    value={previewCameraParams.end_x}
                    onChange={(e) =>
                      updatePreviewCameraParams({ end_x: parseFloat(e.target.value) || 0 })
                    }
                  />
                </div>
              </div>
              <div className="field-row">
                <label className="field-label">Start Z / End Z</label>
                <div style={{ display: 'flex', gap: 3 }}>
                  <input
                    type="number"
                    step={0.05}
                    min={0.2}
                    max={4}
                    value={previewCameraParams.start_zoom}
                    onChange={(e) =>
                      updatePreviewCameraParams({ start_zoom: parseFloat(e.target.value) || 1 })
                    }
                  />
                  <input
                    type="number"
                    step={0.05}
                    min={0.2}
                    max={4}
                    value={previewCameraParams.end_zoom}
                    onChange={(e) =>
                      updatePreviewCameraParams({ end_zoom: parseFloat(e.target.value) || 1 })
                    }
                  />
                </div>
              </div>
            </div>
            {previewCameraParams.movement === 'shake' && (
              <div className="field-row">
                <label className="field-label">{t('motionExec.shakeIntensity')}</label>
                <input
                  type="number"
                  min={1}
                  max={80}
                  value={previewCameraParams.shake_intensity_px}
                  onChange={(e) =>
                    updatePreviewCameraParams({
                      shake_intensity_px: Math.max(1, parseFloat(e.target.value) || 12),
                    })
                  }
                />
              </div>
            )}
            {(previewCameraParams.movement === 'tracking' ||
              previewCameraParams.movement === 'camera_follow') && (
              <div className="field-row">
                <label className="field-label">{t('motionExec.followCharacter')}</label>
                <select
                  value={previewCameraParams.follow_instance_id ?? ''}
                  onChange={(e) =>
                    updatePreviewCameraParams({ follow_instance_id: e.target.value || null })
                  }
                >
                  <option value="">{t('motionExec.manualPanFallback')}</option>
                  {sceneCharInstances.map((ci) => (
                    <option key={ci.instance_id} value={ci.instance_id}>
                      {ci.display_name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        )}

        {previewError && (
          <div className="director-callout error" style={{ padding: '6px 8px', fontSize: 10 }} data-testid="motion-preview-error">
            <AlertTriangle size={12} style={{ flexShrink: 0 }} />
            <span>{previewError}</span>
          </div>
        )}

        {previewResponse && previewResponse.compatible && (
          <div style={{ fontSize: 10, color: 'var(--accent-text)' }} data-testid="motion-preview-summary">
            {previewResponse.sync_summary}
          </div>
        )}

        {/* Motion Preview Transport: Preview / Play-Pause / Stop / Reset / Apply / Cancel */}
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn-xs"
            disabled={previewLoading}
            onClick={() => void runLivePreview({ autoPlay: true })}
            data-testid="motion-preview-btn"
          >
            <Play size={11} /> {t('motionExec.previewBtn')}
          </button>
          {previewOverlay && (
            <>
              <button
                type="button"
                className="btn-xs"
                onClick={() => setPlaying(!isPlaying)}
                title={isPlaying ? t('transport.pause') : t('transport.play')}
                data-testid="motion-preview-playpause-btn"
              >
                {isPlaying ? <Pause size={11} /> : <Play size={11} />}
              </button>
              <button
                type="button"
                className="btn-xs"
                onClick={handleStopPreview}
                title={t('transport.stop')}
                data-testid="motion-preview-stop-btn"
              >
                <Square size={10} />
              </button>
              <button
                type="button"
                className="btn-xs"
                onClick={handleResetParams}
                title={t('motionExec.resetBtn')}
                data-testid="motion-preview-reset-btn"
              >
                <RotateCcw size={11} />
              </button>
              <button
                type="button"
                className="btn-xs"
                onClick={handleCancelPreview}
                data-testid="motion-preview-cancel-btn"
              >
                <X size={11} /> {t('common.cancel')}
              </button>
            </>
          )}
          <button
            type="button"
            className="btn-xs btn-primary"
            style={{ marginLeft: 'auto' }}
            disabled={applying || previewLoading}
            onClick={() => void handleApplyMotion()}
            data-testid="motion-apply-btn"
          >
            <Check size={11} /> {t('motionExec.applySingleBtn')}
          </button>
        </div>
      </CollapsibleSection>

      {/* 2. REUSABLE MOTION LIBRARY */}
      <CollapsibleSection
        title={t('motionLib.title')}
        icon={<Sparkles size={12} color="var(--accent-text)" />}
        badge={motionPresets.length}
        defaultOpen
      >
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <div style={{ flex: 1 }}>
            <SearchInput
              value={presetQuery}
              onChange={setPresetQuery}
              placeholder={t('motionLib.searchPlaceholder')}
            />
          </div>
          <button
            type="button"
            className="btn-xs"
            title={t('motionLib.saveCurrentTip')}
            onClick={() => setShowSaveForm((v) => !v)}
            data-testid="motion-lib-toggle-save-btn"
          >
            <Plus size={11} /> {t('common.save')}
          </button>
        </div>

        {showSaveForm && (
          <div className="list-card" style={{ padding: 6, gap: 5 }} data-testid="motion-lib-save-form">
            <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
              {t('motionLib.saveFormHint', { base: selectedPreset?.name ?? 'Idle' })}
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              <input
                value={savingPresetName}
                onChange={(e) => setSavingPresetName(e.target.value)}
                placeholder={t('motionLib.namePlaceholder')}
                style={{ flex: 1 }}
                data-testid="motion-lib-save-name-input"
              />
              <button
                type="button"
                className="btn-xs btn-primary"
                disabled={!savingPresetName.trim()}
                onClick={() => void handleSaveCustomPreset()}
                data-testid="motion-lib-save-confirm-btn"
              >
                <Save size={11} />
              </button>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, maxHeight: 260, overflowY: 'auto' }}>
          {filteredPresets.map((preset) => {
            const compat = activeCharacter
              ? checkPresetCompatibilityLocal(preset, activeCaps)
              : null;
            const isSelected = previewPresetId === preset.preset_id && previewTargetKind === 'character';
            const isRenaming = renamingPresetId === preset.preset_id;

            return (
              <div
                key={preset.preset_id}
                className={`list-card ${isSelected ? 'selected' : ''}`}
                style={{ padding: 6, gap: 4 }}
                data-testid={`motion-preset-card-${preset.preset_id}`}
                onClick={() => {
                  setPreviewTarget(
                    'character',
                    preset.preset_id,
                    effectiveInstanceId,
                    preset.default_parameters,
                  );
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
                  {isRenaming ? (
                    <div
                      style={{ display: 'flex', gap: 3, flex: 1 }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        value={renameDraft}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        style={{ flex: 1, fontSize: 11, padding: '2px 5px' }}
                        data-testid="motion-lib-rename-input"
                      />
                      <button
                        type="button"
                        className="btn-xs btn-primary"
                        onClick={() => void handleCommitRename(preset.preset_id)}
                        data-testid="motion-lib-rename-save-btn"
                      >
                        <Check size={10} />
                      </button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, flex: 1 }}>
                      <strong style={{ fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {preset.name}
                      </strong>
                      <span className="tag-pill mono" style={{ fontSize: 9 }}>
                        {preset.category}
                      </span>
                      {!preset.is_builtin && (
                        <span className="tag-pill accent" style={{ fontSize: 9 }}>
                          {t('motionLib.customBadge')}
                        </span>
                      )}
                    </div>
                  )}

                  {compat && (
                    <span
                      className={`director-badge ${
                        compat.support_level === 'full'
                          ? 'accepted'
                          : compat.support_level === 'partial'
                            ? 'warning'
                            : 'rejected'
                      }`}
                      style={{ fontSize: 9 }}
                      data-testid={`motion-preset-compat-${preset.preset_id}`}
                    >
                      {t(`motionExec.support.${compat.support_level}`)}
                    </span>
                  )}
                </div>

                {compat && !compat.compatible && (
                  <div style={{ fontSize: 9, color: 'var(--danger)' }}>
                    ⚠ {compat.warnings[0]}
                  </div>
                )}

                <div
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <div style={{ display: 'flex', gap: 3 }}>
                    <button
                      type="button"
                      className="btn-xs"
                      disabled={Boolean(compat && !compat.compatible) || !effectiveInstanceId}
                      onClick={() => {
                        setPreviewTarget(
                          'character',
                          preset.preset_id,
                          effectiveInstanceId,
                          preset.default_parameters,
                        );
                        void runLivePreview({
                          targetKind: 'character',
                          preset,
                          instanceId: effectiveInstanceId,
                          params: preset.default_parameters,
                          autoPlay: true,
                        });
                      }}
                      data-testid={`motion-preset-preview-${preset.preset_id}`}
                    >
                      <Play size={10} /> {t('motionExec.previewBtn')}
                    </button>
                    <button
                      type="button"
                      className="btn-xs"
                      disabled={Boolean(compat && !compat.compatible) || !effectiveInstanceId || applying}
                      onClick={() => void handleApplyMotion(preset)}
                      data-testid={`motion-preset-apply-${preset.preset_id}`}
                    >
                      <Check size={10} /> {t('motionExec.applyShort')}
                    </button>
                  </div>

                  <div style={{ display: 'flex', gap: 2 }}>
                    <button
                      type="button"
                      className="btn-ghost btn-icon btn-xs"
                      title={t('common.duplicate')}
                      onClick={() => void handleDuplicatePreset(preset)}
                      data-testid={`motion-preset-dup-${preset.preset_id}`}
                    >
                      <Copy size={10} />
                    </button>
                    <button
                      type="button"
                      className="btn-ghost btn-icon btn-xs"
                      title={t('common.rename')}
                      onClick={() => {
                        setRenamingPresetId(preset.preset_id);
                        setRenameDraft(preset.name);
                      }}
                      data-testid={`motion-preset-rename-${preset.preset_id}`}
                    >
                      <Edit3 size={10} />
                    </button>
                    {!preset.is_builtin && (
                      <button
                        type="button"
                        className="btn-ghost btn-icon btn-xs"
                        title={t('common.delete')}
                        onClick={() => void handleDeletePreset(preset)}
                        data-testid={`motion-preset-del-${preset.preset_id}`}
                      >
                        <Trash2 size={10} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </CollapsibleSection>

      {/* 3. EXISTING STATE CLIPS & KEYFRAMES EXPLORER */}
      <SearchInput
        value={query}
        onChange={setQuery}
        placeholder={t('animPanel.searchPlaceholder')}
      />

      <CollapsibleSection
        title={t('animPanel.stateClips')}
        icon={<Sparkles size={12} />}
        badge={project.timeline.animation_clips.length}
        defaultOpen={false}
      >
        {project.timeline.animation_clips.length === 0 ? (
          <EmptyState
            title={t('animPanel.emptyClipsTitle')}
            description={t('animPanel.emptyClipsDesc')}
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {project.timeline.animation_clips.map((clip) => (
              <div
                key={clip.clip_id}
                className="list-card"
                style={{ cursor: 'pointer' }}
                onClick={() => {
                  setSelection({ type: 'character', id: clip.instance_id });
                  setCurrentFrame(msToFrame(clip.start_ms, fps));
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span className="tag-pill accent mono">{clip.animation_state}</span>
                  <button
                    className="btn-ghost btn-icon btn-xs"
                    title={t('common.delete')}
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteAnimationClip(clip.clip_id);
                    }}
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
                <div className="mono" style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                  {formatTimecode(clip.start_ms)} → {formatTimecode(clip.end_ms)}
                </div>
              </div>
            ))}
          </div>
        )}
      </CollapsibleSection>

      <CollapsibleSection
        title={t('animPanel.keyframesTitle')}
        icon={<Diamond size={12} color="var(--track-keyframe)" />}
        badge={sortedKfs.length}
        defaultOpen
      >
        {sortedKfs.length === 0 ? (
          <EmptyState
            title={t('animPanel.emptyKfsTitle')}
            description={t('animPanel.emptyKfsDesc')}
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, maxHeight: 240, overflowY: 'auto' }}>
            {sortedKfs.map((kf) => (
              <div
                key={kf.keyframe_id}
                className={`list-card ${selectedKeyframeIds.includes(kf.keyframe_id) ? 'selected' : ''}`}
                style={{ padding: 6, cursor: 'pointer' }}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey) {
                    selectKeyframe(kf.keyframe_id, 'toggle');
                    return;
                  }
                  setCurrentFrame(msToFrame(kf.time_ms, fps));
                  selectKeyframe(kf.keyframe_id, 'replace');
                  if (kf.target_type === 'camera') {
                    setSelection({ type: 'camera', id: 'camera' });
                  } else if (kf.target_type === 'character_instance') {
                    setSelection({ type: 'character', id: kf.target_id });
                  } else if (kf.target_type === 'character_part') {
                    const [instId, slotId] = kf.target_id.split(':');
                    setSelection({ type: 'character', id: instId, subSlotId: slotId });
                  } else if (kf.target_type === 'prop') {
                    setSelection({ type: 'prop', id: kf.target_id });
                  }
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontWeight: 600, fontSize: 11 }}>
                    {kf.target_type === 'camera' ? 'Camera' : kf.target_id.slice(0, 18)}.{kf.property}
                  </span>
                  <button
                    className="btn-ghost btn-icon btn-xs"
                    title={t('timeline.ctxDeleteKeyframe')}
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteKeyframe(kf.keyframe_id);
                    }}
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                  <span className="mono" style={{ fontSize: 10, color: 'var(--accent-text)' }}>
                    F{msToFrame(kf.time_ms, fps)} ({formatTimecode(kf.time_ms)}) = {String(kf.value)}
                  </span>
                  <select
                    value={kf.easing === 'step' ? 'hold' : kf.easing}
                    style={{ fontSize: 10, padding: '1px 4px' }}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      const nextEasing = e.target.value as EasingType;
                      mutateProject((draft) => {
                        const target = draft.timeline.keyframes.find(
                          (x) => x.keyframe_id === kf.keyframe_id,
                        );
                        if (target) target.easing = nextEasing;
                      });
                    }}
                  >
                    {EASING_OPTIONS.map((opt) => (
                      <option key={opt} value={opt}>
                        {t(`easing.${opt}`)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            ))}
          </div>
        )}
      </CollapsibleSection>
    </>
  );
}
