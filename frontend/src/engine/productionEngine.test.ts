import { describe, expect, it } from 'vitest';
import {
  applyProductionPlanToTimeline,
  approveAllProductionShots,
  assignShotAudioSound,
  assignShotBackgroundAsset,
  assignShotCharacterLibrary,
  buildTimelineApplyPreview,
  editProductionShotPlan,
  evaluateShotPlanReadiness,
  isSoundLicenseSafe,
  toggleLockProductionShot,
  updateShotAnimationCategory,
  updateShotCameraMovementPlan,
} from '@/engine/productionEngine';
import type {
  Asset,
  Character,
  ProductionPlanDocument,
  ProductionShotPlan,
  ProjectState,
  SoundAsset,
} from '@/types/models';

function makeRigCharacter(id: string, name: string, withClosedEyes = true): Character {
  return {
    character_id: id,
    name,
    description: 'Test rig',
    tags: [],
    identity_confirmed: true,
    thumbnail_asset_id: null,
    voice_profile_id: null,
    version: 1,
    parts: [
      {
        slot_id: 'slot_body',
        name: 'Body',
        part_role: 'body',
        parent_slot_id: null,
        z_index: 1,
        visible: true,
        anchor_x: 0.5,
        anchor_y: 0.5,
        default_transform: { x: 0, y: 0, rotation_deg: 0, scale_x: 1, scale_y: 1, opacity: 1 },
        default_asset_id: 'ast_body',
        variants: {},
      },
      {
        slot_id: 'slot_head',
        name: 'Head',
        part_role: 'head',
        parent_slot_id: 'slot_body',
        z_index: 2,
        visible: true,
        anchor_x: 0.5,
        anchor_y: 0.8,
        default_transform: { x: 0, y: -60, rotation_deg: 0, scale_x: 1, scale_y: 1, opacity: 1 },
        default_asset_id: 'ast_head',
        variants: {},
      },
      {
        slot_id: 'slot_arm',
        name: 'Right Arm',
        part_role: 'right_arm',
        parent_slot_id: 'slot_body',
        z_index: 3,
        visible: true,
        anchor_x: 0.2,
        anchor_y: 0.2,
        default_transform: { x: 30, y: -20, rotation_deg: 0, scale_x: 1, scale_y: 1, opacity: 1 },
        default_asset_id: 'ast_arm',
        variants: {},
      },
      {
        slot_id: 'slot_eyes',
        name: 'Eyes',
        part_role: 'eyes',
        parent_slot_id: 'slot_head',
        z_index: 4,
        visible: true,
        anchor_x: 0.5,
        anchor_y: 0.5,
        default_transform: { x: 0, y: -10, rotation_deg: 0, scale_x: 1, scale_y: 1, opacity: 1 },
        default_asset_id: 'ast_eyes_open',
        variants: withClosedEyes ? { open: 'ast_eyes_open', closed: 'ast_eyes_closed' } : { open: 'ast_eyes_open' },
      },
    ],
    expressions: [],
    poses: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

function makeBgAsset(id: string, name: string): Asset {
  return {
    asset_id: id,
    scope: 'global',
    project_id: null,
    name,
    type: 'background',
    part_role: null,
    folder: 'city',
    file_path: `/assets/${id}.png`,
    sha256: `sha_${id}`,
    width: 1920,
    height: 1080,
    default_anchor: { x: 0.5, y: 0.5 },
    version: 1,
    identity_verified: true,
    tags: ['alley', 'rain'],
    created_at: '2026-01-01T00:00:00Z',
  };
}

function makeSound(id: string, name: string, verified: boolean, audioType: 'sfx' | 'bgm' = 'sfx'): SoundAsset {
  return {
    sound_id: id,
    name,
    audio_type: audioType,
    category: audioType === 'bgm' ? 'dramatic' : 'rain',
    file_path: `/sounds/${id}.wav`,
    sha256: `sha_${id}`,
    duration_ms: 2000,
    sample_rate: 44100,
    channels: 2,
    codec: 'pcm_s16le',
    default_volume: 0.8,
    loopable: audioType === 'bgm',
    fade_in_ms: 0,
    fade_out_ms: 0,
    tags: ['rain'],
    is_favorite: false,
    is_bundled: verified,
    waveform_peaks: [],
    license: {
      source: verified ? 'cc0' : 'custom',
      usage: verified ? 'verified' : 'unverified',
      attribution: '',
      notes: '',
    },
    created_at: '2026-01-01T00:00:00Z',
  };
}

function makeShotPlan(overrides: Partial<ProductionShotPlan> = {}): ProductionShotPlan {
  return {
    production_shot_id: 'pshot_1',
    shot_id: 'shot_1',
    scene_id: 'scn_1',
    shot_order: 1,
    title: 'Alley Entrance',
    duration_ms: 3000,
    start_time_ms: 0,
    end_time_ms: 3000,
    readiness_status: 'ready',
    readiness_reasons: [],
    execution_capability: 'full',
    approval_status: 'approved',
    locked: false,
    characters: [
      {
        staging_id: 'stg_1',
        character_name: 'Minh Anh',
        character_analysis_id: 'ch_minh',
        library_character_id: 'char_minh',
        character_missing: false,
        rig_missing: false,
        visible: true,
        speaking: true,
        reacting: false,
        screen_position: 'left',
        relative_position: 'left foreground',
        depth_layer: 'midground',
        facing_direction: 'right',
        initial_pose: 'standing',
        initial_pose_id: null,
        final_pose: 'standing',
        final_pose_id: null,
        expression: 'tense',
        expression_id: null,
        action: 'Walks and waves',
        movement: 'walks forward',
        entrance: 'none',
        exit: 'none',
        suggestion_note: '',
      },
    ],
    background: {
      requirement_id: 'areq_bg',
      kind: 'background',
      label: 'Neon Rain Alley',
      query: 'rain alley',
      classification: 'existing_compatible',
      matched_asset_id: 'ast_alley',
      matched_asset_name: 'Neon Rain Alley',
      candidates: [],
      required: true,
      notes: '',
    },
    assets: [],
    initial_pose_summary: 'Standing',
    final_pose_summary: 'Standing',
    action_summary: 'Minh Anh walks under the neon awning.',
    animation_plans: [
      {
        action_plan_id: 'ap_1',
        character_name: 'Minh Anh',
        library_character_id: 'char_minh',
        category: 'walk',
        description: 'Walks into frame',
        supported: true,
        mapped_animation_state: 'WALKING',
        mapped_preset_id: 'walk_cycle',
        required_rig: true,
        required_parts: ['body'],
        missing_parts: [],
        parameters: {},
        estimated_duration_ms: 2200,
        unsupported_reason: '',
        manual_alternative: '',
      },
      {
        action_plan_id: 'ap_2',
        character_name: 'Minh Anh',
        library_character_id: 'char_minh',
        category: 'wave',
        description: 'Waves hand',
        supported: true,
        mapped_animation_state: 'IDLE',
        mapped_preset_id: 'part_wave',
        required_rig: true,
        required_parts: ['right_arm'],
        missing_parts: [],
        parameters: {},
        estimated_duration_ms: 1400,
        unsupported_reason: '',
        manual_alternative: '',
      },
    ],
    camera_plan: {
      shot_size: 'medium',
      camera_angle: 'eye_level',
      camera_movement: 'zoom_in',
      support_status: 'supported',
      support_note: 'Direct 2D zoom keyframes.',
      angle_note: 'Standard eye level.',
      start_framing: 'Medium framing',
      end_framing: 'Tighter framing',
      focus_target: 'Minh Anh',
      duration_ms: 3000,
      transition_out: 'cut',
      camera_plan: {
        start_x: 0,
        start_y: 0,
        start_zoom: 1,
        start_rotation_deg: 0,
        end_x: 0,
        end_y: 0,
        end_zoom: 1.2,
        end_rotation_deg: 0,
        easing: 'ease_in_out',
      },
      executable_on_timeline: true,
    },
    voice_subtitle_plans: [
      {
        item_plan_id: 'vs_1',
        item_type: 'dialogue',
        script_ref_id: 'it_1',
        script_entry_id: 'ent_1',
        speaker_name: 'Minh Anh',
        library_character_id: 'char_minh',
        text: 'Đừng đi tiếp nữa!',
        voice_audio_asset_id: null,
        voice_sound_id: null,
        subtitle_segment_id: null,
        spans_multiple_shots: false,
        sync_mode: 'estimated',
        start_offset_ms: 200,
        duration_ms: 1800,
        notes: '',
      },
    ],
    sfx_plans: [
      {
        audio_plan_id: 'aud_1',
        audio_type: 'sfx',
        category: 'rain',
        description: 'Rain drops',
        match_classification: 'existing_compatible',
        matched_sound_id: 'snd_rain',
        matched_sound_name: 'Rain Loop',
        license_verified: true,
        license_note: 'Verified CC0',
        candidates: [],
        offset_ms: 0,
        duration_ms: 2000,
        volume: 0.7,
        fade_in_ms: 100,
        fade_out_ms: 100,
        loop: false,
        notes: '',
      },
    ],
    bgm_plans: [],
    transition_out: 'cut',
    warnings: [],
    missing_dependencies: [],
    user_edited_fields: [],
    timeline_refs: {
      applied: false,
      applied_at: null,
      stage_scene_id: null,
      applied_start_ms: 0,
      applied_end_ms: 0,
      character_instance_ids: [],
      keyframe_ids: [],
      animation_clip_ids: [],
      sound_event_ids: [],
      subtitle_ids: [],
      skipped_operations: [],
    },
    ai_notes: '',
    ...overrides,
  };
}

function makeProject(planDoc: ProductionPlanDocument): ProjectState {
  return {
    meta: {
      project_id: 'proj_1',
      name: 'Test Comic',
      description: '',
      width: 1920,
      height: 1080,
      fps: 30,
      duration_ms: 10000,
      default_export_preset_id: 'preset_1080p_final',
      auto_save_enabled: true,
      schema_version: '6',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
    scenes: [
      {
        scene_id: 'scn_1',
        project_id: 'proj_1',
        order_index: 0,
        name: 'Scene 1',
        start_ms: 0,
        duration_ms: 6000,
        background_asset_id: null,
        background_color: '#14161A',
        transition_in: 'cut',
        transition_duration_ms: 300,
        camera_default: { x: 0, y: 0, zoom: 1, rotation_deg: 0 },
        characters: [],
        props: [],
      },
    ],
    timeline: {
      project_id: 'proj_1',
      fps: 30,
      total_duration_ms: 10000,
      tracks: [
        {
          track_id: 'trk_cam',
          project_id: 'proj_1',
          track_type: 'camera',
          name: 'Camera',
          target_ref_id: null,
          order_index: 1,
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
    production_plan: planDoc,
  };
}

describe('Phase 06 Batch 3 — Production Engine, Readiness & Safe Timeline Execution', () => {
  const libChar = makeRigCharacter('char_minh', 'Minh Anh', true);
  const libBg = makeBgAsset('ast_alley', 'Neon Rain Alley');
  const libRainSafe = makeSound('snd_rain', 'Rain Loop', true, 'sfx');
  const libCopyrightUnsafe = makeSound('snd_unsafe', 'Copyrighted Song', false, 'bgm');
  const libCtx = {
    characters: [libChar],
    assets: [libBg],
    sounds: [libRainSafe, libCopyrightUnsafe],
  };

  it('validates real readiness states including missing char, deleted asset, unverified audio & unsupported anim/camera', () => {
    // 1. Fully ready shot
    const readyShot = evaluateShotPlanReadiness(makeShotPlan(), libCtx);
    expect(readyShot.readiness_status).toBe('ready');
    expect(readyShot.execution_capability).toBe('full');
    expect(readyShot.missing_dependencies).toHaveLength(0);

    // 2. Deleted/missing background asset -> needs_assets & clears stale ID
    const missingBg = evaluateShotPlanReadiness(
      makeShotPlan({
        background: {
          ...makeShotPlan().background!,
          matched_asset_id: 'ast_deleted_nonexistent',
        },
      }),
      libCtx,
    );
    expect(missingBg.readiness_status).toBe('needs_assets');
    expect(missingBg.background?.matched_asset_id).toBeNull();

    // 3. Unverified audio license is strictly rejected
    expect(isSoundLicenseSafe(libRainSafe)).toBe(true);
    expect(isSoundLicenseSafe(libCopyrightUnsafe)).toBe(false);
    const unsafeAudioShot = evaluateShotPlanReadiness(
      makeShotPlan({
        bgm_plans: [
          {
            ...makeShotPlan().sfx_plans[0],
            audio_plan_id: 'aud_bgm_1',
            audio_type: 'bgm',
            matched_sound_id: 'snd_unsafe',
            license_verified: true,
          },
        ],
      }),
      libCtx,
    );
    expect(unsafeAudioShot.bgm_plans[0].matched_sound_id).toBeNull();
    expect(unsafeAudioShot.bgm_plans[0].license_verified).toBe(false);
    expect(unsafeAudioShot.readiness_status).toBe('needs_audio');

    // 4. Unsupported animation (attack) + unsupported camera (parallax) -> unsupported!
    const unsupportedShot = evaluateShotPlanReadiness(
      makeShotPlan({
        animation_plans: [{ ...makeShotPlan().animation_plans[0], category: 'attack' }],
        camera_plan: { ...makeShotPlan().camera_plan, camera_movement: 'parallax' },
      }),
      libCtx,
    );
    expect(unsupportedShot.readiness_status).toBe('unsupported');
    expect(unsupportedShot.camera_plan.executable_on_timeline).toBe(false);
    expect(unsupportedShot.animation_plans[0].supported).toBe(false);
  });

  it('tracks user_edited_fields, lock toggle, approval, and live inline character/asset/audio/camera/animation updates', () => {
    const baseShot = makeShotPlan({
      characters: [{ ...makeShotPlan().characters[0], library_character_id: null, character_missing: true }],
      background: { ...makeShotPlan().background!, matched_asset_id: null, classification: 'missing' },
    });
    let doc: ProductionPlanDocument = {
      plan_id: 'plan_1',
      version: 1,
      provider_id: 'openai',
      model: 'gpt-4o-mini',
      analysis_language: 'vi',
      status: 'generated',
      shots: [evaluateShotPlanReadiness(baseShot, libCtx)],
      scene_hashes: {},
      updated_at: '2026-01-01T00:00:00Z',
    };
    expect(doc.shots[0].readiness_status).toBe('needs_character');

    // Assign real Character Library rig -> moves from needs_character to needs_assets
    doc = assignShotCharacterLibrary(doc, 'pshot_1', 'stg_1', libChar, libCtx);
    expect(doc.shots[0].readiness_status).toBe('needs_assets');
    expect(doc.shots[0].user_edited_fields).toContain('characters');

    // Assign real Background asset -> becomes READY!
    doc = assignShotBackgroundAsset(doc, 'pshot_1', libBg, libCtx);
    expect(doc.shots[0].readiness_status).toBe('ready');

    // Attempt to assign unverified copyright audio -> blocked cleanly!
    doc = assignShotAudioSound(doc, 'pshot_1', 'sfx', 'aud_1', libCopyrightUnsafe, libCtx);
    expect(doc.shots[0].sfx_plans[0].matched_sound_id).toBeNull();
    // Re-assign verified audio -> ready again!
    doc = assignShotAudioSound(doc, 'pshot_1', 'sfx', 'aud_1', libRainSafe, libCtx);
    expect(doc.shots[0].sfx_plans[0].matched_sound_id).toBe('snd_rain');

    // Switch camera movement to parallax -> needs_camera_setup; back to pan_right -> ready
    doc = updateShotCameraMovementPlan(doc, 'pshot_1', 'parallax', libCtx);
    expect(doc.shots[0].readiness_status).toBe('needs_camera_setup');
    doc = updateShotCameraMovementPlan(doc, 'pshot_1', 'pan_right', libCtx);
    expect(doc.shots[0].readiness_status).toBe('ready');

    // Switch animation category to fall -> needs_animation; to look -> ready (has head slot)
    doc = updateShotAnimationCategory(doc, 'pshot_1', 'ap_1', 'fall', libCtx);
    expect(doc.shots[0].readiness_status).toBe('needs_animation');
    doc = updateShotAnimationCategory(doc, 'pshot_1', 'ap_1', 'look', libCtx);
    expect(doc.shots[0].readiness_status).toBe('ready');
    expect(doc.shots[0].animation_plans[0].mapped_preset_id).toBe('part_look');

    // Lock, edit notes & approve all
    doc = toggleLockProductionShot(doc, 'pshot_1', true);
    expect(doc.shots[0].locked).toBe(true);
    doc = editProductionShotPlan(doc, 'pshot_1', { ai_notes: 'Keep close timing' }, libCtx);
    expect(doc.shots[0].user_edited_fields).toContain('ai_notes');
    doc = approveAllProductionShots(doc);
    expect(doc.shots[0].approval_status).toBe('approved');
  });

  it('executes idempotently on Timeline with ZERO duplicate clips/keyframes/subtitles/characters across repeated applications', () => {
    const doc: ProductionPlanDocument = {
      plan_id: 'plan_idem',
      version: 1,
      provider_id: 'openai',
      model: 'gpt-4o-mini',
      analysis_language: 'vi',
      status: 'generated',
      shots: [makeShotPlan()],
      scene_hashes: {},
      updated_at: '2026-01-01T00:00:00Z',
    };
    const project = makeProject(doc);

    // Apply #1
    const res1 = applyProductionPlanToTimeline(project, {
      targetShotIds: ['pshot_1'],
      strategy: 'update_owned_only',
      ...libCtx,
    });
    expect(res1.appliedShots).toBe(1);
    expect(res1.charactersPlaced).toBe(1);
    expect(res1.keyframesCreated).toBeGreaterThan(5);
    expect(res1.animationClipsCreated).toBe(2);
    expect(res1.audioClipsCreated).toBe(1);
    expect(res1.subtitlesCreated).toBe(1);

    const kfsAfter1 = project.timeline.keyframes.length;
    const clipsAfter1 = project.timeline.animation_clips.length;
    const soundsAfter1 = project.timeline.sound_events.length;
    const subsAfter1 = project.subtitles!.segments.length;
    const charsAfter1 = project.scenes[0].characters.length;

    // Preview before Apply #2 must report 0 conflicts because all items are owned by pshot_1!
    const pv2 = buildTimelineApplyPreview(project, project.production_plan!.shots, libCtx);
    expect(pv2.total_conflicts).toBe(0);
    expect(pv2.shots[0].is_reapply).toBe(true);

    // Apply #2 — exact same counts, ZERO duplicates!
    const res2 = applyProductionPlanToTimeline(project, {
      targetShotIds: ['pshot_1'],
      strategy: 'update_owned_only',
      ...libCtx,
    });
    expect(res2.appliedShots).toBe(1);
    expect(project.timeline.keyframes.length).toBe(kfsAfter1);
    expect(project.timeline.animation_clips.length).toBe(clipsAfter1);
    expect(project.timeline.sound_events.length).toBe(soundsAfter1);
    expect(project.subtitles!.segments.length).toBe(subsAfter1);
    expect(project.scenes[0].characters.length).toBe(charsAfter1);
  });

  it('detects conflicts with pre-existing user Timeline content and honors skip_conflicting & append_after_existing without overwriting', () => {
    const doc: ProductionPlanDocument = {
      plan_id: 'plan_conf',
      version: 1,
      provider_id: 'openai',
      model: 'gpt-4o-mini',
      analysis_language: 'en',
      status: 'generated',
      shots: [makeShotPlan()],
      scene_hashes: {},
      updated_at: '2026-01-01T00:00:00Z',
    };
    const project = makeProject(doc);
    // Pre-existing user camera keyframe at 1000ms (NOT owned by production plan)
    project.timeline.keyframes.push({
      keyframe_id: 'user_kf_1',
      track_id: 'trk_cam',
      target_type: 'camera',
      target_id: 'camera',
      property: 'zoom',
      time_ms: 1000,
      value: 1.5,
      easing: 'linear',
    });

    const preview = buildTimelineApplyPreview(project, doc.shots, libCtx);
    expect(preview.total_conflicts).toBe(1);
    expect(preview.shots[0].conflicts[0].kind).toBe('camera_keyframe');
    expect(preview.suggested_strategy).toBe('skip_conflicting');

    // Strategy 1: skip_conflicting -> skips shot and keeps user_kf_1 untouched
    const skipRes = applyProductionPlanToTimeline(project, {
      targetShotIds: ['pshot_1'],
      strategy: 'skip_conflicting',
      ...libCtx,
    });
    expect(skipRes.appliedShots).toBe(0);
    expect(skipRes.skippedConflictingShots).toBe(1);
    expect(project.timeline.keyframes.map((k) => k.keyframe_id)).toEqual(['user_kf_1']);

    // Strategy 2: append_after_existing -> places after 1000ms and preserves user_kf_1!
    const appendRes = applyProductionPlanToTimeline(project, {
      targetShotIds: ['pshot_1'],
      strategy: 'append_after_existing',
      ...libCtx,
    });
    expect(appendRes.appliedShots).toBe(1);
    expect(project.timeline.keyframes.some((k) => k.keyframe_id === 'user_kf_1')).toBe(true);
    expect(project.production_plan!.shots[0].timeline_refs.applied_start_ms).toBe(1000);
  });

  it('partially executes supported operations while honestly skipping unsupported animations & parallax camera', () => {
    const partialShot = evaluateShotPlanReadiness(
      makeShotPlan({
        animation_plans: [
          makeShotPlan().animation_plans[0], // supported walk
          {
            ...makeShotPlan().animation_plans[1],
            action_plan_id: 'ap_attack',
            category: 'attack',
            supported: false,
            mapped_animation_state: null,
            mapped_preset_id: null,
            unsupported_reason: 'Combat attack choreography unsupported',
          },
        ],
        camera_plan: {
          ...makeShotPlan().camera_plan,
          camera_movement: 'parallax',
        },
      }),
      libCtx,
    );
    const project = makeProject({
      plan_id: 'plan_partial',
      version: 1,
      provider_id: 'openai',
      model: 'gpt-4o-mini',
      analysis_language: 'en',
      status: 'generated',
      shots: [partialShot],
      scene_hashes: {},
      updated_at: '2026-01-01T00:00:00Z',
    });

    const res = applyProductionPlanToTimeline(project, {
      targetShotIds: ['pshot_1'],
      strategy: 'update_owned_only',
      ...libCtx,
    });
    expect(res.appliedShots).toBe(1);
    expect(res.animationClipsCreated).toBe(1); // Only supported walk applied!
    expect(res.skippedUnsupportedCount).toBe(2); // attack + parallax honestly skipped!
    expect(project.timeline.keyframes.some((k) => k.target_type === 'camera')).toBe(false);
    expect(project.production_plan!.shots[0].timeline_refs.skipped_operations).toHaveLength(2);
  });
});
