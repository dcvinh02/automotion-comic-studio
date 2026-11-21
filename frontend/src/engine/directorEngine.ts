/**
 * Phase 06 Batch 1 — Pure AI Director Review, Editing, Scene Boundary & Commit Engine.
 *
 * Guarantees:
 * - Zero silent overwrites of original script text (`script.raw_source_text` is never cleared/modified)
 * - Zero text loss when splitting or merging scenes
 * - Explicit tracking of `user_edited_fields` so per-scene AI regeneration preserves human decisions
 * - Safe alias consolidation, ambiguity separation, and non-duplicating Library Character linking
 * - Reversible restoration to original AI analysis snapshots
 */

import {
  ensureProjectScript,
  moveArrayItemByDelta,
  recalculateScriptDurations,
  reorderArrayByIds,
} from '@/engine/scriptEngine';
import type {
  DirectorAnalysisDocument,
  DirectorReviewStatus,
  ExtractedCharacter,
  ExtractedScriptItem,
  ProjectState,
  Scene,
  SceneBreakdownItem,
  SceneImportance,
  ScriptEntry,
  ScriptEntryType,
  ScriptScene,
  TransitionType,
} from '@/types/models';

function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function norm(value: string): string {
  return (value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function dedupeStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const clean = (raw || '').trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(clean);
    }
  }
  return out;
}

const IMPORTANCE_RANK: Record<SceneImportance, number> = {
  low: 1,
  medium: 2,
  high: 3,
  climax: 4,
};

function renumberScenes(scenes: SceneBreakdownItem[]): SceneBreakdownItem[] {
  return scenes.map((sc, idx) => ({ ...sc, scene_number: idx + 1 }));
}

export function recomputeDirectorDocumentStatus(
  doc: DirectorAnalysisDocument,
): DirectorAnalysisDocument['status'] {
  if (doc.scenes.length === 0) return doc.status === 'idle' ? 'idle' : 'analyzed';
  const activeScenes = doc.scenes.filter((s) => s.review_status !== 'rejected');
  const acceptedCount = doc.scenes.filter((s) => s.review_status === 'accepted').length;
  if (acceptedCount === 0) return 'analyzed';
  if (activeScenes.length > 0 && acceptedCount === activeScenes.length) return 'accepted';
  return 'partially_accepted';
}

function touchDoc(doc: DirectorAnalysisDocument): DirectorAnalysisDocument {
  return {
    ...doc,
    status: recomputeDirectorDocumentStatus(doc),
    updated_at: new Date().toISOString(),
  };
}

// --- Character Review & Alias Management ---

export function editExtractedCharacter(
  doc: DirectorAnalysisDocument,
  characterAnalysisId: string,
  patch: Partial<
    Pick<
      ExtractedCharacter,
      | 'canonical_name'
      | 'aliases'
      | 'ambiguous_aliases'
      | 'role'
      | 'personality'
      | 'appearance_description'
      | 'appearance_specified'
      | 'relationships'
      | 'narrative_importance'
      | 'emotional_states'
      | 'actions'
      | 'linked_character_id'
      | 'review_status'
      | 'notes'
    >
  >,
): DirectorAnalysisDocument {
  const idx = doc.characters.findIndex((c) => c.character_analysis_id === characterAnalysisId);
  if (idx === -1) return doc;

  const existing = doc.characters[idx];
  const oldName = existing.canonical_name;
  const touched = Object.keys(patch).filter((k) => k !== 'review_status');
  const nextEditedFields = dedupeStrings([...existing.user_edited_fields, ...touched]);

  let nextAppearanceDesc =
    patch.appearance_description !== undefined
      ? patch.appearance_description.trim()
      : existing.appearance_description;
  let nextAppearanceSpec =
    patch.appearance_specified !== undefined
      ? patch.appearance_specified
      : existing.appearance_specified;
  if (patch.appearance_description !== undefined && patch.appearance_specified === undefined) {
    const low = nextAppearanceDesc.toLowerCase();
    nextAppearanceSpec = Boolean(
      nextAppearanceDesc && !['unspecified', 'unknown', 'none', 'không rõ', 'chưa mô tả'].includes(low),
    );
    if (!nextAppearanceSpec) {
      nextAppearanceDesc = 'unspecified';
    }
  }

  const nextCanonical = (patch.canonical_name ?? existing.canonical_name).trim() || existing.canonical_name;
  const nextAliases = dedupeStrings(patch.aliases ?? existing.aliases).filter(
    (a) => norm(a) !== norm(nextCanonical),
  );

  const updatedChar: ExtractedCharacter = {
    ...existing,
    ...patch,
    canonical_name: nextCanonical,
    aliases: nextAliases,
    ambiguous_aliases: dedupeStrings(patch.ambiguous_aliases ?? existing.ambiguous_aliases),
    appearance_description: nextAppearanceDesc,
    appearance_specified: nextAppearanceSpec,
    user_edited_fields: nextEditedFields,
    review_status: patch.review_status ?? 'edited',
  };

  let nextChars = doc.characters.map((c, i) => (i === idx ? updatedChar : c));
  let nextScenes = doc.scenes;

  // Propagate canonical rename across scenes and relationship targets cleanly
  if (norm(nextCanonical) !== norm(oldName)) {
    nextChars = nextChars.map((c) => ({
      ...c,
      relationships: c.relationships.map((rel) =>
        rel.target_character_analysis_id === characterAnalysisId || norm(rel.target_name) === norm(oldName)
          ? { ...rel, target_name: nextCanonical, target_character_analysis_id: characterAnalysisId }
          : rel,
      ),
    }));
    nextScenes = doc.scenes.map((sc) => ({
      ...sc,
      characters_present: dedupeStrings(
        sc.characters_present.map((n) => (norm(n) === norm(oldName) ? nextCanonical : n)),
      ),
      character_entrances: dedupeStrings(
        sc.character_entrances.map((n) => (norm(n) === norm(oldName) ? nextCanonical : n)),
      ),
      character_exits: dedupeStrings(
        sc.character_exits.map((n) => (norm(n) === norm(oldName) ? nextCanonical : n)),
      ),
    }));
  }

  return touchDoc({
    ...doc,
    characters: nextChars,
    scenes: nextScenes,
  });
}

