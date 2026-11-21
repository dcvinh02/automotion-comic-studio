import type { ProjectState, Scene, TimelineTrack } from '@/types/models';
import { deduplicateKeyframesByChannelFrame } from './keyframeEngine';

export type LayerKind = 'character' | 'prop' | 'empty';

export interface UnifiedSceneLayer {
  id: string;
  sceneId: string;
  kind: LayerKind;
  name: string;
  zIndex: number;
  visible: boolean;
  locked: boolean;
  parentId: string | null;
  assetId: string | null;
  characterId: string | null;
}

/**
 * Returns all visual layers in a scene ordered FRONT-TO-BACK (highest z_index first).
 *
 * Stacking convention across the entire studio:
 * - Canvas / Export: higher z_index draws IN FRONT of lower z_index.
 * - Layer Panel & Timeline Visual Layers: top row = frontmost (highest z_index),
 *   bottom row = backmost (lowest z_index).
 */
export function getOrderedSceneLayers(scene: Scene): UnifiedSceneLayer[] {
  const layers: UnifiedSceneLayer[] = [];

  for (const inst of scene.characters) {
    layers.push({
      id: inst.instance_id,
      sceneId: scene.scene_id,
      kind: 'character',
      name: inst.display_name,
      zIndex: inst.z_index,
      visible: inst.visible !== false,
      locked: Boolean(inst.locked),
      parentId: null,
      assetId: null,
      characterId: inst.character_id,
    });
  }

  for (const prop of scene.props) {
    const isEmpty = prop.layer_kind === 'empty' || !prop.asset_id;
    layers.push({
      id: prop.prop_instance_id,
      sceneId: scene.scene_id,
      kind: isEmpty ? 'empty' : 'prop',
      name: prop.name,
      zIndex: prop.z_index,
      visible: prop.visible !== false,
      locked: Boolean(prop.locked),
      parentId: prop.parent_id ?? null,
      assetId: prop.asset_id ?? null,
      characterId: null,
    });
  }

  // Descending z_index = frontmost layer at index 0
  layers.sort((a, b) => b.zIndex - a.zIndex || a.id.localeCompare(b.id));
  return layers;
}

/**
 * Computes the next top z_index so a newly added layer always starts cleanly in front.
 */
export function getNextTopZIndex(scene: Scene): number {
  let maxZ = 0;
  for (const c of scene.characters) {
    if (c.z_index > maxZ) maxZ = c.z_index;
  }
  for (const p of scene.props) {
    if (p.z_index > maxZ) maxZ = p.z_index;
  }
  return maxZ + 10;
}

/**
 * Assigns clean monotonic z_index values in-place on existing scene characters and props
 * from a front-to-back ordered list of layer IDs without recreating objects or losing data.
 */
export function applyFrontToBackZOrder(scene: Scene, orderedIds: string[]): void {
  const count = orderedIds.length;
  const zById = new Map<string, number>();
  orderedIds.forEach((id, idx) => {
    zById.set(id, (count - idx) * 10);
  });

  for (const inst of scene.characters) {
    const z = zById.get(inst.instance_id);
    if (z !== undefined) {
      inst.z_index = z;
    }
  }
  for (const prop of scene.props) {
    const z = zById.get(prop.prop_instance_id);
    if (z !== undefined) {
      prop.z_index = z;
    }
  }
}

/**
 * Computes the reordered front-to-back layer ID list for drag-and-drop.
 * Preserves parent-child references (never detaches children from their parent).
 */
export function computeDragReorderIds(
  layers: UnifiedSceneLayer[],
  sourceId: string,
  targetId: string,
  position: 'before' | 'after',
): string[] | null {
  if (sourceId === targetId) return null;
  const ids = layers.map((l) => l.id);
  const srcIdx = ids.indexOf(sourceId);
  const tgtIdx = ids.indexOf(targetId);
  if (srcIdx === -1 || tgtIdx === -1) return null;

  const sourceLayer = layers[srcIdx];
  const targetLayer = layers[tgtIdx];
  // If dragging a child prop that belongs to a parent, keep reordering constrained within siblings of same parent
  if (sourceLayer.parentId && targetLayer.parentId !== sourceLayer.parentId && targetLayer.id !== sourceLayer.parentId) {
    // Allow reordering only among siblings sharing the same parent so children are not silently moved outside their group
    return null;
  }

  const next = ids.filter((id) => id !== sourceId);
  const newTargetIdx = next.indexOf(targetId);
  if (newTargetIdx === -1) return null;
  const insertAt = position === 'before' ? newTargetIdx : newTargetIdx + 1;
  next.splice(insertAt, 0, sourceId);
  return next;
}

/**
 * Computes new front-to-back order for Move Up / Move Down / Bring to Front / Send to Back.
 * Remember index 0 = frontmost (highest z_index), index N-1 = backmost (lowest z_index).
 */
