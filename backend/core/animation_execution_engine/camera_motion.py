"""Phase 07 Batch 2 — 2D Camera Motion Execution & Character Synchronization.

Executes supported 2D camera motions via real, editable `camera` Timeline keyframes:
- Native: static, pan_left, pan_right, tilt_up, tilt_down, zoom_in, zoom_out
- Procedural 2D: dolly_in, dolly_out, shake, tracking, camera_follow (synchronized with character root motion!)
- Honestly Unsupported (NEVER silently replaced!): parallax
"""

from __future__ import annotations

import math

from core.animation_execution_engine.procedural import quantize_ms, stable_anim_id
from schemas.animation_execution import (
    CameraMotionParameters,
    MotionSupportLevel,
)
from schemas.timeline import EasingType, Keyframe, KeyframeProperty


def evaluate_camera_execution_support(movement: str) -> tuple[MotionSupportLevel, bool, str]:
    """Return `(support_level, executable, reason_or_note)` honestly for each camera movement."""
    if movement == "parallax":
        return (
            "unsupported",
            False,
            "True 2.5D/3D multi-plane parallax camera is not supported by the single-plane 2D camera. Not replaced silently.",
        )
    if movement in ("static", "pan_left", "pan_right", "tilt_up", "tilt_down", "zoom_in", "zoom_out"):
        return ("full", True, "")
    if movement in ("dolly_in", "dolly_out"):
        return (
            "partial",
            True,
            "Executed as 2D zoom approximation (true 3D perspective dolly depth is unavailable in 2D camera).",
        )
    if movement == "shake":
        return (
            "full",
            True,
            "Executed via damped procedural 2D camera X/Y/rotation keyframes.",
        )
    if movement in ("tracking", "camera_follow"):
        return (
            "full",
            True,
            "Executed via character-synchronized 2D camera X/Y tracking keyframes.",
        )
    return (
        "unsupported",
        False,
        f"Unrecognized camera movement '{movement}'.",
    )


