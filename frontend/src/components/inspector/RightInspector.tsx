import { useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  Box,
  Camera,
  Captions,
  CheckCircle2,
  Clapperboard,
  ClipboardPaste,
  Copy,
  Diamond,
  Eye,
  Film,
  Image as ImageIcon,
  Layers,
  Lock,
  Plus,
  Scissors,
  ShieldAlert,
  Sliders,
  Smile,
  Sparkles,
  Trash2,
  Volume2,
  Wand2,
} from 'lucide-react';
import { inspectCharacterCapabilitiesLocal } from '@/engine/animationExecutionEngine';
import { evaluateStageAtFrame, frameToMs, msToFrame } from '@/engine/evaluator';
import { evaluateNumericKeyframes } from '@/engine/interpolation';
import { ANIMATION_PRESETS, type AnimationPresetId } from '@/engine/presets';
import { ensureSubtitleDocument } from '@/engine/subtitleEngine';
import { useI18n } from '@/i18n/useLocaleStore';
import { apiClient } from '@/services/apiClient';
import { useAnimationExecStore } from '@/stores/useAnimationExecStore';
import { useJobStore } from '@/stores/useJobStore';
import { useLibraryStore } from '@/stores/useLibraryStore';
import { usePlaybackStore } from '@/stores/usePlaybackStore';
import { useProjectStore } from '@/stores/useProjectStore';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';
import type {
  AnimationStateType,
  Character,
  EasingType,
  Keyframe,
  KeyframeProperty,
  KeyframeTargetType,
  TransitionType,
} from '@/types/models';
import { CollapsibleSection } from '@/components/ui/CollapsibleSection';
import {
  KeyframeDiamondButton,
  NumericInput,
  PropertySlider,
  SliderWithInput,
  Vector2Control,
} from '@/components/ui/PropertyControls';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { SubtitleInspectorPanel } from '@/components/inspector/SubtitleInspectorPanel';
import { EmptyState, formatTimecode, WaveformCanvas } from '@/components/common/CommonUI';

const ANIM_STATES: AnimationStateType[] = [
  'IDLE',
  'WALKING',
  'RUNNING',
  'SPEAKING',
  'LISTENING',
  'REACTING',
  'SURPRISED',
  'ANGRY',
  'SAD',
  'HAPPY',
  'CRYING',
  'TRANSITION',
];

const EASING_OPTIONS: EasingType[] = ['hold', 'linear', 'ease_in', 'ease_out', 'ease_in_out'];

function normalizeEasingForSelect(easing: EasingType): EasingType {
  return easing === 'step' ? 'hold' : easing;
}

