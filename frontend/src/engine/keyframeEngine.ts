/**
 * Pure, deterministic Keyframe & Timeline Engine (Phase 05 — Batch 1).
 *
 * Guarantees:
 * 1. Dragging/moving keyframes ALWAYS preserves original stable `keyframe_id`s (MOVE, never CREATE).
 * 2. Exact frame-bijective timing across 24 / 25 / 30 / 60 FPS (no 1-frame floor drift).
 * 3. Deterministic collision resolution: at most ONE keyframe per (target_type, target_id, property, frame).
 * 4. Multi-keyframe group moves preserve exact relative frame offsets via rigid boundary clamping.
 * 5. Summary track frame clusters group all properties at a frame so collapsed-track drags never
 *    leave sibling property keyframes behind as ghost markers.
 */
import type { EasingType, Keyframe } from '@/types/models';
import { msToFrame } from './evaluator';

export function getKeyframeChannelKey(
  kf: Pick<Keyframe, 'target_type' | 'target_id' | 'property'>,
): string {
  return `${kf.target_type}::${kf.target_id}::${kf.property}`;
}

export function frameIndexToQuantizedMs(frameIndex: number, fps: number): number {
  const safeFps = Math.max(1, fps);
  const clampedFrame = Math.max(0, Math.round(frameIndex));
  return Math.round((clampedFrame * 1000) / safeFps);
}

export function getKeyframeFrame(kf: Pick<Keyframe, 'time_ms'>, fps: number): number {
  return msToFrame(kf.time_ms, fps);
}

export function getMaxTimelineFrame(totalDurationMs: number, fps: number): number {
  return Math.max(0, msToFrame(Math.max(0, totalDurationMs), fps));
}

export interface SummaryKeyframeCluster {
  clusterKey: string;
  frameIndex: number;
  timeMs: number;
  keyframeIds: string[];
  keyframes: Keyframe[];
}

/**
 * Groups a track's keyframes by quantized frame index for the collapsed summary track row.
 * Prevents stacking multiple single-property diamonds on identical coordinates.
 */
export function groupTrackKeyframesByFrame(
  keyframes: Keyframe[],
  fps: number,
): SummaryKeyframeCluster[] {
  const byFrame = new Map<number, Keyframe[]>();
  for (const kf of keyframes) {
    const frame = getKeyframeFrame(kf, fps);
    const list = byFrame.get(frame);
    if (list) list.push(kf);
    else byFrame.set(frame, [kf]);
  }
  const clusters: SummaryKeyframeCluster[] = [];
  const sortedFrames = [...byFrame.keys()].sort((a, b) => a - b);
  for (const frameIndex of sortedFrames) {
    const list = byFrame.get(frameIndex)!;
    const timeMs = frameIndexToQuantizedMs(frameIndex, fps);
    clusters.push({
      clusterKey: `cluster_f${frameIndex}`,
      frameIndex,
      timeMs,
      keyframeIds: list.map((k) => k.keyframe_id),
      keyframes: list,
    });
  }
  return clusters;
}

/**
 * Deterministically deduplicates keyframes sharing the exact same channel and quantized frame
 * (last entry wins, matching evaluator semantics). Never mutates valid unique keyframes.
 */
export function deduplicateKeyframesByChannelFrame(
  keyframes: Keyframe[],
  fps: number,
): Keyframe[] {
  if (keyframes.length <= 1) return keyframes;
  const seen = new Map<string, number>();
  const result: Keyframe[] = [];
  for (const kf of keyframes) {
    const slotKey = `${getKeyframeChannelKey(kf)}@f${getKeyframeFrame(kf, fps)}`;
    const prevIdx = seen.get(slotKey);
    if (prevIdx !== undefined) {
      result[prevIdx] = kf;
    } else {
      seen.set(slotKey, result.length);
      result.push(kf);
    }
  }
  return result;
}

