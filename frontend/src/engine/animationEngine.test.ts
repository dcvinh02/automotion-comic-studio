import { beforeEach, describe, expect, it } from 'vitest';
import { evaluateStageAtFrame, frameToMs, msToFrame } from './evaluator';
import { applyEasing, evaluateNumericKeyframes } from './interpolation';
import {
  ANIMATION_PRESETS,
  generatePresetKeyframes,
  groupKeyframesForTrack,
  quantizeMsToFrameMs,
} from './presets';
import { useLocaleStore } from '@/i18n/useLocaleStore';
import { usePlaybackStore } from '@/stores/usePlaybackStore';
import { useProjectStore } from '@/stores/useProjectStore';
import type { Character, Keyframe, ProjectState } from '@/types/models';

function createBaseProject(fps = 30): ProjectState {
  return {
    meta: {
      project_id: 'proj_p3_test',
      name: 'Truyện Tranh Demo',
      description: 'User authored description',
      schema_version: '0.1.0',
      width: 1920,
      height: 1080,
      fps,
      duration_ms: 5000,
      default_export_preset_id: 'preset_1080p_final',
      auto_save_enabled: false,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
    scenes: [
      {
        scene_id: 'sc_1',
        project_id: 'proj_p3_test',
        order_index: 0,
        name: 'Cảnh Mở Đầu',
        start_ms: 0,
        duration_ms: 5000,
        background_asset_id: null,
        background_color: '#14161A',
        transition_in: 'cut',
        transition_duration_ms: 0,
        camera_default: { x: 0, y: 0, zoom: 1, rotation_deg: 0 },
        characters: [
          {
            instance_id: 'inst_hero',
            scene_id: 'sc_1',
            character_id: 'char_hero',
            display_name: 'Anh Hùng Minh',
            z_index: 10,
            initial_transform: {
              x: 400,
              y: 500,
              rotation_deg: 0,
              scale_x: 1,
              scale_y: 1,
              opacity: 1,
            },
            default_expression_id: null,
            default_pose_id: null,
            default_eye_state: 'open',
            default_mouth_state: 'closed',
          },
        ],
        props: [
          {
            prop_instance_id: 'prop_torso',
            asset_id: 'ast_torso',
            name: 'Torso Layer',
            z_index: 5,
            anchor_x: 0.5,
            anchor_y: 0.8,
            visible: true,
            locked: false,
            parent_id: null,
            transform: { x: 500, y: 500, rotation_deg: 90, scale_x: 2, scale_y: 2, opacity: 0.8 },
          },
          {
            prop_instance_id: 'prop_arm',
            asset_id: 'ast_arm',
            name: 'Arm Layer',
            z_index: 6,
            anchor_x: 0.5,
            anchor_y: 0.1,
            visible: true,
            locked: false,
            parent_id: 'prop_torso',
            transform: { x: 100, y: 0, rotation_deg: 15, scale_x: 0.5, scale_y: 0.5, opacity: 0.5 },
          },
        ],
      },
    ],
    timeline: {
      project_id: 'proj_p3_test',
      fps,
      total_duration_ms: 5000,
      tracks: [
        {
          track_id: 'trk_scene',
          project_id: 'proj_p3_test',
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
          project_id: 'proj_p3_test',
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
          track_id: 'trk_hero',
          project_id: 'proj_p3_test',
          track_type: 'character',
          name: 'Char: Anh Hùng Minh',
          target_ref_id: 'inst_hero',
          order_index: 2,
          muted: false,
          locked: false,
          solo: false,
          visible: true,
          volume: 1,
          collapsed: false,
        },
      ],
      keyframes: [],
      animation_clips: [],
      sound_events: [],
    },
  };
}

const HERO_CHAR: Character = {
  character_id: 'char_hero',
  name: 'Anh Hùng Minh',
  description: '',
  tags: ['hero'],
  version: 1,
  identity_confirmed: true,
  thumbnail_asset_id: null,
  voice_profile_id: null,
  parts: [
    {
      slot_id: 'slot_body',
      name: 'Body',
      part_role: 'body',
      parent_slot_id: null,
      default_asset_id: 'ast_body',
      variants: {},
      z_index: 10,
      anchor_x: 0.5,
      anchor_y: 0.8,
      default_transform: { x: 0, y: 0, rotation_deg: 0, scale_x: 1, scale_y: 1, opacity: 1 },
      visible: true,
    },
    {
      slot_id: 'slot_arm',
      name: 'Right Arm',
      part_role: 'right_arm',
      parent_slot_id: 'slot_body',
      default_asset_id: 'ast_arm',
      variants: {},
      z_index: 20,
      anchor_x: 0.5,
      anchor_y: 0.1,
      default_transform: { x: 50, y: -100, rotation_deg: 0, scale_x: 1, scale_y: 1, opacity: 1 },
      visible: true,
    },
  ],
  expressions: [],
  poses: [],
  created_at: '',
  updated_at: '',
};

describe('Phase 03 Animation Engine — Interpolation & Edge Cases', () => {
  const mkKf = (id: string, time_ms: number, value: number, easing: Keyframe['easing']): Keyframe => ({
    keyframe_id: id,
    track_id: 'trk_hero',
    target_type: 'character_instance',
    target_id: 'inst_hero',
    property: 'x',
    time_ms,
    value,
    easing,
  });

  it('evaluates linear, ease_in, ease_out, ease_in_out, and hold distinctly between frame 0 and frame 60', () => {
    // At 30fps, frame 0 = 0ms, frame 30 = 1000ms (t=0.5), frame 60 = 2000ms
    const tMid = 1000;
    const lin = evaluateNumericKeyframes(
      [mkKf('a', 0, 100, 'linear'), mkKf('b', 2000, 500, 'linear')],
      tMid,
      0,
    );
    const eIn = evaluateNumericKeyframes(
      [mkKf('a', 0, 100, 'ease_in'), mkKf('b', 2000, 500, 'ease_in')],
      tMid,
      0,
    );
    const eOut = evaluateNumericKeyframes(
      [mkKf('a', 0, 100, 'ease_out'), mkKf('b', 2000, 500, 'ease_out')],
      tMid,
      0,
    );
    const eInOut = evaluateNumericKeyframes(
      [mkKf('a', 0, 100, 'ease_in_out'), mkKf('b', 2000, 500, 'ease_in_out')],
      500,
      0,
    );
    const holdMid = evaluateNumericKeyframes(
      [mkKf('a', 0, 100, 'hold'), mkKf('b', 2000, 500, 'hold')],
      tMid,
      0,
    );
    const holdEnd = evaluateNumericKeyframes(
      [mkKf('a', 0, 100, 'hold'), mkKf('b', 2000, 500, 'hold')],
      2000,
      0,
    );

    expect(lin).toBeCloseTo(300, 5);
    expect(eIn).toBeLessThan(lin);
    expect(eOut).toBeGreaterThan(lin);
    expect(eInOut).toBeLessThan(200); // ease_in_out at t=0.25 is slower than linear (200)
    expect(holdMid).toBe(100);
    expect(holdEnd).toBe(500);
  });

  it('handles 0 keyframes, 1 keyframe, clamping, duplicate timestamps, and invalid values safely', () => {
    expect(evaluateNumericKeyframes([], 500, 42)).toBe(42);
    expect(evaluateNumericKeyframes([mkKf('a', 1000, 250, 'linear')], 0, 42)).toBe(250);
    expect(evaluateNumericKeyframes([mkKf('a', 1000, 250, 'linear')], 5000, 42)).toBe(250);

    // Duplicate timestamps resolve deterministically without divide-by-zero NaN
    const dup = evaluateNumericKeyframes(
      [mkKf('a1', 1000, 100, 'linear'), mkKf('a2', 1000, 300, 'linear'), mkKf('b', 2000, 500, 'linear')],
      1500,
      0,
    );
    expect(Number.isFinite(dup)).toBe(true);
    expect(dup).toBeCloseTo(400, 5);

    // Non-numeric / NaN keyframe falls back cleanly without crashing
    const bad = evaluateNumericKeyframes(
      [{ ...mkKf('bad', 0, Number.NaN, 'linear') }],
      0,
      99,
    );
    expect(bad).toBe(99);
    expect(applyEasing(-0.5, 'ease_in_out')).toBe(0);
    expect(applyEasing(1.5, 'ease_in_out')).toBe(1);
  });

  it('aligns frame/time conversions accurately across 24, 25, 30, and 60 FPS', () => {
    for (const fps of [24, 25, 30, 60]) {
      const f30Ms = frameToMs(30, fps);
      expect(msToFrame(f30Ms + 0.001, fps)).toBe(30);
      const q = quantizeMsToFrameMs(f30Ms, fps);
      expect(Math.abs(q - f30Ms)).toBeLessThanOrEqual(1);
    }
  });
});

describe('Phase 03 Animation Engine — Hierarchy, Rig Parts & Presets', () => {
  it('computes hierarchical prop parent-child world transforms and cycle safety', () => {
    const project = createBaseProject(30);
    const stage = evaluateStageAtFrame(project, { char_hero: HERO_CHAR }, 0, 30);
    const arm = stage.props.find((p) => p.prop_instance_id === 'prop_arm');
    expect(arm).toBeDefined();
    // Parent at (500, 500), rot=90deg, scale=2, opacity=0.8; Child local=(100, 0), rot=15deg, scale=0.5, opacity=0.5
    // Local (100, 0) * scale 2 rotated 90deg => (0, +200) -> World (500, 700)
    expect(arm!.transform.x).toBeCloseTo(500, 3);
    expect(arm!.transform.y).toBeCloseTo(700, 3);
    expect(arm!.transform.rotation_deg).toBeCloseTo(105, 3);
    expect(arm!.transform.scale_x).toBeCloseTo(1, 3);
    expect(arm!.transform.opacity).toBeCloseTo(0.4, 3);
    expect(arm!.anchor_y).toBe(0.1);

    // Ensure circular parenting never causes stack overflow
    project.scenes[0].props[0].parent_id = 'prop_arm';
    const cyclicStage = evaluateStageAtFrame(project, { char_hero: HERO_CHAR }, 0, 30);
    expect(cyclicStage.props.length).toBe(2);
  });

  it('animates individual character cutout body parts independently around their pivots', () => {
    const project = createBaseProject(30);
    project.timeline.keyframes.push(
      {
        keyframe_id: 'kf_arm_0',
        track_id: 'trk_hero',
        target_type: 'character_part',
        target_id: 'inst_hero:slot_arm',
        property: 'rotation_deg',
        time_ms: 0,
        value: 0,
        easing: 'linear',
      },
      {
        keyframe_id: 'kf_arm_60',
        track_id: 'trk_hero',
        target_type: 'character_part',
        target_id: 'inst_hero:slot_arm',
        property: 'rotation_deg',
        time_ms: 2000,
        value: -60,
        easing: 'linear',
      },
    );

    const mid = evaluateStageAtFrame(project, { char_hero: HERO_CHAR }, 30, 30);
    const arm = mid.characters[0].parts.find((p) => p.slot_id === 'slot_arm');
    const body = mid.characters[0].parts.find((p) => p.slot_id === 'slot_body');
    expect(arm!.transform.rotation_deg).toBeCloseTo(-30, 3);
    expect(body!.transform.rotation_deg).toBe(0);
  });

  it('generates editable keyframes for all 9 presets and groups them into expandable property tracks', () => {
    for (const preset of ANIMATION_PRESETS) {
      const specs = generatePresetKeyframes({
        presetId: preset.id,
        targetType: preset.supportsCamera ? 'camera' : 'character_instance',
        targetId: preset.supportsCamera ? 'camera' : 'inst_hero',
        trackId: preset.supportsCamera ? 'trk_cam' : 'trk_hero',
        startFrame: 15,
        fps: 30,
        baseTransform: { x: 400, y: 500, rotation_deg: 0, scale_x: 1, scale_y: 1, opacity: 1 },
        baseCameraZoom: 1,
      });
      expect(specs.length).toBeGreaterThanOrEqual(2);
      expect(specs[0].time_ms).toBe(500);
    }

    const fakeKfs: Keyframe[] = [
      { keyframe_id: '1', track_id: 'trk_hero', target_type: 'character_instance', target_id: 'inst_hero', property: 'x', time_ms: 0, value: 100, easing: 'linear' },
      { keyframe_id: '2', track_id: 'trk_hero', target_type: 'character_instance', target_id: 'inst_hero', property: 'x', time_ms: 1000, value: 300, easing: 'linear' },
      { keyframe_id: '3', track_id: 'trk_hero', target_type: 'character_part', target_id: 'inst_hero:slot_arm', property: 'rotation_deg', time_ms: 500, value: 45, easing: 'ease_out' },
    ];
    const groups = groupKeyframesForTrack(fakeKfs, () => true);
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.property === 'x')?.keyframes).toHaveLength(2);
    expect(groups.find((g) => g.partSlotId === 'slot_arm')?.property).toBe('rotation_deg');
  });
});

