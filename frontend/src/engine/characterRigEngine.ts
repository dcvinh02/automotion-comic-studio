/**
 * Pure 2D Character Builder, Assembly, Hierarchy, Pivot & Rig Preview Engine (Phase 05 — Batch 2).
 *
 * Uses the exact same 2D affine matrix convention as PixiSceneGraph.ts and software_compositor.py
 * so every edit inside the Character Builder matches Stage Preview and MP4 Export pixel-for-pixel.
 */
import type {
  Asset,
  Character,
  CharacterPartSlot,
  PartRole,
  PartialTransform2D,
} from '@/types/models';

export type Mat2D = [number, number, number, number, number, number];

export const ALL_PART_ROLES: PartRole[] = [
  'body',
  'head',
  'hair',
  'hair_back',
  'hair_front',
  'eyes',
  'eyebrows',
  'mouth',
  'left_arm',
  'right_arm',
  'left_hand',
  'right_hand',
  'left_leg',
  'right_leg',
  'left_foot',
  'right_foot',
  'clothing',
  'accessory',
  'custom',
  'other',
];

export type RigPreviewActionId =
  | 'idle'
  | 'blink'
  | 'wave'
  | 'head_turn'
  | 'walk'
  | 'run'
  | 'bounce';

export const RIG_PREVIEW_ACTIONS: RigPreviewActionId[] = [
  'idle',
  'blink',
  'wave',
  'head_turn',
  'walk',
  'run',
  'bounce',
];

export function composeMat(
  x: number,
  y: number,
  rotDeg: number,
  sx: number,
  sy: number,
): Mat2D {
  const rad = (rotDeg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [c * sx, s * sx, -s * sy, c * sy, x, y];
}

export function mulMat(m1: Mat2D, m2: Mat2D): Mat2D {
  const [a1, b1, c1, d1, tx1, ty1] = m1;
  const [a2, b2, c2, d2, tx2, ty2] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * tx2 + c1 * ty2 + tx1,
    b1 * tx2 + d1 * ty2 + ty1,
  ];
}

export function invertMat(m: Mat2D): Mat2D {
  const [a, b, c, d, tx, ty] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-8) {
    return [1, 0, 0, 1, -tx, -ty];
  }
  const inv = 1 / det;
  return [
    d * inv,
    -b * inv,
    -c * inv,
    a * inv,
    (c * ty - d * tx) * inv,
    (b * tx - a * ty) * inv,
  ];
}

export function applyMat(m: Mat2D, px: number, py: number): { x: number; y: number } {
  return {
    x: m[0] * px + m[2] * py + m[4],
    y: m[1] * px + m[3] * py + m[5],
  };
}

export function applyLinearInverse(m: Mat2D, dx: number, dy: number): { x: number; y: number } {
  const inv = invertMat(m);
  return {
    x: inv[0] * dx + inv[2] * dy,
    y: inv[1] * dx + inv[3] * dy,
  };
}

export function decomposeMat(m: Mat2D): {
  x: number;
  y: number;
  rotation_deg: number;
  scale_x: number;
  scale_y: number;
} {
  const [a, b, c, d, tx, ty] = m;
  const sx = Math.hypot(a, b);
  const det = a * d - b * c;
  const sy = (det < 0 ? -1 : 1) * Math.hypot(c, d);
  const rotation_deg = (Math.atan2(b, a) * 180) / Math.PI;
  return {
    x: round2(tx),
    y: round2(ty),
    rotation_deg: round2(rotation_deg),
    scale_x: round3(sx || 1),
    scale_y: round3(sy || 1),
  };
}

function round2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}

function round3(v: number): number {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
}

/**
 * Resolves canvas-space world affine matrices for every part in the character rig (cycle-safe).
 */
export function computePartWorldMatrices(
  parts: CharacterPartSlot[],
  rootX: number,
  rootY: number,
): Map<string, Mat2D> {
  const byId = new Map(parts.map((p) => [p.slot_id, p]));
  const rootMat: Mat2D = [1, 0, 0, 1, rootX, rootY];
  const cache = new Map<string, Mat2D>();

  const resolve = (slotId: string, visited = new Set<string>()): Mat2D => {
    const hit = cache.get(slotId);
    if (hit) return hit;
    const part = byId.get(slotId);
    if (!part) return rootMat;
    const own = composeMat(
      part.default_transform.x,
      part.default_transform.y,
      part.default_transform.rotation_deg,
      part.default_transform.scale_x,
      part.default_transform.scale_y,
    );
    if (visited.has(slotId)) {
      const m = mulMat(rootMat, own);
      cache.set(slotId, m);
      return m;
    }
    visited.add(slotId);
    const parentMat =
      part.parent_slot_id && byId.has(part.parent_slot_id)
        ? resolve(part.parent_slot_id, visited)
        : rootMat;
    const combined = mulMat(parentMat, own);
    cache.set(slotId, combined);
    return combined;
  };

  for (const part of parts) {
    resolve(part.slot_id);
  }
  return cache;
}

