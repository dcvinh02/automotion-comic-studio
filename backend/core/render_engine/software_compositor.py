"""Deterministic software 2D Cutout Compositor (Pillow).

Mirrors the TypeScript FrameEvaluator math 1:1. Used for:
1. Headless render tests (pytest) without requiring a GUI display.
2. Automatic fallback when running backend standalone without Electron offscreen WebGL worker.
"""

from __future__ import annotations

import hashlib
import math
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

from core.asset_engine.service import AssetService
from database.library_repo import LibraryRepository
from schemas.character import Character, CharacterPartSlot
from schemas.common import CameraState, Transform2D
from schemas.project import ProjectState
from schemas.scene import Scene
from schemas.subtitle import SubtitleStyle, default_subtitle_styles, resolve_effective_subtitle_style
from schemas.timeline import CharacterAnimationClip, EasingType, Keyframe

_FONT_CANDIDATES_BOLD = (
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/Library/Fonts/Arial Unicode.ttf",
    "/System/Library/Fonts/HelveticaNeue.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
)

_FONT_CANDIDATES_BOLD_ITALIC = (
    "/System/Library/Fonts/Supplemental/Arial Bold Italic.ttf",
    "/System/Library/Fonts/Supplemental/Georgia Bold Italic.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-BoldOblique.ttf",
    "C:/Windows/Fonts/arialbi.ttf",
    *_FONT_CANDIDATES_BOLD,
)

_FONT_CANDIDATES_REGULAR = (
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/Library/Fonts/Arial Unicode.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/HelveticaNeue.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "C:/Windows/Fonts/arial.ttf",
)

_FONT_CANDIDATES_ITALIC = (
    "/System/Library/Fonts/Supplemental/Arial Italic.ttf",
    "/System/Library/Fonts/Supplemental/Georgia Italic.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf",
    "C:/Windows/Fonts/ariali.ttf",
    *_FONT_CANDIDATES_REGULAR,
)


def _apply_easing(t: float, easing: EasingType, bezier: tuple[float, float, float, float] | None = None) -> float:
    t = max(0.0, min(1.0, t))
    if easing in ("step", "hold"):
        return 0.0 if t < 1.0 else 1.0
    if easing == "linear":
        return t
    if easing == "ease_in":
        return t * t * t
    if easing == "ease_out":
        inv = 1.0 - t
        return 1.0 - inv * inv * inv
    if easing == "ease_in_out":
        return 4 * t * t * t if t < 0.5 else 1 - pow(-2 * t + 2, 3) / 2
    if easing == "cubic_bezier" and bezier:
        _, y1, _, y2 = bezier
        u = 1.0 - t
        return 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t
    return t


def _dedup_sorted_keyframes(keyframes: list[Keyframe]) -> list[Keyframe]:
    if len(keyframes) <= 1:
        return keyframes
    by_time: dict[int, Keyframe] = {}
    for kf in keyframes:
        by_time[int(round(kf.time_ms))] = kf
    return sorted(by_time.values(), key=lambda k: k.time_ms)


def _eval_numeric_keyframes(
    keyframes: list[Keyframe],
    time_ms: float,
    default_val: float,
) -> float:
    if not keyframes:
        return default_val
    sorted_kfs = _dedup_sorted_keyframes(keyframes)
    if time_ms <= sorted_kfs[0].time_ms:
        return float(sorted_kfs[0].value)
    if time_ms >= sorted_kfs[-1].time_ms:
        return float(sorted_kfs[-1].value)

    for i in range(len(sorted_kfs) - 1):
        k0 = sorted_kfs[i]
        k1 = sorted_kfs[i + 1]
        if k0.time_ms <= time_ms <= k1.time_ms:
            if k0.easing in ("step", "hold") or k1.time_ms == k0.time_ms:
                return float(k1.value) if time_ms >= k1.time_ms else float(k0.value)
            ratio = (time_ms - k0.time_ms) / float(k1.time_ms - k0.time_ms)
            eased = _apply_easing(ratio, k0.easing, k0.bezier_handles)
            return float(k0.value) + (float(k1.value) - float(k0.value)) * eased
    return default_val


def _eval_string_keyframes(
    keyframes: list[Keyframe],
    time_ms: float,
    default_val: str | None,
) -> str | None:
    if not keyframes:
        return default_val
    sorted_kfs = _dedup_sorted_keyframes(keyframes)
    result = default_val
    for kf in sorted_kfs:
        if kf.time_ms <= time_ms:
            result = str(kf.value)
        else:
            break
    return result


def _parse_hex_color(hex_color: str) -> tuple[int, int, int, int]:
    cleaned = hex_color.lstrip("#")
    if len(cleaned) == 6:
        try:
            r = int(cleaned[0:2], 16)
            g = int(cleaned[2:4], 16)
            b = int(cleaned[4:6], 16)
            return (r, g, b, 255)
        except ValueError:
            pass
    return (20, 22, 26, 255)


