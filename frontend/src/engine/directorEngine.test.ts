import { describe, expect, it } from 'vitest';
import {
  acceptAllScenesInDoc,
  applyAcceptedScenesToProjectState,
  deleteSceneBreakdown,
  editExtractedCharacter,
  editSceneBreakdown,
  mergeExtractedCharacters,
  mergeSceneBreakdowns,
  moveSceneBreakdown,
  resolveExtractedItemSpeaker,
  restoreAllOriginalScenes,
  restoreOriginalSceneBreakdown,
  separateExtractedCharacterAlias,
  setSceneReviewStatus,
  splitSceneBreakdown,
} from '@/engine/directorEngine';
import type { DirectorAnalysisDocument, ProjectState } from '@/types/models';

function buildFixtureDoc(): DirectorAnalysisDocument {
  const sc1 = {
    scene_breakdown_id: 'sb_1',
    scene_number: 1,
    title: 'Alleyway Confrontation',
    source_paragraphs: [0, 1],
    source_text:
      'Rain hammers the neon alley as Minh Anh steps under the awning.\n\nMinh: "You should not be here tonight."',
    location: 'Neon Alleyway',
    time_of_day: 'Night',
    environment: 'Wet asphalt, neon signs',
    characters_present: ['Minh Anh', 'Lan'],
    character_entrances: ['Minh Anh'],
    character_exits: [],
    main_action: 'Minh Anh warns Lan in the pouring rain.',
    dialogue_item_ids: ['it_dlg_1'],
    narration_item_ids: ['it_nar_1'],
    emotional_beat: 'Tense warning',
    scene_purpose: 'Establish central danger',
    conflict: 'Minh Anh wants Lan to leave; Lan refuses.',
    visual_opportunities: ['Rain streaks on neon glass'],
    atmosphere: 'Noir suspense',
    suggested_duration_min_s: 8,
    suggested_duration_max_s: 14,
    importance: 'high' as const,
    transition_suggestion: 'Cross dissolve to rooftop',
    ai_confidence: 0.91,
    unresolved_questions: [],
    review_status: 'pending' as const,
    user_edited_fields: [],
    applied_script_scene_id: null,
    applied_stage_scene_id: null,
    original_ai_snapshot: null as Record<string, unknown> | null,
  };
  sc1.original_ai_snapshot = { ...sc1, original_ai_snapshot: undefined };

  const sc2 = {
    scene_breakdown_id: 'sb_2',
    scene_number: 2,
    title: 'Rooftop Reveal',
    source_paragraphs: [2],
    source_text: 'On the rooftop, a mysterious shadow drops the key. Silence falls over the city.',
    location: 'Rooftop',
    time_of_day: 'Midnight',
    environment: 'Windy skyline',
    characters_present: ['Lan'],
    character_entrances: ['Mysterious Shadow'],
    character_exits: ['Mysterious Shadow'],
    main_action: 'A shadowy figure leaves behind a key.',
    dialogue_item_ids: ['it_dlg_2'],
    narration_item_ids: ['it_nar_2'],
    emotional_beat: 'Mystery deepens',
    scene_purpose: 'Introduce inciting artifact',
    conflict: 'Unknown ally or trap',
    visual_opportunities: ['Key glinting under moonlight'],
    atmosphere: 'Eerie quiet',
    suggested_duration_min_s: 6,
    suggested_duration_max_s: 10,
    importance: 'climax' as const,
    transition_suggestion: 'Fade to black',
    ai_confidence: 0.84,
    unresolved_questions: ['Who is the mysterious shadow?'],
    review_status: 'pending' as const,
    user_edited_fields: [],
    applied_script_scene_id: null,
    applied_stage_scene_id: null,
    original_ai_snapshot: null as Record<string, unknown> | null,
  };
  sc2.original_ai_snapshot = { ...sc2, original_ai_snapshot: undefined };

  return {
    analysis_id: 'dir_test_01',
    version: 1,
    script_source_mode: 'raw_text',
    source_script_hash: 'abc123',
    source_paragraphs: [
      'Rain hammers the neon alley as Minh Anh steps under the awning.',
      'Minh: "You should not be here tonight."',
      'On the rooftop, a mysterious shadow drops the key. Silence falls over the city.',
    ],
    provider_id: 'openai',
    model: 'gpt-4o-mini',
    analysis_language: 'auto',
    status: 'analyzed',
    analyzed_at: '2026-11-20T00:00:00Z',
    updated_at: '2026-11-20T00:00:00Z',
    story_overview: {
      title: 'Midnight Key',
      genre: 'Mystery',
      premise: 'A warning in the rain leads to a mysterious key.',
      synopsis: 'Minh Anh warns Lan, then a shadowy figure leaves a clue.',
      themes: ['Trust', 'Secrecy'],
      narrative_tone: 'Tense noir',
      story_structure: 'Mystery opening',
      structure_uncertainty: 'Short excerpt — full arc unresolved.',
      conflict: 'Hidden threat in the city',
      turning_points: ['Key dropped on rooftop'],
      climax: 'Rooftop reveal',
      ending: 'Cliffhanger',
      narrative_beats: [],
    },
    production_analysis: {
      visual_opportunities: ['Neon puddles'],
      action_moments: ['Key drop'],
      emotional_beats: ['Warning'],
      dramatic_pauses: ['Silence falls'],
      establishing_shots: ['Wide neon alley'],
      environmental_details: ['Rain'],
      transition_ideas: ['Rain wipe'],
      vfx_scenes: ['Rain streaks'],
    },
    characters: [
      {
        character_analysis_id: 'ch_1',
        canonical_name: 'Minh Anh',
        aliases: ['Minh', 'Anh'],
        ambiguous_aliases: ['Anh'],
        role: 'Protector',
        personality: 'Cautious',
        appearance_description: 'unspecified',
        appearance_specified: false,
        relationships: [
          {
            target_character_analysis_id: 'ch_2',
            target_name: 'Lan',
            relationship_type: 'Ally',
            description: 'Tries to keep Lan safe',
          },
        ],
        narrative_importance: 'main',
        dialogue_item_ids: ['it_dlg_1'],
        emotional_states: ['Worried'],
        actions: ['Steps under awning'],
        first_appearance_paragraph: 0,
        last_appearance_paragraph: 1,
        linked_character_id: 'lib_char_minh',
        review_status: 'pending',
        user_edited_fields: [],
        confidence: 0.92,
        notes: '',
      },
      {
        character_analysis_id: 'ch_2',
        canonical_name: 'Lan',
        aliases: [],
        ambiguous_aliases: [],
        role: 'Investigator',
        personality: 'Determined',
        appearance_description: 'unspecified',
        appearance_specified: false,
        relationships: [],
        narrative_importance: 'main',
        dialogue_item_ids: [],
        emotional_states: ['Defiant'],
        actions: [],
        first_appearance_paragraph: 1,
        last_appearance_paragraph: 2,
        linked_character_id: null,
        review_status: 'pending',
        user_edited_fields: [],
        confidence: 0.86,
        notes: '',
      },
      {
        character_analysis_id: 'ch_dup',
        canonical_name: 'Minh (Duplicate)',
        aliases: ['Cậu Minh'],
        ambiguous_aliases: [],
        role: '',
        personality: '',
        appearance_description: 'Dark raincoat',
        appearance_specified: true,
        relationships: [],
        narrative_importance: 'supporting',
        dialogue_item_ids: [],
        emotional_states: ['Guarded'],
        actions: ['Checks alley'],
        first_appearance_paragraph: 1,
        last_appearance_paragraph: 2,
        linked_character_id: null,
        review_status: 'pending',
        user_edited_fields: [],
        confidence: 0.7,
        notes: 'Possible duplicate',
      },
    ],
    extracted_items: [
      {
        item_id: 'it_nar_1',
        item_type: 'narration',
        original_text: 'Rain hammers the neon alley as Minh Anh steps under the awning.',
        speaker_character_analysis_id: null,
        speaker_name_raw: '',
        speaker_unresolved: false,
        scene_breakdown_id: 'sb_1',
        order_index: 0,
        paragraph_index: 0,
        language: 'en',
        emotion: 'tense',
        notes: '',
      },
      {
        item_id: 'it_dlg_1',
        item_type: 'dialogue',
        original_text: 'You should not be here tonight.',
        speaker_character_analysis_id: 'ch_1',
        speaker_name_raw: 'Minh',
        speaker_unresolved: false,
        scene_breakdown_id: 'sb_1',
        order_index: 1,
        paragraph_index: 1,
        language: 'en',
        emotion: 'urgent',
        notes: '',
      },
      {
        item_id: 'it_nar_2',
        item_type: 'narration',
        original_text: 'On the rooftop, a mysterious shadow drops the key. Silence falls over the city.',
        speaker_character_analysis_id: null,
        speaker_name_raw: '',
        speaker_unresolved: false,
        scene_breakdown_id: 'sb_2',
        order_index: 2,
        paragraph_index: 2,
        language: 'en',
        emotion: 'mysterious',
        notes: '',
      },
      {
        item_id: 'it_dlg_2',
        item_type: 'dialogue',
        original_text: 'Take this before sunrise.',
        speaker_character_analysis_id: null,
        speaker_name_raw: 'Voice',
        speaker_unresolved: true,
        scene_breakdown_id: 'sb_2',
        order_index: 3,
        paragraph_index: 2,
        language: 'en',
        emotion: 'whisper',
        notes: '',
      },
    ],
    scenes: [sc1, sc2],
    original_scenes_snapshot: [
      { ...sc1, original_ai_snapshot: undefined },
      { ...sc2, original_ai_snapshot: undefined },
    ],
    warnings: [],
    context_strategy_note: 'Single-pass analysis',
  };
}

