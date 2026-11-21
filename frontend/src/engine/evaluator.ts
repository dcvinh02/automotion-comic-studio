import type {
  AnimationStateType,
  CameraState,
  Character,
  CharacterAnimationClip,
  Keyframe,
  ProjectState,
  Scene,
  SceneShot,
  Transform2D,
} from '@/types/models';
import { evaluateNumericKeyframes, evaluateStringKeyframes, markImmutableKeyframeList } from './interpolation';
import { findActiveShotInScene } from './sceneExecutionEngine';

export interface EvaluatedPart {
  slot_id: string;
  name: string;
  parent_slot_id: string | null;
  part_role: string;
  z_index: number;
  anchor_x: number;
  anchor_y: number;
  visible: boolean;
  asset_id: string | null;
  transform: Transform2D;
}

export interface EvaluatedCharacter {
  instance_id: string;
  character_id: string;
  display_name: string;
  z_index: number;
  visible: boolean;
  locked: boolean;
  transform: Transform2D;
  expression_id: string | null;
  pose_id: string | null;
  eye_state: string;
  mouth_state: string;
  animation_state: AnimationStateType;
  auto_blink_closed: boolean;
  parts: EvaluatedPart[];
}

export interface EvaluatedProp {
  prop_instance_id: string;
  asset_id: string | null;
  layer_kind: 'prop' | 'empty';
  name: string;
  z_index: number;
  anchor_x: number;
  anchor_y: number;
  visible: boolean;
  locked: boolean;
  parent_id: string | null;
  transform: Transform2D;
}

export interface EvaluatedStage {
  frameIndex: number;
  timeMs: number;
  scene: Scene | null;
  activeShot: SceneShot | null;
  effectiveBackgroundAssetId: string | null;
  effectiveBackgroundColor: string;
  fadeAlpha: number;
  camera: CameraState;
  props: EvaluatedProp[];
  characters: EvaluatedCharacter[];
}

function deterministicSeedOffset(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % 1700;
}

const EMPTY_KFS: Keyframe[] = [];
const EMPTY_ID_SET: ReadonlySet<string> = new Set<string>();
const kfIndexCache = new WeakMap<Keyframe[], Map<string, Keyframe[]>>();
const ownedIdsCache = new WeakMap<Scene[], Map<string, ReadonlySet<string>>>();

function indexKey(targetType: string, targetId: string, prop: string): string {
  return `${targetType}\u0000${targetId}\u0000${prop}`;
}

/** Keyframes grouped by (target_type, target_id, property), original order preserved. */
export function getKeyframeIndex(keyframes: Keyframe[]): Map<string, Keyframe[]> {
  let idx = kfIndexCache.get(keyframes);
  if (!idx) {
    idx = new Map();
    for (const k of keyframes) {
      const key = indexKey(k.target_type, k.target_id, k.property);
      const list = idx.get(key);
      if (list) list.push(k);
      else idx.set(key, [k]);
    }
    for (const list of idx.values()) markImmutableKeyframeList(list);
    kfIndexCache.set(keyframes, idx);
  }
  return idx;
}

/** Keyframe IDs owned by shots other than `activeShotId` (zero motion leakage between shots). */
function getOtherShotOwnedKeyframeIds(scenes: Scene[], activeShotId: string): ReadonlySet<string> {
  let perShot = ownedIdsCache.get(scenes);
  if (!perShot) {
    perShot = new Map();
    ownedIdsCache.set(scenes, perShot);
  }
  let ids = perShot.get(activeShotId);
  if (!ids) {
    const set = new Set<string>();
    for (const scOther of scenes) {
      for (const shOther of scOther.shots ?? []) {
        if (shOther.shot_id === activeShotId) continue;
        for (const id of shOther.animation_refs ?? []) set.add(id);
        for (const mot of shOther.applied_motions ?? []) {
          for (const id of mot.keyframe_ids ?? []) set.add(id);
        }
      }
    }
    ids = set;
    perShot.set(activeShotId, ids);
  }
  return ids;
}

export function findActiveScene(scenes: Scene[], timeMs: number): Scene | null {
  if (scenes.length === 0) return null;
  const sorted = [...scenes].sort((a, b) => a.start_ms - b.start_ms || a.order_index - b.order_index);
  for (const scene of sorted) {
    if (timeMs >= scene.start_ms && timeMs < scene.start_ms + scene.duration_ms) {
      return scene;
    }
  }
  return sorted[sorted.length - 1];
}

