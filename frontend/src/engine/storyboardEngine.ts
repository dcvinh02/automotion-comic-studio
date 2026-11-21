/**
 * Phase 06 Batch 2 — Pure Storyboard, Shot Editing, Camera Capability & Continuity Engine.
 *
 * Mirrors backend/core/storyboard_engine/camera_capabilities.py and continuity.py so every
 * user edit (add/delete/duplicate/reorder/camera/staging/duration/lock) recalculates timings,
 * 2D camera feasibility, and continuity warnings instantaneously with full Undo/Redo support.
 */

import type {
  Camera2DKeyPlan,
  CameraAngle,
  CameraMovement,
  CameraSupportStatus,
  Character,
  ContinuityWarning,
  ProjectState,
  ScreenPosition,
  ShotCharacterStaging,
  ShotSize,
  StoryboardDocument,
  StoryboardShot,
} from '@/types/models';

function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function norm(s: string): string {
  return (s || '').trim().toLowerCase();
}

function dedupeStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const clean = (raw || '').trim();
    if (!clean) continue;
    const k = clean.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(clean);
    }
  }
  return out;
}

function stableHash(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// --- Authoritative 2D Camera Capability Matrix ---

export const SHOT_SIZES: ShotSize[] = [
  'extreme_wide',
  'wide',
  'full',
  'medium_full',
  'medium',
  'medium_close_up',
  'close_up',
  'extreme_close_up',
  'over_the_shoulder',
  'pov',
  'insert',
];

export const CAMERA_ANGLES: CameraAngle[] = [
  'eye_level',
  'low_angle',
  'high_angle',
  'birds_eye',
  'worms_eye',
  'dutch_angle',
  'over_the_shoulder',
  'pov',
];

export const CAMERA_MOVEMENTS: CameraMovement[] = [
  'static',
  'pan_left',
  'pan_right',
  'tilt_up',
  'tilt_down',
  'zoom_in',
  'zoom_out',
  'dolly_in',
  'dolly_out',
  'tracking',
  'camera_follow',
  'shake',
  'parallax',
];

export const CAMERA_MOVEMENT_SUPPORT: Record<
  CameraMovement,
  { status: CameraSupportStatus; note: string }
> = {
  static: {
    status: 'supported',
    note: 'Directly executable via fixed 2D Camera (x, y, zoom, rotation_deg).',
  },
  pan_left: {
    status: 'supported',
    note: 'Directly executable via 2D Camera horizontal X keyframes.',
  },
  pan_right: {
    status: 'supported',
    note: 'Directly executable via 2D Camera horizontal X keyframes.',
  },
  tilt_up: {
    status: 'supported',
    note: 'Directly executable via 2D Camera vertical Y pan keyframes.',
  },
  tilt_down: {
    status: 'supported',
    note: 'Directly executable via 2D Camera vertical Y pan keyframes.',
  },
  zoom_in: {
    status: 'supported',
    note: 'Directly executable via 2D Camera zoom keyframes.',
  },
  zoom_out: {
    status: 'supported',
    note: 'Directly executable via 2D Camera zoom keyframes.',
  },
  dolly_in: {
    status: '2d_approximation',
    note: '2D approximation via zoom-in only; true 3D perspective dolly depth is not supported by the 2D camera.',
  },
  dolly_out: {
    status: '2d_approximation',
    note: '2D approximation via zoom-out only; true 3D perspective dolly depth is not supported by the 2D camera.',
  },
  tracking: {
    status: '2d_approximation',
    note: 'Requires manual 2D camera X/Y keyframes matched to character motion; automatic motion tracking is not implemented.',
  },
  camera_follow: {
    status: '2d_approximation',
    note: 'Requires manual 2D camera X/Y keyframes; automatic target-follow camera constraints are not yet implemented.',
  },
  shake: {
    status: '2d_approximation',
    note: 'Requires manual rapid camera X/Y/rotation keyframes; procedural camera shake filter is not yet implemented.',
  },
  parallax: {
    status: 'unsupported_suggestion',
    note: 'Unsupported in single-plane 2D camera (planning suggestion only; requires multi-depth 2.5D parallax layers).',
  },
};

export const CAMERA_ANGLE_NOTES: Record<CameraAngle, string> = {
  eye_level: 'Native 2D neutral framing.',
  dutch_angle: 'Executable via 2D camera rotation_deg tilt.',
  low_angle: '2D staging direction: compose artwork/character scale upward (no 3D camera pitch).',
  high_angle: '2D staging direction: compose artwork/horizon higher in frame (no 3D camera pitch).',
  birds_eye: '2D art direction: requires dedicated top-down background/character art.',
  worms_eye: '2D art direction: requires dedicated steep low-horizon art.',
  over_the_shoulder: '2D staging direction: place foreground shoulder silhouette near frame edge.',
  pov: '2D staging direction: frame directly from character viewpoint without showing speaker.',
};

const SHOT_SIZE_ZOOM: Record<ShotSize, number> = {
  extreme_wide: 0.85,
  wide: 1.0,
  full: 1.08,
  medium_full: 1.18,
  medium: 1.32,
  medium_close_up: 1.55,
  close_up: 1.85,
  extreme_close_up: 2.35,
  over_the_shoulder: 1.45,
  pov: 1.25,
  insert: 2.1,
};

export function evaluateCameraMovementSupport(movement: CameraMovement): {
  status: CameraSupportStatus;
  note: string;
} {
  return (
    CAMERA_MOVEMENT_SUPPORT[movement] ?? {
      status: 'unsupported_suggestion',
      note: 'Planning suggestion only.',
    }
  );
}

export function evaluateCameraAngleNote(angle: CameraAngle): string {
  return CAMERA_ANGLE_NOTES[angle] ?? '2D composition direction.';
}

export function buildDefault2DCameraPlan(
  shotSize: ShotSize,
  angle: CameraAngle,
  movement: CameraMovement,
): Camera2DKeyPlan {
  const baseZoom = SHOT_SIZE_ZOOM[shotSize] ?? 1.2;
  const rot = angle === 'dutch_angle' ? 7.5 : 0;
  let sx = 0;
  let sy = 0;
  let ex = 0;
  let ey = 0;
  let sz = baseZoom;
  let ez = baseZoom;

  if (movement === 'pan_left') {
    sx = 90;
    ex = -90;
  } else if (movement === 'pan_right') {
    sx = -90;
    ex = 90;
  } else if (movement === 'tilt_up') {
    sy = 60;
    ey = -60;
  } else if (movement === 'tilt_down') {
    sy = -60;
    ey = 60;
  } else if (movement === 'zoom_in' || movement === 'dolly_in') {
    ez = Math.min(4.0, Math.round(baseZoom * 118) / 100);
  } else if (movement === 'zoom_out' || movement === 'dolly_out') {
    sz = Math.min(4.0, Math.round(baseZoom * 118) / 100);
    ez = baseZoom;
  } else if (movement === 'tracking' || movement === 'camera_follow') {
    sx = -70;
    ex = 70;
  }

  return {
    start_x: sx,
    start_y: sy,
    start_zoom: sz,
    start_rotation_deg: rot,
    end_x: ex,
    end_y: ey,
    end_zoom: ez,
    end_rotation_deg: rot,
    easing: movement === 'pan_left' || movement === 'pan_right' || movement === 'tracking' ? 'linear' : 'ease_in_out',
  };
}

// --- Timing & Continuity Analysis ---

export function recalculateSceneShotTimings(shots: StoryboardShot[]): StoryboardShot[] {
  const cursors = new Map<string, number>();
  const orders = new Map<string, number>();
  return shots.map((sh) => {
    const order = (orders.get(sh.scene_id) ?? 0) + 1;
    const start = cursors.get(sh.scene_id) ?? 0;
    const dur = Math.max(500, Math.round(sh.duration_ms || 3000));
    const end = start + dur;
    orders.set(sh.scene_id, order);
    cursors.set(sh.scene_id, end);
    return {
      ...sh,
      shot_order: order,
      duration_ms: dur,
      start_time_ms: start,
      end_time_ms: end,
    };
  });
}

const POS_INDEX: Record<ScreenPosition, number> = {
  far_left: -3,
  left: -2,
  center_left: -1,
  center: 0,
  center_right: 1,
  right: 2,
  far_right: 3,
  offscreen: 99,
};

const MOVEMENT_CUES = [
  'walk', 'run', 'cross', 'move', 'step', 'rush', 'dash', 'jump', 'approach', 'slide', 'enter', 'reposition',
  'bước', 'chạy', 'đi qua', 'di chuyển', 'lao', 'tiến', 'lùi', 'sang', 'vào',
];
const TURN_CUES = [
  'turn', 'spin', 'look back', 'look away', 'pivot', 'twist', 'face', 'glances', 'reverse',
  'quay', 'ngoái', 'xoay', 'nhìn sang', 'quay đầu', 'đối mặt',
];
const EXIT_CUES = [
  'exit', 'leave', 'leaves', 'walk out', 'walks out', 'runs out', 'disappear', 'vanish', 'depart',
  'rời đi', 'rời khỏi', 'bước ra', 'đi khuất', 'biến mất', 'thoát ra',
];
const ENTER_CUES = [
  'enter', 'enters', 'return', 'returns', 'comes back', 'steps back', 'reappear', 'arrives',
  'bước vào', 'quay lại', 'trở lại', 'xuất hiện',
];

function hasAnyCue(text: string, cues: string[]): boolean {
  const low = norm(text);
  return cues.some((c) => low.includes(c));
}

function isLeftFacing(f: string): boolean {
  return f === 'left' || f === 'three_quarter_left';
}

function isRightFacing(f: string): boolean {
  return f === 'right' || f === 'three_quarter_right';
}

function envTokens(env: string): Set<string> {
  const stop = new Set([
    'the', 'and', 'with', 'from', 'near', 'under', 'trong', 'ngoài', 'trên', 'dưới', 'của', 'với', 'tại', 'một', 'các',
  ]);
  const out = new Set<string>();
  for (const w of norm(env).split(/\s+/)) {
    const clean = w.replace(/[.,;:!?()[\]"'—-]/g, '');
    if (clean.length >= 3 && !stop.has(clean)) out.add(clean);
  }
  return out;
}

export function analyzeStoryboardContinuity(
  shots: StoryboardShot[],
  existingWarnings: ContinuityWarning[] = [],
): ContinuityWarning[] {
  const prevFlags = new Map<string, { reviewed: boolean; dismissed: boolean }>();
  for (const w of existingWarnings) {
    prevFlags.set(w.warning_id, { reviewed: w.reviewed, dismissed: w.dismissed });
  }

  const warnings: ContinuityWarning[] = [];
  const addWarn = (
    sceneId: string,
    shotId: string,
    prevShotId: string | null,
    category: ContinuityWarning['category'],
    severity: ContinuityWarning['severity'],
    title: string,
    description: string,
    key: string,
  ) => {
    const wid = `cw_${stableHash(`${sceneId}|${shotId}|${category}|${key}`)}`;
    const flags = prevFlags.get(wid) ?? { reviewed: false, dismissed: false };
    warnings.push({
      warning_id: wid,
      scene_id: sceneId,
      shot_id: shotId,
      previous_shot_id: prevShotId,
      category,
      severity,
      title,
      description,
      reviewed: flags.reviewed,
      dismissed: flags.dismissed,
    });
  };

  const byScene = new Map<string, StoryboardShot[]>();
  for (const sh of shots) {
    const arr = byScene.get(sh.scene_id) ?? [];
    arr.push(sh);
    byScene.set(sh.scene_id, arr);
  }

  for (const [sceneId, sceneShots] of byScene.entries()) {
    const ordered = [...sceneShots].sort((a, b) => a.shot_order - b.shot_order);

    const speakingIdxs = new Map<string, number[]>();
    ordered.forEach((sh, i) => {
      for (const ch of sh.characters) {
        if (ch.speaking) {
          const k = norm(ch.character_name);
          speakingIdxs.set(k, [...(speakingIdxs.get(k) ?? []), i]);
        }
      }
      for (const d of sh.dialogue_refs) {
        if (d.speaker_name) {
          const k = norm(d.speaker_name);
          speakingIdxs.set(k, [...(speakingIdxs.get(k) ?? []), i]);
        }
      }
    });

    ordered.forEach((curr, idx) => {
      const prev = idx > 0 ? ordered[idx - 1] : null;
      const currChars = new Map(curr.characters.map((c) => [norm(c.character_name), c]));

      for (const ch of curr.characters) {
        if (ch.is_missing_asset || !ch.library_character_id) {
          addWarn(
            sceneId,
            curr.shot_id,
            null,
            'missing_character_asset',
            'info',
            `Unlinked character asset: ${ch.character_name}`,
            `Shot ${curr.shot_order} stages "${ch.character_name}" without a linked Character Library rig.`,
            `missing_${norm(ch.character_name)}`,
          );
        }
        if (ch.reacting && !ch.visible) {
          addWarn(
            sceneId,
            curr.shot_id,
            prev?.shot_id ?? null,
            'reaction_missing_character',
            'warning',
            `Invisible reacting character: ${ch.character_name}`,
            `Shot ${curr.shot_order} marks "${ch.character_name}" as reacting while hidden.`,
            `react_inv_${norm(ch.character_name)}`,
          );
        }
      }

      for (const dlg of curr.dialogue_refs) {
        const spk = norm(dlg.speaker_name);
        if (spk && !currChars.has(spk) && curr.shot_size !== 'insert' && curr.shot_size !== 'pov') {
          addWarn(
            sceneId,
            curr.shot_id,
            prev?.shot_id ?? null,
            'dialogue_gap',
            'warning',
            `Dialogue speaker not staged: ${dlg.speaker_name}`,
            `Shot ${curr.shot_order} has dialogue for "${dlg.speaker_name}" who is not listed in character staging.`,
            `dlg_missing_${spk}`,
          );
        }
      }

      if (!prev) return;
      const prevChars = new Map(prev.characters.map((c) => [norm(c.character_name), c]));
      const isReverse =
        curr.shot_size === 'over_the_shoulder' ||
        prev.shot_size === 'over_the_shoulder' ||
        curr.camera_angle === 'over_the_shoulder' ||
        curr.camera_angle === 'pov';

      for (const [k, cCurr] of currChars.entries()) {
        const cPrev = prevChars.get(k);
        if (!cPrev) continue;
        const motion = `${cPrev.action} ${cPrev.movement} ${cCurr.action} ${cCurr.movement}`;

        if (
          hasAnyCue(`${cPrev.action} ${cPrev.movement}`, EXIT_CUES) &&
          cCurr.visible &&
          cCurr.screen_position !== 'offscreen' &&
          !hasAnyCue(`${cCurr.action} ${cCurr.movement}`, ENTER_CUES)
        ) {
          addWarn(
            sceneId,
            curr.shot_id,
            prev.shot_id,
            'entry_exit',
            'warning',
            `Entry/Exit mismatch: ${cCurr.character_name}`,
            `"${cCurr.character_name}" exited in Shot ${prev.shot_order} yet appears visible in Shot ${curr.shot_order} without re-entering.`,
            `exit_${k}`,
          );
        }

        if (cPrev.visible && cCurr.visible) {
          const p1 = POS_INDEX[cPrev.screen_position] ?? 0;
          const p2 = POS_INDEX[cCurr.screen_position] ?? 0;
          if (p1 !== 99 && p2 !== 99 && Math.abs(p1 - p2) >= 3 && !isReverse && !hasAnyCue(motion, MOVEMENT_CUES)) {
            addWarn(
              sceneId,
              curr.shot_id,
              prev.shot_id,
              'position_jump',
              'warning',
              `Sudden position jump: ${cCurr.character_name}`,
              `"${cCurr.character_name}" jumps from ${cPrev.screen_position} (Shot ${prev.shot_order}) to ${cCurr.screen_position} (Shot ${curr.shot_order}) without movement.`,
              `pos_${k}`,
            );
          }

          const flipped =
            (isLeftFacing(cPrev.facing_direction) && isRightFacing(cCurr.facing_direction)) ||
            (isRightFacing(cPrev.facing_direction) && isLeftFacing(cCurr.facing_direction));
          if (flipped && !isReverse && !hasAnyCue(motion, TURN_CUES)) {
            addWarn(
              sceneId,
              curr.shot_id,
              prev.shot_id,
              'facing_flip',
              'warning',
              `Facing / screen direction flip: ${cCurr.character_name}`,
              `"${cCurr.character_name}" flips facing from ${cPrev.facing_direction} (Shot ${prev.shot_order}) to ${cCurr.facing_direction} (Shot ${curr.shot_order}) without turning.`,
              `facing_${k}`,
            );
          }
        }
      }

      if (['extreme_wide', 'wide', 'full', 'medium_full'].includes(curr.shot_size)) {
        for (const [k, cPrev] of prevChars.entries()) {
          if (currChars.has(k)) continue;
          if (hasAnyCue(`${cPrev.action} ${cPrev.movement}`, EXIT_CUES)) continue;
          const idxs = speakingIdxs.get(k) ?? [];
          if (idxs.some((i) => i <= idx - 1) && idxs.some((i) => i >= idx + 1)) {
            addWarn(
              sceneId,
              curr.shot_id,
              prev.shot_id,
              'character_disappearance',
              'warning',
              `Character disappears mid-dialogue: ${cPrev.character_name}`,
              `"${cPrev.character_name}" speaks before and after Shot ${curr.shot_order} (${curr.shot_size}) but is absent without an exit.`,
              `disappear_${k}`,
            );
          }
        }
      }

      const prevEnv = envTokens(prev.environment);
      const currEnv = envTokens(curr.environment);
      let sharedEnv = 0;
      for (const tok of prevEnv) if (currEnv.has(tok)) sharedEnv++;
      if (
        prevEnv.size >= 2 &&
        currEnv.size >= 2 &&
        sharedEnv === 0 &&
        !['close_up', 'extreme_close_up', 'insert'].includes(curr.shot_size) &&
        prev.transition_out === 'cut'
      ) {
        addWarn(
          sceneId,
          curr.shot_id,
          prev.shot_id,
          'location_shift',
          'info',
          `Possible environment shift (Shot ${prev.shot_order} -> ${curr.shot_order})`,
          `Environment changed from "${prev.environment}" to "${curr.environment}" on a direct cut.`,
          `env_${prev.shot_order}_${curr.shot_order}`,
        );
      }
    });
  }

  return warnings;
}

// --- Pure Storyboard Document CRUD & Editing ---

export function ensureStoryboardDocument(doc?: StoryboardDocument | null): StoryboardDocument {
  if (doc) return doc;
  return {
    storyboard_id: uid('sbdoc'),
    version: 1,
    provider_id: '',
    model: '',
    analysis_language: 'auto',
    status: 'idle',
    shots: [],
    continuity_warnings: [],
    scene_hashes: {},
    generation_history: [],
    updated_at: new Date().toISOString(),
  };
}

function finalizeDoc(doc: StoryboardDocument, shots: StoryboardShot[]): StoryboardDocument {
  const timed = recalculateSceneShotTimings(shots);
  const warnings = analyzeStoryboardContinuity(timed, doc.continuity_warnings);
  return {
    ...doc,
    status: timed.length > 0 ? (doc.status === 'idle' ? 'edited' : doc.status) : 'idle',
    shots: timed,
    continuity_warnings: warnings,
    updated_at: new Date().toISOString(),
  };
}

export function addStoryboardShot(
  doc: StoryboardDocument,
  params: {
    sceneId: string;
    sceneBreakdownId?: string | null;
    scriptSceneId?: string | null;
    afterShotId?: string | null;
    environment?: string;
    title?: string;
  },
): { doc: StoryboardDocument; shotId: string } {
  const shotId = uid('shot');
  const existingInScene = doc.shots.filter((s) => s.scene_id === params.sceneId);
  const sup = evaluateCameraMovementSupport('static');
  const newShot: StoryboardShot = {
    shot_id: shotId,
    scene_id: params.sceneId,
    scene_breakdown_id: params.sceneBreakdownId ?? null,
    script_scene_id: params.scriptSceneId ?? null,
    shot_order: existingInScene.length + 1,
    title: params.title?.trim() || `Shot ${existingInScene.length + 1}`,
    purpose: '',
    shot_size: 'medium',
    camera_angle: 'eye_level',
    camera_movement: 'static',
    camera_support_status: sup.status,
    camera_support_note: sup.note,
    camera_angle_note: evaluateCameraAngleNote('eye_level'),
    camera_plan: buildDefault2DCameraPlan('medium', 'eye_level', 'static'),
    duration_ms: 3200,
    start_time_ms: 0,
    end_time_ms: 3200,
    characters: [],
    dialogue_refs: [],
    narration_refs: [],
    environment: params.environment ?? existingInScene[existingInScene.length - 1]?.environment ?? '',
    visual_focus: '',
    emotional_emphasis: '',
    props_in_shot: [],
    transition_out: 'cut',
    ai_rationale: '',
    confidence: 1.0,
    warnings: [],
    locked: false,
    user_edited_fields: ['title'],
    original_ai_snapshot: null,
  };

  const nextShots = [...doc.shots];
  if (params.afterShotId) {
    const idx = nextShots.findIndex((s) => s.shot_id === params.afterShotId);
    if (idx !== -1) {
      nextShots.splice(idx + 1, 0, newShot);
    } else {
      nextShots.push(newShot);
    }
  } else {
    // Insert at end of this scene's block
    let lastIdx = -1;
    nextShots.forEach((s, i) => {
      if (s.scene_id === params.sceneId) lastIdx = i;
    });
    if (lastIdx !== -1) nextShots.splice(lastIdx + 1, 0, newShot);
    else nextShots.push(newShot);
  }

  return { doc: finalizeDoc(doc, nextShots), shotId };
}

export function duplicateStoryboardShot(
  doc: StoryboardDocument,
  shotId: string,
): { doc: StoryboardDocument; createdShotId: string } | null {
  const idx = doc.shots.findIndex((s) => s.shot_id === shotId);
  if (idx === -1) return null;
  const src = doc.shots[idx];
  const createdShotId = uid('shot');
  const clone: StoryboardShot = {
    ...src,
    shot_id: createdShotId,
    title: `${src.title} (Copy)`,
    locked: false,
    characters: src.characters.map((c) => ({ ...c, staging_id: uid('stg') })),
    dialogue_refs: src.dialogue_refs.map((r) => ({ ...r })),
    narration_refs: src.narration_refs.map((r) => ({ ...r })),
    camera_plan: { ...src.camera_plan },
    user_edited_fields: dedupeStrings([...src.user_edited_fields, 'title']),
    original_ai_snapshot: null,
  };
  const nextShots = [...doc.shots];
  nextShots.splice(idx + 1, 0, clone);
  return { doc: finalizeDoc(doc, nextShots), createdShotId };
}

export function deleteStoryboardShot(doc: StoryboardDocument, shotId: string): StoryboardDocument {
  const nextShots = doc.shots.filter((s) => s.shot_id !== shotId);
  return finalizeDoc(doc, nextShots);
}

export function editStoryboardShot(
  doc: StoryboardDocument,
  shotId: string,
  patch: Partial<
    Omit<
      StoryboardShot,
      'shot_id' | 'scene_id' | 'shot_order' | 'start_time_ms' | 'end_time_ms' | 'original_ai_snapshot' | 'user_edited_fields'
    >
  >,
): StoryboardDocument {
  const idx = doc.shots.findIndex((s) => s.shot_id === shotId);
  if (idx === -1) return doc;
  const existing = doc.shots[idx];

  const nextSize = patch.shot_size ?? existing.shot_size;
  const nextAngle = patch.camera_angle ?? existing.camera_angle;
  const nextMove = patch.camera_movement ?? existing.camera_movement;
  const sup = evaluateCameraMovementSupport(nextMove);
  const angleNote = evaluateCameraAngleNote(nextAngle);

  const cameraChanged =
    patch.shot_size !== undefined ||
    patch.camera_angle !== undefined ||
    patch.camera_movement !== undefined;
  const nextCamPlan =
    patch.camera_plan ??
    (cameraChanged ? buildDefault2DCameraPlan(nextSize, nextAngle, nextMove) : existing.camera_plan);

  const editedKeys = Object.keys(patch).filter((k) => k !== 'locked');
  const nextEdited = dedupeStrings([...existing.user_edited_fields, ...editedKeys]);

  const updated: StoryboardShot = {
    ...existing,
    ...patch,
    shot_size: nextSize,
    camera_angle: nextAngle,
    camera_movement: nextMove,
    camera_support_status: sup.status,
    camera_support_note: sup.note,
    camera_angle_note: angleNote,
    camera_plan: nextCamPlan,
    duration_ms: Math.max(500, Math.min(60000, Math.round(patch.duration_ms ?? existing.duration_ms))),
    user_edited_fields: nextEdited,
  };

  const nextShots = doc.shots.map((s, i) => (i === idx ? updated : s));
  return finalizeDoc({ ...doc, status: 'edited' }, nextShots);
}

export function toggleLockStoryboardShot(
  doc: StoryboardDocument,
  shotId: string,
  locked?: boolean,
): StoryboardDocument {
  const idx = doc.shots.findIndex((s) => s.shot_id === shotId);
  if (idx === -1) return doc;
  const nextShots = doc.shots.map((s, i) =>
    i === idx ? { ...s, locked: locked !== undefined ? locked : !s.locked } : s,
  );
  return { ...doc, shots: nextShots, updated_at: new Date().toISOString() };
}

export function moveStoryboardShot(
  doc: StoryboardDocument,
  shotId: string,
  delta: -1 | 1,
): StoryboardDocument | null {
  const target = doc.shots.find((s) => s.shot_id === shotId);
  if (!target) return null;

  const sceneIndices: number[] = [];
  doc.shots.forEach((s, i) => {
    if (s.scene_id === target.scene_id) sceneIndices.push(i);
  });
  const localPos = sceneIndices.findIndex((gi) => doc.shots[gi].shot_id === shotId);
  const nextLocalPos = localPos + delta;
  if (localPos === -1 || nextLocalPos < 0 || nextLocalPos >= sceneIndices.length) return null;

  const gA = sceneIndices[localPos];
  const gB = sceneIndices[nextLocalPos];
  const nextShots = [...doc.shots];
  const tmp = nextShots[gA];
  nextShots[gA] = nextShots[gB];
  nextShots[gB] = tmp;

  return finalizeDoc({ ...doc, status: 'edited' }, nextShots);
}

export function reorderStoryboardShotsInScene(
  doc: StoryboardDocument,
  sourceShotId: string,
  targetShotId: string,
  position: 'before' | 'after',
): StoryboardDocument | null {
  if (sourceShotId === targetShotId) return null;
  const src = doc.shots.find((s) => s.shot_id === sourceShotId);
  const tgt = doc.shots.find((s) => s.shot_id === targetShotId);
  if (!src || !tgt || src.scene_id !== tgt.scene_id) return null;

  const sceneShots = doc.shots.filter((s) => s.scene_id === src.scene_id);
  const withoutSrc = sceneShots.filter((s) => s.shot_id !== sourceShotId);
  const tgtIdx = withoutSrc.findIndex((s) => s.shot_id === targetShotId);
  if (tgtIdx === -1) return null;
  withoutSrc.splice(position === 'before' ? tgtIdx : tgtIdx + 1, 0, src);

  let cursor = 0;
  const nextShots = doc.shots.map((s) => (s.scene_id === src.scene_id ? withoutSrc[cursor++] : s));
  return finalizeDoc({ ...doc, status: 'edited' }, nextShots);
}

export function addShotCharacterStaging(
  doc: StoryboardDocument,
  shotId: string,
  character: {
    characterName: string;
    libraryCharacterId?: string | null;
    characterAnalysisId?: string | null;
  },
): StoryboardDocument {
  const sh = doc.shots.find((s) => s.shot_id === shotId);
  if (!sh) return doc;
  const staging: ShotCharacterStaging = {
    staging_id: uid('stg'),
    character_analysis_id: character.characterAnalysisId ?? null,
    library_character_id: character.libraryCharacterId ?? null,
    character_name: character.characterName.trim() || 'Character',
    is_missing_asset: !character.libraryCharacterId,
    visible: true,
    speaking: false,
    reacting: false,
    screen_position: sh.characters.length === 0 ? 'center' : sh.characters.length === 1 ? 'right' : 'left',
    depth_layer: 'midground',
    facing_direction: 'front',
    action: '',
    expression: 'neutral',
    movement: '',
  };
  return editStoryboardShot(doc, shotId, {
    characters: [...sh.characters, staging],
  });
}

export function updateShotCharacterStaging(
  doc: StoryboardDocument,
  shotId: string,
  stagingId: string,
  patch: Partial<ShotCharacterStaging>,
  libraryCharacters?: Character[],
): StoryboardDocument {
  const sh = doc.shots.find((s) => s.shot_id === shotId);
  if (!sh) return doc;
  const nextChars = sh.characters.map((c) => {
    if (c.staging_id !== stagingId) return c;
    const merged: ShotCharacterStaging = { ...c, ...patch };
    if (patch.library_character_id !== undefined) {
      merged.is_missing_asset = !patch.library_character_id;
      if (patch.library_character_id && libraryCharacters) {
        const lib = libraryCharacters.find((lc) => lc.character_id === patch.library_character_id);
        if (lib && !patch.character_name) {
          merged.character_name = lib.name;
        }
      }
    }
    if (patch.screen_position === 'offscreen') {
      merged.visible = false;
    }
    return merged;
  });
  return editStoryboardShot(doc, shotId, { characters: nextChars });
}

export function removeShotCharacterStaging(
  doc: StoryboardDocument,
  shotId: string,
  stagingId: string,
): StoryboardDocument {
  const sh = doc.shots.find((s) => s.shot_id === shotId);
  if (!sh) return doc;
  return editStoryboardShot(doc, shotId, {
    characters: sh.characters.filter((c) => c.staging_id !== stagingId),
  });
}

export function restoreOriginalStoryboardShot(
  doc: StoryboardDocument,
  shotId: string,
): StoryboardDocument {
  const idx = doc.shots.findIndex((s) => s.shot_id === shotId);
  if (idx === -1) return doc;
  const cur = doc.shots[idx];
  const snap = cur.original_ai_snapshot;
  if (!snap) return doc;
  const restored: StoryboardShot = {
    ...(snap as unknown as StoryboardShot),
    shot_id: cur.shot_id,
    scene_id: cur.scene_id,
    locked: cur.locked,
    user_edited_fields: [],
    original_ai_snapshot: snap,
  };
  const nextShots = doc.shots.map((s, i) => (i === idx ? restored : s));
  return finalizeDoc(doc, nextShots);
}

export function markContinuityWarning(
  doc: StoryboardDocument,
  warningId: string,
  patch: { reviewed?: boolean; dismissed?: boolean },
): StoryboardDocument {
  return {
    ...doc,
    continuity_warnings: doc.continuity_warnings.map((w) =>
      w.warning_id === warningId ? { ...w, ...patch } : w,
    ),
    updated_at: new Date().toISOString(),
  };
}

/**
 * Reconcile a parent Stage Scene's `duration_ms` with the total duration of its storyboard shots
 * without mutating any script text or deleting any tracks/keyframes.
 */
export function reconcileStageSceneDurationToShots(
  draft: ProjectState,
  sceneId: string,
): { updated: boolean; newDurationMs: number } {
  const shots = (draft.storyboard?.shots ?? []).filter((s) => s.scene_id === sceneId);
  if (shots.length === 0) return { updated: false, newDurationMs: 0 };
  const totalMs = shots.reduce((acc, s) => acc + Math.max(500, s.duration_ms), 0);

  const stageScene = draft.scenes.find((s) => s.scene_id === sceneId);
  if (!stageScene) return { updated: false, newDurationMs: totalMs };

  stageScene.duration_ms = totalMs;
  let cursor = 0;
  draft.scenes.forEach((sc, idx) => {
    sc.order_index = idx;
    sc.start_ms = cursor;
    cursor += sc.duration_ms;
  });
  draft.timeline.total_duration_ms = Math.max(draft.timeline.total_duration_ms, cursor);
  draft.meta.duration_ms = draft.timeline.total_duration_ms;
  return { updated: true, newDurationMs: totalMs };
}
