/**
 * Phase 06 Batch 3 — Pure AI Production Planner Review, Readiness, Timeline Preview,
 * Conflict Detection & Idempotent Partial-Safe Timeline Execution Engine.
 *
 * Guarantees:
 * - Real data-driven readiness checking against actual Library Characters, Assets & Sounds
 * - Preview Before Applying with exact Timeline windows, operations, skipped unsupported items & conflicts
 * - Never silently overwrites existing user Timeline content
 * - Zero duplicate clips/keyframes/subtitles/characters across repeated applications (`timeline_refs` ownership)
 * - Partial execution safely executes supported operations while honestly reporting unsupported ones
 */

import { generatePresetKeyframes, quantizeMsToFrameMs } from '@/engine/presets';
import { ensureSubtitleDocument } from '@/engine/subtitleEngine';
import {
  evaluateCameraAngleNote,
  evaluateCameraMovementSupport,
} from '@/engine/storyboardEngine';
import type {
  AnimationActionCategory,
  Asset,
  CameraMovement,
  Character,
  CharacterAnimationClip,
  Keyframe,
  MissingDependency,
  ProductionApprovalStatus,
  ProductionPlanDocument,
  ProductionReadinessStatus,
  ProductionShotPlan,
  ProjectState,
  Scene,
  SceneCharacterInstance,
  ScreenPosition,
  SoundAsset,
  SoundEffectEvent,
  SubtitleSegment,
  TimelineInsertionStrategy,
  TimelineTrack,
} from '@/types/models';

function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function dedupeStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of items) {
    const clean = (v || '').trim();
    if (!clean) continue;
    const k = clean.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(clean);
    }
  }
  return out;
}

export function isSoundLicenseSafe(sound: SoundAsset): boolean {
  if (sound.is_bundled) return true;
  return (
    sound.license.usage === 'verified' &&
    ['cc0', 'royalty_free', 'user_imported', 'cc_by'].includes(sound.license.source)
  );
}

// --- 1. Real Data-Driven Readiness Re-Evaluation ---

export function evaluateShotPlanReadiness(
  shot: ProductionShotPlan,
  ctx: {
    characters: Character[];
    assets: Asset[];
    sounds: SoundAsset[];
  },
): ProductionShotPlan {
  const charById = new Map(ctx.characters.map((c) => [c.character_id, c]));
  const assetById = new Map(ctx.assets.map((a) => [a.asset_id, a]));
  const soundById = new Map(ctx.sounds.map((s) => [s.sound_id, s]));

  const deps: MissingDependency[] = [];
  const reasons: string[] = [];
  const addDep = (
    kind: MissingDependency['kind'],
    severity: MissingDependency['severity'],
    label: string,
    reason: string,
    suggested_action: string,
  ) => {
    deps.push({
      dependency_id: uid('dep'),
      kind,
      severity,
      label,
      reason,
      suggested_action,
    });
    reasons.push(reason);
  };

  let hasMissingChar = false;
  let hasMissingRig = false;
  const updatedChars = shot.characters.map((ch) => {
    const lib = ch.library_character_id ? charById.get(ch.library_character_id) : undefined;
    if (!lib) {
      hasMissingChar = true;
      addDep(
        'character',
        'blocking',
        ch.character_name,
        `Character "${ch.character_name}" is not linked to a Character Library rig.`,
        'Link an existing character or create one in Character Builder.',
      );
      return { ...ch, library_character_id: null, character_missing: true, rig_missing: true };
    }
    if (lib.parts.length === 0) {
      hasMissingRig = true;
      addDep(
        'rig',
        'blocking',
        lib.name,
        `Character "${lib.name}" has 0 assembled rig parts.`,
        'Assemble transparent PNG parts in Cutout Rig Editor.',
      );
      return { ...ch, character_missing: false, rig_missing: true };
    }
    return { ...ch, character_missing: false, rig_missing: false };
  });

  let hasMissingAsset = false;
  let hasAmbiguousReview = false;
  const checkAsset = <T extends NonNullable<ProductionShotPlan['background']>>(item: T): T => {
    let next = { ...item };
    if (next.matched_asset_id && !assetById.has(next.matched_asset_id)) {
      next = {
        ...next,
        matched_asset_id: null,
        matched_asset_name: '',
        classification: 'missing',
        notes: 'Referenced asset no longer exists in Asset Library.',
      };
    }
    if ((next.classification === 'missing' || next.classification === 'requires_new_asset') && next.required) {
      hasMissingAsset = true;
      addDep(
        'asset',
        'warning',
        next.label,
        `Missing ${next.kind} asset: ${next.label}.`,
        'Assign an existing asset or import a PNG in Asset Library.',
      );
    } else if (next.classification === 'requires_review') {
      hasAmbiguousReview = true;
      addDep(
        'review',
        'warning',
        next.label,
        `Ambiguous ${next.kind} match for "${next.label}" — select the intended asset.`,
        'Pick one of the candidate assets.',
      );
    }
    return next;
  };

  const updatedBg = shot.background ? checkAsset(shot.background) : null;
  const updatedAssets = shot.assets.map(checkAsset);

  let hasUnsupportedAnim = false;
  let hasMissingAnimParts = false;
  const updatedAnims = shot.animation_plans.map((ap) => {
    const lib = ap.library_character_id ? charById.get(ap.library_character_id) : undefined;
    let supported = ap.supported;
    let missingParts = ap.missing_parts;
    let reason = ap.unsupported_reason;

    if (!lib) {
      supported = false;
      missingParts = ['character_rig'];
      reason = `Character "${ap.character_name}" is not linked to a Character Library rig.`;
    } else if (lib.parts.length === 0) {
      supported = false;
      missingParts = ['body'];
      reason = `Character "${lib.name}" has 0 assembled rig parts.`;
    } else if (ap.category === 'blink') {
      const eyes = lib.parts.find((p) => p.part_role === 'eyes');
      supported = Boolean(eyes && eyes.variants['closed']);
      missingParts = supported ? [] : ['eyes:closed'];
      reason = supported ? '' : 'Rig lacks an eyes part with a closed variant.';
    } else if (ap.category === 'wave') {
      const arm = lib.parts.find((p) => p.part_role === 'right_arm' || p.part_role === 'left_arm');
      supported = Boolean(arm);
      missingParts = supported ? [] : ['right_arm|left_arm'];
      reason = supported ? '' : 'Rig lacks right_arm or left_arm part slot.';
    } else if (ap.category === 'look') {
      const head = lib.parts.find((p) => p.part_role === 'head');
      supported = Boolean(head);
      missingParts = supported ? [] : ['head'];
      reason = supported ? '' : 'Rig lacks a head part slot.';
    } else if (['fall', 'attack', 'custom'].includes(ap.category)) {
      supported = false;
    } else if (ap.category === 'sit') {
      const hasSit = lib.poses.some((p) => /sit|ngồi/i.test(p.name));
      supported = hasSit;
      missingParts = hasSit ? [] : ['pose:sit'];
    } else {
      supported = true;
      missingParts = [];
      reason = '';
    }

    if (!supported) {
      hasUnsupportedAnim = true;
      addDep(
        'animation',
        'warning',
        `${ap.character_name}: ${ap.category}`,
        reason || `Animation "${ap.category}" is unsupported for automatic execution.`,
        ap.manual_alternative || 'Keyframe manually on the Master Timeline.',
      );
    } else if (missingParts.length > 0) {
      hasMissingAnimParts = true;
      addDep(
        'rig',
        'info',
        `${ap.character_name}: ${missingParts.join(', ')}`,
        reason || `Optional rig parts missing: ${missingParts.join(', ')}.`,
        'Add missing rig parts in Cutout Rig Editor.',
      );
    }
    return { ...ap, supported, missing_parts: missingParts, unsupported_reason: reason };
  });

  const camSup = evaluateCameraMovementSupport(shot.camera_plan.camera_movement);
  const updatedCam = {
    ...shot.camera_plan,
    support_status: camSup.status,
    support_note: camSup.note,
    angle_note: evaluateCameraAngleNote(shot.camera_plan.camera_angle),
    executable_on_timeline: camSup.status === 'supported',
  };
  const hasUnsupportedCam = camSup.status === 'unsupported_suggestion';
  const hasApproxCam = camSup.status === '2d_approximation';
  if (hasUnsupportedCam) {
    addDep(
      'camera',
      'warning',
      `Camera: ${updatedCam.camera_movement}`,
      camSup.note,
      'Switch to an executable 2D movement (static/pan/tilt/zoom) or animate manually.',
    );
  } else if (hasApproxCam) {
    addDep(
      'camera',
      'info',
      `Camera: ${updatedCam.camera_movement}`,
      camSup.note,
      'Review 2D approximation or switch to explicit pan/zoom keyframes.',
    );
  }

  let hasMissingAudio = false;
  const checkAudio = (item: ProductionShotPlan['sfx_plans'][number]) => {
    let next = { ...item };
    if (next.matched_sound_id) {
      const snd = soundById.get(next.matched_sound_id);
      if (!snd) {
        next = {
          ...next,
          matched_sound_id: null,
          matched_sound_name: '',
          match_classification: 'missing',
          license_verified: false,
        };
      } else if (!isSoundLicenseSafe(snd)) {
        next = {
          ...next,
          matched_sound_id: null,
          matched_sound_name: '',
          match_classification: 'requires_review',
          license_verified: false,
          license_note: 'Unverified license — not auto-placed.',
        };
      } else {
        next = { ...next, license_verified: true };
      }
    }
    if (!next.matched_sound_id) {
      hasMissingAudio = true;
      addDep(
        'audio',
        'info',
        `${next.audio_type.toUpperCase()}: ${next.category || next.description}`,
        `No verified ${next.audio_type.toUpperCase()} clip matched for "${next.description || next.category}".`,
        'Select a verified clip from Audio Library or import one.',
      );
    }
    return next;
  };

  const updatedSfx = shot.sfx_plans.map(checkAudio);
  const updatedBgm = shot.bgm_plans.map(checkAudio);

  let readiness: ProductionReadinessStatus = 'ready';
  if (hasMissingChar) readiness = 'needs_character';
  else if (hasMissingRig) readiness = 'needs_rig';
  else if (hasUnsupportedAnim && hasUnsupportedCam) readiness = 'unsupported';
  else if (hasUnsupportedAnim) readiness = 'needs_animation';
  else if (hasUnsupportedCam) readiness = 'needs_camera_setup';
  else if (hasMissingAsset) readiness = 'needs_assets';
  else if (hasAmbiguousReview) readiness = 'needs_review';
  else if (hasMissingAudio) readiness = 'needs_audio';
  else if (hasMissingAnimParts || hasApproxCam) readiness = 'needs_review';
  else readiness = 'ready';

  const canExecuteAnything =
    updatedCam.executable_on_timeline ||
    updatedChars.some((c) => !c.character_missing) ||
    [...updatedSfx, ...updatedBgm].some((a) => Boolean(a.matched_sound_id && a.license_verified)) ||
    shot.voice_subtitle_plans.length > 0 ||
    Boolean(updatedBg?.matched_asset_id);

  return {
    ...shot,
    characters: updatedChars,
    background: updatedBg,
    assets: updatedAssets,
    animation_plans: updatedAnims,
    camera_plan: updatedCam,
    sfx_plans: updatedSfx,
    bgm_plans: updatedBgm,
    readiness_status: readiness,
    readiness_reasons: reasons,
    execution_capability: readiness === 'ready' ? 'full' : canExecuteAnything ? 'partial' : 'blocked',
    missing_dependencies: deps,
  };
}