describe('Phase 03 Store Integration — Keyframe Editing, Undo/Redo & Bilingual State Preservation', () => {
  beforeEach(() => {
    const project = createBaseProject(30);
    useProjectStore.setState({
      project,
      activeSceneId: 'sc_1',
      selection: { type: 'character', id: 'inst_hero' },
      selectedKeyframeId: null,
      copiedKeyframe: null,
      undoStack: [],
      redoStack: [],
      isDirty: false,
    });
    usePlaybackStore.setState({ isPlaying: false, currentFrame: 12 });
    useLocaleStore.getState().setLocale('vi');
  });

  it('supports applying presets, editing/moving/copy-pasting keyframes, and Undo/Redo', () => {
    const store = useProjectStore.getState();
    const added = store.applyAnimationPreset({
      presetId: 'move_right',
      targetType: 'character_instance',
      targetId: 'inst_hero',
      trackId: 'trk_hero',
      startFrame: 0,
      baseTransform: { x: 400, y: 500, rotation_deg: 0, scale_x: 1, scale_y: 1, opacity: 1 },
    });
    expect(added).toBe(2);

    const kfs = useProjectStore.getState().project!.timeline.keyframes;
    expect(kfs).toHaveLength(2);
    const secondKf = kfs[1];
    expect(secondKf.time_ms).toBe(2000);
    expect(secondKf.value).toBe(720);

    // Presets produce real editable keyframes: drag/move second keyframe to 1000ms
    useProjectStore.getState().moveKeyframe(secondKf.keyframe_id, 1000, true);
    expect(
      useProjectStore.getState().project!.timeline.keyframes.find((k) => k.keyframe_id === secondKf.keyframe_id)?.time_ms,
    ).toBe(1000);

    // Copy & paste at 3000ms
    useProjectStore.getState().copyKeyframe(secondKf);
    expect(useProjectStore.getState().pasteKeyframeAtTime(3000)).toBe(true);
    expect(useProjectStore.getState().project!.timeline.keyframes).toHaveLength(3);

    // Undo removes the pasted keyframe cleanly
    useProjectStore.getState().undo();
    expect(useProjectStore.getState().project!.timeline.keyframes).toHaveLength(2);

    // Redo restores it cleanly
    useProjectStore.getState().redo();
    expect(useProjectStore.getState().project!.timeline.keyframes).toHaveLength(3);
  });

  it('switches language vi <-> en without resetting project, selection, playback, or user content', () => {
    usePlaybackStore.setState({ isPlaying: true, currentFrame: 27 });

    useLocaleStore.getState().setLocale('en');
    expect(useLocaleStore.getState().locale).toBe('en');
    expect(usePlaybackStore.getState().isPlaying).toBe(true);
    expect(usePlaybackStore.getState().currentFrame).toBe(27);
    expect(useProjectStore.getState().selection).toEqual({ type: 'character', id: 'inst_hero' });
    // User-created names must NEVER be modified by localization
    expect(useProjectStore.getState().project!.meta.name).toBe('Truyện Tranh Demo');
    expect(useProjectStore.getState().project!.scenes[0].name).toBe('Cảnh Mở Đầu');
    expect(useProjectStore.getState().project!.scenes[0].characters[0].display_name).toBe('Anh Hùng Minh');

    useLocaleStore.getState().setLocale('vi');
    expect(useLocaleStore.getState().locale).toBe('vi');
    expect(usePlaybackStore.getState().isPlaying).toBe(true);
    expect(useProjectStore.getState().project!.meta.name).toBe('Truyện Tranh Demo');
  });
});