/**
 * Clamps a requested group delta (in frames) rigidly so:
 * - No moved keyframe goes below frame 0.
 * - No moved keyframe exceeds maxFrame (derived from totalDurationMs).
 * - Exact relative frame spacing between ALL moved keyframes is strictly preserved.
 */
export function computeClampedGroupDeltaFrames(
  allKeyframes: Keyframe[],
  movingIds: ReadonlySet<string>,
  requestedDeltaFrames: number,
  fps: number,
  totalDurationMs: number,
): number {
  const delta = Math.round(requestedDeltaFrames);
  if (delta === 0 || movingIds.size === 0) return 0;

  let minFrame = Infinity;
  let maxFrame = -Infinity;
  for (const kf of allKeyframes) {
    if (!movingIds.has(kf.keyframe_id)) continue;
    const f = getKeyframeFrame(kf, fps);
    if (f < minFrame) minFrame = f;
    if (f > maxFrame) maxFrame = f;
  }
  if (!Number.isFinite(minFrame) || !Number.isFinite(maxFrame)) return 0;

  const upperBoundFrame = getMaxTimelineFrame(totalDurationMs, fps);
  const minAllowedDelta = -minFrame;
  const maxAllowedDelta = Math.max(0, upperBoundFrame - maxFrame);
  return Math.max(minAllowedDelta, Math.min(maxAllowedDelta, delta));
}

export interface MoveKeyframesResult {
  keyframes: Keyframe[];
  movedCount: number;
  replacedIds: string[];
  clampedDeltaFrames: number;
}

/**
 * Atomically MOVES one or more keyframes by `requestedDeltaFrames`.
 * - Preserves every moved keyframe's original `keyframe_id`, `value`, `easing`, and handles.
 * - Preserves exact relative timing across multi-keyframe selections.
 * - Resolves collisions deterministically: if a moved keyframe lands on the same
 *   (target_type, target_id, property, frame) as a stationary keyframe, the moved keyframe
 *   replaces the stationary keyframe (zero duplicate channel+frame markers).
 */
export function applyMoveKeyframes(
  allKeyframes: Keyframe[],
  movingIdList: string[],
  requestedDeltaFrames: number,
  fps: number,
  totalDurationMs: number,
): MoveKeyframesResult {
  const movingIds = new Set(movingIdList);
  const clampedDeltaFrames = computeClampedGroupDeltaFrames(
    allKeyframes,
    movingIds,
    requestedDeltaFrames,
    fps,
    totalDurationMs,
  );

  if (clampedDeltaFrames === 0 || movingIds.size === 0) {
    return {
      keyframes: allKeyframes,
      movedCount: 0,
      replacedIds: [],
      clampedDeltaFrames: 0,
    };
  }

  // First compute destination slots occupied by the moved keyframes
  const occupiedByMoved = new Set<string>();
  const movedById = new Map<string, Keyframe>();
  for (const kf of allKeyframes) {
    if (!movingIds.has(kf.keyframe_id)) continue;
    const nextFrame = Math.max(0, getKeyframeFrame(kf, fps) + clampedDeltaFrames);
    const nextTimeMs = Math.min(totalDurationMs, frameIndexToQuantizedMs(nextFrame, fps));
    const movedKf: Keyframe = {
      ...kf,
      time_ms: nextTimeMs,
    };
    movedById.set(kf.keyframe_id, movedKf);
    occupiedByMoved.add(`${getKeyframeChannelKey(movedKf)}@f${getKeyframeFrame(movedKf, fps)}`);
  }

  const replacedIds: string[] = [];
  const nextList: Keyframe[] = [];
  for (const kf of allKeyframes) {
    const moved = movedById.get(kf.keyframe_id);
    if (moved) {
      nextList.push(moved);
    } else {
      const slotKey = `${getKeyframeChannelKey(kf)}@f${getKeyframeFrame(kf, fps)}`;
      if (occupiedByMoved.has(slotKey)) {
        replacedIds.push(kf.keyframe_id);
      } else {
        nextList.push(kf);
      }
    }
  }

  return {
    keyframes: deduplicateKeyframesByChannelFrame(nextList, fps),
    movedCount: movedById.size,
    replacedIds,
    clampedDeltaFrames,
  };
}

