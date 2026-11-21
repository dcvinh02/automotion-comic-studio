import { describe, expect, it } from 'vitest';
import {
  addShotCharacterStaging,
  addStoryboardShot,
  analyzeStoryboardContinuity,
  deleteStoryboardShot,
  duplicateStoryboardShot,
  editStoryboardShot,
  ensureStoryboardDocument,
  evaluateCameraMovementSupport,
  markContinuityWarning,
  moveStoryboardShot,
  reconcileStageSceneDurationToShots,
  reorderStoryboardShotsInScene,
  restoreOriginalStoryboardShot,
  toggleLockStoryboardShot,
  updateShotCharacterStaging,
} from '@/engine/storyboardEngine';
import type { ProjectState, StoryboardDocument } from '@/types/models';

function buildFixtureStoryboard(): StoryboardDocument {
  let doc = ensureStoryboardDocument(null);
  const s1 = addStoryboardShot(doc, {
    sceneId: 'scn_1',
    title: 'Establishing Rain Alley',
    environment: 'Neon rain alley under awning',
  });
  doc = s1.doc;
  doc = editStoryboardShot(doc, s1.shotId, {
    shot_size: 'wide',
    camera_angle: 'eye_level',
    camera_movement: 'pan_right',
    duration_ms: 4200,
    characters: [
      {
        staging_id: 'stg_1',
        character_analysis_id: 'ch_1',
        library_character_id: 'lib_minh',
        character_name: 'Minh Anh',
        is_missing_asset: false,
        visible: true,
        speaking: true,
        reacting: false,
        screen_position: 'left',
        depth_layer: 'midground',
        facing_direction: 'right',
        action: 'Stands under awning warning Tuan',
        expression: 'worried',
        movement: '',
      },
    ],
  });
  // Attach AI snapshot for restore test
  doc.shots[0].original_ai_snapshot = {
    ...doc.shots[0],
    title: 'Original AI Alley Shot',
    original_ai_snapshot: undefined,
  };

  const s2 = addStoryboardShot(doc, {
    sceneId: 'scn_1',
    afterShotId: s1.shotId,
    title: 'Close-Up Warning',
    environment: 'Neon rain alley under awning',
  });
  doc = s2.doc;
  doc = editStoryboardShot(doc, s2.shotId, {
    shot_size: 'close_up',
    camera_angle: 'dutch_angle',
    camera_movement: 'zoom_in',
    duration_ms: 2800,
    characters: [
      {
        staging_id: 'stg_2',
        character_analysis_id: 'ch_1',
        library_character_id: 'lib_minh',
        character_name: 'Minh Anh',
        is_missing_asset: false,
        visible: true,
        speaking: true,
        reacting: false,
        screen_position: 'left',
        depth_layer: 'foreground',
        facing_direction: 'right',
        action: 'Speaks urgently',
        expression: 'urgent',
        movement: '',
      },
    ],
  });
  return doc;
}