export function mergeExtractedCharacters(
  doc: DirectorAnalysisDocument,
  primaryId: string,
  secondaryId: string,
): DirectorAnalysisDocument {
  if (primaryId === secondaryId) return doc;
  const primary = doc.characters.find((c) => c.character_analysis_id === primaryId);
  const secondary = doc.characters.find((c) => c.character_analysis_id === secondaryId);
  if (!primary || !secondary) return doc;

  const combinedAliases = dedupeStrings([
    ...primary.aliases,
    secondary.canonical_name,
    ...secondary.aliases,
  ]).filter((a) => norm(a) !== norm(primary.canonical_name));

  const combinedAmbiguous = dedupeStrings([
    ...primary.ambiguous_aliases,
    ...secondary.ambiguous_aliases,
  ]);

  const combinedDialogues = Array.from(
    new Set([...primary.dialogue_item_ids, ...secondary.dialogue_item_ids]),
  );

  // Merge relationships, retargeting secondary -> primary and avoiding self-loops
  const relMap = new Map<string, ExtractedCharacter['relationships'][number]>();
  for (const rel of [...primary.relationships, ...secondary.relationships]) {
    const isTargetSecondary =
      rel.target_character_analysis_id === secondaryId ||
      norm(rel.target_name) === norm(secondary.canonical_name);
    const isTargetPrimary =
      rel.target_character_analysis_id === primaryId ||
      norm(rel.target_name) === norm(primary.canonical_name);
    if (isTargetPrimary || isTargetSecondary) continue;
    const key = rel.target_character_analysis_id || norm(rel.target_name);
    if (!relMap.has(key)) {
      relMap.set(key, rel);
    }
  }

  const firstPara =
    primary.first_appearance_paragraph === null
      ? secondary.first_appearance_paragraph
      : secondary.first_appearance_paragraph === null
        ? primary.first_appearance_paragraph
        : Math.min(primary.first_appearance_paragraph, secondary.first_appearance_paragraph);
  const lastPara =
    primary.last_appearance_paragraph === null
      ? secondary.last_appearance_paragraph
      : secondary.last_appearance_paragraph === null
        ? primary.last_appearance_paragraph
        : Math.max(primary.last_appearance_paragraph, secondary.last_appearance_paragraph);

  const appearanceSpecified = primary.appearance_specified || secondary.appearance_specified;
  const appearanceDescription = primary.appearance_specified
    ? primary.appearance_description
    : secondary.appearance_specified
      ? secondary.appearance_description
      : 'unspecified';

  const mergedPrimary: ExtractedCharacter = {
    ...primary,
    aliases: combinedAliases,
    ambiguous_aliases: combinedAmbiguous,
    role: primary.role || secondary.role,
    personality: primary.personality || secondary.personality,
    appearance_description: appearanceDescription,
    appearance_specified: appearanceSpecified,
    relationships: Array.from(relMap.values()),
    dialogue_item_ids: combinedDialogues,
    emotional_states: dedupeStrings([...primary.emotional_states, ...secondary.emotional_states]),
    actions: dedupeStrings([...primary.actions, ...secondary.actions]),
    first_appearance_paragraph: firstPara,
    last_appearance_paragraph: lastPara,
    linked_character_id: primary.linked_character_id ?? secondary.linked_character_id,
    review_status: 'edited',
    user_edited_fields: dedupeStrings([...primary.user_edited_fields, 'aliases', 'merged']),
    notes: [primary.notes, secondary.notes].filter(Boolean).join(' | '),
  };

  const nextChars = doc.characters
    .filter((c) => c.character_analysis_id !== secondaryId)
    .map((c) => {
      const base = c.character_analysis_id === primaryId ? mergedPrimary : c;
      return {
        ...base,
        relationships: base.relationships.map((r) =>
          r.target_character_analysis_id === secondaryId ||
          norm(r.target_name) === norm(secondary.canonical_name)
            ? { ...r, target_character_analysis_id: primaryId, target_name: primary.canonical_name }
            : r,
        ),
      };
    });

  const nextItems = doc.extracted_items.map((it) =>
    it.speaker_character_analysis_id === secondaryId
      ? { ...it, speaker_character_analysis_id: primaryId, speaker_unresolved: false }
      : it,
  );

  const replaceSecName = (list: string[]) =>
    dedupeStrings(
      list.map((n) => (norm(n) === norm(secondary.canonical_name) ? primary.canonical_name : n)),
    );

  const nextScenes = doc.scenes.map((sc) => ({
    ...sc,
    characters_present: replaceSecName(sc.characters_present),
    character_entrances: replaceSecName(sc.character_entrances),
    character_exits: replaceSecName(sc.character_exits),
  }));

  return touchDoc({
    ...doc,
    characters: nextChars,
    extracted_items: nextItems,
    scenes: nextScenes,
  });
}

