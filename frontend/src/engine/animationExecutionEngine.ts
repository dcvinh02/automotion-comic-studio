import type {
  Character,
  CharacterAnimationClip,
  CharacterRigCapabilities,
  Keyframe,
  MotionCompatibilityResult,
  MotionPreset,
  MotionSupportLevel,
  ProjectState,
  RigCapability,
  RigType,
} from '@/types/models';

/**
 * Pure client-side mirror of backend `inspect_character_capabilities`
 * so Rig Capabilities & Motion Library compatibility badges update instantaneously with zero flicker.
 */
export function inspectCharacterCapabilitiesLocal(
  character: Character | null | undefined,
): CharacterRigCapabilities {
  if (!character) {
    return {
      character_id: '',
      character_name: '(Unlinked)',
      rig_type: 'empty',
      part_count: 0,
      capabilities: [],
      available_part_roles: [],
      part_slots_by_role: {},
      eye_variants: [],
      mouth_variants: [],
      pose_ids: [],
      pose_names: {},
      expression_ids: [],
      limitations: ['Character is not linked to a Character Library rig.'],
    };
  }

  const parts = character.parts ?? [];
  if (parts.length === 0) {
    return {
      character_id: character.character_id,
      character_name: character.name,
      rig_type: 'empty',
      part_count: 0,
      capabilities: [],
      available_part_roles: [],
      part_slots_by_role: {},
      eye_variants: [],
      mouth_variants: [],
      pose_ids: (character.poses ?? []).map((p) => p.pose_id),
      pose_names: Object.fromEntries((character.poses ?? []).map((p) => [p.pose_id, p.name])),
      expression_ids: (character.expressions ?? []).map((e) => e.expression_id),
      limitations: [`Character '${character.name}' has 0 assembled PNG rig parts.`],
    };
  }

  const roleSet = new Set<string>(parts.map((p) => p.part_role));
  const slotsByRole: Record<string, string> = {};
  for (const p of parts) {
    if (!slotsByRole[p.part_role] && p.visible) slotsByRole[p.part_role] = p.slot_id;
  }
  for (const p of parts) {
    if (!slotsByRole[p.part_role]) slotsByRole[p.part_role] = p.slot_id;
  }

  const caps: RigCapability[] = ['root_movement', 'scale_animation', 'opacity_animation', 'body_rotation'];
  const limitations: string[] = [];

  const hasHead = roleSet.has('head');
  if (hasHead) caps.push('head_rotation');
  else limitations.push('No `head` part slot.');

  const hasArms = roleSet.has('left_arm') || roleSet.has('right_arm');
  if (hasArms) caps.push('arm_rotation');
  else limitations.push('No `left_arm`/`right_arm` slots.');

  const hasLegs = roleSet.has('left_leg') || roleSet.has('right_leg');
  if (hasLegs) caps.push('leg_rotation');
  else limitations.push('No `left_leg`/`right_leg` slots.');

  if (roleSet.has('left_hand') || roleSet.has('right_hand')) {
    caps.push('hand_rotation');
  }

  const eyesSlot = parts.find((p) => p.part_role === 'eyes');
  const eyeVariants = eyesSlot ? Object.keys(eyesSlot.variants ?? {}).sort() : [];
  if (eyesSlot && ('closed' in (eyesSlot.variants ?? {}) || eyeVariants.length >= 2)) {
    caps.push('eye_state');
  } else {
    limitations.push('No `eyes` slot with `closed` variant.');
  }

  const mouthSlot = parts.find((p) => p.part_role === 'mouth');
  const mouthVariants = mouthSlot ? Object.keys(mouthSlot.variants ?? {}).sort() : [];
  if (mouthSlot && ('open' in (mouthSlot.variants ?? {}) || mouthVariants.length >= 2)) {
    caps.push('mouth_state');
  } else {
    limitations.push('No `mouth` slot with `open`/`closed` variants.');
  }

  const rigType: RigType =
    hasLegs && hasArms && hasHead ? 'full_cutout' : hasArms || hasHead ? 'upper_body' : 'simple_cutout';

  return {
    character_id: character.character_id,
    character_name: character.name,
    rig_type: rigType,
    part_count: parts.length,
    capabilities: caps,
    available_part_roles: [...roleSet].sort(),
    part_slots_by_role: slotsByRole,
    eye_variants: eyeVariants,
    mouth_variants: mouthVariants,
    pose_ids: (character.poses ?? []).map((p) => p.pose_id),
    pose_names: Object.fromEntries((character.poses ?? []).map((p) => [p.pose_id, p.name])),
    expression_ids: (character.expressions ?? []).map((e) => e.expression_id),
    limitations,
  };
}