export function computeStepMoveIds(
  layers: UnifiedSceneLayer[],
  layerId: string,
  direction: 'up' | 'down' | 'front' | 'back',
): string[] | null {
  const ids = layers.map((l) => l.id);
  const idx = ids.indexOf(layerId);
  if (idx === -1) return null;

  const source = layers[idx];
  // If the layer belongs to a parent group, constrain step moves to its sibling subset
  if (source.parentId) {
    const siblingIndices = layers
      .map((l, i) => (l.parentId === source.parentId ? i : -1))
      .filter((i) => i !== -1);
    const posInSibs = siblingIndices.indexOf(idx);
    if (posInSibs === -1 || siblingIndices.length <= 1) return null;
    let targetPos = posInSibs;
    if (direction === 'up') targetPos = Math.max(0, posInSibs - 1);
    else if (direction === 'down') targetPos = Math.min(siblingIndices.length - 1, posInSibs + 1);
    else if (direction === 'front') targetPos = 0;
    else if (direction === 'back') targetPos = siblingIndices.length - 1;
    if (targetPos === posInSibs) return null;

    const sibIds = siblingIndices.map((i) => ids[i]);
    const [moved] = sibIds.splice(posInSibs, 1);
    sibIds.splice(targetPos, 0, moved);
    const next = [...ids];
    siblingIndices.forEach((origIdx, sIdx) => {
      next[origIdx] = sibIds[sIdx];
    });
    return next;
  }

  let targetIdx = idx;
  if (direction === 'up') targetIdx = Math.max(0, idx - 1);
  else if (direction === 'down') targetIdx = Math.min(ids.length - 1, idx + 1);
  else if (direction === 'front') targetIdx = 0;
  else if (direction === 'back') targetIdx = ids.length - 1;

  if (targetIdx === idx) return null;
  const next = [...ids];
  const [moved] = next.splice(idx, 1);
  next.splice(targetIdx, 0, moved);
  return next;
}

/**
 * Single-source-of-truth reconciler ensuring Scene layers (Characters, Props, Empty Layers)
 * and MasterTimeline tracks stay 100% synchronized by stable ID:
 * - Every scene character and prop/empty layer has a matching TimelineTrack (`target_ref_id`).
 * - Track names, visibility, locked state, and front-to-back order match the scene layers.
 * - Orphan character/prop tracks are pruned.
 * - Track `order_index` bands never collide with Camera, Voice, or SFX tracks.
 */
export function reconcileProjectLayersAndTimeline(draft: ProjectState): void {
  const existingTrackByTarget = new Map<string, TimelineTrack>();
  const nonVisualTracks: TimelineTrack[] = [];

  for (const trk of draft.timeline.tracks) {
    if ((trk.track_type === 'character' || trk.track_type === 'prop') && trk.target_ref_id) {
      if (!existingTrackByTarget.has(trk.target_ref_id)) {
        existingTrackByTarget.set(trk.target_ref_id, trk);
      }
    } else {
      nonVisualTracks.push(trk);
    }
  }

  // Build synchronized visual tracks in front-to-back order across scenes
  const visualTracks: TimelineTrack[] = [];
  const validVisualTargetIds = new Set<string>();
  const sortedScenes = [...draft.scenes].sort(
    (a, b) => a.order_index - b.order_index || a.start_ms - b.start_ms,
  );

  let visualOrder = 10;
  for (const scene of sortedScenes) {
    const orderedLayers = getOrderedSceneLayers(scene);
    for (const layer of orderedLayers) {
      validVisualTargetIds.add(layer.id);
      const trackType = layer.kind === 'character' ? 'character' : 'prop';
      const existing = existingTrackByTarget.get(layer.id);
      if (existing) {
        existing.track_type = trackType;
        existing.name = layer.name;
        existing.visible = layer.visible;
        existing.locked = layer.locked;
        existing.order_index = visualOrder++;
        visualTracks.push(existing);
      } else {
        const created: TimelineTrack = {
          track_id: `trk_${trackType}_${layer.id.slice(-8)}`,
          project_id: draft.meta.project_id,
          track_type: trackType,
          name: layer.name,
          target_ref_id: layer.id,
          order_index: visualOrder++,
          muted: false,
          locked: layer.locked,
          solo: false,
          visible: layer.visible,
          volume: 1,
          collapsed: false,
        };
        visualTracks.push(created);
      }
    }
  }

  // Assign deterministic non-colliding order bands for structural & audio tracks
  let voiceOrder = 500;
  let sfxOrder = 1000;
  let otherOrder = 1500;
  for (const trk of nonVisualTracks) {
    if (trk.track_type === 'scene') trk.order_index = 0;
    else if (trk.track_type === 'camera') trk.order_index = 1;
    else if (trk.track_type === 'voice') trk.order_index = voiceOrder++;
    else if (trk.track_type === 'sfx') trk.order_index = sfxOrder++;
    else trk.order_index = otherOrder++;
  }

  draft.timeline.tracks = [...nonVisualTracks, ...visualTracks].sort(
    (a, b) => a.order_index - b.order_index,
  );

  // Keep keyframe & animation clip track_id references pointing to the live track_id
  const liveTrackIdByTarget = new Map<string, string>();
  for (const trk of visualTracks) {
    if (trk.target_ref_id) liveTrackIdByTarget.set(trk.target_ref_id, trk.track_id);
  }
  for (const kf of draft.timeline.keyframes) {
    if (kf.target_type === 'character_instance' || kf.target_type === 'prop') {
      const tid = liveTrackIdByTarget.get(kf.target_id);
      if (tid) kf.track_id = tid;
    } else if (kf.target_type === 'character_part') {
      const charId = kf.target_id.split(':')[0];
      const tid = liveTrackIdByTarget.get(charId);
      if (tid) kf.track_id = tid;
    }
  }
  for (const clip of draft.timeline.animation_clips) {
    const tid = liveTrackIdByTarget.get(clip.instance_id);
    if (tid) clip.track_id = tid;
  }

  // Enforce collision-free channel+frame invariant across the entire timeline
  draft.timeline.keyframes = deduplicateKeyframesByChannelFrame(
    draft.timeline.keyframes,
    draft.timeline.fps || 30,
  );
}
