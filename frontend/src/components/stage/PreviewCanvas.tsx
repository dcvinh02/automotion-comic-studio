import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Camera,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  Crosshair,
  Diamond,
  Frame,
  Grid,
  Maximize2,
  MousePointer2,
  Move,
  Pause,
  Play,
  Repeat,
  RotateCcw,
  RotateCw,
  Scaling,
  SkipBack,
  SkipForward,
  Square,
  Target,
  Trash2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { mergeMotionPreviewOverlay } from '@/engine/animationExecutionEngine';
import { audioPreviewEngine } from '@/engine/audioPreviewEngine';
import { evaluateStageAtFrame, frameToMs, msToFrame } from '@/engine/evaluator';
import { useI18n } from '@/i18n/useLocaleStore';
import { PixiStageController } from '@/renderer/PixiStageController';
import { apiClient } from '@/services/apiClient';
import { useAnimationExecStore } from '@/stores/useAnimationExecStore';
import { useLibraryStore } from '@/stores/useLibraryStore';
import { usePlaybackStore } from '@/stores/usePlaybackStore';
import { useProjectStore } from '@/stores/useProjectStore';
import {
  useWorkspaceStore,
  type PreviewResolution,
  type TransformToolId,
} from '@/stores/useWorkspaceStore';
import type { Character, SoundAsset } from '@/types/models';
import { EmptyState, formatTimecode } from '@/components/common/CommonUI';

interface DragSession {
  mode: 'move' | 'rotate' | 'scale' | 'pivot' | 'viewport_pan';
  targetType?: 'character' | 'prop';
  targetId?: string;
  sceneId?: string;
  startClientX: number;
  startClientY: number;
  startWorldX: number;
  startWorldY: number;
  origPanX: number;
  origPanY: number;
  origX: number;
  origY: number;
  origRot: number;
  origScaleX: number;
  origScaleY: number;
  origAnchorX: number;
  origAnchorY: number;
  boundsW: number;
  boundsH: number;
  centerStageX: number;
  centerStageY: number;
  startAngle: number;
  startDist: number;
}