// --- 2. Pure Production Plan Editing Operations ---

export function editProductionShotPlan(
  doc: ProductionPlanDocument,
  productionShotId: string,
  patch: Partial<
    Omit<
      ProductionShotPlan,
      'production_shot_id' | 'shot_id' | 'scene_id' | 'original_ai_snapshot' | 'user_edited_fields'
    >
  >,
  libCtx?: { characters: Character[]; assets: Asset[]; sounds: SoundAsset[] },
): ProductionPlanDocument {
  const nextShots = doc.shots.map((sh) => {
    if (sh.production_shot_id !== productionShotId) return sh;
    const touched = Object.keys(patch).filter((k) => k !== 'locked' && k !== 'approval_status');
    let updated: ProductionShotPlan = {
      ...sh,
      ...patch,
      user_edited_fields: dedupeStrings([...sh.user_edited_fields, ...touched]),
      approval_status: patch.approval_status ?? (touched.length > 0 ? 'edited' : sh.approval_status),
    };
    if (libCtx) {
      updated = evaluateShotPlanReadiness(updated, libCtx);
    }
    return updated;
  });
  return { ...doc, status: 'edited', shots: nextShots, updated_at: new Date().toISOString() };
}

export function toggleLockProductionShot(
  doc: ProductionPlanDocument,
  productionShotId: string,
  locked?: boolean,
): ProductionPlanDocument {
  return {
    ...doc,
    shots: doc.shots.map((sh) =>
      sh.production_shot_id === productionShotId
        ? { ...sh, locked: locked !== undefined ? locked : !sh.locked }
        : sh,
    ),
    updated_at: new Date().toISOString(),
  };
}

export function setProductionShotApproval(
  doc: ProductionPlanDocument,
  productionShotId: string,
  approval: ProductionApprovalStatus,
): ProductionPlanDocument {
  return {
    ...doc,
    shots: doc.shots.map((sh) =>
      sh.production_shot_id === productionShotId ? { ...sh, approval_status: approval } : sh,
    ),
    updated_at: new Date().toISOString(),
  };
}

export function approveSceneProductionShots(
  doc: ProductionPlanDocument,
  sceneId: string,
): ProductionPlanDocument {
  return {
    ...doc,
    shots: doc.shots.map((sh) =>
      sh.scene_id === sceneId && sh.approval_status !== 'rejected'
        ? { ...sh, approval_status: 'approved' as const }
        : sh,
    ),
    updated_at: new Date().toISOString(),
  };
}

