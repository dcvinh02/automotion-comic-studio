"""Authoritative 2D Camera Capability Matrix, Framing Presets & Duration Estimator.

Honest capability boundaries matching the actual PixiJS/WebGL + software 2D Camera engine
(`CameraState`: x, y, zoom, rotation_deg + keyframe interpolation):
- Directly executable (`supported`): static, pan_left, pan_right, tilt_up, tilt_down, zoom_in, zoom_out
- 2D approximation (`2d_approximation`): dolly_in, dolly_out, shake, tracking, camera_follow
- Planning suggestion only (`unsupported_suggestion`): parallax (requires multi-plane 2.5D depth)
"""

from __future__ import annotations

from schemas.storyboard import (
    Camera2DKeyPlan,
    CameraAngle,
    CameraMovement,
    CameraSupportStatus,
    ShotScriptRef,
    ShotSize,
    StoryboardShot,
)

CAMERA_MOVEMENT_SUPPORT: dict[CameraMovement, tuple[CameraSupportStatus, str]] = {
    "static": (
        "supported",
        "Directly executable via fixed 2D Camera (x, y, zoom, rotation_deg).",
    ),
    "pan_left": (
        "supported",
        "Directly executable via 2D Camera horizontal X keyframes.",
    ),
    "pan_right": (
        "supported",
        "Directly executable via 2D Camera horizontal X keyframes.",
    ),
    "tilt_up": (
        "supported",
        "Directly executable via 2D Camera vertical Y pan keyframes.",
    ),
    "tilt_down": (
        "supported",
        "Directly executable via 2D Camera vertical Y pan keyframes.",
    ),
    "zoom_in": (
        "supported",
        "Directly executable via 2D Camera zoom keyframes.",
    ),
    "zoom_out": (
        "supported",
        "Directly executable via 2D Camera zoom keyframes.",
    ),
    "dolly_in": (
        "2d_approximation",
        "2D approximation via zoom-in only; true 3D perspective dolly depth is not supported by the 2D camera.",
    ),
    "dolly_out": (
        "2d_approximation",
        "2D approximation via zoom-out only; true 3D perspective dolly depth is not supported by the 2D camera.",
    ),
    "tracking": (
        "2d_approximation",
        "Requires manual 2D camera X/Y keyframes matched to character motion; automatic motion tracking is not implemented.",
    ),
    "camera_follow": (
        "2d_approximation",
        "Requires manual 2D camera X/Y keyframes; automatic target-follow camera constraints are not yet implemented.",
    ),
    "shake": (
        "2d_approximation",
        "Requires manual rapid camera X/Y/rotation keyframes; procedural camera shake filter is not yet implemented.",
    ),
    "parallax": (
        "unsupported_suggestion",
        "Unsupported in single-plane 2D camera (planning suggestion only; requires multi-depth 2.5D parallax layers).",
    ),
}

CAMERA_ANGLE_NOTES: dict[CameraAngle, str] = {
    "eye_level": "Native 2D neutral framing.",
    "dutch_angle": "Executable via 2D camera rotation_deg tilt.",
    "low_angle": "2D staging direction: compose artwork/character scale upward (no 3D camera pitch).",
    "high_angle": "2D staging direction: compose artwork/horizon higher in frame (no 3D camera pitch).",
    "birds_eye": "2D art direction: requires dedicated top-down background/character art.",
    "worms_eye": "2D art direction: requires dedicated steep low-horizon art.",
    "over_the_shoulder": "2D staging direction: place foreground shoulder silhouette near frame edge.",
    "pov": "2D staging direction: frame directly from character viewpoint without showing speaker.",
}

SHOT_SIZE_BASE_ZOOM: dict[ShotSize, float] = {
    "extreme_wide": 0.85,
    "wide": 1.0,
    "full": 1.08,
    "medium_full": 1.18,
    "medium": 1.32,
    "medium_close_up": 1.55,
    "close_up": 1.85,
    "extreme_close_up": 2.35,
    "over_the_shoulder": 1.45,
    "pov": 1.25,
    "insert": 2.1,
}


def evaluate_camera_movement_support(
    movement: CameraMovement,
) -> tuple[CameraSupportStatus, str]:
    return CAMERA_MOVEMENT_SUPPORT.get(
        movement,
        ("unsupported_suggestion", "Unrecognized camera movement; treated as planning suggestion only."),
    )


def evaluate_camera_angle_note(angle: CameraAngle) -> str:
    return CAMERA_ANGLE_NOTES.get(angle, "2D composition direction.")


