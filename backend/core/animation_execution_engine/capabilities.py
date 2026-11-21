"""Phase 07 Batch 2 — Character Rig Capability Inspection & Compatibility Registry."""

from __future__ import annotations

from schemas.animation_execution import (
    CharacterRigCapabilities,
    MotionCompatibilityResult,
    MotionPreset,
    MotionSupportLevel,
    RigCapability,
    RigType,
)
from schemas.character import Character
from schemas.production import AnimationActionCategory


def inspect_character_capabilities(character: Character | None) -> CharacterRigCapabilities:
    """Inspect a real Character Library rig and expose ONLY truly supported capabilities."""
    if character is None:
        return CharacterRigCapabilities(
            character_id="",
            character_name="(Unlinked)",
            rig_type="empty",
            part_count=0,
            capabilities=[],
            limitations=["Character is not linked to a real Character Library rig."],
        )

    parts = character.parts or []
    if len(parts) == 0:
        return CharacterRigCapabilities(
            character_id=character.character_id,
            character_name=character.name,
            rig_type="empty",
            part_count=0,
            capabilities=[],
            limitations=[
                f"Character '{character.name}' has 0 assembled PNG rig parts; animate after assembling parts in Cutout Rig Editor."
            ],
        )

    roles_present = [p.part_role for p in parts]
    role_set = set(roles_present)
    slots_by_role: dict[str, str] = {}
    for p in parts:
        # Keep first visible slot per role as primary animation target
        if p.part_role not in slots_by_role and p.visible:
            slots_by_role[p.part_role] = p.slot_id
    for p in parts:
        if p.part_role not in slots_by_role:
            slots_by_role[p.part_role] = p.slot_id

    caps: list[RigCapability] = [
        "root_movement",
        "scale_animation",
        "opacity_animation",
    ]
    limitations: list[str] = []

    if "body" in role_set or len(parts) >= 1:
        caps.append("body_rotation")

    has_head = "head" in role_set
    if has_head:
        caps.append("head_rotation")
    else:
        limitations.append("No `head` part slot: independent head rotation/turn is unavailable.")

    has_arms = bool({"left_arm", "right_arm"} & role_set)
    if has_arms:
        caps.append("arm_rotation")
    else:
        limitations.append("No `left_arm`/`right_arm` part slots: arm wave and arm swing are unavailable.")

    has_legs = bool({"left_leg", "right_leg"} & role_set)
    if has_legs:
        caps.append("leg_rotation")
    else:
        limitations.append("No `left_leg`/`right_leg` part slots: leg stride rotation and full run sprint are unavailable.")

    has_hands = bool({"left_hand", "right_hand"} & role_set)
    if has_hands:
        caps.append("hand_rotation")

    eyes_slot = next((p for p in parts if p.part_role == "eyes"), None)
    eye_variants = sorted(eyes_slot.variants.keys()) if eyes_slot else []
    if eyes_slot and ("closed" in eyes_slot.variants or len(eyes_slot.variants) >= 2):
        caps.append("eye_state")
    else:
        limitations.append("No `eyes` slot with `closed` variant PNG: blink animation is unavailable.")

    mouth_slot = next((p for p in parts if p.part_role == "mouth"), None)
    mouth_variants = sorted(mouth_slot.variants.keys()) if mouth_slot else []
    if mouth_slot and ("open" in mouth_slot.variants or len(mouth_slot.variants) >= 2):
        caps.append("mouth_state")
    else:
        limitations.append(
            "No `mouth` slot with `open`/`closed` variant PNGs: visible mouth-flap talk animation is unavailable."
        )

    # Classify rig type honestly based on present cutout hierarchy
    if has_legs and has_arms and has_head:
        rig_type: RigType = "full_cutout"
    elif has_arms or has_head:
        rig_type = "upper_body"
    else:
        rig_type = "simple_cutout"

    return CharacterRigCapabilities(
        character_id=character.character_id,
        character_name=character.name,
        rig_type=rig_type,
        part_count=len(parts),
        capabilities=caps,
        available_part_roles=sorted(role_set),
        part_slots_by_role=slots_by_role,
        eye_variants=eye_variants,
        mouth_variants=mouth_variants,
        pose_ids=[p.pose_id for p in character.poses],
        pose_names={p.pose_id: p.name for p in character.poses},
        expression_ids=[e.expression_id for e in character.expressions],
        limitations=limitations,
    )