def _deterministic_seed_offset(identifier: str) -> int:
    """Exact port of evaluator.ts `deterministicSeedOffset` (FNV-1a over UTF-16 code units with
    JavaScript int32 semantics) so auto-blink timing matches the editor preview frame-for-frame."""

    def _i32(v: int) -> int:
        v &= 0xFFFFFFFF
        return v - 0x100000000 if v >= 0x80000000 else v

    h = _i32(2166136261)
    data = identifier.encode("utf-16-le")
    for i in range(0, len(data), 2):
        code = data[i] | (data[i + 1] << 8)
        h = _i32(h ^ code)
        h = _i32(h * 16777619)
    return abs(h) % 1700


def _compose_2d_matrix(
    x: float,
    y: float,
    rotation_deg: float,
    scale_x: float,
    scale_y: float,
) -> tuple[float, float, float, float, float, float]:
    """Return 2D affine matrix (a, b, c, d, tx, ty)."""
    rad = math.radians(rotation_deg)
    cos_r = math.cos(rad)
    sin_r = math.sin(rad)
    return (
        cos_r * scale_x,
        sin_r * scale_x,
        -sin_r * scale_y,
        cos_r * scale_y,
        x,
        y,
    )


def _mul_matrix(
    m1: tuple[float, float, float, float, float, float],
    m2: tuple[float, float, float, float, float, float],
) -> tuple[float, float, float, float, float, float]:
    a1, b1, c1, d1, tx1, ty1 = m1
    a2, b2, c2, d2, tx2, ty2 = m2
    return (
        a1 * a2 + c1 * b2,
        b1 * a2 + d1 * b2,
        a1 * c2 + c1 * d2,
        b1 * c2 + d1 * d2,
        a1 * tx2 + c1 * ty2 + tx1,
        b1 * tx2 + d1 * ty2 + ty1,
    )


