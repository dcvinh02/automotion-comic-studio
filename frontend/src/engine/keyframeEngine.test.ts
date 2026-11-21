import { beforeEach, describe, expect, it } from 'vitest';
import { evaluateStageAtFrame, msToFrame } from './evaluator';
import {
  applyMoveKeyframes,
  deduplicateKeyframesByChannelFrame,
  frameIndexToQuantizedMs,
  getKeyframeFrame,
  groupTrackKeyframesByFrame,
} from './keyframeEngine';
import { useProjectStore } from '@/stores/useProjectStore';
import type { Keyframe, ProjectState } from '@/types/models';

function createTimelineFixture(fps = 30): ProjectState {
  return {
    meta: {
      project_id: 'proj_p5_kf',
      name: 'Phase 05 Keyframe Repair Test',
      description: '',
      schema_version: '0.1.0',
      width: 1280,
      height: 720,
      fps,
      duration_ms: 5000,
      default_export_preset_id: 'preset_1080p_final',
      auto_save_enabled: false,
      created_at: '',
      updated_at: '',
    },
    scenes: [
      {
        scene_id: 'scene_1',
        project_id: 'proj_p5_kf',
        order_index: 0,
        name: 'Scene 1',
        start_ms: 0,
        duration_ms: 5000,
        background_asset_id: null,
        background_color: '#101216',
        transition_in: 'cut',
        transition_duration_ms: 0,
        camera_default: { x: 0, y: 0, zoom: 1, rotation_deg: 0 },
        characters: [],
        props: [
          {
            prop_instance_id: 'prop_box',
            asset_id: 'ast_box',
            layer_kind: 'prop',
            name: 'Box',
            z_index: 10,
            anchor_x: 0.5,
            anchor_y: 0.5,
            visible: true,
            locked: false,
            parent_id: null,
            transform: { x: 100, y: 200, rotation_deg: 0, scale_x: 1, scale_y: 1, opacity: 1 },
          },
        ],
      },
    ],
    timeline: {
      project_id: 'proj_p5_kf',
      fps,
      total_duration_ms: 5000,
      tracks: [
        {
          track_id: 'trk_scene',
          project_id: 'proj_p5_kf',
          track_type: 'scene',
          name: 'Scenes',
          target_ref_id: null,
          order_index: 0,
          muted: false,
          locked: false,
          solo: false,
          visible: true,
          volume: 1,
          collapsed: false,
        },
        {
          track_id: 'trk_cam',
          project_id: 'proj_p5_kf',
          track_type: 'camera',
          name: 'Camera',
          target_ref_id: 'camera',
          order_index: 1,
          muted: false,
          locked: false,
          solo: false,
          visible: true,
          volume: 1,
          collapsed: false,
        },
        {
          track_id: 'trk_prop_box',
          project_id: 'proj_p5_kf',
          track_type: 'prop',
          name: 'Box',
          target_ref_id: 'prop_box',
          order_index: 10,
          muted: false,
          locked: false,
          solo: false,
          visible: true,
          volume: 1,
          collapsed: false,
        },
      ],
      keyframes: [
        {
          keyframe_id: 'kf_x_f10',
          track_id: 'trk_prop_box',
          target_type: 'prop',
          target_id: 'prop_box',
          property: 'x',
          time_ms: frameIndexToQuantizedMs(10, fps), // 333ms @ 30fps
          value: 200,
          easing: 'linear',
        },
        {
          keyframe_id: 'kf_x_f40',
          track_id: 'trk_prop_box',
          target_type: 'prop',
          target_id: 'prop_box',
          property: 'x',
          time_ms: frameIndexToQuantizedMs(40, fps), // 1333ms @ 30fps
          value: 800,
          easing: 'linear',
        },
      ],
      animation_clips: [],
      sound_events: [],
    },
  };
}

