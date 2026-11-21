import { create } from 'zustand';
import { repackScenesPreservingContent } from '@/engine/sceneTimeline';
import {
  applySaveResponse,
  dirtySections,
  mergeServerState,
  takeSnapshot,
  type SyncSnapshot,
} from '@/engine/projectSync';
import type {
  AnimationActionCategory,
  AnimationStateType,
  Asset,
  CameraMovement,
  CameraState,
  Character,
  CharacterAnimationClip,
  CharacterPartSlot,
  DirectorAnalysisDocument,
  DirectorReviewStatus,
  EasingType,
  ExtractedCharacter,
  Keyframe,
  KeyframeProperty,
  KeyframeTargetType,
  ProductionApprovalStatus,
  ProductionPlanDocument,
  ProductionShotPlan,
  ProjectState,
  ProjectSummary,
  Scene,
  SceneBreakdownItem,
  SceneCharacterInstance,
  ScenePropInstance,
  SceneShot,
  ScriptEntry,
  ScriptEntryType,
  ScriptScene,
  SelectionState,
  ShotCharacterStaging,
  SoundAsset,
  SoundEffectEvent,
  StoryboardDocument,
  StoryboardShot,
  SubtitleDocument,
  SubtitleSegment,
  SubtitleStyle,
  SubtitleStyleOverride,
  TimelineInsertionStrategy,
  TimelineTrack,
  Transform2D,
} from '@/types/models';
import {
  ensureSubtitleDocument,
  generateSubtitlesFromScript,
  mergeSubtitleSegments,
  splitSubtitleSegment,
} from '@/engine/subtitleEngine';
import {
  applyFrontToBackZOrder,
  computeDragReorderIds,
  computeStepMoveIds,
  getNextTopZIndex,
  getOrderedSceneLayers,
  reconcileProjectLayersAndTimeline,
} from '@/engine/layerSync';
import {
  applyDeleteKeyframes,
  applyDuplicateKeyframes,
  applyMoveKeyframes,
  applyMoveKeyframesToFrame,
  applyPasteKeyframes,
  applySetKeyframesEasing,
  getKeyframeFrame,
} from '@/engine/keyframeEngine';
import { msToFrame } from '@/engine/evaluator';
import {
  ensureProjectScript,
  moveArrayItemByDelta,
  recalculateScriptDurations,
  reorderArrayByIds,
} from '@/engine/scriptEngine';
import {
  acceptAllScenesInDoc,
  applyAcceptedScenesToProjectState,
  deleteSceneBreakdown,
  editExtractedCharacter,
  editSceneBreakdown,
  mergeExtractedCharacters,
  mergeSceneBreakdowns,
  moveSceneBreakdown,
  reorderSceneBreakdowns,
  resolveExtractedItemSpeaker,
  restoreAllOriginalScenes,
  restoreOriginalSceneBreakdown,
  separateExtractedCharacterAlias,
  setSceneReviewStatus,
  splitSceneBreakdown,
  type ApplyAcceptedResult,
} from '@/engine/directorEngine';
import {
  addShotCharacterStaging,
  addStoryboardShot,
  analyzeStoryboardContinuity,
  deleteStoryboardShot,
  duplicateStoryboardShot,
  editStoryboardShot,
  ensureStoryboardDocument,
  markContinuityWarning,
  moveStoryboardShot,
  recalculateSceneShotTimings,
  reconcileStageSceneDurationToShots,
  removeShotCharacterStaging,
  reorderStoryboardShotsInScene,
  restoreOriginalStoryboardShot,
  toggleLockStoryboardShot,
  updateShotCharacterStaging,
} from '@/engine/storyboardEngine';
import {
  applyProductionPlanToTimeline,
  approveAllProductionShots,
  approveSceneProductionShots,
  assignShotAudioSound,
  assignShotBackgroundAsset,
  assignShotCharacterLibrary,
  assignShotPropAsset,
  editProductionShotPlan,
  setProductionShotApproval,
  toggleLockProductionShot,
  updateShotAnimationCategory,
  updateShotCameraMovementPlan,
  type TimelineApplyResult,
} from '@/engine/productionEngine';
import {
  editSceneShotState,
  syncCharacterEditIntoActiveShot,
  syncPropEditIntoActiveShot,
} from '@/engine/sceneExecutionEngine';
import {
  generatePresetKeyframes,
  quantizeMsToFrameMs,
  type AnimationPresetId,
} from '@/engine/presets';
import { apiClient } from '@/services/apiClient';

const MAX_HISTORY = 80;

function cloneState<T>(obj: T): T {
  return structuredClone(obj);
}

function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

interface ProjectStore {
  projects: ProjectSummary[];
  project: ProjectState | null;
  activeSceneId: string | null;
  activeShotId: string | null;
  activeScriptSceneId: string | null;
  selectedScriptEntryId: string | null;
  selection: SelectionState;
  selectedKeyframeId: string | null;
  selectedKeyframeIds: string[];
  selectionAnchorKeyframeId: string | null;
  copiedKeyframe: Keyframe | null;
  copiedKeyframes: Keyframe[];
  isDirty: boolean;
  /** Phase 09.1: content + revisions of each section as last synced with the backend. */
  syncSnapshot: SyncSnapshot | null;
  /** Merge a newer server copy (background service writes) without losing unsaved edits. */
  syncFromServer: (fresh: ProjectState) => { keptLocal: string[]; adopted: string[] };
  isSaving: boolean;
  lastSavedAt: string | null;
  error: string | null;

  undoStack: ProjectState[];
  redoStack: ProjectState[];

  loadProjectList: () => Promise<void>;
  createProject: (payload: {
    name: string;
    description?: string;
    width?: number;
    height?: number;
    fps?: number;
    duration_ms?: number;
  }) => Promise<ProjectState>;
  openProject: (projectId: string) => Promise<void>;
  saveProject: (backup?: boolean) => Promise<void>;
  deleteProject: (projectId: string) => Promise<void>;
  replaceProjectFromRestore: (restored: ProjectState) => void;

  setSelection: (sel: SelectionState) => void;
  setSelectedKeyframeId: (kfId: string | null) => void;
  setSelectedKeyframeIds: (kfIds: string[], anchorId?: string | null) => void;
  selectKeyframe: (kfId: string, mode?: 'replace' | 'toggle' | 'add') => void;
  selectKeyframeRange: (orderedIds: string[], targetId: string) => void;
  clearKeyframeSelection: () => void;
  setActiveSceneId: (sceneId: string) => void;
  setActiveShotId: (shotId: string | null) => void;
  setActiveScriptSceneId: (scriptSceneId: string | null) => void;
  setSelectedScriptEntryId: (entryId: string | null) => void;
  setStageDimensions: (width: number, height: number) => void;

  // Generic state mutation with Undo/Redo support
  mutateProject: (mutator: (draft: ProjectState) => void, recordHistory?: boolean) => void;
  pushHistorySnapshot: () => void;
  previewKeyframesDuringDrag: (keyframes: Keyframe[]) => void;
  commitDragHistorySnapshot: (preDragSnapshot: ProjectState) => void;
  undo: () => void;
  redo: () => void;

  // Domain operations
  addScene: (name?: string, durationMs?: number) => void;
  updateScene: (sceneId: string, patch: Partial<Scene>) => void;
  deleteScene: (sceneId: string) => void;

  addCharacterToScene: (sceneId: string, characterId: string, displayName: string) => void;
  updateCharacterInstance: (
    sceneId: string,
    instanceId: string,
    patch: Partial<SceneCharacterInstance>,
    recordHistory?: boolean,
  ) => void;
  removeCharacterInstance: (sceneId: string, instanceId: string) => void;

  addPropToScene: (sceneId: string, assetId: string, name: string) => void;
  addEmptyLayer: (sceneId: string, name?: string) => string;
  updatePropInstance: (
    sceneId: string,
    propInstanceId: string,
    patch: Partial<ScenePropInstance>,
    recordHistory?: boolean,
  ) => void;
  removePropInstance: (sceneId: string, propInstanceId: string) => void;

  // Unified Layer management (synchronized across Scene Graph, Layer Panel, Inspector & Timeline)
  renameLayer: (sceneId: string, layerType: 'character' | 'prop', layerId: string, name: string) => void;
  setLayerVisibility: (
    sceneId: string,
    layerType: 'character' | 'prop',
    layerId: string,
    visible: boolean,
  ) => void;
  setLayerLocked: (
    sceneId: string,
    layerType: 'character' | 'prop',
    layerId: string,
    locked: boolean,
  ) => void;
  reorderSceneLayer: (
    sceneId: string,
    sourceId: string,
    targetId: string,
    position: 'before' | 'after',
  ) => boolean;
  moveSceneLayer: (
    sceneId: string,
    layerId: string,
    direction: 'up' | 'down' | 'front' | 'back',
  ) => boolean;

  upsertKeyframe: (params: {
    track_id: string;
    target_type: KeyframeTargetType;
    target_id: string;
    property: KeyframeProperty;
    time_ms: number;
    value: number | string;
    easing?: EasingType;
    recordHistory?: boolean;
  }) => void;
  moveKeyframe: (
    keyframeId: string,
    newTimeMs: number,
    recordHistory?: boolean,
  ) => { movedCount: number; replacedCount: number; clampedDeltaFrames: number };
  moveKeyframesByDeltaFrames: (
    keyframeIds: string[],
    deltaFrames: number,
    recordHistory?: boolean,
  ) => { movedCount: number; replacedCount: number; clampedDeltaFrames: number };
  moveKeyframesToFrame: (
    keyframeIds: string[],
    targetStartFrame: number,
  ) => { movedCount: number; replacedCount: number; clampedDeltaFrames: number };
  copyKeyframe: (kf: Keyframe) => void;
  copySelectedKeyframes: (explicitIds?: string[]) => number;
  pasteKeyframeAtTime: (timeMs: number) => boolean;
  pasteKeyframesAtTime: (timeMs: number) => { pastedIds: string[]; replacedCount: number };
  duplicateKeyframes: (
    keyframeIds: string[],
    offsetFrames?: number,
  ) => { createdIds: string[]; replacedCount: number };
  setKeyframesEasing: (keyframeIds: string[], easing: EasingType) => number;
  deleteKeyframe: (keyframeId: string) => void;
  deleteKeyframes: (keyframeIds: string[]) => number;
  applyAnimationPreset: (params: {
    presetId: AnimationPresetId;
    targetType: KeyframeTargetType;
    targetId: string;
    trackId: string;
    startFrame: number;
    baseTransform: Transform2D;
    baseCameraZoom?: number;
  }) => number;
  groupScenePropsIntoCharacter: (
    sceneId: string,
    characterName: string,
  ) => Promise<{ character: Character; partCount: number } | null>;

  addOrUpdateAnimationClip: (clip: Partial<CharacterAnimationClip> & { instance_id: string; start_ms: number; end_ms: number }) => void;
  deleteAnimationClip: (clipId: string) => void;

  addSfxTrack: () => void;
  addAudioTrack: (trackType: 'sfx' | 'bgm' | 'ambient' | 'voice') => string;
  ensureSubtitleTrack: () => string;
  addSoundToBestTrack: (
    sound: SoundAsset,
    startMs: number,
    sourceSceneId?: string | null,
    preferredTrackType?: 'sfx' | 'bgm' | 'ambient' | 'voice',
  ) => string;
  addVoiceClipToTimeline: (sound: SoundAsset, startMs: number, sourceSceneId?: string | null) => string;
  updateTrack: (trackId: string, patch: Partial<TimelineTrack>) => void;
  addSoundEvent: (trackId: string, sound: SoundAsset, startMs: number, sourceSceneId?: string | null) => void;
  updateSoundEvent: (eventId: string, patch: Partial<SoundEffectEvent>, recordHistory?: boolean) => void;
  deleteSoundEvent: (eventId: string) => void;

  // Subtitle Studio operations (independent timeline objects, Undo/Redo enabled)
  selectedSubtitleIds: string[];
  setSelectedSubtitleIds: (ids: string[], primaryId?: string | null) => void;
  addSubtitleSegment: (partial?: Partial<SubtitleSegment>) => string;
  updateSubtitleSegment: (
    subtitleId: string,
    patch: Partial<SubtitleSegment>,
    recordHistory?: boolean,
  ) => void;
  updateSubtitleStyleOverride: (
    subtitleId: string,
    patch: SubtitleStyleOverride,
    recordHistory?: boolean,
  ) => void;
  clearSubtitleStyleOverride: (subtitleId: string) => void;
  applySubtitleOverrideToStyle: (subtitleId: string) => void;
  deleteSubtitleSegments: (subtitleIds: string[]) => number;
  duplicateSubtitleSegment: (subtitleId: string) => string | null;
  splitSubtitleSegmentAt: (subtitleId: string, splitAtMs?: number) => [string, string] | null;
  mergeSubtitleSegmentsByIds: (subtitleIds: string[]) => string | null;
  moveSubtitleSegmentsByDelta: (
    subtitleIds: string[],
    deltaMs: number,
    recordHistory?: boolean,
  ) => void;
  upsertSubtitleStyle: (style: SubtitleStyle) => void;
  deleteSubtitleStyle: (styleId: string) => void;
  setDefaultSubtitleStyle: (styleId: string) => void;
  importSubtitles: (segments: SubtitleSegment[], mode: 'replace' | 'append') => number;
  generateSubtitlesFromProjectScript: (
    characters: Character[],
    options?: { mode?: 'replace' | 'append'; includeDialogue?: boolean; includeNarration?: boolean },
  ) => { total: number; voiceSyncedCount: number; estimatedCount: number };

  // Structured Script Engine operations (Undo/Redo enabled)
  updateScriptMeta: (patch: { episode_title?: string; raw_source_text?: string }) => void;
  addScriptScene: (title?: string) => string;
  updateScriptScene: (scriptSceneId: string, patch: Partial<ScriptScene>) => void;
  deleteScriptScene: (scriptSceneId: string) => void;
  reorderScriptScenes: (
    sourceId: string,
    targetId: string,
    position: 'before' | 'after',
  ) => boolean;
  moveScriptScene: (scriptSceneId: string, delta: -1 | 1) => boolean;
  addScriptEntry: (
    scriptSceneId: string,
    entryType: ScriptEntryType,
    characterId?: string | null,
  ) => string;
  updateScriptEntry: (
    scriptSceneId: string,
    entryId: string,
    patch: Partial<ScriptEntry>,
  ) => void;
  deleteScriptEntry: (scriptSceneId: string, entryId: string) => void;
  reorderScriptEntries: (
    scriptSceneId: string,
    sourceId: string,
    targetId: string,
    position: 'before' | 'after',
  ) => boolean;
  moveScriptEntry: (scriptSceneId: string, entryId: string, delta: -1 | 1) => boolean;
  syncScriptScenesToStage: () => number;