export function RightInspector() {
  const { t } = useI18n();
  const project = useProjectStore((s) => s.project);
  const activeSceneId = useProjectStore((s) => s.activeSceneId);
  const selection = useProjectStore((s) => s.selection);
  const selectedKeyframeIds = useProjectStore((s) => s.selectedKeyframeIds);
  const copiedKeyframe = useProjectStore((s) => s.copiedKeyframe);
  const selectKeyframe = useProjectStore((s) => s.selectKeyframe);
  const pushHistorySnapshot = useProjectStore((s) => s.pushHistorySnapshot);
  const mutateProject = useProjectStore((s) => s.mutateProject);
  const updateScene = useProjectStore((s) => s.updateScene);
  const updateSceneShot = useProjectStore((s) => s.updateSceneShot);
  const setSelection = useProjectStore((s) => s.setSelection);
  const updateCharacterInstance = useProjectStore((s) => s.updateCharacterInstance);
  const updatePropInstance = useProjectStore((s) => s.updatePropInstance);
  const addPropToScene = useProjectStore((s) => s.addPropToScene);
  const renameLayer = useProjectStore((s) => s.renameLayer);
  const setLayerVisibility = useProjectStore((s) => s.setLayerVisibility);
  const setLayerLocked = useProjectStore((s) => s.setLayerLocked);
  const moveSceneLayer = useProjectStore((s) => s.moveSceneLayer);
  const upsertKeyframe = useProjectStore((s) => s.upsertKeyframe);
  const copyKeyframe = useProjectStore((s) => s.copyKeyframe);
  const pasteKeyframeAtTime = useProjectStore((s) => s.pasteKeyframeAtTime);
  const deleteKeyframe = useProjectStore((s) => s.deleteKeyframe);
  const applyAnimationPreset = useProjectStore((s) => s.applyAnimationPreset);
  const addOrUpdateAnimationClip = useProjectStore((s) => s.addOrUpdateAnimationClip);
  const updateCameraAtTime = useProjectStore((s) => s.updateCameraAtTime);
  const updateSoundEvent = useProjectStore((s) => s.updateSoundEvent);
  const deleteSoundEvent = useProjectStore((s) => s.deleteSoundEvent);
  const updateSubtitleSegment = useProjectStore((s) => s.updateSubtitleSegment);
  const deleteSubtitleSegments = useProjectStore((s) => s.deleteSubtitleSegments);
  const duplicateSubtitleSegment = useProjectStore((s) => s.duplicateSubtitleSegment);
  const splitSubtitleSegmentAt = useProjectStore((s) => s.splitSubtitleSegmentAt);

  const assets = useLibraryStore((s) => s.assets);
  const upsertAsset = useLibraryStore((s) => s.upsertAsset);
  const characters = useLibraryStore((s) => s.characters);
  const sounds = useLibraryStore((s) => s.sounds);
  const pushToast = useJobStore((s) => s.pushToast);
  const openAnimationExecModal = useAnimationExecStore((s) => s.openAnimationExecModal);
  const switchWorkspace = useWorkspaceStore((s) => s.switchWorkspace);
  const setSidebarTab = useWorkspaceStore((s) => s.setSidebarTab);

  const currentFrame = usePlaybackStore((s) => s.currentFrame);
  const setCurrentFrame = usePlaybackStore((s) => s.setCurrentFrame);

  const [assetTagDraft, setAssetTagDraft] = useState('');
  const [activePartSlotId, setActivePartSlotId] = useState<string>('');
  const [scaleAspectLocked, setScaleAspectLocked] = useState<boolean>(true);

  const charMap = useMemo(() => {
    const m: Record<string, Character> = {};
    for (const c of characters) m[c.character_id] = c;
    return m;
  }, [characters]);

  const fps = project?.timeline.fps ?? 30;
  const timeMs = Math.round(frameToMs(currentFrame, fps));
  const frameToleranceMs = Math.max(15, Math.ceil(500 / fps));

  const evaluated = useMemo(() => {
    if (!project) return null;
    return evaluateStageAtFrame(project, charMap, currentFrame, fps);
  }, [project, charMap, currentFrame, fps]);

  const renderKeyframeRows = (kfs: Keyframe[]) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {copiedKeyframe && (
        <button
          className="btn-xs"
          style={{ alignSelf: 'flex-start' }}
          onClick={() => {
            if (pasteKeyframeAtTime(timeMs)) {
              pushToast('info', t('inspector.pastedToast', { time: formatTimecode(timeMs) }));
            }
          }}
        >
          <ClipboardPaste size={10} /> {t('inspector.pasteKeyframe')}
        </button>
      )}
      {kfs.map((kf) => (
        <div
          key={kf.keyframe_id}
          className={`list-card ${selectedKeyframeIds.includes(kf.keyframe_id) ? 'selected' : ''}`}
          style={{
            padding: '4px 6px',
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            cursor: 'pointer',
          }}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey) {
              selectKeyframe(kf.keyframe_id, 'toggle');
            } else {
              selectKeyframe(kf.keyframe_id, 'replace');
              setCurrentFrame(msToFrame(kf.time_ms, fps));
            }
          }}
        >
          <span className="mono" style={{ fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {formatTimecode(kf.time_ms)} • {kf.property}={String(kf.value).slice(0, 8)}
          </span>
          <div style={{ display: 'flex', gap: 3, alignItems: 'center', flexShrink: 0 }}>
            <select
              value={normalizeEasingForSelect(kf.easing)}
              style={{ fontSize: 10, padding: '1px 3px' }}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) =>
                mutateProject((draft) => {
                  const target = draft.timeline.keyframes.find((x) => x.keyframe_id === kf.keyframe_id);
                  if (target) target.easing = e.target.value as EasingType;
                })
              }
            >
              {EASING_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {t(`easing.${opt}`)}
                </option>
              ))}
            </select>
            <button
              className="btn-ghost btn-icon btn-xs"
              title={t('inspector.copyKeyframe')}
              aria-label={t('inspector.copyKeyframe')}
              onClick={(e) => {
                e.stopPropagation();
                copyKeyframe(kf);
                pushToast('info', t('inspector.copiedToast', { prop: kf.property, val: String(kf.value) }));
              }}
            >
              <Copy size={10} />
            </button>
            <button
              className="btn-ghost btn-icon btn-xs"
              title={t('common.delete')}
              aria-label={t('common.delete')}
              onClick={(e) => {
                e.stopPropagation();
                deleteKeyframe(kf.keyframe_id);
              }}
            >
              <Trash2 size={10} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );

  // --- ASSET CONTEXT INSPECTOR (works even if no project is open!) ---
  if (selection.type === 'asset' && selection.id) {
    const asset = assets.find((a) => a.asset_id === selection.id);
    if (!asset) {
      return (
        <div className="panel-body">
          <EmptyState title={t('inspector.assetNotFound')} description={t('inspector.emptyDesc')} />
        </div>
      );
    }
    const activeScene =
      project?.scenes.find((s) => s.scene_id === activeSceneId) ?? project?.scenes[0] ?? null;

    return (
      <div className="panel-body">
        <CollapsibleSection
          title={t('inspector.assetSection', { name: asset.name })}
          icon={<ImageIcon size={12} color="var(--accent-text)" />}
          defaultOpen
        >
          <div className="asset-thumb" style={{ height: 140 }}>
            <img src={apiClient.getAssetFileUrl(asset.asset_id)} alt={asset.name} />
          </div>

          <div className="field-row">
            <label className="field-label">{t('inspector.displayName')}</label>
            <input
              defaultValue={asset.name}
              key={asset.asset_id + asset.name}
              onBlur={async (e) => {
                const next = e.target.value.trim();
                if (next && next !== asset.name) {
                  const updated = await apiClient.updateAsset(asset.asset_id, { name: next });
                  upsertAsset(updated);
                }
              }}
            />
          </div>

          <div className="field-grid">
            <div className="field-row">
              <label className="field-label">{t('inspector.type')}</label>
              <div className="tag-pill">{asset.type}</div>
            </div>
            <div className="field-row">
              <label className="field-label">{t('inspector.dimensions')}</label>
              <div className="tag-pill mono">
                {asset.width} × {asset.height} px
              </div>
            </div>
            <div className="field-row">
              <label className="field-label">{t('inspector.folder')}</label>
              <div className="tag-pill">{asset.folder}</div>
            </div>
            <div className="field-row">
              <label className="field-label">{t('inspector.partRole')}</label>
              <div className="tag-pill">{asset.part_role ?? '—'}</div>
            </div>
          </div>

          <ToggleSwitch
            label={t('inspector.identityVerified')}
            description={t('inspector.identityVerifiedDesc')}
            checked={asset.identity_verified}
            onChange={async (checked) => {
              const updated = await apiClient.updateAsset(asset.asset_id, {
                identity_verified: checked,
              });
              upsertAsset(updated);
            }}
          />

          <div style={{ display: 'flex', gap: 5, alignItems: 'center', fontSize: 10, color: 'var(--text-muted)' }}>
            {asset.identity_verified ? (
              <CheckCircle2 size={12} color="var(--success)" />
            ) : (
              <ShieldAlert size={12} color="var(--warning)" />
            )}
            <span className="mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
              SHA256: {asset.sha256.slice(0, 16)}…
            </span>
          </div>
        </CollapsibleSection>

        <CollapsibleSection title={t('inspector.tagsAndSource')} defaultOpen>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {asset.tags.length === 0 ? (
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t('inspector.noTags')}</span>
            ) : (
              asset.tags.map((tag) => (
                <span key={tag} className="tag-pill" style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                  {tag}
                  <button
                    className="btn-ghost"
                    style={{ padding: 0, fontSize: 10 }}
                    aria-label={`${t('common.remove')} ${tag}`}
                    onClick={async () => {
                      const updated = await apiClient.updateAsset(asset.asset_id, {
                        tags: asset.tags.filter((x) => x !== tag),
                      });
                      upsertAsset(updated);
                    }}
                  >
                    ×
                  </button>
                </span>
              ))
            )}
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            <input
              placeholder={t('inspector.addTagPlaceholder')}
              value={assetTagDraft}
              onChange={(e) => setAssetTagDraft(e.target.value)}
              style={{ flex: 1 }}
            />
            <button
              disabled={!assetTagDraft.trim()}
              onClick={async () => {
                const tag = assetTagDraft.trim();
                if (!tag || asset.tags.includes(tag)) return;
                const updated = await apiClient.updateAsset(asset.asset_id, {
                  tags: [...asset.tags, tag],
                });
                upsertAsset(updated);
                setAssetTagDraft('');
              }}
            >
              <Plus size={11} /> {t('common.add')}
            </button>
          </div>
          <div className="mono" style={{ fontSize: 10, color: 'var(--text-muted)', wordBreak: 'break-all' }}>
            {t('inspector.pathLabel')}: {asset.file_path}
          </div>
          {activeScene && (
            <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
              <button
                style={{ flex: 1 }}
                onClick={() => {
                  updateScene(activeScene.scene_id, { background_asset_id: asset.asset_id });
                  pushToast(
                    'info',
                    t('inspector.assetAssignedBgToast', { name: asset.name, scene: activeScene.name }),
                  );
                }}
              >
                {t('inspector.useAsBg')}
              </button>
              <button
                className="btn-primary"
                style={{ flex: 1 }}
                onClick={() => addPropToScene(activeScene.scene_id, asset.asset_id, asset.name)}
              >
                {t('inspector.addAsProp')}
              </button>
            </div>
          )}
        </CollapsibleSection>
      </div>
    );
  }

  if (!project || !evaluated) {
    return (
      <div className="panel-body">
        <EmptyState title={t('panel.inspector')} description={t('inspector.noProjectDesc')} />
      </div>
    );
  }

  const findKeyframeAtTime = (targetId: string, prop: KeyframeProperty) =>
    project.timeline.keyframes.find(
      (k) => k.target_id === targetId && k.property === prop && Math.abs(k.time_ms - timeMs) <= frameToleranceMs,
    );

  const hasAnyKeyframe = (targetId: string, prop: KeyframeProperty) =>
    project.timeline.keyframes.some((k) => k.target_id === targetId && k.property === prop);

  const renderLayerOrderRow = (sceneId: string, layerId: string, zIndex: number) => (
    <div className="field-row">
      <label className="field-label">
        <span>{t('layer.layerOrder')}</span>
        <span className="mono tag-pill" style={{ fontSize: 9 }}>
          Z: {zIndex}
        </span>
      </label>
      <div style={{ display: 'flex', gap: 4 }}>
        <button
          type="button"
          className="btn-xs"
          style={{ flex: 1 }}
          title={t('layer.bringToFront')}
          onClick={() => moveSceneLayer(sceneId, layerId, 'front')}
        >
          <ArrowUpToLine size={11} />
        </button>
        <button
          type="button"
          className="btn-xs"
          style={{ flex: 1 }}
          title={t('layer.moveUp')}
          onClick={() => moveSceneLayer(sceneId, layerId, 'up')}
        >
          <ArrowUp size={11} />
        </button>
        <button
          type="button"
          className="btn-xs"
          style={{ flex: 1 }}
          title={t('layer.moveDown')}
          onClick={() => moveSceneLayer(sceneId, layerId, 'down')}
        >
          <ArrowDown size={11} />
        </button>
        <button
          type="button"
          className="btn-xs"
          style={{ flex: 1 }}
          title={t('layer.sendToBack')}
          onClick={() => moveSceneLayer(sceneId, layerId, 'back')}
        >
          <ArrowDownToLine size={11} />
        </button>
      </div>
    </div>
  );

  // --- SCENE CONTEXT INSPECTOR ---
  if (selection.type === 'scene' && selection.id) {
    const scene = project.scenes.find((s) => s.scene_id === selection.id);
    if (!scene) {
      return (
        <div className="panel-body">
          <EmptyState title={t('inspector.sceneNotFound')} description={t('inspector.emptyDesc')} />
        </div>
      );
    }
    const bgAssets = assets.filter((a) => a.type === 'background' || a.type === 'prop');

    return (
      <div className="panel-body">
        <CollapsibleSection
          title={t('inspector.sceneTitle', { name: scene.name })}
          icon={<Film size={12} color="var(--accent-text)" />}
          defaultOpen
        >
          <div className="field-row">
            <label className="field-label">{t('inspector.sceneName')}</label>
            <input
              value={scene.name}
              onChange={(e) => updateScene(scene.scene_id, { name: e.target.value })}
            />
          </div>
          <div className="field-grid">
            <NumericInput
              label={t('inspector.duration')}
              shortTag="D"
              unit="s"
              step={0.5}
              min={1}
              max={600}
              precision={2}
              value={scene.duration_ms / 1000}
              onChange={(sec) => updateScene(scene.scene_id, { duration_ms: Math.round(sec * 1000) })}
            />
            <div className="field-row">
              <label className="field-label">{t('inspector.resolution')}</label>
              <div className="tag-pill mono" style={{ padding: '5px 7px' }}>
                {project.meta.width}×{project.meta.height}
              </div>
            </div>
          </div>

          <div className="field-grid">
            <div className="field-row">
              <label className="field-label">{t('inspector.transitionIn')}</label>
              <select
                value={scene.transition_in}
                onChange={(e) =>
                  updateScene(scene.scene_id, { transition_in: e.target.value as TransitionType })
                }
              >
                <option value="cut">{t('inspector.transitionCut')}</option>
                <option value="fade">{t('inspector.transitionFade')}</option>
                <option value="cross_dissolve">{t('inspector.transitionCross')}</option>
              </select>
            </div>
            <NumericInput
              label={t('inspector.transitionDur')}
              shortTag="T"
              unit="ms"
              step={50}
              min={0}
              max={4000}
              precision={0}
              value={scene.transition_duration_ms}
              onChange={(ms) => updateScene(scene.scene_id, { transition_duration_ms: Math.round(ms) })}
            />
          </div>
        </CollapsibleSection>

        <CollapsibleSection title={t('inspector.bgAndCamera')} icon={<Camera size={12} />} defaultOpen>
          <div className="field-row">
            <label className="field-label">{t('inspector.bgImage')}</label>
            <select
              value={scene.background_asset_id ?? ''}
              onChange={(e) =>
                updateScene(scene.scene_id, { background_asset_id: e.target.value || null })
              }
            >
              <option value="">{t('inspector.bgNone')}</option>
              {bgAssets.map((a) => (
                <option key={a.asset_id} value={a.asset_id}>
                  {a.name} ({a.width}×{a.height})
                </option>
              ))}
            </select>
          </div>
          <div className="field-row">
            <label className="field-label">{t('inspector.bgColor')}</label>
            <input
              type="color"
              value={scene.background_color}
              onChange={(e) => updateScene(scene.scene_id, { background_color: e.target.value })}
              style={{ height: 28, padding: 2 }}
            />
          </div>
          <Vector2Control
            label={t('inspector.position')}
            x={scene.camera_default.x}
            y={scene.camera_default.y}
            unit="px"
            step={5}
            precision={0}
            onChangeX={(x) =>
              updateScene(scene.scene_id, { camera_default: { ...scene.camera_default, x } })
            }
            onChangeY={(y) =>
              updateScene(scene.scene_id, { camera_default: { ...scene.camera_default, y } })
            }
          />
          <SliderWithInput
            label={t('inspector.defaultZoom')}
            value={scene.camera_default.zoom}
            min={0.2}
            max={4}
            step={0.05}
            precision={2}
            unit="x"
            onReset={() =>
              updateScene(scene.scene_id, { camera_default: { ...scene.camera_default, zoom: 1 } })
            }
            onChange={(zoom) =>
              updateScene(scene.scene_id, { camera_default: { ...scene.camera_default, zoom } })
            }
          />
          <NumericInput
            label={t('inspector.defaultRot')}
            shortTag="R"
            unit="°"
            step={1}
            value={scene.camera_default.rotation_deg}
            onReset={() =>
              updateScene(scene.scene_id, {
                camera_default: { ...scene.camera_default, rotation_deg: 0 },
              })
            }
            onChange={(rotation_deg) =>
              updateScene(scene.scene_id, {
                camera_default: { ...scene.camera_default, rotation_deg },
              })
            }
          />
        </CollapsibleSection>
      </div>
    );
  }

  // --- CAMERA CONTEXT INSPECTOR ---
  if (selection.type === 'camera') {
    const cam = evaluated.camera;
    const camTrackId =
      project.timeline.tracks.find((tr) => tr.track_type === 'camera')?.track_id ??
      project.timeline.tracks[0]?.track_id ??
      '';
    const camKfs = project.timeline.keyframes
      .filter((k) => k.target_type === 'camera')
      .sort((a, b) => a.time_ms - b.time_ms);

    const toggleCamKf = (prop: 'x' | 'y' | 'zoom' | 'rotation_deg', val: number) => {
      const existing = findKeyframeAtTime('camera', prop);
      if (existing) deleteKeyframe(existing.keyframe_id);
      else updateCameraAtTime(timeMs, { [prop]: val }, true);
    };

    const applyCamPreset = (presetId: AnimationPresetId) => {
      const count = applyAnimationPreset({
        presetId,
        targetType: 'camera',
        targetId: 'camera',
        trackId: camTrackId,
        startFrame: currentFrame,
        baseTransform: { x: cam.x, y: cam.y, rotation_deg: cam.rotation_deg, scale_x: 1, scale_y: 1, opacity: 1 },
        baseCameraZoom: cam.zoom,
      });
      pushToast('success', t('preset.appliedToast', { preset: t(`preset.${presetId}`), count }));
    };

    return (
      <div className="panel-body">
        <CollapsibleSection
          title={t('inspector.cameraSection')}
          icon={<Camera size={12} color="var(--track-camera-accent)" />}
          defaultOpen
        >
          <Vector2Control
            label={`${t('inspector.panX')} / ${t('inspector.panY')}`}
            x={cam.x}
            y={cam.y}
            unit="px"
            step={5}
            precision={0}
            onScrubStart={pushHistorySnapshot}
            onReset={() => updateCameraAtTime(timeMs, { x: 0, y: 0 }, true)}
            onChangeX={(x) => updateCameraAtTime(timeMs, { x }, true)}
            onChangeY={(y) => updateCameraAtTime(timeMs, { y }, true)}
            xRightSlot={
              <KeyframeDiamondButton
                atCurrentFrame={Boolean(findKeyframeAtTime('camera', 'x'))}
                hasAnyKeyframe={hasAnyKeyframe('camera', 'x')}
                onClick={() => toggleCamKf('x', cam.x)}
              />
            }
            yRightSlot={
              <KeyframeDiamondButton
                atCurrentFrame={Boolean(findKeyframeAtTime('camera', 'y'))}
                hasAnyKeyframe={hasAnyKeyframe('camera', 'y')}
                onClick={() => toggleCamKf('y', cam.y)}
              />
            }
          />
          <SliderWithInput
            label={t('inspector.zoom')}
            value={cam.zoom}
            min={0.2}
            max={4}
            step={0.05}
            precision={2}
            unit="x"
            onScrubStart={pushHistorySnapshot}
            onReset={() => updateCameraAtTime(timeMs, { zoom: 1 }, true)}
            onChange={(zoom) => updateCameraAtTime(timeMs, { zoom }, true)}
            rightSlot={
              <KeyframeDiamondButton
                atCurrentFrame={Boolean(findKeyframeAtTime('camera', 'zoom'))}
                hasAnyKeyframe={hasAnyKeyframe('camera', 'zoom')}
                onClick={() => toggleCamKf('zoom', cam.zoom)}
              />
            }
          />
          <NumericInput
            label={t('inspector.roll')}
            shortTag="R"
            unit="°"
            step={1}
            value={cam.rotation_deg}
            onScrubStart={pushHistorySnapshot}
            onReset={() => updateCameraAtTime(timeMs, { rotation_deg: 0 }, true)}
            onChange={(rotation_deg) => updateCameraAtTime(timeMs, { rotation_deg }, true)}
            rightSlot={
              <KeyframeDiamondButton
                atCurrentFrame={Boolean(findKeyframeAtTime('camera', 'rotation_deg'))}
                hasAnyKeyframe={hasAnyKeyframe('camera', 'rotation_deg')}
                onClick={() => toggleCamKf('rotation_deg', cam.rotation_deg)}
              />
            }
          />

          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            <button
              className="btn-xs"
              onClick={() => updateCameraAtTime(timeMs, { x: 0, y: 0, zoom: 1, rotation_deg: 0 }, true)}
            >
              {t('inspector.camReset')}
            </button>
            <button className="btn-xs" onClick={() => updateCameraAtTime(timeMs, { zoom: 1.35 }, true)}>
              {t('inspector.camMedium')}
            </button>
            <button className="btn-xs" onClick={() => updateCameraAtTime(timeMs, { zoom: 1.75 }, true)}>
              {t('inspector.camCloseUp')}
            </button>
          </div>
        </CollapsibleSection>

        <CollapsibleSection title={t('inspector.presetsSection')} icon={<Wand2 size={12} />} defaultOpen>
          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{t('inspector.presetsDesc')}</span>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {ANIMATION_PRESETS.filter((p) => p.supportsCamera).map((p) => (
              <button key={p.id} className="btn-xs" onClick={() => applyCamPreset(p.id)}>
                {t(p.labelKey)}
              </button>
            ))}
          </div>
        </CollapsibleSection>

        <CollapsibleSection
          title={t('inspector.cameraKeyframes')}
          icon={<Diamond size={12} color="var(--track-keyframe)" />}
          badge={camKfs.length}
          defaultOpen
        >
          {camKfs.length === 0 ? (
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t('inspector.cameraNoKfs')}</span>
          ) : (
            renderKeyframeRows(camKfs)
          )}
        </CollapsibleSection>
      </div>
    );
  }

  // --- SUBTITLE SEGMENT CONTEXT INSPECTOR ---
  if (selection.type === 'subtitle' && selection.id) {
    const subDoc = ensureSubtitleDocument(project.subtitles);
    const seg = subDoc.segments.find((s) => s.subtitle_id === selection.id);
    if (!seg) {
      return (
        <div className="panel-body">
          <EmptyState title={t('sub.notFoundTitle')} description={t('inspector.emptyDesc')} />
        </div>
      );
    }
    return <SubtitleInspectorPanel seg={seg} />;
  }

  // --- SFX / VOICE / BGM / AMBIENT AUDIO CLIP CONTEXT INSPECTOR ---
  if (selection.type === 'sfx_event' && selection.id) {
    const ev = project.timeline.sound_events.find((e) => e.event_id === selection.id);
    if (!ev) {
      return (
        <div className="panel-body">
          <EmptyState title={t('inspector.sfxNotFound')} description={t('inspector.emptyDesc')} />
        </div>
      );
    }
    const sound = sounds.find((s) => s.sound_id === ev.sound_id);

    return (
      <div className="panel-body">
        <CollapsibleSection
          title={t('inspector.audioSection', { name: sound?.name ?? ev.sound_id })}
          icon={<Volume2 size={12} color="var(--track-sfx-wave)" />}
          action={
            <button
              className="btn-danger btn-xs"
              onClick={() => deleteSoundEvent(ev.event_id)}
              title={t('timeline.ctxDeleteSfx')}
            >
              <Trash2 size={10} />
            </button>
          }
          defaultOpen
        >
          {sound && <WaveformCanvas peaks={sound.waveform_peaks} height={34} background="var(--surface-base)" />}

          <div className="field-grid">
            <NumericInput
              label={t('inspector.startTime')}
              shortTag="S"
              unit="ms"
              step={50}
              min={0}
              precision={0}
              value={ev.start_ms}
              onScrubStart={pushHistorySnapshot}
              onChange={(st) => {
                const dur = Math.max(100, ev.end_ms - ev.start_ms);
                updateSoundEvent(ev.event_id, { start_ms: Math.round(st), end_ms: Math.round(st + dur) });
              }}
            />
            <NumericInput
              label={t('inspector.endTime')}
              shortTag="E"
              unit="ms"
              step={50}
              min={ev.start_ms + 100}
              precision={0}
              value={ev.end_ms}
              onScrubStart={pushHistorySnapshot}
              onChange={(end) => updateSoundEvent(ev.event_id, { end_ms: Math.round(end) })}
            />
            <NumericInput
              label={t('inspector.trimOffset')}
              shortTag="O"
              unit="ms"
              step={25}
              min={0}
              precision={0}
              value={ev.trim_start_ms}
              onChange={(trim) => updateSoundEvent(ev.event_id, { trim_start_ms: Math.round(trim) })}
            />
            <NumericInput
              label={t('inspector.speed')}
              shortTag="×"
              unit="x"
              step={0.05}
              min={0.5}
              max={2}
              value={ev.speed}
              onReset={() => updateSoundEvent(ev.event_id, { speed: 1.0 })}
              onChange={(speed) => updateSoundEvent(ev.event_id, { speed })}
            />
          </div>

          <SliderWithInput
            label={t('inspector.volume')}
            value={ev.volume}
            min={0}
            max={2}
            step={0.05}
            displayScale={100}
            unit="%"
            precision={0}
            onScrubStart={pushHistorySnapshot}
            onReset={() => updateSoundEvent(ev.event_id, { volume: 1.0 })}
            onChange={(volume) => updateSoundEvent(ev.event_id, { volume }, false)}
          />

          <div className="field-grid">
            <NumericInput
              label={t('inspector.fadeIn')}
              shortTag="FI"
              unit="ms"
              step={25}
              min={0}
              precision={0}
              value={ev.fade_in_ms}
              onChange={(ms) => updateSoundEvent(ev.event_id, { fade_in_ms: Math.round(ms) })}
            />
            <NumericInput
              label={t('inspector.fadeOut')}
              shortTag="FO"
              unit="ms"
              step={25}
              min={0}
              precision={0}
              value={ev.fade_out_ms}
              onChange={(ms) => updateSoundEvent(ev.event_id, { fade_out_ms: Math.round(ms) })}
            />
          </div>

          <SliderWithInput
            label={t('inspector.stereoPan')}
            value={ev.spatial_position}
            min={-1}
            max={1}
            step={0.05}
            precision={2}
            onScrubStart={pushHistorySnapshot}
            onReset={() => updateSoundEvent(ev.event_id, { spatial_position: 0 })}
            onChange={(spatial_position) => updateSoundEvent(ev.event_id, { spatial_position }, false)}
          />

          <ToggleSwitch
            label={t('inspector.loopClip')}
            description={t('inspector.loopClipDesc')}
            checked={ev.loop}
            onChange={(loop) => updateSoundEvent(ev.event_id, { loop })}
          />

          {sound && (
            <div style={{ fontSize: 10, color: 'var(--text-muted)', borderTop: '1px solid var(--border-subtle)', paddingTop: 6 }}>
              {t('inspector.licenseLabel')}: <strong>{sound.license.source}</strong> ({sound.license.usage}) • {sound.codec} {sound.sample_rate}Hz
            </div>
          )}
        </CollapsibleSection>
      </div>
    );
  }

  // --- CHARACTER CONTEXT INSPECTOR (Layer, Transform, Appearance, Animation) ---
  if (selection.type === 'character' && selection.id && evaluated.scene) {
    const scene = evaluated.scene;
    const inst = scene.characters.find((c) => c.instance_id === selection.id);
    const evalChar = evaluated.characters.find((c) => c.instance_id === selection.id);
    const charDef = inst ? charMap[inst.character_id] : null;

    if (!inst || !evalChar) {
      return (
        <div className="panel-body">
          <EmptyState
            title={t('inspector.charNotInSceneTitle')}
            description={t('inspector.charNotInSceneDesc')}
          />
        </div>
      );
    }

    const isLocked = Boolean(inst.locked);
    const isVisible = inst.visible !== false;
    const charTrack = project.timeline.tracks.find(
      (tr) => tr.track_type === 'character' && tr.target_ref_id === inst.instance_id,
    );
    const trackId = charTrack?.track_id ?? project.timeline.tracks[0]?.track_id ?? '';
    const activeClip = project.timeline.animation_clips.find(
      (c) => c.instance_id === inst.instance_id && timeMs >= c.start_ms && timeMs < c.end_ms,
    );

    const validPartSlot =
      activePartSlotId && evalChar.parts.some((p) => p.slot_id === activePartSlotId)
        ? evalChar.parts.find((p) => p.slot_id === activePartSlotId) ?? null
        : null;

    const currentTargetType: KeyframeTargetType = validPartSlot ? 'character_part' : 'character_instance';
    const currentTargetId = validPartSlot ? `${inst.instance_id}:${validPartSlot.slot_id}` : inst.instance_id;
    const currentTransform = validPartSlot ? validPartSlot.transform : evalChar.transform;

    const charKfs = project.timeline.keyframes
      .filter((k) =>
        validPartSlot
          ? k.target_id === currentTargetId
          : k.target_id === inst.instance_id || k.target_id.startsWith(`${inst.instance_id}:`),
      )
      .sort((a, b) => a.time_ms - b.time_ms);

    const setNumericProp = (
      prop: 'x' | 'y' | 'rotation_deg' | 'scale_x' | 'scale_y' | 'opacity',
      val: number,
      recordHistory = true,
    ) => {
      if (validPartSlot) {
        upsertKeyframe({
          track_id: trackId,
          target_type: 'character_part',
          target_id: currentTargetId,
          property: prop,
          time_ms: timeMs,
          value: val,
          recordHistory,
        });
        return;
      }

      const animated = hasAnyKeyframe(inst.instance_id, prop);
      if (animated) {
        upsertKeyframe({
          track_id: trackId,
          target_type: 'character_instance',
          target_id: inst.instance_id,
          property: prop,
          time_ms: timeMs,
          value: val,
          recordHistory,
        });
      } else {
        updateCharacterInstance(
          scene.scene_id,
          inst.instance_id,
          { initial_transform: { ...inst.initial_transform, [prop]: val } },
          recordHistory,
        );
      }
    };

    const setScaleBoth = (nextSx: number, nextSy: number, recordHistory = true) => {
      if (validPartSlot || hasAnyKeyframe(inst.instance_id, 'scale_x') || hasAnyKeyframe(inst.instance_id, 'scale_y')) {
        upsertKeyframe({ track_id: trackId, target_type: currentTargetType, target_id: currentTargetId, property: 'scale_x', time_ms: timeMs, value: nextSx, recordHistory });
        upsertKeyframe({ track_id: trackId, target_type: currentTargetType, target_id: currentTargetId, property: 'scale_y', time_ms: timeMs, value: nextSy, recordHistory: false });
      } else {
        updateCharacterInstance(
          scene.scene_id,
          inst.instance_id,
          { initial_transform: { ...inst.initial_transform, scale_x: nextSx, scale_y: nextSy } },
          recordHistory,
        );
      }
    };

    const handleScaleXChange = (nextSx: number, recordHistory = true) => {
      if (scaleAspectLocked) {
        const ratio = currentTransform.scale_x > 0.001 ? currentTransform.scale_y / currentTransform.scale_x : 1;
        const nextSy = Math.max(0.05, Math.min(10, Math.round(nextSx * ratio * 100) / 100));
        setScaleBoth(nextSx, nextSy, recordHistory);
      } else {
        setNumericProp('scale_x', nextSx, recordHistory);
      }
    };

    const handleScaleYChange = (nextSy: number, recordHistory = true) => {
      if (scaleAspectLocked) {
        const ratio = currentTransform.scale_y > 0.001 ? currentTransform.scale_x / currentTransform.scale_y : 1;
        const nextSx = Math.max(0.05, Math.min(10, Math.round(nextSy * ratio * 100) / 100));
        setScaleBoth(nextSx, nextSy, recordHistory);
      } else {
        setNumericProp('scale_y', nextSy, recordHistory);
      }
    };

    const toggleTargetKf = (prop: KeyframeProperty, value: number | string) => {
      const existing = findKeyframeAtTime(currentTargetId, prop);
      if (existing) deleteKeyframe(existing.keyframe_id);
      else {
        upsertKeyframe({
          track_id: trackId,
          target_type: currentTargetType,
          target_id: currentTargetId,
          property: prop,
          time_ms: timeMs,
          value,
        });
      }
    };

    const toggleRootKf = (prop: KeyframeProperty, value: number | string) => {
      const existing = findKeyframeAtTime(inst.instance_id, prop);
      if (existing) deleteKeyframe(existing.keyframe_id);
      else {
        upsertKeyframe({
          track_id: trackId,
          target_type: 'character_instance',
          target_id: inst.instance_id,
          property: prop,
          time_ms: timeMs,
          value,
        });
      }
    };

    const eyeSlot = charDef?.parts.find((p) => p.part_role === 'eyes');
    const mouthSlot = charDef?.parts.find((p) => p.part_role === 'mouth');
    const eyeOptions = [...new Set(['open', 'half', 'closed', ...Object.keys(eyeSlot?.variants ?? {})])];
    const mouthOptions = [
      ...new Set(['closed', 'open', 'a', 'e', 'i', 'o', 'u', 'smile', ...Object.keys(mouthSlot?.variants ?? {})]),
    ];

    const handleApplyCharPreset = (presetId: AnimationPresetId) => {
      const count = applyAnimationPreset({
        presetId,
        targetType: currentTargetType,
        targetId: currentTargetId,
        trackId,
        startFrame: currentFrame,
        baseTransform: currentTransform,
      });
      pushToast('success', t('preset.appliedToast', { preset: t(`preset.${presetId}`), count }));
    };

    const charCaps = inspectCharacterCapabilitiesLocal(charDef);

    return (
      <div className="panel-body">
        {isLocked && (
          <div className="status-pill warn" style={{ padding: '6px 8px', justifyContent: 'flex-start' }}>
            <Lock size={12} /> {t('layer.lockedBanner')}
          </div>
        )}

        {charDef && (
          <CollapsibleSection
            title={t('motionExec.rigCapsTitle')}
            icon={<Wand2 size={12} color="var(--accent-text)" />}
            badge={charCaps.rig_type}
            defaultOpen={false}
          >
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }} data-testid="inspector-char-capabilities">
              {charCaps.capabilities.map((cap) => (
                <span key={cap} className="tag-pill mono" style={{ fontSize: 9 }}>
                  {cap}
                </span>
              ))}
            </div>
            {charCaps.limitations.length > 0 && (
              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                {charCaps.limitations.slice(0, 3).map((lim, i) => (
                  <div key={i}>• {lim}</div>
                ))}
              </div>
            )}
            <button
              type="button"
              className="btn-xs"
              style={{ width: '100%' }}
              onClick={() => {
                switchWorkspace('animation');
                setSidebarTab('animation');
              }}
            >
              <Sparkles size={11} /> {t('motionLib.openLibraryBtn')}
            </button>
          </CollapsibleSection>
        )}

        {/* 1. LAYER SECTION */}
        <CollapsibleSection
          title={`${t('layer.sectionTitle')}: ${inst.display_name}`}
          icon={<Layers size={12} color="var(--accent-text)" />}
          defaultOpen
        >
          <div className="field-row">
            <label className="field-label">{t('layer.layerName')}</label>
            <input
              value={inst.display_name}
              onChange={(e) => renameLayer(scene.scene_id, 'character', inst.instance_id, e.target.value)}
            />
          </div>
          {renderLayerOrderRow(scene.scene_id, inst.instance_id, inst.z_index)}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <ToggleSwitch
              label={t('inspector.visible')}
              checked={isVisible}
              onChange={(v) => setLayerVisibility(scene.scene_id, 'character', inst.instance_id, v)}
            />
            <ToggleSwitch
              label={t('inspector.locked')}
              checked={isLocked}
              onChange={(l) => setLayerLocked(scene.scene_id, 'character', inst.instance_id, l)}
            />
          </div>
        </CollapsibleSection>

        {/* 2. TRANSFORM SECTION */}
        <CollapsibleSection
          title={`${t('inspector.transform')}${validPartSlot ? ` › ${validPartSlot.name}` : ''}`}
          icon={<Sliders size={12} color="var(--accent-text)" />}
          action={
            <button
              className="btn-xs"
              disabled={isLocked}
              title={t('inspector.keyAllTip')}
              onClick={() => {
                upsertKeyframe({ track_id: trackId, target_type: currentTargetType, target_id: currentTargetId, property: 'x', time_ms: timeMs, value: Math.round(currentTransform.x) });
                upsertKeyframe({ track_id: trackId, target_type: currentTargetType, target_id: currentTargetId, property: 'y', time_ms: timeMs, value: Math.round(currentTransform.y), recordHistory: false });
                upsertKeyframe({ track_id: trackId, target_type: currentTargetType, target_id: currentTargetId, property: 'rotation_deg', time_ms: timeMs, value: currentTransform.rotation_deg, recordHistory: false });
                upsertKeyframe({ track_id: trackId, target_type: currentTargetType, target_id: currentTargetId, property: 'scale_x', time_ms: timeMs, value: currentTransform.scale_x, recordHistory: false });
                upsertKeyframe({ track_id: trackId, target_type: currentTargetType, target_id: currentTargetId, property: 'scale_y', time_ms: timeMs, value: currentTransform.scale_y, recordHistory: false });
                upsertKeyframe({ track_id: trackId, target_type: currentTargetType, target_id: currentTargetId, property: 'opacity', time_ms: timeMs, value: currentTransform.opacity, recordHistory: false });
              }}
            >
              <Diamond size={9} color="var(--track-keyframe)" /> {t('inspector.keyAll')}
            </button>
          }
          defaultOpen
        >
          {evalChar.parts.length > 0 && (
            <div className="field-row">
              <label className="field-label">{t('inspector.activePartTarget')}</label>
              <select
                value={validPartSlot?.slot_id ?? ''}
                onChange={(e) => setActivePartSlotId(e.target.value)}
              >
                <option value="">{t('inspector.wholeCharacter')}</option>
                {evalChar.parts.map((part) => (
                  <option key={part.slot_id} value={part.slot_id}>
                    {part.name} ({part.part_role})
                  </option>
                ))}
              </select>
              {validPartSlot && (
                <span style={{ fontSize: 10, color: 'var(--accent-text)' }}>
                  {t('inspector.partOverrideHint')}
                </span>
              )}
            </div>
          )}

          <Vector2Control
            label={t('inspector.position')}
            x={currentTransform.x}
            y={currentTransform.y}
            unit="px"
            step={5}
            precision={1}
            disabled={isLocked}
            onScrubStart={pushHistorySnapshot}
            onReset={() => {
              const rx = validPartSlot ? 0 : Math.round(project.meta.width / 2);
              const ry = validPartSlot ? 0 : Math.round(project.meta.height * 0.62);
              setNumericProp('x', rx, true);
              setNumericProp('y', ry, false);
            }}
            onChangeX={(val) => setNumericProp('x', val, true)}
            onChangeY={(val) => setNumericProp('y', val, true)}
            xRightSlot={
              <KeyframeDiamondButton
                disabled={isLocked}
                atCurrentFrame={Boolean(findKeyframeAtTime(currentTargetId, 'x'))}
                hasAnyKeyframe={hasAnyKeyframe(currentTargetId, 'x')}
                onClick={() => toggleTargetKf('x', Number(currentTransform.x.toFixed(1)))}
              />
            }
            yRightSlot={
              <KeyframeDiamondButton
                disabled={isLocked}
                atCurrentFrame={Boolean(findKeyframeAtTime(currentTargetId, 'y'))}
                hasAnyKeyframe={hasAnyKeyframe(currentTargetId, 'y')}
                onClick={() => toggleTargetKf('y', Number(currentTransform.y.toFixed(1)))}
              />
            }
          />

          <NumericInput
            label={t('inspector.rotation')}
            shortTag="R"
            unit="°"
            step={1}
            precision={1}
            disabled={isLocked}
            value={currentTransform.rotation_deg}
            onScrubStart={pushHistorySnapshot}
            onReset={() => setNumericProp('rotation_deg', 0, true)}
            onChange={(val) => setNumericProp('rotation_deg', val, true)}
            rightSlot={
              <KeyframeDiamondButton
                disabled={isLocked}
                atCurrentFrame={Boolean(findKeyframeAtTime(currentTargetId, 'rotation_deg'))}
                hasAnyKeyframe={hasAnyKeyframe(currentTargetId, 'rotation_deg')}
                onClick={() => toggleTargetKf('rotation_deg', Number(currentTransform.rotation_deg.toFixed(1)))}
              />
            }
          />

          <Vector2Control
            label={t('inspector.scale')}
            xTag="SX"
            yTag="SY"
            x={currentTransform.scale_x}
            y={currentTransform.scale_y}
            min={0.05}
            max={10}
            step={0.05}
            precision={2}
            unit="x"
            disabled={isLocked}
            aspectLocked={scaleAspectLocked}
            onToggleAspectLock={() => setScaleAspectLocked((v) => !v)}
            onScrubStart={pushHistorySnapshot}
            onReset={() => setScaleBoth(1, 1, true)}
            onChangeX={(val) => handleScaleXChange(val, true)}
            onChangeY={(val) => handleScaleYChange(val, true)}
            xRightSlot={
              <KeyframeDiamondButton
                disabled={isLocked}
                atCurrentFrame={Boolean(findKeyframeAtTime(currentTargetId, 'scale_x'))}
                hasAnyKeyframe={hasAnyKeyframe(currentTargetId, 'scale_x')}
                onClick={() => toggleTargetKf('scale_x', Number(currentTransform.scale_x.toFixed(2)))}
              />
            }
            yRightSlot={
              <KeyframeDiamondButton
                disabled={isLocked}
                atCurrentFrame={Boolean(findKeyframeAtTime(currentTargetId, 'scale_y'))}
                hasAnyKeyframe={hasAnyKeyframe(currentTargetId, 'scale_y')}
                onClick={() => toggleTargetKf('scale_y', Number(currentTransform.scale_y.toFixed(2)))}
              />
            }
          />
          <PropertySlider
            ariaLabel={t('inspector.scale')}
            min={0.1}
            max={3}
            step={0.05}
            disabled={isLocked}
            value={currentTransform.scale_x}
            onScrubStart={pushHistorySnapshot}
            onChange={(val) => handleScaleXChange(val, false)}
          />
        </CollapsibleSection>

        {/* 3. APPEARANCE SECTION */}
        <CollapsibleSection
          title={t('layer.appearanceSection')}
          icon={<Eye size={12} />}
          defaultOpen
        >
          <SliderWithInput
            label={t('inspector.opacity')}
            value={currentTransform.opacity}
            min={0}
            max={1}
            step={0.01}
            displayScale={100}
            unit="%"
            precision={0}
            disabled={isLocked}
            onScrubStart={pushHistorySnapshot}
            onReset={() => setNumericProp('opacity', 1, true)}
            onChange={(val) => setNumericProp('opacity', val, false)}
            rightSlot={
              <KeyframeDiamondButton
                disabled={isLocked}
                atCurrentFrame={Boolean(findKeyframeAtTime(currentTargetId, 'opacity'))}
                hasAnyKeyframe={hasAnyKeyframe(currentTargetId, 'opacity')}
                onClick={() => toggleTargetKf('opacity', Number(currentTransform.opacity.toFixed(2)))}
              />
            }
          />
        </CollapsibleSection>

        {/* 4. ANIMATION, EXPRESSION & PRESETS */}
        <CollapsibleSection title={t('inspector.presetsSection')} icon={<Wand2 size={12} />} defaultOpen>
          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{t('inspector.presetsDesc')}</span>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {ANIMATION_PRESETS.map((p) => (
              <button
                key={p.id}
                className="btn-xs"
                disabled={isLocked}
                onClick={() => handleApplyCharPreset(p.id)}
              >
                {t(p.labelKey)}
              </button>
            ))}
          </div>
        </CollapsibleSection>

        <CollapsibleSection title={t('inspector.expressionSection')} icon={<Smile size={12} />} defaultOpen={false}>
          <div className="field-row">
            <label className="field-label">
              <span>{t('inspector.expressionPreset')}</span>
              <KeyframeDiamondButton
                atCurrentFrame={Boolean(findKeyframeAtTime(inst.instance_id, 'expression_id'))}
                hasAnyKeyframe={hasAnyKeyframe(inst.instance_id, 'expression_id')}
                onClick={() => toggleRootKf('expression_id', evalChar.expression_id ?? '')}
              />
            </label>
            <select
              value={evalChar.expression_id ?? ''}
              onChange={(e) =>
                upsertKeyframe({
                  track_id: trackId,
                  target_type: 'character_instance',
                  target_id: inst.instance_id,
                  property: 'expression_id',
                  time_ms: timeMs,
                  value: e.target.value,
                  easing: 'hold',
                })
              }
            >
              <option value="">{t('common.default')}</option>
              {(charDef?.expressions ?? []).map((ex) => (
                <option key={ex.expression_id} value={ex.expression_id}>
                  {ex.name}
                </option>
              ))}
            </select>
          </div>

          <div className="field-grid">
            <div className="field-row">
              <label className="field-label">
                <span>{t('inspector.eyes')}</span>
                <KeyframeDiamondButton
                  atCurrentFrame={Boolean(findKeyframeAtTime(inst.instance_id, 'eye_state'))}
                  hasAnyKeyframe={hasAnyKeyframe(inst.instance_id, 'eye_state')}
                  onClick={() => toggleRootKf('eye_state', evalChar.eye_state)}
                />
              </label>
              <select
                value={evalChar.eye_state}
                onChange={(e) =>
                  upsertKeyframe({
                    track_id: trackId,
                    target_type: 'character_instance',
                    target_id: inst.instance_id,
                    property: 'eye_state',
                    time_ms: timeMs,
                    value: e.target.value,
                    easing: 'hold',
                  })
                }
              >
                {eyeOptions.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </div>

            <div className="field-row">
              <label className="field-label">
                <span>{t('inspector.mouth')}</span>
                <KeyframeDiamondButton
                  atCurrentFrame={Boolean(findKeyframeAtTime(inst.instance_id, 'mouth_state'))}
                  hasAnyKeyframe={hasAnyKeyframe(inst.instance_id, 'mouth_state')}
                  onClick={() => toggleRootKf('mouth_state', evalChar.mouth_state)}
                />
              </label>
              <select
                value={evalChar.mouth_state}
                onChange={(e) =>
                  upsertKeyframe({
                    track_id: trackId,
                    target_type: 'character_instance',
                    target_id: inst.instance_id,
                    property: 'mouth_state',
                    time_ms: timeMs,
                    value: e.target.value,
                    easing: 'hold',
                  })
                }
              >
                {mouthOptions.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </CollapsibleSection>

        <CollapsibleSection title={t('inspector.animationStateSection')} icon={<Sparkles size={12} />} defaultOpen={false}>
          <div className="field-row">
            <label className="field-label">{t('inspector.stateMachine')}</label>
            <select
              value={evalChar.animation_state}
              onChange={(e) => {
                const nextState = e.target.value as AnimationStateType;
                if (activeClip) {
                  addOrUpdateAnimationClip({ ...activeClip, animation_state: nextState });
                } else {
                  addOrUpdateAnimationClip({
                    instance_id: inst.instance_id,
                    track_id: trackId,
                    start_ms: scene.start_ms,
                    end_ms: scene.start_ms + scene.duration_ms,
                    animation_state: nextState,
                  });
                }
              }}
            >
              {ANIM_STATES.map((st) => (
                <option key={st} value={st}>
                  {st}
                </option>
              ))}
            </select>
          </div>

          {activeClip && (
            <>
              <ToggleSwitch
                label={t('inspector.autoBlink')}
                description={t('inspector.autoBlinkDesc', { ms: activeClip.procedural.blink_interval_ms })}
                checked={activeClip.procedural.auto_blink}
                onChange={(checked) =>
                  addOrUpdateAnimationClip({
                    ...activeClip,
                    procedural: { ...activeClip.procedural, auto_blink: checked },
                  })
                }
              />
              <ToggleSwitch
                label={t('inspector.breathing')}
                description={t('inspector.breathingDesc')}
                checked={activeClip.procedural.breathing}
                onChange={(checked) =>
                  addOrUpdateAnimationClip({
                    ...activeClip,
                    procedural: { ...activeClip.procedural, breathing: checked },
                  })
                }
              />
              <SliderWithInput
                label={t('inspector.walkBounce')}
                value={activeClip.procedural.walk_bounce_px}
                min={0}
                max={60}
                step={1}
                unit="px"
                precision={0}
                onChange={(val) =>
                  addOrUpdateAnimationClip({
                    ...activeClip,
                    procedural: { ...activeClip.procedural, walk_bounce_px: val },
                  })
                }
              />
            </>
          )}
        </CollapsibleSection>

        <CollapsibleSection
          title={
            validPartSlot
              ? t('inspector.partKeyframes', { part: validPartSlot.name })
              : t('inspector.keyframesSection')
          }
          icon={<Diamond size={12} color="var(--track-keyframe)" />}
          badge={charKfs.length}
          defaultOpen={charKfs.length > 0}
        >
          {charKfs.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t('inspector.noKeyframes')}</span>
              {copiedKeyframe && (
                <button
                  className="btn-xs"
                  style={{ alignSelf: 'flex-start' }}
                  onClick={() => {
                    if (pasteKeyframeAtTime(timeMs)) {
                      pushToast('info', t('inspector.pastedToast', { time: formatTimecode(timeMs) }));
                    }
                  }}
                >
                  <ClipboardPaste size={10} /> {t('inspector.pasteKeyframe')}
                </button>
              )}
            </div>
          ) : (
            renderKeyframeRows(charKfs)
          )}
        </CollapsibleSection>
      </div>
    );
  }

  // --- PROP / EMPTY LAYER CONTEXT INSPECTOR (Layer, Transform, Appearance, Animation) ---
  if (selection.type === 'prop' && selection.id && evaluated.scene) {
    const scene = evaluated.scene;
    const prop = scene.props.find((p) => p.prop_instance_id === selection.id);
    const evalProp = evaluated.props.find((p) => p.prop_instance_id === selection.id);
    if (!prop || !evalProp) {
      return (
        <div className="panel-body">
          <EmptyState title={t('inspector.propNotFound')} description={t('inspector.emptyDesc')} />
        </div>
      );
    }

    const isLocked = Boolean(prop.locked);
    const isVisible = prop.visible !== false;
    const isEmptyLayer = prop.layer_kind === 'empty' || !prop.asset_id;
    const propTrack = project.timeline.tracks.find(
      (tr) => tr.track_type === 'prop' && tr.target_ref_id === prop.prop_instance_id,
    );
    const trackId = propTrack?.track_id ?? project.timeline.tracks[0]?.track_id ?? '';
    const propKfs = project.timeline.keyframes
      .filter((k) => k.target_id === prop.prop_instance_id)
      .sort((a, b) => a.time_ms - b.time_ms);

    const isDescendant = (candidateId: string, ancestorId: string): boolean => {
      let curr: string | null | undefined = candidateId;
      const seen = new Set<string>();
      while (curr && !seen.has(curr)) {
        if (curr === ancestorId) return true;
        seen.add(curr);
        curr = scene.props.find((p) => p.prop_instance_id === curr)?.parent_id;
      }
      return false;
    };
    const validParents = scene.props.filter(
      (p) =>
        p.prop_instance_id !== prop.prop_instance_id &&
        !isDescendant(p.prop_instance_id, prop.prop_instance_id),
    );

    const displayVal = (field: 'x' | 'y' | 'rotation_deg' | 'scale_x' | 'scale_y' | 'opacity'): number => {
      if (!prop.parent_id) return evalProp.transform[field];
      const fieldKfs = project.timeline.keyframes.filter(
        (k) => k.target_type === 'prop' && k.target_id === prop.prop_instance_id && k.property === field,
      );
      return evaluateNumericKeyframes(fieldKfs, timeMs, prop.transform[field]);
    };

    const setPropNumericField = (
      field: 'x' | 'y' | 'rotation_deg' | 'scale_x' | 'scale_y' | 'opacity',
      val: number,
      recordHistory = true,
    ) => {
      const animated = hasAnyKeyframe(prop.prop_instance_id, field);
      if (animated) {
        upsertKeyframe({
          track_id: trackId,
          target_type: 'prop',
          target_id: prop.prop_instance_id,
          property: field,
          time_ms: timeMs,
          value: val,
          recordHistory,
        });
      } else {
        updatePropInstance(
          scene.scene_id,
          prop.prop_instance_id,
          { transform: { ...prop.transform, [field]: val } },
          recordHistory,
        );
      }
    };

    const setPropScaleBoth = (nextSx: number, nextSy: number, recordHistory = true) => {
      if (hasAnyKeyframe(prop.prop_instance_id, 'scale_x') || hasAnyKeyframe(prop.prop_instance_id, 'scale_y')) {
        upsertKeyframe({ track_id: trackId, target_type: 'prop', target_id: prop.prop_instance_id, property: 'scale_x', time_ms: timeMs, value: nextSx, recordHistory });
        upsertKeyframe({ track_id: trackId, target_type: 'prop', target_id: prop.prop_instance_id, property: 'scale_y', time_ms: timeMs, value: nextSy, recordHistory: false });
      } else {
        updatePropInstance(
          scene.scene_id,
          prop.prop_instance_id,
          { transform: { ...prop.transform, scale_x: nextSx, scale_y: nextSy } },
          recordHistory,
        );
      }
    };

    const curX = displayVal('x');
    const curY = displayVal('y');
    const curRot = displayVal('rotation_deg');
    const curSx = displayVal('scale_x');
    const curSy = displayVal('scale_y');
    const curOp = displayVal('opacity');

    const handlePropScaleX = (nextSx: number, recordHistory = true) => {
      if (scaleAspectLocked) {
        const ratio = curSx > 0.001 ? curSy / curSx : 1;
        const nextSy = Math.max(0.05, Math.min(10, Math.round(nextSx * ratio * 100) / 100));
        setPropScaleBoth(nextSx, nextSy, recordHistory);
      } else {
        setPropNumericField('scale_x', nextSx, recordHistory);
      }
    };

    const handlePropScaleY = (nextSy: number, recordHistory = true) => {
      if (scaleAspectLocked) {
        const ratio = curSy > 0.001 ? curSx / curSy : 1;
        const nextSx = Math.max(0.05, Math.min(10, Math.round(nextSy * ratio * 100) / 100));
        setPropScaleBoth(nextSx, nextSy, recordHistory);
      } else {
        setPropNumericField('scale_y', nextSy, recordHistory);
      }
    };

    const togglePropKf = (field: KeyframeProperty, value: number) => {
      const existing = findKeyframeAtTime(prop.prop_instance_id, field);
      if (existing) deleteKeyframe(existing.keyframe_id);
      else {
        upsertKeyframe({
          track_id: trackId,
          target_type: 'prop',
          target_id: prop.prop_instance_id,
          property: field,
          time_ms: timeMs,
          value,
        });
      }
    };

    const handleApplyPropPreset = (presetId: AnimationPresetId) => {
      const count = applyAnimationPreset({
        presetId,
        targetType: 'prop',
        targetId: prop.prop_instance_id,
        trackId,
        startFrame: currentFrame,
        baseTransform: { x: curX, y: curY, rotation_deg: curRot, scale_x: curSx, scale_y: curSy, opacity: curOp },
      });
      pushToast('success', t('preset.appliedToast', { preset: t(`preset.${presetId}`), count }));
    };

    return (
      <div className="panel-body">
        {isLocked && (
          <div className="status-pill warn" style={{ padding: '6px 8px', justifyContent: 'flex-start' }}>
            <Lock size={12} /> {t('layer.lockedBanner')}
          </div>
        )}

        {/* 1. LAYER SECTION */}
        <CollapsibleSection
          title={t('inspector.propTitle', { name: prop.name })}
          icon={isEmptyLayer ? <Box size={12} color="var(--text-muted)" /> : <ImageIcon size={12} color="var(--accent-text)" />}
          defaultOpen
        >
          <div className="field-row">
            <label className="field-label">{t('layer.layerName')}</label>
            <input
              value={prop.name}
              onChange={(e) => renameLayer(scene.scene_id, 'prop', prop.prop_instance_id, e.target.value)}
            />
          </div>

          <div className="field-row">
            <label className="field-label">{t('layer.assignPngOpt')}</label>
            <select
              value={prop.asset_id ?? ''}
              onChange={(e) =>
                updatePropInstance(scene.scene_id, prop.prop_instance_id, {
                  asset_id: e.target.value || null,
                })
              }
            >
              <option value="">{t('layer.noPngAssigned')}</option>
              {assets.map((a) => (
                <option key={a.asset_id} value={a.asset_id}>
                  {a.name} ({a.width}×{a.height})
                </option>
              ))}
            </select>
          </div>

          {renderLayerOrderRow(scene.scene_id, prop.prop_instance_id, prop.z_index)}

          <div className="field-row">
            <label className="field-label">{t('inspector.parentObject')}</label>
            <select
              value={prop.parent_id ?? ''}
              onChange={(e) =>
                updatePropInstance(scene.scene_id, prop.prop_instance_id, {
                  parent_id: e.target.value || null,
                })
              }
            >
              <option value="">{t('inspector.parentRoot')}</option>
              {validParents.map((cand) => (
                <option key={cand.prop_instance_id} value={cand.prop_instance_id}>
                  {cand.name}
                </option>
              ))}
            </select>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <ToggleSwitch
              label={t('inspector.visible')}
              checked={isVisible}
              onChange={(v) => setLayerVisibility(scene.scene_id, 'prop', prop.prop_instance_id, v)}
            />
            <ToggleSwitch
              label={t('inspector.locked')}
              checked={isLocked}
              onChange={(l) => setLayerLocked(scene.scene_id, 'prop', prop.prop_instance_id, l)}
            />
          </div>
        </CollapsibleSection>

        {/* 2. TRANSFORM SECTION */}
        <CollapsibleSection
          title={t('inspector.transform')}
          icon={<Sliders size={12} color="var(--accent-text)" />}
          action={
            <button
              className="btn-xs"
              disabled={isLocked}
              title={t('inspector.keyAllTip')}
              onClick={() => {
                upsertKeyframe({ track_id: trackId, target_type: 'prop', target_id: prop.prop_instance_id, property: 'x', time_ms: timeMs, value: Math.round(curX) });
                upsertKeyframe({ track_id: trackId, target_type: 'prop', target_id: prop.prop_instance_id, property: 'y', time_ms: timeMs, value: Math.round(curY), recordHistory: false });
                upsertKeyframe({ track_id: trackId, target_type: 'prop', target_id: prop.prop_instance_id, property: 'rotation_deg', time_ms: timeMs, value: curRot, recordHistory: false });
                upsertKeyframe({ track_id: trackId, target_type: 'prop', target_id: prop.prop_instance_id, property: 'scale_x', time_ms: timeMs, value: curSx, recordHistory: false });
                upsertKeyframe({ track_id: trackId, target_type: 'prop', target_id: prop.prop_instance_id, property: 'scale_y', time_ms: timeMs, value: curSy, recordHistory: false });
                upsertKeyframe({ track_id: trackId, target_type: 'prop', target_id: prop.prop_instance_id, property: 'opacity', time_ms: timeMs, value: curOp, recordHistory: false });
              }}
            >
              <Diamond size={9} color="var(--track-keyframe)" /> {t('inspector.keyAll')}
            </button>
          }
          defaultOpen
        >
          <Vector2Control
            label={t('inspector.position')}
            x={curX}
            y={curY}
            unit="px"
            step={5}
            precision={1}
            disabled={isLocked}
            onScrubStart={pushHistorySnapshot}
            onReset={() => {
              setPropNumericField('x', prop.parent_id ? 0 : Math.round(project.meta.width / 2), true);
              setPropNumericField('y', prop.parent_id ? 0 : Math.round(project.meta.height / 2), false);
            }}
            onChangeX={(v) => setPropNumericField('x', v, true)}
            onChangeY={(v) => setPropNumericField('y', v, true)}
            xRightSlot={
              <KeyframeDiamondButton
                disabled={isLocked}
                atCurrentFrame={Boolean(findKeyframeAtTime(prop.prop_instance_id, 'x'))}
                hasAnyKeyframe={hasAnyKeyframe(prop.prop_instance_id, 'x')}
                onClick={() => togglePropKf('x', Number(curX.toFixed(1)))}
              />
            }
            yRightSlot={
              <KeyframeDiamondButton
                disabled={isLocked}
                atCurrentFrame={Boolean(findKeyframeAtTime(prop.prop_instance_id, 'y'))}
                hasAnyKeyframe={hasAnyKeyframe(prop.prop_instance_id, 'y')}
                onClick={() => togglePropKf('y', Number(curY.toFixed(1)))}
              />
            }
          />

          <NumericInput
            label={t('inspector.rotation')}
            shortTag="R"
            unit="°"
            step={1}
            precision={1}
            disabled={isLocked}
            value={curRot}
            onScrubStart={pushHistorySnapshot}
            onReset={() => setPropNumericField('rotation_deg', 0, true)}
            onChange={(v) => setPropNumericField('rotation_deg', v, true)}
            rightSlot={
              <KeyframeDiamondButton
                disabled={isLocked}
                atCurrentFrame={Boolean(findKeyframeAtTime(prop.prop_instance_id, 'rotation_deg'))}
                hasAnyKeyframe={hasAnyKeyframe(prop.prop_instance_id, 'rotation_deg')}
                onClick={() => togglePropKf('rotation_deg', Number(curRot.toFixed(1)))}
              />
            }
          />

          <Vector2Control
            label={t('inspector.scale')}
            xTag="SX"
            yTag="SY"
            x={curSx}
            y={curSy}
            min={0.05}
            max={10}
            step={0.05}
            precision={2}
            unit="x"
            disabled={isLocked}
            aspectLocked={scaleAspectLocked}
            onToggleAspectLock={() => setScaleAspectLocked((v) => !v)}
            onScrubStart={pushHistorySnapshot}
            onReset={() => setPropScaleBoth(1, 1, true)}
            onChangeX={(v) => handlePropScaleX(v, true)}
            onChangeY={(v) => handlePropScaleY(v, true)}
            xRightSlot={
              <KeyframeDiamondButton
                disabled={isLocked}
                atCurrentFrame={Boolean(findKeyframeAtTime(prop.prop_instance_id, 'scale_x'))}
                hasAnyKeyframe={hasAnyKeyframe(prop.prop_instance_id, 'scale_x')}
                onClick={() => togglePropKf('scale_x', Number(curSx.toFixed(2)))}
              />
            }
            yRightSlot={
              <KeyframeDiamondButton
                disabled={isLocked}
                atCurrentFrame={Boolean(findKeyframeAtTime(prop.prop_instance_id, 'scale_y'))}
                hasAnyKeyframe={hasAnyKeyframe(prop.prop_instance_id, 'scale_y')}
                onClick={() => togglePropKf('scale_y', Number(curSy.toFixed(2)))}
              />
            }
          />
          <PropertySlider
            ariaLabel={t('inspector.scale')}
            min={0.1}
            max={3}
            step={0.05}
            disabled={isLocked}
            value={curSx}
            onScrubStart={pushHistorySnapshot}
            onChange={(val) => handlePropScaleX(val, false)}
          />

          <Vector2Control
            label={t('inspector.pivot')}
            xTag="PX"
            yTag="PY"
            x={prop.anchor_x ?? 0.5}
            y={prop.anchor_y ?? 0.5}
            min={0}
            max={1}
            step={0.05}
            precision={2}
            disabled={isLocked}
            onReset={() =>
              updatePropInstance(scene.scene_id, prop.prop_instance_id, { anchor_x: 0.5, anchor_y: 0.5 })
            }
            onChangeX={(anchor_x) =>
              updatePropInstance(scene.scene_id, prop.prop_instance_id, { anchor_x })
            }
            onChangeY={(anchor_y) =>
              updatePropInstance(scene.scene_id, prop.prop_instance_id, { anchor_y })
            }
          />
        </CollapsibleSection>

        {/* 3. APPEARANCE SECTION */}
        <CollapsibleSection title={t('layer.appearanceSection')} icon={<Eye size={12} />} defaultOpen>
          <SliderWithInput
            label={t('inspector.opacity')}
            value={curOp}
            min={0}
            max={1}
            step={0.01}
            displayScale={100}
            unit="%"
            precision={0}
            disabled={isLocked}
            onScrubStart={pushHistorySnapshot}
            onReset={() => setPropNumericField('opacity', 1, true)}
            onChange={(val) => setPropNumericField('opacity', val, false)}
            rightSlot={
              <KeyframeDiamondButton
                disabled={isLocked}
                atCurrentFrame={Boolean(findKeyframeAtTime(prop.prop_instance_id, 'opacity'))}
                hasAnyKeyframe={hasAnyKeyframe(prop.prop_instance_id, 'opacity')}
                onClick={() => togglePropKf('opacity', Number(curOp.toFixed(2)))}
              />
            }
          />
        </CollapsibleSection>

        {/* 4. ANIMATION & PRESETS */}
        <CollapsibleSection title={t('inspector.presetsSection')} icon={<Wand2 size={12} />} defaultOpen>
          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{t('inspector.presetsDesc')}</span>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {ANIMATION_PRESETS.map((p) => (
              <button
                key={p.id}
                className="btn-xs"
                disabled={isLocked}
                onClick={() => handleApplyPropPreset(p.id)}
              >
                {t(p.labelKey)}
              </button>
            ))}
          </div>
        </CollapsibleSection>

        <CollapsibleSection
          title={t('inspector.propKeyframes')}
          icon={<Diamond size={12} color="var(--track-keyframe)" />}
          badge={propKfs.length}
          defaultOpen={propKfs.length > 0}
        >
          {propKfs.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t('inspector.noKeyframes')}</span>
              {copiedKeyframe && (
                <button
                  className="btn-xs"
                  style={{ alignSelf: 'flex-start' }}
                  onClick={() => {
                    if (pasteKeyframeAtTime(timeMs)) {
                      pushToast('info', t('inspector.pastedToast', { time: formatTimecode(timeMs) }));
                    }
                  }}
                >
                  <ClipboardPaste size={10} /> {t('inspector.pasteKeyframe')}
                </button>
              )}
            </div>
          ) : (
            renderKeyframeRows(propKfs)
          )}
        </CollapsibleSection>
      </div>
    );
  }

  // --- 4B. EXECUTED SHOT INSPECTOR (Phase 07 Batch 1) ---
  if (selection.type === 'shot' && selection.id) {
    let foundScene = null as (typeof project.scenes)[number] | null;
    let foundShot = null as NonNullable<(typeof project.scenes)[number]['shots']>[number] | null;
    for (const sc of project.scenes) {
      const sh = sc.shots?.find((item) => item.shot_id === selection.id);
      if (sh) {
        foundScene = sc;
        foundShot = sh;
        break;
      }
    }
    if (foundScene && foundShot) {
      const targetScene = foundScene;
      const targetShot = foundShot;
      const bgOptions = assets.filter((a) => a.type === 'background' || a.type === 'prop');
      return (
        <div className="panel-body" data-testid="right-inspector-shot">
          <div className="inspector-section">
            <div className="inspector-section-title">
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <Clapperboard size={12} color="var(--accent-text)" />
                {t('sceneExec.shotInspectorTitle', { order: targetShot.shot_order })}
              </span>
              <span className="director-badge edited">{targetShot.execution_status}</span>
            </div>

            <div className="field-row">
              <label className="field-label">{t('sceneExec.shotTitleLabel')}</label>
              <input
                value={targetShot.title}
                data-testid="shot-inspector-title-input"
                onChange={(e) =>
                  updateSceneShot(targetScene.scene_id, targetShot.shot_id, {
                    title: e.target.value,
                  })
                }
              />
            </div>

            <div className="field-grid">
              <div className="field-row">
                <label className="field-label">{t('inspector.duration')} (s)</label>
                <input
                  type="number"
                  min={0.5}
                  max={120}
                  step={0.1}
                  value={Number((targetShot.duration_ms / 1000).toFixed(2))}
                  data-testid="shot-inspector-duration-input"
                  onChange={(e) =>
                    updateSceneShot(targetScene.scene_id, targetShot.shot_id, {
                      duration_ms: Math.max(500, Math.round((Number(e.target.value) || 1) * 1000)),
                    })
                  }
                />
              </div>
              <div className="field-row">
                <label className="field-label">{t('sceneExec.shotTimingLabel')}</label>
                <div className="mono" style={{ fontSize: 10, paddingTop: 6, color: 'var(--text-secondary)' }}>
                  {((targetScene.start_ms + targetShot.start_ms) / 1000).toFixed(1)}s →{' '}
                  {((targetScene.start_ms + targetShot.start_ms + targetShot.duration_ms) / 1000).toFixed(1)}s
                </div>
              </div>
            </div>

            <div className="field-row">
              <label className="field-label">{t('sceneExec.shotBackgroundLabel')}</label>
              <select
                value={targetShot.background_asset_id ?? ''}
                data-testid="shot-inspector-bg-select"
                onChange={(e) =>
                  updateSceneShot(targetScene.scene_id, targetShot.shot_id, {
                    background_asset_id: e.target.value || null,
                  })
                }
              >
                <option value="">{t('sceneExec.inheritSceneBgOption')}</option>
                {bgOptions.map((a) => (
                  <option key={a.asset_id} value={a.asset_id}>
                    [{a.type}] {a.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <CollapsibleSection title={t('sceneExec.shotCameraSection')} icon={<Camera size={12} />} defaultOpen>
            <div className="field-grid">
              <div className="field-row">
                <label className="field-label">Cam X</label>
                <input
                  type="number"
                  value={targetShot.camera_default.x}
                  onChange={(e) =>
                    updateSceneShot(targetScene.scene_id, targetShot.shot_id, {
                      camera_default: { ...targetShot.camera_default, x: Number(e.target.value) || 0 },
                    })
                  }
                />
              </div>
              <div className="field-row">
                <label className="field-label">Cam Y</label>
                <input
                  type="number"
                  value={targetShot.camera_default.y}
                  onChange={(e) =>
                    updateSceneShot(targetScene.scene_id, targetShot.shot_id, {
                      camera_default: { ...targetShot.camera_default, y: Number(e.target.value) || 0 },
                    })
                  }
                />
              </div>
              <div className="field-row">
                <label className="field-label">Zoom</label>
                <input
                  type="number"
                  step={0.05}
                  min={0.2}
                  max={5}
                  value={targetShot.camera_default.zoom}
                  onChange={(e) =>
                    updateSceneShot(targetScene.scene_id, targetShot.shot_id, {
                      camera_default: {
                        ...targetShot.camera_default,
                        zoom: Math.max(0.2, Number(e.target.value) || 1),
                      },
                    })
                  }
                />
              </div>
              <div className="field-row">
                <label className="field-label">Rot (°)</label>
                <input
                  type="number"
                  value={targetShot.camera_default.rotation_deg}
                  onChange={(e) =>
                    updateSceneShot(targetScene.scene_id, targetShot.shot_id, {
                      camera_default: {
                        ...targetShot.camera_default,
                        rotation_deg: Number(e.target.value) || 0,
                      },
                    })
                  }
                />
              </div>
            </div>
          </CollapsibleSection>

          <CollapsibleSection
            title={t('sceneExec.shotObjectsSection')}
            icon={<Layers size={12} />}
            badge={targetShot.character_states.length + targetShot.prop_states.length}
            defaultOpen
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {targetShot.character_states.map((cs) => (
                <div
                  key={cs.instance_id}
                  className="list-card"
                  style={{ padding: '5px 7px', cursor: 'pointer' }}
                  onClick={() => setSelection({ type: 'character', id: cs.instance_id })}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <strong style={{ fontSize: 11 }}>{cs.display_name}</strong>
                    <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                      ({Math.round(cs.transform.x)}, {Math.round(cs.transform.y)}) z={cs.z_index}
                    </span>
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                    {cs.screen_position} • {cs.depth_layer} • {cs.facing_direction}
                  </div>
                </div>
              ))}
              {targetShot.prop_states.map((ps) => (
                <div
                  key={ps.prop_instance_id}
                  className="list-card"
                  style={{ padding: '5px 7px', cursor: 'pointer' }}
                  onClick={() => setSelection({ type: 'prop', id: ps.prop_instance_id })}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <strong style={{ fontSize: 11 }}>{ps.name}</strong>
                    <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                      [{ps.role}] z={ps.z_index}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </CollapsibleSection>

          <CollapsibleSection
            title={t('motionExec.shotAppliedMotionsTitle')}
            icon={<Sparkles size={12} color="var(--accent-text)" />}
            badge={(targetShot.applied_motions ?? []).length}
            defaultOpen
          >
            {(targetShot.applied_motions ?? []).length === 0 ? (
              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                {t('motionExec.shotNoAppliedMotions')}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }} data-testid="shot-inspector-applied-motions">
                {(targetShot.applied_motions ?? []).map((mot) => (
                  <div key={mot.motion_id} className="list-card" style={{ padding: '5px 7px', gap: 3 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 4 }}>
                      <strong style={{ fontSize: 11 }}>{mot.preset_name}</strong>
                      <span className="tag-pill mono" style={{ fontSize: 9 }}>
                        {mot.keyframe_ids.length} kf
                      </span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 10, color: 'var(--text-secondary)' }}>
                      <span>
                        {mot.target_kind} • {mot.support_level}
                        {mot.user_modified ? ` • ${t('motionExec.userEditedBadge')}` : ''}
                      </span>
                      <button
                        type="button"
                        className="btn-xs"
                        onClick={() =>
                          openAnimationExecModal({
                            shotIds: [targetShot.shot_id],
                            regenerateMotionIds: [mot.motion_id],
                          })
                        }
                      >
                        {t('motionExec.regenerateBtn')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <button
              type="button"
              className="btn-xs btn-primary"
              style={{ width: '100%' }}
              onClick={() => openAnimationExecModal({ shotIds: [targetShot.shot_id] })}
              data-testid="shot-inspector-exec-motion-btn"
            >
              <Sparkles size={11} /> {t('motionExec.execForShotBtn')}
            </button>
          </CollapsibleSection>

          {targetShot.staging_fallbacks.length > 0 && (
            <div className="director-callout warning" style={{ marginTop: 6, flexDirection: 'column', gap: 3 }}>
              <strong style={{ fontSize: 10 }}>{t('sceneExec.fallbacksNoticeTitle')}</strong>
              {targetShot.staging_fallbacks.map((fb, idx) => (
                <span key={idx} style={{ fontSize: 10 }}>• {fb}</span>
              ))}
            </div>
          )}
        </div>
      );
    }
  }

  return (
    <div className="panel-body">
      <EmptyState
        title={t('inspector.emptyTitle')}
        description={t('inspector.emptyDesc')}
        action={<Sliders size={14} color="var(--text-muted)" />}
      />
    </div>
  );
}
