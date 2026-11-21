/**
 * Phase 09.1 — Keep timeline content attached to its scene when scenes are re-packed or deleted.
 *
 * Scenes are laid out back-to-back on the Master Timeline, but keyframes, animation clips, audio
 * clips and subtitles store ABSOLUTE times. Previously, deleting a scene or changing a scene's
 * duration re-packed `start_ms` of later scenes while leaving their content at the old times,
 * so animation/dialogue/subtitles drifted onto the wrong scene, and the deleted scene's
 * instance keyframes/clips stayed behind as orphans.
 *
 * Ownership of each timeline item is resolved in this order:
 *   1. target instance / prop / part key belongs to a scene's characters/props;
 *   2. explicit scene reference (`subtitle.scene_id`, `sound_event.source_scene_id`);
 *   3. the scene whose OLD time range contains the item's start time (camera keyframes, unbound
 *      audio/subtitles).
 * Owned items move by their scene's start delta; items owned by a deleted scene are removed
 * (the whole operation goes through `mutateProject`, so it is undoable).
 */
import type { ProjectState } from '@/types/models';

interface Range {
  start: number;
  end: number;
}

export function repackScenesPreservingContent(
  draft: ProjectState,
  mutateScenes: (draft: ProjectState) => void,
): void {
  const oldRanges = new Map<string, Range>();
  const targetOwner = new Map<string, string>();
  for (const sc of draft.scenes) {
    oldRanges.set(sc.scene_id, { start: sc.start_ms, end: sc.start_ms + sc.duration_ms });
    for (const c of sc.characters) targetOwner.set(c.instance_id, sc.scene_id);
    for (const p of sc.props) targetOwner.set(p.prop_instance_id, sc.scene_id);
  }

  mutateScenes(draft);

  const delta = new Map<string, number>();
  for (const sc of draft.scenes) {
    const old = oldRanges.get(sc.scene_id);
    if (old) delta.set(sc.scene_id, sc.start_ms - old.start);
  }
  const ordered = [...oldRanges.entries()].sort((a, b) => a[1].start - b[1].start);
  const sceneAt = (t: number): string | null => {
    for (const [id, r] of ordered) if (t >= r.start && t < r.end) return id;
    return null;
  };
  const ownerOf = (targetId: string | null | undefined, explicitScene: string | null | undefined, t: number): string | null => {
    if (targetId) {
      const base = targetId.includes(':') ? targetId.split(':')[0] : targetId;
      const own = targetOwner.get(base);
      if (own) return own;
    }
    if (explicitScene && oldRanges.has(explicitScene)) return explicitScene;
    return sceneAt(t);
  };
  // undefined owner → leave untouched; deleted owner → remove; else shift by delta
  const plan = (owner: string | null): 'keep' | 'remove' | number => {
    if (!owner) return 'keep';
    if (!delta.has(owner)) return 'remove';
    return delta.get(owner) ?? 0;
  };

  const tl = draft.timeline;
  tl.keyframes = tl.keyframes.flatMap((k) => {
    const target = k.target_type === 'camera' ? null : k.target_id;
    const p = plan(ownerOf(target, null, k.time_ms));
    if (p === 'remove') return [];
    if (p === 'keep' || p === 0) return [k];
    return [{ ...k, time_ms: Math.max(0, Math.round(k.time_ms + p)) }];
  });
  tl.animation_clips = tl.animation_clips.flatMap((c) => {
    const p = plan(ownerOf(c.instance_id, null, c.start_ms));
    if (p === 'remove') return [];
    if (p === 'keep' || p === 0) return [c];
    return [{ ...c, start_ms: Math.max(0, c.start_ms + p), end_ms: Math.max(1, c.end_ms + p) }];
  });
  tl.sound_events = tl.sound_events.flatMap((e) => {
    const p = plan(ownerOf(null, e.source_scene_id ?? null, e.start_ms));
    if (p === 'remove') return [];
    if (p === 'keep' || p === 0) return [e];
    return [{ ...e, start_ms: Math.max(0, e.start_ms + p), end_ms: Math.max(1, e.end_ms + p) }];
  });
  if (draft.subtitles) {
    draft.subtitles.segments = draft.subtitles.segments.flatMap((s) => {
      const p = plan(ownerOf(null, s.scene_id ?? null, s.start_ms));
      if (p === 'remove') return [];
      if (p === 'keep' || p === 0) return [s];
      return [{ ...s, start_ms: Math.max(0, s.start_ms + p), end_ms: Math.max(1, s.end_ms + p) }];
    });
  }
}