export function approveAllProductionShots(doc: ProductionPlanDocument): ProductionPlanDocument {
  return {
    ...doc,
    shots: doc.shots.map((sh) =>
      sh.approval_status !== 'rejected' ? { ...sh, approval_status: 'approved' as const } : sh,
    ),
    updated_at: new Date().toISOString(),
  };
}

export function assignShotBackgroundAsset(
  doc: ProductionPlanDocument,
  productionShotId: string,
  asset: Asset | null,
  libCtx: { characters: Character[]; assets: Asset[]; sounds: SoundAsset[] },
): ProductionPlanDocument {
  const shot = doc.shots.find((s) => s.production_shot_id === productionShotId);
  if (!shot) return doc;
  const bg = shot.background ?? {
    requirement_id: uid('areq'),
    kind: 'background' as const,
    label: 'Scene Background',
    query: '',
    classification: 'missing' as const,
    matched_asset_id: null,
    matched_asset_name: '',
    candidates: [],
    required: true,
    notes: '',
  };
  return editProductionShotPlan(
    doc,
    productionShotId,
    {
      background: {
        ...bg,
        matched_asset_id: asset ? asset.asset_id : null,
        matched_asset_name: asset ? asset.name : '',
        classification: asset ? 'existing_compatible' : 'missing',
        notes: asset ? `Assigned '${asset.name}' by user.` : 'Unassigned.',
      },
    },
    libCtx,
  );
}

export function assignShotPropAsset(
  doc: ProductionPlanDocument,
  productionShotId: string,
  requirementId: string,
  asset: Asset | null,
  libCtx: { characters: Character[]; assets: Asset[]; sounds: SoundAsset[] },
): ProductionPlanDocument {
  const shot = doc.shots.find((s) => s.production_shot_id === productionShotId);
  if (!shot) return doc;
  const nextAssets = shot.assets.map((item) =>
    item.requirement_id === requirementId
      ? {
          ...item,
          matched_asset_id: asset ? asset.asset_id : null,
          matched_asset_name: asset ? asset.name : '',
          classification: asset ? ('existing_compatible' as const) : ('missing' as const),
          notes: asset ? `Assigned '${asset.name}' by user.` : 'Unassigned.',
        }
      : item,
  );
  return editProductionShotPlan(
    doc,
    productionShotId,
    { assets: nextAssets },
    libCtx,
  );
}

export function assignShotCharacterLibrary(
  doc: ProductionPlanDocument,
  productionShotId: string,
  stagingId: string,
  character: Character | null,
  libCtx: { characters: Character[]; assets: Asset[]; sounds: SoundAsset[] },
): ProductionPlanDocument {
  const shot = doc.shots.find((s) => s.production_shot_id === productionShotId);
  if (!shot) return doc;
  const targetStaging = shot.characters.find((c) => c.staging_id === stagingId);
  if (!targetStaging) return doc;

  const nextChars = shot.characters.map((c) =>
    c.staging_id === stagingId
      ? {
          ...c,
          library_character_id: character ? character.character_id : null,
          character_missing: !character,
          rig_missing: !character || character.parts.length === 0,
        }
      : c,
  );
  const nextAnims = shot.animation_plans.map((ap) =>
    ap.character_name.toLowerCase() === targetStaging.character_name.toLowerCase()
      ? { ...ap, library_character_id: character ? character.character_id : null }
      : ap,
  );

  return editProductionShotPlan(
    doc,
    productionShotId,
    { characters: nextChars, animation_plans: nextAnims },
    libCtx,
  );
}

export function assignShotAudioSound(
  doc: ProductionPlanDocument,
  productionShotId: string,
  listKind: 'sfx' | 'bgm',
  audioPlanId: string,
  sound: SoundAsset | null,
  libCtx: { characters: Character[]; assets: Asset[]; sounds: SoundAsset[] },
): ProductionPlanDocument {
  const shot = doc.shots.find((s) => s.production_shot_id === productionShotId);
  if (!shot) return doc;
  const list = listKind === 'sfx' ? shot.sfx_plans : shot.bgm_plans;
  const safe = sound ? isSoundLicenseSafe(sound) : false;
  const nextList = list.map((a) =>
    a.audio_plan_id === audioPlanId
      ? {
          ...a,
          matched_sound_id: sound && safe ? sound.sound_id : null,
          matched_sound_name: sound && safe ? sound.name : '',
          license_verified: safe,
          license_note: sound ? (safe ? `Verified (${sound.license.source})` : 'Unverified license — blocked') : '',
          match_classification: sound && safe ? ('existing_compatible' as const) : ('missing' as const),
        }
      : a,
  );
  return editProductionShotPlan(
    doc,
    productionShotId,
    listKind === 'sfx' ? { sfx_plans: nextList } : { bgm_plans: nextList },
    libCtx,
  );
}

const CATEGORY_EXECUTION_MAP: Record<
  AnimationActionCategory,
  {
    state: ProductionShotPlan['animation_plans'][number]['mapped_animation_state'];
    preset: string | null;
    reason?: string;
    alt?: string;
  }
> = {
  idle: { state: 'IDLE', preset: 'idle_breathe' },
  stand: { state: 'IDLE', preset: 'idle_breathe' },
  walk: { state: 'WALKING', preset: 'walk_cycle' },
  run: { state: 'RUNNING', preset: 'walk_cycle' },
  blink: { state: 'IDLE', preset: null },
  talk: { state: 'SPEAKING', preset: null },
  wave: { state: 'IDLE', preset: 'part_wave' },
  look: { state: 'IDLE', preset: 'part_look' },
  turn: { state: 'TRANSITION', preset: null },
  jump: { state: 'REACTING', preset: 'bounce' },
  react: { state: 'REACTING', preset: 'bounce' },
  sit: {
    state: 'IDLE',
    preset: null,
    reason: 'Sit animation requires a matching sit PosePreset on the character rig.',
    alt: 'Create a Sit pose in Cutout Rig Editor or keyframe manually.',
  },
  fall: {
    state: null,
    preset: null,
    reason: 'Physics-driven falling is not supported by the 2D procedural engine.',
    alt: 'Keyframe Y position and rotation manually on the Master Timeline.',
  },
  attack: {
    state: null,
    preset: null,
    reason: 'Complex combat/attack choreography is not supported by the 2D procedural engine.',
    alt: 'Compose attack poses and keyframes manually in the Rig Editor & Timeline.',
  },
  custom: {
    state: null,
    preset: null,
    reason: 'Custom motion requires manual keyframing.',
    alt: 'Animate manually on the Master Timeline.',
  },
};