  updateCameraAtTime: (timeMs: number, patch: Partial<CameraState>, insertKeyframe?: boolean) => void;
  setTotalDurationMs: (durationMs: number) => void;

  // Phase 06 Batch 1 — AI Director Script Intelligence & Scene Breakdown actions
  setDirectorAnalysis: (doc: DirectorAnalysisDocument) => void;
  replaceDirectorScene: (scene: SceneBreakdownItem) => void;
  editDirectorCharacter: (
    characterAnalysisId: string,
    patch: Partial<
      Pick<
        ExtractedCharacter,
        | 'canonical_name'
        | 'aliases'
        | 'ambiguous_aliases'
        | 'role'
        | 'personality'
        | 'appearance_description'
        | 'appearance_specified'
        | 'relationships'
        | 'narrative_importance'
        | 'emotional_states'
        | 'actions'
        | 'linked_character_id'
        | 'review_status'
        | 'notes'
      >
    >,
  ) => void;
  mergeDirectorCharacters: (primaryId: string, secondaryId: string) => void;
  separateDirectorCharacterAlias: (sourceCharId: string, alias: string) => string | null;
  resolveDirectorItemSpeaker: (itemId: string, characterAnalysisId: string | null) => void;
  editDirectorScene: (
    sceneBreakdownId: string,
    patch: Partial<
      Omit<
        SceneBreakdownItem,
        'scene_breakdown_id' | 'scene_number' | 'original_ai_snapshot' | 'user_edited_fields'
      >
    >,
  ) => void;
  setDirectorSceneStatus: (sceneBreakdownId: string, status: DirectorReviewStatus) => void;
  acceptAllDirectorScenes: () => void;
  splitDirectorScene: (
    sceneBreakdownId: string,
    splitAtParagraphPos?: number,
  ) => { firstId: string; secondId: string } | null;
  mergeDirectorScenes: (sceneBreakdownIds: string[]) => string | null;
  reorderDirectorScenes: (
    sourceId: string,
    targetId: string,
    position: 'before' | 'after',
  ) => boolean;
  moveDirectorScene: (sceneBreakdownId: string, delta: -1 | 1) => boolean;
  deleteDirectorScene: (sceneBreakdownId: string) => void;
  restoreDirectorScene: (sceneBreakdownId: string) => void;
  restoreAllDirectorScenes: () => void;
  applyAcceptedDirectorScenes: (options?: { createStageScenes?: boolean }) => ApplyAcceptedResult;

  // Phase 06 Batch 2 — AI Storyboard, Shot Planning & Continuity actions
  setStoryboardDocument: (doc: StoryboardDocument) => void;
  replaceStoryboardShot: (shot: StoryboardShot) => void;
  addStoryboardShot: (params: {
    sceneId: string;
    sceneBreakdownId?: string | null;
    scriptSceneId?: string | null;
    afterShotId?: string | null;
    environment?: string;
    title?: string;
  }) => string;
  duplicateStoryboardShot: (shotId: string) => string | null;
  deleteStoryboardShot: (shotId: string) => void;
  editStoryboardShot: (
    shotId: string,
    patch: Partial<
      Omit<
        StoryboardShot,
        'shot_id' | 'scene_id' | 'shot_order' | 'start_time_ms' | 'end_time_ms' | 'original_ai_snapshot' | 'user_edited_fields'
      >
    >,
  ) => void;
  toggleLockStoryboardShot: (shotId: string, locked?: boolean) => void;
  moveStoryboardShot: (shotId: string, delta: -1 | 1) => boolean;
  reorderStoryboardShots: (
    sourceShotId: string,
    targetShotId: string,
    position: 'before' | 'after',
  ) => boolean;
  addShotCharacter: (
    shotId: string,
    character: {
      characterName: string;
      libraryCharacterId?: string | null;
      characterAnalysisId?: string | null;
    },
  ) => void;
  updateShotCharacter: (
    shotId: string,
    stagingId: string,
    patch: Partial<ShotCharacterStaging>,
    libraryCharacters?: Character[],
  ) => void;
  removeShotCharacter: (shotId: string, stagingId: string) => void;
  restoreOriginalStoryboardShot: (shotId: string) => void;
  markStoryboardContinuityWarning: (
    warningId: string,
    patch: { reviewed?: boolean; dismissed?: boolean },
  ) => void;
  reconcileSceneDurationToStoryboard: (sceneId: string) => { updated: boolean; newDurationMs: number };

  // Phase 06 Batch 3 — AI Production Planner & Timeline Integration actions
  setProductionPlanDocument: (doc: ProductionPlanDocument) => void;
  replaceProductionShotPlan: (shot: ProductionShotPlan) => void;
  editProductionShotPlan: (
    productionShotId: string,
    patch: Partial<
      Omit<
        ProductionShotPlan,
        'production_shot_id' | 'shot_id' | 'scene_id' | 'original_ai_snapshot' | 'user_edited_fields'
      >
    >,
    libCtx?: { characters: Character[]; assets: Asset[]; sounds: SoundAsset[] },
  ) => void;
  toggleLockProductionShot: (productionShotId: string, locked?: boolean) => void;
  setProductionShotApproval: (productionShotId: string, approval: ProductionApprovalStatus) => void;
  approveSceneProductionShots: (sceneId: string) => void;
  approveAllProductionShots: () => void;
  assignProductionBackground: (
    productionShotId: string,
    asset: Asset | null,
    libCtx: { characters: Character[]; assets: Asset[]; sounds: SoundAsset[] },
  ) => void;
  assignProductionPropAsset: (
    productionShotId: string,
    requirementId: string,
    asset: Asset | null,
    libCtx: { characters: Character[]; assets: Asset[]; sounds: SoundAsset[] },
  ) => void;
  assignProductionCharacter: (
    productionShotId: string,
    stagingId: string,
    character: Character | null,
    libCtx: { characters: Character[]; assets: Asset[]; sounds: SoundAsset[] },
  ) => void;
  assignProductionAudio: (
    productionShotId: string,
    listKind: 'sfx' | 'bgm',
    audioPlanId: string,
    sound: SoundAsset | null,
    libCtx: { characters: Character[]; assets: Asset[]; sounds: SoundAsset[] },
  ) => void;
  updateProductionCameraMovement: (
    productionShotId: string,
    cameraMovement: CameraMovement,
    libCtx: { characters: Character[]; assets: Asset[]; sounds: SoundAsset[] },
  ) => void;
  updateProductionAnimationCategory: (
    productionShotId: string,
    actionPlanId: string,
    category: AnimationActionCategory,
    libCtx: { characters: Character[]; assets: Asset[]; sounds: SoundAsset[] },
  ) => void;
  applyProductionPlanToProjectTimeline: (options: {
    targetShotIds: string[];
    strategy: TimelineInsertionStrategy;
    characters: Character[];
    assets: Asset[];
    sounds: SoundAsset[];
  }) => TimelineApplyResult;

  // Phase 07 Batch 1 — Scene Execution Engine & Editable Shot State Management
  applyExecutedProjectState: (updated: ProjectState, recordHistory?: boolean) => void;
  updateSceneShot: (
    sceneId: string,
    shotId: string,
    patch: Partial<
      Pick<
        SceneShot,
        | 'title'
        | 'duration_ms'
        | 'background_asset_id'
        | 'background_color'
        | 'camera_default'
        | 'character_states'
        | 'prop_states'
      >
    >,
  ) => void;
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  projects: [],
  project: null,
  activeSceneId: null,
  activeShotId: null,
  activeScriptSceneId: null,
  selectedScriptEntryId: null,
  selection: { type: 'none', id: null },
  selectedKeyframeId: null,
  selectedKeyframeIds: [],
  selectionAnchorKeyframeId: null,
  selectedSubtitleIds: [],
  copiedKeyframe: null,
  copiedKeyframes: [],
  isDirty: false,
  syncSnapshot: null,
  isSaving: false,
  lastSavedAt: null,
  error: null,
  undoStack: [],
  redoStack: [],

  loadProjectList: async () => {
    const projects = await apiClient.listProjects();
    set({ projects });
  },

  createProject: async (payload) => {
    const created = await apiClient.createProject(payload);
    reconcileProjectLayersAndTimeline(created);
    const projects = await apiClient.listProjects();
    set({
      projects,
      project: created,
      syncSnapshot: takeSnapshot(created),
      activeSceneId: created.scenes[0]?.scene_id ?? null,
      activeScriptSceneId: created.script?.scenes[0]?.script_scene_id ?? null,
      selectedScriptEntryId: null,
      selection: { type: 'none', id: null },
      selectedKeyframeId: null,
      selectedKeyframeIds: [],
      selectionAnchorKeyframeId: null,
      isDirty: false,
      lastSavedAt: created.meta.updated_at,
      undoStack: [],
      redoStack: [],
      error: null,
    });
    return created;
  },

  openProject: async (projectId) => {
    const loaded = await apiClient.getProject(projectId);
    reconcileProjectLayersAndTimeline(loaded);
    set({
      project: loaded,
      syncSnapshot: takeSnapshot(loaded),
      activeSceneId: loaded.scenes[0]?.scene_id ?? null,
      activeScriptSceneId: loaded.script?.scenes[0]?.script_scene_id ?? null,
      selectedScriptEntryId: null,
      selection: { type: 'none', id: null },
      selectedKeyframeId: null,
      selectedKeyframeIds: [],
      selectionAnchorKeyframeId: null,
      isDirty: false,
      lastSavedAt: loaded.meta.updated_at,
      undoStack: [],
      redoStack: [],
      error: null,
    });
  },

  saveProject: async (backup = false) => {
    const { project, isSaving, syncSnapshot } = get();
    if (!project || isSaving) return;
    const dirty = dirtySections(project, syncSnapshot);
    if (dirty.length === 0 && !backup) {
      set({ isDirty: false });
      return;
    }
    set({ isSaving: true, error: null });
    try {
      // Send the revisions this copy is based on so the server can detect concurrent changes.
      const sent: ProjectState = { ...project, revisions: { ...(syncSnapshot?.revisions ?? project.revisions ?? {}) } };
      const { state: saved, conflicts } = await apiClient.saveProjectSections(sent, dirty, backup);
      set((s) => {
        if (!s.project || s.project.meta.project_id !== saved.meta.project_id) {
          return { isSaving: false };
        }
        const res = applySaveResponse(s.project, sent, saved, dirty, s.syncSnapshot);
        return {
          project: res.project,
          syncSnapshot: res.snapshot,
          // edits made while the request was in flight stay dirty and are autosaved next
          isDirty: res.stillDirty,
          isSaving: false,
          lastSavedAt: saved.meta.updated_at,
        };
      });
      if (conflicts.length > 0) {
        set({
          error: `Another process changed ${conflicts.join(', ')} while you were editing. Your version was saved; the previous version is in Backups (tag "conflict").`,
        });
      }
      void get().loadProjectList();
    } catch (err) {
      set({
        isSaving: false,
        error: err instanceof Error ? err.message : 'Failed to save project',
      });
      throw err;
    }
  },

  syncFromServer: (fresh) => {
    const { project, syncSnapshot } = get();
    if (!project || project.meta.project_id !== fresh.meta.project_id) return { keptLocal: [], adopted: [] };
    reconcileProjectLayersAndTimeline(fresh);
    const res = mergeServerState(project, fresh, syncSnapshot, false);
    if (res.adopted.length === 0 && res.keptLocal.length === 0) {
      set({ syncSnapshot: res.snapshot });
      return { keptLocal: [], adopted: [] };
    }
    set({
      project: res.project,
      syncSnapshot: res.snapshot,
      isDirty: dirtySections(res.project, res.snapshot).length > 0,
    });
    return { keptLocal: res.keptLocal, adopted: res.adopted };
  },

  deleteProject: async (projectId) => {
    await apiClient.deleteProject(projectId);
    const projects = await apiClient.listProjects();
    set((s) => ({
      projects,
      project: s.project?.meta.project_id === projectId ? null : s.project,
    }));
  },

  replaceProjectFromRestore: (restored) => {
    reconcileProjectLayersAndTimeline(restored);
    set({
      project: restored,
      syncSnapshot: takeSnapshot(restored),
      activeSceneId: restored.scenes[0]?.scene_id ?? null,
      activeScriptSceneId: restored.script?.scenes[0]?.script_scene_id ?? null,
      selectedScriptEntryId: null,
      selection: { type: 'none', id: null },
      selectedKeyframeId: null,
      selectedKeyframeIds: [],
      selectionAnchorKeyframeId: null,
      isDirty: false,
      lastSavedAt: restored.meta.updated_at,
      undoStack: [],
      redoStack: [],
    });
  },

