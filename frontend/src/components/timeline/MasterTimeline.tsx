import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  Box,
  Camera,
  Captions,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ClipboardPaste,
  Copy,
  CopyPlus,
  Diamond,
  Eye,
  EyeOff,
  Film,
  GripVertical,
  Image as ImageIcon,
  Lock,
  Merge,
  Mic,
  MoveHorizontal,
  Music,
  Plus,
  Repeat,
  Scissors,
  Trash2,
  Unlock,
  Users,
  Volume2,
  VolumeX,
  Waves,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { frameToMs, msToFrame } from '@/engine/evaluator';
import {
  applyMoveKeyframes,
  getKeyframeFrame,
  groupTrackKeyframesByFrame,
  type SummaryKeyframeCluster,
} from '@/engine/keyframeEngine';
import { groupKeyframesForTrack, type PropertyTrackGroup } from '@/engine/presets';
import { useI18n } from '@/i18n/useLocaleStore';
import { useJobStore } from '@/stores/useJobStore';
import { useLibraryStore } from '@/stores/useLibraryStore';
import { usePlaybackStore } from '@/stores/usePlaybackStore';
import { useProjectStore } from '@/stores/useProjectStore';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';
import type {
  EasingType,
  Keyframe,
  ProjectState,
  Scene,
  ScenePropInstance,
  SoundAsset,
  SoundEffectEvent,
  SubtitleSegment,
  TimelineTrack,
} from '@/types/models';
import { formatTimecode, WaveformCanvas } from '@/components/common/CommonUI';

interface SfxDragState {
  mode: 'move' | 'trim_start' | 'trim_end';
  eventId: string;
  startClientX: number;
  origStartMs: number;
  origEndMs: number;
  origTrimStartMs: number;
}

const AUDIO_TRACK_TYPES = new Set(['sfx', 'bgm', 'ambient', 'voice']);

interface KfDragState {
  movingIds: string[];
  clickedIds: string[];
  anchorKf: Keyframe;
  startClientX: number;
  origKeyframes: Keyframe[];
  preDragSnapshot: ProjectState;
  lastClampedDeltaFrames: number;
  lastReplacedCount: number;
  moved: boolean;
}

interface MarqueeBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const EASING_MENU_OPTIONS: EasingType[] = ['hold', 'linear', 'ease_in', 'ease_out', 'ease_in_out'];