def generate_camera_motion_keyframes(
    *,
    motion_id: str,
    cam_params: CameraMotionParameters,
    camera_track_id: str,
    shot_start_ms: int,
    shot_end_ms: int,
    fps: int,
    stage_width: int,
    stage_height: int,
    follow_character_kfs: list[Keyframe] | None = None,
    follow_base_x: float | None = None,
    follow_base_y: float | None = None,
) -> tuple[list[Keyframe], MotionSupportLevel, bool, list[str], str]:
    """Generate real, editable, shot-clamped `camera` keyframes.

    Returns `(keyframes, support_level, executable, warnings, unsupported_reason)`.
    """
    support_level, executable, note = evaluate_camera_execution_support(cam_params.movement)
    if not executable:
        return [], "unsupported", False, [], note

    warnings: list[str] = []
    if note and support_level == "partial":
        warnings.append(note)

    safe_fps = max(12, int(fps))
    shot_dur = max(250, shot_end_ms - shot_start_ms)
    delay = min(cam_params.delay_ms, max(0, shot_dur - 250))
    t0 = quantize_ms(shot_start_ms + delay, safe_fps)
    dur = min(max(250, cam_params.duration_ms), max(250, shot_end_ms - t0))
    if cam_params.duration_ms > (shot_end_ms - t0):
        warnings.append(
            f"Camera duration ({cam_params.duration_ms}ms) clamped to {dur}ms to match shot end."
        )
    t1 = min(shot_end_ms, quantize_ms(t0 + dur, safe_fps))
    if t1 <= t0:
        t1 = min(shot_end_ms, t0 + max(250, int(round(1000.0 / safe_fps))))

    keyframes: list[Keyframe] = []
    seen: set[tuple[str, int]] = set()

    def add_cam(prop: KeyframeProperty, time_ms: float, val: float, easing: EasingType) -> None:
        q_ms = max(shot_start_ms, min(shot_end_ms, quantize_ms(time_ms, safe_fps)))
        if prop == "zoom":
            val = max(0.2, min(4.0, float(val)))
        elif prop == "rotation_deg":
            val = max(-45.0, min(45.0, float(val)))
        else:
            val = max(-4000.0, min(4000.0, float(val)))
        val = round(val, 3)
        key = (prop, q_ms)
        if key in seen:
            for idx, existing in enumerate(keyframes):
                if existing.property == prop and existing.time_ms == q_ms:
                    keyframes[idx] = existing.model_copy(update={"value": val, "easing": easing})
                    return
        seen.add(key)
        keyframes.append(
            Keyframe(
                keyframe_id=stable_anim_id("anim_kf", motion_id, "camera", prop, q_ms),
                track_id=camera_track_id,
                target_type="camera",
                target_id="camera",
                property=prop,
                time_ms=q_ms,
                value=val,
                easing=easing,
            )
        )

    mv = cam_params.movement
    easing = cam_params.easing

    if mv == "static":
        add_cam("x", t0, cam_params.start_x, "hold")
        add_cam("y", t0, cam_params.start_y, "hold")
        add_cam("zoom", t0, cam_params.start_zoom, "hold")
        add_cam("rotation_deg", t0, cam_params.start_rotation_deg, "hold")
        # Hold end boundary so prior/next shots stay cleanly isolated
        add_cam("x", t1, cam_params.start_x, "hold")
        add_cam("y", t1, cam_params.start_y, "hold")
        add_cam("zoom", t1, cam_params.start_zoom, "hold")
        add_cam("rotation_deg", t1, cam_params.start_rotation_deg, "hold")

    elif mv == "shake":
        amp = float(cam_params.shake_intensity_px)
        freq = float(cam_params.shake_frequency_hz)
        total_sec = max(0.25, (t1 - t0) / 1000.0)
        # Keep shake keyframes smooth & bounded (max ~24 samples so timeline stays clean!)
        steps = max(4, min(24, int(round(total_sec * freq * 2.0))))
        dt = (t1 - t0) / float(steps)

        add_cam("zoom", t0, cam_params.start_zoom, easing)
        add_cam("zoom", t1, cam_params.end_zoom, "hold")
        add_cam("x", t0, cam_params.start_x, "linear")
        add_cam("y", t0, cam_params.start_y, "linear")
        add_cam("rotation_deg", t0, cam_params.start_rotation_deg, "linear")

        for i in range(1, steps):
            frac = i / float(steps)
            # Smooth envelope: ramp in quickly, damp out cleanly to 0 before shot end
            env = math.sin(frac * math.pi)
            base_x = cam_params.start_x + (cam_params.end_x - cam_params.start_x) * frac
            base_y = cam_params.start_y + (cam_params.end_y - cam_params.start_y) * frac
            base_r = cam_params.start_rotation_deg + (cam_params.end_rotation_deg - cam_params.start_rotation_deg) * frac

            # Deterministic alternating impulse pattern
            sign_x = 1.0 if i % 2 == 1 else -1.0
            sign_y = 1.0 if (i // 2) % 2 == 0 else -1.0
            t_cur = t0 + i * dt
            add_cam("x", t_cur, base_x + sign_x * amp * env, "linear")
            add_cam("y", t_cur, base_y + sign_y * amp * 0.65 * env, "linear")
            add_cam("rotation_deg", t_cur, base_r + sign_x * min(4.5, amp * 0.14) * env, "linear")

        # Settle cleanly back to end framing (zero abrupt jump at shot boundary!)
        add_cam("x", t1, cam_params.end_x, "hold")
        add_cam("y", t1, cam_params.end_y, "hold")
        add_cam("rotation_deg", t1, cam_params.end_rotation_deg, "hold")

    elif mv in ("tracking", "camera_follow"):
        cx = stage_width / 2.0
        cy = stage_height / 2.0
        strength = float(cam_params.follow_strength)

        char_x_kfs = sorted(
            [k for k in (follow_character_kfs or []) if k.target_type == "character_instance" and k.property == "x"],
            key=lambda k: k.time_ms,
        )
        char_y_kfs = sorted(
            [k for k in (follow_character_kfs or []) if k.target_type == "character_instance" and k.property == "y"],
            key=lambda k: k.time_ms,
        )

        if len(char_x_kfs) >= 2:
            # Synchronize camera X directly to the character's root motion trajectory!
            x_start_char = float(char_x_kfs[0].value)
            x_end_char = float(char_x_kfs[-1].value)
            cam_x0 = cam_params.start_x if abs(cam_params.start_x) > 0.1 else (x_start_char - cx) * strength * 0.55
            delta_x = (x_end_char - x_start_char) * strength
            cam_x1 = cam_x0 + delta_x

            add_cam("x", t0, cam_x0, "linear" if mv == "tracking" else easing)
            add_cam("x", t1, cam_x1, "hold")

            if len(char_y_kfs) >= 2:
                y_start_char = float(char_y_kfs[0].value)
                y_end_char = float(char_y_kfs[-1].value)
                cam_y0 = cam_params.start_y
                cam_y1 = cam_y0 + (y_end_char - y_start_char) * strength * 0.5
                add_cam("y", t0, cam_y0, easing)
                add_cam("y", t1, cam_y1, "hold")
            else:
                add_cam("y", t0, cam_params.start_y, easing)
                add_cam("y", t1, cam_params.end_y, "hold")
        elif follow_base_x is not None:
            # Frame onto character center cleanly when character isn't translating
            target_x = (follow_base_x - cx) * strength * 0.55
            target_y = ((follow_base_y - cy) * strength * 0.35) if follow_base_y is not None else cam_params.end_y
            add_cam("x", t0, cam_params.start_x, easing)
            add_cam("x", t1, target_x, "hold")
            add_cam("y", t0, cam_params.start_y, easing)
            add_cam("y", t1, target_y, "hold")
            warnings.append(
                "Target character had no root translation keyframes; camera smoothly reframed to focus character position."
            )
        else:
            add_cam("x", t0, cam_params.start_x, easing)
            add_cam("x", t1, cam_params.end_x, "hold")
            add_cam("y", t0, cam_params.start_y, easing)
            add_cam("y", t1, cam_params.end_y, "hold")
            warnings.append(
                "No moving character target specified; executed explicit start-to-end 2D tracking pan."
            )

        add_cam("zoom", t0, cam_params.start_zoom, easing)
        add_cam("zoom", t1, cam_params.end_zoom, "hold")
        add_cam("rotation_deg", t0, cam_params.start_rotation_deg, easing)
        add_cam("rotation_deg", t1, cam_params.end_rotation_deg, "hold")

    else:
        # pan_left, pan_right, tilt_up, tilt_down, zoom_in, zoom_out, dolly_in, dolly_out
        add_cam("x", t0, cam_params.start_x, easing)
        add_cam("x", t1, cam_params.end_x, "hold")
        add_cam("y", t0, cam_params.start_y, easing)
        add_cam("y", t1, cam_params.end_y, "hold")
        add_cam("zoom", t0, cam_params.start_zoom, easing)
        add_cam("zoom", t1, cam_params.end_zoom, "hold")
        add_cam("rotation_deg", t0, cam_params.start_rotation_deg, easing)
        add_cam("rotation_deg", t1, cam_params.end_rotation_deg, "hold")

    keyframes.sort(key=lambda k: (k.time_ms, k.property))
    return keyframes, support_level, True, warnings, ""
