import { describe, expect, it } from 'vitest';
import { evaluateStageAtFrame, frameToMs, msToFrame } from './evaluator';
import { applyEasing, evaluateNumericKeyframes } from './interpolation';
import type { Character, Keyframe, ProjectState } from '@/types/models';

function createFixtureProject(): { project: ProjectState; characters: Record<string, Character> } {
  const char: Character = {
    character_id: 'char_hero',
    name: 'Minh',
    description: '',
    tags: [],
    identity_confirmed: true,
    thumbnail_asset_id: null,
    voice_profile_id: null,
    version: 1,
    created_at: '',
    updated_at: '',
    parts: [
      {
        slot_id: 'slot_body',
        name: 'Body',
        part_role: 'body',
        parent_slot_id: null,
        default_asset_id: 'ast_body',
        variants: {},
        z_index: 1,
        anchor_x: 0.5,
        anchor_y: 0.8,
        default_transform: { x: 0, y: 0, rotation_deg: 0, scale_x: 1, scale_y: 1, opacity: 1 },
        visible: true,
      },
      {
        slot_id: 'slot_head',
        name: 'Head',
        part_role: 'head',
        parent_slot_id: 'slot_body',
        default_asset_id: 'ast_head',
        variants: {},
        z_index: 2,
        anchor_x: 0.5,
        anchor_y: 0.85,
        default_transform: { x: 0, y: -120, rotation_deg: 0, scale_x: 1, scale_y: 1, opacity: 1 },
        visible: true,
      },
      {
        slot_id: 'slot_eyes',
        name: 'Eyes',
        part_role: 'eyes',
        parent_slot_id: 'slot_head',
        default_asset_id: 'ast_eyes_open',
        variants: { open: 'ast_eyes_open', closed: 'ast_eyes_closed', happy: 'ast_eyes_happy' },
        z_index: 3,
        anchor_x: 0.5,
        anchor_y: 0.5,
        default_transform: { x: 0, y: -30, rotation_deg: 0, scale_x: 1, scale_y: 1, opacity: 1 },
        visible: true,
      },
      {
        slot_id: 'slot_mouth',
        name: 'Mouth',
        part_role: 'mouth',
        parent_slot_id: 'slot_head',
        default_asset_id: 'ast_mouth_closed',
        variants: { closed: 'ast_mouth_closed', smile: 'ast_mouth_smile', a: 'ast_mouth_a' },
        z_index: 4,
        anchor_x: 0.5,
        anchor_y: 0.5,
        default_transform: { x: 0, y: 15, rotation_deg: 0, scale_x: 1, scale_y: 1, opacity: 1 },
        visible: true,
      },
    ],
    expressions: [
      {
        expression_id: 'expr_happy',
        name: 'Happy',
        slot_variant_overrides: { slot_eyes: 'happy', slot_mouth: 'smile' },
        slot_transform_overrides: {},
      },
    ],
    poses: [],
  };

  const project: ProjectState = {
    meta: {
      project_id: 'proj_test',
      name: 'Test Comic',
      description: '',
      schema_version: '0.1.0',
      width: 1920,
      height: 1080,
      fps: 30,
      duration_ms: 10000,
      default_export_preset_id: 'preset_1080p_final',
      auto_save_enabled: true,
      created_at: '',
      updated_at: '',
    },
    scenes: [
      {
        scene_id: 'scene_1',
        project_id: 'proj_test',
        order_index: 0,
        name: 'Scene 1',
        start_ms: 0,
        duration_ms: 10000,
        background_asset_id: null,
        background_color: '#14161A',
        transition_in: 'fade',
        transition_duration_ms: 1000,
        camera_default: { x: 0, y: 0, zoom: 1, rotation_deg: 0 },
        characters: [
          {
            instance_id: 'inst_1',
            scene_id: 'scene_1',
            character_id: 'char_hero',
            display_name: 'Minh',
            z_index: 10,
            initial_transform: { x: 300, y: 600, rotation_deg: 0, scale_x: 1, scale_y: 1, opacity: 1 },
            default_expression_id: null,
            default_pose_id: null,
            default_eye_state: 'open',
            default_mouth_state: 'closed',
          },
        ],
        props: [],
      },
    ],
    timeline: {
      project_id: 'proj_test',
      fps: 30,
      total_duration_ms: 10000,
      tracks: [],
      keyframes: [
        {
          keyframe_id: 'kf_x0',
          track_id: 'trk_1',
          target_type: 'character_instance',
          target_id: 'inst_1',
          property: 'x',
          time_ms: 0,
          value: 300,
          easing: 'linear',
        },
        {
          keyframe_id: 'kf_x1',
          track_id: 'trk_1',
          target_type: 'character_instance',
          target_id: 'inst_1',
          property: 'x',
          time_ms: 2000,
          value: 900,
          easing: 'linear',
        },
        {
          keyframe_id: 'kf_expr',
          track_id: 'trk_1',
          target_type: 'character_instance',
          target_id: 'inst_1',
          property: 'expression_id',
          time_ms: 1000,
          value: 'expr_happy',
          easing: 'step',
        },
        {
          keyframe_id: 'kf_cam0',
          track_id: 'trk_cam',
          target_type: 'camera',
          target_id: 'camera',
          property: 'zoom',
          time_ms: 0,
          value: 1.0,
          easing: 'linear',
        },
        {
          keyframe_id: 'kf_cam1',
          track_id: 'trk_cam',
          target_type: 'camera',
          target_id: 'camera',
          property: 'zoom',
          time_ms: 2000,
          value: 1.5,
          easing: 'linear',
        },
      ],
      animation_clips: [
        {
          clip_id: 'clip_1',
          track_id: 'trk_1',
          instance_id: 'inst_1',
          start_ms: 0,
          end_ms: 5000,
          animation_state: 'WALKING',
          procedural: {
            auto_blink: true,
            blink_interval_ms: 3000,
            blink_duration_ms: 150,
            breathing: true,
            breathing_amplitude: 0.02,
            breathing_period_ms: 2000,
            walk_bounce_px: 15,
            walk_cycle_ms: 600,
          },
        },
      ],
      sound_events: [],
    },
  };

  return { project, characters: { char_hero: char } };
}