export function separateExtractedCharacterAlias(
  doc: DirectorAnalysisDocument,
  sourceCharId: string,
  aliasToSeparate: string,
): { doc: DirectorAnalysisDocument; createdCharacterId: string | null } {
  const cleanAlias = aliasToSeparate.trim();
  if (!cleanAlias) return { doc, createdCharacterId: null };
  const source = doc.characters.find((c) => c.character_analysis_id === sourceCharId);
  if (!source) return { doc, createdCharacterId: null };

  const newId = uid('achar');
  const matchingItemIds: string[] = [];
  const nextItems = doc.extracted_items.map((it) => {
    if (
      it.speaker_character_analysis_id === sourceCharId &&
      norm(it.speaker_name_raw) === norm(cleanAlias)
    ) {
      matchingItemIds.push(it.item_id);
      return {
        ...it,
        speaker_character_analysis_id: newId,
        speaker_unresolved: false,
      };
    }
    return it;
  });

  const matchedSet = new Set(matchingItemIds);
  const updatedSource: ExtractedCharacter = {
    ...source,
    aliases: source.aliases.filter((a) => norm(a) !== norm(cleanAlias)),
    ambiguous_aliases: source.ambiguous_aliases.filter((a) => norm(a) !== norm(cleanAlias)),
    dialogue_item_ids: source.dialogue_item_ids.filter((id) => !matchedSet.has(id)),
    review_status: 'edited',
    user_edited_fields: dedupeStrings([...source.user_edited_fields, 'aliases']),
  };

  const separatedChar: ExtractedCharacter = {
    character_analysis_id: newId,
    canonical_name: cleanAlias,
    aliases: [],
    ambiguous_aliases: [],
    role: '',
    personality: '',
    appearance_description: 'unspecified',
    appearance_specified: false,
    relationships: [],
    narrative_importance: 'supporting',
    dialogue_item_ids: matchingItemIds,
    emotional_states: [],
    actions: [],
    first_appearance_paragraph: null,
    last_appearance_paragraph: null,
    linked_character_id: null,
    review_status: 'edited',
    user_edited_fields: ['canonical_name'],
    confidence: 1.0,
    notes: `Separated from alias of ${source.canonical_name}`,
  };

  const nextChars = [
    ...doc.characters.map((c) => (c.character_analysis_id === sourceCharId ? updatedSource : c)),
    separatedChar,
  ];

  return {
    doc: touchDoc({ ...doc, characters: nextChars, extracted_items: nextItems }),
    createdCharacterId: newId,
  };
}

export function resolveExtractedItemSpeaker(
  doc: DirectorAnalysisDocument,
  itemId: string,
  characterAnalysisId: string | null,
): DirectorAnalysisDocument {
  const targetItem = doc.extracted_items.find((it) => it.item_id === itemId);
  if (!targetItem) return doc;
  const targetChar = characterAnalysisId
    ? doc.characters.find((c) => c.character_analysis_id === characterAnalysisId)
    : null;

  const nextItems = doc.extracted_items.map((it) =>
    it.item_id === itemId
      ? {
          ...it,
          speaker_character_analysis_id: targetChar ? targetChar.character_analysis_id : null,
          speaker_name_raw: targetChar ? targetChar.canonical_name : it.speaker_name_raw,
          speaker_unresolved: targetChar ? false : true,
        }
      : it,
  );

  const nextChars = doc.characters.map((c) => {
    const filtered = c.dialogue_item_ids.filter((id) => id !== itemId);
    if (targetChar && c.character_analysis_id === targetChar.character_analysis_id) {
      return { ...c, dialogue_item_ids: [...filtered, itemId] };
    }
    return { ...c, dialogue_item_ids: filtered };
  });

  return touchDoc({
    ...doc,
    characters: nextChars,
    extracted_items: nextItems,
  });
}

// --- Scene Breakdown Editing, Split, Merge, Reorder, Restore ---