function buildFixtureProject(): ProjectState {
  const originalRaw =
    'Rain hammers the neon alley as Minh Anh steps under the awning.\n\nMinh: "You should not be here tonight."\n\nOn the rooftop, a mysterious shadow drops the key. Silence falls over the city.';
  return {
    meta: {
      project_id: 'proj_dir_1',
      name: 'Midnight Key',
      description: '',
      schema_version: '0.1.0',
      width: 1920,
      height: 1080,
      fps: 30,
      duration_ms: 8000,
      default_export_preset_id: 'preset_1080p_30',
      auto_save_enabled: true,
      created_at: '2026-11-20T00:00:00Z',
      updated_at: '2026-11-20T00:00:00Z',
    },
    scenes: [
      {
        scene_id: 'scn_existing_user',
        project_id: 'proj_dir_1',
        order_index: 0,
        name: 'Existing User Intro',
        start_ms: 0,
        duration_ms: 8000,
        background_asset_id: null,
        background_color: '#101218',
        transition_in: 'cut',
        transition_duration_ms: 0,
        camera_default: { x: 0, y: 0, zoom: 1, rotation_deg: 0 },
        characters: [],
        props: [],
      },
    ],
    timeline: {
      project_id: 'proj_dir_1',
      fps: 30,
      total_duration_ms: 8000,
      tracks: [],
      keyframes: [],
      animation_clips: [],
      sound_events: [],
    },
    script: {
      episode_title: 'Episode 1',
      raw_source_text: originalRaw,
      scenes: [
        {
          script_scene_id: 'ssc_existing_user',
          linked_stage_scene_id: 'scn_existing_user',
          order_index: 0,
          title: 'Pre-existing Script Scene',
          location: 'Studio',
          time_of_day: 'Day',
          description: 'Must not be overwritten',
          background_asset_id: null,
          character_ids: [],
          notes: '',
          entries: [],
          estimated_duration_ms: 0,
        },
      ],
      updated_at: '2026-11-20T00:00:00Z',
    },
    director: buildFixtureDoc(),
  };
}

