/**
 * Phase 09.2 — Structural sharing for project edits.
 *
 * `mutateProject` edits a deep clone of the project. Previously every undo snapshot was an
 * additional full deep clone, so 80 history entries of a 2 MB project cost ~200 MB of heap, and
 * every edit allocated two complete copies. `shareUnchanged(prev, next)` walks the edited draft and
 * substitutes every sub-tree that is deep-equal to the previous state with the previous object, so
 * consecutive states (and undo snapshots, now kept by reference) share all unchanged data.
 *
 * Correctness contract: committed project states are treated as immutable (all store mutations
 * operate on a fresh `structuredClone` draft), so shared sub-objects are never mutated.
 */

const ID_KEYS = [
  'keyframe_id',
  'scene_id',
  'shot_id',
  'instance_id',
  'prop_instance_id',
  'track_id',
  'clip_id',
  'event_id',
  'subtitle_id',
  'slot_id',
  'style_id',
  'entry_id',
  'script_scene_id',
];

function idOf(v: unknown): string | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  for (const k of ID_KEYS) {
    const id = o[k];
    if (typeof id === 'string') return `${k}:${id}`;
  }
  return null;
}

export function shareUnchanged<T>(prev: T, next: T): T {
  if (prev === next) return next;
  if (prev === null || next === null || typeof prev !== 'object' || typeof next !== 'object') {
    return Object.is(prev, next) ? prev : next;
  }
  if (Array.isArray(prev) !== Array.isArray(next)) return next;

  if (Array.isArray(prev) && Array.isArray(next)) {
    let prevById: Map<string, unknown> | null = null;
    if (prev.length !== next.length) {
      // insert / delete: match elements by their stable ID so the rest stay shared
      prevById = new Map();
      for (const p of prev) {
        const id = idOf(p);
        if (id) prevById.set(id, p);
      }
    }
    let allSame = prev.length === next.length;
    for (let i = 0; i < next.length; i++) {
      let candidate: unknown = undefined;
      if (prevById) {
        const id = idOf(next[i]);
        candidate = id ? prevById.get(id) : undefined;
      } else {
        candidate = prev[i];
      }
      const shared = candidate === undefined ? next[i] : shareUnchanged(candidate, next[i]);
      if (shared !== next[i]) next[i] = shared;
      if (prevById || shared !== prev[i]) allSame = false;
    }
    return (allSame ? prev : next) as T;
  }

  const p = prev as Record<string, unknown>;
  const n = next as Record<string, unknown>;
  const pKeys = Object.keys(p);
  const nKeys = Object.keys(n);
  let allSame = pKeys.length === nKeys.length;
  for (const k of nKeys) {
    if (!(k in p)) {
      allSame = false;
      continue;
    }
    const shared = shareUnchanged(p[k], n[k]);
    if (shared !== n[k]) n[k] = shared;
    if (shared !== p[k]) allSame = false;
  }
  return (allSame ? prev : next) as T;
}