  setSelection: (selection) => set({ selection }),
  setSelectedKeyframeId: (selectedKeyframeId) =>
    set({
      selectedKeyframeId,
      selectedKeyframeIds: selectedKeyframeId ? [selectedKeyframeId] : [],
      selectionAnchorKeyframeId: selectedKeyframeId,
    }),
  setSelectedKeyframeIds: (kfIds, anchorId) => {
    const unique = Array.from(new Set(kfIds));
    set((s) => ({
      selectedKeyframeIds: unique,
      selectedKeyframeId: unique.length > 0 ? unique[unique.length - 1] : null,
      selectionAnchorKeyframeId:
        anchorId !== undefined
          ? anchorId
          : unique.length > 0
            ? (s.selectionAnchorKeyframeId && unique.includes(s.selectionAnchorKeyframeId)
                ? s.selectionAnchorKeyframeId
                : unique[0])
            : null,
    }));
  },
  selectKeyframe: (kfId, mode = 'replace') => {
    set((s) => {
      if (mode === 'replace') {
        return {
          selectedKeyframeIds: [kfId],
          selectedKeyframeId: kfId,
          selectionAnchorKeyframeId: kfId,
        };
      }
      if (mode === 'add') {
        if (s.selectedKeyframeIds.includes(kfId)) {
          return { selectedKeyframeId: kfId };
        }
        const next = [...s.selectedKeyframeIds, kfId];
        return {
          selectedKeyframeIds: next,
          selectedKeyframeId: kfId,
          selectionAnchorKeyframeId: s.selectionAnchorKeyframeId ?? kfId,
        };
      }
      // toggle (Ctrl / Cmd click)
      const exists = s.selectedKeyframeIds.includes(kfId);
      const next = exists
        ? s.selectedKeyframeIds.filter((id) => id !== kfId)
        : [...s.selectedKeyframeIds, kfId];
      return {
        selectedKeyframeIds: next,
        selectedKeyframeId: next.length > 0 ? next[next.length - 1] : null,
        selectionAnchorKeyframeId: exists
          ? (next.length > 0 ? next[next.length - 1] : null)
          : kfId,
      };
    });
  },
  selectKeyframeRange: (orderedIds, targetId) => {
    set((s) => {
      const anchor = s.selectionAnchorKeyframeId ?? s.selectedKeyframeId;
      if (!anchor) {
        return {
          selectedKeyframeIds: [targetId],
          selectedKeyframeId: targetId,
          selectionAnchorKeyframeId: targetId,
        };
      }
      const aIdx = orderedIds.indexOf(anchor);
      const tIdx = orderedIds.indexOf(targetId);
      if (aIdx === -1 || tIdx === -1) {
        const merged = Array.from(new Set([...s.selectedKeyframeIds, targetId]));
        return {
          selectedKeyframeIds: merged,
          selectedKeyframeId: targetId,
          selectionAnchorKeyframeId: anchor,
        };
      }
      const lo = Math.min(aIdx, tIdx);
      const hi = Math.max(aIdx, tIdx);
      const slice = orderedIds.slice(lo, hi + 1);
      const merged = Array.from(new Set([...s.selectedKeyframeIds, ...slice]));
      return {
        selectedKeyframeIds: merged,
        selectedKeyframeId: targetId,
        selectionAnchorKeyframeId: anchor,
      };
    });
  },
  clearKeyframeSelection: () =>
    set({
      selectedKeyframeIds: [],
      selectedKeyframeId: null,
      selectionAnchorKeyframeId: null,
    }),
  setActiveSceneId: (activeSceneId) => set({ activeSceneId }),
  setActiveShotId: (activeShotId) => set({ activeShotId }),
  setActiveScriptSceneId: (activeScriptSceneId) =>
    set({ activeScriptSceneId, selectedScriptEntryId: null }),
  setSelectedScriptEntryId: (selectedScriptEntryId) => set({ selectedScriptEntryId }),
  setStageDimensions: (width, height) => {
    get().mutateProject((draft) => {
      draft.meta.width = Math.max(320, Math.min(3840, Math.round(width)));
      draft.meta.height = Math.max(240, Math.min(2160, Math.round(height)));
    });
  },

  pushHistorySnapshot: () => {
    const { project, undoStack } = get();
    if (!project) return;
    const nextUndo = [...undoStack, cloneState(project)].slice(-MAX_HISTORY);
    set({ undoStack: nextUndo, redoStack: [] });
  },

  previewKeyframesDuringDrag: (keyframes) => {
    set((s) => {
      if (!s.project) return s;
      return {
        project: {
          ...s.project,
          timeline: {
            ...s.project.timeline,
            keyframes,
          },
        },
      };
    });
  },

  commitDragHistorySnapshot: (preDragSnapshot) => {
    set((s) => ({
      isDirty: true,
      undoStack: [...s.undoStack, preDragSnapshot].slice(-MAX_HISTORY),
      redoStack: [],
    }));
  },

  mutateProject: (mutator, recordHistory = true) => {
    const { project, undoStack } = get();
    if (!project) return;
    const snapshot = recordHistory ? cloneState(project) : null;
    const draft = cloneState(project);
    mutator(draft);
    // Keep Scene Layers <-> MasterTimeline tracks and meta fields strictly synchronized
    reconcileProjectLayersAndTimeline(draft);
    draft.meta.duration_ms = draft.timeline.total_duration_ms;
    draft.meta.fps = draft.timeline.fps;
    const liveKfIds = new Set(draft.timeline.keyframes.map((k) => k.keyframe_id));
    set((s) => {
      const prunedSel = s.selectedKeyframeIds.filter((id) => liveKfIds.has(id));
      return {
        project: draft,
        isDirty: true,
        selectedKeyframeIds: prunedSel,
        selectedKeyframeId: prunedSel.length > 0 ? prunedSel[prunedSel.length - 1] : null,
        selectionAnchorKeyframeId:
          s.selectionAnchorKeyframeId && liveKfIds.has(s.selectionAnchorKeyframeId)
            ? s.selectionAnchorKeyframeId
            : (prunedSel[0] ?? null),
        undoStack: snapshot ? [...undoStack, snapshot].slice(-MAX_HISTORY) : undoStack,
        redoStack: recordHistory ? [] : s.redoStack,
      };
    });
  },

  undo: () => {
    const { undoStack, project, redoStack, selectedKeyframeIds, selectionAnchorKeyframeId } = get();
    if (undoStack.length === 0 || !project) return;
    const prev = undoStack[undoStack.length - 1];
    const liveIds = new Set(prev.timeline.keyframes.map((k) => k.keyframe_id));
    const pruned = selectedKeyframeIds.filter((id) => liveIds.has(id));
    set({
      project: prev,
      undoStack: undoStack.slice(0, -1),
      redoStack: [...redoStack, cloneState(project)].slice(-MAX_HISTORY),
      selectedKeyframeIds: pruned,
      selectedKeyframeId: pruned.length > 0 ? pruned[pruned.length - 1] : null,
      selectionAnchorKeyframeId:
        selectionAnchorKeyframeId && liveIds.has(selectionAnchorKeyframeId)
          ? selectionAnchorKeyframeId
          : (pruned[0] ?? null),
      isDirty: true,
    });
  },

  redo: () => {
    const { redoStack, project, undoStack, selectedKeyframeIds, selectionAnchorKeyframeId } = get();
    if (redoStack.length === 0 || !project) return;
    const next = redoStack[redoStack.length - 1];
    const liveIds = new Set(next.timeline.keyframes.map((k) => k.keyframe_id));
    const pruned = selectedKeyframeIds.filter((id) => liveIds.has(id));
    set({
      project: next,
      redoStack: redoStack.slice(0, -1),
      undoStack: [...undoStack, cloneState(project)].slice(-MAX_HISTORY),
      selectedKeyframeIds: pruned,
      selectedKeyframeId: pruned.length > 0 ? pruned[pruned.length - 1] : null,
      selectionAnchorKeyframeId:
        selectionAnchorKeyframeId && liveIds.has(selectionAnchorKeyframeId)
          ? selectionAnchorKeyframeId
          : (pruned[0] ?? null),
      isDirty: true,
    });
  },

  addScene: (name, durationMs = 10000) => {
    get().mutateProject((draft) => {
      const sorted = [...draft.scenes].sort((a, b) => a.start_ms - b.start_ms);
      const last = sorted[sorted.length - 1];
      const startMs = last ? last.start_ms + last.duration_ms : 0;
      const newScene: Scene = {
        scene_id: uid('scene'),
        project_id: draft.meta.project_id,
        order_index: draft.scenes.length,
        name: name || `Scene ${draft.scenes.length + 1}`,
        start_ms: startMs,
        duration_ms: durationMs,
        background_asset_id: null,
        background_color: '#14161A',
        transition_in: draft.scenes.length > 0 ? 'fade' : 'cut',
        transition_duration_ms: 500,
        camera_default: { x: 0, y: 0, zoom: 1, rotation_deg: 0 },
        characters: [],
        props: [],
      };
      draft.scenes.push(newScene);
      const endMs = startMs + durationMs;
      if (endMs > draft.timeline.total_duration_ms) {
        draft.timeline.total_duration_ms = endMs;
      }
      set({ activeSceneId: newScene.scene_id });
    });
  },

  updateScene: (sceneId, patch) => {
    get().mutateProject((draft) => {
      const idx = draft.scenes.findIndex((s) => s.scene_id === sceneId);
      if (idx === -1) return;
      if (patch.duration_ms === undefined) {
        draft.scenes[idx] = { ...draft.scenes[idx], ...patch };
        return;
      }
      // Re-pack scene start_ms sequentially when durations change — and move every later scene's
      // keyframes / clips / audio / subtitles with it (Phase 09.1).
      repackScenesPreservingContent(draft, (d) => {
        d.scenes[idx] = { ...d.scenes[idx], ...patch };
        let cursor = 0;
        for (const sc of d.scenes) {
          sc.start_ms = cursor;
          cursor += sc.duration_ms;
        }
        if (cursor > d.timeline.total_duration_ms) {
          d.timeline.total_duration_ms = cursor;
        }
      });
    });
  },

  deleteScene: (sceneId) => {
    get().mutateProject((draft) => {
      if (draft.scenes.length <= 1) return;
      // Phase 09.1: remove the deleted scene's content and move later scenes' content with them
      repackScenesPreservingContent(draft, (d) => {
        d.scenes = d.scenes.filter((s) => s.scene_id !== sceneId);
        let cursor = 0;
        d.scenes.forEach((sc, i) => {
          sc.order_index = i;
          sc.start_ms = cursor;
          cursor += sc.duration_ms;
        });
      });
    });
    const st = get();
    if (st.activeSceneId === sceneId && st.project?.scenes[0]) {
      set({ activeSceneId: st.project.scenes[0].scene_id });
    }
  },

  addCharacterToScene: (sceneId, characterId, displayName) => {
    let createdInstId = '';
    get().mutateProject((draft) => {
      const scene = draft.scenes.find((s) => s.scene_id === sceneId);
      if (!scene) return;
      const instId = uid('inst');
      createdInstId = instId;
      const offsetIdx = scene.characters.length;
      const inst: SceneCharacterInstance = {
        instance_id: instId,
        scene_id: sceneId,
        character_id: characterId,
        display_name: displayName,
        z_index: getNextTopZIndex(scene),
        visible: true,
        locked: false,
        initial_transform: {
          x: Math.round(draft.meta.width * 0.5 + offsetIdx * 160 - 80 * (offsetIdx > 0 ? 1 : 0)),
          y: Math.round(draft.meta.height * 0.62),
          rotation_deg: 0,
          scale_x: 1,
          scale_y: 1,
          opacity: 1,
        },
        default_expression_id: null,
        default_pose_id: null,
        default_eye_state: 'open',
        default_mouth_state: 'closed',
      };
      scene.characters.push(inst);

      // Create dedicated Character Track on Master Timeline + default IDLE clip with Auto-Blink & Breathing
      const trackId = uid('trk_char');
      draft.timeline.tracks.push({
        track_id: trackId,
        project_id: draft.meta.project_id,
        track_type: 'character',
        name: displayName,
        target_ref_id: instId,
        order_index: 10,
        muted: false,
        locked: false,
        solo: false,
        visible: true,
        volume: 1,
        collapsed: false,
      });

      draft.timeline.animation_clips.push({
        clip_id: uid('aclip'),
        track_id: trackId,
        instance_id: instId,
        start_ms: scene.start_ms,
        end_ms: scene.start_ms + scene.duration_ms,
        animation_state: 'IDLE',
        procedural: {
          auto_blink: true,
          blink_interval_ms: 3500,
          blink_duration_ms: 140,
          breathing: true,
          breathing_amplitude: 0.015,
          breathing_period_ms: 3200,
          walk_bounce_px: 12,
          walk_cycle_ms: 600,
        },
      });
    });

    if (createdInstId) {
      set({ selection: { type: 'character', id: createdInstId } });
    }
  },

  updateCharacterInstance: (sceneId, instanceId, patch, recordHistory = true) => {
    const activeShotId = get().activeShotId;
    get().mutateProject((draft) => {
      const scene = draft.scenes.find((s) => s.scene_id === sceneId);
      if (!scene) return;
      const idx = scene.characters.findIndex((c) => c.instance_id === instanceId);
      if (idx === -1) return;
      // If editing while an executed SceneShot is active, isolate transform/pose/expression/visibility into that shot!
      const isolated = syncCharacterEditIntoActiveShot(scene, activeShotId, instanceId, patch);
      if (!isolated) {
        scene.characters[idx] = { ...scene.characters[idx], ...patch };
      } else {
        // Still apply scene-wide metadata like display_name or locked
        if (patch.display_name !== undefined) scene.characters[idx].display_name = patch.display_name;
        if (patch.locked !== undefined) scene.characters[idx].locked = patch.locked;
      }
    }, recordHistory);
  },

  removeCharacterInstance: (sceneId, instanceId) => {
    get().mutateProject((draft) => {
      const scene = draft.scenes.find((s) => s.scene_id === sceneId);
      if (!scene) return;
      scene.characters = scene.characters.filter((c) => c.instance_id !== instanceId);
      if (scene.shots) {
        for (const sh of scene.shots) {
          sh.character_states = sh.character_states.filter((cs) => cs.instance_id !== instanceId);
        }
      }
      draft.timeline.tracks = draft.timeline.tracks.filter((t) => t.target_ref_id !== instanceId);
      draft.timeline.animation_clips = draft.timeline.animation_clips.filter(
        (c) => c.instance_id !== instanceId,
      );
      draft.timeline.keyframes = draft.timeline.keyframes.filter(
        (k) => k.target_id !== instanceId && !k.target_id.startsWith(`${instanceId}:`),
      );
    });
    if (get().selection.id === instanceId) {
      set({ selection: { type: 'none', id: null } });
    }
  },

  addPropToScene: (sceneId, assetId, name) => {
    let propId = '';
    get().mutateProject((draft) => {
      const scene = draft.scenes.find((s) => s.scene_id === sceneId);
      if (!scene) return;
      propId = uid('prop');
      scene.props.push({
        prop_instance_id: propId,
        asset_id: assetId,
        layer_kind: 'prop',
        name,
        z_index: getNextTopZIndex(scene),
        anchor_x: 0.5,
        anchor_y: 0.5,
        visible: true,
        locked: false,
        parent_id: null,
        transform: {
          x: Math.round(draft.meta.width * 0.5),
          y: Math.round(draft.meta.height * 0.5),
          rotation_deg: 0,
          scale_x: 1,
          scale_y: 1,
          opacity: 1,
        },
      });
    });
    if (propId) {
      set({ selection: { type: 'prop', id: propId } });
    }
  },

