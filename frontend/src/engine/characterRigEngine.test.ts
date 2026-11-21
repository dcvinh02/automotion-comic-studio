import { describe, expect, it } from 'vitest';
import {
  analyzeCharacterRig,
  applyMat,
  applyRigPreviewPoseToCharacter,
  buildHierarchyTree,
  canReparentPart,
  canvasPointToPartAnchor,
  computePartCanvasQuad,
  computePartWorldMatrices,
  evaluateRigPreviewPose,
  getDefaultPivotForRole,
  getSuggestedParentSlotId,
  groupPartsUnderNewGroup,
  guessPartRoleFromFilename,
  hitTestCharacterParts,
  movePartPivotPreservingVisualPosition,
  reparentPartPreservingWorldTransform,
  ungroupPart,
} from './characterRigEngine';
import type { Character, CharacterPartSlot } from '@/types/models';

function makeSampleParts(): CharacterPartSlot[] {
  return [
    {
      slot_id: 'slot_body',
      name: 'Body',
      part_role: 'body',
      parent_slot_id: null,
      default_asset_id: 'ast_body',
      variants: {},
      z_index: 15,
      anchor_x: 0.5,
      anchor_y: 0.8,
      default_transform: { x: 20, y: -10, rotation_deg: 15, scale_x: 1.2, scale_y: 1.2, opacity: 1 },
      visible: true,
      locked: false,
    },
    {
      slot_id: 'slot_head',
      name: 'Head',
      part_role: 'head',
      parent_slot_id: 'slot_body',
      default_asset_id: 'ast_head',
      variants: {},
      z_index: 22,
      anchor_x: 0.5,
      anchor_y: 0.88,
      default_transform: { x: 0, y: -130, rotation_deg: 0, scale_x: 1, scale_y: 1, opacity: 1 },
      visible: true,
      locked: false,
    },
    {
      slot_id: 'slot_r_arm',
      name: 'Right Arm',
      part_role: 'right_arm',
      parent_slot_id: 'slot_body',
      default_asset_id: 'ast_r_arm',
      variants: {},
      z_index: 36,
      anchor_x: 0.5,
      anchor_y: 0.5,
      default_transform: { x: 55, y: -100, rotation_deg: 25, scale_x: 1, scale_y: 1, opacity: 1 },
      visible: true,
      locked: false,
    },
    {
      slot_id: 'slot_r_hand',
      name: 'Right Hand',
      part_role: 'right_hand',
      parent_slot_id: 'slot_r_arm',
      default_asset_id: 'ast_r_hand',
      variants: {},
      z_index: 37,
      anchor_x: 0.5,
      anchor_y: 0.15,
      default_transform: { x: 0, y: 80, rotation_deg: 0, scale_x: 1, scale_y: 1, opacity: 1 },
      visible: true,
      locked: false,
    },
  ];
}