describe('Deterministic FrameEvaluator & Interpolation', () => {
  it('converts frames <-> ms consistently', () => {
    expect(frameToMs(30, 30)).toBe(1000);
    expect(msToFrame(1000, 30)).toBe(30);
    expect(applyEasing(0.5, 'linear')).toBe(0.5);
    expect(applyEasing(0.5, 'step')).toBe(0);
  });

  it('interpolates character X and camera zoom accurately at midpoint', () => {
    const { project, characters } = createFixtureProject();
    // Frame 30 @ 30fps == 1000ms (exact midpoint between 0ms and 2000ms)
    const evalMid = evaluateStageAtFrame(project, characters, 30, 30);
    expect(evalMid.characters[0].transform.x).toBeCloseTo(600, 2);
    expect(evalMid.camera.zoom).toBeCloseTo(1.25, 3);
    expect(evalMid.fadeAlpha).toBeCloseTo(1.0, 2);

    // Frame 15 @ 30fps == 500ms -> fadeAlpha == 0.5
    const evalQuarter = evaluateStageAtFrame(project, characters, 15, 30);
    expect(evalQuarter.fadeAlpha).toBeCloseTo(0.5, 2);
  });

  it('switches expression at step keyframe deterministically', () => {
    const { project, characters } = createFixtureProject();
    const before = evaluateStageAtFrame(project, characters, 25, 30); // 833ms
    const after = evaluateStageAtFrame(project, characters, 30, 30); // 1000ms
    expect(before.characters[0].expression_id).toBeNull();
    expect(after.characters[0].expression_id).toBe('expr_happy');

    // Evaluating same frame twice gives identical results (WYSIWYG invariant)
    const after2 = evaluateStageAtFrame(project, characters, 30, 30);
    expect(after2).toEqual(after);
  });

  it('applies procedural walking bounce when state is WALKING', () => {
    const { project, characters } = createFixtureProject();
    const ev = evaluateStageAtFrame(project, characters, 4, 30); // ~133ms into walk cycle
    expect(ev.characters[0].transform.y).toBeLessThan(600);
  });

  it('handles numeric keyframes with clamping outside bounds', () => {
    const kfs: Keyframe[] = [
      {
        keyframe_id: 'a',
        track_id: 't',
        target_type: 'camera',
        target_id: 'camera',
        property: 'x',
        time_ms: 1000,
        value: 100,
        easing: 'linear',
      },
      {
        keyframe_id: 'b',
        track_id: 't',
        target_type: 'camera',
        target_id: 'camera',
        property: 'x',
        time_ms: 2000,
        value: 200,
        easing: 'linear',
      },
    ];
    expect(evaluateNumericKeyframes(kfs, 0, 0)).toBe(100);
    expect(evaluateNumericKeyframes(kfs, 1500, 0)).toBe(150);
    expect(evaluateNumericKeyframes(kfs, 5000, 0)).toBe(200);
  });
});
