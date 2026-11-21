/**
 * Phase 07 Batch 1 — Pure TypeScript Shot State Isolation & Canvas Sync Engine.
 *
 * Guarantees:
 * - Resolves the active executed `SceneShot` strictly by stable `shot_id` & timeline timestamp
 *   (never relying on array indices as identity).
 * - Prevents state from Shot A (background, camera, character transform/visibility/pose/expression,
 *   prop transform/visibility/z_index) from leaking into Shot B.
 * - Preserves unrelated user-created Scene objects (not in `execution_meta.owned_*_ids`) across all shots.
 * - Synchronizes interactive Canvas drag/rotate/scale/visibility edits cleanly into ONLY the active shot!
 */

import type {
  Scene,
  SceneCharacterInstance,
  ScenePropInstance,
  SceneShot,
  ShotCharacterState,
  ShotPropState,
} from '@/types/models';

export function findActiveShotInScene(scene: Scene | null, timeMs: number): SceneShot | null {
  if (!scene || !scene.shots || scene.shots.length === 0) return null;
  const localMs = timeMs - scene.start_ms;
  const ordered = [...scene.shots].sort(
    (a, b) => a.start_ms - b.start_ms || a.shot_order - b.shot_order || a.shot_id.localeCompare(b.shot_id),
  );
  for (const sh of ordered) {
    if (localMs >= sh.start_ms && localMs < sh.start_ms + sh.duration_ms) {
      return sh;
    }
  }
  if (localMs < ordered[0].start_ms) return ordered[0];
  return ordered[ordered.length - 1];
}

export function findShotById(scene: Scene | null, shotId: string | null): SceneShot | null {
  if (!scene || !scene.shots || !shotId) return null;
  return scene.shots.find((s) => s.shot_id === shotId) ?? null;
}

export function getShotAbsoluteRange(scene: Scene, shot: SceneShot): { startMs: number; endMs: number } {
  const startMs = scene.start_ms + shot.start_ms;
  return { startMs, endMs: startMs + Math.max(1, shot.duration_ms) };
}

export function recalculateSceneShotTimings(scene: Scene): void {
  if (!scene.shots || scene.shots.length === 0) return;
  scene.shots.sort((a, b) => a.shot_order - b.shot_order || a.start_ms - b.start_ms);
  let cursor = 0;
  for (const sh of scene.shots) {
    sh.start_ms = cursor;
    cursor += Math.max(100, sh.duration_ms);
  }
  if (cursor > scene.duration_ms) {
    scene.duration_ms = cursor;
  }
}

export function editSceneShotState(
  scene: Scene,
  shotId: string,
  patch: Partial<
    Pick<
      SceneShot,
      | 'title'
      | 'duration_ms'
      | 'background_asset_id'
      | 'background_color'
      | 'camera_default'
      | 'character_states'
      | 'prop_states'
    >
  >,
): boolean {
  if (!scene.shots) return false;
  const target = scene.shots.find((s) => s.shot_id === shotId);
  if (!target) return false;

  if (patch.title !== undefined) target.title = patch.title;
  if (patch.duration_ms !== undefined) target.duration_ms = Math.max(200, Math.round(patch.duration_ms));
  if (patch.background_asset_id !== undefined) target.background_asset_id = patch.background_asset_id;
  if (patch.background_color !== undefined) target.background_color = patch.background_color;
  if (patch.camera_default !== undefined) target.camera_default = { ...patch.camera_default };
  if (patch.character_states !== undefined) target.character_states = patch.character_states;
  if (patch.prop_states !== undefined) target.prop_states = patch.prop_states;

  target.execution_status = 'edited';
  target.updated_at = new Date().toISOString();
  recalculateSceneShotTimings(scene);
  return true;
}

/**
 * When a user edits a character instance on Canvas/Inspector while a specific executed shot is active,
 * isolate that edit to ONLY the active shot's `ShotCharacterState` (never bleeding into sibling shots!).
 */
