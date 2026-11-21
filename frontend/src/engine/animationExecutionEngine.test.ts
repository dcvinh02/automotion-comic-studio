import { describe, expect, it } from 'vitest';
import {
  checkPresetCompatibilityLocal,
  inspectCharacterCapabilitiesLocal,
  mergeMotionPreviewOverlay,
  type MotionPreviewOverlay,
} from './animationExecutionEngine';
import { evaluateStageAtFrame } from './evaluator';
import type { Character, MotionPreset, ProjectState } from '@/types/models';

const fullChar: Character = {
  character_id: 'ch_full',
  name: 'Full Hero',
  description: '',
  tags: [],
  identity_confirmed: true,
  thumbnail_asset_id: null,
  voice_profile_id: null,
  parts: [
    {
      slot_id: 's_body',
      name: 'Body',
      part_role: 'body',
      parent_slot_id: null,
      default_asset_id: 'a_body',
      variants: {},
      z_index: 1,
      anchor_x: 0.5,
      anchor_y: 0.5,
      default_transform: { x: 0, y: 0, rotation_deg: 0, scale_x: 1, scale_y: 1, opacity: 1 },
      visible: true,
      locked: false,
    },
    {
      slot_id: 's_head',
      name: 'Head',
      part_role: 'head',
      parent_slot_id: 's_body',
      default_asset_id: 'a_head',
      variants: {},
      z_index: 2,
      anchor_x: 0.5,
      anchor_y: 0.85,
      default_transform: { x: 0, y: -90, rotation_deg: 0, scale_x: 1, scale_y: 1, opacity: 1 },
      visible: true,
      locked: false,
    },
    {
      slot_id: 's_rarm',
      name: 'Right Arm',
      part_role: 'right_arm',
      parent_slot_id: 's_body',
      default_asset_id: 'a_arm',
      variants: {},
      z_index: 3,
      anchor_x: 0.5,
      anchor_y: 0.1,
      default_transform: { x: 40, y: -30, rotation_deg: 0, scale_x: 1, scale_y: 1, opacity: 1 },
      visible: true,
      locked: false,
    },
    {
      slot_id: 's_lleg',
      name: 'Left Leg',
      part_role: 'left_leg',
      parent_slot_id: 's_body',
      default_asset_id: 'a_leg',
      variants: {},
      z_index: 0,
      anchor_x: 0.5,
      anchor_y: 0.1,
      default_transform: { x: -20, y: 80, rotation_deg: 0, scale_x: 1, scale_y: 1, opacity: 1 },
      visible: true,
      locked: false,
    },
    {
      slot_id: 's_eyes',
      name: 'Eyes',
      part_role: 'eyes',
      parent_slot_id: 's_head',
      default_asset_id: 'a_eye_open',
      variants: { open: 'a_eye_open', closed: 'a_eye_closed' },
      z_index: 4,
      anchor_x: 0.5,
      anchor_y: 0.5,
      default_transform: { x: 0, y: -10, rotation_deg: 0, scale_x: 1, scale_y: 1, opacity: 1 },
      visible: true,
      locked: false,
    },
  ],
  expressions: [],
  poses: [],
  version: 1,
  created_at: '',
  updated_at: '',
};

const minimalChar: Character = {
  ...fullChar,
  character_id: 'ch_min',
  name: 'Minimal Rig',
  parts: [fullChar.parts[0]],
};

const blinkPreset: MotionPreset = {
  preset_id: 'motion_blink',
  name: 'Eye Blink',
  category: 'blink',
  description: '',
  is_builtin: true,
  required_capabilities: ['eye_state'],
  optional_capabilities: [],
  supported_rig_types: ['full_cutout', 'upper_body', 'simple_cutout'],
  motion_targets: ['root.eye_state'],
  supported_easings: ['hold'],
  min_duration_ms: 250,
  max_duration_ms: 15000,
  default_parameters: {
    duration_ms: 600,
    speed: 1,
    intensity: 1,
    distance_px: 0,
    direction: 'in_place',
    start_pose_id: null,
    end_pose_id: null,
    easing: 'hold',
    loop: false,
    delay_ms: 0,
  },
  limitations: [],
  tags: [],
  created_at: '',
  updated_at: '',
};