  addEmptyLayer: (sceneId, name) => {
    let layerId = '';
    get().mutateProject((draft) => {
      const scene = draft.scenes.find((s) => s.scene_id === sceneId);
      if (!scene) return;
      layerId = uid('layer');
      const totalLayers = scene.characters.length + scene.props.length + 1;
      scene.props.push({
        prop_instance_id: layerId,
        asset_id: null,
        layer_kind: 'empty',
        name: name?.trim() || `Layer ${totalLayers}`,
        z_index: getNextTopZIndex(scene),
        anchor_x: 0.5,
        anchor_y: 0.5,
        visible: true,
        locked: false,
        parent_id: null,
        transform: {
          x: Math.round(draft.meta.width * 0.5),
          y: Math.round(draft.meta.height * 0.5),
          rotation_deg: 0,
          scale_x: 1,
          scale_y: 1,
          opacity: 1,
        },
      });
    });
    if (layerId) {
      set({ selection: { type: 'prop', id: layerId } });
    }
    return layerId;
  },

  updatePropInstance: (sceneId, propInstanceId, patch, recordHistory = true) => {
    const activeShotId = get().activeShotId;
    get().mutateProject((draft) => {
      const scene = draft.scenes.find((s) => s.scene_id === sceneId);
      if (!scene) return;
      const idx = scene.props.findIndex((p) => p.prop_instance_id === propInstanceId);
      if (idx === -1) return;
      const isolated = syncPropEditIntoActiveShot(scene, activeShotId, propInstanceId, patch);
      if (!isolated) {
        const nextProp = { ...scene.props[idx], ...patch };
        if (patch.asset_id !== undefined) {
          nextProp.layer_kind = patch.asset_id ? 'prop' : 'empty';
        }
        scene.props[idx] = nextProp;
      } else {
        if (patch.name !== undefined) scene.props[idx].name = patch.name;
        if (patch.locked !== undefined) scene.props[idx].locked = patch.locked;
        if (patch.asset_id !== undefined) {
          scene.props[idx].asset_id = patch.asset_id;
          scene.props[idx].layer_kind = patch.asset_id ? 'prop' : 'empty';
        }
      }
    }, recordHistory);
  },

  removePropInstance: (sceneId, propInstanceId) => {
    get().mutateProject((draft) => {
      const scene = draft.scenes.find((s) => s.scene_id === sceneId);
      if (!scene) return;
      scene.props = scene.props
        .filter((p) => p.prop_instance_id !== propInstanceId)
        .map((p) => (p.parent_id === propInstanceId ? { ...p, parent_id: null } : p));
      if (scene.shots) {
        for (const sh of scene.shots) {
          sh.prop_states = sh.prop_states.filter((ps) => ps.prop_instance_id !== propInstanceId);
        }
      }
      draft.timeline.tracks = draft.timeline.tracks.filter(
        (t) => t.target_ref_id !== propInstanceId,
      );
      draft.timeline.keyframes = draft.timeline.keyframes.filter(
        (k) => k.target_id !== propInstanceId,
      );
    });
    if (get().selection.id === propInstanceId) {
      set({ selection: { type: 'none', id: null } });
    }
  },

  renameLayer: (sceneId, layerType, layerId, name) => {
    const cleaned = name.trim();
    if (!cleaned) return;
    get().mutateProject((draft) => {
      const scene = draft.scenes.find((s) => s.scene_id === sceneId);
      if (!scene) return;
      if (layerType === 'character') {
        const inst = scene.characters.find((c) => c.instance_id === layerId);
        if (inst) inst.display_name = cleaned;
      } else {
        const prop = scene.props.find((p) => p.prop_instance_id === layerId);
        if (prop) prop.name = cleaned;
      }
    });
  },

  setLayerVisibility: (sceneId, layerType, layerId, visible) => {
    get().mutateProject((draft) => {
      const scene = draft.scenes.find((s) => s.scene_id === sceneId);
      if (!scene) return;
      if (layerType === 'character') {
        const inst = scene.characters.find((c) => c.instance_id === layerId);
        if (inst) inst.visible = visible;
      } else {
        const prop = scene.props.find((p) => p.prop_instance_id === layerId);
        if (prop) prop.visible = visible;
      }
    });
  },

  setLayerLocked: (sceneId, layerType, layerId, locked) => {
    get().mutateProject((draft) => {
      const scene = draft.scenes.find((s) => s.scene_id === sceneId);
      if (!scene) return;
      if (layerType === 'character') {
        const inst = scene.characters.find((c) => c.instance_id === layerId);
        if (inst) inst.locked = locked;
      } else {
        const prop = scene.props.find((p) => p.prop_instance_id === layerId);
        if (prop) prop.locked = locked;
      }
    });
  },

  reorderSceneLayer: (sceneId, sourceId, targetId, position) => {
    const project = get().project;
    if (!project) return false;
    const scene = project.scenes.find((s) => s.scene_id === sceneId);
    if (!scene) return false;
    const ordered = getOrderedSceneLayers(scene);
    const nextIds = computeDragReorderIds(ordered, sourceId, targetId, position);
    if (!nextIds) return false;
    get().mutateProject((draft) => {
      const sc = draft.scenes.find((s) => s.scene_id === sceneId);
      if (sc) applyFrontToBackZOrder(sc, nextIds);
    });
    return true;
  },

  moveSceneLayer: (sceneId, layerId, direction) => {
    const project = get().project;
    if (!project) return false;
    const scene = project.scenes.find((s) => s.scene_id === sceneId);
    if (!scene) return false;
    const ordered = getOrderedSceneLayers(scene);
    const nextIds = computeStepMoveIds(ordered, layerId, direction);
    if (!nextIds) return false;
    get().mutateProject((draft) => {
      const sc = draft.scenes.find((s) => s.scene_id === sceneId);
      if (sc) applyFrontToBackZOrder(sc, nextIds);
    });
    return true;
  },

  upsertKeyframe: ({
    track_id,
    target_type,
    target_id,
    property,
    time_ms,
    value,
    easing,
    recordHistory = true,
  }) => {
    const fps = get().project?.timeline.fps ?? 30;
    const targetFrame = msToFrame(Math.max(0, time_ms), fps);
    const quantizedTime = quantizeMsToFrameMs(Math.max(0, time_ms), fps);
    const isDiscrete = ['expression_id', 'pose_id', 'eye_state', 'mouth_state', 'animation_state'].includes(
      property,
    );
    const resolvedEasing: EasingType = isDiscrete ? 'hold' : (easing ?? 'ease_in_out');

    get().mutateProject((draft) => {
      const clampedTime = Math.min(draft.timeline.total_duration_ms, quantizedTime);
      const clampedFrame = msToFrame(clampedTime, fps);
      const existing = draft.timeline.keyframes.find(
        (k) =>
          k.target_type === target_type &&
          k.target_id === target_id &&
          k.property === property &&
          getKeyframeFrame(k, fps) === (clampedFrame ?? targetFrame),
      );
      if (existing) {
        existing.value = value;
        if (easing !== undefined) existing.easing = resolvedEasing;
        existing.time_ms = clampedTime;
      } else {
        const kf: Keyframe = {
          keyframe_id: uid('kf'),
          track_id,
          target_type,
          target_id,
          property,
          time_ms: clampedTime,
          value,
          easing: resolvedEasing,
        };
        draft.timeline.keyframes.push(kf);
      }
    }, recordHistory);
  },

  moveKeyframe: (keyframeId, newTimeMs, recordHistory = true) => {
    const project = get().project;
    if (!project) return { movedCount: 0, replacedCount: 0, clampedDeltaFrames: 0 };
    const fps = project.timeline.fps ?? 30;
    const existing = project.timeline.keyframes.find((k) => k.keyframe_id === keyframeId);
    if (!existing) return { movedCount: 0, replacedCount: 0, clampedDeltaFrames: 0 };
    const origFrame = getKeyframeFrame(existing, fps);
    const targetFrame = msToFrame(Math.max(0, newTimeMs), fps);
    const deltaFrames = targetFrame - origFrame;
    return get().moveKeyframesByDeltaFrames([keyframeId], deltaFrames, recordHistory);
  },

  moveKeyframesByDeltaFrames: (keyframeIds, deltaFrames, recordHistory = true) => {
    const project = get().project;
    if (!project || keyframeIds.length === 0 || Math.round(deltaFrames) === 0) {
      return { movedCount: 0, replacedCount: 0, clampedDeltaFrames: 0 };
    }
    const fps = project.timeline.fps ?? 30;
    const totalMs = project.timeline.total_duration_ms;
    const previewRes = applyMoveKeyframes(
      project.timeline.keyframes,
      keyframeIds,
      deltaFrames,
      fps,
      totalMs,
    );
    if (previewRes.movedCount === 0 || previewRes.clampedDeltaFrames === 0) {
      return { movedCount: 0, replacedCount: 0, clampedDeltaFrames: 0 };
    }
    get().mutateProject((draft) => {
      const applied = applyMoveKeyframes(
        draft.timeline.keyframes,
        keyframeIds,
        deltaFrames,
        draft.timeline.fps ?? 30,
        draft.timeline.total_duration_ms,
      );
      draft.timeline.keyframes = applied.keyframes;
    }, recordHistory);
    return {
      movedCount: previewRes.movedCount,
      replacedCount: previewRes.replacedIds.length,
      clampedDeltaFrames: previewRes.clampedDeltaFrames,
    };
  },

  moveKeyframesToFrame: (keyframeIds, targetStartFrame) => {
    const project = get().project;
    if (!project || keyframeIds.length === 0) {
      return { movedCount: 0, replacedCount: 0, clampedDeltaFrames: 0 };
    }
    const fps = project.timeline.fps ?? 30;
    const totalMs = project.timeline.total_duration_ms;
    const previewRes = applyMoveKeyframesToFrame(
      project.timeline.keyframes,
      keyframeIds,
      targetStartFrame,
      fps,
      totalMs,
    );
    if (previewRes.movedCount === 0 || previewRes.clampedDeltaFrames === 0) {
      return { movedCount: 0, replacedCount: 0, clampedDeltaFrames: 0 };
    }
    get().mutateProject((draft) => {
      const applied = applyMoveKeyframesToFrame(
        draft.timeline.keyframes,
        keyframeIds,
        targetStartFrame,
        draft.timeline.fps ?? 30,
        draft.timeline.total_duration_ms,
      );
      draft.timeline.keyframes = applied.keyframes;
    }, true);
    return {
      movedCount: previewRes.movedCount,
      replacedCount: previewRes.replacedIds.length,
      clampedDeltaFrames: previewRes.clampedDeltaFrames,
    };
  },

  copyKeyframe: (kf) => {
    const cloned = cloneState(kf);
    set({ copiedKeyframe: cloned, copiedKeyframes: [cloned] });
  },

  copySelectedKeyframes: (explicitIds) => {
    const { project, selectedKeyframeIds } = get();
    if (!project) return 0;
    const ids = new Set(explicitIds ?? selectedKeyframeIds);
    const matched = project.timeline.keyframes
      .filter((k) => ids.has(k.keyframe_id))
      .map((k) => cloneState(k));
    if (matched.length === 0) return 0;
    set({
      copiedKeyframes: matched,
      copiedKeyframe: matched[0],
    });
    return matched.length;
  },

  pasteKeyframeAtTime: (timeMs) => {
    const res = get().pasteKeyframesAtTime(timeMs);
    return res.pastedIds.length > 0;
  },

  pasteKeyframesAtTime: (timeMs) => {
    const { copiedKeyframes, copiedKeyframe, project } = get();
    const clipboard =
      copiedKeyframes.length > 0 ? copiedKeyframes : copiedKeyframe ? [copiedKeyframe] : [];
    if (clipboard.length === 0 || !project) {
      return { pastedIds: [], replacedCount: 0 };
    }
    const fps = project.timeline.fps ?? 30;
    const targetFrame = msToFrame(Math.max(0, timeMs), fps);
    let pastedIds: string[] = [];
    let replacedCount = 0;

    get().mutateProject((draft) => {
      const applied = applyPasteKeyframes(
        draft.timeline.keyframes,
        clipboard,
        targetFrame,
        draft.timeline.fps ?? 30,
        draft.timeline.total_duration_ms,
        () => uid('kf'),
      );
      draft.timeline.keyframes = applied.keyframes;
      pastedIds = applied.createdIds;
      replacedCount = applied.replacedIds.length;
    }, true);

    if (pastedIds.length > 0) {
      get().setSelectedKeyframeIds(pastedIds, pastedIds[0]);
    }
    return { pastedIds, replacedCount };
  },

  duplicateKeyframes: (keyframeIds, offsetFrames = 10) => {
    const project = get().project;
    if (!project || keyframeIds.length === 0) {
      return { createdIds: [], replacedCount: 0 };
    }
    let createdIds: string[] = [];
    let replacedCount = 0;

    get().mutateProject((draft) => {
      const applied = applyDuplicateKeyframes(
        draft.timeline.keyframes,
        keyframeIds,
        offsetFrames,
        draft.timeline.fps ?? 30,
        draft.timeline.total_duration_ms,
        () => uid('kf'),
      );
      draft.timeline.keyframes = applied.keyframes;
      createdIds = applied.createdIds;
      replacedCount = applied.replacedIds.length;
    }, true);

    if (createdIds.length > 0) {
      get().setSelectedKeyframeIds(createdIds, createdIds[0]);
    }
    return { createdIds, replacedCount };
  },

  setKeyframesEasing: (keyframeIds, easing) => {
    const project = get().project;
    if (!project || keyframeIds.length === 0) return 0;
    const preview = applySetKeyframesEasing(project.timeline.keyframes, keyframeIds, easing);
    if (preview.updatedCount === 0) return 0;

    let updatedCount = 0;
    get().mutateProject((draft) => {
      const applied = applySetKeyframesEasing(draft.timeline.keyframes, keyframeIds, easing);
      draft.timeline.keyframes = applied.keyframes;
      updatedCount = applied.updatedCount;
    }, true);
    return updatedCount;
  },

  deleteKeyframe: (keyframeId) => {
    get().deleteKeyframes([keyframeId]);
  },