export function checkPresetCompatibilityLocal(
  preset: MotionPreset,
  caps: CharacterRigCapabilities,
): MotionCompatibilityResult {
  const capSet = new Set(caps.capabilities);
  const missingReq = preset.required_capabilities.filter((c) => !capSet.has(c));
  const availOpt = preset.optional_capabilities.filter((c) => capSet.has(c));

  if (caps.rig_type === 'empty' || missingReq.length > 0) {
    return {
      preset_id: preset.preset_id,
      preset_name: preset.name,
      character_id: caps.character_id,
      character_name: caps.character_name,
      compatible: false,
      support_level: 'unsupported',
      missing_capabilities: missingReq.length > 0 ? missingReq : ['root_movement'],
      available_optional_capabilities: availOpt,
      warnings: [
        missingReq.length > 0
          ? `Missing capabilities: ${missingReq.join(', ')}`
          : `Character '${caps.character_name}' has no rig parts.`,
      ],
      limitations: preset.limitations,
    };
  }

  let support: MotionSupportLevel = 'full';
  const warnings: string[] = [];
  if (preset.category === 'walk' && !capSet.has('leg_rotation')) {
    support = 'partial';
    warnings.push('No legs: Walk animates root bounce & translation only.');
  } else if ((preset.category === 'walk' || preset.category === 'run') && !capSet.has('arm_rotation')) {
    support = 'partial';
    warnings.push('No arms: omits arm swing.');
  }

  return {
    preset_id: preset.preset_id,
    preset_name: preset.name,
    character_id: caps.character_id,
    character_name: caps.character_name,
    compatible: true,
    support_level: support,
    missing_capabilities: [],
    available_optional_capabilities: availOpt,
    warnings,
    limitations: preset.limitations,
  };
}

export interface MotionPreviewOverlay {
  projectId: string;
  sceneId: string;
  shotId: string | null;
  targetKind: 'character' | 'camera';
  instanceId: string | null;
  presetId: string | null;
  startMs: number;
  endMs: number;
  loop: boolean;
  keyframes: Keyframe[];
  animationClips: CharacterAnimationClip[];
}

/**
 * Pure non-destructive overlay combiner used ONLY in-memory by PreviewCanvas during Motion Preview.
 * Never mutates the permanent ProjectState or project.db!
 */
export function mergeMotionPreviewOverlay(
  project: ProjectState,
  overlay: MotionPreviewOverlay | null,
): ProjectState {
  if (!overlay || overlay.projectId !== project.meta.project_id) {
    return project;
  }
  if (overlay.keyframes.length === 0 && overlay.animationClips.length === 0) {
    return project;
  }

  // Replace only overlapping keyframes for the exact target properties within the preview window
  const previewTargets = new Set(
    overlay.keyframes.map((k) => `${k.target_type}|${k.target_id}|${k.property}`),
  );
  const keptKfs = project.timeline.keyframes.filter((k) => {
    const sig = `${k.target_type}|${k.target_id}|${k.property}`;
    if (!previewTargets.has(sig)) return true;
    return k.time_ms < overlay.startMs || k.time_ms > overlay.endMs;
  });

  const previewInsts = new Set(overlay.animationClips.map((c) => c.instance_id));
  const keptClips = project.timeline.animation_clips.filter(
    (c) => !(previewInsts.has(c.instance_id) && c.end_ms > overlay.startMs && c.start_ms < overlay.endMs),
  );

  return {
    ...project,
    timeline: {
      ...project.timeline,
      keyframes: [...keptKfs, ...overlay.keyframes],
      animation_clips: [...keptClips, ...overlay.animationClips],
    },
  };
}