/**
 * Collects all descendant slot IDs of `slotId` (cycle-safe).
 */
export function getDescendantSlotIds(parts: CharacterPartSlot[], slotId: string): Set<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const p of parts) {
    if (p.parent_slot_id) {
      const list = childrenByParent.get(p.parent_slot_id);
      if (list) list.push(p.slot_id);
      else childrenByParent.set(p.parent_slot_id, [p.slot_id]);
    }
  }
  const descendants = new Set<string>();
  const stack = [...(childrenByParent.get(slotId) ?? [])];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (descendants.has(cur) || cur === slotId) continue;
    descendants.add(cur);
    for (const child of childrenByParent.get(cur) ?? []) {
      stack.push(child);
    }
  }
  return descendants;
}

/**
 * Checks whether setting `newParentSlotId` as parent of `slotId` is valid (no self-parenting or cycle).
 */
export function canReparentPart(
  parts: CharacterPartSlot[],
  slotId: string,
  newParentSlotId: string | null,
): boolean {
  if (newParentSlotId === null) return true;
  if (slotId === newParentSlotId) return false;
  const byId = new Map(parts.map((p) => [p.slot_id, p]));
  if (!byId.has(slotId) || !byId.has(newParentSlotId)) return false;
  const descendants = getDescendantSlotIds(parts, slotId);
  return !descendants.has(newParentSlotId);
}

/**
 * Reparents a part to `newParentSlotId` (or null for root) while mathematically preserving
 * its exact visual world position, rotation, and scale.
 */
export function reparentPartPreservingWorldTransform(
  parts: CharacterPartSlot[],
  slotId: string,
  newParentSlotId: string | null,
): CharacterPartSlot[] | null {
  if (!canReparentPart(parts, slotId, newParentSlotId)) return null;
  const target = parts.find((p) => p.slot_id === slotId);
  if (!target) return null;
  if (target.parent_slot_id === newParentSlotId) return parts;

  const worldMats = computePartWorldMatrices(parts, 0, 0);
  const oldWorld = worldMats.get(slotId)!;
  const newParentWorld: Mat2D = newParentSlotId
    ? (worldMats.get(newParentSlotId) ?? [1, 0, 0, 1, 0, 0])
    : [1, 0, 0, 1, 0, 0];

  const newLocalMat = mulMat(invertMat(newParentWorld), oldWorld);
  const dec = decomposeMat(newLocalMat);

  return parts.map((p) =>
    p.slot_id === slotId
      ? {
          ...p,
          parent_slot_id: newParentSlotId,
          default_transform: {
            ...p.default_transform,
            x: dec.x,
            y: dec.y,
            rotation_deg: dec.rotation_deg,
            scale_x: dec.scale_x,
            scale_y: dec.scale_y,
          },
        }
      : p,
  );
}

/**
 * Moves a part's normalized pivot (anchor_x, anchor_y) while mathematically compensating both
 * the part's local (x, y) AND its direct children's local (x, y) so neither the part nor
 * any attached child jumps visually on screen!
 */