  deleteKeyframes: (keyframeIds) => {
    const project = get().project;
    if (!project || keyframeIds.length === 0) return 0;
    const preview = applyDeleteKeyframes(project.timeline.keyframes, keyframeIds);
    if (preview.deletedCount === 0) return 0;

    let deletedCount = 0;
    get().mutateProject((draft) => {
      const applied = applyDeleteKeyframes(draft.timeline.keyframes, keyframeIds);
      draft.timeline.keyframes = applied.keyframes;
      deletedCount = applied.deletedCount;
    }, true);
    return deletedCount;
  },

  applyAnimationPreset: ({
    presetId,
    targetType,
    targetId,
    trackId,
    startFrame,
    baseTransform,
    baseCameraZoom,
  }) => {
    const project = get().project;
    if (!project) return 0;
    const fps = project.timeline.fps;
    const specs = generatePresetKeyframes({
      presetId,
      targetType,
      targetId,
      trackId,
      startFrame,
      fps,
      baseTransform,
      baseCameraZoom,
    });
    if (specs.length === 0) return 0;

    get().mutateProject((draft) => {
      for (const spec of specs) {
        const clampedMs = Math.min(draft.timeline.total_duration_ms, Math.max(0, spec.time_ms));
        const existing = draft.timeline.keyframes.find(
          (k) =>
            k.target_type === spec.target_type &&
            k.target_id === spec.target_id &&
            k.property === spec.property &&
            Math.abs(k.time_ms - clampedMs) <= Math.ceil(500 / fps),
        );
        if (existing) {
          existing.value = spec.value;
          existing.easing = spec.easing;
          existing.time_ms = clampedMs;
        } else {
          draft.timeline.keyframes.push({
            keyframe_id: uid('kf'),
            track_id: spec.track_id,
            target_type: spec.target_type,
            target_id: spec.target_id,
            property: spec.property,
            time_ms: clampedMs,
            value: spec.value,
            easing: spec.easing,
          });
        }
      }
    });
    return specs.length;
  },

  groupScenePropsIntoCharacter: async (sceneId, characterName) => {
    const project = get().project;
    if (!project) return null;
    const scene = project.scenes.find((s) => s.scene_id === sceneId);
    if (!scene || scene.props.length === 0) return null;

    // Anchor character root at the centroid of root props
    const rootProps = scene.props.filter((p) => !p.parent_id);
    const basis = rootProps.length > 0 ? rootProps : scene.props;
    const rootX = Math.round(basis.reduce((sum, p) => sum + p.transform.x, 0) / basis.length);
    const rootY = Math.round(basis.reduce((sum, p) => sum + p.transform.y, 0) / basis.length);

    const propToSlot = new Map<string, string>();
    scene.props.forEach((p, idx) => {
      propToSlot.set(p.prop_instance_id, `slot_part_${idx + 1}`);
    });

    const parts: CharacterPartSlot[] = scene.props.map((p) => {
      const slotId = propToSlot.get(p.prop_instance_id)!;
      const parentSlot = p.parent_id ? (propToSlot.get(p.parent_id) ?? null) : null;
      return {
        slot_id: slotId,
        name: p.name,
        part_role: 'other',
        parent_slot_id: parentSlot,
        default_asset_id: p.asset_id,
        variants: {},
        z_index: p.z_index,
        anchor_x: p.anchor_x ?? 0.5,
        anchor_y: p.anchor_y ?? 0.5,
        default_transform: {
          x: parentSlot ? p.transform.x : Math.round(p.transform.x - rootX),
          y: parentSlot ? p.transform.y : Math.round(p.transform.y - rootY),
          rotation_deg: p.transform.rotation_deg,
          scale_x: p.transform.scale_x,
          scale_y: p.transform.scale_y,
          opacity: p.transform.opacity,
        },
        visible: p.visible !== false,
      };
    });

    const createdChar = await apiClient.createCharacter({
      name: characterName.trim() || 'Grouped Character',
      identity_confirmed: true,
      parts,
      expressions: [],
      poses: [],
    });

    const propIds = new Set(scene.props.map((p) => p.prop_instance_id));
    let newInstId = '';
    get().mutateProject((draft) => {
      const sc = draft.scenes.find((s) => s.scene_id === sceneId);
      if (!sc) return;
      sc.props = [];
      draft.timeline.tracks = draft.timeline.tracks.filter(
        (t) => !(t.target_ref_id && propIds.has(t.target_ref_id)),
      );
      draft.timeline.keyframes = draft.timeline.keyframes.filter(
        (k) => !propIds.has(k.target_id),
      );
      newInstId = uid('inst');
      sc.characters.push({
        instance_id: newInstId,
        scene_id: sceneId,
        character_id: createdChar.character_id,
        display_name: createdChar.name,
        z_index: 10 + sc.characters.length,
        initial_transform: {
          x: rootX,
          y: rootY,
          rotation_deg: 0,
          scale_x: 1,
          scale_y: 1,
          opacity: 1,
        },
        default_expression_id: null,
        default_pose_id: null,
        default_eye_state: 'open',
        default_mouth_state: 'closed',
      });
      const trackId = uid('trk_char');
      draft.timeline.tracks.push({
        track_id: trackId,
        project_id: draft.meta.project_id,
        track_type: 'character',
        name: `Char: ${createdChar.name}`,
        target_ref_id: newInstId,
        order_index: draft.timeline.tracks.filter((t) => t.track_type !== 'sfx').length,
        muted: false,
        locked: false,
        solo: false,
        visible: true,
        volume: 1,
        collapsed: false,
      });
    });

    if (newInstId) {
      set({ selection: { type: 'character', id: newInstId } });
    }
    return { character: createdChar, partCount: parts.length };
  },

  addOrUpdateAnimationClip: (clipInput) => {
    get().mutateProject((draft) => {
      if (clipInput.clip_id) {
        const idx = draft.timeline.animation_clips.findIndex(
          (c) => c.clip_id === clipInput.clip_id,
        );
        if (idx !== -1) {
          draft.timeline.animation_clips[idx] = {
            ...draft.timeline.animation_clips[idx],
            ...clipInput,
            procedural: {
              ...draft.timeline.animation_clips[idx].procedural,
              ...(clipInput.procedural ?? {}),
            },
          };
          return;
        }
      }
      const charTrack = draft.timeline.tracks.find(
        (t) => t.track_type === 'character' && t.target_ref_id === clipInput.instance_id,
      );
      draft.timeline.animation_clips.push({
        clip_id: uid('aclip'),
        track_id: clipInput.track_id ?? charTrack?.track_id ?? '',
        instance_id: clipInput.instance_id,
        start_ms: Math.max(0, Math.round(clipInput.start_ms)),
        end_ms: Math.max(Math.round(clipInput.start_ms) + 200, Math.round(clipInput.end_ms)),
        animation_state: (clipInput.animation_state ?? 'IDLE') as AnimationStateType,
        procedural: {
          auto_blink: true,
          blink_interval_ms: 3500,
          blink_duration_ms: 140,
          breathing: true,
          breathing_amplitude: 0.015,
          breathing_period_ms: 3200,
          walk_bounce_px: 12,
          walk_cycle_ms: 600,
          ...(clipInput.procedural ?? {}),
        },
      });
    });
  },

  deleteAnimationClip: (clipId) => {
    get().mutateProject((draft) => {
      draft.timeline.animation_clips = draft.timeline.animation_clips.filter(
        (c) => c.clip_id !== clipId,
      );
    });
  },

  addSfxTrack: () => {
    get().addAudioTrack('sfx');
  },

  addAudioTrack: (trackType) => {
    let createdId = '';
    const labels: Record<'sfx' | 'bgm' | 'ambient' | 'voice', string> = {
      voice: 'Voice Track',
      sfx: 'SFX Track',
      bgm: 'BGM Track',
      ambient: 'Ambient Track',
    };
    const baseOrders: Record<'sfx' | 'bgm' | 'ambient' | 'voice', number> = {
      voice: 900,
      sfx: 1000,
      bgm: 1100,
      ambient: 1200,
    };
    const defaultVol: Record<'sfx' | 'bgm' | 'ambient' | 'voice', number> = {
      voice: 1.0,
      sfx: 1.0,
      bgm: 0.65,
      ambient: 0.75,
    };
    get().mutateProject((draft) => {
      const existingCount = draft.timeline.tracks.filter((t) => t.track_type === trackType).length;
      createdId = uid(`trk_${trackType}`);
      draft.timeline.tracks.push({
        track_id: createdId,
        project_id: draft.meta.project_id,
        track_type: trackType,
        name: `${labels[trackType]} ${existingCount + 1}`,
        target_ref_id: null,
        order_index: baseOrders[trackType] + existingCount,
        muted: false,
        locked: false,
        solo: false,
        visible: true,
        volume: defaultVol[trackType],
        collapsed: false,
      });
    });
    return createdId;
  },

  ensureSubtitleTrack: () => {
    const existing = get().project?.timeline.tracks.find((t) => t.track_type === 'subtitle');
    if (existing) return existing.track_id;
    let createdId = '';
    get().mutateProject((draft) => {
      const found = draft.timeline.tracks.find((t) => t.track_type === 'subtitle');
      if (found) {
        createdId = found.track_id;
        return;
      }
      createdId = uid('trk_sub');
      draft.timeline.tracks.push({
        track_id: createdId,
        project_id: draft.meta.project_id,
        track_type: 'subtitle',
        name: 'Subtitles',
        target_ref_id: null,
        order_index: 800,
        muted: false,
        locked: false,
        solo: false,
        visible: true,
        volume: 1.0,
        collapsed: false,
      });
    });
    return createdId;
  },

  addSoundToBestTrack: (sound, startMs, sourceSceneId = null, preferredTrackType) => {
    const targetType: 'sfx' | 'bgm' | 'ambient' | 'voice' =
      preferredTrackType ??
      (sound.audio_type === 'bgm'
        ? 'bgm'
        : sound.category === 'ambient' || sound.category === 'wind' || sound.category === 'rain'
          ? 'ambient'
          : 'sfx');

    let eventId = '';
    get().mutateProject((draft) => {
      let track = draft.timeline.tracks.find((t) => t.track_type === targetType && !t.locked);
      if (!track) {
        track = draft.timeline.tracks.find((t) => t.track_type === targetType);
      }
      if (!track) {
        const labels: Record<typeof targetType, string> = {
          voice: 'Voice Track 1',
          sfx: 'SFX Track 1',
          bgm: 'BGM Track 1',
          ambient: 'Ambient Track 1',
        };
        const baseOrders: Record<typeof targetType, number> = {
          voice: 900,
          sfx: 1000,
          bgm: 1100,
          ambient: 1200,
        };
        track = {
          track_id: uid(`trk_${targetType}`),
          project_id: draft.meta.project_id,
          track_type: targetType,
          name: labels[targetType],
          target_ref_id: null,
          order_index: baseOrders[targetType],
          muted: false,
          locked: false,
          solo: false,
          visible: true,
          volume: targetType === 'bgm' ? 0.65 : targetType === 'ambient' ? 0.75 : 1.0,
          collapsed: false,
        };
        draft.timeline.tracks.push(track);
      }
      eventId = uid(`${targetType}_ev`);
      const safeStart = Math.max(0, Math.round(startMs));
      const defaultDur =
        targetType === 'bgm' && sound.loopable
          ? Math.max(sound.duration_ms, Math.min(draft.timeline.total_duration_ms - safeStart, Math.max(sound.duration_ms, 8000)))
          : Math.max(150, sound.duration_ms);
      const safeEnd = safeStart + Math.max(150, defaultDur);
      draft.timeline.sound_events.push({
        event_id: eventId,
        track_id: track.track_id,
        sound_id: sound.sound_id,
        start_ms: safeStart,
        end_ms: safeEnd,
        trim_start_ms: 0,
        volume: sound.default_volume,
        speed: 1.0,
        fade_in_ms: sound.fade_in_ms,
        fade_out_ms: sound.fade_out_ms,
        loop: sound.loopable || targetType === 'bgm',
        spatial_position: 0,
        source_scene_id: sourceSceneId,
      });
      if (safeEnd > draft.timeline.total_duration_ms) {
        draft.timeline.total_duration_ms = safeEnd;
      }
    });
    if (eventId) {
      set({ selection: { type: 'sfx_event', id: eventId, multiIds: [eventId] } });
    }
    return eventId;
  },

  addVoiceClipToTimeline: (sound, startMs, sourceSceneId = null) => {
    let eventId = '';
    get().mutateProject((draft) => {
      let voiceTrack = draft.timeline.tracks.find((t) => t.track_type === 'voice');
      if (!voiceTrack) {
        voiceTrack = {
          track_id: uid('trk_voice'),
          project_id: draft.meta.project_id,
          track_type: 'voice',
          name: 'Voice Track',
          target_ref_id: null,
          order_index: 500,
          muted: false,
          locked: false,
          solo: false,
          visible: true,
          volume: 1.0,
          collapsed: false,
        };
        draft.timeline.tracks.push(voiceTrack);
      }
      eventId = uid('voice_ev');
      const safeStart = Math.max(0, Math.round(startMs));
      const safeEnd = safeStart + Math.max(150, sound.duration_ms);
      draft.timeline.sound_events.push({
        event_id: eventId,
        track_id: voiceTrack.track_id,
        sound_id: sound.sound_id,
        start_ms: safeStart,
        end_ms: safeEnd,
        trim_start_ms: 0,
        volume: sound.default_volume ?? 1.0,
        speed: 1.0,
        fade_in_ms: 0,
        fade_out_ms: 0,
        loop: false,
        spatial_position: 0,
        source_scene_id: sourceSceneId,
      });
      if (safeEnd > draft.timeline.total_duration_ms) {
        draft.timeline.total_duration_ms = safeEnd;
      }
    });
    if (eventId) {
      set({ selection: { type: 'sfx_event', id: eventId } });
    }
    return eventId;
  },

  updateTrack: (trackId, patch) => {
    get().mutateProject((draft) => {
      const idx = draft.timeline.tracks.findIndex((t) => t.track_id === trackId);
      if (idx === -1) return;
      const trk = { ...draft.timeline.tracks[idx], ...patch };
      draft.timeline.tracks[idx] = trk;

      // Bidirectionally mirror visual track visibility, lock, and rename back to the authoritative scene layer!
      if ((trk.track_type === 'character' || trk.track_type === 'prop') && trk.target_ref_id) {
        for (const sc of draft.scenes) {
          if (trk.track_type === 'character') {
            const inst = sc.characters.find((c) => c.instance_id === trk.target_ref_id);
            if (inst) {
              if (patch.visible !== undefined) inst.visible = patch.visible;
              if (patch.locked !== undefined) inst.locked = patch.locked;
              if (patch.name !== undefined && patch.name.trim()) inst.display_name = patch.name.trim();
            }
          } else {
            const prop = sc.props.find((p) => p.prop_instance_id === trk.target_ref_id);
            if (prop) {
              if (patch.visible !== undefined) prop.visible = patch.visible;
              if (patch.locked !== undefined) prop.locked = patch.locked;
              if (patch.name !== undefined && patch.name.trim()) prop.name = patch.name.trim();
            }
          }
        }
      }
    });
  },