describe('directorEngine — Script Intelligence Review, Editing & Commit', () => {
  it('merges duplicate characters without data loss and separates incorrectly merged aliases', () => {
    const doc = buildFixtureDoc();

    const merged = mergeExtractedCharacters(doc, 'ch_1', 'ch_dup');
    expect(merged.characters.length).toBe(2);
    const minh = merged.characters.find((c) => c.character_analysis_id === 'ch_1')!;
    expect(minh.aliases).toContain('Minh (Duplicate)');
    expect(minh.aliases).toContain('Cậu Minh');
    expect(minh.appearance_specified).toBe(true);
    expect(minh.appearance_description).toBe('Dark raincoat');
    expect(minh.last_appearance_paragraph).toBe(2);

    // Separate alias "Minh" into its own character and verify dialogue line reassignment
    const sep = separateExtractedCharacterAlias(merged, 'ch_1', 'Minh');
    expect(sep.createdCharacterId).toBeTruthy();
    expect(sep.doc.characters.length).toBe(3);
    const created = sep.doc.characters.find((c) => c.character_analysis_id === sep.createdCharacterId)!;
    expect(created.canonical_name).toBe('Minh');
    expect(created.dialogue_item_ids).toContain('it_dlg_1');
    const dlgItem = sep.doc.extracted_items.find((i) => i.item_id === 'it_dlg_1')!;
    expect(dlgItem.speaker_character_analysis_id).toBe(sep.createdCharacterId);
  });

  it('propagates canonical character rename across scenes and resolves unresolved speakers', () => {
    const doc = buildFixtureDoc();
    const renamed = editExtractedCharacter(doc, 'ch_1', { canonical_name: 'Trần Minh Anh' });
    expect(renamed.scenes[0].characters_present).toContain('Trần Minh Anh');
    expect(renamed.scenes[0].characters_present).not.toContain('Minh Anh');

    const resolved = resolveExtractedItemSpeaker(renamed, 'it_dlg_2', 'ch_2');
    const item = resolved.extracted_items.find((i) => i.item_id === 'it_dlg_2')!;
    expect(item.speaker_unresolved).toBe(false);
    expect(item.speaker_character_analysis_id).toBe('ch_2');
  });

  it('splits multi-paragraph and single-paragraph scenes with zero text loss and merges scenes back cleanly', () => {
    const doc = buildFixtureDoc();
    // 1. Multi-paragraph split on Scene 1 (paragraphs [0, 1] -> [0] and [1])
    const split1 = splitSceneBreakdown(doc, 'sb_1', 1);
    expect(split1).not.toBeNull();
    expect(split1!.doc.scenes.length).toBe(3);
    const partA = split1!.doc.scenes[0];
    const partB = split1!.doc.scenes[1];
    expect(partA.source_paragraphs).toEqual([0]);
    expect(partB.source_paragraphs).toEqual([1]);
    expect(`${partA.source_text}\n\n${partB.source_text}`).toBe(doc.scenes[0].source_text);
    expect(partA.narration_item_ids).toEqual(['it_nar_1']);
    expect(partB.dialogue_item_ids).toEqual(['it_dlg_1']);

    // 2. Single-paragraph sentence split on Scene 3 (originally sb_2)
    const splitSingle = splitSceneBreakdown(split1!.doc, 'sb_2');
    expect(splitSingle).not.toBeNull();
    expect(splitSingle!.doc.scenes.length).toBe(4);
    const s3 = splitSingle!.doc.scenes[2];
    const s4 = splitSingle!.doc.scenes[3];
    expect(`${s3.source_text} ${s4.source_text}`).toBe(doc.scenes[1].source_text);

    // 3. Merge partA and partB back together losslessly
    const merged = mergeSceneBreakdowns(split1!.doc, [partA.scene_breakdown_id, partB.scene_breakdown_id]);
    expect(merged).not.toBeNull();
    expect(merged!.doc.scenes.length).toBe(2);
    expect(merged!.doc.scenes[0].source_text).toBe(doc.scenes[0].source_text);
    expect(merged!.doc.scenes[0].dialogue_item_ids).toEqual(['it_dlg_1']);
    expect(merged!.doc.scenes[0].narration_item_ids).toEqual(['it_nar_1']);
  });

  it('tracks user_edited_fields, reorders/deletes safely, and restores original AI snapshots', () => {
    let doc = buildFixtureDoc();
    doc = editSceneBreakdown(doc, 'sb_1', {
      title: 'User Custom Rain Scene',
      location: 'Saigon Alley',
    });
    expect(doc.scenes[0].user_edited_fields).toEqual(['title', 'location']);
    expect(doc.scenes[0].review_status).toBe('edited');

    // Move scene 1 down -> becomes scene 2
    const moved = moveSceneBreakdown(doc, 'sb_1', 1);
    expect(moved).not.toBeNull();
    expect(moved!.scenes[0].scene_breakdown_id).toBe('sb_2');
    expect(moved!.scenes[0].scene_number).toBe(1);
    expect(moved!.scenes[1].scene_breakdown_id).toBe('sb_1');
    expect(moved!.scenes[1].scene_number).toBe(2);

    // Restore single scene clears user_edited_fields and restores AI title
    const restoredOne = restoreOriginalSceneBreakdown(moved!, 'sb_1');
    const sb1 = restoredOne.scenes.find((s) => s.scene_breakdown_id === 'sb_1')!;
    expect(sb1.title).toBe('Alleyway Confrontation');
    expect(sb1.user_edited_fields).toEqual([]);

    // Delete scene then restore all original AI scenes
    const deleted = deleteSceneBreakdown(restoredOne, 'sb_2');
    expect(deleted.scenes.length).toBe(1);
    const restoredAll = restoreAllOriginalScenes(deleted);
    expect(restoredAll.scenes.length).toBe(2);
    expect(restoredAll.scenes[0].scene_breakdown_id).toBe('sb_1');
    expect(restoredAll.scenes[1].scene_breakdown_id).toBe('sb_2');
  });

  it('applies ONLY accepted scenes to project without overwriting raw_source_text or existing user scenes', () => {
    const project = buildFixtureProject();
    const originalRawText = project.script!.raw_source_text;

    // Accept ONLY Scene 1, reject Scene 2
    project.director = setSceneReviewStatus(project.director!, 'sb_1', 'accepted');
    project.director = setSceneReviewStatus(project.director!, 'sb_2', 'rejected');

    const res1 = applyAcceptedScenesToProjectState(project, { createStageScenes: true });
    expect(res1.appliedCount).toBe(1);
    expect(res1.createdScriptScenes).toBe(1);
    expect(res1.createdStageScenes).toBe(1);

    // Original raw script text is 100% untouched!
    expect(project.script!.raw_source_text).toBe(originalRawText);
    // Pre-existing user ScriptScene & Stage Scene are preserved!
    expect(project.script!.scenes.length).toBe(2);
    expect(project.script!.scenes[0].script_scene_id).toBe('ssc_existing_user');
    expect(project.scenes.length).toBe(2);
    expect(project.scenes[0].scene_id).toBe('scn_existing_user');

    // Applied scene preserves verbatim dialogue & linked library character ID
    const appliedScriptScene = project.script!.scenes[1];
    expect(appliedScriptScene.title).toBe('Alleyway Confrontation');
    expect(appliedScriptScene.character_ids).toContain('lib_char_minh');
    expect(appliedScriptScene.entries.some((e) => e.text === 'You should not be here tonight.')).toBe(
      true,
    );

    // Re-applying updates the linked scene cleanly without creating duplicates!
    project.director = editSceneBreakdown(project.director!, 'sb_1', {
      title: 'Alleyway Confrontation (Final)',
      review_status: 'accepted',
    });
    const res2 = applyAcceptedScenesToProjectState(project, { createStageScenes: true });
    expect(res2.createdScriptScenes).toBe(0);
    expect(res2.updatedScriptScenes).toBe(1);
    expect(res2.updatedStageScenes).toBe(1);
    expect(project.script!.scenes.length).toBe(2);
    expect(project.script!.scenes[1].title).toBe('Alleyway Confrontation (Final)');

    // Accept All ignores rejected scenes
    const afterAcceptAll = acceptAllScenesInDoc(project.director!);
    expect(afterAcceptAll.scenes[1].review_status).toBe('rejected');
  });
});
