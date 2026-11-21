"""Normalized Character Staging, Anti-Overlap Placement & Layer Arrangement (Phase 07 Batch 1)."""

from __future__ import annotations

import hashlib
from typing import Literal

from schemas.asset import Asset
from schemas.character import Character
from schemas.common import CameraState, Transform2D
from schemas.production import ProductionShotPlan
from schemas.scene_execution import (
    LayerPreviewEntry,
    StagedCharacterPlacement,
    StagedObjectPlacement,
)

# Normalized X anchors inside the visible viewport (0.0 .. 1.0), except explicit offscreen
NORMALIZED_ANCHOR_X: dict[str, float] = {
    "far_left": 0.14,
    "left": 0.27,
    "center_left": 0.39,
    "center": 0.50,
    "center_right": 0.61,
    "right": 0.73,
    "far_right": 0.86,
    "offscreen": -0.15,
}

# Depth layer configuration: (normalized_y, scale_magnitude, base_z_index)
DEPTH_LAYER_SPEC: dict[str, tuple[float, float, int]] = {
    "background": (0.52, 0.82, 8),
    "midground": (0.59, 1.00, 14),
    "foreground": (0.66, 1.14, 22),
}

VALID_FACING = {"left", "right", "front", "back", "three_quarter_left", "three_quarter_right"}


def stable_id(prefix: str, *parts: str) -> str:
    """Deterministic stable identifier derived from semantic references (never random or index-based)."""
    raw = "::".join(str(p or "") for p in parts)
    digest = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:12]
    return f"{prefix}_{digest}"


def _norm(text: str) -> str:
    return (text or "").strip().lower()


def _resolve_pose(character: Character | None, pose_id: str | None, pose_hint: str) -> tuple[str | None, str]:
    if not character:
        return None, ""
    if pose_id:
        found = next((p for p in character.poses if p.pose_id == pose_id), None)
        if found:
            return found.pose_id, found.name
    hint = _norm(pose_hint)
    if hint:
        for p in character.poses:
            pn = _norm(p.name)
            if pn == hint or hint in pn or pn in hint:
                return p.pose_id, p.name
    return None, ""


def _resolve_expression(
    character: Character | None, expression_id: str | None, expr_hint: str
) -> tuple[str | None, str]:
    if not character:
        return None, ""
    if expression_id:
        found = next((e for e in character.expressions if e.expression_id == expression_id), None)
        if found:
            return found.expression_id, found.name
    hint = _norm(expr_hint)
    if hint:
        for e in character.expressions:
            en = _norm(e.name)
            if en == hint or hint in en or en in hint:
                return e.expression_id, e.name
    return None, ""