  addSoundEvent: (trackId, sound, startMs, sourceSceneId = null) => {
    let eventId = '';
    get().mutateProject((draft) => {
      eventId = uid('sfx_ev');
      const safeStart = Math.max(0, Math.round(startMs));
      const safeEnd = safeStart + Math.max(150, sound.duration_ms);
      draft.timeline.sound_events.push({
        event_id: eventId,
        track_id: trackId,
        sound_id: sound.sound_id,
        start_ms: safeStart,
        end_ms: safeEnd,
        trim_start_ms: 0,
        volume: sound.default_volume,
        speed: 1.0,
        fade_in_ms: sound.fade_in_ms,
        fade_out_ms: sound.fade_out_ms,
        loop: sound.loopable,
        spatial_position: 0,
        source_scene_id: sourceSceneId,
      });
      if (safeEnd > draft.timeline.total_duration_ms) {
        draft.timeline.total_duration_ms = safeEnd;
      }
    });
    if (eventId) {
      set({ selection: { type: 'sfx_event', id: eventId } });
    }
  },

  updateSoundEvent: (eventId, patch, recordHistory = true) => {
    get().mutateProject((draft) => {
      const idx = draft.timeline.sound_events.findIndex((e) => e.event_id === eventId);
      if (idx === -1) return;
      draft.timeline.sound_events[idx] = { ...draft.timeline.sound_events[idx], ...patch };
    }, recordHistory);
  },

  deleteSoundEvent: (eventId) => {
    get().mutateProject((draft) => {
      draft.timeline.sound_events = draft.timeline.sound_events.filter(
        (e) => e.event_id !== eventId,
      );
    });
    if (get().selection.id === eventId) {
      set({ selection: { type: 'none', id: null } });
    }
  },

  updateScriptMeta: (patch) => {
    get().mutateProject((draft) => {
      const doc = ensureProjectScript(draft);
      if (patch.episode_title !== undefined) doc.episode_title = patch.episode_title;
      if (patch.raw_source_text !== undefined) doc.raw_source_text = patch.raw_source_text;
      doc.updated_at = new Date().toISOString();
    });
  },

  addScriptScene: (title) => {
    let createdId = '';
    get().mutateProject((draft) => {
      const doc = ensureProjectScript(draft);
      createdId = uid('ssc');
      doc.scenes.push({
        script_scene_id: createdId,
        linked_stage_scene_id: null,
        order_index: doc.scenes.length,
        title: title?.trim() || `Scene ${doc.scenes.length + 1}`,
        location: '',
        time_of_day: '',
        description: '',
        background_asset_id: null,
        character_ids: [],
        notes: '',
        entries: [],
        estimated_duration_ms: 0,
      });
      recalculateScriptDurations(doc);
    });
    if (createdId) {
      set({ activeScriptSceneId: createdId, selectedScriptEntryId: null });
    }
    return createdId;
  },

  updateScriptScene: (scriptSceneId, patch) => {
    get().mutateProject((draft) => {
      const doc = ensureProjectScript(draft);
      const idx = doc.scenes.findIndex((s) => s.script_scene_id === scriptSceneId);
      if (idx === -1) return;
      doc.scenes[idx] = { ...doc.scenes[idx], ...patch };
      recalculateScriptDurations(doc);
    });
  },

  deleteScriptScene: (scriptSceneId) => {
    get().mutateProject((draft) => {
      const doc = ensureProjectScript(draft);
      doc.scenes = doc.scenes.filter((s) => s.script_scene_id !== scriptSceneId);
      recalculateScriptDurations(doc);
    });
    const st = get();
    if (st.activeScriptSceneId === scriptSceneId) {
      set({
        activeScriptSceneId: st.project?.script?.scenes[0]?.script_scene_id ?? null,
        selectedScriptEntryId: null,
      });
    }
  },

  reorderScriptScenes: (sourceId, targetId, position) => {
    const project = get().project;
    if (!project?.script) return false;
    const reordered = reorderArrayByIds(
      project.script.scenes,
      (s) => s.script_scene_id,
      sourceId,
      targetId,
      position,
    );
    if (!reordered) return false;
    get().mutateProject((draft) => {
      const doc = ensureProjectScript(draft);
      const next = reorderArrayByIds(
        doc.scenes,
        (s) => s.script_scene_id,
        sourceId,
        targetId,
        position,
      );
      if (next) {
        doc.scenes = next;
        recalculateScriptDurations(doc);
      }
    });
    return true;
  },

  moveScriptScene: (scriptSceneId, delta) => {
    const project = get().project;
    if (!project?.script) return false;
    const idx = project.script.scenes.findIndex((s) => s.script_scene_id === scriptSceneId);
    if (idx === -1) return false;
    if (!moveArrayItemByDelta(project.script.scenes, idx, delta)) return false;
    get().mutateProject((draft) => {
      const doc = ensureProjectScript(draft);
      const curIdx = doc.scenes.findIndex((s) => s.script_scene_id === scriptSceneId);
      const next = moveArrayItemByDelta(doc.scenes, curIdx, delta);
      if (next) {
        doc.scenes = next;
        recalculateScriptDurations(doc);
      }
    });
    return true;
  },

  addScriptEntry: (scriptSceneId, entryType, characterId = null) => {
    let createdId = '';
    get().mutateProject((draft) => {
      const doc = ensureProjectScript(draft);
      const sc = doc.scenes.find((s) => s.script_scene_id === scriptSceneId);
      if (!sc) return;
      createdId = uid('entry');
      sc.entries.push({
        entry_id: createdId,
        entry_type: entryType,
        order_index: sc.entries.length,
        character_id: entryType === 'dialogue' ? characterId : null,
        narrator_label: 'Narrator',
        text: '',
        voice_profile_id: null,
        emotion: 'neutral',
        delivery_style: 'normal',
        pause_before_ms: 0,
        pause_after_ms: 300,
        estimated_duration_ms: 1300,
        audio_asset_id: null,
        audio_duration_ms: null,
        sound_effect_ids: [],
      });
      recalculateScriptDurations(doc);
    });
    if (createdId) {
      set({ selectedScriptEntryId: createdId });
    }
    return createdId;
  },

  updateScriptEntry: (scriptSceneId, entryId, patch) => {
    get().mutateProject((draft) => {
      const doc = ensureProjectScript(draft);
      const sc = doc.scenes.find((s) => s.script_scene_id === scriptSceneId);
      if (!sc) return;
      const idx = sc.entries.findIndex((e) => e.entry_id === entryId);
      if (idx === -1) return;
      sc.entries[idx] = { ...sc.entries[idx], ...patch };
      recalculateScriptDurations(doc);
    });
  },

  deleteScriptEntry: (scriptSceneId, entryId) => {
    get().mutateProject((draft) => {
      const doc = ensureProjectScript(draft);
      const sc = doc.scenes.find((s) => s.script_scene_id === scriptSceneId);
      if (!sc) return;
      sc.entries = sc.entries.filter((e) => e.entry_id !== entryId);
      recalculateScriptDurations(doc);
    });
    if (get().selectedScriptEntryId === entryId) {
      set({ selectedScriptEntryId: null });
    }
  },

  reorderScriptEntries: (scriptSceneId, sourceId, targetId, position) => {
    const project = get().project;
    const sc = project?.script?.scenes.find((s) => s.script_scene_id === scriptSceneId);
    if (!sc) return false;
    if (!reorderArrayByIds(sc.entries, (e) => e.entry_id, sourceId, targetId, position)) {
      return false;
    }
    get().mutateProject((draft) => {
      const doc = ensureProjectScript(draft);
      const dsc = doc.scenes.find((s) => s.script_scene_id === scriptSceneId);
      if (!dsc) return;
      const next = reorderArrayByIds(dsc.entries, (e) => e.entry_id, sourceId, targetId, position);
      if (next) {
        dsc.entries = next;
        recalculateScriptDurations(doc);
      }
    });
    return true;
  },

  moveScriptEntry: (scriptSceneId, entryId, delta) => {
    const project = get().project;
    const sc = project?.script?.scenes.find((s) => s.script_scene_id === scriptSceneId);
    if (!sc) return false;
    const idx = sc.entries.findIndex((e) => e.entry_id === entryId);
    if (!moveArrayItemByDelta(sc.entries, idx, delta)) return false;
    get().mutateProject((draft) => {
      const doc = ensureProjectScript(draft);
      const dsc = doc.scenes.find((s) => s.script_scene_id === scriptSceneId);
      if (!dsc) return;
      const curIdx = dsc.entries.findIndex((e) => e.entry_id === entryId);
      const next = moveArrayItemByDelta(dsc.entries, curIdx, delta);
      if (next) {
        dsc.entries = next;
        recalculateScriptDurations(doc);
      }
    });
    return true;
  },

  syncScriptScenesToStage: () => {
    let syncedCount = 0;
    get().mutateProject((draft) => {
      const doc = ensureProjectScript(draft);
      recalculateScriptDurations(doc);
      if (doc.scenes.length === 0) return;

      for (const ssc of doc.scenes) {
        let stageScene = ssc.linked_stage_scene_id
          ? draft.scenes.find((s) => s.scene_id === ssc.linked_stage_scene_id)
          : undefined;
        const targetDur = Math.max(3000, ssc.estimated_duration_ms || 5000);
        if (stageScene) {
          stageScene.name = ssc.title || stageScene.name;
          stageScene.duration_ms = Math.max(stageScene.duration_ms, targetDur);
        } else {
          // Reuse first empty default scene if unlinked and empty on first sync, otherwise create new
          const reusable =
            draft.scenes.length === 1 &&
            draft.scenes[0].characters.length === 0 &&
            draft.scenes[0].props.length === 0 &&
            !doc.scenes.some((o) => o.linked_stage_scene_id === draft.scenes[0].scene_id)
              ? draft.scenes[0]
              : undefined;
          if (reusable) {
            reusable.name = ssc.title || reusable.name;
            reusable.duration_ms = Math.max(reusable.duration_ms, targetDur);
            ssc.linked_stage_scene_id = reusable.scene_id;
          } else {
            const newId = uid('scene');
            draft.scenes.push({
              scene_id: newId,
              project_id: draft.meta.project_id,
              order_index: draft.scenes.length,
              name: ssc.title || `Scene ${draft.scenes.length + 1}`,
              start_ms: 0,
              duration_ms: targetDur,
              background_asset_id: ssc.background_asset_id ?? null,
              background_color: '#14161A',
              transition_in: draft.scenes.length > 0 ? 'fade' : 'cut',
              transition_duration_ms: 500,
              camera_default: { x: 0, y: 0, zoom: 1, rotation_deg: 0 },
              characters: [],
              props: [],
            });
            ssc.linked_stage_scene_id = newId;
          }
        }
        syncedCount += 1;
      }

      // Re-pack scene start_ms sequentially
      let cursor = 0;
      draft.scenes.forEach((sc, idx) => {
        sc.order_index = idx;
        sc.start_ms = cursor;
        cursor += sc.duration_ms;
      });
      if (cursor > draft.timeline.total_duration_ms) {
        draft.timeline.total_duration_ms = cursor;
      }
    });
    return syncedCount;
  },

  updateCameraAtTime: (timeMs, patch, insertKeyframe = true) => {
    const st = get();
    if (!st.project) return;
    const camTrack = st.project.timeline.tracks.find((t) => t.track_type === 'camera');
    if (!camTrack) return;

    if (insertKeyframe) {
      get().mutateProject((draft) => {
        const roundedTime = Math.max(0, Math.round(timeMs));
        for (const [key, val] of Object.entries(patch)) {
          if (val === undefined) continue;
          const prop = key as KeyframeProperty;
          const existing = draft.timeline.keyframes.find(
            (k) =>
              k.target_type === 'camera' &&
              k.target_id === 'camera' &&
              k.property === prop &&
              Math.abs(k.time_ms - roundedTime) <= 20,
          );
          if (existing) {
            existing.value = val;
            existing.time_ms = roundedTime;
          } else {
            draft.timeline.keyframes.push({
              keyframe_id: uid('kf'),
              track_id: camTrack.track_id,
              target_type: 'camera',
              target_id: 'camera',
              property: prop,
              time_ms: roundedTime,
              value: val,
              easing: 'ease_in_out',
            });
          }
        }
      });
    } else {
      const sceneId = st.activeSceneId ?? st.project.scenes[0]?.scene_id;
      if (!sceneId) return;
      get().mutateProject((draft) => {
        const sc = draft.scenes.find((s) => s.scene_id === sceneId);
        if (sc) {
          sc.camera_default = { ...sc.camera_default, ...patch };
        }
      });
    }
  },

  setTotalDurationMs: (durationMs) => {
    get().mutateProject((draft) => {
      draft.timeline.total_duration_ms = Math.max(1000, Math.round(durationMs));
      draft.meta.duration_ms = draft.timeline.total_duration_ms;
    });
  },

  // --- Subtitle Studio Actions ---

  setSelectedSubtitleIds: (ids, primaryId) => {
    const unique = [...new Set(ids)];
    const active = primaryId !== undefined ? primaryId : (unique[0] ?? null);
    set({
      selectedSubtitleIds: unique,
      selection: active
        ? { type: 'subtitle', id: active, multiIds: unique }
        : { type: 'none', id: null },
    });
  },