class SoftwareCompositor:
    """Renders deterministic RGBA frames for a ProjectState using Pillow."""

    def __init__(
        self,
        library_repo: LibraryRepository,
        asset_service: AssetService,
        state: ProjectState,
        width: int,
        height: int,
        fps: int,
        burn_in_subtitles: bool = False,
        aspect_mode: str = "stretch",
    ) -> None:
        self.library_repo = library_repo
        self.asset_service = asset_service
        self.state = state
        self.fps = fps
        self.burn_in_subtitles = burn_in_subtitles
        # Output frame size vs. internal content size. When the output aspect differs from the
        # project stage, content is rendered at the stage aspect and letterboxed ("fit") or
        # center-cropped ("fill") instead of being non-uniformly stretched.
        self.out_width = width
        self.out_height = height
        content_w, content_h = width, height
        sw, sh = float(state.meta.width), float(state.meta.height)
        if aspect_mode in ("fit", "fill") and abs((width / float(height)) - (sw / sh)) > 0.01:
            s = min(width / sw, height / sh) if aspect_mode == "fit" else max(width / sw, height / sh)
            content_w = max(2, int(round(sw * s)))
            content_h = max(2, int(round(sh * s)))
        self.width = content_w
        self.height = content_h
        self._image_cache: dict[str, Image.Image] = {}
        self._character_cache: dict[str, Character] = {}
        self._font_cache: dict[tuple[bool, int], ImageFont.FreeTypeFont | ImageFont.ImageFont] = {}
        self._stage_scale_x = content_w / float(state.meta.width)
        self._stage_scale_y = content_h / float(state.meta.height)
        self._excluded_kf_ids: set[str] = set()

    def close(self) -> None:
        for img in self._image_cache.values():
            try:
                img.close()
            except Exception:
                pass
        self._image_cache.clear()
        self._character_cache.clear()

    def _get_image(self, asset_id: str | None) -> Image.Image | None:
        if not asset_id:
            return None
        if asset_id in self._image_cache:
            return self._image_cache[asset_id]
        asset = self.library_repo.get_asset(asset_id)
        if not asset:
            return None
        path = self.asset_service.resolve_asset_file(asset)
        if not path.is_file():
            return None
        img = Image.open(path).convert("RGBA")
        self._image_cache[asset_id] = img
        return img

    def _get_character(self, character_id: str) -> Character | None:
        if character_id not in self._character_cache:
            char = self.library_repo.get_character(character_id)
            if char:
                self._character_cache[character_id] = char
        return self._character_cache.get(character_id)

    def _find_active_scene(self, time_ms: float) -> Scene | None:
        scenes = sorted(self.state.scenes, key=lambda s: (s.start_ms, s.order_index))
        for scene in scenes:
            if scene.start_ms <= time_ms < scene.start_ms + scene.duration_ms:
                return scene
        return scenes[-1] if scenes else None

    def _kfs_for(self, target_type: str, target_id: str, prop: str) -> list[Keyframe]:
        return [
            k
            for k in self.state.timeline.keyframes
            if k.target_type == target_type
            and k.target_id == target_id
            and k.property == prop
            and k.keyframe_id not in self._excluded_kf_ids
        ]

    def _active_anim_clip(self, instance_id: str, time_ms: float) -> CharacterAnimationClip | None:
        for clip in self.state.timeline.animation_clips:
            if clip.instance_id == instance_id and clip.start_ms <= time_ms < clip.end_ms:
                return clip
        return None

    def _find_active_shot(self, scene: Scene, time_ms: float):
        if not scene.shots:
            return None
        local_ms = time_ms - scene.start_ms
        ordered = sorted(scene.shots, key=lambda s: (s.start_ms, s.shot_order))
        for sh in ordered:
            if sh.start_ms <= local_ms < sh.start_ms + sh.duration_ms:
                return sh
        if local_ms < ordered[0].start_ms:
            return ordered[0]
        return ordered[-1]

    def render_frame_rgba(self, frame_index: int) -> bytes:
        return self.render_time_rgba((frame_index * 1000.0) / float(self.fps))

    def render_time_rgba(self, time_ms: float) -> bytes:
        """Render the stage at an exact source-timeline time and return output-sized RGBA bytes."""
        content = self._render_content(time_ms)
        if (content.width, content.height) == (self.out_width, self.out_height):
            return content.tobytes()
        frame = Image.new("RGBA", (self.out_width, self.out_height), (0, 0, 0, 255))
        ox = (self.out_width - content.width) // 2
        oy = (self.out_height - content.height) // 2
        frame.paste(content, (ox, oy))
        return frame.tobytes()

    # ------------------------------------------------------------------
    # Phase 09.1: shared evaluation contract with frontend/src/engine/evaluator.ts
    # `evaluate_stage()` returns the same structure as `evaluateStageAtFrame()` (EvaluatedStage);
    # drawing consumes only this structure, so preview and final render are driven by the
    # same evaluated scene state (verified by tests/integration/test_phase09_1_preview_render_parity.py).
    # ------------------------------------------------------------------

    def evaluate_stage(self, time_ms: float) -> dict:
        scene = self._find_active_scene(time_ms)
        if not scene:
            return {
                "timeMs": time_ms, "scene_id": None, "shot_id": None,
                "effectiveBackgroundAssetId": None, "effectiveBackgroundColor": "#14161A",
                "fadeAlpha": 1.0, "camera": None, "props": [], "characters": [],
            }
        active_shot = self._find_active_shot(scene, time_ms)
        excluded_kfs: set[str] = set()
        if active_shot is not None:
            for sc_other in self.state.scenes:
                for sh_other in sc_other.shots:
                    if sh_other.shot_id == active_shot.shot_id:
                        continue
                    excluded_kfs.update(sh_other.animation_refs)
                    for mot in sh_other.applied_motions:
                        excluded_kfs.update(mot.keyframe_ids)
        self._excluded_kf_ids = excluded_kfs

        owned_char_ids = set(scene.execution_meta.owned_character_instance_ids) if scene.execution_meta else set()
        owned_prop_ids = set(scene.execution_meta.owned_prop_instance_ids) if scene.execution_meta else set()
        shot_char_map = {cs.instance_id: cs for cs in active_shot.character_states} if active_shot else {}
        shot_prop_map = {ps.prop_instance_id: ps for ps in active_shot.prop_states} if active_shot else {}

        bg_asset = active_shot.background_asset_id if active_shot and active_shot.background_asset_id else scene.background_asset_id
        bg_color = active_shot.background_color if active_shot and active_shot.background_color else scene.background_color

        cam_def = active_shot.camera_default if active_shot else scene.camera_default
        camera = {
            "x": _eval_numeric_keyframes(self._kfs_for("camera", "camera", "x"), time_ms, cam_def.x),
            "y": _eval_numeric_keyframes(self._kfs_for("camera", "camera", "y"), time_ms, cam_def.y),
            "zoom": max(0.1, _eval_numeric_keyframes(self._kfs_for("camera", "camera", "zoom"), time_ms, cam_def.zoom)),
            "rotation_deg": _eval_numeric_keyframes(self._kfs_for("camera", "camera", "rotation_deg"), time_ms, cam_def.rotation_deg),
        }

        fade = 1.0
        if scene.transition_in in ("fade", "cross_dissolve") and scene.transition_duration_ms > 0:
            elapsed = time_ms - scene.start_ms
            if 0.0 <= elapsed < scene.transition_duration_ms:
                fade = max(0.0, min(1.0, elapsed / float(scene.transition_duration_ms)))

        # Props: local values (shot state → keyframes), then parent-chain world transforms
        props_by_id = {p.prop_instance_id: p for p in scene.props}
        raw: dict[str, dict] = {}
        for p in scene.props:
            ps = shot_prop_map.get(p.prop_instance_id)
            tf = ps.transform if ps else p.transform
            pid = p.prop_instance_id
            raw[pid] = {
                "x": _eval_numeric_keyframes(self._kfs_for("prop", pid, "x"), time_ms, tf.x),
                "y": _eval_numeric_keyframes(self._kfs_for("prop", pid, "y"), time_ms, tf.y),
                "rotation_deg": _eval_numeric_keyframes(self._kfs_for("prop", pid, "rotation_deg"), time_ms, tf.rotation_deg),
                "scale_x": _eval_numeric_keyframes(self._kfs_for("prop", pid, "scale_x"), time_ms, tf.scale_x),
                "scale_y": _eval_numeric_keyframes(self._kfs_for("prop", pid, "scale_y"), time_ms, tf.scale_y),
                "opacity": _eval_numeric_keyframes(self._kfs_for("prop", pid, "opacity"), time_ms, tf.opacity),
            }
        world: dict[str, dict] = {}

        def resolve(pid: str, visited: set[str]) -> dict:
            if pid in world:
                return world[pid]
            local = raw[pid]
            prop = props_by_id[pid]
            if not prop.parent_id or prop.parent_id not in props_by_id or prop.parent_id in visited:
                world[pid] = local
                return local
            visited.add(pid)
            par = resolve(prop.parent_id, visited)
            rad = math.radians(par["rotation_deg"])
            rx = local["x"] * par["scale_x"] * math.cos(rad) - local["y"] * par["scale_y"] * math.sin(rad)
            ry = local["x"] * par["scale_x"] * math.sin(rad) + local["y"] * par["scale_y"] * math.cos(rad)
            world[pid] = {
                "x": par["x"] + rx,
                "y": par["y"] + ry,
                "rotation_deg": par["rotation_deg"] + local["rotation_deg"],
                "scale_x": par["scale_x"] * local["scale_x"],
                "scale_y": par["scale_y"] * local["scale_y"],
                "opacity": par["opacity"] * local["opacity"],
            }
            return world[pid]

        props = []
        for p in scene.props:
            ps = shot_prop_map.get(p.prop_instance_id)
            shot_vis = bool(ps and ps.visible) if (active_shot and p.prop_instance_id in owned_prop_ids) else True
            asset = (ps.asset_id if ps and ps.asset_id else None) or p.asset_id
            props.append({
                "prop_instance_id": p.prop_instance_id,
                "asset_id": asset,
                "z_index": ps.z_index if ps else p.z_index,
                "anchor_x": p.anchor_x,
                "anchor_y": p.anchor_y,
                "visible": bool(p.visible) and shot_vis,
                "transform": resolve(p.prop_instance_id, set()),
            })

        characters = []
        for inst in scene.characters:
            cs = shot_char_map.get(inst.instance_id)
            shot_vis = bool(cs and cs.visible) if (active_shot and inst.instance_id in owned_char_ids) else True
            characters.append(self._evaluate_character(inst, cs, time_ms, bool(inst.visible) and shot_vis))

        return {
            "timeMs": time_ms,
            "scene_id": scene.scene_id,
            "shot_id": active_shot.shot_id if active_shot else None,
            "effectiveBackgroundAssetId": bg_asset,
            "effectiveBackgroundColor": bg_color,
            "fadeAlpha": fade,
            "camera": camera,
            "props": props,
            "characters": characters,
        }

    def _evaluate_character(self, inst, cs, time_ms: float, visible: bool) -> dict:
        iid = inst.instance_id
        tf = cs.transform if cs else inst.initial_transform
        kf = lambda prop, default: _eval_numeric_keyframes(self._kfs_for("character_instance", iid, prop), time_ms, default)  # noqa: E731
        x, y = kf("x", tf.x), kf("y", tf.y)
        rot, sx, sy, op = kf("rotation_deg", tf.rotation_deg), kf("scale_x", tf.scale_x), kf("scale_y", tf.scale_y), kf("opacity", tf.opacity)
        expr_default = (cs.expression_id if cs else None) or inst.default_expression_id
        pose_default = (cs.pose_id if cs else None) or inst.default_pose_id
        expr_id = _eval_string_keyframes(self._kfs_for("character_instance", iid, "expression_id"), time_ms, expr_default)
        pose_id = _eval_string_keyframes(self._kfs_for("character_instance", iid, "pose_id"), time_ms, pose_default)
        eye_state = _eval_string_keyframes(self._kfs_for("character_instance", iid, "eye_state"), time_ms, inst.default_eye_state) or "open"
        mouth_state = _eval_string_keyframes(self._kfs_for("character_instance", iid, "mouth_state"), time_ms, inst.default_mouth_state) or "closed"
        clip = self._active_anim_clip(iid, time_ms)
        anim_state = _eval_string_keyframes(
            self._kfs_for("character_instance", iid, "animation_state"),
            time_ms,
            clip.animation_state if clip else ((cs.animation_state if cs else None) or "IDLE"),
        ) or "IDLE"

        breath_sy, bounce_y, head_bob_rot, limb_swing, auto_blink_closed = 1.0, 0.0, 0.0, 0.0, False
        if clip:
            proc = clip.procedural
            if proc.breathing:
                phase = (time_ms / float(max(200, proc.breathing_period_ms))) * 2.0 * math.pi
                breath_sy = 1.0 + math.sin(phase) * proc.breathing_amplitude
                head_bob_rot = math.sin(phase * 0.5) * 1.4
            if anim_state in ("WALKING", "RUNNING"):
                speed_mul = 1.6 if anim_state == "RUNNING" else 1.0
                phase = ((time_ms * speed_mul) / float(max(150, proc.walk_cycle_ms))) * 2.0 * math.pi
                bounce_y = -abs(math.sin(phase)) * proc.walk_bounce_px
                limb_swing = math.sin(phase) * (24.0 if anim_state == "RUNNING" else 14.0)
            elif anim_state in ("REACTING", "SURPRISED"):
                elapsed = time_ms - clip.start_ms
                if elapsed < 300:
                    bounce_y = -math.sin((elapsed / 300.0) * math.pi) * 18.0
            if proc.auto_blink:
                cycle_pos = (time_ms + _deterministic_seed_offset(iid)) % max(500, proc.blink_interval_ms)
                auto_blink_closed = cycle_pos < proc.blink_duration_ms

        char = self._get_character(inst.character_id)
        parts = []
        if char:
            expr = next((e for e in char.expressions if e.expression_id == expr_id), None)
            pose = next((p for p in char.poses if p.pose_id == pose_id), None)
            for slot in char.parts:
                t = slot.default_transform.model_dump()
                for ov_src in (
                    pose.slot_transforms.get(slot.slot_id) if pose else None,
                    expr.slot_transform_overrides.get(slot.slot_id) if expr else None,
                ):
                    if ov_src is not None:
                        for key in ("x", "y", "rotation_deg", "scale_x", "scale_y", "opacity"):
                            val = getattr(ov_src, key)
                            if val is not None:
                                t[key] = val
                if slot.part_role == "head":
                    t["rotation_deg"] += head_bob_rot
                elif slot.part_role in ("left_arm", "right_leg"):
                    t["rotation_deg"] += limb_swing
                elif slot.part_role in ("right_arm", "left_leg"):
                    t["rotation_deg"] -= limb_swing
                pk = f"{iid}:{slot.slot_id}"
                for key in ("x", "y", "rotation_deg", "scale_x", "scale_y", "opacity"):
                    t[key] = _eval_numeric_keyframes(self._kfs_for("character_part", pk, key), time_ms, t[key])
                asset_id = slot.default_asset_id
                variant = expr.slot_variant_overrides.get(slot.slot_id) if expr else None
                if variant and variant in slot.variants:
                    asset_id = slot.variants[variant]
                if slot.part_role == "eyes":
                    desired = "closed" if auto_blink_closed else eye_state
                    if desired in slot.variants:
                        asset_id = slot.variants[desired]
                elif slot.part_role == "mouth" and mouth_state in slot.variants:
                    asset_id = slot.variants[mouth_state]
                parts.append({
                    "slot_id": slot.slot_id,
                    "parent_slot_id": slot.parent_slot_id,
                    "part_role": slot.part_role,
                    "z_index": slot.z_index,
                    "anchor_x": slot.anchor_x,
                    "anchor_y": slot.anchor_y,
                    "visible": slot.visible,
                    "asset_id": asset_id,
                    "transform": {k: t[k] for k in ("x", "y", "rotation_deg", "scale_x", "scale_y", "opacity")},
                })
        return {
            "instance_id": iid,
            "character_id": inst.character_id,
            "z_index": cs.z_index if cs else inst.z_index,
            "visible": visible,
            "transform": {"x": x, "y": y + bounce_y, "rotation_deg": rot, "scale_x": sx, "scale_y": sy * breath_sy, "opacity": op},
            "expression_id": expr_id,
            "pose_id": pose_id,
            "eye_state": eye_state,
            "mouth_state": mouth_state,
            "animation_state": anim_state,
            "auto_blink_closed": auto_blink_closed,
            "parts": parts,
        }

    def _render_content(self, time_ms: float) -> Image.Image:
        ev = self.evaluate_stage(time_ms)
        if ev["scene_id"] is None:
            return Image.new("RGBA", (self.width, self.height), (20, 22, 26, 255))
        canvas = Image.new("RGBA", (self.width, self.height), _parse_hex_color(ev["effectiveBackgroundColor"]))
        cam = ev["camera"]
        cx = self.state.meta.width / 2.0
        cy = self.state.meta.height / 2.0
        stage_to_out = _compose_2d_matrix(0.0, 0.0, 0.0, self._stage_scale_x, self._stage_scale_y)
        cam_to_center = _compose_2d_matrix(cx, cy, -cam["rotation_deg"], cam["zoom"], cam["zoom"])
        world_offset = _compose_2d_matrix(-(cx + cam["x"]), -(cy + cam["y"]), 0.0, 1.0, 1.0)
        view_matrix = _mul_matrix(stage_to_out, _mul_matrix(cam_to_center, world_offset))

        if ev["effectiveBackgroundAssetId"]:
            bg_img = self._get_image(ev["effectiveBackgroundAssetId"])
            if bg_img:
                bg_mat = _mul_matrix(view_matrix, _compose_2d_matrix(cx, cy, 0.0, self.state.meta.width / float(bg_img.width), self.state.meta.height / float(bg_img.height)))
                self._blit_sprite(canvas, bg_img, bg_mat, 0.5, 0.5, 1.0)

        items: list[tuple[int, int, str, dict]] = []
        for p in ev["props"]:
            items.append((p["z_index"], 0, "prop", p))
        for c in ev["characters"]:
            items.append((c["z_index"], 1, "character", c))
        items.sort(key=lambda it: (it[0], it[1]))
        for _, _, kind, obj in items:
            if not obj["visible"]:
                continue
            if kind == "prop":
                if not obj["asset_id"]:
                    continue
                img = self._get_image(obj["asset_id"])
                if not img:
                    continue
                t = obj["transform"]
                mat = _mul_matrix(view_matrix, _compose_2d_matrix(t["x"], t["y"], t["rotation_deg"], t["scale_x"], t["scale_y"]))
                self._blit_sprite(canvas, img, mat, obj["anchor_x"], obj["anchor_y"], t["opacity"])
            else:
                self._draw_evaluated_character(canvas, view_matrix, obj)

        if ev["fadeAlpha"] < 0.999:
            black = Image.new("RGBA", (self.width, self.height), (0, 0, 0, 255))
            canvas = Image.blend(black, canvas, ev["fadeAlpha"])

        if self.burn_in_subtitles:
            self._draw_subtitles(canvas, time_ms)
        return canvas

    def _get_subtitle_font(
        self, bold: bool, size_px: int, italic: bool = False
    ) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
        key = (bold, italic, max(10, size_px))
        if key in self._font_cache:
            return self._font_cache[key]
        if bold and italic:
            candidates = _FONT_CANDIDATES_BOLD_ITALIC
        elif bold:
            candidates = _FONT_CANDIDATES_BOLD
        elif italic:
            candidates = _FONT_CANDIDATES_ITALIC
        else:
            candidates = _FONT_CANDIDATES_REGULAR
        font: ImageFont.FreeTypeFont | ImageFont.ImageFont | None = None
        for path_str in candidates:
            p = Path(path_str)
            if p.is_file():
                try:
                    font = ImageFont.truetype(str(p), size=key[2])
                    break
                except Exception:
                    continue
        if font is None:
            font = ImageFont.load_default()
        self._font_cache[key] = font
        return font

    def _wrap_lines(self, draw: ImageDraw.ImageDraw, text: str, font, max_w: int, word_wrap: bool) -> list[str]:
        raw_lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
        if not word_wrap or max_w <= 20:
            return raw_lines
        out: list[str] = []
        for raw in raw_lines:
            words = raw.split(" ")
            if not words:
                out.append("")
                continue
            current = words[0]
            for w in words[1:]:
                candidate = f"{current} {w}" if current else w
                bbox = draw.textbbox((0, 0), candidate, font=font)
                if (bbox[2] - bbox[0]) <= max_w:
                    current = candidate
                else:
                    out.append(current)
                    current = w
            out.append(current)
        return out

    def _draw_subtitles(self, canvas: Image.Image, time_ms: float) -> None:
        sub_doc = getattr(self.state, "subtitles", None)
        if not sub_doc or not sub_doc.segments:
            return
        sub_track = next((t for t in self.state.timeline.tracks if t.track_type == "subtitle"), None)
        if sub_track and not sub_track.visible:
            return

        active = [
            s
            for s in sub_doc.segments
            if s.enabled and s.text.strip() and s.start_ms <= time_ms < s.end_ms
        ]
        if not active:
            return

        styles_list = sub_doc.styles or default_subtitle_styles()
        scale_y = self.height / 1080.0
        scale_x = self.width / 1920.0

        overlay = Image.new("RGBA", (self.width, self.height), (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)

        # Group simultaneous subtitles by position so multiple cues stack cleanly
        by_pos: dict[str, list[tuple[object, SubtitleStyle]]] = {"bottom": [], "center": [], "top": []}
        for seg in sorted(active, key=lambda s: (s.start_ms, s.end_ms)):
            st = resolve_effective_subtitle_style(styles_list, seg, sub_doc.default_style_id)
            pos = st.position
            by_pos.setdefault(pos, []).append((seg, st))

        safe_x = int(round(self.width * 0.05))
        safe_y = int(round(self.height * 0.05))

        for pos, items in by_pos.items():
            if not items:
                continue
            stack_offset = 0
            for seg, st in (reversed(items) if pos == "bottom" else items):
                font_px = max(12, int(round(st.font_size * scale_y)))
                bold = st.font_weight in ("semibold", "bold", "extrabold")
                font = self._get_subtitle_font(bold, font_px, italic=bool(getattr(st, "italic", False)))
                max_w = max(80, int(round(self.width * (st.max_width_pct / 100.0))))
                lines = self._wrap_lines(draw, seg.text, font, max_w, st.word_wrap)
                if not lines:
                    continue

                letter_sp = float(getattr(st, "letter_spacing", 0.0) or 0.0) * scale_x
                line_h = int(round(font_px * st.line_spacing))
                line_widths: list[int] = []
                for ln in lines:
                    bb = draw.textbbox((0, 0), ln or " ", font=font)
                    extra_sp = max(0, len(ln) - 1) * letter_sp if abs(letter_sp) >= 0.2 else 0.0
                    line_widths.append(max(1, int(round((bb[2] - bb[0]) + extra_sp))))
                block_w = min(max_w, max(line_widths, default=1))
                block_h = max(line_h, line_h * len(lines))

                pad_x = max(0, int(round(getattr(st, "background_padding_x", 18) * scale_x)))
                pad_y = max(0, int(round(getattr(st, "background_padding_y", 10) * scale_y)))
                margin_x = int(round(st.margin_x * scale_x))
                margin_y = int(round(st.margin_y * scale_y))
                min_box_h = int(round(getattr(st, "box_height_px", 0) * scale_y))
                box_w = block_w + pad_x * 2
                box_h = max(block_h + pad_y * 2, min_box_h)

                if st.alignment == "left":
                    box_x = margin_x
                elif st.alignment == "right":
                    box_x = max(margin_x, self.width - margin_x - box_w)
                else:
                    box_x = (self.width - box_w) // 2

                if pos == "top":
                    box_y = margin_y + stack_offset
                elif pos == "center":
                    box_y = (self.height - box_h) // 2 + stack_offset
                else:
                    box_y = self.height - margin_y - box_h - stack_offset

                box_x += int(round(getattr(st, "offset_x", 0.0) * scale_x))
                box_y += int(round(getattr(st, "offset_y", 0.0) * scale_y))

                if getattr(st, "safe_area_clamp", True):
                    box_x = max(safe_x, min(self.width - safe_x - box_w, box_x))
                    box_y = max(safe_y, min(self.height - safe_y - box_h, box_y))

                if st.background_enabled and st.background_opacity > 0.01:
                    br, bg, bb_col, _ = _parse_hex_color(st.background_color)
                    ba = max(0, min(255, int(round(st.background_opacity * 255))))
                    radius = max(4, int(round(10 * scale_y)))
                    draw.rounded_rectangle(
                        [box_x, box_y, box_x + box_w, box_y + box_h],
                        radius=radius,
                        fill=(br, bg, bb_col, ba),
                    )

                txt_rgba = _parse_hex_color(st.text_color)
                out_rgba = _parse_hex_color(st.outline_color)
                stroke_w = max(0, int(round(st.outline_width * scale_y)))
                sh_r, sh_g, sh_b, _ = _parse_hex_color(st.shadow_color)
                sh_alpha = max(0, min(255, int(round(getattr(st, "shadow_opacity", 0.78) * 255))))
                sh_dx = int(round(st.shadow_offset_x * scale_x))
                sh_dy = int(round(st.shadow_offset_y * scale_y))
                v_center_pad = max(0, (box_h - (block_h + pad_y * 2)) // 2)

                for l_idx, ln in enumerate(lines):
                    lw = line_widths[l_idx]
                    if st.alignment == "left":
                        tx = box_x + pad_x
                    elif st.alignment == "right":
                        tx = box_x + pad_x + (block_w - lw)
                    else:
                        tx = box_x + pad_x + (block_w - lw) // 2
                    ty = box_y + pad_y + v_center_pad + l_idx * line_h

                    if abs(letter_sp) >= 0.2:
                        cx = float(tx)
                        for ch in ln:
                            if st.shadow_enabled and (sh_dx != 0 or sh_dy != 0 or st.shadow_blur > 0):
                                draw.text(
                                    (int(round(cx)) + sh_dx, ty + max(1, sh_dy)),
                                    ch,
                                    font=font,
                                    fill=(sh_r, sh_g, sh_b, sh_alpha),
                                    stroke_width=stroke_w,
                                    stroke_fill=(sh_r, sh_g, sh_b, int(sh_alpha * 0.8)) if stroke_w > 0 else None,
                                )
                            draw.text(
                                (int(round(cx)), ty),
                                ch,
                                font=font,
                                fill=txt_rgba,
                                stroke_width=stroke_w,
                                stroke_fill=out_rgba if stroke_w > 0 else None,
                            )
                            cbb = draw.textbbox((0, 0), ch, font=font)
                            cx += (cbb[2] - cbb[0]) + letter_sp
                    else:
                        if st.shadow_enabled and (sh_dx != 0 or sh_dy != 0 or st.shadow_blur > 0):
                            draw.text(
                                (tx + sh_dx, ty + max(1, sh_dy)),
                                ln,
                                font=font,
                                fill=(sh_r, sh_g, sh_b, sh_alpha),
                                stroke_width=stroke_w,
                                stroke_fill=(sh_r, sh_g, sh_b, int(sh_alpha * 0.8)) if stroke_w > 0 else None,
                            )
                        draw.text(
                            (tx, ty),
                            ln,
                            font=font,
                            fill=txt_rgba,
                            stroke_width=stroke_w,
                            stroke_fill=out_rgba if stroke_w > 0 else None,
                        )

                    if getattr(st, "underline", False) and lw > 0:
                        uy = ty + font_px + max(1, int(round(2 * scale_y)))
                        draw.line([(tx, uy), (tx + lw, uy)], fill=txt_rgba, width=max(1, int(round(2 * scale_y))))

                stack_offset += box_h + max(8, int(round(10 * scale_y)))

        canvas.alpha_composite(overlay)

    def _draw_evaluated_character(self, canvas: Image.Image, view_matrix, ch: dict) -> None:
        t = ch["transform"]
        root = _mul_matrix(view_matrix, _compose_2d_matrix(t["x"], t["y"], t["rotation_deg"], t["scale_x"], t["scale_y"]))
        parts = {p["slot_id"]: p for p in ch["parts"]}
        mats: dict[str, tuple] = {}

        def part_mat(slot_id: str, seen: set[str]) -> tuple:
            if slot_id in mats:
                return mats[slot_id]
            p = parts[slot_id]
            pt = p["transform"]
            local = _compose_2d_matrix(pt["x"], pt["y"], pt["rotation_deg"], pt["scale_x"], pt["scale_y"])
            seen.add(slot_id)
            par = p["parent_slot_id"]
            parent = part_mat(par, seen) if par and par in parts and par not in seen else root
            mats[slot_id] = _mul_matrix(parent, local)
            return mats[slot_id]

        for p in sorted(ch["parts"], key=lambda q: q["z_index"]):
            if not p["visible"] or not p["asset_id"]:
                continue
            img = self._get_image(p["asset_id"])
            if img:
                self._blit_sprite(canvas, img, part_mat(p["slot_id"], set()), p["anchor_x"], p["anchor_y"], t["opacity"] * p["transform"]["opacity"])

    @staticmethod
    def _blit_sprite(
        canvas: Image.Image,
        sprite: Image.Image,
        matrix: tuple[float, float, float, float, float, float],
        anchor_x: float,
        anchor_y: float,
        opacity: float,
    ) -> None:
        if opacity <= 0.001:
            return
        a, b, c, d, tx, ty = matrix
        scale_x = math.hypot(a, b)
        scale_y = math.hypot(c, d)
        if scale_x < 1e-4 or scale_y < 1e-4:
            return
        rot_deg = math.degrees(math.atan2(b, a))

        w = max(1, int(round(sprite.width * scale_x)))
        h = max(1, int(round(sprite.height * scale_y)))
        img = sprite.resize((w, h), Image.Resampling.BILINEAR)

        # Position of anchor relative to top-left of resized image
        ax = w * anchor_x
        ay = h * anchor_y

        if abs(rot_deg) > 0.01:
            # Rotate around image center and compensate pivot shift
            cx_img = w / 2.0
            cy_img = h / 2.0
            dx = cx_img - ax
            dy = cy_img - ay
            rad = math.radians(rot_deg)
            rx = dx * math.cos(rad) - dy * math.sin(rad)
            ry = dx * math.sin(rad) + dy * math.cos(rad)
            rotated = img.rotate(-rot_deg, resample=Image.Resampling.BICUBIC, expand=True)
            paste_x = int(round(tx + rx - rotated.width / 2.0))
            paste_y = int(round(ty + ry - rotated.height / 2.0))
            img = rotated
        else:
            paste_x = int(round(tx - ax))
            paste_y = int(round(ty - ay))

        if opacity < 0.999:
            r, g, b_ch, alpha = img.split()
            alpha = alpha.point(lambda p: int(p * opacity))
            img = Image.merge("RGBA", (r, g, b_ch, alpha))

        canvas.alpha_composite(img, dest=(paste_x, paste_y))