def compute_shot_character_staging(
    shot: ProductionShotPlan,
    target_stage_scene_id: str,
    stage_width: int,
    stage_height: int,
    characters_by_id: dict[str, Character],
) -> tuple[list[StagedCharacterPlacement], list[str]]:
    """Compute normalized aspect-ratio-aware, anti-overlap character placement for a shot."""
    w = max(320, int(stage_width))
    h = max(240, int(stage_height))
    aspect_scale = min(1.15, max(0.75, h / 1080.0))
    margin_x_norm = max(0.10, min(0.16, 130.0 / w))
    min_sep_norm = max(0.16, min(0.24, 240.0 / w))

    fallbacks: list[str] = []
    placements: list[StagedCharacterPlacement] = []

    # 1. Initial normalized anchor resolution + fallback reporting
    for idx, ch in enumerate(shot.characters):
        lib_char = characters_by_id.get(ch.library_character_id) if ch.library_character_id else None
        resolved = lib_char is not None
        inst_key = lib_char.character_id if lib_char else ch.staging_id
        stable_inst = stable_id("exec_char", target_stage_scene_id, inst_key)

        fb_reasons: list[str] = []
        pos_key = ch.screen_position if ch.screen_position in NORMALIZED_ANCHOR_X else ""
        if not pos_key:
            pos_key = "center"
            fb_reasons.append(f"Invalid screen_position '{ch.screen_position}' -> fell back to 'center'.")

        depth_key = ch.depth_layer if ch.depth_layer in DEPTH_LAYER_SPEC else ""
        if not depth_key:
            depth_key = "midground"
            fb_reasons.append(f"Invalid depth_layer '{ch.depth_layer}' -> fell back to 'midground'.")

        norm_x = NORMALIZED_ANCHOR_X[pos_key]
        norm_y, depth_scale, z_base = DEPTH_LAYER_SPEC[depth_key]

        facing = ch.facing_direction if ch.facing_direction in VALID_FACING else ""
        if not facing:
            # Safe dialogue-aware facing fallback: characters on left face right, on right face left
            facing = "right" if norm_x < 0.48 else "left" if norm_x > 0.52 else "front"
            fb_reasons.append(f"Missing/invalid facing_direction -> inferred '{facing}'.")

        pose_id, pose_name = _resolve_pose(lib_char, ch.initial_pose_id, ch.initial_pose)
        expr_id, expr_name = _resolve_expression(lib_char, ch.expression_id, ch.expression)

        placements.append(
            StagedCharacterPlacement(
                staging_id=ch.staging_id,
                stable_instance_id=stable_inst,
                character_name=lib_char.name if lib_char else ch.character_name,
                library_character_id=lib_char.character_id if lib_char else None,
                resolved=resolved,
                screen_position=pos_key,
                depth_layer=depth_key,
                facing_direction=facing,
                normalized_x=norm_x,
                normalized_y=norm_y,
                transform=Transform2D(),
                z_index=z_base + idx,
                visible=bool(ch.visible and pos_key != "offscreen"),
                pose_id=pose_id,
                pose_name=pose_name,
                expression_id=expr_id,
                expression_name=expr_name,
                fallback_used=bool(fb_reasons),
                fallback_reason=" ".join(fb_reasons),
            )
        )
        for reason in fb_reasons:
            fallbacks.append(f"{ch.character_name}: {reason}")

    # 2. Multi-character anti-overlap distribution (preserves left-to-right order & visible bounds)
    visible_indices = [
        i for i, p in enumerate(placements) if p.screen_position != "offscreen" and p.visible
    ]
    if len(visible_indices) >= 2:
        # Sort stably by desired normalized_x (tie-break by original order)
        ordered = sorted(visible_indices, key=lambda i: (placements[i].normalized_x, i))
        xs = [placements[i].normalized_x for i in ordered]
        adjusted = False

        # Forward relaxation to enforce minimum horizontal separation
        for k in range(1, len(xs)):
            if xs[k] - xs[k - 1] < min_sep_norm:
                mid = (xs[k] + xs[k - 1]) / 2.0
                xs[k - 1] = mid - min_sep_norm / 2.0
                xs[k] = mid + min_sep_norm / 2.0
                adjusted = True

        # Second pass forward & backward clamp into visible safe canvas [margin_x_norm, 1 - margin_x_norm]
        lo = margin_x_norm
        hi = 1.0 - margin_x_norm
        for k in range(len(xs)):
            if xs[k] < lo:
                xs[k] = lo
                adjusted = True
            if k > 0 and xs[k] < xs[k - 1] + min_sep_norm:
                xs[k] = xs[k - 1] + min_sep_norm
                adjusted = True
        if xs[-1] > hi:
            shift = xs[-1] - hi
            xs = [max(lo, x - shift) for x in xs]
            # If still crowded for many characters, distribute evenly across [lo, hi]
            if len(xs) > 1 and xs[-1] > hi:
                step = (hi - lo) / (len(xs) - 1)
                xs = [lo + step * idx for idx in range(len(xs))]
            adjusted = True

        if adjusted:
            for idx_pos, char_idx in enumerate(ordered):
                old_x = placements[char_idx].normalized_x
                new_x = round(xs[idx_pos], 4)
                if abs(new_x - old_x) > 0.005:
                    placements[char_idx].normalized_x = new_x
                    msg = f"Adjusted X anchor ({old_x:.2f} -> {new_x:.2f}) to prevent character overlap."
                    placements[char_idx].fallback_used = True
                    placements[char_idx].fallback_reason = (
                        f"{placements[char_idx].fallback_reason} {msg}".strip()
                    )
                    fallbacks.append(f"{placements[char_idx].character_name}: {msg}")

        # Dialogue relationship facing sanity check: if 2 visible characters face identically
        # away from each other when one is speaking, gently face them toward each other only if facing wasn't explicit
        if len(ordered) == 2:
            left_p = placements[ordered[0]]
            right_p = placements[ordered[1]]
            if left_p.facing_direction == "front" and right_p.facing_direction == "front":
                left_p.facing_direction = "three_quarter_right"
                right_p.facing_direction = "three_quarter_left"

    # 3. Convert normalized positions -> actual stage coordinates respecting aspect ratio & safe clamping
    for p in placements:
        _, depth_scale, _ = DEPTH_LAYER_SPEC.get(p.depth_layer, DEPTH_LAYER_SPEC["midground"])
        scale_mag = round(depth_scale * aspect_scale, 3)
        facing_sign = -1.0 if p.facing_direction in ("left", "three_quarter_left") else 1.0

        if p.screen_position == "offscreen":
            px = round(-0.12 * w, 1)
            py = round(p.normalized_y * h, 1)
        else:
            clamped_nx = max(margin_x_norm, min(1.0 - margin_x_norm, p.normalized_x))
            clamped_ny = max(0.20, min(0.84, p.normalized_y))
            px = round(clamped_nx * w, 1)
            py = round(clamped_ny * h, 1)

        p.transform = Transform2D(
            x=px,
            y=py,
            rotation_deg=0.0,
            scale_x=round(scale_mag * facing_sign, 3),
            scale_y=scale_mag,
            opacity=1.0 if p.visible else 0.0,
        )

    return placements, fallbacks


def _classify_prop_role(label: str, kind: str) -> Literal["environment", "prop", "foreground"]:
    low = _norm(f"{label} {kind}")
    if any(k in low for k in ("foreground", "tiền cảnh", "frame", "awning", "mái hiên", "railing", "lan can", "smoke", "rain overlay")):
        return "foreground"
    if any(k in low for k in ("environment", "môi trường", "wall", "sky", "tree", "cây", "lamp", "đèn", "neon", "street", "building")):
        return "environment"
    return "prop"