export function editSceneBreakdown(
  doc: DirectorAnalysisDocument,
  sceneBreakdownId: string,
  patch: Partial<
    Omit<
      SceneBreakdownItem,
      'scene_breakdown_id' | 'scene_number' | 'original_ai_snapshot' | 'user_edited_fields'
    >
  >,
): DirectorAnalysisDocument {
  const idx = doc.scenes.findIndex((s) => s.scene_breakdown_id === sceneBreakdownId);
  if (idx === -1) return doc;

  const existing = doc.scenes[idx];
  const editedKeys = Object.keys(patch).filter((k) => k !== 'review_status');
  const nextEdited = dedupeStrings([...existing.user_edited_fields, ...editedKeys]);

  const minS = Math.max(1, Math.min(600, Math.round(patch.suggested_duration_min_s ?? existing.suggested_duration_min_s)));
  const maxS = Math.max(
    minS,
    Math.min(600, Math.round(patch.suggested_duration_max_s ?? existing.suggested_duration_max_s)),
  );

  const updated: SceneBreakdownItem = {
    ...existing,
    ...patch,
    suggested_duration_min_s: minS,
    suggested_duration_max_s: maxS,
    user_edited_fields: nextEdited,
    review_status: patch.review_status ?? 'edited',
  };

  const nextScenes = doc.scenes.map((s, i) => (i === idx ? updated : s));
  return touchDoc({ ...doc, scenes: nextScenes });
}

export function setSceneReviewStatus(
  doc: DirectorAnalysisDocument,
  sceneBreakdownId: string,
  status: DirectorReviewStatus,
): DirectorAnalysisDocument {
  const idx = doc.scenes.findIndex((s) => s.scene_breakdown_id === sceneBreakdownId);
  if (idx === -1) return doc;
  const nextScenes = doc.scenes.map((s, i) =>
    i === idx ? { ...s, review_status: status } : s,
  );
  return touchDoc({ ...doc, scenes: nextScenes });
}

export function acceptAllScenesInDoc(doc: DirectorAnalysisDocument): DirectorAnalysisDocument {
  const nextScenes = doc.scenes.map((s) =>
    s.review_status === 'rejected' ? s : { ...s, review_status: 'accepted' as const },
  );
  return touchDoc({ ...doc, scenes: nextScenes });
}

export function splitSceneBreakdown(
  doc: DirectorAnalysisDocument,
  sceneBreakdownId: string,
  splitAtParagraphPos?: number,
): { doc: DirectorAnalysisDocument; firstId: string; secondId: string } | null {
  const idx = doc.scenes.findIndex((s) => s.scene_breakdown_id === sceneBreakdownId);
  if (idx === -1) return null;

  const target = doc.scenes[idx];
  const firstId = target.scene_breakdown_id;
  const secondId = uid('sb');

  let firstParas: number[];
  let secondParas: number[];
  let firstText: string;
  let secondText: string;

  if (target.source_paragraphs.length >= 2) {
    const cut = Math.max(
      1,
      Math.min(
        target.source_paragraphs.length - 1,
        splitAtParagraphPos ?? Math.ceil(target.source_paragraphs.length / 2),
      ),
    );
    firstParas = target.source_paragraphs.slice(0, cut);
    secondParas = target.source_paragraphs.slice(cut);

    const resolveParaText = (indices: number[]): string => {
      const resolved = indices
        .map((p) => doc.source_paragraphs[p])
        .filter((t): t is string => typeof t === 'string');
      if (resolved.length === indices.length) return resolved.join('\n\n');
      return '';
    };
    const r1 = resolveParaText(firstParas);
    const r2 = resolveParaText(secondParas);
    if (r1 && r2) {
      firstText = r1;
      secondText = r2;
    } else {
      const blocks = target.source_text.split(/\n{2,}/);
      firstText = blocks.slice(0, cut).join('\n\n') || target.source_text;
      secondText = blocks.slice(cut).join('\n\n') || '';
    }
  } else {
    // Single-paragraph scene: lossless line or sentence split so ZERO characters are lost!
    const raw = target.source_text || '';
    const lines = raw.split('\n').filter((l) => l.length > 0);
    if (lines.length >= 2) {
      const cutLine = Math.ceil(lines.length / 2);
      firstText = lines.slice(0, cutLine).join('\n');
      secondText = lines.slice(cutLine).join('\n');
    } else {
      const sentences = raw.match(/[^.!?…]+[.!?…]*(?:\s+|$)/g) ?? [raw];
      if (sentences.length >= 2) {
        const cutSent = Math.ceil(sentences.length / 2);
        firstText = sentences.slice(0, cutSent).join('').trim();
        secondText = sentences.slice(cutSent).join('').trim();
      } else {
        const mid = Math.ceil(raw.length / 2);
        firstText = raw.slice(0, mid);
        secondText = raw.slice(mid);
      }
    }
    firstParas = [...target.source_paragraphs];
    secondParas = [...target.source_paragraphs];
  }

  // Partition dialogue & narration items cleanly without losing any item
  const firstParaSet = new Set(firstParas);
  const secondParaSet = new Set(secondParas);
  const sameParas =
    firstParas.length === secondParas.length &&
    firstParas.every((p, i) => p === secondParas[i]);

  const itemById = new Map(doc.extracted_items.map((it) => [it.item_id, it]));
  const partitionIds = (ids: string[]): [string[], string[]] => {
    if (sameParas) {
      const cut = Math.ceil(ids.length / 2);
      return [ids.slice(0, cut), ids.slice(cut)];
    }
    const a: string[] = [];
    const b: string[] = [];
    for (const id of ids) {
      const it = itemById.get(id);
      if (it && secondParaSet.has(it.paragraph_index) && !firstParaSet.has(it.paragraph_index)) {
        b.push(id);
      } else {
        a.push(id);
      }
    }
    return [a, b];
  };

  const [dlgA, dlgB] = partitionIds(target.dialogue_item_ids);
  const [narA, narB] = partitionIds(target.narration_item_ids);
  const secondItemSet = new Set([...dlgB, ...narB]);

  const halfMin = Math.max(2, Math.round(target.suggested_duration_min_s / 2));
  const halfMax = Math.max(halfMin, Math.round(target.suggested_duration_max_s / 2));

  const firstScene: SceneBreakdownItem = {
    ...target,
    scene_breakdown_id: firstId,
    title: `${target.title} (Part 1)`,
    source_paragraphs: firstParas,
    source_text: firstText,
    dialogue_item_ids: dlgA,
    narration_item_ids: narA,
    suggested_duration_min_s: halfMin,
    suggested_duration_max_s: halfMax,
    review_status: 'edited',
    user_edited_fields: dedupeStrings([...target.user_edited_fields, 'title', 'source_paragraphs']),
    applied_script_scene_id: target.applied_script_scene_id,
    applied_stage_scene_id: target.applied_stage_scene_id,
  };

  const secondScene: SceneBreakdownItem = {
    ...target,
    scene_breakdown_id: secondId,
    title: `${target.title} (Part 2)`,
    source_paragraphs: secondParas,
    source_text: secondText,
    dialogue_item_ids: dlgB,
    narration_item_ids: narB,
    suggested_duration_min_s: halfMin,
    suggested_duration_max_s: halfMax,
    review_status: 'edited',
    user_edited_fields: ['title', 'source_paragraphs'],
    applied_script_scene_id: null,
    applied_stage_scene_id: null,
    original_ai_snapshot: null,
  };

  const nextScenes = [...doc.scenes];
  nextScenes.splice(idx, 1, firstScene, secondScene);

  const nextItems = doc.extracted_items.map((it) =>
    secondItemSet.has(it.item_id) ? { ...it, scene_breakdown_id: secondId } : it,
  );

  return {
    doc: touchDoc({
      ...doc,
      scenes: renumberScenes(nextScenes),
      extracted_items: nextItems,
    }),
    firstId,
    secondId,
  };
}