export function updateShotCameraMovementPlan(
  doc: ProductionPlanDocument,
  productionShotId: string,
  cameraMovement: CameraMovement,
  libCtx: { characters: Character[]; assets: Asset[]; sounds: SoundAsset[] },
): ProductionPlanDocument {
  const shot = doc.shots.find((s) => s.production_shot_id === productionShotId);
  if (!shot) return doc;
  const cp = { ...shot.camera_plan.camera_plan };
  const baseZ = cp.start_zoom || 1;
  cp.end_x = cp.start_x;
  cp.end_y = cp.start_y;
  cp.end_zoom = baseZ;
  cp.end_rotation_deg = cp.start_rotation_deg;
  if (cameraMovement === 'pan_left') cp.end_x = cp.start_x - 160;
  else if (cameraMovement === 'pan_right') cp.end_x = cp.start_x + 160;
  else if (cameraMovement === 'tilt_up') cp.end_y = cp.start_y - 110;
  else if (cameraMovement === 'tilt_down') cp.end_y = cp.start_y + 110;
  else if (cameraMovement === 'zoom_in') cp.end_zoom = Number((baseZ * 1.18).toFixed(2));
  else if (cameraMovement === 'zoom_out') cp.end_zoom = Number(Math.max(0.5, baseZ * 0.85).toFixed(2));

  return editProductionShotPlan(
    doc,
    productionShotId,
    {
      camera_plan: {
        ...shot.camera_plan,
        camera_movement: cameraMovement,
        camera_plan: cp,
      },
    },
    libCtx,
  );
}

export function updateShotAnimationCategory(
  doc: ProductionPlanDocument,
  productionShotId: string,
  actionPlanId: string,
  category: AnimationActionCategory,
  libCtx: { characters: Character[]; assets: Asset[]; sounds: SoundAsset[] },
): ProductionPlanDocument {
  const shot = doc.shots.find((s) => s.production_shot_id === productionShotId);
  if (!shot) return doc;
  const mapping = CATEGORY_EXECUTION_MAP[category] ?? CATEGORY_EXECUTION_MAP.custom;
  return editProductionShotPlan(
    doc,
    productionShotId,
    {
      animation_plans: shot.animation_plans.map((ap) =>
        ap.action_plan_id === actionPlanId
          ? {
              ...ap,
              category,
              mapped_animation_state: mapping.state,
              mapped_preset_id: mapping.preset,
              unsupported_reason: mapping.reason ?? '',
              manual_alternative: mapping.alt ?? ap.manual_alternative,
            }
          : ap,
      ),
    },
    libCtx,
  );
}

// --- 3. Timeline Preview Before Applying & Conflict Detection ---

export interface TimelineConflict {
  conflict_id: string;
  production_shot_id: string;
  shot_title: string;
  kind: 'camera_keyframe' | 'animation_clip' | 'audio_event' | 'subtitle';
  start_ms: number;
  end_ms: number;
  description: string;
}

export interface TimelineShotPreviewItem {
  production_shot_id: string;
  scene_id: string;
  shot_order: number;
  title: string;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  is_reapply: boolean;
  readiness_status: ProductionReadinessStatus;
  execution_capability: ProductionShotPlan['execution_capability'];
  characters_to_place: string[];
  animations_to_apply: string[];
  camera_summary: string;
  camera_executable: boolean;
  audio_to_place: string[];
  subtitles_to_place: number;
  skipped_unsupported: string[];
  conflicts: TimelineConflict[];
}

export interface TimelineApplyPreview {
  shots: TimelineShotPreviewItem[];
  total_duration_ms: number;
  total_conflicts: number;
  total_skipped_unsupported: number;
  suggested_strategy: TimelineInsertionStrategy;
  append_offset_ms: number;
}

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function computeExistingTimelineEndMs(project: ProjectState): number {
  let maxEnd = 0;
  for (const kf of project.timeline.keyframes) maxEnd = Math.max(maxEnd, kf.time_ms);
  for (const cl of project.timeline.animation_clips) maxEnd = Math.max(maxEnd, cl.end_ms);
  for (const ev of project.timeline.sound_events) maxEnd = Math.max(maxEnd, ev.end_ms);
  for (const sub of project.subtitles?.segments ?? []) maxEnd = Math.max(maxEnd, sub.end_ms);
  return maxEnd;
}

function resolveShotTimelineWindow(
  project: ProjectState,
  shot: ProductionShotPlan,
  sceneOffsets: Map<string, number>,
): { startMs: number; endMs: number } {
  const base = sceneOffsets.get(shot.scene_id) ?? 0;
  const startMs = base + shot.start_time_ms;
  const endMs = startMs + Math.max(500, shot.duration_ms);
  return { startMs, endMs };
}

function buildSceneBaseOffsets(project: ProjectState, targetShots: ProductionShotPlan[]): Map<string, number> {
  const map = new Map<string, number>();
  const stageById = new Map(project.scenes.map((s) => [s.scene_id, s]));
  const seenScenes: string[] = [];
  for (const sh of targetShots) {
    if (!seenScenes.includes(sh.scene_id)) seenScenes.push(sh.scene_id);
  }
  let runningEnd = project.scenes.reduce((acc, s) => Math.max(acc, s.start_ms + s.duration_ms), 0);
  for (const sid of seenScenes) {
    const stage = stageById.get(sid);
    if (stage) {
      map.set(sid, stage.start_ms);
    } else {
      map.set(sid, runningEnd);
      const sceneDur = targetShots
        .filter((s) => s.scene_id === sid)
        .reduce((acc, s) => acc + s.duration_ms, 0);
      runningEnd += Math.max(1000, sceneDur);
    }
  }
  return map;
}