export function frameToMs(frameIndex: number, fps: number): number {
  return (frameIndex * 1000) / Math.max(1, fps);
}

export function msToFrame(ms: number, fps: number): number {
  return Math.max(0, Math.round((ms * Math.max(1, fps)) / 1000));
}

export function evaluateStageAtFrame(
  state: ProjectState,
  charactersById: Record<string, Character>,
  frameIndex: number,
  fpsOverride?: number,
): EvaluatedStage {
  const fps = fpsOverride ?? state.timeline.fps ?? 30;
  const timeMs = frameToMs(frameIndex, fps);
  const scene = findActiveScene(state.scenes, timeMs);

  if (!scene) {
    return {
      frameIndex,
      timeMs,
      scene: null,
      activeShot: null,
      effectiveBackgroundAssetId: null,
      effectiveBackgroundColor: '#101216',
      fadeAlpha: 1,
      camera: { x: 0, y: 0, zoom: 1, rotation_deg: 0 },
      props: [],
      characters: [],
    };
  }

  // Phase 07 Batch 1: Isolated Active Shot State Resolution (zero shot-to-shot leakage!)
  const activeShot = findActiveShotInScene(scene, timeMs);
  const ownedCharIds = new Set(scene.execution_meta?.owned_character_instance_ids ?? []);
  const ownedPropIds = new Set(scene.execution_meta?.owned_prop_instance_ids ?? []);
  const shotCharMap = new Map((activeShot?.character_states ?? []).map((c) => [c.instance_id, c]));
  const shotPropMap = new Map((activeShot?.prop_states ?? []).map((p) => [p.prop_instance_id, p]));

  const effectiveBackgroundAssetId =
    activeShot && activeShot.background_asset_id
      ? activeShot.background_asset_id
      : scene.background_asset_id;
  const effectiveBackgroundColor =
    activeShot && activeShot.background_color
      ? activeShot.background_color
      : scene.background_color;

  const allKfs = state.timeline.keyframes;
  // Phase 09.2: keyframe lookups used to scan every keyframe in the project for every property of
  // every object on every frame (O(objects × properties × keyframes)). Both the per-target index
  // and the "owned by other shots" set are cached per (immutable) array and reused across frames.
  const kfIndex = getKeyframeIndex(allKfs);
  const otherShotOwnedKfIds = activeShot ? getOtherShotOwnedKeyframeIds(state.scenes, activeShot.shot_id) : EMPTY_ID_SET;
  const kfsFor = (targetType: Keyframe['target_type'], targetId: string, prop: Keyframe['property']): Keyframe[] => {
    const list = kfIndex.get(indexKey(targetType, targetId, prop));
    if (!list) return EMPTY_KFS;
    if (otherShotOwnedKfIds.size === 0) return list;
    let excluded = false;
    for (const k of list) {
      if (otherShotOwnedKfIds.has(k.keyframe_id)) {
        excluded = true;
        break;
      }
    }
    return excluded ? list.filter((k) => !otherShotOwnedKfIds.has(k.keyframe_id)) : list;
  };

  // Camera (shot camera_default -> overridden cleanly by Timeline keyframes)
  const camBase = activeShot ? activeShot.camera_default : scene.camera_default;
  const camera: CameraState = {
    x: evaluateNumericKeyframes(kfsFor('camera', 'camera', 'x'), timeMs, camBase.x),
    y: evaluateNumericKeyframes(kfsFor('camera', 'camera', 'y'), timeMs, camBase.y),
    zoom: Math.max(
      0.1,
      evaluateNumericKeyframes(kfsFor('camera', 'camera', 'zoom'), timeMs, camBase.zoom),
    ),
    rotation_deg: evaluateNumericKeyframes(
      kfsFor('camera', 'camera', 'rotation_deg'),
      timeMs,
      camBase.rotation_deg,
    ),
  };

  // Fade-in transition
  let fadeAlpha = 1;
  if (
    (scene.transition_in === 'fade' || scene.transition_in === 'cross_dissolve') &&
    scene.transition_duration_ms > 0
  ) {
    const elapsed = timeMs - scene.start_ms;
    if (elapsed >= 0 && elapsed < scene.transition_duration_ms) {
      fadeAlpha = Math.max(0, Math.min(1, elapsed / scene.transition_duration_ms));
    }
  }

  // Props (supporting pivot/anchor, visibility, lock, parent-child inheritance & isolated shot state)
  const rawPropTransforms = new Map<string, Transform2D>();
  for (const prop of scene.props) {
    const ps = shotPropMap.get(prop.prop_instance_id);
    const baseTf = ps ? ps.transform : prop.transform;
    rawPropTransforms.set(prop.prop_instance_id, {
      x: evaluateNumericKeyframes(kfsFor('prop', prop.prop_instance_id, 'x'), timeMs, baseTf.x),
      y: evaluateNumericKeyframes(kfsFor('prop', prop.prop_instance_id, 'y'), timeMs, baseTf.y),
      rotation_deg: evaluateNumericKeyframes(
        kfsFor('prop', prop.prop_instance_id, 'rotation_deg'),
        timeMs,
        baseTf.rotation_deg,
      ),
      scale_x: evaluateNumericKeyframes(
        kfsFor('prop', prop.prop_instance_id, 'scale_x'),
        timeMs,
        baseTf.scale_x,
      ),
      scale_y: evaluateNumericKeyframes(
        kfsFor('prop', prop.prop_instance_id, 'scale_y'),
        timeMs,
        baseTf.scale_y,
      ),
      opacity: evaluateNumericKeyframes(
        kfsFor('prop', prop.prop_instance_id, 'opacity'),
        timeMs,
        baseTf.opacity,
      ),
    });
  }

  const propsById = new Map(scene.props.map((p) => [p.prop_instance_id, p]));
  const worldPropCache = new Map<string, Transform2D>();

  const resolvePropWorld = (propId: string, visited = new Set<string>()): Transform2D => {
    const cached = worldPropCache.get(propId);
    if (cached) return cached;
    const local = rawPropTransforms.get(propId) ?? {
      x: 0,
      y: 0,
      rotation_deg: 0,
      scale_x: 1,
      scale_y: 1,
      opacity: 1,
    };
    const prop = propsById.get(propId);
    if (!prop?.parent_id || !propsById.has(prop.parent_id) || visited.has(prop.parent_id)) {
      worldPropCache.set(propId, local);
      return local;
    }
    visited.add(propId);
    const parent = resolvePropWorld(prop.parent_id, visited);
    const rad = (parent.rotation_deg * Math.PI) / 180;
    const rx = local.x * parent.scale_x * Math.cos(rad) - local.y * parent.scale_y * Math.sin(rad);
    const ry = local.x * parent.scale_x * Math.sin(rad) + local.y * parent.scale_y * Math.cos(rad);
    const combined: Transform2D = {
      x: parent.x + rx,
      y: parent.y + ry,
      rotation_deg: parent.rotation_deg + local.rotation_deg,
      scale_x: parent.scale_x * local.scale_x,
      scale_y: parent.scale_y * local.scale_y,
      opacity: parent.opacity * local.opacity,
    };
    worldPropCache.set(propId, combined);
    return combined;
  };

  const props: EvaluatedProp[] = scene.props.map((prop) => {
    const ps = shotPropMap.get(prop.prop_instance_id);
    const shotVis = activeShot && ownedPropIds.has(prop.prop_instance_id) ? Boolean(ps?.visible) : true;
    return {
      prop_instance_id: prop.prop_instance_id,
      asset_id: ps?.asset_id ?? prop.asset_id ?? null,
      layer_kind: prop.layer_kind === 'empty' || !(ps?.asset_id ?? prop.asset_id) ? 'empty' : 'prop',
      name: ps?.name ?? prop.name,
      z_index: ps ? ps.z_index : prop.z_index,
      anchor_x: prop.anchor_x ?? 0.5,
      anchor_y: prop.anchor_y ?? 0.5,
      visible: prop.visible !== false && shotVis,
      locked: Boolean(prop.locked),
      parent_id: prop.parent_id ?? null,
      transform: resolvePropWorld(prop.prop_instance_id),
    };
  });

  // Characters (isolated per activeShot when owned by Scene Execution)
  const characters: EvaluatedCharacter[] = [];
  for (const inst of scene.characters) {
    const char = charactersById[inst.character_id];
    const iid = inst.instance_id;
    const cs = shotCharMap.get(iid);
    const baseTf = cs ? cs.transform : inst.initial_transform;
    const shotVis = activeShot && ownedCharIds.has(iid) ? Boolean(cs?.visible) : true;

    const baseX = evaluateNumericKeyframes(
      kfsFor('character_instance', iid, 'x'),
      timeMs,
      baseTf.x,
    );
    const baseY = evaluateNumericKeyframes(
      kfsFor('character_instance', iid, 'y'),
      timeMs,
      baseTf.y,
    );
    const rot = evaluateNumericKeyframes(
      kfsFor('character_instance', iid, 'rotation_deg'),
      timeMs,
      baseTf.rotation_deg,
    );
    const sx = evaluateNumericKeyframes(
      kfsFor('character_instance', iid, 'scale_x'),
      timeMs,
      baseTf.scale_x,
    );
    const sy = evaluateNumericKeyframes(
      kfsFor('character_instance', iid, 'scale_y'),
      timeMs,
      baseTf.scale_y,
    );
    const opacity = evaluateNumericKeyframes(
      kfsFor('character_instance', iid, 'opacity'),
      timeMs,
      baseTf.opacity,
    );

    const exprId = evaluateStringKeyframes(
      kfsFor('character_instance', iid, 'expression_id'),
      timeMs,
      // null in a shot state means 'unspecified' (backend schema default) → instance default
      cs?.expression_id ?? inst.default_expression_id,
    );
    const poseId = evaluateStringKeyframes(
      kfsFor('character_instance', iid, 'pose_id'),
      timeMs,
      // null in a shot state means 'unspecified' (backend schema default) → instance default
      cs?.pose_id ?? inst.default_pose_id,
    );
    const eyeState =
      evaluateStringKeyframes(
        kfsFor('character_instance', iid, 'eye_state'),
        timeMs,
        inst.default_eye_state,
      ) ?? 'open';
    const mouthState =
      evaluateStringKeyframes(
        kfsFor('character_instance', iid, 'mouth_state'),
        timeMs,
        inst.default_mouth_state,
      ) ?? 'closed';

    const activeClip: CharacterAnimationClip | undefined = state.timeline.animation_clips.find(
      (c) => c.instance_id === iid && timeMs >= c.start_ms && timeMs < c.end_ms,
    );

    const animState = (evaluateStringKeyframes(
      kfsFor('character_instance', iid, 'animation_state'),
      timeMs,
      activeClip?.animation_state ?? (cs?.animation_state as AnimationStateType | null) ?? 'IDLE',
    ) ?? 'IDLE') as AnimationStateType;

    // Deterministic procedural motion
    let breathSy = 1;
    let bounceY = 0;
    let headBobRot = 0;
    let limbSwingDeg = 0;
    let autoBlinkClosed = false;

    if (activeClip) {
      const p = activeClip.procedural;
      if (p.breathing) {
        const phase = (timeMs / Math.max(200, p.breathing_period_ms)) * Math.PI * 2;
        breathSy = 1 + Math.sin(phase) * p.breathing_amplitude;
        headBobRot = Math.sin(phase * 0.5) * 1.4;
      }
      if (animState === 'WALKING' || animState === 'RUNNING') {
        const speedMul = animState === 'RUNNING' ? 1.6 : 1.0;
        const phase = ((timeMs * speedMul) / Math.max(150, p.walk_cycle_ms)) * Math.PI * 2;
        bounceY = -Math.abs(Math.sin(phase)) * p.walk_bounce_px;
        limbSwingDeg = Math.sin(phase) * (animState === 'RUNNING' ? 24 : 14);
      } else if (animState === 'REACTING' || animState === 'SURPRISED') {
        const elapsed = timeMs - activeClip.start_ms;
        if (elapsed < 300) {
          bounceY = -Math.sin((elapsed / 300) * Math.PI) * 18;
        }
      }
      if (p.auto_blink) {
        const offset = deterministicSeedOffset(iid);
        const cyclePos = (timeMs + offset) % Math.max(500, p.blink_interval_ms);
        if (cyclePos < p.blink_duration_ms) {
          autoBlinkClosed = true;
        }
      }
    }

    const expr = char?.expressions.find((e) => e.expression_id === exprId);
    const pose = char?.poses.find((p) => p.pose_id === poseId);

    const parts: EvaluatedPart[] = (char?.parts ?? []).map((slot) => {
      const t: Transform2D = { ...slot.default_transform };

      const poseOv = pose?.slot_transforms?.[slot.slot_id];
      if (poseOv) {
        if (poseOv.x != null) t.x = poseOv.x;
        if (poseOv.y != null) t.y = poseOv.y;
        if (poseOv.rotation_deg != null) t.rotation_deg = poseOv.rotation_deg;
        if (poseOv.scale_x != null) t.scale_x = poseOv.scale_x;
        if (poseOv.scale_y != null) t.scale_y = poseOv.scale_y;
        if (poseOv.opacity != null) t.opacity = poseOv.opacity;
      }

      const exprOv = expr?.slot_transform_overrides?.[slot.slot_id];
      if (exprOv) {
        if (exprOv.x != null) t.x = exprOv.x;
        if (exprOv.y != null) t.y = exprOv.y;
        if (exprOv.rotation_deg != null) t.rotation_deg = exprOv.rotation_deg;
        if (exprOv.scale_x != null) t.scale_x = exprOv.scale_x;
        if (exprOv.scale_y != null) t.scale_y = exprOv.scale_y;
        if (exprOv.opacity != null) t.opacity = exprOv.opacity;
      }

      // Procedural subtle limb / head rotation
      if (slot.part_role === 'head') {
        t.rotation_deg += headBobRot;
      } else if (slot.part_role === 'left_arm' || slot.part_role === 'right_leg') {
        t.rotation_deg += limbSwingDeg;
      } else if (slot.part_role === 'right_arm' || slot.part_role === 'left_leg') {
        t.rotation_deg -= limbSwingDeg;
      }

      // Part-level keyframes
      const partKey = `${iid}:${slot.slot_id}`;
      t.x = evaluateNumericKeyframes(kfsFor('character_part', partKey, 'x'), timeMs, t.x);
      t.y = evaluateNumericKeyframes(kfsFor('character_part', partKey, 'y'), timeMs, t.y);
      t.rotation_deg = evaluateNumericKeyframes(
        kfsFor('character_part', partKey, 'rotation_deg'),
        timeMs,
        t.rotation_deg,
      );
      t.scale_x = evaluateNumericKeyframes(kfsFor('character_part', partKey, 'scale_x'), timeMs, t.scale_x);
      t.scale_y = evaluateNumericKeyframes(kfsFor('character_part', partKey, 'scale_y'), timeMs, t.scale_y);
      t.opacity = evaluateNumericKeyframes(kfsFor('character_part', partKey, 'opacity'), timeMs, t.opacity);

      let assetId = slot.default_asset_id;
      const exprVariant = expr?.slot_variant_overrides?.[slot.slot_id];
      if (exprVariant && slot.variants[exprVariant]) {
        assetId = slot.variants[exprVariant];
      }
      if (slot.part_role === 'eyes') {
        const desired = autoBlinkClosed ? 'closed' : eyeState;
        if (slot.variants[desired]) {
          assetId = slot.variants[desired];
        }
      } else if (slot.part_role === 'mouth') {
        if (slot.variants[mouthState]) {
          assetId = slot.variants[mouthState];
        }
      }

      return {
        slot_id: slot.slot_id,
        name: slot.name,
        parent_slot_id: slot.parent_slot_id,
        part_role: slot.part_role,
        z_index: slot.z_index,
        anchor_x: slot.anchor_x,
        anchor_y: slot.anchor_y,
        visible: slot.visible,
        asset_id: assetId,
        transform: t,
      };
    });

    characters.push({
      instance_id: iid,
      character_id: inst.character_id,
      display_name: cs?.display_name ?? inst.display_name,
      z_index: cs ? cs.z_index : inst.z_index,
      visible: inst.visible !== false && shotVis,
      locked: Boolean(inst.locked),
      transform: {
        x: baseX,
        y: baseY + bounceY,
        rotation_deg: rot,
        scale_x: sx,
        scale_y: sy * breathSy,
        opacity,
      },
      expression_id: exprId,
      pose_id: poseId,
      eye_state: eyeState,
      mouth_state: mouthState,
      animation_state: animState,
      auto_blink_closed: autoBlinkClosed,
      parts,
    });
  }

  return {
    frameIndex,
    timeMs,
    scene,
    activeShot,
    effectiveBackgroundAssetId,
    effectiveBackgroundColor,
    fadeAlpha,
    camera,
    props,
    characters,
  };
}