  addSubtitleSegment: (partial) => {
    const subId = uid('sub');
    get().mutateProject((draft) => {
      draft.subtitles = ensureSubtitleDocument(draft.subtitles);
      const doc = draft.subtitles;
      // Ensure a subtitle track exists on Master Timeline
      if (!draft.timeline.tracks.some((t) => t.track_type === 'subtitle')) {
        draft.timeline.tracks.push({
          track_id: uid('trk_sub'),
          project_id: draft.meta.project_id,
          track_type: 'subtitle',
          name: 'Subtitles',
          target_ref_id: null,
          order_index: 800,
          muted: false,
          locked: false,
          solo: false,
          visible: true,
          volume: 1.0,
          collapsed: false,
        });
      }
      const startMs = Math.max(0, Math.round(partial?.start_ms ?? 0));
      const endMs = Math.max(startMs + 200, Math.round(partial?.end_ms ?? startMs + 2500));
      const seg: SubtitleSegment = {
        subtitle_id: subId,
        text: partial?.text ?? '',
        start_ms: startMs,
        end_ms: endMs,
        scene_id: partial?.scene_id ?? get().activeSceneId ?? draft.scenes[0]?.scene_id ?? null,
        speaker_character_id: partial?.speaker_character_id ?? null,
        speaker_name: partial?.speaker_name ?? '',
        script_entry_id: partial?.script_entry_id ?? null,
        voice_audio_asset_id: partial?.voice_audio_asset_id ?? null,
        timing_source: partial?.timing_source ?? 'manual',
        style_id: partial?.style_id ?? doc.default_style_id,
        position_override: partial?.position_override ?? null,
        enabled: partial?.enabled ?? true,
      };
      doc.segments.push(seg);
      doc.segments.sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
      if (endMs > draft.timeline.total_duration_ms) {
        draft.timeline.total_duration_ms = endMs;
      }
    });
    set({
      selectedSubtitleIds: [subId],
      selection: { type: 'subtitle', id: subId, multiIds: [subId] },
    });
    return subId;
  },

  updateSubtitleSegment: (subtitleId, patch, recordHistory = true) => {
    get().mutateProject((draft) => {
      draft.subtitles = ensureSubtitleDocument(draft.subtitles);
      const idx = draft.subtitles.segments.findIndex((s) => s.subtitle_id === subtitleId);
      if (idx === -1) return;
      const prev = draft.subtitles.segments[idx];
      const nextStart = Math.max(0, Math.round(patch.start_ms ?? prev.start_ms));
      const nextEnd = Math.max(nextStart + 100, Math.round(patch.end_ms ?? prev.end_ms));
      draft.subtitles.segments[idx] = {
        ...prev,
        ...patch,
        start_ms: nextStart,
        end_ms: nextEnd,
      };
      if (patch.start_ms !== undefined || patch.end_ms !== undefined) {
        draft.subtitles.segments.sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
        if (nextEnd > draft.timeline.total_duration_ms) {
          draft.timeline.total_duration_ms = nextEnd;
        }
      }
    }, recordHistory);
  },

  updateSubtitleStyleOverride: (subtitleId, patch, recordHistory = true) => {
    get().mutateProject((draft) => {
      draft.subtitles = ensureSubtitleDocument(draft.subtitles);
      const idx = draft.subtitles.segments.findIndex((s) => s.subtitle_id === subtitleId);
      if (idx === -1) return;
      const prev = draft.subtitles.segments[idx];
      const merged: SubtitleStyleOverride = {
        ...(prev.style_override ?? {}),
        ...patch,
      };
      draft.subtitles.segments[idx] = {
        ...prev,
        style_override: merged,
        ...(patch.position !== undefined ? { position_override: patch.position ?? null } : {}),
      };
    }, recordHistory);
  },

  clearSubtitleStyleOverride: (subtitleId) => {
    get().mutateProject((draft) => {
      draft.subtitles = ensureSubtitleDocument(draft.subtitles);
      const idx = draft.subtitles.segments.findIndex((s) => s.subtitle_id === subtitleId);
      if (idx === -1) return;
      draft.subtitles.segments[idx] = {
        ...draft.subtitles.segments[idx],
        style_override: null,
        position_override: null,
      };
    }, true);
  },

  applySubtitleOverrideToStyle: (subtitleId) => {
    get().mutateProject((draft) => {
      draft.subtitles = ensureSubtitleDocument(draft.subtitles);
      const idx = draft.subtitles.segments.findIndex((s) => s.subtitle_id === subtitleId);
      if (idx === -1) return;
      const seg = draft.subtitles.segments[idx];
      const ov = seg.style_override;
      if (!ov && !seg.position_override) return;
      const sIdx = draft.subtitles.styles.findIndex((st) => st.style_id === seg.style_id);
      if (sIdx === -1) return;
      const cleanOv: Record<string, unknown> = {};
      if (ov) {
        for (const [k, v] of Object.entries(ov)) {
          if (v !== undefined && v !== null) cleanOv[k] = v;
        }
      }
      if (seg.position_override && cleanOv.position === undefined) {
        cleanOv.position = seg.position_override;
      }
      draft.subtitles.styles[sIdx] = {
        ...draft.subtitles.styles[sIdx],
        ...cleanOv,
      } as SubtitleStyle;
      draft.subtitles.segments[idx] = {
        ...seg,
        style_override: null,
        position_override: null,
      };
    }, true);
  },

  deleteSubtitleSegments: (subtitleIds) => {
    const idSet = new Set(subtitleIds);
    if (idSet.size === 0) return 0;
    let removed = 0;
    get().mutateProject((draft) => {
      draft.subtitles = ensureSubtitleDocument(draft.subtitles);
      const before = draft.subtitles.segments.length;
      draft.subtitles.segments = draft.subtitles.segments.filter((s) => !idSet.has(s.subtitle_id));
      removed = before - draft.subtitles.segments.length;
    });
    const remainingSel = get().selectedSubtitleIds.filter((id) => !idSet.has(id));
    set({
      selectedSubtitleIds: remainingSel,
      selection:
        get().selection.type === 'subtitle' && get().selection.id && idSet.has(get().selection.id!)
          ? remainingSel[0]
            ? { type: 'subtitle', id: remainingSel[0], multiIds: remainingSel }
            : { type: 'none', id: null }
          : get().selection,
    });
    return removed;
  },

  duplicateSubtitleSegment: (subtitleId) => {
    let createdId: string | null = null;
    get().mutateProject((draft) => {
      draft.subtitles = ensureSubtitleDocument(draft.subtitles);
      const src = draft.subtitles.segments.find((s) => s.subtitle_id === subtitleId);
      if (!src) return;
      const dur = Math.max(200, src.end_ms - src.start_ms);
      createdId = uid('sub');
      const nextStart = src.end_ms + 100;
      const nextEnd = nextStart + dur;
      draft.subtitles.segments.push({
        ...structuredClone(src),
        subtitle_id: createdId,
        start_ms: nextStart,
        end_ms: nextEnd,
        timing_source: 'manual',
      });
      draft.subtitles.segments.sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
      if (nextEnd > draft.timeline.total_duration_ms) {
        draft.timeline.total_duration_ms = nextEnd;
      }
    });
    if (createdId) {
      set({
        selectedSubtitleIds: [createdId],
        selection: { type: 'subtitle', id: createdId, multiIds: [createdId] },
      });
    }
    return createdId;
  },

  splitSubtitleSegmentAt: (subtitleId, splitAtMs) => {
    let pairIds: [string, string] | null = null;
    get().mutateProject((draft) => {
      draft.subtitles = ensureSubtitleDocument(draft.subtitles);
      const idx = draft.subtitles.segments.findIndex((s) => s.subtitle_id === subtitleId);
      if (idx === -1) return;
      const res = splitSubtitleSegment(draft.subtitles.segments[idx], splitAtMs);
      if (!res) return;
      draft.subtitles.segments.splice(idx, 1, res[0], res[1]);
      draft.subtitles.segments.sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
      pairIds = [res[0].subtitle_id, res[1].subtitle_id];
    });
    if (pairIds) {
      set({
        selectedSubtitleIds: [pairIds[1]],
        selection: { type: 'subtitle', id: pairIds[1], multiIds: [pairIds[1]] },
      });
    }
    return pairIds;
  },

  mergeSubtitleSegmentsByIds: (subtitleIds) => {
    let mergedId: string | null = null;
    const idSet = new Set(subtitleIds);
    if (idSet.size < 2) return null;
    get().mutateProject((draft) => {
      draft.subtitles = ensureSubtitleDocument(draft.subtitles);
      const targets = draft.subtitles.segments.filter((s) => idSet.has(s.subtitle_id));
      const merged = mergeSubtitleSegments(targets);
      if (!merged) return;
      mergedId = merged.subtitle_id;
      draft.subtitles.segments = [
        ...draft.subtitles.segments.filter((s) => !idSet.has(s.subtitle_id)),
        merged,
      ].sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
    });
    if (mergedId) {
      set({
        selectedSubtitleIds: [mergedId],
        selection: { type: 'subtitle', id: mergedId, multiIds: [mergedId] },
      });
    }
    return mergedId;
  },

  moveSubtitleSegmentsByDelta: (subtitleIds, deltaMs, recordHistory = true) => {
    const idSet = new Set(subtitleIds);
    if (idSet.size === 0 || deltaMs === 0) return;
    get().mutateProject((draft) => {
      draft.subtitles = ensureSubtitleDocument(draft.subtitles);
      const targets = draft.subtitles.segments.filter((s) => idSet.has(s.subtitle_id));
      if (targets.length === 0) return;
      const minStart = Math.min(...targets.map((s) => s.start_ms));
      const clampedDelta = Math.max(-minStart, Math.round(deltaMs));
      if (clampedDelta === 0) return;
      for (const seg of targets) {
        seg.start_ms += clampedDelta;
        seg.end_ms += clampedDelta;
      }
      draft.subtitles.segments.sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
    }, recordHistory);
  },

  upsertSubtitleStyle: (style) => {
    get().mutateProject((draft) => {
      draft.subtitles = ensureSubtitleDocument(draft.subtitles);
      const idx = draft.subtitles.styles.findIndex((s) => s.style_id === style.style_id);
      if (idx !== -1) {
        draft.subtitles.styles[idx] = { ...style };
      } else {
        draft.subtitles.styles.push({ ...style });
      }
    });
  },

  deleteSubtitleStyle: (styleId) => {
    get().mutateProject((draft) => {
      draft.subtitles = ensureSubtitleDocument(draft.subtitles);
      if (draft.subtitles.styles.length <= 1) return;
      const target = draft.subtitles.styles.find((s) => s.style_id === styleId);
      if (!target || target.is_builtin) return;
      draft.subtitles.styles = draft.subtitles.styles.filter((s) => s.style_id !== styleId);
      const fallback = draft.subtitles.styles[0].style_id;
      if (draft.subtitles.default_style_id === styleId) {
        draft.subtitles.default_style_id = fallback;
      }
      for (const seg of draft.subtitles.segments) {
        if (seg.style_id === styleId) seg.style_id = fallback;
      }
    });
  },

  setDefaultSubtitleStyle: (styleId) => {
    get().mutateProject((draft) => {
      draft.subtitles = ensureSubtitleDocument(draft.subtitles);
      if (draft.subtitles.styles.some((s) => s.style_id === styleId)) {
        draft.subtitles.default_style_id = styleId;
      }
    });
  },

  importSubtitles: (segments, mode) => {
    if (segments.length === 0) return 0;
    get().mutateProject((draft) => {
      draft.subtitles = ensureSubtitleDocument(draft.subtitles);
      if (!draft.timeline.tracks.some((t) => t.track_type === 'subtitle')) {
        draft.timeline.tracks.push({
          track_id: uid('trk_sub'),
          project_id: draft.meta.project_id,
          track_type: 'subtitle',
          name: 'Subtitles',
          target_ref_id: null,
          order_index: 800,
          muted: false,
          locked: false,
          solo: false,
          visible: true,
          volume: 1.0,
          collapsed: false,
        });
      }
      const next =
        mode === 'replace'
          ? [...segments]
          : [...draft.subtitles.segments, ...segments];
      next.sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
      draft.subtitles.segments = next;
      const maxEnd = Math.max(0, ...next.map((s) => s.end_ms));
      if (maxEnd > draft.timeline.total_duration_ms) {
        draft.timeline.total_duration_ms = maxEnd;
      }
    });
    return segments.length;
  },

  generateSubtitlesFromProjectScript: (characters, options) => {
    const project = get().project;
    if (!project) return { total: 0, voiceSyncedCount: 0, estimatedCount: 0 };
    const doc = ensureSubtitleDocument(project.subtitles);
    const mode = options?.mode ?? 'replace';
    const existingEnd =
      mode === 'append' && doc.segments.length > 0
        ? Math.max(...doc.segments.map((s) => s.end_ms)) + 300
        : 0;
    const generated = generateSubtitlesFromScript(project.script, characters, {
      defaultStyleId: doc.default_style_id,
      includeDialogue: options?.includeDialogue ?? true,
      includeNarration: options?.includeNarration ?? true,
      startOffsetMs: existingEnd,
    });
    if (generated.segments.length > 0) {
      get().importSubtitles(generated.segments, mode);
    }
    return {
      total: generated.segments.length,
      voiceSyncedCount: generated.voiceSyncedCount,
      estimatedCount: generated.estimatedCount,
    };
  },

  setDirectorAnalysis: (doc) => {
    set((s) => {
      if (!s.project) return s;
      return {
        project: {
          ...s.project,
          director: doc,
        },
        lastSavedAt: new Date().toISOString(),
      };
    });
  },

  replaceDirectorScene: (scene) => {
    set((s) => {
      if (!s.project?.director) return s;
      const nextScenes = s.project.director.scenes.map((sc) =>
        sc.scene_breakdown_id === scene.scene_breakdown_id ? scene : sc,
      );
      return {
        project: {
          ...s.project,
          director: {
            ...s.project.director,
            scenes: nextScenes,
            updated_at: new Date().toISOString(),
          },
        },
        lastSavedAt: new Date().toISOString(),
      };
    });
  },

  editDirectorCharacter: (characterAnalysisId, patch) => {
    get().mutateProject((draft) => {
      if (!draft.director) return;
      draft.director = editExtractedCharacter(draft.director, characterAnalysisId, patch);
    });
  },

  mergeDirectorCharacters: (primaryId, secondaryId) => {
    get().mutateProject((draft) => {
      if (!draft.director) return;
      draft.director = mergeExtractedCharacters(draft.director, primaryId, secondaryId);
    });
  },

  separateDirectorCharacterAlias: (sourceCharId, alias) => {
    let createdId: string | null = null;
    get().mutateProject((draft) => {
      if (!draft.director) return;
      const res = separateExtractedCharacterAlias(draft.director, sourceCharId, alias);
      draft.director = res.doc;
      createdId = res.createdCharacterId;
    });
    return createdId;
  },