describe('Phase 05 Batch 1 — Keyframe Movement, Collision, Multi-Selection & Atomic Undo/Redo', () => {
  beforeEach(() => {
    useProjectStore.setState({
      project: createTimelineFixture(30),
      activeSceneId: 'scene_1',
      selection: { type: 'prop', id: 'prop_box' },
      selectedKeyframeId: null,
      selectedKeyframeIds: [],
      selectionAnchorKeyframeId: null,
      copiedKeyframe: null,
      copiedKeyframes: [],
      isDirty: false,
      undoStack: [],
      redoStack: [],
    });
  });

  it('maintains exact frame <-> ms bijection across 24, 25, 30, and 60 FPS (fixing 1-frame floor drift)', () => {
    for (const fps of [24, 25, 30, 60]) {
      for (let f = 0; f <= 300; f++) {
        const ms = frameIndexToQuantizedMs(f, fps);
        expect(msToFrame(ms, fps)).toBe(f);
      }
    }
  });

  it('moves a keyframe from Frame 10 to Frame 20 as a pure MOVE (old position gone, stable ID unchanged, evaluator updated)', () => {
    const store = useProjectStore.getState();
    const res = store.moveKeyframe('kf_x_f10', frameIndexToQuantizedMs(20, 30), true);
    expect(res.movedCount).toBe(1);
    expect(res.replacedCount).toBe(0);
    expect(res.clampedDeltaFrames).toBe(10);

    const proj = useProjectStore.getState().project!;
    expect(proj.timeline.keyframes).toHaveLength(2);

    // No keyframe remains at Frame 10
    const atF10 = proj.timeline.keyframes.filter((k) => getKeyframeFrame(k, 30) === 10);
    expect(atF10).toHaveLength(0);

    // Original ID is now cleanly at Frame 20
    const moved = proj.timeline.keyframes.find((k) => k.keyframe_id === 'kf_x_f10');
    expect(moved).toBeDefined();
    expect(getKeyframeFrame(moved!, 30)).toBe(20);
    expect(moved!.time_ms).toBe(frameIndexToQuantizedMs(20, 30));
    expect(moved!.value).toBe(200);

    // Evaluator midpoint between Frame 20 (200) and Frame 40 (800) is Frame 30 -> 500
    const mid = evaluateStageAtFrame(proj, {}, 30, 30);
    expect(mid.props[0].transform.x).toBeCloseTo(500, 1);
  });

  it('supports repeated movement of the exact same keyframe with zero duplicates ever created', () => {
    const targets = [20, 5, 45, 0, 10, 27, 13];
    for (const frame of targets) {
      useProjectStore.getState().moveKeyframe('kf_x_f10', frameIndexToQuantizedMs(frame, 30), true);
      const kfs = useProjectStore.getState().project!.timeline.keyframes;
      expect(kfs).toHaveLength(2);
      const found = kfs.find((k) => k.keyframe_id === 'kf_x_f10')!;
      expect(getKeyframeFrame(found, 30)).toBe(frame);
    }
  });

  it('groups multi-property keyframes into summary frame clusters so moving a cluster leaves ZERO ghost markers behind', () => {
    // Add Y and Rotation keyframes at Frame 10 (same frame as X)
    useProjectStore.getState().upsertKeyframe({
      track_id: 'trk_prop_box',
      target_type: 'prop',
      target_id: 'prop_box',
      property: 'y',
      time_ms: frameIndexToQuantizedMs(10, 30),
      value: 350,
    });
    useProjectStore.getState().upsertKeyframe({
      track_id: 'trk_prop_box',
      target_type: 'prop',
      target_id: 'prop_box',
      property: 'rotation_deg',
      time_ms: frameIndexToQuantizedMs(10, 30),
      value: 45,
    });

    const beforeKfs = useProjectStore.getState().project!.timeline.keyframes;
    const clusters = groupTrackKeyframesByFrame(beforeKfs, 30);
    const f10Cluster = clusters.find((c) => c.frameIndex === 10)!;
    expect(f10Cluster.keyframes).toHaveLength(3);
    const originalIds = [...f10Cluster.keyframeIds].sort();

    // Move entire summary cluster +10 frames -> Frame 20
    const res = useProjectStore.getState().moveKeyframesByDeltaFrames(f10Cluster.keyframeIds, 10, true);
    expect(res.movedCount).toBe(3);

    const afterKfs = useProjectStore.getState().project!.timeline.keyframes;
    const afterClusters = groupTrackKeyframesByFrame(afterKfs, 30);
    expect(afterClusters.find((c) => c.frameIndex === 10)).toBeUndefined();
    const f20Cluster = afterClusters.find((c) => c.frameIndex === 20)!;
    expect(f20Cluster.keyframes).toHaveLength(3);
    expect([...f20Cluster.keyframeIds].sort()).toEqual(originalIds);
  });

  it('resolves frame collisions deterministically without duplicates AND never destroys intermediate keyframes passed over during drag', () => {
    const orig = structuredClone(useProjectStore.getState().project!.timeline.keyframes);
    // Add a third keyframe on X at Frame 25
    const kf25: Keyframe = {
      keyframe_id: 'kf_x_f25',
      track_id: 'trk_prop_box',
      target_type: 'prop',
      target_id: 'prop_box',
      property: 'x',
      time_ms: frameIndexToQuantizedMs(25, 30),
      value: 500,
      easing: 'linear',
    };
    orig.push(kf25);

    // Mid-drag preview over Frame 25 (delta +15) -> temporarily collides with kf_x_f25
    const midDrag = applyMoveKeyframes(orig, ['kf_x_f10'], 15, 30, 5000);
    expect(midDrag.replacedIds).toEqual(['kf_x_f25']);
    expect(midDrag.keyframes).toHaveLength(2);

    // Continue drag past Frame 25 to Frame 30 (delta +20) computed from orig -> kf_x_f25 is 100% UNHARMED!
    const pastDrag = applyMoveKeyframes(orig, ['kf_x_f10'], 20, 30, 5000);
    expect(pastDrag.replacedIds).toEqual([]);
    expect(pastDrag.keyframes).toHaveLength(3);
    expect(pastDrag.keyframes.some((k) => k.keyframe_id === 'kf_x_f25')).toBe(true);

    // Commit collision: move kf_x_f10 directly onto occupied Frame 40 (kf_x_f40)
    const commitRes = useProjectStore.getState().moveKeyframesByDeltaFrames(['kf_x_f10'], 30, true);
    expect(commitRes.movedCount).toBe(1);
    expect(commitRes.replacedCount).toBe(1);
    const kfsAfter = useProjectStore.getState().project!.timeline.keyframes;
    expect(kfsAfter).toHaveLength(1);
    expect(kfsAfter[0].keyframe_id).toBe('kf_x_f10');
    expect(getKeyframeFrame(kfsAfter[0], 30)).toBe(40);
    expect(kfsAfter[0].value).toBe(200);

    // Single Undo restores BOTH keyframes at their exact original positions!
    useProjectStore.getState().undo();
    const kfsRestored = useProjectStore.getState().project!.timeline.keyframes;
    expect(kfsRestored).toHaveLength(2);
    expect(getKeyframeFrame(kfsRestored.find((k) => k.keyframe_id === 'kf_x_f10')!, 30)).toBe(10);
    expect(getKeyframeFrame(kfsRestored.find((k) => k.keyframe_id === 'kf_x_f40')!, 30)).toBe(40);
  });

  it('supports multi-selection (click, toggle, Shift-range) and rigid group move preserving exact relative timing', () => {
    const store = useProjectStore.getState();
    store.upsertKeyframe({
      track_id: 'trk_prop_box',
      target_type: 'prop',
      target_id: 'prop_box',
      property: 'x',
      time_ms: frameIndexToQuantizedMs(25, 30),
      value: 500,
    });
    const allIds = useProjectStore
      .getState()
      .project!.timeline.keyframes.slice()
      .sort((a, b) => a.time_ms - b.time_ms)
      .map((k) => k.keyframe_id);
    expect(allIds).toHaveLength(3);

    // Replace select first, Shift-range select to third -> all 3 selected
    store.selectKeyframe(allIds[0], 'replace');
    store.selectKeyframeRange(allIds, allIds[2]);
    expect(useProjectStore.getState().selectedKeyframeIds).toHaveLength(3);

    // Toggle middle off (Ctrl/Cmd-click) -> 2 selected (Frame 10 and Frame 40)
    store.selectKeyframe(allIds[1], 'toggle');
    expect(useProjectStore.getState().selectedKeyframeIds).toEqual([allIds[0], allIds[2]]);

    // Try moving both left by -20 frames -> clamps rigidly to -10 frames (Frame 0 and Frame 30, preserving 30F gap!)
    const res = store.moveKeyframesByDeltaFrames([allIds[0], allIds[2]], -20, true);
    expect(res.clampedDeltaFrames).toBe(-10);
    const kfs = useProjectStore.getState().project!.timeline.keyframes;
    expect(getKeyframeFrame(kfs.find((k) => k.keyframe_id === allIds[0])!, 30)).toBe(0);
    expect(getKeyframeFrame(kfs.find((k) => k.keyframe_id === allIds[2])!, 30)).toBe(30);
    // Unselected middle keyframe stays untouched at Frame 25
    expect(getKeyframeFrame(kfs.find((k) => k.keyframe_id === allIds[1])!, 30)).toBe(25);
  });

  it('executes bulk delete, bulk duplicate, bulk copy/paste, move-to-playhead & easing change atomically with 1-step Undo/Redo', () => {
    const store = useProjectStore.getState();
    // Add Y keyframe at Frame 10
    store.upsertKeyframe({
      track_id: 'trk_prop_box',
      target_type: 'prop',
      target_id: 'prop_box',
      property: 'y',
      time_ms: frameIndexToQuantizedMs(10, 30),
      value: 300,
    });
    const initial3 = useProjectStore.getState().project!.timeline.keyframes.map((k) => k.keyframe_id);
    expect(initial3).toHaveLength(3);

    // 1. Bulk easing change on first two
    const easingCount = store.setKeyframesEasing([initial3[0], initial3[1]], 'hold');
    expect(easingCount).toBe(2);
    expect(
      useProjectStore
        .getState()
        .project!.timeline.keyframes.filter((k) => k.easing === 'hold'),
    ).toHaveLength(2);
    useProjectStore.getState().undo();
    expect(
      useProjectStore
        .getState()
        .project!.timeline.keyframes.filter((k) => k.easing === 'hold'),
    ).toHaveLength(0);

    // 2. Bulk duplicate 2 keyframes (+10F) -> 5 keyframes total, 1 Undo returns to 3
    const dupRes = store.duplicateKeyframes([initial3[0], initial3[2]], 10);
    expect(dupRes.createdIds).toHaveLength(2);
    expect(useProjectStore.getState().project!.timeline.keyframes).toHaveLength(5);
    useProjectStore.getState().undo();
    expect(useProjectStore.getState().project!.timeline.keyframes).toHaveLength(3);

    // 3. Bulk copy & paste at Frame 60 preserving relative spacing (F10 & F40 -> F60 & F90)
    expect(store.copySelectedKeyframes([initial3[0], initial3[1]])).toBe(2);
    const pasteRes = store.pasteKeyframesAtTime(frameIndexToQuantizedMs(60, 30));
    expect(pasteRes.pastedIds).toHaveLength(2);
    const pastedFrames = pasteRes.pastedIds
      .map((id) =>
        getKeyframeFrame(
          useProjectStore.getState().project!.timeline.keyframes.find((k) => k.keyframe_id === id)!,
          30,
        ),
      )
      .sort((a, b) => a - b);
    expect(pastedFrames).toEqual([60, 90]);

    // 4. Move pasted selection to Playhead Frame 50 -> F50 & F80
    const moveRes = store.moveKeyframesToFrame(pasteRes.pastedIds, 50);
    expect(moveRes.movedCount).toBe(2);
    const movedFrames = pasteRes.pastedIds
      .map((id) =>
        getKeyframeFrame(
          useProjectStore.getState().project!.timeline.keyframes.find((k) => k.keyframe_id === id)!,
          30,
        ),
      )
      .sort((a, b) => a - b);
    expect(movedFrames).toEqual([50, 80]);

    // 5. Bulk delete the 2 pasted keyframes atomically -> back to 3, Undo -> 5, Redo -> 3
    const delCount = store.deleteKeyframes(pasteRes.pastedIds);
    expect(delCount).toBe(2);
    expect(useProjectStore.getState().project!.timeline.keyframes).toHaveLength(3);
    expect(useProjectStore.getState().selectedKeyframeIds).toEqual([]);

    useProjectStore.getState().undo();
    expect(useProjectStore.getState().project!.timeline.keyframes).toHaveLength(5);
    useProjectStore.getState().redo();
    expect(useProjectStore.getState().project!.timeline.keyframes).toHaveLength(3);
  });

  it('commits a multi-step drag preview as ONE single Undo entry without cluttering history', () => {
    const startSnap = structuredClone(useProjectStore.getState().project!);
    const origKfs = structuredClone(startSnap.timeline.keyframes);

    // Simulate 15 intermediate drag frames
    for (let step = 1; step <= 15; step++) {
      const preview = applyMoveKeyframes(origKfs, ['kf_x_f10'], step, 30, 5000);
      useProjectStore.getState().previewKeyframesDuringDrag(preview.keyframes);
    }
    expect(useProjectStore.getState().undoStack).toHaveLength(0);

    // Single atomic commit on pointerup
    useProjectStore.getState().commitDragHistorySnapshot(startSnap);
    expect(useProjectStore.getState().undoStack).toHaveLength(1);
    expect(
      getKeyframeFrame(
        useProjectStore.getState().project!.timeline.keyframes.find((k) => k.keyframe_id === 'kf_x_f10')!,
        30,
      ),
    ).toBe(25);

    // ONE Undo restores exact pre-drag Frame 10
    useProjectStore.getState().undo();
    expect(
      getKeyframeFrame(
        useProjectStore.getState().project!.timeline.keyframes.find((k) => k.keyframe_id === 'kf_x_f10')!,
        30,
      ),
    ).toBe(10);
  });

  it('deduplicates corrupted duplicate channel+frame keyframes safely', () => {
    const dirty: Keyframe[] = [
      {
        keyframe_id: 'kf_old',
        track_id: 'trk_prop_box',
        target_type: 'prop',
        target_id: 'prop_box',
        property: 'x',
        time_ms: 333,
        value: 100,
        easing: 'linear',
      },
      {
        keyframe_id: 'kf_new',
        track_id: 'trk_prop_box',
        target_type: 'prop',
        target_id: 'prop_box',
        property: 'x',
        time_ms: 333,
        value: 450,
        easing: 'ease_out',
      },
    ];
    const clean = deduplicateKeyframesByChannelFrame(dirty, 30);
    expect(clean).toHaveLength(1);
    expect(clean[0].keyframe_id).toBe('kf_new');
    expect(clean[0].value).toBe(450);
  });
});
