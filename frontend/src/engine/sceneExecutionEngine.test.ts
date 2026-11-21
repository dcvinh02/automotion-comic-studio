import { describe, expect, it } from 'vitest';
import { evaluateStageAtFrame } from '@/engine/evaluator';
import {
  editSceneShotState,
  findActiveShotInScene,
  syncCharacterEditIntoActiveShot,
  syncPropEditIntoActiveShot,
} from '@/engine/sceneExecutionEngine';
import type { Character, ProjectState, Scene } from '@/types/models';

function makeChar(id: string, name: string): Character {
  return {
    character_id: id,
    name,
    description: '',
    tags: [],
    identity_confirmed: true,
    thumbnail_asset_id: null,
    voice_profile_id: null,
    version: 1,
    parts: [
      {
        slot_id: 's_body',
        name: 'Body',
        part_role: 'body',
        parent_slot_id: null,
        default_asset_id: 'ast_body',
        variants: {},
        z_index: 1,
        anchor_x: 0.5,
        anchor_y: 0.5,
        default_transform: { x: 0, y: 0, rotation_deg: 0, scale_x: 1, scale_y: 1, opacity: 1 },
        visible: true,
      },
    ],
    expressions: [],
    poses: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

function makeProjectWithTwoIsolatedShots(): ProjectState {
  const scene: Scene = {
    scene_id: 'scn_1',
    project_id: 'proj_1',
    order_index: 0,
    name: 'Scene 1',
    start_ms: 0,
    duration_ms: 6000,
    background_asset_id: 'ast_bg_default',
    background_color: '#14161A',
    transition_in: 'cut',
    transition_duration_ms: 0,
    camera_default: { x: 0, y: 0, zoom: 1, rotation_deg: 0 },
    characters: [
      {
        instance_id: 'exec_char_minh',
        scene_id: 'scn_1',
        character_id: 'char_minh',
        display_name: 'Minh Anh',
        z_index: 14,
        visible: true,
        locked: false,
        initial_transform: { x: 400, y: 600, rotation_deg: 0, scale_x: 1, scale_y: 1, opacity: 1 },
        default_expression_id: null,
        default_pose_id: null,
        default_eye_state: 'open',
        default_mouth_state: 'closed',
      },
      {
        instance_id: 'exec_char_tuan',
        scene_id: 'scn_1',
        character_id: 'char_tuan',
        display_name: 'Tuấn Anh',
        z_index: 15,
        visible: true,
        locked: false,
        initial_transform: { x: 1200, y: 600, rotation_deg: 0, scale_x: -1, scale_y: 1, opacity: 1 },
        default_expression_id: null,
        default_pose_id: null,
        default_eye_state: 'open',
        default_mouth_state: 'closed',
      },
    ],
    props: [
      {
        prop_instance_id: 'exec_prop_lantern',
        asset_id: 'ast_lantern',
        layer_kind: 'prop',
        name: 'Lantern',
        z_index: 12,
        visible: true,
        locked: false,
        transform: { x: 300, y: 500, rotation_deg: 0, scale_x: 1, scale_y: 1, opacity: 1 },
      },
      {
        prop_instance_id: 'exec_prop_umbrella',
        asset_id: 'ast_umbrella',
        layer_kind: 'prop',
        name: 'Umbrella',
        z_index: 28,
        visible: true,
        locked: false,
        transform: { x: 1400, y: 700, rotation_deg: 0, scale_x: 1, scale_y: 1, opacity: 1 },
      },
      {
        // Unrelated user-created prop (NOT in execution_meta.owned_prop_instance_ids) -> must stay visible in ALL shots!
        prop_instance_id: 'user_prop_logo',
        asset_id: 'ast_logo',
        layer_kind: 'prop',
        name: 'User Logo',
        z_index: 50,
        visible: true,
        locked: false,
        transform: { x: 100, y: 80, rotation_deg: 0, scale_x: 1, scale_y: 1, opacity: 1 },
      },
    ],
    execution_meta: {
      executed: true,
      production_plan_id: 'plan_1',
      source_scene_id: 'scn_1',
      executed_at: '2026-01-01T00:00:00Z',
      owned_shot_ids: ['exec_shot_1', 'exec_shot_2'],
      owned_character_instance_ids: ['exec_char_minh', 'exec_char_tuan'],
      owned_prop_instance_ids: ['exec_prop_lantern', 'exec_prop_umbrella'],
      execution_warnings: [],
    },
    shots: [
      {
        shot_id: 'exec_shot_1',
        scene_id: 'scn_1',
        production_shot_id: 'ps_1',
        storyboard_shot_id: 'sb_1',
        shot_order: 1,
        title: 'Shot 1 — Rain Alley',
        start_ms: 0,
        duration_ms: 3000,
        background_asset_id: 'ast_bg_alley',
        camera_default: { x: -40, y: 0, zoom: 1.0, rotation_deg: 0 },
        character_states: [
          {
            instance_id: 'exec_char_minh',
            character_id: 'char_minh',
            display_name: 'Minh Anh',
            visible: true,
            z_index: 14,
            transform: { x: 350, y: 620, rotation_deg: 0, scale_x: 1, scale_y: 1, opacity: 1 },
            facing_direction: 'right',
            screen_position: 'left',
            depth_layer: 'midground',
            pose_id: 'pose_stand',
            expression_id: 'expr_calm',
            animation_state: 'WALKING',
            staging_fallback_used: false,
            staging_fallback_reason: '',
          },
        ],
        prop_states: [
          {
            prop_instance_id: 'exec_prop_lantern',
            asset_id: 'ast_lantern',
            name: 'Lantern',
            role: 'prop',
            visible: true,
            z_index: 12,
            transform: { x: 260, y: 520, rotation_deg: 0, scale_x: 0.8, scale_y: 0.8, opacity: 1 },
          },
        ],
        asset_refs: ['ast_bg_alley', 'ast_lantern'],
        animation_refs: [],
        execution_status: 'assembled',
        warnings: [],
        staging_fallbacks: [],
      },
      {
        shot_id: 'exec_shot_2',
        scene_id: 'scn_1',
        production_shot_id: 'ps_2',
        storyboard_shot_id: 'sb_2',
        shot_order: 2,
        title: 'Shot 2 — Rooftop Confrontation',
        start_ms: 3000,
        duration_ms: 3000,
        background_asset_id: 'ast_bg_rooftop',
        camera_default: { x: 80, y: -20, zoom: 1.35, rotation_deg: 4 },
        character_states: [
          {
            instance_id: 'exec_char_minh',
            character_id: 'char_minh',
            display_name: 'Minh Anh',
            visible: true,
            z_index: 22,
            transform: { x: 760, y: 660, rotation_deg: 0, scale_x: 1.14, scale_y: 1.14, opacity: 1 },
            facing_direction: 'right',
            screen_position: 'center_left',
            depth_layer: 'foreground',
            pose_id: 'pose_alert',
            expression_id: 'expr_tense',
            animation_state: 'SPEAKING',
            staging_fallback_used: false,
            staging_fallback_reason: '',
          },
          {
            instance_id: 'exec_char_tuan',
            character_id: 'char_tuan',
            display_name: 'Tuấn Anh',
            visible: true,
            z_index: 15,
            transform: { x: 1380, y: 600, rotation_deg: 0, scale_x: -1, scale_y: 1, opacity: 1 },
            facing_direction: 'left',
            screen_position: 'right',
            depth_layer: 'midground',
            pose_id: null,
            expression_id: null,
            animation_state: 'IDLE',
            staging_fallback_used: false,
            staging_fallback_reason: '',
          },
        ],
        prop_states: [
          {
            prop_instance_id: 'exec_prop_umbrella',
            asset_id: 'ast_umbrella',
            name: 'Umbrella',
            role: 'foreground',
            visible: true,
            z_index: 28,
            transform: { x: 1450, y: 740, rotation_deg: -10, scale_x: 1, scale_y: 1, opacity: 1 },
          },
        ],
        asset_refs: ['ast_bg_rooftop', 'ast_umbrella'],
        animation_refs: [],
        execution_status: 'assembled',
        warnings: [],
        staging_fallbacks: [],
      },
    ],
  };

  return {
    meta: {
      project_id: 'proj_1',
      name: 'Shot Isolation Test',
      description: '',
      schema_version: '7',
      width: 1920,
      height: 1080,
      fps: 30,
      duration_ms: 6000,
      default_export_preset_id: 'preset_1080p_final',
      auto_save_enabled: true,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
    scenes: [scene],
    timeline: {
      project_id: 'proj_1',
      fps: 30,
      total_duration_ms: 6000,
      tracks: [],
      keyframes: [],
      animation_clips: [],
      sound_events: [],
    },
  };
}

describe('Phase 07 Batch 1 — Shot State Isolation & Canvas Sync Engine', () => {
  const charsById = {
    char_minh: makeChar('char_minh', 'Minh Anh'),
    char_tuan: makeChar('char_tuan', 'Tuấn Anh'),
  };

  it('resolves exact active shot by timestamp and isolates background, camera, characters & props without leakage', () => {
    const project = makeProjectWithTwoIsolatedShots();

    // Frame 15 -> 500ms (Shot 1)
    const st1 = evaluateStageAtFrame(project, charsById, 15, 30);
    expect(st1.activeShot?.shot_id).toBe('exec_shot_1');
    expect(st1.effectiveBackgroundAssetId).toBe('ast_bg_alley');
    expect(st1.camera).toEqual({ x: -40, y: 0, zoom: 1.0, rotation_deg: 0 });

    const minh1 = st1.characters.find((c) => c.instance_id === 'exec_char_minh')!;
    const tuan1 = st1.characters.find((c) => c.instance_id === 'exec_char_tuan')!;
    expect(minh1.visible).toBe(true);
    expect(minh1.transform.x).toBe(350);
    expect(minh1.z_index).toBe(14);
    expect(minh1.animation_state).toBe('WALKING');
    expect(tuan1.visible).toBe(false); // Tuấn Anh is NOT in Shot 1 -> isolated!

    const lantern1 = st1.props.find((p) => p.prop_instance_id === 'exec_prop_lantern')!;
    const umbrella1 = st1.props.find((p) => p.prop_instance_id === 'exec_prop_umbrella')!;
    const userLogo1 = st1.props.find((p) => p.prop_instance_id === 'user_prop_logo')!;
    expect(lantern1.visible).toBe(true);
    expect(umbrella1.visible).toBe(false); // Umbrella belongs only to Shot 2 -> isolated!
    expect(userLogo1.visible).toBe(true); // User-owned prop stays visible!

    // Frame 105 -> 3500ms (Shot 2)
    const st2 = evaluateStageAtFrame(project, charsById, 105, 30);
    expect(st2.activeShot?.shot_id).toBe('exec_shot_2');
    expect(st2.effectiveBackgroundAssetId).toBe('ast_bg_rooftop');
    expect(st2.camera).toEqual({ x: 80, y: -20, zoom: 1.35, rotation_deg: 4 });

    const minh2 = st2.characters.find((c) => c.instance_id === 'exec_char_minh')!;
    const tuan2 = st2.characters.find((c) => c.instance_id === 'exec_char_tuan')!;
    expect(minh2.visible).toBe(true);
    expect(minh2.transform.x).toBe(760);
    expect(minh2.z_index).toBe(22);
    expect(minh2.animation_state).toBe('SPEAKING');
    expect(tuan2.visible).toBe(true);
    expect(tuan2.transform.x).toBe(1380);

    const lantern2 = st2.props.find((p) => p.prop_instance_id === 'exec_prop_lantern')!;
    const umbrella2 = st2.props.find((p) => p.prop_instance_id === 'exec_prop_umbrella')!;
    const userLogo2 = st2.props.find((p) => p.prop_instance_id === 'user_prop_logo')!;
    expect(lantern2.visible).toBe(false); // Lantern belongs only to Shot 1 -> isolated!
    expect(umbrella2.visible).toBe(true);
    expect(userLogo2.visible).toBe(true); // User-owned prop preserved!
  });

  it('isolates Canvas transform/visibility edits into ONLY the active shot without mutating sibling shots', () => {
    const project = makeProjectWithTwoIsolatedShots();
    const scene = project.scenes[0];

    // Edit Minh Anh's position while Shot 1 is active
    const okChar = syncCharacterEditIntoActiveShot(scene, 'exec_shot_1', 'exec_char_minh', {
      initial_transform: { x: 488, y: 615, rotation_deg: 5, scale_x: 1, scale_y: 1, opacity: 1 },
    });
    expect(okChar).toBe(true);

    // Edit Lantern prop while Shot 1 is active
    const okProp = syncPropEditIntoActiveShot(scene, 'exec_shot_1', 'exec_prop_lantern', {
      transform: { x: 310, y: 505, rotation_deg: 12, scale_x: 0.9, scale_y: 0.9, opacity: 1 },
    });
    expect(okProp).toBe(true);

    // Shot 1 reflects new coordinates; Shot 2 remains 100% untouched!
    expect(scene.shots![0].character_states[0].transform.x).toBe(488);
    expect(scene.shots![0].prop_states[0].transform.x).toBe(310);
    expect(scene.shots![1].character_states[0].transform.x).toBe(760);
    expect(scene.shots![1].prop_states[0].transform.x).toBe(1450);

    // Editing Shot 1 duration cleanly repacks Shot 2 start_ms without losing Shot 2's identity
    expect(editSceneShotState(scene, 'exec_shot_1', { duration_ms: 4200, title: 'Edited Shot 1' })).toBe(true);
    expect(scene.shots![0].title).toBe('Edited Shot 1');
    expect(scene.shots![1].start_ms).toBe(4200);
    expect(scene.duration_ms).toBe(7200);
    expect(findActiveShotInScene(scene, 4100)?.shot_id).toBe('exec_shot_1');
    expect(findActiveShotInScene(scene, 4300)?.shot_id).toBe('exec_shot_2');
  });
});