function makeTwoShotProject(): ProjectState {
  return {
    meta: {
      project_id: 'proj_anim_test',
      name: 'Anim Isolation Test',
      description: '',
      schema_version: '8',
      width: 1280,
      height: 720,
      fps: 24,
      duration_ms: 6000,
      default_export_preset_id: 'preset_720p_preview',
      auto_save_enabled: true,
      created_at: '',
      updated_at: '',
    },
    scenes: [
      {
        scene_id: 'sc_1',
        project_id: 'proj_anim_test',
        order_index: 0,
        name: 'Scene 1',
        start_ms: 0,
        duration_ms: 6000,
        background_asset_id: null,
        background_color: '#101216',
        transition_in: 'cut',
        transition_duration_ms: 0,
        camera_default: { x: 0, y: 0, zoom: 1, rotation_deg: 0 },
        characters: [
          {
            instance_id: 'inst_hero',
            scene_id: 'sc_1',
            character_id: 'ch_full',
            display_name: 'Full Hero',
            z_index: 10,
            visible: true,
            locked: false,
            initial_transform: { x: 400, y: 420, rotation_deg: 0, scale_x: 1, scale_y: 1, opacity: 1 },
            default_expression_id: null,
            default_pose_id: null,
            default_eye_state: 'open',
            default_mouth_state: 'closed',
          },
        ],
        props: [],
        execution_meta: {
          executed: true,
          production_plan_id: 'plan_1',
          source_scene_id: 'sc_1',
          executed_at: '',
          owned_shot_ids: ['sh_1', 'sh_2'],
          owned_character_instance_ids: ['inst_hero'],
          owned_prop_instance_ids: [],
          execution_warnings: [],
        },
        shots: [
          {
            shot_id: 'sh_1',
            scene_id: 'sc_1',
            production_shot_id: 'ps_1',
            storyboard_shot_id: null,
            shot_order: 1,
            title: 'Shot 1 (Walk)',
            start_ms: 0,
            duration_ms: 3000,
            background_asset_id: null,
            camera_default: { x: 0, y: 0, zoom: 1, rotation_deg: 0 },
            character_states: [
              {
                instance_id: 'inst_hero',
                character_id: 'ch_full',
                display_name: 'Full Hero',
                visible: true,
                z_index: 10,
                screen_position: 'left',
                depth_layer: 'midground',
                facing_direction: 'right',
                transform: { x: 400, y: 420, rotation_deg: 0, scale_x: 1, scale_y: 1, opacity: 1 },
                pose_id: null,
                expression_id: null,
                animation_state: 'WALKING',
                staging_fallback_used: false,
                staging_fallback_reason: '',
              },
            ],
            prop_states: [],
            asset_refs: [],
            animation_refs: ['anim_kf_s1_x0', 'anim_kf_s1_x1'],
            applied_motions: [],
            execution_status: 'assembled',
            warnings: [],
            staging_fallbacks: [],
          },
          {
            shot_id: 'sh_2',
            scene_id: 'sc_1',
            production_shot_id: 'ps_2',
            storyboard_shot_id: null,
            shot_order: 2,
            title: 'Shot 2 (Stationary Center)',
            start_ms: 3000,
            duration_ms: 3000,
            background_asset_id: null,
            camera_default: { x: 0, y: 0, zoom: 1, rotation_deg: 0 },
            character_states: [
              {
                instance_id: 'inst_hero',
                character_id: 'ch_full',
                display_name: 'Full Hero',
                visible: true,
                z_index: 10,
                screen_position: 'center',
                depth_layer: 'midground',
                facing_direction: 'front',
                transform: { x: 640, y: 420, rotation_deg: 0, scale_x: 1, scale_y: 1, opacity: 1 },
                pose_id: null,
                expression_id: null,
                animation_state: 'IDLE',
                staging_fallback_used: false,
                staging_fallback_reason: '',
              },
            ],
            prop_states: [],
            asset_refs: [],
            animation_refs: [],
            applied_motions: [],
            execution_status: 'assembled',
            warnings: [],
            staging_fallbacks: [],
          },
        ],
      },
    ],
    timeline: {
      project_id: 'proj_anim_test',
      fps: 24,
      total_duration_ms: 6000,
      tracks: [],
      keyframes: [
        {
          keyframe_id: 'anim_kf_s1_x0',
          track_id: 'trk_char',
          target_type: 'character_instance',
          target_id: 'inst_hero',
          property: 'x',
          time_ms: 0,
          value: 400,
          easing: 'linear',
        },
        {
          keyframe_id: 'anim_kf_s1_x1',
          track_id: 'trk_char',
          target_type: 'character_instance',
          target_id: 'inst_hero',
          property: 'x',
          time_ms: 3000,
          value: 920,
          easing: 'hold',
        },
      ],
      animation_clips: [],
      sound_events: [],
    },
    script: undefined,
    subtitles: undefined,
    director: null,
    storyboard: null,
    production_plan: null,
  };
}