export function mergeSceneBreakdowns(
  doc: DirectorAnalysisDocument,
  sceneBreakdownIds: string[],
): { doc: DirectorAnalysisDocument; mergedId: string } | null {
  const idSet = new Set(sceneBreakdownIds);
  if (idSet.size < 2) return null;

  const targets = doc.scenes.filter((s) => idSet.has(s.scene_breakdown_id));
  if (targets.length < 2) return null;

  const firstIdx = doc.scenes.findIndex((s) => idSet.has(s.scene_breakdown_id));
  const primary = targets[0];
  const mergedId = primary.scene_breakdown_id;

  const mergedParas = Array.from(new Set(targets.flatMap((s) => s.source_paragraphs))).sort(
    (a, b) => a - b,
  );

  // Preserve 100% of verbatim text in order
  const mergedText = targets
    .map((s) => s.source_text)
    .filter((t) => t.length > 0)
    .join('\n\n');

  const mergedDialogues = Array.from(new Set(targets.flatMap((s) => s.dialogue_item_ids)));
  const mergedNarrations = Array.from(new Set(targets.flatMap((s) => s.narration_item_ids)));
  const mergedItemSet = new Set([...mergedDialogues, ...mergedNarrations]);

  const highestImportance = targets.reduce<SceneImportance>(
    (best, s) => (IMPORTANCE_RANK[s.importance] > IMPORTANCE_RANK[best] ? s.importance : best),
    primary.importance,
  );

  const sumMin = Math.min(
    600,
    targets.reduce((acc, s) => acc + s.suggested_duration_min_s, 0),
  );
  const sumMax = Math.max(
    sumMin,
    Math.min(
      600,
      targets.reduce((acc, s) => acc + s.suggested_duration_max_s, 0),
    ),
  );

  const mergedScene: SceneBreakdownItem = {
    ...primary,
    title: primary.title,
    source_paragraphs: mergedParas,
    source_text: mergedText,
    location: primary.location || targets.find((s) => s.location)?.location || '',
    time_of_day: primary.time_of_day || targets.find((s) => s.time_of_day)?.time_of_day || '',
    environment: dedupeStrings(targets.map((s) => s.environment)).join(' / '),
    characters_present: dedupeStrings(targets.flatMap((s) => s.characters_present)),
    character_entrances: dedupeStrings(targets.flatMap((s) => s.character_entrances)),
    character_exits: dedupeStrings(targets.flatMap((s) => s.character_exits)),
    main_action: dedupeStrings(targets.map((s) => s.main_action)).join(' '),
    dialogue_item_ids: mergedDialogues,
    narration_item_ids: mergedNarrations,
    emotional_beat: dedupeStrings(targets.map((s) => s.emotional_beat)).join(' -> '),
    scene_purpose: dedupeStrings(targets.map((s) => s.scene_purpose)).join(' '),
    conflict: dedupeStrings(targets.map((s) => s.conflict)).join(' '),
    visual_opportunities: dedupeStrings(targets.flatMap((s) => s.visual_opportunities)),
    atmosphere: dedupeStrings(targets.map((s) => s.atmosphere)).join(', '),
    suggested_duration_min_s: sumMin,
    suggested_duration_max_s: sumMax,
    importance: highestImportance,
    transition_suggestion: targets[targets.length - 1].transition_suggestion || primary.transition_suggestion,
    unresolved_questions: dedupeStrings(targets.flatMap((s) => s.unresolved_questions)),
    review_status: 'edited',
    user_edited_fields: dedupeStrings([
      ...primary.user_edited_fields,
      'source_paragraphs',
      'main_action',
    ]),
  };

  const remaining = doc.scenes.filter((s) => !idSet.has(s.scene_breakdown_id));
  remaining.splice(firstIdx, 0, mergedScene);

  const nextItems = doc.extracted_items.map((it) =>
    mergedItemSet.has(it.item_id) || (it.scene_breakdown_id && idSet.has(it.scene_breakdown_id))
      ? { ...it, scene_breakdown_id: mergedId }
      : it,
  );

  return {
    doc: touchDoc({
      ...doc,
      scenes: renumberScenes(remaining),
      extracted_items: nextItems,
    }),
    mergedId,
  };
}