export function buildTimelineApplyPreview(
  project: ProjectState,
  targetShots: ProductionShotPlan[],
  libCtx: { characters: Character[]; assets: Asset[]; sounds: SoundAsset[] },
): TimelineApplyPreview {
  const charById = new Map(libCtx.characters.map((c) => [c.character_id, c]));
  const soundById = new Map(libCtx.sounds.map((s) => [s.sound_id, s]));

  // Collect ALL IDs owned by the target production shots so re-applying is NOT treated as a conflict!
  const allOwnedKfs = new Set<string>();
  const allOwnedClips = new Set<string>();
  const allOwnedSounds = new Set<string>();
  const allOwnedSubs = new Set<string>();
  for (const sh of targetShots) {
    for (const id of sh.timeline_refs.keyframe_ids) allOwnedKfs.add(id);
    for (const id of sh.timeline_refs.animation_clip_ids) allOwnedClips.add(id);
    for (const id of sh.timeline_refs.sound_event_ids) allOwnedSounds.add(id);
    for (const id of sh.timeline_refs.subtitle_ids) allOwnedSubs.add(id);
  }

  const sceneOffsets = buildSceneBaseOffsets(project, targetShots);
  const appendOffsetMs = computeExistingTimelineEndMs(project);

  const previewShots: TimelineShotPreviewItem[] = [];
  let totalConflicts = 0;
  let totalSkipped = 0;

  for (const sh of targetShots) {
    const { startMs, endMs } = resolveShotTimelineWindow(project, sh, sceneOffsets);
    const skipped: string[] = [];

    const charsToPlace: string[] = [];
    for (const c of sh.characters) {
      if (c.library_character_id && charById.has(c.library_character_id)) {
        charsToPlace.push(c.character_name);
      } else {
        skipped.push(`Character "${c.character_name}" skipped (no linked Character Library rig)`);
      }
    }

    const animsToApply: string[] = [];
    for (const ap of sh.animation_plans) {
      if (ap.supported && ap.library_character_id && charById.has(ap.library_character_id)) {
        animsToApply.push(`${ap.character_name}: ${ap.category}`);
      } else {
        skipped.push(
          `Animation "${ap.character_name}: ${ap.category}" skipped (${ap.unsupported_reason || 'unsupported'})`,
        );
      }
    }

    const cameraExecutable = sh.camera_plan.executable_on_timeline && sh.camera_plan.support_status === 'supported';
    if (!cameraExecutable) {
      skipped.push(
        `Camera "${sh.camera_plan.camera_movement}" skipped (${sh.camera_plan.support_note})`,
      );
    }

    const audioToPlace: string[] = [];
    for (const aud of [...sh.sfx_plans, ...sh.bgm_plans]) {
      const snd = aud.matched_sound_id ? soundById.get(aud.matched_sound_id) : undefined;
      if (snd && aud.license_verified && isSoundLicenseSafe(snd)) {
        audioToPlace.push(`${aud.audio_type.toUpperCase()}: ${snd.name}`);
      } else {
        skipped.push(
          `Audio "${aud.audio_type.toUpperCase()}: ${aud.category || aud.description}" skipped (missing or unverified license)`,
        );
      }
    }

    const conflicts: TimelineConflict[] = [];

    // Detect non-owned Camera Keyframes overlapping this shot window
    if (cameraExecutable) {
      const foreignCamKfs = project.timeline.keyframes.filter(
        (k) =>
          k.target_type === 'camera' &&
          !allOwnedKfs.has(k.keyframe_id) &&
          k.time_ms >= startMs &&
          k.time_ms <= endMs,
      );
      if (foreignCamKfs.length > 0) {
        conflicts.push({
          conflict_id: uid('conf'),
          production_shot_id: sh.production_shot_id,
          shot_title: sh.title,
          kind: 'camera_keyframe',
          start_ms: startMs,
          end_ms: endMs,
          description: `${foreignCamKfs.length} existing user camera keyframe(s) overlap ${(startMs / 1000).toFixed(1)}s–${(endMs / 1000).toFixed(1)}s.`,
        });
      }
    }

    // Detect non-owned Character Animation Clips overlapping this shot window
    const foreignClips = project.timeline.animation_clips.filter(
      (c) => !allOwnedClips.has(c.clip_id) && rangesOverlap(c.start_ms, c.end_ms, startMs, endMs),
    );
    if (foreignClips.length > 0 && animsToApply.length > 0) {
      conflicts.push({
        conflict_id: uid('conf'),
        production_shot_id: sh.production_shot_id,
        shot_title: sh.title,
        kind: 'animation_clip',
        start_ms: startMs,
        end_ms: endMs,
        description: `${foreignClips.length} existing character animation clip(s) overlap this window.`,
      });
    }

    // Detect non-owned Audio Events overlapping this shot window
    if (audioToPlace.length > 0) {
      const foreignAudio = project.timeline.sound_events.filter(
        (ev) => !allOwnedSounds.has(ev.event_id) && rangesOverlap(ev.start_ms, ev.end_ms, startMs, endMs),
      );
      if (foreignAudio.length > 0) {
        conflicts.push({
          conflict_id: uid('conf'),
          production_shot_id: sh.production_shot_id,
          shot_title: sh.title,
          kind: 'audio_event',
          start_ms: startMs,
          end_ms: endMs,
          description: `${foreignAudio.length} existing timeline audio clip(s) overlap this window.`,
        });
      }
    }

    // Detect non-owned Subtitles overlapping this shot window
    if (sh.voice_subtitle_plans.length > 0) {
      const foreignSubs = (project.subtitles?.segments ?? []).filter(
        (seg) => !allOwnedSubs.has(seg.subtitle_id) && rangesOverlap(seg.start_ms, seg.end_ms, startMs, endMs),
      );
      if (foreignSubs.length > 0) {
        conflicts.push({
          conflict_id: uid('conf'),
          production_shot_id: sh.production_shot_id,
          shot_title: sh.title,
          kind: 'subtitle',
          start_ms: startMs,
          end_ms: endMs,
          description: `${foreignSubs.length} existing subtitle segment(s) overlap this window.`,
        });
      }
    }

    totalConflicts += conflicts.length;
    totalSkipped += skipped.length;

    previewShots.push({
      production_shot_id: sh.production_shot_id,
      scene_id: sh.scene_id,
      shot_order: sh.shot_order,
      title: sh.title,
      start_ms: startMs,
      end_ms: endMs,
      duration_ms: sh.duration_ms,
      is_reapply: sh.timeline_refs.applied,
      readiness_status: sh.readiness_status,
      execution_capability: sh.execution_capability,
      characters_to_place: charsToPlace,
      animations_to_apply: animsToApply,
      camera_summary: `${sh.camera_plan.shot_size} • ${sh.camera_plan.camera_angle} • ${sh.camera_plan.camera_movement}`,
      camera_executable: cameraExecutable,
      audio_to_place: audioToPlace,
      subtitles_to_place: sh.voice_subtitle_plans.length,
      skipped_unsupported: skipped,
      conflicts,
    });
  }

  return {
    shots: previewShots,
    total_duration_ms: previewShots.reduce((acc, s) => acc + s.duration_ms, 0),
    total_conflicts: totalConflicts,
    total_skipped_unsupported: totalSkipped,
    suggested_strategy: totalConflicts > 0 ? 'skip_conflicting' : 'update_owned_only',
    append_offset_ms: appendOffsetMs,
  };
}

// --- 4. Idempotent Safe Production Plan -> Master Timeline Execution ---

export interface TimelineApplyResult {
  appliedShots: number;
  skippedConflictingShots: number;
  charactersPlaced: number;
  keyframesCreated: number;
  animationClipsCreated: number;
  audioClipsCreated: number;
  subtitlesCreated: number;
  skippedUnsupportedCount: number;
}

const SCREEN_POS_X_RATIO: Record<ScreenPosition, number> = {
  far_left: 0.14,
  left: 0.26,
  center_left: 0.38,
  center: 0.5,
  center_right: 0.62,
  right: 0.74,
  far_right: 0.86,
  offscreen: -0.15,
};

function ensureTrack(
  draft: ProjectState,
  trackType: TimelineTrack['track_type'],
  name: string,
  targetRefId: string | null = null,
): TimelineTrack {
  const existing = draft.timeline.tracks.find(
    (t) => t.track_type === trackType && (targetRefId ? t.target_ref_id === targetRefId : true),
  );
  if (existing) return existing;
  const orderMap: Record<TimelineTrack['track_type'], number> = {
    scene: 0,
    camera: 1,
    character: 10,
    prop: 50,
    subtitle: 800,
    voice: 900,
    sfx: 1000,
    bgm: 1100,
    ambient: 1200,
    lipsync: 950,
  };
  const trk: TimelineTrack = {
    track_id: uid(`trk_${trackType}`),
    project_id: draft.meta.project_id,
    track_type: trackType,
    name,
    target_ref_id: targetRefId,
    order_index: orderMap[trackType] + draft.timeline.tracks.length,
    muted: false,
    locked: false,
    solo: false,
    visible: true,
    volume: trackType === 'bgm' ? 0.55 : trackType === 'ambient' ? 0.7 : 1.0,
    collapsed: false,
  };
  draft.timeline.tracks.push(trk);
  return trk;
}