describe('Phase 07 Batch 2 — Animation Capabilities, Preview Overlay & Shot Keyframe Isolation', () => {
  it('inspects rig capabilities accurately and blocks incompatible presets', () => {
    const fullCaps = inspectCharacterCapabilitiesLocal(fullChar);
    expect(fullCaps.rig_type).toBe('full_cutout');
    expect(fullCaps.capabilities).toContain('eye_state');
    expect(fullCaps.capabilities).toContain('leg_rotation');

    const minCaps = inspectCharacterCapabilitiesLocal(minimalChar);
    expect(minCaps.rig_type).toBe('simple_cutout');
    expect(minCaps.capabilities).not.toContain('eye_state');

    expect(checkPresetCompatibilityLocal(blinkPreset, fullCaps).compatible).toBe(true);
    const bad = checkPresetCompatibilityLocal(blinkPreset, minCaps);
    expect(bad.compatible).toBe(false);
    expect(bad.missing_capabilities).toContain('eye_state');
  });

  it('prevents Shot 1 animation keyframes from leaking into Shot 2 even at the shared 3000ms boundary', () => {
    const proj = makeTwoShotProject();
    const charsById = { ch_full: fullChar };

    // Mid Shot 1 (1500ms = frame 36): hero is walking midway between 400 and 920 (~660)
    const s1Mid = evaluateStageAtFrame(proj, charsById, 36, 24);
    expect(s1Mid.activeShot?.shot_id).toBe('sh_1');
    expect(s1Mid.characters[0].transform.x).toBeCloseTo(660, 0);

    // Exact Shot 2 boundary (3000ms = frame 72): Shot 1's end keyframe (920) MUST NOT leak into Shot 2 (640)!
    const s2Start = evaluateStageAtFrame(proj, charsById, 72, 24);
    expect(s2Start.activeShot?.shot_id).toBe('sh_2');
    expect(s2Start.characters[0].transform.x).toBe(640);
  });

  it('evaluates non-destructive Motion Preview overlay without mutating permanent ProjectState keyframes', () => {
    const proj = makeTwoShotProject();
    const origKfCount = proj.timeline.keyframes.length;

    const overlay: MotionPreviewOverlay = {
      projectId: proj.meta.project_id,
      sceneId: 'sc_1',
      shotId: 'sh_2',
      targetKind: 'character',
      instanceId: 'inst_hero',
      presetId: 'motion_wave',
      startMs: 3000,
      endMs: 4500,
      loop: false,
      keyframes: [
        {
          keyframe_id: 'prev_arm_0',
          track_id: 'trk_char',
          target_type: 'character_part',
          target_id: 'inst_hero:s_rarm',
          property: 'rotation_deg',
          time_ms: 3000,
          value: 0,
          easing: 'linear',
        },
        {
          keyframe_id: 'prev_arm_1',
          track_id: 'trk_char',
          target_type: 'character_part',
          target_id: 'inst_hero:s_rarm',
          property: 'rotation_deg',
          time_ms: 4500,
          value: -60,
          easing: 'linear',
        },
      ],
      animationClips: [],
    };

    const merged = mergeMotionPreviewOverlay(proj, overlay);
    // Permanent project remains completely untouched!
    expect(proj.timeline.keyframes.length).toBe(origKfCount);
    expect(merged.timeline.keyframes.length).toBe(origKfCount + 2);

    // Evaluate midway into preview (3750ms = frame 90): right arm rotated -30 deg!
    const evalPreview = evaluateStageAtFrame(merged, { ch_full: fullChar }, 90, 24);
    const rarm = evalPreview.characters[0].parts.find((p) => p.slot_id === 's_rarm');
    expect(rarm?.transform.rotation_deg).toBeCloseTo(-30, 0);
  });
});