export function reorderSceneBreakdowns(
  doc: DirectorAnalysisDocument,
  sourceId: string,
  targetId: string,
  position: 'before' | 'after',
): DirectorAnalysisDocument | null {
  const next = reorderArrayByIds(
    doc.scenes,
    (s) => s.scene_breakdown_id,
    sourceId,
    targetId,
    position,
  );
  if (!next) return null;
  return touchDoc({ ...doc, scenes: renumberScenes(next) });
}

export function moveSceneBreakdown(
  doc: DirectorAnalysisDocument,
  sceneBreakdownId: string,
  delta: -1 | 1,
): DirectorAnalysisDocument | null {
  const idx = doc.scenes.findIndex((s) => s.scene_breakdown_id === sceneBreakdownId);
  if (idx === -1) return null;
  const next = moveArrayItemByDelta(doc.scenes, idx, delta);
  if (!next) return null;
  return touchDoc({ ...doc, scenes: renumberScenes(next) });
}

export function deleteSceneBreakdown(
  doc: DirectorAnalysisDocument,
  sceneBreakdownId: string,
): DirectorAnalysisDocument {
  const nextScenes = doc.scenes.filter((s) => s.scene_breakdown_id !== sceneBreakdownId);
  const nextItems = doc.extracted_items.map((it) =>
    it.scene_breakdown_id === sceneBreakdownId ? { ...it, scene_breakdown_id: null } : it,
  );
  return touchDoc({
    ...doc,
    scenes: renumberScenes(nextScenes),
    extracted_items: nextItems,
  });
}

export function restoreOriginalSceneBreakdown(
  doc: DirectorAnalysisDocument,
  sceneBreakdownId: string,
): DirectorAnalysisDocument {
  const idx = doc.scenes.findIndex((s) => s.scene_breakdown_id === sceneBreakdownId);
  if (idx === -1) return doc;
  const cur = doc.scenes[idx];
  const snap = cur.original_ai_snapshot;
  if (!snap) return doc;

  const restored: SceneBreakdownItem = {
    ...(snap as unknown as SceneBreakdownItem),
    scene_breakdown_id: cur.scene_breakdown_id,
    scene_number: cur.scene_number,
    review_status: 'pending',
    user_edited_fields: [],
    applied_script_scene_id: cur.applied_script_scene_id,
    applied_stage_scene_id: cur.applied_stage_scene_id,
    original_ai_snapshot: snap,
  };

  const nextScenes = doc.scenes.map((s, i) => (i === idx ? restored : s));
  return touchDoc({ ...doc, scenes: nextScenes });
}