describe('storyboardEngine — Camera Feasibility, Shot Editing, Continuity & Duration Reconciliation', () => {
  it('accurately classifies 2D executable, 2D approximation, and unsupported camera movements', () => {
    expect(evaluateCameraMovementSupport('static').status).toBe('supported');
    expect(evaluateCameraMovementSupport('pan_left').status).toBe('supported');
    expect(evaluateCameraMovementSupport('zoom_in').status).toBe('supported');
    expect(evaluateCameraMovementSupport('dolly_in').status).toBe('2d_approximation');
    expect(evaluateCameraMovementSupport('shake').status).toBe('2d_approximation');
    expect(evaluateCameraMovementSupport('camera_follow').status).toBe('2d_approximation');
    expect(evaluateCameraMovementSupport('parallax').status).toBe('unsupported_suggestion');
  });

  it('supports add, duplicate, reorder, move, lock, edit, delete, restore & recalculates relative timings', () => {
    let doc = buildFixtureStoryboard();
    expect(doc.shots.length).toBe(2);
    expect(doc.shots[0].start_time_ms).toBe(0);
    expect(doc.shots[0].end_time_ms).toBe(4200);
    expect(doc.shots[1].start_time_ms).toBe(4200);
    expect(doc.shots[1].end_time_ms).toBe(7000);

    // Duplicate Shot 1
    const dup = duplicateStoryboardShot(doc, doc.shots[0].shot_id);
    expect(dup).not.toBeNull();
    doc = dup!.doc;
    expect(doc.shots.length).toBe(3);
    expect(doc.shots[1].title).toContain('(Copy)');
    expect(doc.shots[2].start_time_ms).toBe(8400);

    // Lock Shot 1
    doc = toggleLockStoryboardShot(doc, doc.shots[0].shot_id, true);
    expect(doc.shots[0].locked).toBe(true);

    // Move Shot 2 down to position 3
    const moved = moveStoryboardShot(doc, doc.shots[1].shot_id, 1);
    expect(moved).not.toBeNull();
    doc = moved!;
    expect(doc.shots[2].shot_id).toBe(dup!.createdShotId);
    expect(doc.shots[2].shot_order).toBe(3);

    // Reorder Shot 3 before Shot 1
    const reordered = reorderStoryboardShotsInScene(doc, doc.shots[2].shot_id, doc.shots[0].shot_id, 'before');
    expect(reordered).not.toBeNull();
    doc = reordered!;
    expect(doc.shots[0].shot_id).toBe(dup!.createdShotId);
    expect(doc.shots[0].shot_order).toBe(1);

    // Edit camera movement to parallax -> immediately marks unsupported_suggestion
    const origShot1Id = doc.shots[1].shot_id;
    doc = editStoryboardShot(doc, origShot1Id, { camera_movement: 'parallax', duration_ms: 5100 });
    expect(doc.shots[1].camera_support_status).toBe('unsupported_suggestion');
    expect(doc.shots[1].user_edited_fields).toContain('camera_movement');
    expect(doc.shots[1].user_edited_fields).toContain('duration_ms');

    // Restore Shot 1 from original AI snapshot
    doc = restoreOriginalStoryboardShot(doc, origShot1Id);
    expect(doc.shots[1].title).toBe('Original AI Alley Shot');
    expect(doc.shots[1].user_edited_fields).toEqual([]);

    // Delete duplicated shot
    doc = deleteStoryboardShot(doc, dup!.createdShotId);
    expect(doc.shots.length).toBe(2);
    expect(doc.shots[0].shot_order).toBe(1);
    expect(doc.shots[1].shot_order).toBe(2);
  });

  it('detects position jump, facing flip, exit mismatch, and missing character asset continuity warnings', () => {
    let doc = buildFixtureStoryboard();
    const sh2Id = doc.shots[1].shot_id;

    // 1. Introduce sudden position jump (left -> right) & facing flip (right -> left) with NO movement/turn
    doc = updateShotCharacterStaging(doc, sh2Id, 'stg_2', {
      screen_position: 'right',
      facing_direction: 'left',
      action: 'Stands still',
      movement: '',
    });

    // 2. Stage an unlinked character (missing asset) + hidden reacting character
    doc = addShotCharacterStaging(doc, sh2Id, {
      characterName: 'Mysterious Stranger',
      libraryCharacterId: null,
    });
    const strangerStg = doc.shots[1].characters.find((c) => c.character_name === 'Mysterious Stranger')!;
    doc = updateShotCharacterStaging(doc, sh2Id, strangerStg.staging_id, {
      visible: false,
      reacting: true,
    });

    const warns = analyzeStoryboardContinuity(doc.shots);
    const cats = warns.map((w) => w.category);
    expect(cats).toContain('position_jump');
    expect(cats).toContain('facing_flip');
    expect(cats).toContain('missing_character_asset');
    expect(cats).toContain('reaction_missing_character');

    // Review / dismiss flag persists cleanly
    const posWarn = warns.find((w) => w.category === 'position_jump')!;
    doc = markContinuityWarning(doc, posWarn.warning_id, { reviewed: true, dismissed: true });
    const rechecked = analyzeStoryboardContinuity(doc.shots, doc.continuity_warnings);
    expect(rechecked.find((w) => w.warning_id === posWarn.warning_id)?.dismissed).toBe(true);

    // Adding an explicit crossing + turning action clears position_jump & facing_flip cleanly!
    doc = updateShotCharacterStaging(doc, sh2Id, 'stg_2', {
      action: 'Turns back and crosses the alley',
      movement: 'walks to right side',
    });
    const afterFixCats = doc.continuity_warnings.map((w) => w.category);
    expect(afterFixCats).not.toContain('position_jump');
    expect(afterFixCats).not.toContain('facing_flip');
  });

  it('reconciles Stage Scene duration to storyboard shots without altering raw script or other scenes', () => {
    const doc = buildFixtureStoryboard(); // 4200 + 2800 = 7000ms for scn_1
    const project: ProjectState = {
      meta: {
        project_id: 'proj_sb',
        name: 'Storyboard Duration Sync',
        description: '',
        schema_version: '0.1.0',
        width: 1920,
        height: 1080,
        fps: 30,
        duration_ms: 15000,
        default_export_preset_id: 'preset_1080p_final',
        auto_save_enabled: true,
        created_at: '2026-11-21T00:00:00Z',
        updated_at: '2026-11-21T00:00:00Z',
      },
      scenes: [
        {
          scene_id: 'scn_1',
          project_id: 'proj_sb',
          order_index: 0,
          name: 'Scene 1',
          start_ms: 0,
          duration_ms: 10000,
          background_asset_id: null,
          background_color: '#111317',
          transition_in: 'cut',
          transition_duration_ms: 0,
          camera_default: { x: 0, y: 0, zoom: 1, rotation_deg: 0 },
          characters: [],
          props: [],
        },
        {
          scene_id: 'scn_2',
          project_id: 'proj_sb',
          order_index: 1,
          name: 'Scene 2',
          start_ms: 10000,
          duration_ms: 5000,
          background_asset_id: null,
          background_color: '#111317',
          transition_in: 'fade',
          transition_duration_ms: 500,
          camera_default: { x: 0, y: 0, zoom: 1, rotation_deg: 0 },
          characters: [],
          props: [],
        },
      ],
      timeline: {
        project_id: 'proj_sb',
        fps: 30,
        total_duration_ms: 15000,
        tracks: [],
        keyframes: [],
        animation_clips: [],
        sound_events: [],
      },
      script: {
        episode_title: 'Ep 1',
        raw_source_text: 'Original script untouched.',
        scenes: [],
        updated_at: '2026-11-21T00:00:00Z',
      },
      storyboard: doc,
    };

    const res = reconcileStageSceneDurationToShots(project, 'scn_1');
    expect(res.updated).toBe(true);
    expect(res.newDurationMs).toBe(7000);
    expect(project.scenes[0].duration_ms).toBe(7000);
    expect(project.scenes[1].start_ms).toBe(7000);
    expect(project.script?.raw_source_text).toBe('Original script untouched.');
  });
});