/**
 * Moves a selection of keyframes so the earliest selected keyframe lands on `targetStartFrame`,
 * preserving exact relative frame spacing of the group.
 */
export function applyMoveKeyframesToFrame(
  allKeyframes: Keyframe[],
  movingIdList: string[],
  targetStartFrame: number,
  fps: number,
  totalDurationMs: number,
): MoveKeyframesResult {
  const movingIds = new Set(movingIdList);
  let minFrame = Infinity;
  for (const kf of allKeyframes) {
    if (movingIds.has(kf.keyframe_id)) {
      minFrame = Math.min(minFrame, getKeyframeFrame(kf, fps));
    }
  }
  if (!Number.isFinite(minFrame)) {
    return { keyframes: allKeyframes, movedCount: 0, replacedIds: [], clampedDeltaFrames: 0 };
  }
  const deltaFrames = Math.round(targetStartFrame) - minFrame;
  return applyMoveKeyframes(allKeyframes, movingIdList, deltaFrames, fps, totalDurationMs);
}

export interface DuplicateKeyframesResult {
  keyframes: Keyframe[];
  createdIds: string[];
  replacedIds: string[];
}

/**
 * Atomically duplicates selected keyframes with fresh IDs shifted by `offsetFrames`
 * (defaults to +10 frames or right after the selection span if needed), replacing any
 * colliding destination keyframe on the exact same channel/frame cleanly.
 */
export function applyDuplicateKeyframes(
  allKeyframes: Keyframe[],
  sourceIdList: string[],
  offsetFrames: number,
  fps: number,
  totalDurationMs: number,
  createId: () => string,
): DuplicateKeyframesResult {
  const sourceIds = new Set(sourceIdList);
  const sources = allKeyframes.filter((k) => sourceIds.has(k.keyframe_id));
  if (sources.length === 0) {
    return { keyframes: allKeyframes, createdIds: [], replacedIds: [] };
  }

  const upperFrame = getMaxTimelineFrame(totalDurationMs, fps);
  const maxSrcFrame = Math.max(...sources.map((k) => getKeyframeFrame(k, fps)));
  const minSrcFrame = Math.min(...sources.map((k) => getKeyframeFrame(k, fps)));

  let safeOffset = Math.round(offsetFrames);
  if (safeOffset === 0) safeOffset = 10;
  // Clamp offset so duplicated group fits inside timeline bounds; if at very end, shift backward
  if (maxSrcFrame + safeOffset > upperFrame) {
    const remaining = upperFrame - maxSrcFrame;
    if (remaining > 0) {
      safeOffset = remaining;
    } else if (minSrcFrame >= 10) {
      safeOffset = -10;
    } else {
      safeOffset = Math.max(-minSrcFrame, -1);
    }
  }
  if (safeOffset === 0) {
    return { keyframes: allKeyframes, createdIds: [], replacedIds: [] };
  }

  const created: Keyframe[] = [];
  const occupiedSlots = new Set<string>();
  for (const src of sources) {
    const dstFrame = Math.max(0, Math.min(upperFrame, getKeyframeFrame(src, fps) + safeOffset));
    const dstTimeMs = Math.min(totalDurationMs, frameIndexToQuantizedMs(dstFrame, fps));
    const copy: Keyframe = {
      ...src,
      keyframe_id: createId(),
      time_ms: dstTimeMs,
      bezier_handles: src.bezier_handles ? [...src.bezier_handles] : src.bezier_handles,
    };
    created.push(copy);
    occupiedSlots.add(`${getKeyframeChannelKey(copy)}@f${getKeyframeFrame(copy, fps)}`);
  }

  const replacedIds: string[] = [];
  const kept: Keyframe[] = [];
  for (const kf of allKeyframes) {
    const slot = `${getKeyframeChannelKey(kf)}@f${getKeyframeFrame(kf, fps)}`;
    if (occupiedSlots.has(slot)) {
      replacedIds.push(kf.keyframe_id);
    } else {
      kept.push(kf);
    }
  }

  return {
    keyframes: deduplicateKeyframesByChannelFrame([...kept, ...created], fps),
    createdIds: created.map((k) => k.keyframe_id),
    replacedIds,
  };
}