def check_preset_compatibility(
    preset: MotionPreset,
    caps: CharacterRigCapabilities,
) -> MotionCompatibilityResult:
    """Evaluate exact compatibility between a MotionPreset and a real Character's rig."""
    cap_set = set(caps.capabilities)
    missing_required = [c for c in preset.required_capabilities if c not in cap_set]
    avail_optional = [c for c in preset.optional_capabilities if c in cap_set]
    missing_optional = [c for c in preset.optional_capabilities if c not in cap_set]

    warnings: list[str] = []
    limitations = list(preset.limitations)

    if caps.rig_type == "empty":
        return MotionCompatibilityResult(
            preset_id=preset.preset_id,
            preset_name=preset.name,
            character_id=caps.character_id,
            character_name=caps.character_name,
            compatible=False,
            support_level="unsupported",
            missing_capabilities=missing_required or ["root_movement"],
            available_optional_capabilities=[],
            warnings=[f"Character '{caps.character_name}' has no assembled rig parts."],
            limitations=limitations,
        )

    if missing_required:
        return MotionCompatibilityResult(
            preset_id=preset.preset_id,
            preset_name=preset.name,
            character_id=caps.character_id,
            character_name=caps.character_name,
            compatible=False,
            support_level="unsupported",
            missing_capabilities=missing_required,
            available_optional_capabilities=avail_optional,
            warnings=[
                f"Preset '{preset.name}' requires missing rig capabilities: {', '.join(missing_required)}."
            ],
            limitations=limitations,
        )

    # Walk without legs works partially (root bounce + translation only), so report honestly!
    support_level: MotionSupportLevel = "full"
    if preset.category == "walk" and "leg_rotation" not in cap_set:
        support_level = "partial"
        warnings.append(
            "Rig lacks `left_leg`/`right_leg` parts: Walk will animate root translation and bounce without leg rotation."
        )
    elif missing_optional and preset.category in ("walk", "run", "jump", "fall", "wave"):
        # Minor optional limb omission (e.g. missing hands on wave or arms on jump)
        if preset.category == "walk" and "arm_rotation" not in cap_set:
            support_level = "partial"
            warnings.append("Rig lacks arm parts: Walk will omit counter-phase arm swing.")
        elif preset.category == "run" and "arm_rotation" not in cap_set:
            support_level = "partial"
            warnings.append("Rig lacks arm parts: Run will omit arm swing.")

    return MotionCompatibilityResult(
        preset_id=preset.preset_id,
        preset_name=preset.name,
        character_id=caps.character_id,
        character_name=caps.character_name,
        compatible=True,
        support_level=support_level,
        missing_capabilities=[],
        available_optional_capabilities=avail_optional,
        warnings=warnings,
        limitations=limitations,
    )


_CATEGORY_TO_BUILTIN_PRESET: dict[AnimationActionCategory, str] = {
    "idle": "motion_idle_breathe",
    "stand": "motion_idle_breathe",
    "walk": "motion_walk_cycle",
    "run": "motion_run_cycle",
    "blink": "motion_blink",
    "wave": "motion_wave",
    "look": "motion_head_turn",
    "turn": "motion_turn_flip",
    "talk": "motion_talk",
    "jump": "motion_jump",
    "fall": "motion_fall",
    "react": "motion_react",
}


def resolve_action_to_preset(
    category: AnimationActionCategory,
    presets_by_id: dict[str, MotionPreset],
    all_presets: list[MotionPreset],
    preferred_preset_id: str | None = None,
    character: Character | None = None,
) -> tuple[MotionPreset | None, str, str]:
    """Map an AI action category to a real MotionPreset or return an honest unsupported reason.

    Returns `(preset_or_none, unsupported_reason, manual_alternative)`.
    """
    if preferred_preset_id and preferred_preset_id in presets_by_id:
        return presets_by_id[preferred_preset_id], "", ""

    if category == "sit":
        # Sit is supported only if a custom sit preset exists or the character defines a Sit pose
        custom_sit = next((p for p in all_presets if p.category == "sit"), None)
        if custom_sit:
            return custom_sit, "", ""
        if character and any(
            "sit" in p.name.lower() or "ngồi" in p.name.lower() for p in character.poses
        ):
            return presets_by_id.get("motion_idle_breathe"), "", ""
        return (
            None,
            "No sitting Pose Preset or Sit Motion Preset exists for this character rig.",
            "Create a 'Sit' pose in Cutout Rig Editor or save a custom Sit motion preset.",
        )

    if category == "attack":
        custom_atk = next((p for p in all_presets if p.category == "attack"), None)
        if custom_atk:
            return custom_atk, "", ""
        return (
            None,
            "Combat/attack choreography is not natively automated for 2D cutout rigs.",
            "Create custom attack pose presets in Cutout Rig Editor and keyframe impact beats manually.",
        )

    if category == "custom":
        return (
            None,
            "Custom action cannot be mapped automatically without a matching saved Motion Preset.",
            "Keyframe custom motion manually on the Timeline or save a reusable preset in Motion Library.",
        )

    builtin_id = _CATEGORY_TO_BUILTIN_PRESET.get(category)
    if builtin_id and builtin_id in presets_by_id:
        return presets_by_id[builtin_id], "", ""

    match = next((p for p in all_presets if p.category == category), None)
    if match:
        return match, "", ""

    return (
        None,
        f"No compatible motion preset available for action '{category}'.",
        "Keyframe manually on the Master Timeline.",
    )