def build_default_2d_camera_plan(
    shot_size: ShotSize,
    camera_angle: CameraAngle,
    camera_movement: CameraMovement,
) -> Camera2DKeyPlan:
    base_zoom = SHOT_SIZE_BASE_ZOOM.get(shot_size, 1.2)
    rot = 7.5 if camera_angle == "dutch_angle" else 0.0
    sx = sy = ex = ey = 0.0
    sz = ez = base_zoom

    if camera_movement == "pan_left":
        sx, ex = 90.0, -90.0
    elif camera_movement == "pan_right":
        sx, ex = -90.0, 90.0
    elif camera_movement == "tilt_up":
        sy, ey = 60.0, -60.0
    elif camera_movement == "tilt_down":
        sy, ey = -60.0, 60.0
    elif camera_movement in ("zoom_in", "dolly_in"):
        ez = min(4.0, round(base_zoom * 1.18, 2))
    elif camera_movement in ("zoom_out", "dolly_out"):
        sz = min(4.0, round(base_zoom * 1.18, 2))
        ez = base_zoom
    elif camera_movement in ("tracking", "camera_follow"):
        sx, ex = -70.0, 70.0

    return Camera2DKeyPlan(
        start_x=sx,
        start_y=sy,
        start_zoom=sz,
        start_rotation_deg=rot,
        end_x=ex,
        end_y=ey,
        end_zoom=ez,
        end_rotation_deg=rot,
        easing="linear" if camera_movement in ("pan_left", "pan_right", "tracking") else "ease_in_out",
    )


def estimate_shot_duration_ms(
    *,
    dialogue_refs: list[ShotScriptRef],
    narration_refs: list[ShotScriptRef],
    action_text: str,
    camera_movement: CameraMovement,
    emotional_emphasis: str,
    shot_size: ShotSize,
    ai_suggested_ms: int | None = None,
) -> int:
    """Compute realistic, varied shot duration in ms grounded in speech/reading/action/camera load."""
    speech_words = sum(
        len((r.text_excerpt or "").split()) for r in [*dialogue_refs, *narration_refs]
    )
    # ~370 ms per spoken/read word + pause margin for motion comic captions
    speech_ms = (speech_words * 370 + 650) if speech_words > 0 else 0

    action_words = len((action_text or "").split())
    action_ms = 1400 + min(3200, action_words * 130)

    move_bonus = 0
    if camera_movement in ("pan_left", "pan_right", "tilt_up", "tilt_down", "tracking", "camera_follow"):
        move_bonus = 700
    elif camera_movement in ("zoom_in", "zoom_out", "dolly_in", "dolly_out", "parallax"):
        move_bonus = 550
    elif camera_movement == "shake":
        move_bonus = 250

    size_bonus = 500 if shot_size in ("extreme_wide", "wide") else 0
    emo_low = (emotional_emphasis or "").lower()
    pause_bonus = (
        650
        if any(k in emo_low for k in ("pause", "silence", "shock", "lặng", "bất ngờ", "sốc", "climax", "cao trào"))
        else 0
    )

    computed = max(1400, max(speech_ms, action_ms) + move_bonus + size_bonus + pause_bonus)

    if ai_suggested_ms is not None and 800 <= ai_suggested_ms <= 45000:
        # Respect AI timing when reasonable, but enforce minimum readable duration for dialogue!
        min_readable = max(1200, speech_ms)
        blended = max(min_readable, int(round((ai_suggested_ms * 0.65) + (computed * 0.35))))
        return max(1000, min(45000, int(round(blended / 100.0) * 100)))

    return max(1000, min(45000, int(round(computed / 100.0) * 100)))


def recalculate_scene_shot_timings(shots: list[StoryboardShot]) -> list[StoryboardShot]:
    """Recalculate `shot_order`, `start_time_ms`, and `end_time_ms` per scene sequentially."""
    by_scene_cursor: dict[str, int] = {}
    by_scene_order: dict[str, int] = {}
    out: list[StoryboardShot] = []
    for shot in shots:
        sid = shot.scene_id
        order = by_scene_order.get(sid, 0) + 1
        start = by_scene_cursor.get(sid, 0)
        dur = max(500, int(shot.duration_ms))
        end = start + dur
        by_scene_order[sid] = order
        by_scene_cursor[sid] = end
        out.append(
            shot.model_copy(
                update={
                    "shot_order": order,
                    "duration_ms": dur,
                    "start_time_ms": start,
                    "end_time_ms": end,
                }
            )
        )
    return out