/**
 * Atomically pastes a clipboard of 1..N keyframes anchored so the earliest clipboard keyframe
 * lands on `targetFrame`, preserving exact relative frame spacing and resolving collisions cleanly.
 */
export function applyPasteKeyframes(
  allKeyframes: Keyframe[],
  clipboard: Keyframe[],
  targetFrame: number,
  fps: number,
  totalDurationMs: number,
  createId: () => string,
): DuplicateKeyframesResult {
  if (clipboard.length === 0) {
    return { keyframes: allKeyframes, createdIds: [], replacedIds: [] };
  }

  const upperFrame = getMaxTimelineFrame(totalDurationMs, fps);
  const minClipFrame = Math.min(...clipboard.map((k) => getKeyframeFrame(k, fps)));
  const maxClipFrame = Math.max(...clipboard.map((k) => getKeyframeFrame(k, fps)));
  const span = maxClipFrame - minClipFrame;
  const clampedTarget = Math.max(0, Math.min(Math.max(0, upperFrame - span), Math.round(targetFrame)));
  const deltaFrames = clampedTarget - minClipFrame;

  const created: Keyframe[] = [];
  const occupiedSlots = new Set<string>();
  for (const src of clipboard) {
    const dstFrame = Math.max(0, Math.min(upperFrame, getKeyframeFrame(src, fps) + deltaFrames));
    const dstTimeMs = Math.min(totalDurationMs, frameIndexToQuantizedMs(dstFrame, fps));
    const copy: Keyframe = {
      ...src,
      keyframe_id: createId(),
      time_ms: dstTimeMs,
      bezier_handles: src.bezier_handles ? [...src.bezier_handles] : src.bezier_handles,
    };
    created.push(copy);
    occupiedSlots.add(`${getKeyframeChannelKey(copy)}@f${getKeyframeFrame(copy, fps)}`);
  }

  const replacedIds: string[] = [];
  const kept: Keyframe[] = [];
  for (const kf of allKeyframes) {
    const slot = `${getKeyframeChannelKey(kf)}@f${getKeyframeFrame(kf, fps)}`;
    if (occupiedSlots.has(slot)) {
      replacedIds.push(kf.keyframe_id);
    } else {
      kept.push(kf);
    }
  }

  return {
    keyframes: deduplicateKeyframesByChannelFrame([...kept, ...created], fps),
    createdIds: created.map((k) => k.keyframe_id),
    replacedIds,
  };
}

export function applyDeleteKeyframes(
  allKeyframes: Keyframe[],
  targetIdList: string[],
): { keyframes: Keyframe[]; deletedCount: number } {
  const toDelete = new Set(targetIdList);
  if (toDelete.size === 0) {
    return { keyframes: allKeyframes, deletedCount: 0 };
  }
  const remaining = allKeyframes.filter((k) => !toDelete.has(k.keyframe_id));
  return {
    keyframes: remaining,
    deletedCount: allKeyframes.length - remaining.length,
  };
}

export function applySetKeyframesEasing(
  allKeyframes: Keyframe[],
  targetIdList: string[],
  easing: EasingType,
): { keyframes: Keyframe[]; updatedCount: number } {
  const targets = new Set(targetIdList);
  if (targets.size === 0) {
    return { keyframes: allKeyframes, updatedCount: 0 };
  }
  let updatedCount = 0;
  const next = allKeyframes.map((kf) => {
    if (!targets.has(kf.keyframe_id)) return kf;
    if (kf.easing === easing) return kf;
    updatedCount += 1;
    return { ...kf, easing };
  });
  return { keyframes: next, updatedCount };
}