export function restoreAllOriginalScenes(doc: DirectorAnalysisDocument): DirectorAnalysisDocument {
  if (!doc.original_scenes_snapshot || doc.original_scenes_snapshot.length === 0) return doc;

  const restoredScenes: SceneBreakdownItem[] = doc.original_scenes_snapshot.map((raw, idx) => {
    const snap = raw as unknown as SceneBreakdownItem;
    return {
      ...snap,
      scene_number: idx + 1,
      review_status: 'pending',
      user_edited_fields: [],
      original_ai_snapshot: raw,
    };
  });

  // Relink extracted_items to restored scene IDs
  const itemToScene = new Map<string, string>();
  for (const sc of restoredScenes) {
    for (const id of [...sc.dialogue_item_ids, ...sc.narration_item_ids]) {
      itemToScene.set(id, sc.scene_breakdown_id);
    }
  }
  const nextItems = doc.extracted_items.map((it) => ({
    ...it,
    scene_breakdown_id: itemToScene.get(it.item_id) ?? null,
  }));

  return touchDoc({
    ...doc,
    scenes: restoredScenes,
    extracted_items: nextItems,
  });
}

// --- Explicit Commit of Accepted Scenes into Existing Project State ---

function inferTransitionType(suggestion: string): TransitionType {
  const low = (suggestion || '').toLowerCase();
  if (low.includes('dissolve') || low.includes('cross') || low.includes('mờ nối')) {
    return 'cross_dissolve';
  }
  if (low.includes('fade') || low.includes('mờ đen') || low.includes('chuyển mờ')) {
    return 'fade';
  }
  return 'cut';
}

function mapExtractedTypeToScriptEntryType(t: ExtractedScriptItem['item_type']): ScriptEntryType {
  if (t === 'dialogue' || t === 'internal_thought') return 'dialogue';
  if (t === 'action' || t === 'sound_cue') return 'action';
  return 'narration';
}

export interface ApplyAcceptedResult {
  appliedCount: number;
  createdScriptScenes: number;
  updatedScriptScenes: number;
  createdStageScenes: number;
  updatedStageScenes: number;
}

/**
 * Explicitly applies user-accepted `SceneBreakdownItem`s into the project's existing
 * `ScriptDocument.scenes` and (optionally) Stage `ProjectState.scenes`.
 *
 * Strictly non-destructive:
 * - Never clears or modifies `project.script.raw_source_text`
 * - Never deletes pre-existing unlinked user `ScriptScene`s or Stage `Scene`s
 * - Never creates duplicate library characters
 */