export function syncCharacterEditIntoActiveShot(
  scene: Scene,
  activeShotId: string | null,
  instanceId: string,
  patch: Partial<SceneCharacterInstance>,
): boolean {
  if (!scene.shots || scene.shots.length === 0 || !activeShotId) return false;
  const shot = scene.shots.find((s) => s.shot_id === activeShotId);
  if (!shot) return false;

  const existingState = shot.character_states.find((c) => c.instance_id === instanceId);
  if (!existingState) {
    // Only create/update shot state if this character is owned by scene execution or already in this shot
    const owned = new Set(scene.execution_meta?.owned_character_instance_ids ?? []);
    if (!owned.has(instanceId)) return false;
    const baseInst = scene.characters.find((c) => c.instance_id === instanceId);
    if (!baseInst) return false;
    const created: ShotCharacterState = {
      instance_id: baseInst.instance_id,
      character_id: baseInst.character_id,
      display_name: patch.display_name ?? baseInst.display_name,
      visible: patch.visible ?? baseInst.visible ?? true,
      z_index: patch.z_index ?? baseInst.z_index,
      transform: patch.initial_transform
        ? { ...patch.initial_transform }
        : { ...baseInst.initial_transform },
      facing_direction: 'front',
      screen_position: 'center',
      depth_layer: 'midground',
      pose_id: patch.default_pose_id !== undefined ? patch.default_pose_id : baseInst.default_pose_id,
      expression_id:
        patch.default_expression_id !== undefined
          ? patch.default_expression_id
          : baseInst.default_expression_id,
      animation_state: null,
      staging_fallback_used: false,
      staging_fallback_reason: '',
    };
    shot.character_states.push(created);
    shot.execution_status = 'edited';
    shot.updated_at = new Date().toISOString();
    return true;
  }

  if (patch.initial_transform) {
    existingState.transform = { ...existingState.transform, ...patch.initial_transform };
  }
  if (patch.visible !== undefined) existingState.visible = patch.visible;
  if (patch.z_index !== undefined) existingState.z_index = patch.z_index;
  if (patch.display_name !== undefined) existingState.display_name = patch.display_name;
  if (patch.default_pose_id !== undefined) existingState.pose_id = patch.default_pose_id;
  if (patch.default_expression_id !== undefined) existingState.expression_id = patch.default_expression_id;
  shot.execution_status = 'edited';
  shot.updated_at = new Date().toISOString();
  return true;
}

/**
 * When a user edits a prop/environment/foreground object on Canvas/Inspector while an executed shot is active,
 * isolate that edit cleanly inside ONLY that shot's `ShotPropState`!
 */
export function syncPropEditIntoActiveShot(
  scene: Scene,
  activeShotId: string | null,
  propInstanceId: string,
  patch: Partial<ScenePropInstance>,
): boolean {
  if (!scene.shots || scene.shots.length === 0 || !activeShotId) return false;
  const shot = scene.shots.find((s) => s.shot_id === activeShotId);
  if (!shot) return false;

  const existingState = shot.prop_states.find((p) => p.prop_instance_id === propInstanceId);
  if (!existingState) {
    const owned = new Set(scene.execution_meta?.owned_prop_instance_ids ?? []);
    if (!owned.has(propInstanceId)) return false;
    const baseProp = scene.props.find((p) => p.prop_instance_id === propInstanceId);
    if (!baseProp) return false;
    const created: ShotPropState = {
      prop_instance_id: baseProp.prop_instance_id,
      asset_id: patch.asset_id !== undefined ? patch.asset_id : baseProp.asset_id,
      name: patch.name ?? baseProp.name,
      role: 'prop',
      visible: patch.visible ?? baseProp.visible ?? true,
      z_index: patch.z_index ?? baseProp.z_index,
      transform: patch.transform ? { ...patch.transform } : { ...baseProp.transform },
    };
    shot.prop_states.push(created);
    shot.execution_status = 'edited';
    shot.updated_at = new Date().toISOString();
    return true;
  }

  if (patch.transform) {
    existingState.transform = { ...existingState.transform, ...patch.transform };
  }
  if (patch.visible !== undefined) existingState.visible = patch.visible;
  if (patch.z_index !== undefined) existingState.z_index = patch.z_index;
  if (patch.name !== undefined) existingState.name = patch.name;
  if (patch.asset_id !== undefined) existingState.asset_id = patch.asset_id;
  shot.execution_status = 'edited';
  shot.updated_at = new Date().toISOString();
  return true;
}