export function movePartPivotPreservingVisualPosition(
  parts: CharacterPartSlot[],
  slotId: string,
  newAnchorX: number,
  newAnchorY: number,
  texWidth: number,
  texHeight: number,
): CharacterPartSlot[] {
  const target = parts.find((p) => p.slot_id === slotId);
  if (!target) return parts;

  const clampedAx = round3(Math.max(0, Math.min(1, newAnchorX)));
  const clampedAy = round3(Math.max(0, Math.min(1, newAnchorY)));

  const dpx = (clampedAx - target.anchor_x) * Math.max(1, texWidth);
  const dpy = (clampedAy - target.anchor_y) * Math.max(1, texHeight);

  const rad = (target.default_transform.rotation_deg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const sx = target.default_transform.scale_x;
  const sy = target.default_transform.scale_y;

  const parentSpaceShiftX = c * sx * dpx - s * sy * dpy;
  const parentSpaceShiftY = s * sx * dpx + c * sy * dpy;

  return parts.map((p) => {
    if (p.slot_id === slotId) {
      return {
        ...p,
        anchor_x: clampedAx,
        anchor_y: clampedAy,
        default_transform: {
          ...p.default_transform,
          x: round2(p.default_transform.x + parentSpaceShiftX),
          y: round2(p.default_transform.y + parentSpaceShiftY),
        },
      };
    }
    if (p.parent_slot_id === slotId) {
      // Shift direct children in parent-local space by (-dpx, -dpy) so children stay visually pinned
      return {
        ...p,
        default_transform: {
          ...p.default_transform,
          x: round2(p.default_transform.x - dpx),
          y: round2(p.default_transform.y - dpy),
        },
      };
    }
    return p;
  });
}

/**
 * Converts a canvas pointer coordinate into normalized (anchor_x, anchor_y) in the part's image space.
 */
export function canvasPointToPartAnchor(
  part: CharacterPartSlot,
  partWorldMat: Mat2D,
  canvasX: number,
  canvasY: number,
  texWidth: number,
  texHeight: number,
): { anchor_x: number; anchor_y: number } {
  const localPt = applyMat(invertMat(partWorldMat), canvasX, canvasY);
  const w = Math.max(1, texWidth);
  const h = Math.max(1, texHeight);
  return {
    anchor_x: round3(Math.max(0, Math.min(1, part.anchor_x + localPt.x / w))),
    anchor_y: round3(Math.max(0, Math.min(1, part.anchor_y + localPt.y / h))),
  };
}

export interface PartCanvasQuad {
  slotId: string;
  pivot: { x: number; y: number };
  corners: Array<{ x: number; y: number }>;
  topCenter: { x: number; y: number };
  center: { x: number; y: number };
  width: number;
  height: number;
}

export function computePartCanvasQuad(
  part: CharacterPartSlot,
  worldMat: Mat2D,
  texWidth: number,
  texHeight: number,
): PartCanvasQuad {
  const w = Math.max(24, texWidth);
  const h = Math.max(24, texHeight);
  const left = -part.anchor_x * w;
  const right = (1 - part.anchor_x) * w;
  const top = -part.anchor_y * h;
  const bottom = (1 - part.anchor_y) * h;

  const tl = applyMat(worldMat, left, top);
  const tr = applyMat(worldMat, right, top);
  const br = applyMat(worldMat, right, bottom);
  const bl = applyMat(worldMat, left, bottom);
  const topCenter = applyMat(worldMat, (left + right) / 2, top);
  const center = applyMat(worldMat, (left + right) / 2, (top + bottom) / 2);
  const pivot = applyMat(worldMat, 0, 0);

  return {
    slotId: part.slot_id,
    pivot,
    corners: [tl, tr, br, bl],
    topCenter,
    center,
    width: w,
    height: h,
  };
}

/**
 * Hit-tests character parts front-to-back (highest z_index first) in exact local rotated sprite space.
 */
export function hitTestCharacterParts(
  parts: CharacterPartSlot[],
  worldMats: Map<string, Mat2D>,
  assetDimsById: Map<string, { width: number; height: number }>,
  canvasX: number,
  canvasY: number,
): CharacterPartSlot | null {
  const ordered = [...parts]
    .filter((p) => p.visible)
    .sort((a, b) => b.z_index - a.z_index);

  for (const part of ordered) {
    const mat = worldMats.get(part.slot_id);
    if (!mat) continue;
    const dims = part.default_asset_id ? assetDimsById.get(part.default_asset_id) : undefined;
    const w = dims?.width ?? 64;
    const h = dims?.height ?? 64;
    const local = applyMat(invertMat(mat), canvasX, canvasY);
    const left = -part.anchor_x * w;
    const right = (1 - part.anchor_x) * w;
    const top = -part.anchor_y * h;
    const bottom = (1 - part.anchor_y) * h;
    if (local.x >= left && local.x <= right && local.y >= top && local.y <= bottom) {
      return part;
    }
  }
  return null;
}

export interface HierarchyTreeNode {
  part: CharacterPartSlot;
  depth: number;
  childCount: number;
  hasChildren: boolean;
}

/**
 * Flattens character parts into an ordered parent-child tree for the Hierarchy Panel,
 * respecting collapsed nodes and cycle safety.
 */
export function buildHierarchyTree(
  parts: CharacterPartSlot[],
  collapsedIds: ReadonlySet<string> = new Set(),
): HierarchyTreeNode[] {
  const byId = new Map(parts.map((p) => [p.slot_id, p]));
  const childrenMap = new Map<string | null, CharacterPartSlot[]>();
  for (const p of parts) {
    const pid = p.parent_slot_id && byId.has(p.parent_slot_id) ? p.parent_slot_id : null;
    const list = childrenMap.get(pid);
    if (list) list.push(p);
    else childrenMap.set(pid, [p]);
  }
  for (const list of childrenMap.values()) {
    list.sort((a, b) => b.z_index - a.z_index || a.name.localeCompare(b.name));
  }

  const out: HierarchyTreeNode[] = [];
  const visited = new Set<string>();

  const walk = (parentId: string | null, depth: number, visibleBranch: boolean) => {
    const kids = childrenMap.get(parentId) ?? [];
    for (const part of kids) {
      if (visited.has(part.slot_id)) continue;
      visited.add(part.slot_id);
      const subKids = childrenMap.get(part.slot_id) ?? [];
      if (visibleBranch) {
        out.push({
          part,
          depth,
          childCount: subKids.length,
          hasChildren: subKids.length > 0,
        });
      }
      if (subKids.length > 0) {
        walk(part.slot_id, depth + 1, visibleBranch && !collapsedIds.has(part.slot_id));
      }
    }
  };

  walk(null, 0, true);

  // Append any unvisited cyclic orphan safely at depth 0
  for (const p of parts) {
    if (!visited.has(p.slot_id)) {
      out.push({ part: p, depth: 0, childCount: 0, hasChildren: false });
    }
  }
  return out;
}

/**
 * Groups selected slot(s) under a newly created group container slot at their average world pivot,
 * preserving every child's visual world position.
 */
export function groupPartsUnderNewGroup(
  parts: CharacterPartSlot[],
  slotIds: string[],
  groupName: string,
  createSlotId: () => string,
): { parts: CharacterPartSlot[]; groupId: string } | null {
  const validIds = slotIds.filter((id) => parts.some((p) => p.slot_id === id));
  if (validIds.length === 0) return null;

  const worldMats = computePartWorldMatrices(parts, 0, 0);
  const first = parts.find((p) => p.slot_id === validIds[0])!;
  const commonParent = first.parent_slot_id;

  let avgX = 0;
  let avgY = 0;
  for (const id of validIds) {
    const m = worldMats.get(id)!;
    avgX += m[4];
    avgY += m[5];
  }
  avgX /= validIds.length;
  avgY /= validIds.length;

  const parentWorld: Mat2D = commonParent
    ? (worldMats.get(commonParent) ?? [1, 0, 0, 1, 0, 0])
    : [1, 0, 0, 1, 0, 0];
  const localOrigin = applyMat(invertMat(parentWorld), avgX, avgY);

  const groupId = createSlotId();
  const maxZ = Math.max(...parts.map((p) => p.z_index), 10);
  const groupSlot: CharacterPartSlot = {
    slot_id: groupId,
    name: groupName.trim() || 'Group',
    part_role: 'custom',
    parent_slot_id: commonParent,
    default_asset_id: null,
    variants: {},
    z_index: maxZ + 1,
    anchor_x: 0.5,
    anchor_y: 0.5,
    default_transform: {
      x: round2(localOrigin.x),
      y: round2(localOrigin.y),
      rotation_deg: 0,
      scale_x: 1,
      scale_y: 1,
      opacity: 1,
    },
    visible: true,
    locked: false,
  };

  let next = [...parts, groupSlot];
  for (const id of validIds) {
    const reparented = reparentPartPreservingWorldTransform(next, id, groupId);
    if (reparented) next = reparented;
  }
  return { parts: next, groupId };
}

/**
 * Ungroups an empty group slot by reparenting all direct children to the group's parent
 * (preserving every child's world position) and removing the group container.
 */
export function ungroupPart(
  parts: CharacterPartSlot[],
  groupSlotId: string,
): CharacterPartSlot[] | null {
  const group = parts.find((p) => p.slot_id === groupSlotId);
  if (!group) return null;
  const children = parts.filter((p) => p.parent_slot_id === groupSlotId);
  if (children.length === 0) return null;

  let next = [...parts];
  for (const child of children) {
    const reparented = reparentPartPreservingWorldTransform(
      next,
      child.slot_id,
      group.parent_slot_id,
    );
    if (reparented) next = reparented;
  }
  // If the group had no sprite asset of its own, remove the container cleanly; otherwise just release its children
  if (!group.default_asset_id) {
    next = next.filter((p) => p.slot_id !== groupSlotId);
  }
  return next;
}

/**
 * Smart filename-to-PartRole detector for multi-PNG character part imports.
 */
export function guessPartRoleFromFilename(filename: string): PartRole {
  const lower = filename.toLowerCase().replace(/\.[^.]+$/, '');
  const isLeft = /(^|[\s_-])(left|l)([\s_-]|$)/.test(lower) || lower.includes('trai');
  const isRight = /(^|[\s_-])(right|r)([\s_-]|$)/.test(lower) || lower.includes('phai');

  if (lower.includes('eyebrow') || lower.includes('brow') || lower.includes('may')) return 'eyebrows';
  if (lower.includes('eye') || lower.includes('mat')) return 'eyes';
  if (lower.includes('mouth') || lower.includes('lip') || lower.includes('mieng')) return 'mouth';
  if (lower.includes('hair_back') || lower.includes('back_hair')) return 'hair_back';
  if (lower.includes('hair_front') || lower.includes('front_hair') || lower.includes('bang')) return 'hair_front';
  if (lower.includes('hair') || lower.includes('toc')) return 'hair';
  if (lower.includes('head') || lower.includes('face') || lower.includes('dau')) return 'head';
  if (lower.includes('body') || lower.includes('torso') || lower.includes('than')) return 'body';
  if (lower.includes('hand') || lower.includes('ban_tay')) return isRight ? 'right_hand' : 'left_hand';
  if (lower.includes('arm') || lower.includes('tay')) return isRight ? 'right_arm' : 'left_arm';
  if (lower.includes('foot') || lower.includes('shoe') || lower.includes('boot') || lower.includes('ban_chan')) {
    return isRight ? 'right_foot' : 'left_foot';
  }
  if (lower.includes('leg') || lower.includes('thigh') || lower.includes('chan')) {
    return isRight ? 'right_leg' : 'left_leg';
  }
  if (
    lower.includes('cloth') ||
    lower.includes('shirt') ||
    lower.includes('dress') ||
    lower.includes('jacket') ||
    lower.includes('coat') ||
    lower.includes('ao')
  ) {
    return 'clothing';
  }
  if (
    lower.includes('acc') ||
    lower.includes('hat') ||
    lower.includes('glass') ||
    lower.includes('sword') ||
    lower.includes('bag')
  ) {
    return 'accessory';
  }
  return isLeft ? 'left_arm' : isRight ? 'right_arm' : 'custom';
}

/**
 * Beginner-friendly anatomical pivot defaults (shoulder, neck, hip, wrist, ankle).
 */
export function getDefaultPivotForRole(role: PartRole): { anchor_x: number; anchor_y: number } {
  switch (role) {
    case 'body':
    case 'clothing':
      return { anchor_x: 0.5, anchor_y: 0.8 };
    case 'head':
      return { anchor_x: 0.5, anchor_y: 0.88 };
    case 'hair':
    case 'hair_front':
    case 'hair_back':
      return { anchor_x: 0.5, anchor_y: 0.25 };
    case 'left_arm':
    case 'right_arm':
      return { anchor_x: 0.5, anchor_y: 0.12 };
    case 'left_hand':
    case 'right_hand':
      return { anchor_x: 0.5, anchor_y: 0.15 };
    case 'left_leg':
    case 'right_leg':
      return { anchor_x: 0.5, anchor_y: 0.1 };
    case 'left_foot':
    case 'right_foot':
      return { anchor_x: 0.5, anchor_y: 0.2 };
    default:
      return { anchor_x: 0.5, anchor_y: 0.5 };
  }
}

export function getSuggestedZIndexForRole(role: PartRole): number {
  switch (role) {
    case 'hair_back':
      return 4;
    case 'left_leg':
      return 8;
    case 'left_foot':
      return 9;
    case 'right_leg':
      return 10;
    case 'right_foot':
      return 11;
    case 'left_arm':
      return 12;
    case 'left_hand':
      return 13;
    case 'body':
      return 15;
    case 'clothing':
      return 17;
    case 'head':
      return 22;
    case 'eyes':
      return 26;
    case 'eyebrows':
      return 28;
    case 'mouth':
      return 27;
    case 'hair':
    case 'hair_front':
      return 32;
    case 'right_arm':
      return 36;
    case 'right_hand':
      return 37;
    case 'accessory':
      return 40;
    default:
      return 20;
  }
}

export function getSuggestedParentSlotId(
  parts: CharacterPartSlot[],
  role: PartRole,
): string | null {
  const findByRole = (r: PartRole) => parts.find((p) => p.part_role === r)?.slot_id ?? null;
  const bodyId = findByRole('body');
  const headId = findByRole('head');

  switch (role) {
    case 'body':
      return null;
    case 'head':
    case 'clothing':
    case 'left_arm':
    case 'right_arm':
    case 'left_leg':
    case 'right_leg':
      return bodyId;
    case 'left_hand':
      return findByRole('left_arm') ?? bodyId;
    case 'right_hand':
      return findByRole('right_arm') ?? bodyId;
    case 'left_foot':
      return findByRole('left_leg') ?? bodyId;
    case 'right_foot':
      return findByRole('right_leg') ?? bodyId;
    case 'hair':
    case 'hair_back':
    case 'hair_front':
    case 'eyes':
    case 'eyebrows':
    case 'mouth':
      return headId ?? bodyId;
    default:
      return bodyId;
  }
}

export function getSuggestedLocalOffsetForRole(role: PartRole): { x: number; y: number } {
  switch (role) {
    case 'body':
    case 'clothing':
      return { x: 0, y: 0 };
    case 'head':
      return { x: 0, y: -130 };
    case 'hair':
    case 'hair_front':
    case 'hair_back':
      return { x: 0, y: -25 };
    case 'eyes':
      return { x: 0, y: -42 };
    case 'eyebrows':
      return { x: 0, y: -60 };
    case 'mouth':
      return { x: 0, y: -12 };
    case 'left_arm':
      return { x: -58, y: -115 };
    case 'right_arm':
      return { x: 58, y: -115 };
    case 'left_hand':
    case 'right_hand':
      return { x: 0, y: 95 };
    case 'left_leg':
      return { x: -26, y: -14 };
    case 'right_leg':
      return { x: 26, y: -14 };
    case 'left_foot':
    case 'right_foot':
      return { x: 0, y: 110 };
    default:
      return { x: 0, y: -40 };
  }
}

export interface RigActionCapability {
  supported: boolean;
  reasonKey: string | null;
}

export interface CharacterRigAnalysis {
  rigStatus: 'ready' | 'basic' | 'incomplete';
  totalParts: number;
  assignedParts: number;
  missingAssetSlotNames: string[];
  missingCoreRoles: PartRole[];
  thumbnailAssetId: string | null;
  actions: Record<RigPreviewActionId, RigActionCapability>;
}

/**
 * Truthfully inspects a Character rig and determines which Rig Preview actions are genuinely
 * supported by actual parts & assets (never fakes unsupported motion).
 */
export function analyzeCharacterRig(
  character: Pick<Character, 'parts' | 'thumbnail_asset_id'>,
  assetsById?: Record<string, Asset>,
): CharacterRigAnalysis {
  const parts = character.parts ?? [];
  const hasRealAsset = (p: CharacterPartSlot): boolean => {
    if (!p.default_asset_id) return false;
    if (assetsById && Object.keys(assetsById).length > 0) {
      return Boolean(assetsById[p.default_asset_id]);
    }
    return true;
  };

  const assignedPartsList = parts.filter((p) => p.visible && hasRealAsset(p));
  const missingAssetSlotNames = parts
    .filter((p) => !p.default_asset_id && !parts.some((c) => c.parent_slot_id === p.slot_id))
    .map((p) => p.name);

  const hasRoleWithAsset = (role: PartRole) =>
    assignedPartsList.some((p) => p.part_role === role);

  const hasBody = hasRoleWithAsset('body');
  const hasHead = hasRoleWithAsset('head');
  const hasAnyArm = hasRoleWithAsset('right_arm') || hasRoleWithAsset('left_arm');
  const hasBothLegs = hasRoleWithAsset('left_leg') && hasRoleWithAsset('right_leg');

  const eyeParts = parts.filter((p) => p.part_role === 'eyes' && p.visible);
  const canBlink = eyeParts.some(
    (p) => Boolean(p.variants?.closed) || Object.keys(p.variants ?? {}).length >= 2,
  );

  const missingCoreRoles: PartRole[] = [];
  if (!hasBody) missingCoreRoles.push('body');
  if (!hasHead) missingCoreRoles.push('head');

  let rigStatus: CharacterRigAnalysis['rigStatus'] = 'incomplete';
  if (assignedPartsList.length >= 2 && hasBody && hasHead) {
    rigStatus = 'ready';
  } else if (assignedPartsList.length >= 1) {
    rigStatus = 'basic';
  }

  let thumbnailAssetId: string | null = character.thumbnail_asset_id ?? null;
  if (thumbnailAssetId && assetsById && Object.keys(assetsById).length > 0 && !assetsById[thumbnailAssetId]) {
    thumbnailAssetId = null;
  }
  if (!thumbnailAssetId) {
    const headPart = assignedPartsList.find((p) => p.part_role === 'head');
    const bodyPart = assignedPartsList.find((p) => p.part_role === 'body');
    thumbnailAssetId =
      headPart?.default_asset_id ??
      bodyPart?.default_asset_id ??
      assignedPartsList[0]?.default_asset_id ??
      null;
  }

  const actions: Record<RigPreviewActionId, RigActionCapability> = {
    idle: {
      supported: assignedPartsList.length >= 1,
      reasonKey: assignedPartsList.length >= 1 ? null : 'builder.reasonNeedAnyPart',
    },
    blink: {
      supported: canBlink,
      reasonKey: canBlink ? null : 'builder.reasonNeedEyeVariants',
    },
    wave: {
      supported: hasAnyArm,
      reasonKey: hasAnyArm ? null : 'builder.reasonNeedArm',
    },
    head_turn: {
      supported: hasHead,
      reasonKey: hasHead ? null : 'builder.reasonNeedHead',
    },
    walk: {
      supported: hasBothLegs,
      reasonKey: hasBothLegs ? null : 'builder.reasonNeedLegs',
    },
    run: {
      supported: hasBothLegs,
      reasonKey: hasBothLegs ? null : 'builder.reasonNeedLegs',
    },
    bounce: {
      supported: assignedPartsList.length >= 1,
      reasonKey: assignedPartsList.length >= 1 ? null : 'builder.reasonNeedAnyPart',
    },
  };

  return {
    rigStatus,
    totalParts: parts.length,
    assignedParts: assignedPartsList.length,
    missingAssetSlotNames,
    missingCoreRoles,
    thumbnailAssetId,
    actions,
  };
}

export interface RigPreviewPoseResult {
  rootOffsetY: number;
  rootScaleX: number;
  rootScaleY: number;
  slotDeltaTransforms: Record<string, PartialTransform2D>;
  eyeStateOverride: string | null;
}

/**
 * Evaluates real, pivot-driven hierarchical preview motion at `elapsedMs` for the chosen action.
 * Never mutates the saved character rig — strictly computes live preview deltas.
 */
export function evaluateRigPreviewPose(
  parts: CharacterPartSlot[],
  action: RigPreviewActionId,
  elapsedMs: number,
): RigPreviewPoseResult {
  const slotDeltaTransforms: Record<string, PartialTransform2D> = {};
  let rootOffsetY = 0;
  let rootScaleX = 1;
  let rootScaleY = 1;
  let eyeStateOverride: string | null = null;

  const t = Math.max(0, elapsedMs) / 1000;
  const addRot = (slotId: string, deg: number) => {
    const prev = slotDeltaTransforms[slotId] ?? {};
    slotDeltaTransforms[slotId] = { ...prev, rotation_deg: (prev.rotation_deg ?? 0) + deg };
  };
  const addPos = (slotId: string, dx: number, dy: number) => {
    const prev = slotDeltaTransforms[slotId] ?? {};
    slotDeltaTransforms[slotId] = {
      ...prev,
      x: (prev.x ?? 0) + dx,
      y: (prev.y ?? 0) + dy,
    };
  };

  switch (action) {
    case 'idle': {
      const breath = Math.sin(t * Math.PI * 0.85);
      rootScaleY = 1 + breath * 0.018;
      rootOffsetY = -breath * 2.5;
      for (const p of parts) {
        if (p.part_role === 'head') addRot(p.slot_id, Math.sin(t * Math.PI * 0.45) * 3.5);
        if (p.part_role === 'left_arm') addRot(p.slot_id, 2 + breath * 2.5);
        if (p.part_role === 'right_arm') addRot(p.slot_id, -2 - breath * 2.5);
      }
      break;
    }
    case 'blink': {
      const cycle = elapsedMs % 2400;
      eyeStateOverride = cycle >= 1900 && cycle <= 2080 ? 'closed' : 'open';
      break;
    }
    case 'wave': {
      const waveArm =
        parts.find((p) => p.part_role === 'right_arm' && p.visible && p.default_asset_id) ??
        parts.find((p) => p.part_role === 'left_arm' && p.visible && p.default_asset_id);
      if (waveArm) {
        const sign = waveArm.part_role === 'right_arm' ? -1 : 1;
        const waveOsc = Math.sin(t * Math.PI * 3.2);
        addRot(waveArm.slot_id, sign * (130 + waveOsc * 22));
        // Secondary hand wave around wrist pivot if child hand exists
        const handRole: PartRole = waveArm.part_role === 'right_arm' ? 'right_hand' : 'left_hand';
        for (const p of parts) {
          if (p.part_role === handRole) {
            addRot(p.slot_id, sign * Math.sin(t * Math.PI * 3.2 - 0.6) * 18);
          }
          if (p.part_role === 'head') {
            addRot(p.slot_id, -sign * (5 + waveOsc * 3));
          }
        }
      }
      break;
    }
    case 'head_turn': {
      const swing = Math.sin(t * Math.PI * 1.1);
      for (const p of parts) {
        if (p.part_role === 'head') {
          addRot(p.slot_id, swing * 18);
        }
        if (p.part_role === 'hair' || p.part_role === 'hair_back' || p.part_role === 'hair_front') {
          addRot(p.slot_id, -Math.sin(t * Math.PI * 1.1 - 0.35) * 4);
        }
      }
      break;
    }
    case 'walk': {
      const phase = t * Math.PI * 2.4;
      const stride = Math.sin(phase);
      rootOffsetY = -Math.abs(Math.sin(phase)) * 12;
      for (const p of parts) {
        if (p.part_role === 'body') addRot(p.slot_id, Math.sin(phase) * 2.5);
        if (p.part_role === 'head') addRot(p.slot_id, -Math.sin(phase) * 2);
        if (p.part_role === 'left_leg') addRot(p.slot_id, stride * 24);
        if (p.part_role === 'right_leg') addRot(p.slot_id, -stride * 24);
        if (p.part_role === 'left_foot') addRot(p.slot_id, Math.max(0, -stride) * 14);
        if (p.part_role === 'right_foot') addRot(p.slot_id, Math.max(0, stride) * 14);
        if (p.part_role === 'left_arm') addRot(p.slot_id, -stride * 20);
        if (p.part_role === 'right_arm') addRot(p.slot_id, stride * 20);
      }
      break;
    }
    case 'run': {
      const phase = t * Math.PI * 4.0;
      const stride = Math.sin(phase);
      rootOffsetY = -Math.abs(Math.sin(phase)) * 22;
      for (const p of parts) {
        if (p.part_role === 'body') addRot(p.slot_id, 8 + Math.sin(phase) * 3.5);
        if (p.part_role === 'head') addRot(p.slot_id, -6 + Math.sin(phase) * 2);
        if (p.part_role === 'left_leg') addRot(p.slot_id, stride * 42);
        if (p.part_role === 'right_leg') addRot(p.slot_id, -stride * 42);
        if (p.part_role === 'left_foot') addRot(p.slot_id, Math.max(0, -stride) * 22);
        if (p.part_role === 'right_foot') addRot(p.slot_id, Math.max(0, stride) * 22);
        if (p.part_role === 'left_arm') addRot(p.slot_id, -stride * 38);
        if (p.part_role === 'right_arm') addRot(p.slot_id, stride * 38);
      }
      break;
    }
    case 'bounce': {
      const cycle = (t * 1.4) % 1;
      const jump = Math.sin(cycle * Math.PI);
      rootOffsetY = -jump * 34;
      // Anticipation squash at ground contact, slight stretch at apex
      const squash = cycle < 0.12 || cycle > 0.88 ? -0.07 : jump * 0.05;
      rootScaleY = 1 + squash;
      rootScaleX = 1 - squash * 0.7;
      for (const p of parts) {
        if (p.part_role === 'left_arm') addRot(p.slot_id, jump * 18);
        if (p.part_role === 'right_arm') addRot(p.slot_id, -jump * 18);
        if (p.part_role === 'head') addPos(p.slot_id, 0, -jump * 3);
      }
      break;
    }
  }

  return {
    rootOffsetY,
    rootScaleX,
    rootScaleY,
    slotDeltaTransforms,
    eyeStateOverride,
  };
}

/**
 * Produces a temporary preview Character copy applying `RigPreviewPoseResult` deltas
 * on top of base `default_transform` values without modifying the editable draft.
 */
export function applyRigPreviewPoseToCharacter(
  character: Character,
  pose: RigPreviewPoseResult | null,
): Character {
  if (!pose) return character;
  return {
    ...character,
    parts: character.parts.map((part) => {
      const delta = pose.slotDeltaTransforms[part.slot_id];
      if (!delta) return part;
      return {
        ...part,
        default_transform: {
          x: part.default_transform.x + (delta.x ?? 0),
          y: part.default_transform.y + (delta.y ?? 0),
          rotation_deg: part.default_transform.rotation_deg + (delta.rotation_deg ?? 0),
          scale_x: part.default_transform.scale_x * (delta.scale_x ?? 1),
          scale_y: part.default_transform.scale_y * (delta.scale_y ?? 1),
          opacity: part.default_transform.opacity,
        },
      };
    }),
  };
}