export function MasterTimeline() {
  const { t } = useI18n();
  const project = useProjectStore((s) => s.project);
  const activeSceneId = useProjectStore((s) => s.activeSceneId);
  const selection = useProjectStore((s) => s.selection);
  const selectedKeyframeIds = useProjectStore((s) => s.selectedKeyframeIds);
  const copiedKeyframes = useProjectStore((s) => s.copiedKeyframes);
  const setSelection = useProjectStore((s) => s.setSelection);
  const setSelectedKeyframeIds = useProjectStore((s) => s.setSelectedKeyframeIds);
  const selectKeyframeRange = useProjectStore((s) => s.selectKeyframeRange);
  const clearKeyframeSelection = useProjectStore((s) => s.clearKeyframeSelection);
  const setActiveSceneId = useProjectStore((s) => s.setActiveSceneId);
  const setActiveShotId = useProjectStore((s) => s.setActiveShotId);
  const addEmptyLayer = useProjectStore((s) => s.addEmptyLayer);
  const addAudioTrack = useProjectStore((s) => s.addAudioTrack);
  const ensureSubtitleTrack = useProjectStore((s) => s.ensureSubtitleTrack);
  const updateTrack = useProjectStore((s) => s.updateTrack);
  const reorderSceneLayer = useProjectStore((s) => s.reorderSceneLayer);
  const moveSceneLayer = useProjectStore((s) => s.moveSceneLayer);
  const addSoundEvent = useProjectStore((s) => s.addSoundEvent);
  const updateSoundEvent = useProjectStore((s) => s.updateSoundEvent);
  const deleteSoundEvent = useProjectStore((s) => s.deleteSoundEvent);
  const selectedSubtitleIds = useProjectStore((s) => s.selectedSubtitleIds);
  const setSelectedSubtitleIds = useProjectStore((s) => s.setSelectedSubtitleIds);
  const addSubtitleSegment = useProjectStore((s) => s.addSubtitleSegment);
  const updateSubtitleSegment = useProjectStore((s) => s.updateSubtitleSegment);
  const deleteSubtitleSegments = useProjectStore((s) => s.deleteSubtitleSegments);
  const duplicateSubtitleSegment = useProjectStore((s) => s.duplicateSubtitleSegment);
  const splitSubtitleSegmentAt = useProjectStore((s) => s.splitSubtitleSegmentAt);
  const mergeSubtitleSegmentsByIds = useProjectStore((s) => s.mergeSubtitleSegmentsByIds);
  const moveSubtitleSegmentsByDelta = useProjectStore((s) => s.moveSubtitleSegmentsByDelta);
  const pushHistorySnapshot = useProjectStore((s) => s.pushHistorySnapshot);
  const previewKeyframesDuringDrag = useProjectStore((s) => s.previewKeyframesDuringDrag);
  const commitDragHistorySnapshot = useProjectStore((s) => s.commitDragHistorySnapshot);
  const moveKeyframesToFrame = useProjectStore((s) => s.moveKeyframesToFrame);
  const copySelectedKeyframes = useProjectStore((s) => s.copySelectedKeyframes);
  const pasteKeyframesAtTime = useProjectStore((s) => s.pasteKeyframesAtTime);
  const duplicateKeyframes = useProjectStore((s) => s.duplicateKeyframes);
  const setKeyframesEasing = useProjectStore((s) => s.setKeyframesEasing);
  const deleteKeyframes = useProjectStore((s) => s.deleteKeyframes);
  const setTotalDurationMs = useProjectStore((s) => s.setTotalDurationMs);

  const sounds = useLibraryStore((s) => s.sounds);
  const characters = useLibraryStore((s) => s.characters);
  const pushToast = useJobStore((s) => s.pushToast);

  const currentFrame = usePlaybackStore((s) => s.currentFrame);
  const setCurrentFrame = usePlaybackStore((s) => s.setCurrentFrame);
  const setPlaying = usePlaybackStore((s) => s.setPlaying);
  const pxPerSec = usePlaybackStore((s) => s.timelineZoomPxPerSec);
  const setTimelineZoom = usePlaybackStore((s) => s.setTimelineZoom);
  const snapEnabled = usePlaybackStore((s) => s.snapEnabled);
  const setSnapEnabled = usePlaybackStore((s) => s.setSnapEnabled);

  const timelineCollapsed = useWorkspaceStore((s) => s.timelineCollapsed);
  const setTimelineCollapsed = useWorkspaceStore((s) => s.setTimelineCollapsed);
  const openContextMenu = useWorkspaceStore((s) => s.openContextMenu);

  const [dragOverTrackId, setDragOverTrackId] = useState<string | null>(null);
  const [dragLayerRef, setDragLayerRef] = useState<{ sceneId: string; layerId: string } | null>(null);
  const [layerDropIndicator, setLayerDropIndicator] = useState<{
    trackId: string;
    position: 'before' | 'after';
  } | null>(null);
  const [showFutureTracks, setShowFutureTracks] = useState(false);
  const [expandedTracks, setExpandedTracks] = useState<Record<string, boolean>>({});
  const [marqueeBox, setMarqueeBox] = useState<MarqueeBox | null>(null);
  const [rangeFrames, setRangeFrames] = useState<{ from: number; to: number } | null>(null);
  const [dragDeltaHud, setDragDeltaHud] = useState<{ deltaFrames: number; replacedCount: number } | null>(null);

  const headersRef = useRef<HTMLDivElement | null>(null);
  const lanesRef = useRef<HTMLDivElement | null>(null);
  const lanesContentRef = useRef<HTMLDivElement | null>(null);
  const sfxDragRef = useRef<SfxDragState | null>(null);
  const kfDragRef = useRef<KfDragState | null>(null);
  const activePointerCleanupRef = useRef<(() => void) | null>(null);
  const suppressNextLaneClickRef = useRef(false);

  // Guarantee zero leaked window listeners on unmount
  useEffect(() => {
    return () => {
      activePointerCleanupRef.current?.();
      activePointerCleanupRef.current = null;
    };
  }, []);

  const selectedKfSet = useMemo(() => new Set(selectedKeyframeIds), [selectedKeyframeIds]);

  const soundsById = useMemo(() => {
    const map: Record<string, SoundAsset> = {};
    for (const s of sounds) map[s.sound_id] = s;
    return map;
  }, [sounds]);

  const partSlotNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const c of characters) {
      for (const p of c.parts) {
        map[p.slot_id] = p.name;
      }
    }
    return map;
  }, [characters]);

  // Map every visual layer target_ref_id to its owning Scene and Prop metadata
  const layerMetaByRefId = useMemo(() => {
    const map = new Map<
      string,
      { scene: Scene; kind: 'character' | 'prop' | 'empty'; prop?: ScenePropInstance }
    >();
    if (!project) return map;
    for (const sc of project.scenes) {
      for (const c of sc.characters) {
        map.set(c.instance_id, { scene: sc, kind: 'character' });
      }
      for (const p of sc.props) {
        const isEmpty = p.layer_kind === 'empty' || !p.asset_id;
        map.set(p.prop_instance_id, { scene: sc, kind: isEmpty ? 'empty' : 'prop', prop: p });
      }
    }
    return map;
  }, [project]);

  const overlappingEventIds = useMemo(() => {
    const ids = new Set<string>();
    if (!project) return ids;
    const evs = [...project.timeline.sound_events].sort((a, b) => a.start_ms - b.start_ms);
    for (let i = 0; i < evs.length; i++) {
      let concurrent = 1;
      for (let j = i + 1; j < evs.length; j++) {
        if (evs[j].start_ms < evs[i].end_ms) {
          concurrent += 1;
          if (evs[j].sound_id === evs[i].sound_id || concurrent > 3) {
            ids.add(evs[i].event_id);
            ids.add(evs[j].event_id);
          }
        }
      }
    }
    return ids;
  }, [project?.timeline.sound_events]);

  // Pre-compute track keyframes & property groups cleanly once per project render
  const sortedTracks = useMemo(() => {
    if (!project) return [];
    return [...project.timeline.tracks].sort((a, b) => a.order_index - b.order_index);
  }, [project?.timeline.tracks]);

  const lockedTrackIds = useMemo(() => {
    const set = new Set<string>();
    for (const trk of sortedTracks) {
      if (trk.locked) set.add(trk.track_id);
    }
    return set;
  }, [sortedTracks]);

  const trackKeyframesMap = useMemo(() => {
    const map = new Map<string, Keyframe[]>();
    if (!project) return map;
    for (const track of sortedTracks) {
      const matched = project.timeline.keyframes.filter((k) => {
        if (k.track_id === track.track_id) return true;
        if (track.track_type === 'camera' && k.target_type === 'camera') return true;
        if (track.track_type === 'character' && track.target_ref_id) {
          return k.target_id === track.target_ref_id || k.target_id.startsWith(`${track.target_ref_id}:`);
        }
        if (track.track_type === 'prop' && track.target_ref_id) {
          return k.target_id === track.target_ref_id;
        }
        return false;
      });
      map.set(track.track_id, matched);
    }
    return map;
  }, [project?.timeline.keyframes, sortedTracks]);

  if (!project) {
    return (
      <div className="timeline-toolbar">
        <span style={{ fontWeight: 600, fontSize: 11, color: 'var(--text-muted)' }}>
          {t('timeline.emptyProject')}
        </span>
      </div>
    );
  }

  const activeScene =
    project.scenes.find((s) => s.scene_id === activeSceneId) ?? project.scenes[0] ?? null;
  const fps = project.timeline.fps;
  const totalMs = project.timeline.total_duration_ms;
  const totalSec = Math.ceil(totalMs / 1000);
  const timelineWidthPx = Math.max(820, Math.ceil((totalMs / 1000) * pxPerSec) + 140);
  const playheadMs = frameToMs(currentFrame, fps);
  const playheadX = (playheadMs / 1000) * pxPerSec;

  const msToPx = (ms: number) => (ms / 1000) * pxPerSec;
  const pxToMs = (px: number) => {
    const raw = Math.max(0, (px / pxPerSec) * 1000);
    return snapEnabled ? Math.round(raw / 100) * 100 : Math.round(raw);
  };

  const getTrackKeyframes = (track: TimelineTrack): Keyframe[] =>
    trackKeyframesMap.get(track.track_id) ?? [];

  const getPropertyGroups = (track: TimelineTrack): PropertyTrackGroup[] => {
    if (track.track_type !== 'character' && track.track_type !== 'prop' && track.track_type !== 'camera') {
      return [];
    }
    return groupKeyframesForTrack(getTrackKeyframes(track), () => true);
  };

  const formatPropGroupLabel = (group: PropertyTrackGroup): string => {
    const propLabel = t(`timeline.propLabel.${group.property}`);
    if (group.partSlotId) {
      const partName = partSlotNames[group.partSlotId] ?? group.partSlotId;
      return `${partName} › ${propLabel}`;
    }
    return propLabel;
  };

  const isKeyframeLocked = (kf: Keyframe): boolean => {
    if (lockedTrackIds.has(kf.track_id)) return true;
    const ownerTrack = sortedTracks.find((tr) => {
      if (tr.track_id === kf.track_id) return true;
      if (kf.target_type === 'camera' && tr.track_type === 'camera') return true;
      if (kf.target_type === 'character_instance' && tr.target_ref_id === kf.target_id) return true;
      if (kf.target_type === 'character_part' && tr.target_ref_id === kf.target_id.split(':')[0]) return true;
      if (kf.target_type === 'prop' && tr.target_ref_id === kf.target_id) return true;
      return false;
    });
    return Boolean(ownerTrack?.locked);
  };

  const getFrameFromClientX = (clientX: number): number => {
    const el = lanesRef.current;
    const curProj = useProjectStore.getState().project;
    const curPxPerSec = usePlaybackStore.getState().timelineZoomPxPerSec;
    if (!el || !curProj) return 0;
    const rect = el.getBoundingClientRect();
    const x = Math.max(0, clientX - rect.left + el.scrollLeft);
    const ms = Math.min(curProj.timeline.total_duration_ms, (x / curPxPerSec) * 1000);
    return msToFrame(ms, curProj.timeline.fps);
  };

  const handleRulerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    activePointerCleanupRef.current?.();

    const startFrame = getFrameFromClientX(e.clientX);

    // Shift+Drag on Time Ruler selects all keyframes in [fromFrame, toFrame]
    if (e.shiftKey) {
      const initialRange = { from: startFrame, to: startFrame };
      setRangeFrames(initialRange);
      let latestRange = initialRange;

      const onMove = (ev: PointerEvent) => {
        const curFrame = getFrameFromClientX(ev.clientX);
        latestRange = {
          from: Math.min(startFrame, curFrame),
          to: Math.max(startFrame, curFrame),
        };
        setRangeFrames(latestRange);
      };

      const finish = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);
        activePointerCleanupRef.current = null;
        setRangeFrames(null);

        const st = useProjectStore.getState();
        const curProj = st.project;
        if (!curProj) return;
        const curFps = curProj.timeline.fps;
        const activeTargetId =
          st.selection.type === 'character' || st.selection.type === 'prop'
            ? st.selection.id
            : st.selection.type === 'camera'
              ? 'camera'
              : null;

        const matching = curProj.timeline.keyframes.filter((kf) => {
          if (isKeyframeLocked(kf)) return false;
          const f = getKeyframeFrame(kf, curFps);
          if (f < latestRange.from || f > latestRange.to) return false;
          if (activeTargetId) {
            if (activeTargetId === 'camera') return kf.target_type === 'camera';
            return kf.target_id === activeTargetId || kf.target_id.startsWith(`${activeTargetId}:`);
          }
          return true;
        });

        const ids = matching.map((k) => k.keyframe_id);
        st.setSelectedKeyframeIds(ids, ids[0] ?? null);
        pushToast(
          'info',
          t('timeline.kfRangeSelectedToast', {
            count: ids.length,
            from: latestRange.from,
            to: latestRange.to,
          }),
        );
      };

      activePointerCleanupRef.current = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);
        setRangeFrames(null);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', finish);
      return;
    }

    // Standard playhead scrub
    setPlaying(false);
    setCurrentFrame(startFrame);

    const onMove = (ev: PointerEvent) => {
      setPlaying(false);
      setCurrentFrame(getFrameFromClientX(ev.clientX));
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', cleanup);
      window.removeEventListener('pointercancel', cleanup);
      activePointerCleanupRef.current = null;
    };
    activePointerCleanupRef.current = cleanup;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', cleanup);
    window.addEventListener('pointercancel', cleanup);
  };

  const handleDropSfx = (trackId: string, locked: boolean, e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOverTrackId(null);
    if (locked) {
      pushToast('warning', t('timeline.lockedDropWarn'));
      return;
    }
    const soundId = e.dataTransfer.getData('application/x-amcs-sound-id');
    if (!soundId) return;
    const sound = soundsById[soundId];
    if (!sound) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const dropX = Math.max(0, e.clientX - rect.left);
    const startMs = pxToMs(dropX);
    const sceneAtDrop = project.scenes.find(
      (s) => startMs >= s.start_ms && startMs < s.start_ms + s.duration_ms,
    );
    addSoundEvent(trackId, sound, startMs, sceneAtDrop?.scene_id ?? null);
    pushToast(
      'success',
      t('timeline.droppedSfxToast', { name: sound.name, sec: (startMs / 1000).toFixed(2) }),
    );
  };

  const syncLayerSelectionFromKeyframe = (kf: Keyframe) => {
    if (kf.target_type === 'camera') {
      setSelection({ type: 'camera', id: 'camera' });
    } else if (kf.target_type === 'character_instance') {
      setSelection({ type: 'character', id: kf.target_id });
    } else if (kf.target_type === 'character_part') {
      const [charId, slotId] = kf.target_id.split(':');
      setSelection({ type: 'character', id: charId, subSlotId: slotId });
    } else if (kf.target_type === 'prop') {
      setSelection({ type: 'prop', id: kf.target_id });
    }
  };

  /**
   * Unified, atomic pointer drag handler for BOTH single property keyframes and
   * multi-property summary frame clusters.
   *
   * - Preserves original stable `keyframe_id`s (pure MOVE, never CREATE).
   * - Computes every preview frame cleanly from the pre-drag snapshot so passing
   *   over an intermediate keyframe mid-drag NEVER destroys it.
   * - Commits ONE single atomic Undo snapshot on pointerup (and ZERO on no-op or Escape).
   */
  const startKeyframesDrag = (
    clickedIds: string[],
    orderedScopeIds: string[],
    anchorKf: Keyframe,
    locked: boolean,
    e: React.PointerEvent<HTMLDivElement>,
  ) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    activePointerCleanupRef.current?.();

    const store = useProjectStore.getState();
    const currentSelected = store.selectedKeyframeIds;
    const isToggleMod = e.metaKey || e.ctrlKey;

    // 1. Ctrl/Cmd-click: toggle clicked keyframe(s) in multi-selection without accidental drag
    if (isToggleMod) {
      const selSet = new Set(currentSelected);
      const allSelected = clickedIds.every((id) => selSet.has(id));
      if (allSelected) {
        const remaining = currentSelected.filter((id) => !clickedIds.includes(id));
        setSelectedKeyframeIds(remaining);
      } else {
        setSelectedKeyframeIds([...currentSelected, ...clickedIds], clickedIds[0]);
        syncLayerSelectionFromKeyframe(anchorKf);
      }
      return;
    }

    // 2. Shift-click: extend range selection along ordered track/property keyframes
    if (e.shiftKey) {
      selectKeyframeRange(orderedScopeIds, clickedIds[clickedIds.length - 1]);
      if (clickedIds.length > 1) {
        const merged = Array.from(
          new Set([...useProjectStore.getState().selectedKeyframeIds, ...clickedIds]),
        );
        setSelectedKeyframeIds(merged);
      }
      syncLayerSelectionFromKeyframe(anchorKf);
      return;
    }

    // 3. Normal click/drag: if clicking inside an existing multi-selection, drag the whole group!
    syncLayerSelectionFromKeyframe(anchorKf);
    const clickedAlreadySelected =
      currentSelected.length > 1 && clickedIds.some((id) => currentSelected.includes(id));

    let dragCandidateIds: string[];
    if (clickedAlreadySelected) {
      dragCandidateIds = currentSelected;
    } else {
      setSelectedKeyframeIds(clickedIds, clickedIds[0]);
      dragCandidateIds = clickedIds;
    }

    if (locked) {
      setCurrentFrame(getKeyframeFrame(anchorKf, fps));
      return;
    }

    const curProj = useProjectStore.getState().project;
    if (!curProj) return;

    // Filter out any keyframes belonging to locked tracks
    const unlockedMovingIds = dragCandidateIds.filter((id) => {
      const kf = curProj.timeline.keyframes.find((k) => k.keyframe_id === id);
      return Boolean(kf && !isKeyframeLocked(kf));
    });

    if (unlockedMovingIds.length === 0) {
      setCurrentFrame(getKeyframeFrame(anchorKf, fps));
      return;
    }

    const pointerTarget = e.currentTarget;
    const pointerId = e.pointerId;
    try {
      pointerTarget.setPointerCapture?.(pointerId);
    } catch {
      // Synthetic pointer events in tests may not have an active pointerId
    }

    const preDragSnapshot = structuredClone(curProj);
    const origKeyframes = structuredClone(curProj.timeline.keyframes);

    kfDragRef.current = {
      movingIds: unlockedMovingIds,
      clickedIds,
      anchorKf,
      startClientX: e.clientX,
      origKeyframes,
      preDragSnapshot,
      lastClampedDeltaFrames: 0,
      lastReplacedCount: 0,
      moved: false,
    };

    const cleanupListeners = () => {
      try {
        if (pointerTarget.hasPointerCapture?.(pointerId)) {
          pointerTarget.releasePointerCapture(pointerId);
        }
      } catch {
        // Ignore release errors
      }
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKeyDown);
      activePointerCleanupRef.current = null;
      setDragDeltaHud(null);
    };

    const onMove = (me: PointerEvent) => {
      const drag = kfDragRef.current;
      if (!drag) return;
      const dx = me.clientX - drag.startClientX;
      if (!drag.moved && Math.abs(dx) < 3) return;
      drag.moved = true;

      const latestProj = useProjectStore.getState().project;
      const latestPxPerSec = usePlaybackStore.getState().timelineZoomPxPerSec;
      const latestFps = latestProj?.timeline.fps ?? fps;
      const latestTotalMs = latestProj?.timeline.total_duration_ms ?? totalMs;

      const rawDeltaFrames = Math.round((dx / Math.max(1, latestPxPerSec)) * latestFps);
      const res = applyMoveKeyframes(
        drag.origKeyframes,
        drag.movingIds,
        rawDeltaFrames,
        latestFps,
        latestTotalMs,
      );

      // Only update store & HUD when the integer frame delta actually changes (high 60fps performance)
      if (res.clampedDeltaFrames !== drag.lastClampedDeltaFrames) {
        drag.lastClampedDeltaFrames = res.clampedDeltaFrames;
        drag.lastReplacedCount = res.replacedIds.length;
        previewKeyframesDuringDrag(
          res.clampedDeltaFrames === 0 ? drag.origKeyframes : res.keyframes,
        );
        setDragDeltaHud({
          deltaFrames: res.clampedDeltaFrames,
          replacedCount: res.replacedIds.length,
        });
      }
    };

    const onCancel = () => {
      const drag = kfDragRef.current;
      kfDragRef.current = null;
      cleanupListeners();
      if (drag && drag.moved) {
        previewKeyframesDuringDrag(drag.origKeyframes);
      }
    };

    const onKeyDown = (ke: KeyboardEvent) => {
      if (ke.key === 'Escape') {
        ke.preventDefault();
        onCancel();
      }
    };

    const onUp = () => {
      const drag = kfDragRef.current;
      kfDragRef.current = null;
      cleanupListeners();
      if (!drag) return;

      const latestFps = useProjectStore.getState().project?.timeline.fps ?? fps;
      if (drag.moved) {
        if (drag.lastClampedDeltaFrames !== 0) {
          commitDragHistorySnapshot(drag.preDragSnapshot);
          if (drag.lastReplacedCount > 0) {
            pushToast(
              'info',
              t('timeline.kfCollisionReplacedToast', { count: drag.lastReplacedCount }),
            );
          }
        } else {
          // Dragged back to origin: restore exact pre-drag array and push ZERO history steps
          previewKeyframesDuringDrag(drag.origKeyframes);
        }
      } else {
        // Pure click without drag: narrow selection to clicked marker(s) & jump playhead to exact frame
        setSelectedKeyframeIds(drag.clickedIds, drag.clickedIds[0]);
        setCurrentFrame(getKeyframeFrame(drag.anchorKf, latestFps));
      }
    };

    activePointerCleanupRef.current = onCancel;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKeyDown);
  };

  /**
   * Handles empty lane interactions cleanly without interfering with keyframes or clips:
   * - Middle-mouse or Alt+Drag: smooth timeline viewport pan.
   * - Left-drag: Marquee box selection across tracks & property sub-tracks (Shift/Cmd/Ctrl = additive).
   * - Plain click without drag: clears keyframe selection cleanly.
   */
  const handleLanesPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (
      target.closest('[data-kf-marker]') ||
      target.closest('[data-audio-clip]') ||
      target.closest('[data-subtitle-clip]') ||
      target.closest('[data-ruler]') ||
      target.closest('button')
    ) {
      return;
    }

    const scrollEl = lanesRef.current;
    const contentEl = lanesContentRef.current;
    if (!scrollEl || !contentEl) return;

    // Alt+Drag or Middle-Mouse Drag => Timeline Viewport Pan
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      e.preventDefault();
      activePointerCleanupRef.current?.();
      const startX = e.clientX;
      const startY = e.clientY;
      const origLeft = scrollEl.scrollLeft;
      const origTop = scrollEl.scrollTop;

      const onMove = (me: PointerEvent) => {
        scrollEl.scrollLeft = Math.max(0, origLeft - (me.clientX - startX));
        scrollEl.scrollTop = Math.max(0, origTop - (me.clientY - startY));
      };
      const cleanup = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', cleanup);
        window.removeEventListener('pointercancel', cleanup);
        activePointerCleanupRef.current = null;
      };
      activePointerCleanupRef.current = cleanup;
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', cleanup);
      window.addEventListener('pointercancel', cleanup);
      return;
    }

    if (e.button !== 0) return;

    activePointerCleanupRef.current?.();
    const contentRect = contentEl.getBoundingClientRect();
    const startClientX = e.clientX;
    const startClientY = e.clientY;
    const startX = e.clientX - contentRect.left;
    const startY = e.clientY - contentRect.top;
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const baseSelection = additive ? [...useProjectStore.getState().selectedKeyframeIds] : [];
    let isDraggingMarquee = false;

    const updateMarqueeSelection = (curClientX: number, curClientY: number) => {
      const curRect = contentEl.getBoundingClientRect();
      const curX = curClientX - curRect.left;
      const curY = curClientY - curRect.top;
      setMarqueeBox({
        x1: Math.min(startX, curX),
        y1: Math.min(startY, curY),
        x2: Math.max(startX, curX),
        y2: Math.max(startY, curY),
      });

      const minCX = Math.min(startClientX, curClientX);
      const maxCX = Math.max(startClientX, curClientX);
      const minCY = Math.min(startClientY, curClientY);
      const maxCY = Math.max(startClientY, curClientY);

      const hitIds = new Set<string>(baseSelection);
      const markers = contentEl.querySelectorAll<HTMLElement>('[data-kf-marker]');
      markers.forEach((el) => {
        const r = el.getBoundingClientRect();
        const intersects = r.right >= minCX && r.left <= maxCX && r.bottom >= minCY && r.top <= maxCY;
        if (intersects) {
          const raw = el.dataset.kfIds || '';
          for (const id of raw.split(',')) {
            if (id) hitIds.add(id);
          }
        }
      });
      setSelectedKeyframeIds([...hitIds]);
    };

    const onMove = (me: PointerEvent) => {
      if (!isDraggingMarquee && Math.hypot(me.clientX - startClientX, me.clientY - startClientY) < 4) {
        return;
      }
      isDraggingMarquee = true;
      suppressNextLaneClickRef.current = true;
      updateMarqueeSelection(me.clientX, me.clientY);
    };

    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', cleanup);
      activePointerCleanupRef.current = null;
      setMarqueeBox(null);
    };

    const onUp = () => {
      cleanup();
      if (isDraggingMarquee) {
        window.setTimeout(() => {
          suppressNextLaneClickRef.current = false;
        }, 50);
      } else if (!additive) {
        clearKeyframeSelection();
      }
    };

    activePointerCleanupRef.current = cleanup;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', cleanup);
  };

  const handleLanesWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const step = e.deltaY < 0 ? 12 : -12;
      setTimelineZoom(pxPerSec + step);
    } else if (e.shiftKey && Math.abs(e.deltaY) > 0 && lanesRef.current) {
      e.preventDefault();
      lanesRef.current.scrollLeft += e.deltaY;
    }
  };

  const startSfxClipDrag = (
    ev: SoundEffectEvent,
    locked: boolean,
    mode: 'move' | 'trim_start' | 'trim_end',
    e: React.PointerEvent,
  ) => {
    if (e.button !== 0) return;
    e.stopPropagation();

    if (e.shiftKey && selection.type === 'sfx_event') {
      const existing = new Set(selection.multiIds ?? (selection.id ? [selection.id] : []));
      if (existing.has(ev.event_id)) existing.delete(ev.event_id);
      else existing.add(ev.event_id);
      setSelection({ type: 'sfx_event', id: ev.event_id, multiIds: [...existing] });
      return;
    }

    setSelection({ type: 'sfx_event', id: ev.event_id, multiIds: [ev.event_id] });
    if (locked) return;

    activePointerCleanupRef.current?.();
    pushHistorySnapshot();
    sfxDragRef.current = {
      mode,
      eventId: ev.event_id,
      startClientX: e.clientX,
      origStartMs: ev.start_ms,
      origEndMs: ev.end_ms,
      origTrimStartMs: ev.trim_start_ms,
    };

    const onMove = (me: PointerEvent) => {
      const drag = sfxDragRef.current;
      if (!drag) return;
      const curPx = usePlaybackStore.getState().timelineZoomPxPerSec;
      const curSnap = usePlaybackStore.getState().snapEnabled;
      const dx = me.clientX - drag.startClientX;
      const deltaMs = (dx / curPx) * 1000;
      const snappedDelta = curSnap ? Math.round(deltaMs / 100) * 100 : Math.round(deltaMs);

      if (drag.mode === 'move') {
        const dur = drag.origEndMs - drag.origStartMs;
        const nextStart = Math.max(0, drag.origStartMs + snappedDelta);
        updateSoundEvent(drag.eventId, { start_ms: nextStart, end_ms: nextStart + dur }, false);
      } else if (drag.mode === 'trim_start') {
        // Clamp left trim so clip >= 150ms, start_ms >= 0, and trim_start_ms >= 0
        const minDelta = Math.max(-drag.origStartMs, -drag.origTrimStartMs);
        const maxDelta = drag.origEndMs - drag.origStartMs - 150;
        const clamped = Math.max(minDelta, Math.min(maxDelta, snappedDelta));
        updateSoundEvent(
          drag.eventId,
          {
            start_ms: drag.origStartMs + clamped,
            trim_start_ms: Math.max(0, drag.origTrimStartMs + clamped),
          },
          false,
        );
      } else {
        const nextEnd = Math.max(drag.origStartMs + 150, drag.origEndMs + snappedDelta);
        updateSoundEvent(drag.eventId, { end_ms: nextEnd }, false);
      }
    };

    const onUp = () => {
      sfxDragRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      activePointerCleanupRef.current = null;
    };

    activePointerCleanupRef.current = onUp;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const startSubtitleDrag = (
    seg: SubtitleSegment,
    locked: boolean,
    mode: 'move' | 'trim_start' | 'trim_end',
    e: React.PointerEvent,
  ) => {
    if (e.button !== 0) return;
    e.stopPropagation();

    const curSel = useProjectStore.getState().selectedSubtitleIds;
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      const next = new Set(curSel);
      if (next.has(seg.subtitle_id)) next.delete(seg.subtitle_id);
      else next.add(seg.subtitle_id);
      setSelectedSubtitleIds([...next], seg.subtitle_id);
      setCurrentFrame(msToFrame(seg.start_ms, fps));
      return;
    }

    const movingIds =
      mode === 'move' && curSel.length > 1 && curSel.includes(seg.subtitle_id)
        ? [...curSel]
        : [seg.subtitle_id];
    setSelectedSubtitleIds(movingIds, seg.subtitle_id);
    if (useWorkspaceStore.getState().rightCollapsed) {
      useWorkspaceStore.getState().setRightCollapsed(false);
    }
    setPlaying(false);
    setCurrentFrame(msToFrame(seg.start_ms, fps));

    if (locked) return;

    activePointerCleanupRef.current?.();
    const startClientX = e.clientX;
    const origStartMs = seg.start_ms;
    const origEndMs = seg.end_ms;
    let moved = false;
    let lastDeltaApplied = 0;

    const onMove = (me: PointerEvent) => {
      const dx = me.clientX - startClientX;
      if (!moved && Math.abs(dx) < 3) return;
      if (!moved) {
        moved = true;
        pushHistorySnapshot();
      }
      const curPx = usePlaybackStore.getState().timelineZoomPxPerSec;
      const curSnap = usePlaybackStore.getState().snapEnabled;
      const rawDelta = (dx / Math.max(1, curPx)) * 1000;
      const snappedDelta = curSnap ? Math.round(rawDelta / 100) * 100 : Math.round(rawDelta);

      if (mode === 'move') {
        const step = snappedDelta - lastDeltaApplied;
        if (step !== 0) {
          moveSubtitleSegmentsByDelta(movingIds, step, false);
          lastDeltaApplied = snappedDelta;
        }
      } else if (mode === 'trim_start') {
        const nextStart = Math.max(0, Math.min(origEndMs - 150, origStartMs + snappedDelta));
        updateSubtitleSegment(seg.subtitle_id, { start_ms: nextStart, timing_source: 'manual' }, false);
      } else {
        const nextEnd = Math.max(origStartMs + 150, origEndMs + snappedDelta);
        updateSubtitleSegment(seg.subtitle_id, { end_ms: nextEnd, timing_source: 'manual' }, false);
      }
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      activePointerCleanupRef.current = null;
    };

    activePointerCleanupRef.current = onUp;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const openSubtitleContextMenu = (seg: SubtitleSegment, locked: boolean, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const curSel = useProjectStore.getState().selectedSubtitleIds;
    const isPartOfMulti = curSel.length > 1 && curSel.includes(seg.subtitle_id);
    const targetIds = isPartOfMulti ? curSel : [seg.subtitle_id];
    if (!isPartOfMulti) {
      setSelectedSubtitleIds([seg.subtitle_id], seg.subtitle_id);
    }

    const allSegs = project.subtitles?.segments ?? [];
    const idx = allSegs.findIndex((s) => s.subtitle_id === seg.subtitle_id);
    const nextSeg = idx >= 0 && idx + 1 < allSegs.length ? allSegs[idx + 1] : null;
    const mergeIds = targetIds.length >= 2 ? targetIds : nextSeg ? [seg.subtitle_id, nextSeg.subtitle_id] : [];

    openContextMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          id: 'sub-jump',
          label: t('sub.jumpToStart'),
          onSelect: () => {
            setPlaying(false);
            setCurrentFrame(msToFrame(seg.start_ms, fps));
          },
        },
        {
          id: 'sub-split',
          label: t('sub.split'),
          icon: <Scissors size={12} />,
          disabled: locked || seg.end_ms - seg.start_ms < 200,
          onSelect: () => {
            const splitMs =
              playheadMs > seg.start_ms + 80 && playheadMs < seg.end_ms - 80 ? playheadMs : undefined;
            splitSubtitleSegmentAt(seg.subtitle_id, splitMs);
          },
        },
        {
          id: 'sub-merge',
          label: targetIds.length >= 2 ? t('sub.mergeSelected', { count: targetIds.length }) : t('sub.mergeWithNext'),
          icon: <Merge size={12} />,
          disabled: locked || mergeIds.length < 2,
          onSelect: () => mergeSubtitleSegmentsByIds(mergeIds),
        },
        {
          id: 'sub-dup',
          label: t('sub.duplicate'),
          icon: <Copy size={12} />,
          disabled: locked,
          onSelect: () => duplicateSubtitleSegment(seg.subtitle_id),
        },
        {
          id: 'sub-toggle',
          label: seg.enabled ? t('sub.hideSegment') : t('sub.showSegment'),
          icon: seg.enabled ? <EyeOff size={12} /> : <Eye size={12} />,
          disabled: locked,
          onSelect: () => updateSubtitleSegment(seg.subtitle_id, { enabled: !seg.enabled }),
        },
        { id: 'sub-div', divider: true },
        {
          id: 'sub-del',
          label: targetIds.length > 1 ? t('sub.deleteSelected', { count: targetIds.length }) : t('common.delete'),
          icon: <Trash2 size={12} />,
          danger: true,
          disabled: locked,
          onSelect: () => deleteSubtitleSegments(targetIds),
        },
      ],
    });
  };

  const openVisualTrackContextMenu = (track: TimelineTrack, e: React.MouseEvent) => {
    if (!track.target_ref_id) return;
    const meta = layerMetaByRefId.get(track.target_ref_id);
    if (!meta) return;
    e.preventDefault();
    e.stopPropagation();
    const selType = track.track_type === 'character' ? 'character' : 'prop';
    setSelection({ type: selType, id: track.target_ref_id });
    const isVisible = track.visible !== false;
    const trackKfs = getTrackKeyframes(track);

    openContextMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        ...(trackKfs.length > 0
          ? [
              {
                id: 'tl-sel-all-kfs',
                label: t('timeline.ctxSelectAllTrack'),
                icon: <Diamond size={12} />,
                onSelect: () => {
                  const ids = trackKfs.map((k) => k.keyframe_id);
                  setSelectedKeyframeIds(ids, ids[0] ?? null);
                },
              },
              { id: 'tl-div-0', divider: true },
            ]
          : []),
        {
          id: 'tl-front',
          label: t('layer.bringToFront'),
          icon: <ArrowUpToLine size={12} />,
          onSelect: () => moveSceneLayer(meta.scene.scene_id, track.target_ref_id!, 'front'),
        },
        {
          id: 'tl-up',
          label: t('layer.moveUp'),
          icon: <ArrowUp size={12} />,
          onSelect: () => moveSceneLayer(meta.scene.scene_id, track.target_ref_id!, 'up'),
        },
        {
          id: 'tl-down',
          label: t('layer.moveDown'),
          icon: <ArrowDown size={12} />,
          onSelect: () => moveSceneLayer(meta.scene.scene_id, track.target_ref_id!, 'down'),
        },
        {
          id: 'tl-back',
          label: t('layer.sendToBack'),
          icon: <ArrowDownToLine size={12} />,
          onSelect: () => moveSceneLayer(meta.scene.scene_id, track.target_ref_id!, 'back'),
        },
        { id: 'tl-div', divider: true },
        {
          id: 'tl-vis',
          label: isVisible ? t('layer.hideLayer') : t('layer.showLayer'),
          icon: isVisible ? <EyeOff size={12} /> : <Eye size={12} />,
          onSelect: () => updateTrack(track.track_id, { visible: !isVisible }),
        },
        {
          id: 'tl-lock',
          label: track.locked ? t('layer.unlockLayer') : t('layer.lockLayer'),
          icon: track.locked ? <Unlock size={12} /> : <Lock size={12} />,
          onSelect: () => updateTrack(track.track_id, { locked: !track.locked }),
        },
      ],
    });
  };

  const openSfxContextMenu = (ev: SoundEffectEvent, locked: boolean, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setSelection({ type: 'sfx_event', id: ev.event_id, multiIds: [ev.event_id] });
    const sound = soundsById[ev.sound_id];
    openContextMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          id: 'dup-sfx',
          label: t('timeline.ctxDuplicateSfx'),
          icon: <Copy size={12} />,
          disabled: locked || !sound,
          onSelect: () => {
            if (sound) addSoundEvent(ev.track_id, sound, ev.end_ms + 100, ev.source_scene_id);
          },
        },
        {
          id: 'reset-fades',
          label: t('timeline.ctxResetAudio'),
          disabled: locked,
          onSelect: () =>
            updateSoundEvent(ev.event_id, { speed: 1.0, fade_in_ms: 0, fade_out_ms: 0 }),
        },
        { id: 'div-s', divider: true },
        {
          id: 'del-sfx',
          label: t('timeline.ctxDeleteSfx'),
          icon: <Trash2 size={12} />,
          danger: true,
          disabled: locked,
          onSelect: () => deleteSoundEvent(ev.event_id),
        },
      ],
    });
  };

  const openKeyframeContextMenu = (
    clickedIds: string[],
    anchorKf: Keyframe,
    trackAllIds: string[],
    propertyAllIds: string[] | null,
    locked: boolean,
    e: React.MouseEvent,
  ) => {
    e.preventDefault();
    e.stopPropagation();

    // Preserve active multi-selection if right-clicking a member of it; otherwise select clickedIds
    const curSel = useProjectStore.getState().selectedKeyframeIds;
    const isPartOfMulti = curSel.length > 1 && clickedIds.some((id) => curSel.includes(id));
    const targetIds = isPartOfMulti ? curSel : clickedIds;
    if (!isPartOfMulti) {
      setSelectedKeyframeIds(clickedIds, clickedIds[0]);
      syncLayerSelectionFromKeyframe(anchorKf);
    }

    const targetCount = targetIds.length;
    const currentNorm = anchorKf.easing === 'step' ? 'hold' : anchorKf.easing;

    openContextMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          id: 'jump-kf',
          label: t('timeline.ctxJumpKeyframe', {
            time: formatTimecode(anchorKf.time_ms),
            frame: getKeyframeFrame(anchorKf, fps),
          }),
          onSelect: () => setCurrentFrame(getKeyframeFrame(anchorKf, fps)),
        },
        {
          id: 'move-playhead-kf',
          label: t('timeline.ctxMoveToPlayhead'),
          icon: <MoveHorizontal size={12} />,
          disabled: locked,
          onSelect: () => {
            const res = moveKeyframesToFrame(targetIds, currentFrame);
            if (res.movedCount > 0) {
              pushToast(
                'info',
                t('timeline.kfMovedToPlayheadToast', {
                  count: res.movedCount,
                  frame: currentFrame,
                }),
              );
              if (res.replacedCount > 0) {
                pushToast(
                  'info',
                  t('timeline.kfCollisionReplacedToast', { count: res.replacedCount }),
                );
              }
            }
          },
        },
        { id: 'div-k0', divider: true },
        {
          id: 'copy-kf',
          label:
            targetCount > 1
              ? t('timeline.ctxCopySelected', { count: targetCount })
              : t('timeline.ctxCopyKeyframe'),
          icon: <Copy size={12} />,
          onSelect: () => {
            const n = copySelectedKeyframes(targetIds);
            if (n > 0) {
              pushToast('info', t('timeline.kfCopiedCountToast', { count: n }));
            }
          },
        },
        {
          id: 'dup-kf',
          label: t('timeline.ctxDuplicateKeyframes'),
          icon: <CopyPlus size={12} />,
          disabled: locked,
          onSelect: () => {
            const res = duplicateKeyframes(targetIds, 10);
            if (res.createdIds.length > 0) {
              pushToast('info', t('timeline.kfDuplicatedToast', { count: res.createdIds.length }));
            }
          },
        },
        ...(copiedKeyframes.length > 0
          ? [
              {
                id: 'paste-kf',
                label: t('timeline.ctxPasteCount', { count: copiedKeyframes.length }),
                icon: <ClipboardPaste size={12} />,
                disabled: locked,
                onSelect: () => {
                  const res = pasteKeyframesAtTime(playheadMs);
                  if (res.pastedIds.length > 0) {
                    pushToast(
                      'info',
                      t('timeline.kfPastedCountToast', {
                        count: res.pastedIds.length,
                        time: formatTimecode(playheadMs),
                      }),
                    );
                  }
                },
              },
            ]
          : []),
        { id: 'div-e1', divider: true },
        ...EASING_MENU_OPTIONS.map((ease) => ({
          id: `ease-${ease}`,
          label: `${t('timeline.ctxEasing', { mode: t(`easing.${ease}`) })}${targetCount === 1 && currentNorm === ease ? ' ✓' : ''}`,
          disabled: locked,
          onSelect: () => {
            setKeyframesEasing(targetIds, ease);
          },
        })),
        { id: 'div-sel', divider: true },
        {
          id: 'sel-all-track',
          label: t('timeline.ctxSelectAllTrack'),
          onSelect: () => setSelectedKeyframeIds(trackAllIds, trackAllIds[0] ?? null),
        },
        ...(propertyAllIds && propertyAllIds.length > 0
          ? [
              {
                id: 'sel-all-prop',
                label: t('timeline.ctxSelectAllProperty'),
                onSelect: () => setSelectedKeyframeIds(propertyAllIds, propertyAllIds[0] ?? null),
              },
            ]
          : []),
        {
          id: 'clear-sel-kf',
          label: t('timeline.ctxClearSelection'),
          onSelect: () => clearKeyframeSelection(),
        },
        { id: 'div-e2', divider: true },
        {
          id: 'del-kf',
          label:
            targetCount > 1
              ? t('timeline.ctxDeleteSelected', { count: targetCount })
              : t('timeline.ctxDeleteKeyframe'),
          icon: <Trash2 size={12} />,
          danger: true,
          disabled: locked,
          onSelect: () => deleteKeyframes(targetIds),
        },
      ],
    });
  };

  const openLaneContextMenu = (
    track: TimelineTrack,
    propertyGroup: PropertyTrackGroup | null,
    e: React.MouseEvent<HTMLDivElement>,
  ) => {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const clickMs = pxToMs(Math.max(0, e.clientX - rect.left));
    const trackKfs = getTrackKeyframes(track);
    const items = [];

    if (copiedKeyframes.length > 0 && !track.locked) {
      items.push(
        {
          id: 'paste-lane-playhead',
          label: t('timeline.ctxPasteCount', { count: copiedKeyframes.length }),
          icon: <ClipboardPaste size={12} />,
          onSelect: () => {
            const res = pasteKeyframesAtTime(playheadMs);
            if (res.pastedIds.length > 0) {
              pushToast(
                'info',
                t('timeline.kfPastedCountToast', {
                  count: res.pastedIds.length,
                  time: formatTimecode(playheadMs),
                }),
              );
            }
          },
        },
        {
          id: 'paste-lane-click',
          label: `${t('timeline.ctxPasteCount', { count: copiedKeyframes.length })} (${formatTimecode(clickMs)})`,
          icon: <ClipboardPaste size={12} />,
          onSelect: () => {
            const res = pasteKeyframesAtTime(clickMs);
            if (res.pastedIds.length > 0) {
              pushToast(
                'info',
                t('timeline.kfPastedCountToast', {
                  count: res.pastedIds.length,
                  time: formatTimecode(clickMs),
                }),
              );
            }
          },
        },
      );
    }

    if (trackKfs.length > 0) {
      if (items.length > 0) items.push({ id: 'div-l1', divider: true as const });
      items.push({
        id: 'lane-sel-track',
        label: t('timeline.ctxSelectAllTrack'),
        icon: <Diamond size={12} />,
        onSelect: () => {
          const ids = trackKfs.map((k) => k.keyframe_id);
          setSelectedKeyframeIds(ids, ids[0] ?? null);
        },
      });
    }

    if (propertyGroup && propertyGroup.keyframes.length > 0) {
      items.push({
        id: 'lane-sel-prop',
        label: t('timeline.ctxSelectAllProperty'),
        icon: <Diamond size={12} />,
        onSelect: () => {
          const ids = propertyGroup.keyframes.map((k) => k.keyframe_id);
          setSelectedKeyframeIds(ids, ids[0] ?? null);
        },
      });
    }

    if (selectedKeyframeIds.length > 0) {
      items.push({
        id: 'lane-clear-sel',
        label: t('timeline.ctxClearSelection'),
        onSelect: () => clearKeyframeSelection(),
      });
    }

    if (items.length === 0) return;
    openContextMenu({ x: e.clientX, y: e.clientY, items });
  };

  /**
   * Renders a Summary Cluster Marker on the collapsed track lane (grouping ALL properties
   * at a single frame so dragging moves every property at that frame together cleanly).
   */
  const renderSummaryClusterMarker = (
    cluster: SummaryKeyframeCluster,
    allTrackClusters: SummaryKeyframeCluster[],
    track: TimelineTrack,
  ) => {
    const isCompound = cluster.keyframes.length > 1;
    const isSel = cluster.keyframeIds.some((id) => selectedKfSet.has(id));
    const anchorKf = cluster.keyframes[0];
    const orderedTrackIds = allTrackClusters.flatMap((c) => c.keyframeIds);

    const fill = isSel
      ? '#ffffff'
      : anchorKf.target_type === 'camera'
        ? 'var(--track-camera-accent)'
        : anchorKf.target_type === 'character_part'
          ? '#38bdf8'
          : 'var(--track-keyframe)';

    const tooltip = isCompound
      ? t('timeline.kfClusterTip', {
          frame: cluster.frameIndex,
          time: formatTimecode(cluster.timeMs),
          count: cluster.keyframes.length,
          props: cluster.keyframes.map((k) => k.property).join(', '),
        })
      : t('timeline.kfTip', {
          prop: anchorKf.property,
          val: String(anchorKf.value),
          time: formatTimecode(anchorKf.time_ms),
          easing: t(`easing.${anchorKf.easing === 'step' ? 'hold' : anchorKf.easing}`),
        });

    return (
      <div
        key={`${track.track_id}:${cluster.clusterKey}`}
        data-kf-marker={isCompound ? 'cluster' : 'single'}
        data-kf-ids={cluster.keyframeIds.join(',')}
        data-kf-frame={cluster.frameIndex}
        data-track-id={track.track_id}
        className={`kf-marker-hit ${isSel ? 'selected' : ''} ${isCompound ? 'cluster' : ''}`}
        title={tooltip}
        onPointerDown={(e) =>
          startKeyframesDrag(cluster.keyframeIds, orderedTrackIds, anchorKf, track.locked, e)
        }
        onDoubleClick={(e) => {
          e.stopPropagation();
          if (isCompound) {
            setExpandedTracks((prev) => ({ ...prev, [track.track_id]: true }));
          }
          setCurrentFrame(cluster.frameIndex);
        }}
        onContextMenu={(e) =>
          openKeyframeContextMenu(
            cluster.keyframeIds,
            anchorKf,
            orderedTrackIds,
            null,
            track.locked,
            e,
          )
        }
        style={{
          left: msToPx(cluster.timeMs) - 8,
          top: 11,
          cursor: track.locked ? 'not-allowed' : 'ew-resize',
          zIndex: isSel ? 12 : 8,
        }}
      >
        <Diamond
          size={isSel ? 12 : 11}
          fill={fill}
          color={isSel ? 'var(--accent)' : '#0b0c0f'}
          strokeWidth={isSel ? 2.2 : 1.5}
        />
      </div>
    );
  };

  /**
   * Renders an individual property keyframe diamond inside an expanded Property Sub-Track.
   */
  const renderPropertyKeyframeDiamond = (
    kf: Keyframe,
    group: PropertyTrackGroup,
    track: TimelineTrack,
  ) => {
    const isSel = selectedKfSet.has(kf.keyframe_id);
    const frameIndex = getKeyframeFrame(kf, fps);
    const groupIds = group.keyframes.map((k) => k.keyframe_id);
    const trackIds = getTrackKeyframes(track).map((k) => k.keyframe_id);

    const fill = isSel
      ? '#ffffff'
      : kf.target_type === 'camera'
        ? 'var(--track-camera-accent)'
        : kf.target_type === 'character_part'
          ? '#38bdf8'
          : 'var(--track-keyframe)';

    return (
      <div
        key={kf.keyframe_id}
        data-kf-marker="single"
        data-kf-id={kf.keyframe_id}
        data-kf-ids={kf.keyframe_id}
        data-kf-frame={frameIndex}
        data-track-id={track.track_id}
        className={`kf-marker-hit ${isSel ? 'selected' : ''}`}
        title={t('timeline.kfTip', {
          prop: kf.property,
          val: String(kf.value),
          time: formatTimecode(kf.time_ms),
          easing: t(`easing.${kf.easing === 'step' ? 'hold' : kf.easing}`),
        })}
        onPointerDown={(e) =>
          startKeyframesDrag([kf.keyframe_id], groupIds, kf, track.locked, e)
        }
        onDoubleClick={(e) => {
          e.stopPropagation();
          setCurrentFrame(frameIndex);
        }}
        onContextMenu={(e) =>
          openKeyframeContextMenu([kf.keyframe_id], kf, trackIds, groupIds, track.locked, e)
        }
        style={{
          left: msToPx(kf.time_ms) - 8,
          top: 4,
          cursor: track.locked ? 'not-allowed' : 'ew-resize',
          zIndex: isSel ? 12 : 8,
        }}
      >
        <Diamond
          size={isSel ? 11 : 10}
          fill={fill}
          color={isSel ? 'var(--accent)' : '#0b0c0f'}
          strokeWidth={isSel ? 2.2 : 1.5}
        />
      </div>
    );
  };

  const tickStepSec = pxPerSec < 30 ? 5 : pxPerSec < 50 ? 2 : 1;
  const ticks: number[] = [];
  for (let s = 0; s <= totalSec + 1; s += tickStepSec) {
    ticks.push(s);
  }

  const selectedMulti = new Set(selection.multiIds ?? (selection.id ? [selection.id] : []));
  const selectedSubSet = new Set(selectedSubtitleIds);
  const subtitleSegments = project.subtitles?.segments ?? [];

  const futureTracks = [t('timeline.futureLipSync')];

  return (
    <>
      <div className="timeline-toolbar">
        <div className="toolbar-group" style={{ minWidth: 0, overflow: 'hidden' }}>
          <button
            className="btn-ghost btn-icon btn-xs"
            title={timelineCollapsed ? t('timeline.expand') : t('timeline.collapse')}
            aria-label={timelineCollapsed ? t('timeline.expand') : t('timeline.collapse')}
            onClick={() => setTimelineCollapsed(!timelineCollapsed)}
          >
            {timelineCollapsed ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
          <span
            style={{
              fontWeight: 600,
              fontSize: 11,
              color: 'var(--text-secondary)',
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              whiteSpace: 'nowrap',
            }}
          >
            {t('timeline.title')}
          </span>
          <span className="toolbar-divider" />
          {activeScene && (
            <button
              onClick={() => addEmptyLayer(activeScene.scene_id)}
              className="btn-xs"
              title={t('layer.addEmptyTip')}
            >
              <Plus size={11} /> {t('layer.addEmpty')}
            </button>
          )}
          <button onClick={() => addAudioTrack('sfx')} className="btn-xs" data-testid="timeline-add-sfx-btn">
            <Plus size={11} /> {t('timeline.addSfxTrack')}
          </button>
          <button onClick={() => addAudioTrack('bgm')} className="btn-xs" data-testid="timeline-add-bgm-btn">
            <Plus size={11} /> {t('timeline.addBgmTrack')}
          </button>
          <button onClick={() => addAudioTrack('ambient')} className="btn-xs" data-testid="timeline-add-ambient-btn">
            <Plus size={11} /> {t('timeline.addAmbientTrack')}
          </button>
          <button
            onClick={() => {
              ensureSubtitleTrack();
              addSubtitleSegment({
                start_ms: playheadMs,
                end_ms: playheadMs + 2500,
                text: t('sub.newDefaultText'),
              });
            }}
            className="btn-xs"
            data-testid="timeline-add-sub-btn"
          >
            <Captions size={11} /> {t('timeline.addSubtitle')}
          </button>
          <button
            className={`btn-xs ${snapEnabled ? 'active' : ''}`}
            onClick={() => setSnapEnabled(!snapEnabled)}
            title={t('timeline.snapTip')}
          >
            {t('timeline.snap')}
          </button>

          {/* Compact Multi-Keyframe Selection Action Strip (only visible when keyframes selected) */}
          {selectedKeyframeIds.length > 0 && (
            <div className="timeline-sel-bar" data-testid="timeline-selection-bar">
              <Diamond size={10} fill="var(--accent)" color="var(--accent)" />
              <span className="mono" style={{ fontWeight: 600 }}>
                {t('timeline.selectedCount', { count: selectedKeyframeIds.length })}
              </span>
              {dragDeltaHud && (
                <span className="mono" style={{ color: 'var(--track-keyframe)', fontWeight: 700 }}>
                  {dragDeltaHud.deltaFrames >= 0 ? `+${dragDeltaHud.deltaFrames}F` : `${dragDeltaHud.deltaFrames}F`}
                </span>
              )}
              <button
                type="button"
                className="btn-ghost btn-icon btn-xs"
                title={t('timeline.moveToPlayhead')}
                aria-label={t('timeline.moveToPlayhead')}
                onClick={() => {
                  const res = moveKeyframesToFrame(selectedKeyframeIds, currentFrame);
                  if (res.movedCount > 0) {
                    pushToast(
                      'info',
                      t('timeline.kfMovedToPlayheadToast', {
                        count: res.movedCount,
                        frame: currentFrame,
                      }),
                    );
                  }
                }}
              >
                <MoveHorizontal size={11} />
              </button>
              <button
                type="button"
                className="btn-ghost btn-icon btn-xs"
                title={t('timeline.duplicateSelected')}
                aria-label={t('timeline.duplicateSelected')}
                onClick={() => {
                  const res = duplicateKeyframes(selectedKeyframeIds, 10);
                  if (res.createdIds.length > 0) {
                    pushToast('info', t('timeline.kfDuplicatedToast', { count: res.createdIds.length }));
                  }
                }}
              >
                <CopyPlus size={11} />
              </button>
              <button
                type="button"
                className="btn-ghost btn-icon btn-xs"
                title={t('timeline.ctxDeleteSelected', { count: selectedKeyframeIds.length })}
                aria-label={t('timeline.ctxDeleteSelected', { count: selectedKeyframeIds.length })}
                onClick={() => deleteKeyframes(selectedKeyframeIds)}
              >
                <Trash2 size={11} />
              </button>
              <button
                type="button"
                className="btn-ghost btn-icon btn-xs"
                title={t('timeline.clearSelection')}
                aria-label={t('timeline.clearSelection')}
                onClick={clearKeyframeSelection}
              >
                <X size={11} />
              </button>
            </div>
          )}

          {selectedKeyframeIds.length === 0 && (
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 11,
                color: 'var(--text-muted)',
                marginLeft: 4,
                whiteSpace: 'nowrap',
              }}
            >
              <input
                type="checkbox"
                checked={showFutureTracks}
                onChange={(e) => setShowFutureTracks(e.target.checked)}
              />
              {t('timeline.showFuture')}
            </label>
          )}
        </div>

        <div className="toolbar-group" style={{ flexShrink: 0 }}>
          <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{t('timeline.duration')}:</span>
          <input
            type="number"
            aria-label={t('project.timelineDuration')}
            min={3}
            max={1800}
            step={5}
            value={Math.round(totalMs / 1000)}
            onChange={(e) => setTotalDurationMs(Math.max(3, Number(e.target.value) || 30) * 1000)}
            style={{ width: 58, padding: '2px 5px', fontSize: 11 }}
          />
          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>s</span>
          <span className="toolbar-divider" />
          <button
            className="btn-icon btn-xs"
            title={t('timeline.zoomOut')}
            aria-label={t('timeline.zoomOut')}
            onClick={() => setTimelineZoom(pxPerSec - 15)}
          >
            <ZoomOut size={12} />
          </button>
          <span
            className="mono"
            style={{ fontSize: 10, width: 42, textAlign: 'center', color: 'var(--text-secondary)' }}
          >
            {pxPerSec}px/s
          </span>
          <button
            className="btn-icon btn-xs"
            title={t('timeline.zoomIn')}
            aria-label={t('timeline.zoomIn')}
            onClick={() => setTimelineZoom(pxPerSec + 15)}
          >
            <ZoomIn size={12} />
          </button>
        </div>
      </div>

      {!timelineCollapsed && (
        <div className="timeline-body">
          {/* Left Track Headers */}
          <div
            ref={headersRef}
            className="timeline-headers"
            onScroll={(e) => {
              if (lanesRef.current && lanesRef.current.scrollTop !== e.currentTarget.scrollTop) {
                lanesRef.current.scrollTop = e.currentTarget.scrollTop;
              }
            }}
          >
            <div
              style={{
                height: 30,
                borderBottom: '1px solid var(--border-subtle)',
                padding: '0 8px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                fontSize: 10,
                color: 'var(--accent-text)',
                position: 'sticky',
                top: 0,
                zIndex: 10,
                background: 'var(--surface-header)',
              }}
              className="mono"
            >
              <span>{formatTimecode(playheadMs)}</span>
              <span style={{ color: 'var(--text-muted)' }}>F{currentFrame}</span>
            </div>

            {sortedTracks.map((track) => {
              const isVisible = track.visible !== false;
              const isVisualLayer =
                (track.track_type === 'character' || track.track_type === 'prop') &&
                Boolean(track.target_ref_id);
              const layerMeta = track.target_ref_id
                ? layerMetaByRefId.get(track.target_ref_id)
                : undefined;
              const propGroups = getPropertyGroups(track);
              const isExpanded = Boolean(expandedTracks[track.track_id]);
              const canExpand = propGroups.length > 0;
              const isSelectedRow =
                (track.track_type === 'camera' && selection.type === 'camera') ||
                (isVisualLayer && selection.id === track.target_ref_id);
              const dropCls =
                layerDropIndicator?.trackId === track.track_id
                  ? layerDropIndicator.position === 'before'
                    ? 'layer-drop-before'
                    : 'layer-drop-after'
                  : '';

              return (
                <React.Fragment key={track.track_id}>
                  <div
                    draggable={isVisualLayer && Boolean(layerMeta)}
                    data-track-id={track.track_id}
                    data-target-ref-id={track.target_ref_id ?? ''}
                    className={`track-header-row ${track.locked ? 'locked' : ''} ${isSelectedRow ? 'selected-track' : ''} ${dropCls}`}
                    style={{ cursor: isVisualLayer || track.track_type === 'camera' ? 'pointer' : 'default' }}
                    onClick={() => {
                      if (track.track_type === 'camera') {
                        setSelection({ type: 'camera', id: 'camera' });
                      } else if (track.track_type === 'character' && track.target_ref_id) {
                        if (layerMeta) setActiveSceneId(layerMeta.scene.scene_id);
                        setSelection({ type: 'character', id: track.target_ref_id });
                      } else if (track.track_type === 'prop' && track.target_ref_id) {
                        if (layerMeta) setActiveSceneId(layerMeta.scene.scene_id);
                        setSelection({ type: 'prop', id: track.target_ref_id });
                      }
                    }}
                    onContextMenu={(e) => {
                      if (isVisualLayer) openVisualTrackContextMenu(track, e);
                    }}
                    onDragStart={(e) => {
                      if (!isVisualLayer || !layerMeta || !track.target_ref_id) return;
                      setDragLayerRef({
                        sceneId: layerMeta.scene.scene_id,
                        layerId: track.target_ref_id,
                      });
                      e.dataTransfer.setData('application/x-amcs-layer-id', track.target_ref_id);
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragEnd={() => {
                      setDragLayerRef(null);
                      setLayerDropIndicator(null);
                    }}
                    onDragOver={(e) => {
                      if (!dragLayerRef || !isVisualLayer || !layerMeta || !track.target_ref_id) return;
                      if (
                        dragLayerRef.sceneId !== layerMeta.scene.scene_id ||
                        dragLayerRef.layerId === track.target_ref_id
                      ) {
                        return;
                      }
                      e.preventDefault();
                      const rect = e.currentTarget.getBoundingClientRect();
                      const pos = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
                      setLayerDropIndicator({ trackId: track.track_id, position: pos });
                    }}
                    onDrop={(e) => {
                      if (!dragLayerRef || !isVisualLayer || !layerMeta || !track.target_ref_id) return;
                      e.preventDefault();
                      const pos = layerDropIndicator?.position ?? 'before';
                      const srcId = dragLayerRef.layerId;
                      setDragLayerRef(null);
                      setLayerDropIndicator(null);
                      if (srcId !== track.target_ref_id) {
                        const ok = reorderSceneLayer(
                          layerMeta.scene.scene_id,
                          srcId,
                          track.target_ref_id,
                          pos,
                        );
                        if (!ok) {
                          pushToast('info', t('layer.cannotReorderChild'));
                        }
                      }
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, flex: 1 }}>
                      {isVisualLayer && (
                        <GripVertical
                          size={10}
                          style={{ flexShrink: 0, color: 'var(--text-muted)', cursor: 'grab' }}
                        />
                      )}
                      {canExpand ? (
                        <button
                          className="btn-ghost btn-icon btn-xs"
                          style={{ width: 16, height: 16, padding: 0 }}
                          title={isExpanded ? t('timeline.collapseProps') : t('timeline.expandProps')}
                          aria-label={isExpanded ? t('timeline.collapseProps') : t('timeline.expandProps')}
                          onClick={(e) => {
                            e.stopPropagation();
                            setExpandedTracks((prev) => ({
                              ...prev,
                              [track.track_id]: !prev[track.track_id],
                            }));
                          }}
                        >
                          {isExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                        </button>
                      ) : (
                        <span style={{ width: 4 }} />
                      )}
                      {track.track_type === 'scene' && <Film size={12} color="var(--text-secondary)" />}
                      {track.track_type === 'camera' && <Camera size={12} color="var(--track-camera-accent)" />}
                      {track.track_type === 'character' && <Users size={12} color="var(--track-char-text)" />}
                      {track.track_type === 'prop' &&
                        (layerMeta?.kind === 'empty' ? (
                          <Box size={12} color="var(--text-muted)" />
                        ) : (
                          <ImageIcon size={12} color="var(--accent-text)" />
                        ))}
                      {track.track_type === 'subtitle' && <Captions size={12} color="#fbbf24" />}
                      {track.track_type === 'voice' && <Mic size={12} color="#38bdf8" />}
                      {track.track_type === 'sfx' && <Volume2 size={12} color="var(--track-sfx-wave)" />}
                      {track.track_type === 'bgm' && <Music size={12} color="#818cf8" />}
                      {track.track_type === 'ambient' && <Waves size={12} color="#2dd4bf" />}
                      <span
                        style={{
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          fontWeight: isSelectedRow ? 600 : 500,
                          opacity: isVisible ? 1 : 0.45,
                        }}
                        title={track.name}
                      >
                        {track.name}
                      </span>
                      {layerMeta?.kind === 'empty' && (
                        <span className="tag-pill" style={{ fontSize: 8, padding: '0 4px', flexShrink: 0 }}>
                          {t('layer.emptyBadge')}
                        </span>
                      )}
                    </div>

                    <div
                      style={{ display: 'flex', gap: 2, alignItems: 'center' }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {(isVisualLayer || track.track_type === 'subtitle') && (
                        <button
                          className={`btn-ghost btn-icon btn-xs ${!isVisible ? 'btn-danger' : ''}`}
                          title={isVisible ? t('timeline.hideTrack') : t('timeline.showTrack')}
                          aria-label={isVisible ? t('timeline.hideTrack') : t('timeline.showTrack')}
                          onClick={() => updateTrack(track.track_id, { visible: !isVisible })}
                        >
                          {isVisible ? <Eye size={11} /> : <EyeOff size={11} />}
                        </button>
                      )}

                      {AUDIO_TRACK_TYPES.has(track.track_type) && (
                        <>
                          <button
                            className={`btn-icon btn-xs ${track.muted ? 'btn-danger' : 'btn-ghost'}`}
                            title={t('timeline.muteTrack')}
                            aria-label={t('timeline.muteTrack')}
                            onClick={() => updateTrack(track.track_id, { muted: !track.muted })}
                          >
                            {track.muted ? <VolumeX size={10} /> : 'M'}
                          </button>
                          <button
                            className={`btn-icon btn-xs ${track.solo ? 'active' : 'btn-ghost'}`}
                            title={t('timeline.soloTrack')}
                            aria-label={t('timeline.soloTrack')}
                            onClick={() => updateTrack(track.track_id, { solo: !track.solo })}
                          >
                            S
                          </button>
                        </>
                      )}

                      <button
                        className={`btn-icon btn-xs ${track.locked ? 'active' : 'btn-ghost'}`}
                        title={track.locked ? t('timeline.unlockTrack') : t('timeline.lockTrack')}
                        aria-label={track.locked ? t('timeline.unlockTrack') : t('timeline.lockTrack')}
                        onClick={() => updateTrack(track.track_id, { locked: !track.locked })}
                      >
                        {track.locked ? <Lock size={10} /> : <Unlock size={10} />}
                      </button>
                    </div>
                  </div>

                  {/* Expanded Property Sub-Track Headers (click selects all keyframes of that property!) */}
                  {isExpanded &&
                    propGroups.map((group) => (
                      <div
                        key={group.key}
                        className="track-subrow-header"
                        style={{ cursor: 'pointer' }}
                        title={t('timeline.ctxSelectAllProperty')}
                        onClick={() => {
                          const ids = group.keyframes.map((k) => k.keyframe_id);
                          setSelectedKeyframeIds(ids, ids[0] ?? null);
                        }}
                      >
                        <span
                          style={{
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                          title={formatPropGroupLabel(group)}
                        >
                          {formatPropGroupLabel(group)}
                        </span>
                        <span className="mono" style={{ fontSize: 9, color: 'var(--text-muted)' }}>
                          {group.keyframes.length}◆
                        </span>
                      </div>
                    ))}
                </React.Fragment>
              );
            })}

            {showFutureTracks &&
              futureTracks.map((label) => (
                <div
                  key={label}
                  className="track-header-row locked"
                  style={{ opacity: 0.45 }}
                  title={t('timeline.futureRoadmapTip')}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <Lock size={10} /> {label}
                  </span>
                </div>
              ))}
          </div>

          {/* Right Scrollable Master Timeline Lanes */}
          <div
            ref={lanesRef}
            className="timeline-lanes-scroll"
            onWheel={handleLanesWheel}
            onScroll={(e) => {
              if (headersRef.current && headersRef.current.scrollTop !== e.currentTarget.scrollTop) {
                headersRef.current.scrollTop = e.currentTarget.scrollTop;
              }
            }}
          >
            <div
              ref={lanesContentRef}
              onPointerDown={handleLanesPointerDown}
              style={{ width: timelineWidthPx, position: 'relative', minHeight: '100%' }}
            >
              {/* Dual Time + Frame Ruler (supports Shift+Drag time-range keyframe selection) */}
              <div
                data-ruler="true"
                title={t('timeline.rulerShiftTip')}
                onPointerDown={handleRulerPointerDown}
                style={{
                  height: 30,
                  borderBottom: '1px solid var(--border-subtle)',
                  background: 'var(--surface-header)',
                  position: 'sticky',
                  top: 0,
                  zIndex: 15,
                  cursor: 'ew-resize',
                }}
              >
                {ticks.map((sec) => (
                  <div
                    key={sec}
                    className="mono"
                    style={{
                      position: 'absolute',
                      left: sec * pxPerSec,
                      top: 0,
                      height: '100%',
                      borderLeft: '1px solid var(--border-strong)',
                      paddingLeft: 4,
                      fontSize: 9,
                      color: 'var(--text-secondary)',
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'center',
                      lineHeight: 1.15,
                      pointerEvents: 'none',
                    }}
                  >
                    <span>
                      {String(Math.floor(sec / 60)).padStart(2, '0')}:
                      {String(sec % 60).padStart(2, '0')}
                    </span>
                    <span style={{ color: 'var(--text-muted)', fontSize: 8 }}>F{sec * fps}</span>
                  </div>
                ))}
              </div>

              {/* Active Track Lanes + Expandable Property Sub-Track Lanes */}
              {sortedTracks.map((track) => {
                const trackKeyframes = getTrackKeyframes(track);
                const summaryClusters = groupTrackKeyframesByFrame(trackKeyframes, fps);
                const propGroups = getPropertyGroups(track);
                const isExpanded = Boolean(expandedTracks[track.track_id]);
                const layerMeta = track.target_ref_id
                  ? layerMetaByRefId.get(track.target_ref_id)
                  : undefined;

                const trackClips =
                  track.track_type === 'character'
                    ? project.timeline.animation_clips.filter(
                        (c) => c.instance_id === track.target_ref_id,
                      )
                    : [];

                const isAudioTrack = AUDIO_TRACK_TYPES.has(track.track_type);
                const trackAudioEvents = isAudioTrack
                  ? project.timeline.sound_events.filter((e) => e.track_id === track.track_id)
                  : [];

                return (
                  <React.Fragment key={track.track_id}>
                    <div
                      data-lane-track-id={track.track_id}
                      data-lane-track-type={track.track_type}
                      className={`track-lane-row ${dragOverTrackId === track.track_id ? 'drop-active' : ''} ${track.locked ? 'locked-lane' : ''}`}
                      onContextMenu={(e) => {
                        if (!isAudioTrack && track.track_type !== 'scene' && track.track_type !== 'subtitle') {
                          openLaneContextMenu(track, null, e);
                        }
                      }}
                      onDragOver={(e) => {
                        if (isAudioTrack && !track.locked) {
                          e.preventDefault();
                          setDragOverTrackId(track.track_id);
                        }
                      }}
                      onDragLeave={() => {
                        if (dragOverTrackId === track.track_id) setDragOverTrackId(null);
                      }}
                      onDrop={(e) => {
                        if (isAudioTrack) handleDropSfx(track.track_id, track.locked, e);
                      }}
                    >
                      {/* Scene Clips */}
                      {track.track_type === 'scene' &&
                        project.scenes.map((sc) => (
                          <div
                            key={sc.scene_id}
                            onClick={() => {
                              if (suppressNextLaneClickRef.current) return;
                              setActiveSceneId(sc.scene_id);
                              setSelection({ type: 'scene', id: sc.scene_id });
                            }}
                            style={{
                              position: 'absolute',
                              left: msToPx(sc.start_ms),
                              width: Math.max(24, msToPx(sc.duration_ms) - 2),
                              top: 4,
                              height: 30,
                              background: 'var(--track-scene-bg)',
                              border:
                                selection.id === sc.scene_id
                                  ? '1.5px solid var(--accent)'
                                  : '1px solid var(--track-scene-border)',
                              borderRadius: 4,
                              padding: '0 7px',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              fontSize: 11,
                              fontWeight: 500,
                              overflow: 'hidden',
                              cursor: 'pointer',
                            }}
                          >
                            <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {sc.name}
                            </span>
                            <span className="mono" style={{ fontSize: 9, opacity: 0.72 }}>
                              {sc.shots && sc.shots.length > 0 ? `${sc.shots.length} shots` : sc.transition_in}
                            </span>
                            {/* Shot Boundary Sub-Segments (Phase 07 Batch 1) */}
                            {sc.shots && sc.shots.length > 0 && (
                              <div
                                style={{
                                  position: 'absolute',
                                  left: 0,
                                  right: 0,
                                  bottom: 0,
                                  height: 11,
                                  display: 'flex',
                                  pointerEvents: 'auto',
                                }}
                              >
                                {sc.shots.map((sh) => {
                                  const shotW = Math.max(12, msToPx(sh.duration_ms));
                                  const isSel = selection.type === 'shot' && selection.id === sh.shot_id;
                                  return (
                                    <div
                                      key={sh.shot_id}
                                      title={`#${sh.shot_order} ${sh.title} (${(sh.duration_ms / 1000).toFixed(1)}s)`}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setActiveSceneId(sc.scene_id);
                                        setActiveShotId(sh.shot_id);
                                        setSelection({ type: 'shot', id: sh.shot_id });
                                        setCurrentFrame(msToFrame(sc.start_ms + sh.start_ms, fps));
                                      }}
                                      style={{
                                        width: shotW,
                                        height: '100%',
                                        fontSize: 8,
                                        lineHeight: '11px',
                                        padding: '0 3px',
                                        borderRight: '1px solid rgba(255,255,255,0.22)',
                                        background: isSel
                                          ? 'rgba(124,108,246,0.55)'
                                          : 'rgba(15,23,42,0.45)',
                                        color: '#e2e8f0',
                                        overflow: 'hidden',
                                        whiteSpace: 'nowrap',
                                        textOverflow: 'ellipsis',
                                        flexShrink: 0,
                                      }}
                                    >
                                      #{sh.shot_order} {sh.title}
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        ))}

                      {/* Prop / Empty Layer Visual Span Bar */}
                      {track.track_type === 'prop' && layerMeta && track.target_ref_id && (
                        <div
                          onClick={() => {
                            if (suppressNextLaneClickRef.current) return;
                            setActiveSceneId(layerMeta.scene.scene_id);
                            setSelection({ type: 'prop', id: track.target_ref_id! });
                          }}
                          style={{
                            position: 'absolute',
                            left: msToPx(layerMeta.scene.start_ms),
                            width: Math.max(36, msToPx(layerMeta.scene.duration_ms) - 2),
                            top: 6,
                            height: 26,
                            background:
                              layerMeta.kind === 'empty'
                                ? 'rgba(100, 116, 139, 0.14)'
                                : 'rgba(124, 108, 246, 0.16)',
                            border:
                              selection.id === track.target_ref_id
                                ? '1.5px solid var(--accent)'
                                : layerMeta.kind === 'empty'
                                  ? '1px dashed rgba(148, 163, 184, 0.4)'
                                  : '1px solid rgba(124, 108, 246, 0.35)',
                            borderRadius: 4,
                            padding: '0 7px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            fontSize: 10,
                            color: 'var(--text-secondary)',
                            cursor: 'pointer',
                            overflow: 'hidden',
                            opacity: track.visible === false ? 0.35 : 1,
                          }}
                        >
                          <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: 500 }}>
                            {track.name}
                          </span>
                          {layerMeta.kind === 'empty' && (
                            <span style={{ fontSize: 9, opacity: 0.7 }}>({t('layer.emptyBadge')})</span>
                          )}
                        </div>
                      )}

                      {/* Character Fallback Span */}
                      {track.track_type === 'character' && trackClips.length === 0 && layerMeta && track.target_ref_id && (
                        <div
                          onClick={() => {
                            if (suppressNextLaneClickRef.current) return;
                            setActiveSceneId(layerMeta.scene.scene_id);
                            setSelection({ type: 'character', id: track.target_ref_id! });
                          }}
                          style={{
                            position: 'absolute',
                            left: msToPx(layerMeta.scene.start_ms),
                            width: Math.max(36, msToPx(layerMeta.scene.duration_ms) - 2),
                            top: 6,
                            height: 26,
                            background: 'var(--track-char-bg)',
                            border:
                              selection.id === track.target_ref_id
                                ? '1.5px solid var(--accent)'
                                : '1px solid var(--track-char-border)',
                            borderRadius: 4,
                            padding: '0 7px',
                            display: 'flex',
                            alignItems: 'center',
                            fontSize: 10,
                            cursor: 'pointer',
                            opacity: track.visible === false ? 0.35 : 1,
                          }}
                        >
                          <span style={{ color: 'var(--track-char-text)', fontWeight: 500 }}>
                            {track.name}
                          </span>
                        </div>
                      )}

                      {trackClips.map((clip) => (
                        <div
                          key={clip.clip_id}
                          onClick={() => {
                            if (suppressNextLaneClickRef.current) return;
                            if (track.target_ref_id) {
                              if (layerMeta) setActiveSceneId(layerMeta.scene.scene_id);
                              setSelection({ type: 'character', id: track.target_ref_id });
                            }
                          }}
                          style={{
                            position: 'absolute',
                            left: msToPx(clip.start_ms),
                            width: Math.max(24, msToPx(clip.end_ms - clip.start_ms) - 2),
                            top: 5,
                            height: 28,
                            background: 'var(--track-char-bg)',
                            border:
                              selection.id === track.target_ref_id
                                ? '1.5px solid var(--accent)'
                                : '1px solid var(--track-char-border)',
                            borderRadius: 4,
                            padding: '0 6px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            fontSize: 10,
                            cursor: 'pointer',
                            overflow: 'hidden',
                            opacity: track.visible === false ? 0.35 : 1,
                          }}
                        >
                          <span className="mono" style={{ fontWeight: 600, color: 'var(--track-char-text)' }}>
                            {clip.animation_state}
                          </span>
                          {clip.procedural.auto_blink && (
                            <span style={{ opacity: 0.72, fontSize: 9 }}>• {t('timeline.blinkTag')}</span>
                          )}
                          {clip.procedural.breathing && (
                            <span style={{ opacity: 0.72, fontSize: 9 }}>• {t('timeline.breathTag')}</span>
                          )}
                        </div>
                      ))}

                      {/* Summary Frame Cluster Markers (ONE marker per occupied frame — dragging moves ALL properties at that frame!) */}
                      {summaryClusters.map((cluster) =>
                        renderSummaryClusterMarker(cluster, summaryClusters, track),
                      )}

                      {/* Dedicated Subtitle Track Segments (drag move, bulk move, resize start/end, multi-select) */}
                      {track.track_type === 'subtitle' &&
                        subtitleSegments.map((seg) => {
                          const isSel = selectedSubSet.has(seg.subtitle_id);
                          const widthPx = Math.max(22, msToPx(seg.end_ms - seg.start_ms));
                          return (
                            <div
                              key={seg.subtitle_id}
                              data-subtitle-clip={seg.subtitle_id}
                              onPointerDown={(e) => startSubtitleDrag(seg, track.locked, 'move', e)}
                              onContextMenu={(e) => openSubtitleContextMenu(seg, track.locked, e)}
                              title={`${seg.speaker_name ? `${seg.speaker_name}: ` : ''}${seg.text} (${formatTimecode(seg.start_ms)} – ${formatTimecode(seg.end_ms)})`}
                              style={{
                                position: 'absolute',
                                left: msToPx(seg.start_ms),
                                width: widthPx,
                                top: 4,
                                height: 30,
                                background: seg.enabled
                                  ? 'rgba(245, 158, 11, 0.22)'
                                  : 'rgba(100, 116, 139, 0.16)',
                                border: isSel
                                  ? '1.5px solid #fbbf24'
                                  : seg.enabled
                                    ? '1px solid rgba(245, 158, 11, 0.52)'
                                    : '1px dashed rgba(148, 163, 184, 0.45)',
                                borderRadius: 4,
                                overflow: 'hidden',
                                cursor: track.locked ? 'not-allowed' : 'grab',
                                opacity: track.visible === false ? 0.3 : seg.enabled ? 1 : 0.55,
                                display: 'flex',
                                alignItems: 'center',
                              }}
                            >
                              {!track.locked && (
                                <div
                                  data-subtitle-trim-start={seg.subtitle_id}
                                  onPointerDown={(e) => startSubtitleDrag(seg, track.locked, 'trim_start', e)}
                                  title={t('sub.dragTrimStart')}
                                  style={{
                                    position: 'absolute',
                                    top: 0,
                                    left: 0,
                                    width: 6,
                                    height: '100%',
                                    cursor: 'ew-resize',
                                    background: 'rgba(251, 191, 36, 0.32)',
                                    zIndex: 4,
                                  }}
                                />
                              )}
                              <div
                                style={{
                                  padding: '0 9px',
                                  fontSize: 10,
                                  fontWeight: 600,
                                  color: seg.enabled ? '#fef3c7' : 'var(--text-muted)',
                                  whiteSpace: 'nowrap',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  pointerEvents: 'none',
                                  width: '100%',
                                }}
                              >
                                {seg.speaker_name ? `[${seg.speaker_name}] ` : ''}
                                {seg.text.replace(/\n/g, ' / ') || t('sub.emptyTextPlaceholder')}
                              </div>
                              {!track.locked && (
                                <div
                                  data-subtitle-trim-end={seg.subtitle_id}
                                  onPointerDown={(e) => startSubtitleDrag(seg, track.locked, 'trim_end', e)}
                                  title={t('sub.dragTrimEnd')}
                                  style={{
                                    position: 'absolute',
                                    top: 0,
                                    right: 0,
                                    width: 6,
                                    height: '100%',
                                    cursor: 'ew-resize',
                                    background: 'rgba(251, 191, 36, 0.32)',
                                    zIndex: 4,
                                  }}
                                />
                              )}
                            </div>
                          );
                        })}

                      {/* Audio Clips across ALL 4 tracks (Voice, SFX, BGM, Ambient) with Trim Start + Trim End + Fade Indicators */}
                      {trackAudioEvents.map((ev) => {
                        const sound = soundsById[ev.sound_id];
                        const hasOverlap = track.track_type === 'sfx' && overlappingEventIds.has(ev.event_id);
                        const isSelected = selection.type === 'sfx_event' && selectedMulti.has(ev.event_id);
                        const widthPx = Math.max(26, msToPx(ev.end_ms - ev.start_ms));
                        const fadeInPx = Math.min(widthPx * 0.45, msToPx(ev.fade_in_ms));
                        const fadeOutPx = Math.min(widthPx * 0.45, msToPx(ev.fade_out_ms));

                        const clipPalette: Record<string, { bg: string; border: string; wave: string; handle: string }> = {
                          voice: {
                            bg: 'rgba(56, 189, 248, 0.22)',
                            border: 'rgba(56, 189, 248, 0.55)',
                            wave: '#38bdf8',
                            handle: 'rgba(56, 189, 248, 0.38)',
                          },
                          bgm: {
                            bg: 'rgba(129, 140, 248, 0.22)',
                            border: 'rgba(129, 140, 248, 0.55)',
                            wave: '#818cf8',
                            handle: 'rgba(129, 140, 248, 0.38)',
                          },
                          ambient: {
                            bg: 'rgba(45, 212, 191, 0.18)',
                            border: 'rgba(45, 212, 191, 0.52)',
                            wave: '#2dd4bf',
                            handle: 'rgba(45, 212, 191, 0.36)',
                          },
                          sfx: {
                            bg: 'var(--track-sfx-bg)',
                            border: 'var(--track-sfx-border)',
                            wave: '#5eead4',
                            handle: 'rgba(94, 234, 212, 0.3)',
                          },
                        };
                        const pal = clipPalette[track.track_type] ?? clipPalette.sfx;

                        return (
                          <div
                            key={ev.event_id}
                            data-audio-clip={ev.event_id}
                            onPointerDown={(e) => startSfxClipDrag(ev, track.locked, 'move', e)}
                            onContextMenu={(e) => openSfxContextMenu(ev, track.locked, e)}
                            style={{
                              position: 'absolute',
                              left: msToPx(ev.start_ms),
                              width: widthPx,
                              top: 4,
                              height: 30,
                              background: pal.bg,
                              border: isSelected
                                ? '1.5px solid var(--accent-text)'
                                : hasOverlap
                                  ? '1px solid var(--warning)'
                                  : `1px solid ${pal.border}`,
                              borderRadius: 4,
                              overflow: 'hidden',
                              cursor: track.locked ? 'not-allowed' : 'grab',
                              opacity: track.muted ? 0.38 : 1,
                            }}
                          >
                            {sound && (
                              <div style={{ position: 'absolute', inset: 0, opacity: 0.55, pointerEvents: 'none' }}>
                                <WaveformCanvas
                                  peaks={sound.waveform_peaks}
                                  height={28}
                                  color={pal.wave}
                                />
                              </div>
                            )}
                            {/* Visual Fade-In / Fade-Out Ramp Hints */}
                            {fadeInPx > 2 && (
                              <div
                                style={{
                                  position: 'absolute',
                                  left: 0,
                                  top: 0,
                                  bottom: 0,
                                  width: fadeInPx,
                                  background: 'linear-gradient(135deg, rgba(11,12,15,0.68) 49%, transparent 51%)',
                                  pointerEvents: 'none',
                                  zIndex: 1,
                                }}
                              />
                            )}
                            {fadeOutPx > 2 && (
                              <div
                                style={{
                                  position: 'absolute',
                                  right: 0,
                                  top: 0,
                                  bottom: 0,
                                  width: fadeOutPx,
                                  background: 'linear-gradient(225deg, rgba(11,12,15,0.68) 49%, transparent 51%)',
                                  pointerEvents: 'none',
                                  zIndex: 1,
                                }}
                              />
                            )}
                            {!track.locked && (
                              <div
                                data-audio-trim-start={ev.event_id}
                                onPointerDown={(e) => startSfxClipDrag(ev, track.locked, 'trim_start', e)}
                                title={t('timeline.dragToTrimStart')}
                                style={{
                                  position: 'absolute',
                                  top: 0,
                                  left: 0,
                                  width: 6,
                                  height: '100%',
                                  cursor: 'ew-resize',
                                  background: pal.handle,
                                  zIndex: 4,
                                }}
                              />
                            )}
                            <div
                              style={{
                                position: 'relative',
                                zIndex: 2,
                                padding: '2px 10px 2px 9px',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                gap: 4,
                                fontSize: 10,
                                fontWeight: 600,
                                textShadow: '0 1px 2px #000',
                                pointerEvents: 'none',
                              }}
                            >
                              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {sound?.name ?? ev.sound_id}
                              </span>
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0 }}>
                                {ev.loop && <Repeat size={9} />}
                                {hasOverlap && <AlertTriangle size={11} color="var(--warning)" />}
                              </span>
                            </div>
                            {!track.locked && (
                              <div
                                data-audio-trim-end={ev.event_id}
                                onPointerDown={(e) => startSfxClipDrag(ev, track.locked, 'trim_end', e)}
                                title={t('timeline.dragToTrim')}
                                style={{
                                  position: 'absolute',
                                  top: 0,
                                  right: 0,
                                  width: 6,
                                  height: '100%',
                                  cursor: 'ew-resize',
                                  background: pal.handle,
                                  zIndex: 4,
                                }}
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>

                    {/* Expanded Property Sub-Track Lanes */}
                    {isExpanded &&
                      propGroups.map((group) => (
                        <div
                          key={group.key}
                          data-subrow-key={group.key}
                          className={`track-subrow-lane ${track.locked ? 'locked-lane' : ''}`}
                          onContextMenu={(e) => openLaneContextMenu(track, group, e)}
                        >
                          {group.keyframes.map((kf) => renderPropertyKeyframeDiamond(kf, group, track))}
                        </div>
                      ))}
                  </React.Fragment>
                );
              })}

              {showFutureTracks &&
                futureTracks.map((_, i) => (
                  <div key={i} className="track-lane-row locked-lane" style={{ opacity: 0.3 }} />
                ))}

              {/* Time-Range Selection Highlight Band (Shift+Drag on Ruler) */}
              {rangeFrames && (
                <div
                  className="timeline-range-overlay"
                  style={{
                    left: msToPx(frameToMs(rangeFrames.from, fps)),
                    width: Math.max(4, msToPx(frameToMs(rangeFrames.to - rangeFrames.from, fps))),
                  }}
                />
              )}

              {/* Marquee Selection Rectangle */}
              {marqueeBox && (
                <div
                  className="timeline-marquee-box"
                  style={{
                    left: marqueeBox.x1,
                    top: marqueeBox.y1,
                    width: Math.max(2, marqueeBox.x2 - marqueeBox.x1),
                    height: Math.max(2, marqueeBox.y2 - marqueeBox.y1),
                  }}
                />
              )}

              {/* Vertical Playhead Needle */}
              <div
                style={{
                  position: 'absolute',
                  left: playheadX,
                  top: 0,
                  bottom: 0,
                  width: 2,
                  background: 'var(--playhead-color)',
                  zIndex: 20,
                  pointerEvents: 'none',
                }}
              >
                <div
                  style={{
                    width: 10,
                    height: 10,
                    background: 'var(--playhead-color)',
                    transform: 'translateX(-4px) rotate(45deg)',
                    marginTop: -2,
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