export function applyAcceptedScenesToProjectState(
  draft: ProjectState,
  options?: { createStageScenes?: boolean },
): ApplyAcceptedResult {
  const createStageScenes = options?.createStageScenes ?? true;
  const director = draft.director;
  if (!director) {
    return {
      appliedCount: 0,
      createdScriptScenes: 0,
      updatedScriptScenes: 0,
      createdStageScenes: 0,
      updatedStageScenes: 0,
    };
  }

  const acceptedScenes = director.scenes.filter((s) => s.review_status === 'accepted');
  if (acceptedScenes.length === 0) {
    return {
      appliedCount: 0,
      createdScriptScenes: 0,
      updatedScriptScenes: 0,
      createdStageScenes: 0,
      updatedStageScenes: 0,
    };
  }

  const scriptDoc = ensureProjectScript(draft);
  const charByAnalysisId = new Map(
    director.characters.map((c) => [c.character_analysis_id, c]),
  );
  const charByNormName = new Map<string, ExtractedCharacter>();
  for (const ch of director.characters) {
    charByNormName.set(norm(ch.canonical_name), ch);
    for (const al of ch.aliases) {
      charByNormName.set(norm(al), ch);
    }
  }
  const itemById = new Map(director.extracted_items.map((it) => [it.item_id, it]));

  let createdScriptScenes = 0;
  let updatedScriptScenes = 0;
  let createdStageScenes = 0;
  let updatedStageScenes = 0;

  for (const sb of acceptedScenes) {
    const linkedLibraryCharIds = dedupeStrings(
      sb.characters_present
        .map((name) => charByNormName.get(norm(name))?.linked_character_id ?? '')
        .filter(Boolean),
    );

    // Collect ordered verbatim script items belonging to this scene
    const orderedItemIds = Array.from(new Set([...sb.dialogue_item_ids, ...sb.narration_item_ids]));
    const sceneItems = orderedItemIds
      .map((id) => itemById.get(id))
      .filter((x): x is ExtractedScriptItem => Boolean(x))
      .sort((a, b) => a.order_index - b.order_index);

    const entries: ScriptEntry[] = sceneItems.map((it, eIdx) => {
      const ch = it.speaker_character_analysis_id
        ? charByAnalysisId.get(it.speaker_character_analysis_id)
        : undefined;
      const entryType = mapExtractedTypeToScriptEntryType(it.item_type);
      return {
        entry_id: uid('se'),
        entry_type: entryType,
        order_index: eIdx,
        character_id: ch?.linked_character_id ?? null,
        narrator_label:
          entryType === 'narration'
            ? it.speaker_name_raw || 'Narrator'
            : !ch?.linked_character_id
              ? ch?.canonical_name || it.speaker_name_raw || ''
              : '',
        text: it.original_text,
        voice_profile_id: null,
        emotion: it.emotion || 'neutral',
        delivery_style: it.item_type === 'internal_thought' ? 'thoughtful' : 'natural',
        pause_before_ms: 0,
        pause_after_ms: 250,
        estimated_duration_ms: 0,
        audio_asset_id: null,
        audio_duration_ms: null,
        sound_effect_ids: [],
      };
    });

    // Fallback entry if the scene had descriptive source_text with no extracted dialogue/narration items
    if (entries.length === 0 && sb.source_text.trim()) {
      entries.push({
        entry_id: uid('se'),
        entry_type: 'narration',
        order_index: 0,
        character_id: null,
        narrator_label: 'Narrator',
        text: sb.source_text.trim(),
        voice_profile_id: null,
        emotion: sb.emotional_beat || 'neutral',
        delivery_style: 'natural',
        pause_before_ms: 0,
        pause_after_ms: 300,
        estimated_duration_ms: 0,
        audio_asset_id: null,
        audio_duration_ms: null,
        sound_effect_ids: [],
      });
    }

    const descriptionParts = [sb.main_action, sb.atmosphere ? `Atmosphere: ${sb.atmosphere}` : ''].filter(Boolean);
    const notesParts = [
      sb.scene_purpose ? `Purpose: ${sb.scene_purpose}` : '',
      sb.conflict ? `Conflict: ${sb.conflict}` : '',
      sb.visual_opportunities.length > 0 ? `Visuals: ${sb.visual_opportunities.join('; ')}` : '',
    ].filter(Boolean);

    // 1. Create or update Stage Scene if requested
    let stageSceneId = sb.applied_stage_scene_id;
    const midDurationMs = Math.max(
      2000,
      Math.round(((sb.suggested_duration_min_s + sb.suggested_duration_max_s) / 2) * 1000),
    );

    if (createStageScenes) {
      const existingStage = stageSceneId
        ? draft.scenes.find((s) => s.scene_id === stageSceneId)
        : undefined;
      if (existingStage) {
        existingStage.name = sb.title || existingStage.name;
        existingStage.duration_ms = midDurationMs;
        existingStage.transition_in = inferTransitionType(sb.transition_suggestion);
        updatedStageScenes += 1;
      } else {
        const newStageId = uid('scn');
        const newStage: Scene = {
          scene_id: newStageId,
          project_id: draft.meta.project_id,
          order_index: draft.scenes.length,
          name: sb.title || `Scene ${sb.scene_number}`,
          start_ms: 0,
          duration_ms: midDurationMs,
          background_asset_id: null,
          background_color: '#1b1d26',
          transition_in: inferTransitionType(sb.transition_suggestion),
          transition_duration_ms: 500,
          camera_default: { x: 0, y: 0, zoom: 1, rotation_deg: 0 },
          characters: [],
          props: [],
        };
        draft.scenes.push(newStage);
        stageSceneId = newStageId;
        createdStageScenes += 1;
      }
      sb.applied_stage_scene_id = stageSceneId;
    }

    // 2. Create or update ScriptScene cleanly
    const existingScriptScene = sb.applied_script_scene_id
      ? scriptDoc.scenes.find((s) => s.script_scene_id === sb.applied_script_scene_id)
      : undefined;

    if (existingScriptScene) {
      existingScriptScene.title = sb.title || existingScriptScene.title;
      existingScriptScene.location = sb.location;
      existingScriptScene.time_of_day = sb.time_of_day;
      existingScriptScene.description = descriptionParts.join('\n');
      existingScriptScene.character_ids = linkedLibraryCharIds;
      existingScriptScene.notes = notesParts.join('\n');
      existingScriptScene.entries = entries;
      if (stageSceneId) existingScriptScene.linked_stage_scene_id = stageSceneId;
      updatedScriptScenes += 1;
    } else {
      const newScriptSceneId = uid('ssc');
      const newScriptScene: ScriptScene = {
        script_scene_id: newScriptSceneId,
        linked_stage_scene_id: stageSceneId ?? null,
        order_index: scriptDoc.scenes.length,
        title: sb.title || `Scene ${sb.scene_number}`,
        location: sb.location,
        time_of_day: sb.time_of_day,
        description: descriptionParts.join('\n'),
        background_asset_id: null,
        character_ids: linkedLibraryCharIds,
        notes: notesParts.join('\n'),
        entries,
        estimated_duration_ms: 0,
      };
      scriptDoc.scenes.push(newScriptScene);
      sb.applied_script_scene_id = newScriptSceneId;
      createdScriptScenes += 1;
    }
  }

  // Recalculate stage scene timelines and script durations cleanly
  recalculateScriptDurations(scriptDoc);
  let cursor = 0;
  draft.scenes.forEach((sc, idx) => {
    sc.order_index = idx;
    sc.start_ms = cursor;
    cursor += sc.duration_ms;
  });
  draft.timeline.total_duration_ms = Math.max(draft.timeline.total_duration_ms, cursor);
  draft.meta.duration_ms = draft.timeline.total_duration_ms;

  director.status = recomputeDirectorDocumentStatus(director);
  director.updated_at = new Date().toISOString();

  return {
    appliedCount: acceptedScenes.length,
    createdScriptScenes,
    updatedScriptScenes,
    createdStageScenes,
    updatedStageScenes,
  };
}