  resolveDirectorItemSpeaker: (itemId, characterAnalysisId) => {
    get().mutateProject((draft) => {
      if (!draft.director) return;
      draft.director = resolveExtractedItemSpeaker(draft.director, itemId, characterAnalysisId);
    });
  },

  editDirectorScene: (sceneBreakdownId, patch) => {
    get().mutateProject((draft) => {
      if (!draft.director) return;
      draft.director = editSceneBreakdown(draft.director, sceneBreakdownId, patch);
    });
  },

  setDirectorSceneStatus: (sceneBreakdownId, status) => {
    get().mutateProject((draft) => {
      if (!draft.director) return;
      draft.director = setSceneReviewStatus(draft.director, sceneBreakdownId, status);
    });
  },

  acceptAllDirectorScenes: () => {
    get().mutateProject((draft) => {
      if (!draft.director) return;
      draft.director = acceptAllScenesInDoc(draft.director);
    });
  },

  splitDirectorScene: (sceneBreakdownId, splitAtParagraphPos) => {
    let ids: { firstId: string; secondId: string } | null = null;
    get().mutateProject((draft) => {
      if (!draft.director) return;
      const res = splitSceneBreakdown(draft.director, sceneBreakdownId, splitAtParagraphPos);
      if (!res) return;
      draft.director = res.doc;
      ids = { firstId: res.firstId, secondId: res.secondId };
    });
    return ids;
  },

  mergeDirectorScenes: (sceneBreakdownIds) => {
    let mergedId: string | null = null;
    get().mutateProject((draft) => {
      if (!draft.director) return;
      const res = mergeSceneBreakdowns(draft.director, sceneBreakdownIds);
      if (!res) return;
      draft.director = res.doc;
      mergedId = res.mergedId;
    });
    return mergedId;
  },

  reorderDirectorScenes: (sourceId, targetId, position) => {
    let changed = false;
    get().mutateProject((draft) => {
      if (!draft.director) return;
      const next = reorderSceneBreakdowns(draft.director, sourceId, targetId, position);
      if (!next) return;
      draft.director = next;
      changed = true;
    });
    return changed;
  },

  moveDirectorScene: (sceneBreakdownId, delta) => {
    let changed = false;
    get().mutateProject((draft) => {
      if (!draft.director) return;
      const next = moveSceneBreakdown(draft.director, sceneBreakdownId, delta);
      if (!next) return;
      draft.director = next;
      changed = true;
    });
    return changed;
  },

  deleteDirectorScene: (sceneBreakdownId) => {
    get().mutateProject((draft) => {
      if (!draft.director) return;
      draft.director = deleteSceneBreakdown(draft.director, sceneBreakdownId);
    });
  },

  restoreDirectorScene: (sceneBreakdownId) => {
    get().mutateProject((draft) => {
      if (!draft.director) return;
      draft.director = restoreOriginalSceneBreakdown(draft.director, sceneBreakdownId);
    });
  },

  restoreAllDirectorScenes: () => {
    get().mutateProject((draft) => {
      if (!draft.director) return;
      draft.director = restoreAllOriginalScenes(draft.director);
    });
  },

  applyAcceptedDirectorScenes: (options) => {
    let result: ApplyAcceptedResult = {
      appliedCount: 0,
      createdScriptScenes: 0,
      updatedScriptScenes: 0,
      createdStageScenes: 0,
      updatedStageScenes: 0,
    };
    get().mutateProject((draft) => {
      result = applyAcceptedScenesToProjectState(draft, options);
    });
    return result;
  },

  setStoryboardDocument: (doc) => {
    set((s) => {
      if (!s.project) return s;
      return {
        project: {
          ...s.project,
          storyboard: doc,
        },
        lastSavedAt: new Date().toISOString(),
      };
    });
  },

  replaceStoryboardShot: (shot) => {
    set((s) => {
      if (!s.project?.storyboard) return s;
      const replaced = s.project.storyboard.shots.map((sh) =>
        sh.shot_id === shot.shot_id ? shot : sh,
      );
      const timed = recalculateSceneShotTimings(replaced);
      const warnings = analyzeStoryboardContinuity(timed, s.project.storyboard.continuity_warnings);
      return {
        project: {
          ...s.project,
          storyboard: {
            ...s.project.storyboard,
            shots: timed,
            continuity_warnings: warnings,
            updated_at: new Date().toISOString(),
          },
        },
        lastSavedAt: new Date().toISOString(),
      };
    });
  },

  addStoryboardShot: (params) => {
    let createdId = '';
    get().mutateProject((draft) => {
      const base = ensureStoryboardDocument(draft.storyboard);
      const res = addStoryboardShot(base, params);
      draft.storyboard = res.doc;
      createdId = res.shotId;
    });
    return createdId;
  },

  duplicateStoryboardShot: (shotId) => {
    let createdId: string | null = null;
    get().mutateProject((draft) => {
      if (!draft.storyboard) return;
      const res = duplicateStoryboardShot(draft.storyboard, shotId);
      if (!res) return;
      draft.storyboard = res.doc;
      createdId = res.createdShotId;
    });
    return createdId;
  },

  deleteStoryboardShot: (shotId) => {
    get().mutateProject((draft) => {
      if (!draft.storyboard) return;
      draft.storyboard = deleteStoryboardShot(draft.storyboard, shotId);
    });
  },

  editStoryboardShot: (shotId, patch) => {
    get().mutateProject((draft) => {
      if (!draft.storyboard) return;
      draft.storyboard = editStoryboardShot(draft.storyboard, shotId, patch);
    });
  },

  toggleLockStoryboardShot: (shotId, locked) => {
    get().mutateProject((draft) => {
      if (!draft.storyboard) return;
      draft.storyboard = toggleLockStoryboardShot(draft.storyboard, shotId, locked);
    });
  },

  moveStoryboardShot: (shotId, delta) => {
    let moved = false;
    get().mutateProject((draft) => {
      if (!draft.storyboard) return;
      const next = moveStoryboardShot(draft.storyboard, shotId, delta);
      if (!next) return;
      draft.storyboard = next;
      moved = true;
    });
    return moved;
  },

  reorderStoryboardShots: (sourceShotId, targetShotId, position) => {
    let moved = false;
    get().mutateProject((draft) => {
      if (!draft.storyboard) return;
      const next = reorderStoryboardShotsInScene(draft.storyboard, sourceShotId, targetShotId, position);
      if (!next) return;
      draft.storyboard = next;
      moved = true;
    });
    return moved;
  },

  addShotCharacter: (shotId, character) => {
    get().mutateProject((draft) => {
      if (!draft.storyboard) return;
      draft.storyboard = addShotCharacterStaging(draft.storyboard, shotId, character);
    });
  },

  updateShotCharacter: (shotId, stagingId, patch, libraryCharacters) => {
    get().mutateProject((draft) => {
      if (!draft.storyboard) return;
      draft.storyboard = updateShotCharacterStaging(
        draft.storyboard,
        shotId,
        stagingId,
        patch,
        libraryCharacters,
      );
    });
  },

  removeShotCharacter: (shotId, stagingId) => {
    get().mutateProject((draft) => {
      if (!draft.storyboard) return;
      draft.storyboard = removeShotCharacterStaging(draft.storyboard, shotId, stagingId);
    });
  },

  restoreOriginalStoryboardShot: (shotId) => {
    get().mutateProject((draft) => {
      if (!draft.storyboard) return;
      draft.storyboard = restoreOriginalStoryboardShot(draft.storyboard, shotId);
    });
  },

  markStoryboardContinuityWarning: (warningId, patch) => {
    get().mutateProject((draft) => {
      if (!draft.storyboard) return;
      draft.storyboard = markContinuityWarning(draft.storyboard, warningId, patch);
    });
  },

  reconcileSceneDurationToStoryboard: (sceneId) => {
    let out = { updated: false, newDurationMs: 0 };
    get().mutateProject((draft) => {
      out = reconcileStageSceneDurationToShots(draft, sceneId);
    });
    return out;
  },

  // Phase 06 Batch 3 — AI Production Planner & Timeline Integration actions
  setProductionPlanDocument: (doc) => {
    set((s) => {
      if (!s.project) return s;
      return {
        project: {
          ...s.project,
          production_plan: doc,
        },
        lastSavedAt: new Date().toISOString(),
      };
    });
  },

  replaceProductionShotPlan: (shot) => {
    set((s) => {
      if (!s.project?.production_plan) return s;
      const replaced = s.project.production_plan.shots.map((sh) =>
        sh.production_shot_id === shot.production_shot_id ? shot : sh,
      );
      return {
        project: {
          ...s.project,
          production_plan: {
            ...s.project.production_plan,
            shots: replaced,
            updated_at: new Date().toISOString(),
          },
        },
        lastSavedAt: new Date().toISOString(),
      };
    });
  },

  editProductionShotPlan: (productionShotId, patch, libCtx) => {
    get().mutateProject((draft) => {
      if (!draft.production_plan) return;
      draft.production_plan = editProductionShotPlan(
        draft.production_plan,
        productionShotId,
        patch,
        libCtx,
      );
    });
  },

  toggleLockProductionShot: (productionShotId, locked) => {
    get().mutateProject((draft) => {
      if (!draft.production_plan) return;
      draft.production_plan = toggleLockProductionShot(
        draft.production_plan,
        productionShotId,
        locked,
      );
    });
  },

  setProductionShotApproval: (productionShotId, approval) => {
    get().mutateProject((draft) => {
      if (!draft.production_plan) return;
      draft.production_plan = setProductionShotApproval(
        draft.production_plan,
        productionShotId,
        approval,
      );
    });
  },

  approveSceneProductionShots: (sceneId) => {
    get().mutateProject((draft) => {
      if (!draft.production_plan) return;
      draft.production_plan = approveSceneProductionShots(draft.production_plan, sceneId);
    });
  },

  approveAllProductionShots: () => {
    get().mutateProject((draft) => {
      if (!draft.production_plan) return;
      draft.production_plan = approveAllProductionShots(draft.production_plan);
    });
  },

  assignProductionBackground: (productionShotId, asset, libCtx) => {
    get().mutateProject((draft) => {
      if (!draft.production_plan) return;
      draft.production_plan = assignShotBackgroundAsset(
        draft.production_plan,
        productionShotId,
        asset,
        libCtx,
      );
    });
  },

  assignProductionPropAsset: (productionShotId, requirementId, asset, libCtx) => {
    get().mutateProject((draft) => {
      if (!draft.production_plan) return;
      draft.production_plan = assignShotPropAsset(
        draft.production_plan,
        productionShotId,
        requirementId,
        asset,
        libCtx,
      );
    });
  },

  assignProductionCharacter: (productionShotId, stagingId, character, libCtx) => {
    get().mutateProject((draft) => {
      if (!draft.production_plan) return;
      draft.production_plan = assignShotCharacterLibrary(
        draft.production_plan,
        productionShotId,
        stagingId,
        character,
        libCtx,
      );
    });
  },

  assignProductionAudio: (productionShotId, listKind, audioPlanId, sound, libCtx) => {
    get().mutateProject((draft) => {
      if (!draft.production_plan) return;
      draft.production_plan = assignShotAudioSound(
        draft.production_plan,
        productionShotId,
        listKind,
        audioPlanId,
        sound,
        libCtx,
      );
    });
  },

  updateProductionCameraMovement: (productionShotId, cameraMovement, libCtx) => {
    get().mutateProject((draft) => {
      if (!draft.production_plan) return;
      draft.production_plan = updateShotCameraMovementPlan(
        draft.production_plan,
        productionShotId,
        cameraMovement,
        libCtx,
      );
    });
  },

  updateProductionAnimationCategory: (productionShotId, actionPlanId, category, libCtx) => {
    get().mutateProject((draft) => {
      if (!draft.production_plan) return;
      draft.production_plan = updateShotAnimationCategory(
        draft.production_plan,
        productionShotId,
        actionPlanId,
        category,
        libCtx,
      );
    });
  },

  applyProductionPlanToProjectTimeline: (options) => {
    let result: TimelineApplyResult = {
      appliedShots: 0,
      skippedConflictingShots: 0,
      charactersPlaced: 0,
      keyframesCreated: 0,
      animationClipsCreated: 0,
      audioClipsCreated: 0,
      subtitlesCreated: 0,
      skippedUnsupportedCount: 0,
    };
    get().mutateProject((draft) => {
      result = applyProductionPlanToTimeline(draft, options);
    });
    return result;
  },

  // Phase 07 Batch 1 — Scene Execution Engine & Editable Shot State Management
  applyExecutedProjectState: (updated, recordHistory = true) => {
    const { project, undoStack, syncSnapshot } = get();
    const fresh = cloneState(updated);
    reconcileProjectLayersAndTimeline(fresh);
    // Phase 09.1: the executed result wins for the sections the server changed, but unsaved
    // edits to other sections are no longer discarded.
    const merged = project ? mergeServerState(project, fresh, syncSnapshot, true) : null;
    const cloned = merged ? merged.project : fresh;
    const nextSnapshot = merged ? merged.snapshot : takeSnapshot(fresh);
    const firstExecutedScene =
      cloned.scenes.find((s) => s.shots && s.shots.length > 0) ?? cloned.scenes[0] ?? null;
    const firstShot = firstExecutedScene?.shots?.[0] ?? null;
    set({
      project: cloned,
      activeSceneId: firstExecutedScene?.scene_id ?? get().activeSceneId,
      activeShotId: firstShot?.shot_id ?? null,
      syncSnapshot: nextSnapshot,
      isDirty: dirtySections(cloned, nextSnapshot).length > 0,
      lastSavedAt: cloned.meta.updated_at || new Date().toISOString(),
      undoStack:
        recordHistory && project
          ? [...undoStack, cloneState(project)].slice(-MAX_HISTORY)
          : undoStack,
      redoStack: recordHistory ? [] : get().redoStack,
    });
  },

  updateSceneShot: (sceneId, shotId, patch) => {
    get().mutateProject((draft) => {
      const scene = draft.scenes.find((s) => s.scene_id === sceneId);
      if (!scene) return;
      if (editSceneShotState(scene, shotId, patch)) {
        const endMs = scene.start_ms + scene.duration_ms;
        if (endMs > draft.timeline.total_duration_ms) {
          draft.timeline.total_duration_ms = endMs;
          draft.meta.duration_ms = endMs;
        }
      }
    });
  },
}));