/**
 * Safely executes supported operations from approved `ProductionShotPlan`s onto the real
 * Master Timeline, Scenes, and Subtitles with zero duplicates on repeated application!
 */
export function applyProductionPlanToTimeline(
  draft: ProjectState,
  options: {
    targetShotIds: string[];
    strategy: TimelineInsertionStrategy;
    characters: Character[];
    assets: Asset[];
    sounds: SoundAsset[];
  },
): TimelineApplyResult {
  const planDoc = draft.production_plan;
  if (!planDoc || options.targetShotIds.length === 0) {
    return {
      appliedShots: 0,
      skippedConflictingShots: 0,
      charactersPlaced: 0,
      keyframesCreated: 0,
      animationClipsCreated: 0,
      audioClipsCreated: 0,
      subtitlesCreated: 0,
      skippedUnsupportedCount: 0,
    };
  }

  const targetIdSet = new Set(options.targetShotIds);
  const targetShots = planDoc.shots.filter((s) => targetIdSet.has(s.production_shot_id));
  const preview = buildTimelineApplyPreview(draft, targetShots, {
    characters: options.characters,
    assets: options.assets,
    sounds: options.sounds,
  });
  const previewById = new Map(preview.shots.map((p) => [p.production_shot_id, p]));

  const charById = new Map(options.characters.map((c) => [c.character_id, c]));
  const assetById = new Map(options.assets.map((a) => [a.asset_id, a]));
  const soundById = new Map(options.sounds.map((s) => [s.sound_id, s]));

  draft.subtitles = ensureSubtitleDocument(draft.subtitles);
  const fps = draft.timeline.fps || 30;
  const stageW = draft.meta.width || 1920;
  const stageH = draft.meta.height || 1080;

  let appendCursor = options.strategy === 'append_after_existing' ? computeExistingTimelineEndMs(draft) : 0;

  const result: TimelineApplyResult = {
    appliedShots: 0,
    skippedConflictingShots: 0,
    charactersPlaced: 0,
    keyframesCreated: 0,
    animationClipsCreated: 0,
    audioClipsCreated: 0,
    subtitlesCreated: 0,
    skippedUnsupportedCount: 0,
  };

  for (const shot of targetShots) {
    const pv = previewById.get(shot.production_shot_id);
    if (!pv) continue;

    // 1. Respect conflict strategy!
    if (options.strategy === 'skip_conflicting' && pv.conflicts.length > 0) {
      result.skippedConflictingShots += 1;
      continue;
    }

    // Remove ONLY previously owned clips/keyframes/subtitles created by THIS production_shot_id
    // (100% idempotent re-application; NEVER removes user-created clips!)
    const prevOwnedKfs = new Set(shot.timeline_refs.keyframe_ids);
    const prevOwnedClips = new Set(shot.timeline_refs.animation_clip_ids);
    const prevOwnedSounds = new Set(shot.timeline_refs.sound_event_ids);
    const prevOwnedSubs = new Set(shot.timeline_refs.subtitle_ids);

    if (prevOwnedKfs.size > 0) {
      draft.timeline.keyframes = draft.timeline.keyframes.filter((k) => !prevOwnedKfs.has(k.keyframe_id));
    }
    if (prevOwnedClips.size > 0) {
      draft.timeline.animation_clips = draft.timeline.animation_clips.filter(
        (c) => !prevOwnedClips.has(c.clip_id),
      );
    }
    if (prevOwnedSounds.size > 0) {
      draft.timeline.sound_events = draft.timeline.sound_events.filter(
        (e) => !prevOwnedSounds.has(e.event_id),
      );
    }
    if (prevOwnedSubs.size > 0) {
      draft.subtitles.segments = draft.subtitles.segments.filter(
        (seg) => !prevOwnedSubs.has(seg.subtitle_id),
      );
    }

    const startMs =
      options.strategy === 'append_after_existing'
        ? appendCursor
        : pv.start_ms;
    const endMs = startMs + Math.max(500, shot.duration_ms);
    if (options.strategy === 'append_after_existing') {
      appendCursor = endMs;
    }

    // 2. Ensure / reuse Stage Scene
    let stageScene: Scene | undefined =
      (shot.timeline_refs.stage_scene_id
        ? draft.scenes.find((s) => s.scene_id === shot.timeline_refs.stage_scene_id)
        : undefined) ?? draft.scenes.find((s) => s.scene_id === shot.scene_id);

    if (!stageScene) {
      const newSceneId = shot.scene_id.startsWith('scn_') ? shot.scene_id : uid('scn');
      stageScene = {
        scene_id: newSceneId,
        project_id: draft.meta.project_id,
        order_index: draft.scenes.length,
        name: shot.title || `Scene ${draft.scenes.length + 1}`,
        start_ms: startMs,
        duration_ms: Math.max(2000, shot.duration_ms),
        background_asset_id: null,
        background_color: '#14161A',
        transition_in: shot.transition_out === 'fade' ? 'fade' : shot.transition_out === 'cross_dissolve' ? 'cross_dissolve' : 'cut',
        transition_duration_ms: 400,
        camera_default: { x: 0, y: 0, zoom: 1, rotation_deg: 0 },
        characters: [],
        props: [],
      };
      draft.scenes.push(stageScene);
    }

    // Set matched real background asset if scene doesn't already have a user-assigned background
    if (
      shot.background?.matched_asset_id &&
      assetById.has(shot.background.matched_asset_id) &&
      !stageScene.background_asset_id
    ) {
      stageScene.background_asset_id = shot.background.matched_asset_id;
    }
    const neededSceneDur = endMs - stageScene.start_ms;
    if (neededSceneDur > stageScene.duration_ms) {
      stageScene.duration_ms = neededSceneDur;
    }

    const newCharInstanceIds: string[] = [];
    const newKfIds: string[] = [];
    const newClipIds: string[] = [];
    const newSoundEventIds: string[] = [];
    const newSubIds: string[] = [];
    const skippedOps: string[] = [];

    const instanceByLibCharId = new Map<string, { inst: SceneCharacterInstance; trackId: string }>();

    // 3. Place / reuse real linked Characters on Stage Scene
    for (const cp of shot.characters) {
      if (!cp.library_character_id || !charById.has(cp.library_character_id)) {
        skippedOps.push(`Character "${cp.character_name}" skipped (missing library character)`);
        continue;
      }
      const libChar = charById.get(cp.library_character_id)!;
      let inst = stageScene.characters.find((c) => c.character_id === libChar.character_id);
      const posX = Math.round(stageW * (SCREEN_POS_X_RATIO[cp.screen_position] ?? 0.5));
      const posY = Math.round(
        stageH * (cp.depth_layer === 'foreground' ? 0.64 : cp.depth_layer === 'background' ? 0.52 : 0.58),
      );
      const scaleMag = cp.depth_layer === 'foreground' ? 1.1 : cp.depth_layer === 'background' ? 0.82 : 1.0;
      const facingSign = cp.facing_direction === 'left' || cp.facing_direction === 'three_quarter_left' ? -1 : 1;

      if (!inst) {
        inst = {
          instance_id: uid('cinst'),
          scene_id: stageScene.scene_id,
          character_id: libChar.character_id,
          display_name: libChar.name,
          z_index: cp.depth_layer === 'foreground' ? 20 : cp.depth_layer === 'background' ? 8 : 14,
          visible: cp.visible,
          locked: false,
          initial_transform: {
            x: posX,
            y: posY,
            rotation_deg: 0,
            scale_x: scaleMag * facingSign,
            scale_y: scaleMag,
            opacity: cp.visible ? 1 : 0,
          },
          default_expression_id: cp.expression_id ?? null,
          default_pose_id: cp.initial_pose_id ?? null,
          default_eye_state: 'open',
          default_mouth_state: 'closed',
        };
        stageScene.characters.push(inst);
        result.charactersPlaced += 1;
      }
      const charTrack = ensureTrack(draft, 'character', inst.display_name, inst.instance_id);
      instanceByLibCharId.set(libChar.character_id, { inst, trackId: charTrack.track_id });
      newCharInstanceIds.push(inst.instance_id);

      // Keyframe shot-start staging transform cleanly so multi-shot character positioning works!
      const qStart = quantizeMsToFrameMs(startMs, fps);
      const stageProps: Array<[Keyframe['property'], number]> = [
        ['x', posX],
        ['y', posY],
        ['scale_x', scaleMag * facingSign],
        ['scale_y', scaleMag],
        ['opacity', cp.visible ? 1 : 0],
      ];
      for (const [prop, val] of stageProps) {
        const kid = uid('kf');
        draft.timeline.keyframes.push({
          keyframe_id: kid,
          track_id: charTrack.track_id,
          target_type: 'character_instance',
          target_id: inst.instance_id,
          property: prop,
          time_ms: qStart,
          value: val,
          easing: 'hold',
        });
        newKfIds.push(kid);
        result.keyframesCreated += 1;
      }
    }

    // 4. Apply ONLY Supported Animation Plans
    for (const ap of shot.animation_plans) {
      if (!ap.supported || !ap.library_character_id) {
        skippedOps.push(`Animation "${ap.character_name}: ${ap.category}" skipped (${ap.unsupported_reason || 'unsupported'})`);
        continue;
      }
      const placed = instanceByLibCharId.get(ap.library_character_id);
      const libChar = charById.get(ap.library_character_id);
      if (!placed || !libChar) {
        skippedOps.push(`Animation "${ap.character_name}: ${ap.category}" skipped (character not placed in scene)`);
        continue;
      }
      const animEnd = Math.min(endMs, startMs + Math.max(500, ap.estimated_duration_ms));

      if (ap.mapped_animation_state) {
        const clipId = uid('acl');
        const clip: CharacterAnimationClip = {
          clip_id: clipId,
          track_id: placed.trackId,
          instance_id: placed.inst.instance_id,
          start_ms: startMs,
          end_ms: animEnd,
          animation_state: ap.mapped_animation_state,
          procedural: {
            auto_blink: ap.category === 'blink' || Boolean(ap.parameters['auto_blink']),
            blink_interval_ms: 3500,
            blink_duration_ms: 140,
            breathing: true,
            breathing_amplitude: 0.015,
            breathing_period_ms: 3200,
            walk_bounce_px: ap.category === 'run' ? 18 : 12,
            walk_cycle_ms: ap.category === 'run' ? 420 : 600,
          },
        };
        draft.timeline.animation_clips.push(clip);
        newClipIds.push(clipId);
        result.animationClipsCreated += 1;
      }

      // Generate real editable preset or part keyframes for kinetic presets
      const startFrame = Math.round((startMs * fps) / 1000);
      if (ap.mapped_preset_id === 'walk_cycle' || ap.mapped_preset_id === 'bounce' || ap.mapped_preset_id === 'move_left' || ap.mapped_preset_id === 'move_right') {
        const generated = generatePresetKeyframes({
          presetId: ap.mapped_preset_id,
          targetType: 'character_instance',
          targetId: placed.inst.instance_id,
          trackId: placed.trackId,
          startFrame,
          fps,
          baseTransform: placed.inst.initial_transform,
        });
        for (const spec of generated) {
          if (spec.time_ms > endMs) continue;
          const kid = uid('kf');
          draft.timeline.keyframes.push({
            keyframe_id: kid,
            track_id: spec.track_id,
            target_type: spec.target_type,
            target_id: spec.target_id,
            property: spec.property,
            time_ms: spec.time_ms,
            value: spec.value,
            easing: spec.easing,
          });
          newKfIds.push(kid);
          result.keyframesCreated += 1;
        }
      } else if (ap.mapped_preset_id === 'part_wave') {
        const armSlot = libChar.parts.find((p) => p.part_role === 'right_arm' || p.part_role === 'left_arm');
        if (armSlot) {
          const targetId = `${placed.inst.instance_id}:${armSlot.slot_id}`;
          const baseRot = armSlot.default_transform.rotation_deg;
          const waveSteps: Array<[number, number]> = [
            [startMs, baseRot],
            [startMs + 350, baseRot - 28],
            [startMs + 700, baseRot + 18],
            [startMs + 1050, baseRot - 24],
            [Math.min(endMs, startMs + 1400), baseRot],
          ];
          for (const [tMs, deg] of waveSteps) {
            const kid = uid('kf');
            draft.timeline.keyframes.push({
              keyframe_id: kid,
              track_id: placed.trackId,
              target_type: 'character_part',
              target_id: targetId,
              property: 'rotation_deg',
              time_ms: quantizeMsToFrameMs(tMs, fps),
              value: deg,
              easing: 'ease_in_out',
            });
            newKfIds.push(kid);
            result.keyframesCreated += 1;
          }
        }
      } else if (ap.mapped_preset_id === 'part_look') {
        const headSlot = libChar.parts.find((p) => p.part_role === 'head');
        if (headSlot) {
          const targetId = `${placed.inst.instance_id}:${headSlot.slot_id}`;
          const baseRot = headSlot.default_transform.rotation_deg;
          const lookSteps: Array<[number, number]> = [
            [startMs, baseRot],
            [startMs + 450, baseRot + 12],
            [Math.min(endMs, startMs + 1100), baseRot],
          ];
          for (const [tMs, deg] of lookSteps) {
            const kid = uid('kf');
            draft.timeline.keyframes.push({
              keyframe_id: kid,
              track_id: placed.trackId,
              target_type: 'character_part',
              target_id: targetId,
              property: 'rotation_deg',
              time_ms: quantizeMsToFrameMs(tMs, fps),
              value: deg,
              easing: 'ease_in_out',
            });
            newKfIds.push(kid);
            result.keyframesCreated += 1;
          }
        }
      }
    }

    // 5. Apply Executable 2D Camera Keyframes ONLY (never fake unsupported parallax!)
    if (shot.camera_plan.executable_on_timeline && shot.camera_plan.support_status === 'supported') {
      const camTrack = ensureTrack(draft, 'camera', 'Camera');
      const cp = shot.camera_plan.camera_plan;
      const qStart = quantizeMsToFrameMs(startMs, fps);
      const qEnd = quantizeMsToFrameMs(Math.max(startMs + 200, endMs - 100), fps);

      const camPairs: Array<[Keyframe['property'], number, number]> = [
        ['x', cp.start_x, cp.end_x],
        ['y', cp.start_y, cp.end_y],
        ['zoom', cp.start_zoom, cp.end_zoom],
        ['rotation_deg', cp.start_rotation_deg, cp.end_rotation_deg],
      ];
      for (const [prop, v0, v1] of camPairs) {
        const k1 = uid('kf');
        draft.timeline.keyframes.push({
          keyframe_id: k1,
          track_id: camTrack.track_id,
          target_type: 'camera',
          target_id: 'camera',
          property: prop,
          time_ms: qStart,
          value: v0,
          easing: cp.easing,
        });
        newKfIds.push(k1);
        result.keyframesCreated += 1;

        if (v1 !== v0) {
          const k2 = uid('kf');
          draft.timeline.keyframes.push({
            keyframe_id: k2,
            track_id: camTrack.track_id,
            target_type: 'camera',
            target_id: 'camera',
            property: prop,
            time_ms: qEnd,
            value: v1,
            easing: cp.easing,
          });
          newKfIds.push(k2);
          result.keyframesCreated += 1;
        }
      }
    } else {
      skippedOps.push(
        `Camera "${shot.camera_plan.camera_movement}" skipped (${shot.camera_plan.support_note})`,
      );
    }

    // 6. Apply Verified License-Safe SFX & BGM Audio Clips ONLY
    for (const aud of [...shot.sfx_plans, ...shot.bgm_plans]) {
      const snd = aud.matched_sound_id ? soundById.get(aud.matched_sound_id) : undefined;
      if (!snd || !aud.license_verified || !isSoundLicenseSafe(snd)) {
        skippedOps.push(`Audio "${aud.audio_type.toUpperCase()}: ${aud.category || aud.description}" skipped`);
        continue;
      }
      const trackType = aud.audio_type === 'bgm' ? 'bgm' : aud.audio_type === 'ambient' ? 'ambient' : 'sfx';
      const trackLabel = trackType === 'bgm' ? 'BGM Track 1' : trackType === 'ambient' ? 'Ambient Track 1' : 'SFX Track 1';
      const audTrack = ensureTrack(draft, trackType, trackLabel);
      const evStart = startMs + Math.max(0, aud.offset_ms);
      const evDur = Math.max(250, aud.duration_ms || snd.duration_ms || 1500);
      const evEnd = aud.audio_type === 'bgm' ? Math.max(evStart + 500, endMs) : evStart + evDur;

      const evId = uid(`${trackType}_ev`);
      const ev: SoundEffectEvent = {
        event_id: evId,
        track_id: audTrack.track_id,
        sound_id: snd.sound_id,
        start_ms: evStart,
        end_ms: evEnd,
        trim_start_ms: 0,
        volume: aud.volume,
        speed: 1.0,
        fade_in_ms: aud.fade_in_ms,
        fade_out_ms: aud.fade_out_ms,
        loop: aud.loop,
        spatial_position: 0,
        source_scene_id: stageScene.scene_id,
      };
      draft.timeline.sound_events.push(ev);
      newSoundEventIds.push(evId);
      result.audioClipsCreated += 1;
    }

    // 7. Apply Subtitles & Voice Clips (reusing/linking existing references cleanly without duplicating!)
    if (shot.voice_subtitle_plans.length > 0) {
      ensureTrack(draft, 'subtitle', 'Subtitles');
      for (const vs of shot.voice_subtitle_plans) {
        const subStart = startMs + Math.max(0, vs.start_offset_ms);
        const subEnd = Math.min(endMs, subStart + Math.max(600, vs.duration_ms));

        // Do not duplicate an already-existing non-owned subtitle segment with exact same script_entry_id!
        const existingSeg = vs.subtitle_segment_id
          ? draft.subtitles.segments.find((s) => s.subtitle_id === vs.subtitle_segment_id)
          : vs.script_entry_id
            ? draft.subtitles.segments.find((s) => s.script_entry_id === vs.script_entry_id)
            : undefined;

        if (existingSeg) {
          // Existing user/subtitle-studio segment: never duplicate and do not claim destructive ownership
          existingSeg.scene_id = existingSeg.scene_id || stageScene.scene_id;
        } else {
          const subId = uid('sub');
          const seg: SubtitleSegment = {
            subtitle_id: subId,
            text: vs.text,
            start_ms: subStart,
            end_ms: Math.max(subStart + 400, subEnd),
            scene_id: stageScene.scene_id,
            speaker_character_id: vs.library_character_id,
            speaker_name: vs.speaker_name,
            script_entry_id: vs.script_entry_id,
            voice_audio_asset_id: vs.voice_audio_asset_id,
            timing_source: vs.sync_mode === 'exact_voice' ? 'voice_duration' : 'estimated',
            style_id: draft.subtitles.default_style_id,
            position_override: null,
            enabled: true,
          };
          draft.subtitles.segments.push(seg);
          newSubIds.push(subId);
          result.subtitlesCreated += 1;
        }

        // Place real linked voice clip if a registered voice SoundAsset exists
        if (vs.voice_sound_id && soundById.has(vs.voice_sound_id)) {
          const voiceTrack = ensureTrack(draft, 'voice', 'Voice Track 1');
          const vEvId = uid('voice_ev');
          draft.timeline.sound_events.push({
            event_id: vEvId,
            track_id: voiceTrack.track_id,
            sound_id: vs.voice_sound_id,
            start_ms: subStart,
            end_ms: Math.max(subStart + 400, subEnd),
            trim_start_ms: 0,
            volume: 1.0,
            speed: 1.0,
            fade_in_ms: 0,
            fade_out_ms: 0,
            loop: false,
            spatial_position: 0,
            source_scene_id: stageScene.scene_id,
          });
          newSoundEventIds.push(vEvId);
          result.audioClipsCreated += 1;
        }
      }
    }

    // Record exact ownership refs back on this production shot so re-apply is 100% idempotent!
    shot.timeline_refs = {
      applied: true,
      applied_at: new Date().toISOString(),
      stage_scene_id: stageScene.scene_id,
      applied_start_ms: startMs,
      applied_end_ms: endMs,
      character_instance_ids: newCharInstanceIds,
      keyframe_ids: newKfIds,
      animation_clip_ids: newClipIds,
      sound_event_ids: newSoundEventIds,
      subtitle_ids: newSubIds,
      skipped_operations: skippedOps,
    };

    if (endMs > draft.timeline.total_duration_ms) {
      draft.timeline.total_duration_ms = endMs;
      draft.meta.duration_ms = endMs;
    }

    result.appliedShots += 1;
    result.skippedUnsupportedCount += skippedOps.length;
  }

  // Keep subtitles sorted chronologically
  draft.subtitles.segments.sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
  if (result.appliedShots > 0) {
    planDoc.status = 'applied';
    planDoc.updated_at = new Date().toISOString();
  }

  return result;
}