export function PreviewCanvas({ onOpenProjects }: { onOpenProjects?: () => void }) {
  const { t } = useI18n();
  const project = useProjectStore((s) => s.project);
  const activeShotId = useProjectStore((s) => s.activeShotId);
  const setActiveShotId = useProjectStore((s) => s.setActiveShotId);
  const selection = useProjectStore((s) => s.selection);
  const setSelection = useProjectStore((s) => s.setSelection);
  const pushHistorySnapshot = useProjectStore((s) => s.pushHistorySnapshot);
  const updateCharacterInstance = useProjectStore((s) => s.updateCharacterInstance);
  const removeCharacterInstance = useProjectStore((s) => s.removeCharacterInstance);
  const updatePropInstance = useProjectStore((s) => s.updatePropInstance);
  const removePropInstance = useProjectStore((s) => s.removePropInstance);
  const moveSceneLayer = useProjectStore((s) => s.moveSceneLayer);
  const upsertKeyframe = useProjectStore((s) => s.upsertKeyframe);

  const characters = useLibraryStore((s) => s.characters);
  const sounds = useLibraryStore((s) => s.sounds);
  const previewOverlay = useAnimationExecStore((s) => s.previewOverlay);

  const isPlaying = usePlaybackStore((s) => s.isPlaying);
  const currentFrame = usePlaybackStore((s) => s.currentFrame);
  const loop = usePlaybackStore((s) => s.loop);
  const setPlaying = usePlaybackStore((s) => s.setPlaying);
  const setCurrentFrame = usePlaybackStore((s) => s.setCurrentFrame);
  const stepFrames = usePlaybackStore((s) => s.stepFrames);
  const setLoop = usePlaybackStore((s) => s.setLoop);

  const activeTool = useWorkspaceStore((s) => s.activeTool);
  const setActiveTool = useWorkspaceStore((s) => s.setActiveTool);
  const viewportZoom = useWorkspaceStore((s) => s.viewportZoom);
  const viewportPanX = useWorkspaceStore((s) => s.viewportPanX);
  const viewportPanY = useWorkspaceStore((s) => s.viewportPanY);
  const showGrid = useWorkspaceStore((s) => s.showGrid);
  const showSafeGuides = useWorkspaceStore((s) => s.showSafeGuides);
  const showGizmos = useWorkspaceStore((s) => s.showGizmos);
  const previewResolution = useWorkspaceStore((s) => s.previewResolution);
  const zoomViewportBy = useWorkspaceStore((s) => s.zoomViewportBy);
  const setViewportPan = useWorkspaceStore((s) => s.setViewportPan);
  const resetViewport = useWorkspaceStore((s) => s.resetViewport);
  const toggleGrid = useWorkspaceStore((s) => s.toggleGrid);
  const toggleSafeGuides = useWorkspaceStore((s) => s.toggleSafeGuides);
  const toggleGizmos = useWorkspaceStore((s) => s.toggleGizmos);
  const setPreviewResolution = useWorkspaceStore((s) => s.setPreviewResolution);
  const openContextMenu = useWorkspaceStore((s) => s.openContextMenu);

  const [redrawTick, setRedrawTick] = useState(0);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<PixiStageController | null>(null);
  const canvasElRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<DragSession | null>(null);

  const charactersById = useMemo(() => {
    const map: Record<string, Character> = {};
    for (const c of characters) map[c.character_id] = c;
    return map;
  }, [characters]);

  const soundsById = useMemo(() => {
    const map: Record<string, SoundAsset> = {};
    for (const s of sounds) map[s.sound_id] = s;
    return map;
  }, [sounds]);

  const fps = project?.timeline.fps ?? 30;
  const maxFrame = project
    ? Math.max(0, msToFrame(project.timeline.total_duration_ms, fps) - 1)
    : 0;

  // Respect track visibility (hidden character & prop tracks are excluded from live preview)
  const hiddenTargetIds = useMemo(() => {
    const set = new Set<string>();
    if (!project) return set;
    for (const trk of project.timeline.tracks) {
      if ((trk.track_type === 'character' || trk.track_type === 'prop') && trk.visible === false && trk.target_ref_id) {
        set.add(trk.target_ref_id);
      }
    }
    return set;
  }, [project?.timeline.tracks]);

  const lockedTargetIds = useMemo(() => {
    const set = new Set<string>();
    if (!project) return set;
    for (const trk of project.timeline.tracks) {
      if ((trk.track_type === 'character' || trk.track_type === 'prop') && trk.locked && trk.target_ref_id) {
        set.add(trk.target_ref_id);
      }
    }
    return set;
  }, [project?.timeline.tracks]);

  const effectiveProject = useMemo(
    () => (project ? mergeMotionPreviewOverlay(project, previewOverlay) : null),
    [project, previewOverlay],
  );

  const evaluated = useMemo(() => {
    if (!effectiveProject) return null;
    const raw = evaluateStageAtFrame(effectiveProject, charactersById, currentFrame, fps);
    if (hiddenTargetIds.size === 0) return raw;
    return {
      ...raw,
      characters: raw.characters.map((c) =>
        hiddenTargetIds.has(c.instance_id) ? { ...c, visible: false } : c,
      ),
      props: raw.props.map((p) =>
        hiddenTargetIds.has(p.prop_instance_id) ? { ...p, visible: false } : p,
      ),
    };
  }, [effectiveProject, charactersById, currentFrame, fps, hiddenTargetIds]);

  // Keep activeShotId synchronized with playhead's evaluated active shot (never relying on array index!)
  useEffect(() => {
    const nextShotId = evaluated?.activeShot?.shot_id ?? null;
    if (nextShotId !== activeShotId) {
      setActiveShotId(nextShotId);
    }
  }, [evaluated?.activeShot?.shot_id]);

  const selectionIsLocked = useMemo(() => {
    if (!evaluated || !selection.id) return false;
    if (lockedTargetIds.has(selection.id)) return true;
    if (selection.type === 'character') {
      return Boolean(evaluated.characters.find((c) => c.instance_id === selection.id)?.locked);
    }
    if (selection.type === 'prop') {
      return Boolean(evaluated.props.find((p) => p.prop_instance_id === selection.id)?.locked);
    }
    return false;
  }, [evaluated, selection, lockedTargetIds]);

  // Mount PixiJS Stage once per project
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ctrl = new PixiStageController();
    controllerRef.current = ctrl;

    let alive = true;
    const w = project?.meta.width ?? 1920;
    const h = project?.meta.height ?? 1080;

    void ctrl
      .mount(host, w, h, () => {
        if (alive) setRedrawTick((tick) => tick + 1);
      })
      .then((canvas) => {
        if (alive) {
          canvasElRef.current = canvas;
          setRedrawTick((tick) => tick + 1);
        }
      })
      .catch(() => {
        // Destroyed before mount finished
      });

    return () => {
      alive = false;
      ctrl.destroy();
      controllerRef.current = null;
      canvasElRef.current = null;
    };
  }, [project?.meta.project_id]);

  // Render whenever evaluated stage, selection, active tool, subtitles, or viewport overlays change
  const subtitlesTrackVisible = useMemo(() => {
    if (!project) return true;
    const trk = project.timeline.tracks.find((t) => t.track_type === 'subtitle');
    return trk ? trk.visible !== false : true;
  }, [project?.timeline.tracks]);

  useEffect(() => {
    const ctrl = controllerRef.current;
    if (!ctrl || !project || !evaluated) return;
    ctrl.setStageDimensions(project.meta.width, project.meta.height);
    ctrl.render(
      evaluated,
      selection,
      {
        showGizmos: showGizmos && !isPlaying,
        showGrid: showGrid && !isPlaying,
        showSafeGuides: showSafeGuides && !isPlaying,
        activeTool,
        selectionLocked: selectionIsLocked,
        subtitles: project.subtitles ?? null,
        subtitlesVisible: subtitlesTrackVisible,
      },
      (aid) => apiClient.getAssetFileUrl(aid),
    );
  }, [
    project,
    evaluated,
    selection,
    activeTool,
    selectionIsLocked,
    showGizmos,
    showGrid,
    showSafeGuides,
    subtitlesTrackVisible,
    isPlaying,
    redrawTick,
  ]);

  // Drift-free playback loop + Web Audio SFX sync (respects non-destructive Motion Preview window!)
  useEffect(() => {
    if (!isPlaying || !project) {
      audioPreviewEngine.stopTimelinePlayback();
      return;
    }

    const activeOverlay =
      previewOverlay && previewOverlay.projectId === project.meta.project_id
        ? previewOverlay
        : null;
    const rangeStart = activeOverlay ? msToFrame(activeOverlay.startMs, fps) : 0;
    const rangeEnd = activeOverlay
      ? Math.max(rangeStart + 1, Math.min(maxFrame, msToFrame(activeOverlay.endMs, fps)))
      : maxFrame;
    const shouldLoop = activeOverlay ? true : loop;

    let startFrame =
      currentFrame < rangeStart || currentFrame >= rangeEnd ? rangeStart : currentFrame;
    if (startFrame !== currentFrame) {
      setCurrentFrame(startFrame);
    }
    const startMs = frameToMs(startFrame, fps);
    let startPerf = performance.now();

    if (!activeOverlay) {
      void audioPreviewEngine.startTimelinePlayback(startMs, project, soundsById, (sid) =>
        apiClient.getSoundFileUrl(sid),
      );
    }

    let rafId = 0;
    const tick = (now: number) => {
      const elapsedMs = now - startPerf;
      const nextFrame = startFrame + Math.floor((elapsedMs * fps) / 1000);
      if (nextFrame >= rangeEnd) {
        if (shouldLoop) {
          startFrame = rangeStart;
          startPerf = now;
          setCurrentFrame(rangeStart);
          rafId = requestAnimationFrame(tick);
          return;
        } else {
          setCurrentFrame(rangeEnd);
          setPlaying(false);
          audioPreviewEngine.stopTimelinePlayback();
          return;
        }
      }
      setCurrentFrame(nextFrame);
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafId);
      audioPreviewEngine.stopTimelinePlayback();
    };
  }, [
    isPlaying,
    loop,
    fps,
    maxFrame,
    project?.meta.project_id,
    previewOverlay?.startMs,
    previewOverlay?.endMs,
  ]);

  const stageCoordsFromPointer = useCallback(
    (clientX: number, clientY: number): { stageX: number; stageY: number } | null => {
      const canvas = canvasElRef.current;
      if (!canvas || !project) return null;
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;

      const stageAspect = project.meta.width / project.meta.height;
      const rectAspect = rect.width / rect.height;

      let drawW = rect.width;
      let drawH = rect.height;
      let offsetX = 0;
      let offsetY = 0;

      if (rectAspect > stageAspect) {
        drawW = rect.height * stageAspect;
        offsetX = (rect.width - drawW) / 2;
      } else {
        drawH = rect.width / stageAspect;
        offsetY = (rect.height - drawH) / 2;
      }

      const normX = (clientX - rect.left - offsetX) / drawW;
      const normY = (clientY - rect.top - offsetY) / drawH;
      return {
        stageX: normX * project.meta.width,
        stageY: normY * project.meta.height,
      };
    },
    [project],
  );

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      zoomViewportBy(e.deltaY < 0 ? 0.15 : -0.15);
    }
  };

  const beginTargetDrag = (
    mode: 'move' | 'rotate' | 'scale' | 'pivot',
    targetType: 'character' | 'prop',
    targetId: string,
    pt: { stageX: number; stageY: number },
    worldPt: { x: number; y: number },
    e: React.PointerEvent<HTMLDivElement>,
  ) => {
    if (!project || !evaluated || !evaluated.scene || !controllerRef.current) return;
    if (lockedTargetIds.has(targetId)) return;

    const targetChar = evaluated.characters.find((c) => c.instance_id === targetId);
    const targetProp = evaluated.props.find((p) => p.prop_instance_id === targetId);
    if (targetChar?.locked || targetProp?.locked) return;

    const rawSceneProp = evaluated.scene.props.find((p) => p.prop_instance_id === targetId);
    const t = targetChar?.transform ?? targetProp?.transform;
    if (!t) return;

    // For props with a parent, edit local coordinates while still anchoring rotation/scale around visual pivot
    const origX = targetType === 'prop' && rawSceneProp?.parent_id ? rawSceneProp.transform.x : t.x;
    const origY = targetType === 'prop' && rawSceneProp?.parent_id ? rawSceneProp.transform.y : t.y;
    const origRot = targetType === 'prop' && rawSceneProp?.parent_id ? rawSceneProp.transform.rotation_deg : t.rotation_deg;
    const origScaleX = targetType === 'prop' && rawSceneProp?.parent_id ? rawSceneProp.transform.scale_x : t.scale_x;
    const origScaleY = targetType === 'prop' && rawSceneProp?.parent_id ? rawSceneProp.transform.scale_y : t.scale_y;

    const ctrl = controllerRef.current;
    const bounds = ctrl.getBoundsById(targetId);
    const center = ctrl.stageFromWorldPoint(t.x, t.y, evaluated.camera);

    pushHistorySnapshot();
    dragRef.current = {
      mode,
      targetType,
      targetId,
      sceneId: evaluated.scene.scene_id,
      startClientX: e.clientX,
      startClientY: e.clientY,
      origPanX: viewportPanX,
      origPanY: viewportPanY,
      startWorldX: worldPt.x,
      startWorldY: worldPt.y,
      origX,
      origY,
      origRot,
      origScaleX,
      origScaleY,
      origAnchorX: targetProp?.anchor_x ?? 0.5,
      origAnchorY: targetProp?.anchor_y ?? 0.5,
      boundsW: Math.max(40, bounds?.width ?? 120),
      boundsH: Math.max(40, bounds?.height ?? 120),
      centerStageX: center.x,
      centerStageY: center.y,
      startAngle: Math.atan2(pt.stageY - center.y, pt.stageX - center.x),
      startDist: Math.max(10, Math.hypot(pt.stageX - center.x, pt.stageY - center.y)),
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Ignore clicks on floating HUD / tool rail buttons
    if ((e.target as HTMLElement).closest('.canvas-hud-top, .canvas-tool-rail')) {
      return;
    }

    // Middle mouse or Alt+Left-drag pans viewport (strictly decoupled from object transforms)
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      e.preventDefault();
      dragRef.current = {
        mode: 'viewport_pan',
        startClientX: e.clientX,
        startClientY: e.clientY,
        origPanX: viewportPanX,
        origPanY: viewportPanY,
        startWorldX: 0,
        startWorldY: 0,
        origX: 0,
        origY: 0,
        origRot: 0,
        origScaleX: 1,
        origScaleY: 1,
        origAnchorX: 0.5,
        origAnchorY: 0.5,
        boundsW: 100,
        boundsH: 100,
        centerStageX: 0,
        centerStageY: 0,
        startAngle: 0,
        startDist: 1,
      };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }

    if (e.button !== 0 || !project || !evaluated || !evaluated.scene || !controllerRef.current || isPlaying) {
      return;
    }
    const pt = stageCoordsFromPointer(e.clientX, e.clientY);
    if (!pt) return;

    const ctrl = controllerRef.current;
    const worldPt = ctrl.worldFromStagePoint(pt.stageX, pt.stageY, evaluated.camera);

    // 1. Direct gizmo handle hit-test (rotate / scale handles)
    const handle = ctrl.hitTestHandle(pt.stageX, pt.stageY, selection, evaluated.camera);
    if (handle && selection.id && (selection.type === 'character' || selection.type === 'prop')) {
      beginTargetDrag(handle, selection.type, selection.id, pt, worldPt, e);
      return;
    }

    // 2. If dedicated rotate/scale/pivot tool is active and an object is already selected, operate directly on it
    if (
      (activeTool === 'rotate' || activeTool === 'scale' || activeTool === 'pivot') &&
      selection.id &&
      (selection.type === 'character' || selection.type === 'prop')
    ) {
      const hitObj = ctrl.hitTest(worldPt.x, worldPt.y);
      if (hitObj && hitObj.id !== selection.id) {
        setSelection({ type: hitObj.type, id: hitObj.id });
        const modeForHit = activeTool === 'pivot' && hitObj.type !== 'prop' ? 'move' : activeTool;
        beginTargetDrag(modeForHit, hitObj.type, hitObj.id, pt, worldPt, e);
        return;
      }
      if (activeTool === 'pivot' && selection.type === 'prop') {
        beginTargetDrag('pivot', 'prop', selection.id, pt, worldPt, e);
        return;
      }
      if (activeTool === 'rotate' || activeTool === 'scale') {
        beginTargetDrag(activeTool, selection.type, selection.id, pt, worldPt, e);
        return;
      }
    }

    // 3. Object hit-test
    const hit = ctrl.hitTest(worldPt.x, worldPt.y);
    if (!hit) {
      setSelection({ type: 'scene', id: evaluated.scene.scene_id });
      return;
    }

    setSelection({ type: hit.type, id: hit.id });
    const dragMode =
      activeTool === 'rotate'
        ? 'rotate'
        : activeTool === 'scale'
          ? 'scale'
          : activeTool === 'pivot' && hit.type === 'prop'
            ? 'pivot'
            : 'move';
    beginTargetDrag(dragMode, hit.type, hit.id, pt, worldPt, e);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;

    if (drag.mode === 'viewport_pan') {
      setViewportPan(
        drag.origPanX + (e.clientX - drag.startClientX),
        drag.origPanY + (e.clientY - drag.startClientY),
      );
      return;
    }

    if (!project || !evaluated || !controllerRef.current || !drag.targetId || !drag.sceneId || !drag.targetType) {
      return;
    }
    const pt = stageCoordsFromPointer(e.clientX, e.clientY);
    if (!pt) return;

    const timeMs = evaluated.timeMs;
    const hasKf = (prop: 'x' | 'y' | 'rotation_deg' | 'scale_x' | 'scale_y') =>
      project.timeline.keyframes.some(
        (k) => k.target_id === drag.targetId && k.property === prop,
      );

    const trackId =
      project.timeline.tracks.find((tr) => tr.target_ref_id === drag.targetId)?.track_id ??
      project.timeline.tracks[0]?.track_id ??
      '';

    if (drag.mode === 'move') {
      const worldPt = controllerRef.current.worldFromStagePoint(
        pt.stageX,
        pt.stageY,
        evaluated.camera,
      );
      let dx = worldPt.x - drag.startWorldX;
      let dy = worldPt.y - drag.startWorldY;
      // Shift constrains movement to primary axis
      if (e.shiftKey) {
        if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      const nextX = Math.round(drag.origX + dx);
      const nextY = Math.round(drag.origY + dy);

      if (hasKf('x') || hasKf('y')) {
        const tType = drag.targetType === 'character' ? 'character_instance' : 'prop';
        upsertKeyframe({ track_id: trackId, target_type: tType, target_id: drag.targetId, property: 'x', time_ms: timeMs, value: nextX });
        upsertKeyframe({ track_id: trackId, target_type: tType, target_id: drag.targetId, property: 'y', time_ms: timeMs, value: nextY });
      } else if (drag.targetType === 'character') {
        const sc = project.scenes.find((s) => s.scene_id === drag.sceneId);
        const inst = sc?.characters.find((c) => c.instance_id === drag.targetId);
        if (inst) {
          updateCharacterInstance(
            drag.sceneId,
            drag.targetId,
            { initial_transform: { ...inst.initial_transform, x: nextX, y: nextY } },
            false,
          );
        }
      } else {
        const sc = project.scenes.find((s) => s.scene_id === drag.sceneId);
        const prop = sc?.props.find((p) => p.prop_instance_id === drag.targetId);
        if (prop) {
          updatePropInstance(
            drag.sceneId,
            drag.targetId,
            { transform: { ...prop.transform, x: nextX, y: nextY } },
            false,
          );
        }
      }
    } else if (drag.mode === 'rotate') {
      const angle = Math.atan2(pt.stageY - drag.centerStageY, pt.stageX - drag.centerStageX);
      let deltaDeg = ((angle - drag.startAngle) * 180) / Math.PI;
      let nextRot = Math.round((drag.origRot + deltaDeg) * 10) / 10;
      if (e.shiftKey) {
        nextRot = Math.round(nextRot / 15) * 15;
      }

      if (hasKf('rotation_deg')) {
        const tType = drag.targetType === 'character' ? 'character_instance' : 'prop';
        upsertKeyframe({ track_id: trackId, target_type: tType, target_id: drag.targetId, property: 'rotation_deg', time_ms: timeMs, value: nextRot });
      } else if (drag.targetType === 'character') {
        const sc = project.scenes.find((s) => s.scene_id === drag.sceneId);
        const inst = sc?.characters.find((c) => c.instance_id === drag.targetId);
        if (inst) {
          updateCharacterInstance(
            drag.sceneId,
            drag.targetId,
            { initial_transform: { ...inst.initial_transform, rotation_deg: nextRot } },
            false,
          );
        }
      } else {
        const sc = project.scenes.find((s) => s.scene_id === drag.sceneId);
        const prop = sc?.props.find((p) => p.prop_instance_id === drag.targetId);
        if (prop) {
          updatePropInstance(
            drag.sceneId,
            drag.targetId,
            { transform: { ...prop.transform, rotation_deg: nextRot } },
            false,
          );
        }
      }
    } else if (drag.mode === 'scale') {
      const dist = Math.max(10, Math.hypot(pt.stageX - drag.centerStageX, pt.stageY - drag.centerStageY));
      const ratio = Math.max(0.1, Math.min(5, dist / drag.startDist));
      const nextSx = Math.round(drag.origScaleX * ratio * 100) / 100;
      const nextSy = e.shiftKey
        ? drag.origScaleY
        : Math.round(drag.origScaleY * ratio * 100) / 100;

      if (hasKf('scale_x') || hasKf('scale_y')) {
        const tType = drag.targetType === 'character' ? 'character_instance' : 'prop';
        upsertKeyframe({ track_id: trackId, target_type: tType, target_id: drag.targetId, property: 'scale_x', time_ms: timeMs, value: nextSx });
        upsertKeyframe({ track_id: trackId, target_type: tType, target_id: drag.targetId, property: 'scale_y', time_ms: timeMs, value: nextSy });
      } else if (drag.targetType === 'character') {
        const sc = project.scenes.find((s) => s.scene_id === drag.sceneId);
        const inst = sc?.characters.find((c) => c.instance_id === drag.targetId);
        if (inst) {
          updateCharacterInstance(
            drag.sceneId,
            drag.targetId,
            { initial_transform: { ...inst.initial_transform, scale_x: nextSx, scale_y: nextSy } },
            false,
          );
        }
      } else {
        const sc = project.scenes.find((s) => s.scene_id === drag.sceneId);
        const prop = sc?.props.find((p) => p.prop_instance_id === drag.targetId);
        if (prop) {
          updatePropInstance(
            drag.sceneId,
            drag.targetId,
            { transform: { ...prop.transform, scale_x: nextSx, scale_y: nextSy } },
            false,
          );
        }
      }
    } else if (drag.mode === 'pivot' && drag.targetType === 'prop') {
      const worldPt = controllerRef.current.worldFromStagePoint(
        pt.stageX,
        pt.stageY,
        evaluated.camera,
      );
      const dxWorld = worldPt.x - drag.startWorldX;
      const dyWorld = worldPt.y - drag.startWorldY;
      const rad = (-drag.origRot * Math.PI) / 180;
      const localDx = dxWorld * Math.cos(rad) - dyWorld * Math.sin(rad);
      const localDy = dxWorld * Math.sin(rad) + dyWorld * Math.cos(rad);
      const nextAx = Math.max(0, Math.min(1, Math.round((drag.origAnchorX + localDx / drag.boundsW) * 100) / 100));
      const nextAy = Math.max(0, Math.min(1, Math.round((drag.origAnchorY + localDy / drag.boundsH) * 100) / 100));
      const sc = project.scenes.find((s) => s.scene_id === drag.sceneId);
      const prop = sc?.props.find((p) => p.prop_instance_id === drag.targetId);
      if (prop) {
        const daxPx = (nextAx - drag.origAnchorX) * drag.boundsW;
        const dayPx = (nextAy - drag.origAnchorY) * drag.boundsH;
        const fwdRad = (drag.origRot * Math.PI) / 180;
        const compDx = daxPx * Math.cos(fwdRad) - dayPx * Math.sin(fwdRad);
        const compDy = daxPx * Math.sin(fwdRad) + dayPx * Math.cos(fwdRad);
        const preserveVisualPos = !hasKf('x') && !hasKf('y') && !prop.parent_id;
        updatePropInstance(
          drag.sceneId,
          drag.targetId,
          preserveVisualPos
            ? {
                anchor_x: nextAx,
                anchor_y: nextAy,
                transform: {
                  ...prop.transform,
                  x: Math.round(drag.origX + compDx),
                  y: Math.round(drag.origY + compDy),
                },
              }
            : { anchor_x: nextAx, anchor_y: nextAy },
          false,
        );
      }
    }
  };

  const handlePointerUp = () => {
    dragRef.current = null;
  };

  const handleStop = () => {
    setPlaying(false);
    audioPreviewEngine.stopTimelinePlayback();
    setCurrentFrame(0);
  };

  const handleStageContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!project || !evaluated || !evaluated.scene || !controllerRef.current) return;
    e.preventDefault();
    const scene = evaluated.scene;
    const pt = stageCoordsFromPointer(e.clientX, e.clientY);
    const hit = pt
      ? controllerRef.current.hitTest(
          controllerRef.current.worldFromStagePoint(pt.stageX, pt.stageY, evaluated.camera).x,
          controllerRef.current.worldFromStagePoint(pt.stageX, pt.stageY, evaluated.camera).y,
        )
      : null;

    if (hit && hit.type === 'character') {
      setSelection({ type: 'character', id: hit.id });
      const inst = scene.characters.find((c) => c.instance_id === hit.id);
      const evalChar = evaluated.characters.find((c) => c.instance_id === hit.id);
      const charTrack = project.timeline.tracks.find((tr) => tr.target_ref_id === hit.id);
      if (!inst || !evalChar) return;
      const trackId = charTrack?.track_id ?? project.timeline.tracks[0]?.track_id ?? '';
      openContextMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          {
            id: 'key-all',
            label: t('stage.ctxKeyAll', { name: inst.display_name }),
            icon: <Diamond size={12} color="var(--track-keyframe)" />,
            onSelect: () => {
              const tms = evaluated.timeMs;
              upsertKeyframe({ track_id: trackId, target_type: 'character_instance', target_id: inst.instance_id, property: 'x', time_ms: tms, value: Math.round(evalChar.transform.x) });
              upsertKeyframe({ track_id: trackId, target_type: 'character_instance', target_id: inst.instance_id, property: 'y', time_ms: tms, value: Math.round(evalChar.transform.y) });
              upsertKeyframe({ track_id: trackId, target_type: 'character_instance', target_id: inst.instance_id, property: 'rotation_deg', time_ms: tms, value: evalChar.transform.rotation_deg });
              upsertKeyframe({ track_id: trackId, target_type: 'character_instance', target_id: inst.instance_id, property: 'scale_x', time_ms: tms, value: evalChar.transform.scale_x });
              upsertKeyframe({ track_id: trackId, target_type: 'character_instance', target_id: inst.instance_id, property: 'scale_y', time_ms: tms, value: evalChar.transform.scale_y });
              upsertKeyframe({ track_id: trackId, target_type: 'character_instance', target_id: inst.instance_id, property: 'opacity', time_ms: tms, value: evalChar.transform.opacity });
            },
          },
          {
            id: 'reset-t',
            label: t('stage.ctxResetPos'),
            icon: <RotateCcw size={12} />,
            onSelect: () =>
              updateCharacterInstance(scene.scene_id, inst.instance_id, {
                initial_transform: {
                  ...inst.initial_transform,
                  x: Math.round(project.meta.width / 2),
                  y: Math.round(project.meta.height * 0.62),
                  rotation_deg: 0,
                  scale_x: 1,
                  scale_y: 1,
                  opacity: 1,
                },
              }),
          },
          {
            id: 'z-front',
            label: t('layer.bringToFront'),
            onSelect: () => moveSceneLayer(scene.scene_id, inst.instance_id, 'front'),
          },
          {
            id: 'z-up',
            label: t('stage.ctxBringForward'),
            onSelect: () => moveSceneLayer(scene.scene_id, inst.instance_id, 'up'),
          },
          {
            id: 'z-down',
            label: t('stage.ctxSendBackward'),
            onSelect: () => moveSceneLayer(scene.scene_id, inst.instance_id, 'down'),
          },
          {
            id: 'z-back',
            label: t('layer.sendToBack'),
            onSelect: () => moveSceneLayer(scene.scene_id, inst.instance_id, 'back'),
          },
          { id: 'div-rm', divider: true },
          {
            id: 'remove',
            label: t('stage.ctxRemoveChar'),
            icon: <Trash2 size={12} />,
            danger: true,
            onSelect: () => removeCharacterInstance(scene.scene_id, inst.instance_id),
          },
        ],
      });
      return;
    }

    if (hit && hit.type === 'prop') {
      setSelection({ type: 'prop', id: hit.id });
      const prop = scene.props.find((p) => p.prop_instance_id === hit.id);
      const evalProp = evaluated.props.find((p) => p.prop_instance_id === hit.id);
      const propTrack = project.timeline.tracks.find((tr) => tr.target_ref_id === hit.id);
      const trackId = propTrack?.track_id ?? project.timeline.tracks[0]?.track_id ?? '';
      if (!prop || !evalProp) return;
      openContextMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          {
            id: 'key-prop-all',
            label: t('stage.ctxKeyAllProp', { name: prop.name }),
            icon: <Diamond size={12} color="var(--track-keyframe)" />,
            onSelect: () => {
              const tms = evaluated.timeMs;
              upsertKeyframe({ track_id: trackId, target_type: 'prop', target_id: prop.prop_instance_id, property: 'x', time_ms: tms, value: Math.round(prop.transform.x) });
              upsertKeyframe({ track_id: trackId, target_type: 'prop', target_id: prop.prop_instance_id, property: 'y', time_ms: tms, value: Math.round(prop.transform.y) });
              upsertKeyframe({ track_id: trackId, target_type: 'prop', target_id: prop.prop_instance_id, property: 'rotation_deg', time_ms: tms, value: prop.transform.rotation_deg });
              upsertKeyframe({ track_id: trackId, target_type: 'prop', target_id: prop.prop_instance_id, property: 'scale_x', time_ms: tms, value: prop.transform.scale_x });
              upsertKeyframe({ track_id: trackId, target_type: 'prop', target_id: prop.prop_instance_id, property: 'scale_y', time_ms: tms, value: prop.transform.scale_y });
              upsertKeyframe({ track_id: trackId, target_type: 'prop', target_id: prop.prop_instance_id, property: 'opacity', time_ms: tms, value: prop.transform.opacity });
            },
          },
          {
            id: 'reset-prop',
            label: t('stage.ctxResetProp'),
            icon: <RotateCcw size={12} />,
            onSelect: () =>
              updatePropInstance(scene.scene_id, prop.prop_instance_id, {
                transform: {
                  x: Math.round(project.meta.width / 2),
                  y: Math.round(project.meta.height / 2),
                  rotation_deg: 0,
                  scale_x: 1,
                  scale_y: 1,
                  opacity: 1,
                },
              }),
          },
          {
            id: 'prop-z-front',
            label: t('layer.bringToFront'),
            onSelect: () => moveSceneLayer(scene.scene_id, prop.prop_instance_id, 'front'),
          },
          {
            id: 'prop-z-up',
            label: t('stage.ctxBringForward'),
            onSelect: () => moveSceneLayer(scene.scene_id, prop.prop_instance_id, 'up'),
          },
          {
            id: 'prop-z-down',
            label: t('stage.ctxSendBackward'),
            onSelect: () => moveSceneLayer(scene.scene_id, prop.prop_instance_id, 'down'),
          },
          {
            id: 'prop-z-back',
            label: t('layer.sendToBack'),
            onSelect: () => moveSceneLayer(scene.scene_id, prop.prop_instance_id, 'back'),
          },
          { id: 'div-rm-p', divider: true },
          {
            id: 'remove-prop',
            label: t('stage.ctxRemoveProp'),
            icon: <Trash2 size={12} />,
            danger: true,
            onSelect: () => removePropInstance(scene.scene_id, hit.id),
          },
        ],
      });
      return;
    }

    openContextMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          id: 'sel-cam',
          label: t('stage.ctxInspectCamera'),
          icon: <Camera size={12} />,
          onSelect: () => setSelection({ type: 'camera', id: 'camera' }),
        },
        {
          id: 'sel-scene',
          label: t('stage.ctxInspectScene', { name: scene.name }),
          onSelect: () => setSelection({ type: 'scene', id: scene.scene_id }),
        },
        { id: 'div-vp', divider: true },
        {
          id: 'toggle-grid',
          label: showGrid ? t('stage.ctxHideGrid') : t('stage.ctxShowGrid'),
          shortcut: 'G',
          onSelect: toggleGrid,
        },
        {
          id: 'toggle-safe',
          label: showSafeGuides ? t('stage.ctxHideSafe') : t('stage.ctxShowSafe'),
          shortcut: "'",
          onSelect: toggleSafeGuides,
        },
        {
          id: 'reset-vp',
          label: t('stage.resetViewport'),
          shortcut: '0',
          onSelect: resetViewport,
        },
      ],
    });
  };

  if (!project) {
    return (
      <div className="canvas-viewport">
        <EmptyState
          title={t('stage.noProjectTitle')}
          description={t('stage.noProjectDesc')}
          action={
            onOpenProjects && (
              <button className="btn-primary" onClick={onOpenProjects}>
                {t('stage.openOrCreateBtn')}
              </button>
            )
          }
        />
      </div>
    );
  }

  const vpScale = viewportZoom === 'fit' ? 1 : viewportZoom;
  const stageTools: { id: TransformToolId; icon: React.ReactNode; titleKey: string }[] = [
    { id: 'select', icon: <MousePointer2 size={13} />, titleKey: 'stage.toolSelect' },
    { id: 'move', icon: <Move size={13} />, titleKey: 'stage.toolMove' },
    { id: 'rotate', icon: <RotateCw size={13} />, titleKey: 'stage.toolRotate' },
    { id: 'scale', icon: <Scaling size={13} />, titleKey: 'stage.toolScale' },
    { id: 'pivot', icon: <Target size={13} />, titleKey: 'stage.toolPivot' },
  ];

  const selectedPropForPivot =
    activeTool === 'pivot' && selection.type === 'prop' && selection.id
      ? evaluated?.props.find((p) => p.prop_instance_id === selection.id) ?? null
      : null;

  const viewportCursor = dragRef.current
    ? 'grabbing'
    : activeTool === 'move'
      ? 'move'
      : activeTool === 'pivot'
        ? 'crosshair'
        : activeTool === 'rotate'
          ? 'alias'
          : activeTool === 'scale'
            ? 'nwse-resize'
            : 'default';

  return (
    <>
      {evaluated?.scene?.shots && evaluated.scene.shots.length > 0 && (
        <div className="stage-shot-bar" data-testid="stage-shot-switcher">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--text-secondary)', fontWeight: 600, flexShrink: 0 }}>
            <Clapperboard size={11} color="var(--accent-text)" />
            {t('sceneExec.shotBarLabel')}
          </span>
          <div className="stage-shot-pills">
            {evaluated.scene.shots.map((sh) => {
              const isCurrent = evaluated.activeShot?.shot_id === sh.shot_id;
              return (
                <button
                  key={sh.shot_id}
                  type="button"
                  data-testid={`stage-shot-pill-${sh.shot_order}`}
                  className={`stage-shot-pill ${isCurrent ? 'active' : ''}`}
                  onClick={() => {
                    setActiveShotId(sh.shot_id);
                    setSelection({ type: 'shot', id: sh.shot_id });
                    setCurrentFrame(msToFrame((evaluated.scene?.start_ms ?? 0) + sh.start_ms, fps));
                  }}
                >
                  <span className="mono" style={{ fontWeight: 700 }}>#{sh.shot_order}</span>
                  <span>{sh.title}</span>
                  <span className="mono" style={{ opacity: 0.72 }}>{(sh.duration_ms / 1000).toFixed(1)}s</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      <div
        className="canvas-viewport"
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onContextMenu={handleStageContextMenu}
      >
        {/* Top HUD: Resolution + Scene Camera Readout | Viewport Zoom & Guide Controls */}
        <div className="canvas-hud-top">
          <div className="canvas-hud-chip mono">
            <span>
              {project.meta.width}×{project.meta.height}
            </span>
            <span className="hud-fps-readout" style={{ opacity: 0.4 }}>•</span>
            <span className="hud-fps-readout">{fps}fps</span>
            <span className="hud-cam-readout" style={{ opacity: 0.4 }}>•</span>
            <span className="hud-cam-readout">
              Cam {evaluated?.camera.zoom.toFixed(2)}x ({Math.round(evaluated?.camera.x ?? 0)},{' '}
              {Math.round(evaluated?.camera.y ?? 0)})
            </span>
            <span className="hud-res-select" style={{ opacity: 0.4 }}>•</span>
            <select
              className="hud-res-select"
              aria-label="Preview Resolution Scale"
              value={previewResolution}
              onChange={(e) => setPreviewResolution(e.target.value as PreviewResolution)}
              style={{
                background: 'transparent',
                border: 'none',
                padding: 0,
                fontSize: 10,
                color: 'var(--accent-text)',
                cursor: 'pointer',
              }}
            >
              <option value="full">{t('stage.fullRes')}</option>
              <option value="half">{t('stage.halfRes')}</option>
              <option value="quarter">{t('stage.quarterRes')}</option>
            </select>
          </div>

          <div className="canvas-hud-chip">
            <button
              className="btn-ghost btn-icon btn-xs"
              title={t('stage.zoomOut')}
              aria-label={t('stage.zoomOut')}
              onClick={() => zoomViewportBy(-0.15)}
            >
              <ZoomOut size={12} />
            </button>
            <button
              className="btn-ghost btn-xs mono"
              title={t('stage.resetViewport')}
              onClick={resetViewport}
              style={{ minWidth: 44 }}
            >
              {viewportZoom === 'fit' ? t('stage.fit') : `${Math.round(viewportZoom * 100)}%`}
            </button>
            <button
              className="btn-ghost btn-icon btn-xs"
              title={t('stage.zoomIn')}
              aria-label={t('stage.zoomIn')}
              onClick={() => zoomViewportBy(0.15)}
            >
              <ZoomIn size={12} />
            </button>
            <span className="toolbar-divider" style={{ height: 14 }} />
            <button
              className={`btn-ghost btn-icon btn-xs ${showGrid ? 'active' : ''}`}
              title={t('stage.toggleGrid')}
              aria-label={t('stage.toggleGrid')}
              onClick={toggleGrid}
            >
              <Grid size={12} />
            </button>
            <button
              className={`btn-ghost btn-icon btn-xs ${showSafeGuides ? 'active' : ''}`}
              title={t('stage.toggleSafeGuides')}
              aria-label={t('stage.toggleSafeGuides')}
              onClick={toggleSafeGuides}
            >
              <Frame size={12} />
            </button>
            <button
              className={`btn-ghost btn-icon btn-xs ${showGizmos ? 'active' : ''}`}
              title={t('stage.toggleGizmos')}
              aria-label={t('stage.toggleGizmos')}
              onClick={toggleGizmos}
            >
              <Crosshair size={12} />
            </button>
            {(viewportZoom !== 'fit' || viewportPanX !== 0 || viewportPanY !== 0) && (
              <button
                className="btn-ghost btn-icon btn-xs"
                title={t('stage.resetViewport')}
                aria-label={t('stage.resetViewport')}
                onClick={resetViewport}
              >
                <Maximize2 size={11} />
              </button>
            )}
          </div>
        </div>

        {/* Left Floating Transform Tool Rail (Select V / Move W / Rotate R / Scale S / Pivot P) */}
        <div className="canvas-tool-rail" role="toolbar" aria-label="Transform Tools">
          {stageTools.map((tool) => (
            <button
              key={tool.id}
              className={`btn-icon btn-xs ${activeTool === tool.id ? 'active' : 'btn-ghost'}`}
              title={t(tool.titleKey)}
              aria-label={t(tool.titleKey)}
              aria-pressed={activeTool === tool.id}
              onClick={() => setActiveTool(tool.id)}
            >
              {tool.icon}
            </button>
          ))}
        </div>

        {selectedPropForPivot && (
          <div
            className="canvas-hud-chip mono"
            style={{ position: 'absolute', bottom: 10, left: 10, zIndex: 6, color: '#fbbf24' }}
          >
            <Target size={11} />
            {t('stage.pivotHint', {
              ax: selectedPropForPivot.anchor_x.toFixed(2),
              ay: selectedPropForPivot.anchor_y.toFixed(2),
            })}
          </div>
        )}

        {/* Non-destructive Motion Preview Indicator Banner */}
        {previewOverlay && previewOverlay.projectId === project.meta.project_id && (
          <div className="stage-motion-preview-banner" data-testid="stage-motion-preview-banner">
            <span>{t('motionExec.stagePreviewBanner')}</span>
          </div>
        )}

        {/* PixiJS WebGL Canvas Host with Viewport Pan & Zoom transform */}
        <div
          ref={hostRef}
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transform: `translate(${viewportPanX}px, ${viewportPanY}px) scale(${vpScale})`,
            transformOrigin: 'center center',
            cursor: viewportCursor,
            imageRendering: previewResolution === 'full' ? 'auto' : 'pixelated',
          }}
        />
      </div>

      {/* Playback Transport Bar */}
      <div className="transport-bar">
        <div className="toolbar-group">
          <button
            className="btn-icon transport-secondary-btn"
            title={t('transport.jumpStart')}
            aria-label={t('transport.jumpStart')}
            onClick={() => {
              setPlaying(false);
              setCurrentFrame(0);
            }}
          >
            <SkipBack size={13} />
          </button>
          <button
            className="btn-icon"
            title={t('transport.prevFrame')}
            aria-label={t('transport.prevFrame')}
            onClick={() => stepFrames(-1, maxFrame)}
          >
            <ChevronLeft size={14} />
          </button>
          <button
            className="btn-primary"
            onClick={() => setPlaying(!isPlaying)}
            title={t('transport.playPauseTip')}
          >
            {isPlaying ? <Pause size={13} /> : <Play size={13} />}
            <span className="transport-btn-label">
              {isPlaying ? t('transport.pause') : t('transport.play')}
            </span>
          </button>
          <button
            className="btn-icon"
            onClick={handleStop}
            title={t('transport.stopTip')}
            aria-label={t('transport.stop')}
          >
            <Square size={11} fill="currentColor" />
          </button>
          <button
            className="btn-icon"
            title={t('transport.nextFrame')}
            aria-label={t('transport.nextFrame')}
            onClick={() => stepFrames(1, maxFrame)}
          >
            <ChevronRight size={14} />
          </button>
          <button
            className="btn-icon transport-secondary-btn"
            title={t('transport.jumpEnd')}
            aria-label={t('transport.jumpEnd')}
            onClick={() => {
              setPlaying(false);
              setCurrentFrame(maxFrame);
            }}
          >
            <SkipForward size={13} />
          </button>
          <button
            className={`btn-icon transport-secondary-btn ${loop ? 'active' : ''}`}
            title={t('transport.toggleLoop')}
            aria-label={t('transport.toggleLoop')}
            onClick={() => setLoop(!loop)}
          >
            <Repeat size={13} />
          </button>
        </div>

        <div className="timecode-pill" title={t('transport.timecodeTip')}>
          <span>{formatTimecode(frameToMs(currentFrame, fps))}</span>
          <span className="timecode-frame-part" style={{ color: 'var(--text-muted)' }}>|</span>
          <span className="timecode-frame-part">
            F{currentFrame} / {maxFrame}
          </span>
        </div>

        <div className="toolbar-group">
          <button
            className={selection.type === 'camera' ? 'active' : ''}
            onClick={() => setSelection({ type: 'camera', id: 'camera' })}
            title={t('stage.cameraBtnTitle')}
          >
            <Camera size={12} />
            <span className="transport-btn-label">{t('stage.cameraBtn')}</span>
          </button>
        </div>
      </div>
    </>
  );
}