def compute_shot_object_staging(
    shot: ProductionShotPlan,
    target_stage_scene_id: str,
    stage_width: int,
    stage_height: int,
    assets_by_id: dict[str, Asset],
) -> tuple[StagedObjectPlacement | None, list[StagedObjectPlacement]]:
    """Resolve background, environment, prop, and foreground objects strictly by real asset_id."""
    w = max(320, int(stage_width))
    h = max(240, int(stage_height))

    bg_preview: StagedObjectPlacement | None = None
    if shot.background is not None:
        bg_asset = (
            assets_by_id.get(shot.background.matched_asset_id)
            if shot.background.matched_asset_id
            else None
        )
        bg_preview = StagedObjectPlacement(
            requirement_id=shot.background.requirement_id,
            stable_prop_instance_id=stable_id("exec_bg", target_stage_scene_id, shot.background.requirement_id),
            name=shot.background.label or (bg_asset.name if bg_asset else "Scene Background"),
            role="background",
            asset_id=bg_asset.asset_id if bg_asset else None,
            asset_name=bg_asset.name if bg_asset else "",
            resolved=bg_asset is not None,
            transform=Transform2D(x=round(w / 2.0, 1), y=round(h / 2.0, 1)),
            z_index=-10000,
            visible=True,
            notes=shot.background.notes,
        )

    objects: list[StagedObjectPlacement] = []
    # Spread props cleanly across lower/mid thirds avoiding center character crowding
    prop_x_slots = [0.22, 0.78, 0.35, 0.65, 0.50, 0.16, 0.84]
    for idx, item in enumerate(shot.assets):
        asset = assets_by_id.get(item.matched_asset_id) if item.matched_asset_id else None
        role = _classify_prop_role(item.label, item.kind)
        if role == "environment":
            z_idx = 4 + (idx % 4)
            ny = 0.46
        elif role == "foreground":
            z_idx = 28 + (idx % 6)
            ny = 0.74
        else:
            z_idx = 12 + (idx % 4)
            ny = 0.68

        nx = prop_x_slots[idx % len(prop_x_slots)]
        # Scale large prop assets sensibly so they never dominate the full canvas
        scale = 1.0
        if asset and asset.width > 0 and asset.height > 0:
            max_prop_w = w * 0.28
            max_prop_h = h * 0.35
            fit = min(max_prop_w / asset.width, max_prop_h / asset.height, 1.0)
            scale = round(max(0.25, fit), 3)

        stable_prop_key = asset.asset_id if asset else item.requirement_id
        objects.append(
            StagedObjectPlacement(
                requirement_id=item.requirement_id,
                stable_prop_instance_id=stable_id("exec_prop", target_stage_scene_id, role, stable_prop_key),
                name=asset.name if asset else item.label,
                role=role,
                asset_id=asset.asset_id if asset else None,
                asset_name=asset.name if asset else "",
                resolved=asset is not None,
                transform=Transform2D(
                    x=round(nx * w, 1),
                    y=round(ny * h, 1),
                    rotation_deg=0.0,
                    scale_x=scale,
                    scale_y=scale,
                    opacity=1.0,
                ),
                z_index=z_idx,
                visible=True,
                notes=item.notes,
            )
        )

    return bg_preview, objects


def build_front_to_back_layer_preview(
    bg: StagedObjectPlacement | None,
    characters: list[StagedCharacterPlacement],
    objects: list[StagedObjectPlacement],
) -> list[LayerPreviewEntry]:
    """Build exact front-to-back (descending z_index) layer stack matching layerSync.ts."""
    entries: list[LayerPreviewEntry] = []
    for ch in characters:
        entries.append(
            LayerPreviewEntry(
                layer_id=ch.stable_instance_id,
                name=ch.character_name,
                kind="character",
                z_index=ch.z_index,
                resolved=ch.resolved,
            )
        )
    for obj in objects:
        entries.append(
            LayerPreviewEntry(
                layer_id=obj.stable_prop_instance_id,
                name=obj.name,
                kind=obj.role if obj.role != "background" else "prop",
                z_index=obj.z_index,
                resolved=obj.resolved,
            )
        )
    entries.sort(key=lambda e: (-e.z_index, e.layer_id))
    if bg is not None:
        entries.append(
            LayerPreviewEntry(
                layer_id=bg.stable_prop_instance_id,
                name=bg.name,
                kind="background",
                z_index=-10000,
                resolved=bg.resolved,
            )
        )
    return entries


def extract_shot_camera_default(shot: ProductionShotPlan) -> CameraState:
    cp = shot.camera_plan.camera_plan
    zoom = cp.start_zoom if cp.start_zoom and cp.start_zoom > 0.05 else 1.0
    return CameraState(
        x=float(cp.start_x),
        y=float(cp.start_y),
        zoom=float(zoom),
        rotation_deg=float(cp.start_rotation_deg),
    )