describe('Phase 05 Batch 2 — Character Builder, Hierarchy, Pivot & Rig Preview Engine', () => {
  it('guesses anatomical part roles, pivots, and parent slots from transparent PNG filenames', () => {
    expect(guessPartRoleFromFilename('hero_body.png')).toBe('body');
    expect(guessPartRoleFromFilename('minh_head.png')).toBe('head');
    expect(guessPartRoleFromFilename('left_arm_sleeve.png')).toBe('left_arm');
    expect(guessPartRoleFromFilename('right_hand.png')).toBe('right_hand');
    expect(guessPartRoleFromFilename('left_foot_boot.png')).toBe('left_foot');
    expect(guessPartRoleFromFilename('eyebrows_happy.png')).toBe('eyebrows');
    expect(guessPartRoleFromFilename('school_jacket.png')).toBe('clothing');
    expect(guessPartRoleFromFilename('hat_accessory.png')).toBe('accessory');

    expect(getDefaultPivotForRole('right_arm')).toEqual({ anchor_x: 0.5, anchor_y: 0.12 });
    expect(getDefaultPivotForRole('head')).toEqual({ anchor_x: 0.5, anchor_y: 0.88 });

    const parts = makeSampleParts();
    expect(getSuggestedParentSlotId(parts, 'right_hand')).toBe('slot_r_arm');
    expect(getSuggestedParentSlotId(parts, 'eyes')).toBe('slot_head');
    expect(getSuggestedParentSlotId(parts, 'left_leg')).toBe('slot_body');
  });

  it('reparents parts while mathematically preserving exact visual world position and rejecting cycles', () => {
    const parts = makeSampleParts();
    const beforeMats = computePartWorldMatrices(parts, 310, 390);
    const armBefore = beforeMats.get('slot_r_arm')!;

    // Cycle check: cannot parent Body inside Right Hand or self
    expect(canReparentPart(parts, 'slot_body', 'slot_r_hand')).toBe(false);
    expect(canReparentPart(parts, 'slot_body', 'slot_body')).toBe(false);
    expect(reparentPartPreservingWorldTransform(parts, 'slot_body', 'slot_r_hand')).toBeNull();

    // Reparent Right Arm from Body -> Root (unparent)
    const unparented = reparentPartPreservingWorldTransform(parts, 'slot_r_arm', null)!;
    const afterUnparentMats = computePartWorldMatrices(unparented, 310, 390);
    const armAfterUnparent = afterUnparentMats.get('slot_r_arm')!;
    expect(armAfterUnparent[4]).toBeCloseTo(armBefore[4], 1);
    expect(armAfterUnparent[5]).toBeCloseTo(armBefore[5], 1);

    // Reparent Right Arm from Root -> Head (rotated parent hierarchy!)
    const underHead = reparentPartPreservingWorldTransform(unparented, 'slot_r_arm', 'slot_head')!;
    const afterHeadMats = computePartWorldMatrices(underHead, 310, 390);
    const armAfterHead = afterHeadMats.get('slot_r_arm')!;
    expect(armAfterHead[4]).toBeCloseTo(armBefore[4], 1);
    expect(armAfterHead[5]).toBeCloseTo(armBefore[5], 1);
  });

  it('moves pivot to shoulder while keeping BOTH the arm sprite AND attached child hand visually pinned, then rotates around the new pivot', () => {
    const parts = makeSampleParts();
    const dims = { w: 60, h: 140 };
    const matsBefore = computePartWorldMatrices(parts, 310, 390);
    const armQuadBefore = computePartCanvasQuad(
      parts.find((p) => p.slot_id === 'slot_r_arm')!,
      matsBefore.get('slot_r_arm')!,
      dims.w,
      dims.h,
    );
    const handWorldBefore = applyMat(matsBefore.get('slot_r_hand')!, 0, 0);

    // Shift Right Arm pivot from center (0.5, 0.5) to shoulder (0.5, 0.12)
    const shifted = movePartPivotPreservingVisualPosition(
      parts,
      'slot_r_arm',
      0.5,
      0.12,
      dims.w,
      dims.h,
    );
    const matsAfter = computePartWorldMatrices(shifted, 310, 390);
    const armSlotAfter = shifted.find((p) => p.slot_id === 'slot_r_arm')!;
    const armQuadAfter = computePartCanvasQuad(
      armSlotAfter,
      matsAfter.get('slot_r_arm')!,
      dims.w,
      dims.h,
    );
    const handWorldAfter = applyMat(matsAfter.get('slot_r_hand')!, 0, 0);

    // Every corner of the arm sprite remained pinned at the exact same pixel!
    for (let i = 0; i < 4; i++) {
      expect(armQuadAfter.corners[i].x).toBeCloseTo(armQuadBefore.corners[i].x, 1);
      expect(armQuadAfter.corners[i].y).toBeCloseTo(armQuadBefore.corners[i].y, 1);
    }
    // Attached child hand ALSO remained pinned at the exact same pixel!
    expect(handWorldAfter.x).toBeCloseTo(handWorldBefore.x, 1);
    expect(handWorldAfter.y).toBeCloseTo(handWorldBefore.y, 1);
    // Yet the pivot itself moved upward toward the shoulder!
    expect(armQuadAfter.pivot.y).toBeLessThan(armQuadBefore.pivot.y - 30);

    // Verify rotating the arm by +45 deg keeps the shoulder pivot fixed while swinging the hand!
    const rotated = shifted.map((p) =>
      p.slot_id === 'slot_r_arm'
        ? { ...p, default_transform: { ...p.default_transform, rotation_deg: p.default_transform.rotation_deg + 45 } }
        : p,
    );
    const matsRot = computePartWorldMatrices(rotated, 310, 390);
    expect(matsRot.get('slot_r_arm')![4]).toBeCloseTo(armQuadAfter.pivot.x, 1);
    expect(matsRot.get('slot_r_arm')![5]).toBeCloseTo(armQuadAfter.pivot.y, 1);
    const handRot = applyMat(matsRot.get('slot_r_hand')!, 0, 0);
    expect(Math.hypot(handRot.x - handWorldAfter.x, handRot.y - handWorldAfter.y)).toBeGreaterThan(20);

    // Verify canvasPointToPartAnchor inverse roundtrip
    const roundtrip = canvasPointToPartAnchor(
      armSlotAfter,
      matsAfter.get('slot_r_arm')!,
      armQuadAfter.pivot.x,
      armQuadAfter.pivot.y,
      dims.w,
      dims.h,
    );
    expect(roundtrip.anchor_x).toBeCloseTo(0.5, 2);
    expect(roundtrip.anchor_y).toBeCloseTo(0.12, 2);
  });

  it('builds hierarchy tree with collapse, groups/ungroups preserving world positions, and hit-tests front-to-back', () => {
    const parts = makeSampleParts();
    const tree = buildHierarchyTree(parts);
    expect(tree.map((n) => [n.part.slot_id, n.depth])).toEqual([
      ['slot_body', 0],
      ['slot_r_arm', 1],
      ['slot_r_hand', 2],
      ['slot_head', 1],
    ]);

    const collapsed = buildHierarchyTree(parts, new Set(['slot_r_arm']));
    expect(collapsed.some((n) => n.part.slot_id === 'slot_r_hand')).toBe(false);

    // Group & Ungroup preserves exact world position
    const matsBefore = computePartWorldMatrices(parts, 0, 0);
    const grouped = groupPartsUnderNewGroup(parts, ['slot_head'], 'Head Group', () => 'slot_grp_1')!;
    expect(grouped.parts.find((p) => p.slot_id === 'slot_head')?.parent_slot_id).toBe('slot_grp_1');
    const matsGrouped = computePartWorldMatrices(grouped.parts, 0, 0);
    expect(matsGrouped.get('slot_head')![4]).toBeCloseTo(matsBefore.get('slot_head')![4], 1);
    expect(matsGrouped.get('slot_head')![5]).toBeCloseTo(matsBefore.get('slot_head')![5], 1);

    const ungrouped = ungroupPart(grouped.parts, 'slot_grp_1')!;
    expect(ungrouped.some((p) => p.slot_id === 'slot_grp_1')).toBe(false);
    expect(ungrouped.find((p) => p.slot_id === 'slot_head')?.parent_slot_id).toBe('slot_body');

    // Hit testing respects z_index and visibility
    const worldMats = computePartWorldMatrices(parts, 310, 390);
    const dimsMap = new Map([
      ['ast_body', { width: 160, height: 220 }],
      ['ast_head', { width: 130, height: 130 }],
      ['ast_r_arm', { width: 60, height: 140 }],
      ['ast_r_hand', { width: 44, height: 44 }],
    ]);
    const handPt = applyMat(worldMats.get('slot_r_hand')!, 0, 0);
    const hit = hitTestCharacterParts(parts, worldMats, dimsMap, handPt.x, handPt.y);
    expect(hit?.slot_id).toBe('slot_r_hand');
  });

  it('truthfully reports Rig Preview capabilities and evaluates real non-mutating preview actions', () => {
    const partialChar: Character = {
      character_id: 'char_1',
      name: 'Minh',
      description: '',
      tags: [],
      identity_confirmed: true,
      thumbnail_asset_id: null,
      voice_profile_id: null,
      parts: makeSampleParts(), // Body + Head + Right Arm + Right Hand (NO Eyes variants, NO Legs)
      expressions: [],
      poses: [],
      version: 1,
      created_at: '',
      updated_at: '',
    };

    const analysis1 = analyzeCharacterRig(partialChar);
    expect(analysis1.rigStatus).toBe('ready');
    expect(analysis1.thumbnailAssetId).toBe('ast_head');
    expect(analysis1.actions.idle.supported).toBe(true);
    expect(analysis1.actions.wave.supported).toBe(true);
    expect(analysis1.actions.head_turn.supported).toBe(true);
    expect(analysis1.actions.bounce.supported).toBe(true);
    // Truthfully unavailable without legs or eye variants!
    expect(analysis1.actions.blink.supported).toBe(false);
    expect(analysis1.actions.walk.supported).toBe(false);
    expect(analysis1.actions.run.supported).toBe(false);

    // Wave preview rotates Right Arm & Right Hand without mutating original character
    const wavePose = evaluateRigPreviewPose(partialChar.parts, 'wave', 400);
    expect(Math.abs(wavePose.slotDeltaTransforms.slot_r_arm?.rotation_deg ?? 0)).toBeGreaterThan(80);
    const previewChar = applyRigPreviewPoseToCharacter(partialChar, wavePose);
    expect(previewChar.parts.find((p) => p.slot_id === 'slot_r_arm')!.default_transform.rotation_deg)
      .not.toBe(partialChar.parts.find((p) => p.slot_id === 'slot_r_arm')!.default_transform.rotation_deg);

    // Add legs + eye variants -> Walk, Run, and Blink become truthfully supported!
    partialChar.parts.push(
      {
        slot_id: 'slot_l_leg',
        name: 'Left Leg',
        part_role: 'left_leg',
        parent_slot_id: 'slot_body',
        default_asset_id: 'ast_l_leg',
        variants: {},
        z_index: 8,
        anchor_x: 0.5,
        anchor_y: 0.1,
        default_transform: { x: -24, y: -12, rotation_deg: 0, scale_x: 1, scale_y: 1, opacity: 1 },
        visible: true,
        locked: false,
      },
      {
        slot_id: 'slot_r_leg',
        name: 'Right Leg',
        part_role: 'right_leg',
        parent_slot_id: 'slot_body',
        default_asset_id: 'ast_r_leg',
        variants: {},
        z_index: 9,
        anchor_x: 0.5,
        anchor_y: 0.1,
        default_transform: { x: 24, y: -12, rotation_deg: 0, scale_x: 1, scale_y: 1, opacity: 1 },
        visible: true,
        locked: false,
      },
      {
        slot_id: 'slot_eyes',
        name: 'Eyes',
        part_role: 'eyes',
        parent_slot_id: 'slot_head',
        default_asset_id: 'ast_eye_open',
        variants: { open: 'ast_eye_open', closed: 'ast_eye_closed' },
        z_index: 26,
        anchor_x: 0.5,
        anchor_y: 0.5,
        default_transform: { x: 0, y: -40, rotation_deg: 0, scale_x: 1, scale_y: 1, opacity: 1 },
        visible: true,
        locked: false,
      },
    );

    const analysis2 = analyzeCharacterRig(partialChar);
    expect(analysis2.actions.blink.supported).toBe(true);
    expect(analysis2.actions.walk.supported).toBe(true);
    expect(analysis2.actions.run.supported).toBe(true);

    const walkPose = evaluateRigPreviewPose(partialChar.parts, 'walk', 200);
    expect((walkPose.slotDeltaTransforms.slot_l_leg?.rotation_deg ?? 0) * (walkPose.slotDeltaTransforms.slot_r_leg?.rotation_deg ?? 0)).toBeLessThan(0);
    const blinkClosed = evaluateRigPreviewPose(partialChar.parts, 'blink', 1950);
    expect(blinkClosed.eyeStateOverride).toBe('closed');
  });
});
