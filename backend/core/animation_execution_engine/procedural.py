"""Phase 07 Batch 2 — Procedural Real-Keyframe Animation Generator.

Generates real, editable `Keyframe` & `CharacterAnimationClip` records grounded in:
- Deterministic stable IDs (`anim_kf_<hash>`, `anim_clip_<hash>`) -> zero duplicates!
- Actual character rig hierarchy, part slots & pivot anchors (`anchor_x`, `anchor_y`)
- Anti-slide walk & run stride math synchronizing root travel with leg/arm swing
- Strict parameter validation (never allows NaN/Infinity/invalid duration/speed)
- Strict shot-boundary clamping so motion never leaks into adjacent shots
- Sparse semantic keyframes (using easing interpolation instead of per-frame spam)
"""

from __future__ import annotations

import hashlib
import math

from schemas.animation_execution import (
    CharacterRigCapabilities,
    MotionParameters,
    MotionPreset,
)
from schemas.character import Character, CharacterPartSlot
from schemas.common import Transform2D
from schemas.timeline import (
    AnimationStateType,
    CharacterAnimationClip,
    EasingType,
    Keyframe,
    KeyframeProperty,
    KeyframeTargetType,
    ProceduralAnimationConfig,
)


def stable_anim_id(prefix: str, *parts: object) -> str:
    raw = "|".join(str(p) for p in parts)
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12]
    return f"{prefix}_{digest}"


def quantize_ms(time_ms: float, fps: int) -> int:
    safe_fps = max(1, int(fps))
    frame = max(0, round((float(time_ms) * safe_fps) / 1000.0))
    return int(round((frame * 1000.0) / safe_fps))


def validate_motion_parameters(
    params: MotionParameters,
    preset: MotionPreset,
) -> list[str]:
    """Validate motion parameters strictly before keyframe generation."""
    errors: list[str] = []
    if not math.isfinite(params.speed) or params.speed < 0.25 or params.speed > 3.0:
        errors.append("Speed must be a finite number between 0.25 and 3.0.")
    if not math.isfinite(params.intensity) or params.intensity < 0.1 or params.intensity > 2.5:
        errors.append("Intensity must be a finite number between 0.1 and 2.5.")
    if not math.isfinite(params.distance_px) or abs(params.distance_px) > 2400.0:
        errors.append("Distance must be a finite number within [-2400, 2400] px.")
    if params.duration_ms < 250 or params.duration_ms > 60000:
        errors.append("Duration must be between 250ms and 60000ms.")
    if params.delay_ms < 0 or params.delay_ms > 30000:
        errors.append("Delay must be between 0ms and 30000ms.")
    if params.duration_ms < preset.min_duration_ms:
        errors.append(
            f"Duration ({params.duration_ms}ms) is shorter than preset '{preset.name}' minimum ({preset.min_duration_ms}ms)."
        )
    if params.duration_ms > preset.max_duration_ms:
        errors.append(
            f"Duration ({params.duration_ms}ms) exceeds preset '{preset.name}' maximum ({preset.max_duration_ms}ms)."
        )
    return errors


def _slot_by_role(character: Character, role: str) -> CharacterPartSlot | None:
    return next((p for p in character.parts if p.part_role == role and p.visible), None) or next(
        (p for p in character.parts if p.part_role == role), None
    )


def _signed_distance(params: MotionParameters) -> float:
    mag = abs(params.distance_px)
    if params.direction in ("left", "backward"):
        return -mag
    if params.direction in ("right", "forward"):
        return mag
    if params.direction == "in_place":
        return 0.0
    return params.distance_px


def generate_character_motion_keyframes(
    *,
    motion_id: str,
    preset: MotionPreset,
    character: Character,
    caps: CharacterRigCapabilities,
    instance_id: str,
    track_id: str,
    base_transform: Transform2D,
    params: MotionParameters,
    shot_start_ms: int,
    shot_end_ms: int,
    fps: int,
    stage_width: int,
    stage_height: int,
) -> tuple[list[Keyframe], list[CharacterAnimationClip], list[str]]:
    """Generate real, editable, shot-clamped Keyframes & optional Clip for a character motion."""
    warnings: list[str] = []
    safe_fps = max(12, int(fps))
    shot_dur = max(250, shot_end_ms - shot_start_ms)

    # Coordinate delay & active window strictly inside [shot_start_ms, shot_end_ms]
    delay_ms = min(params.delay_ms, max(0, shot_dur - 250))
    if params.delay_ms > delay_ms:
        warnings.append(
            f"Delay ({params.delay_ms}ms) clamped to {delay_ms}ms to fit within shot duration ({shot_dur}ms)."
        )

    active_start = quantize_ms(shot_start_ms + delay_ms, safe_fps)
    requested_dur = params.duration_ms
    max_avail = max(250, shot_end_ms - active_start)
    if params.loop:
        active_dur = max_avail
    elif requested_dur > max_avail:
        active_dur = max_avail
        warnings.append(
            f"Motion duration ({requested_dur}ms) clamped to {active_dur}ms to avoid bleeding past shot end."
        )
    else:
        active_dur = max(250, requested_dur)
    active_end = min(shot_end_ms, quantize_ms(active_start + active_dur, safe_fps))
    if active_end <= active_start:
        active_end = min(shot_end_ms, active_start + max(250, int(round(1000.0 / safe_fps))))
    active_dur = max(100, active_end - active_start)

    keyframes: list[Keyframe] = []
    clips: list[CharacterAnimationClip] = []
    seen_slots: set[tuple[str, str, str, int]] = set()

    def add_kf(
        target_type: KeyframeTargetType,
        target_id: str,
        prop: KeyframeProperty,
        time_ms: float,
        value: float | str,
        easing: EasingType = "ease_in_out",
    ) -> None:
        q_ms = max(shot_start_ms, min(shot_end_ms, quantize_ms(time_ms, safe_fps)))
        val: float | str = round(float(value), 3) if isinstance(value, (int, float)) else str(value)
        dedup_key = (target_type, target_id, prop, q_ms)
        if dedup_key in seen_slots:
            # Replace prior value at exact same quantized frame deterministically
            for idx, existing in enumerate(keyframes):
                if (
                    existing.target_type == target_type
                    and existing.target_id == target_id
                    and existing.property == prop
                    and existing.time_ms == q_ms
                ):
                    keyframes[idx] = existing.model_copy(update={"value": val, "easing": easing})
                    return
        seen_slots.add(dedup_key)
        keyframes.append(
            Keyframe(
                keyframe_id=stable_anim_id("anim_kf", motion_id, target_type, target_id, prop, q_ms),
                track_id=track_id,
                target_type=target_type,
                target_id=target_id,
                property=prop,
                time_ms=q_ms,
                value=val,
                easing=easing,
            )
        )

    def add_part_rot(slot: CharacterPartSlot | None, time_ms: float, delta_deg: float, easing: EasingType) -> None:
        if slot is None:
            return
        base_rot = slot.default_transform.rotation_deg
        add_kf("character_part", f"{instance_id}:{slot.slot_id}", "rotation_deg", time_ms, base_rot + delta_deg, easing)

    # Optional explicit start / end Pose Presets (verified against character.poses!)
    valid_pose_ids = set(caps.pose_ids)
    if params.start_pose_id:
        if params.start_pose_id in valid_pose_ids:
            add_kf("character_instance", instance_id, "pose_id", active_start, params.start_pose_id, "hold")
        else:
            warnings.append(f"Start pose '{params.start_pose_id}' not found on rig '{character.name}'.")
    if params.end_pose_id:
        if params.end_pose_id in valid_pose_ids:
            add_kf("character_instance", instance_id, "pose_id", active_end, params.end_pose_id, "hold")
        else:
            warnings.append(f"End pose '{params.end_pose_id}' not found on rig '{character.name}'.")

    bx = float(base_transform.x)
    by = float(base_transform.y)
    brot = float(base_transform.rotation_deg)
    bsx = float(base_transform.scale_x) if abs(base_transform.scale_x) > 0.01 else 1.0
    bsy = float(base_transform.scale_y) if abs(base_transform.scale_y) > 0.01 else 1.0
    intensity = float(params.intensity)
    speed = float(params.speed)
    easing = params.easing

    head_slot = _slot_by_role(character, "head")
    body_slot = _slot_by_role(character, "body")
    l_arm = _slot_by_role(character, "left_arm")
    r_arm = _slot_by_role(character, "right_arm")
    l_hand = _slot_by_role(character, "left_hand")
    r_hand = _slot_by_role(character, "right_hand")
    l_leg = _slot_by_role(character, "left_leg")
    r_leg = _slot_by_role(character, "right_leg")

    cat = preset.category
    clip_state: AnimationStateType = "IDLE"
    min_x = round(stage_width * 0.08, 1)
    max_x = round(stage_width * 0.92, 1)
    min_y = round(stage_height * 0.14, 1)
    max_y = round(stage_height * 0.90, 1)

    if cat in ("idle", "stand", "sit"):
        clip_state = "IDLE"
        period_ms = max(900.0, 2600.0 / speed)
        cycles = max(1, min(12, int(round(active_dur / period_ms))))
        step_ms = active_dur / float(cycles)
        amp_scale = 0.025 * intensity
        amp_y = 5.0 * intensity
        amp_head = 2.2 * intensity

        add_kf("character_instance", instance_id, "y", active_start, by, "ease_in_out")
        add_kf("character_instance", instance_id, "scale_y", active_start, bsy, "ease_in_out")
        if head_slot:
            add_part_rot(head_slot, active_start, 0.0, "ease_in_out")

        for c in range(cycles):
            t_mid = active_start + (c + 0.5) * step_ms
            t_end = active_start + (c + 1.0) * step_ms
            add_kf("character_instance", instance_id, "y", t_mid, by - amp_y, "ease_in_out")
            add_kf("character_instance", instance_id, "y", t_end, by, "ease_in_out")
            add_kf("character_instance", instance_id, "scale_y", t_mid, bsy * (1.0 + amp_scale), "ease_in_out")
            add_kf("character_instance", instance_id, "scale_y", t_end, bsy, "ease_in_out")
            if head_slot:
                add_part_rot(head_slot, t_mid, amp_head if c % 2 == 0 else -amp_head, "ease_in_out")
                add_part_rot(head_slot, t_end, 0.0, "ease_in_out")

        # Optional subtle natural blink during idle ONLY if rig genuinely supports eye_state
        if "eye_state" in caps.capabilities and active_dur >= 1200:
            blink_t = active_start + active_dur * 0.45
            add_kf("character_instance", instance_id, "eye_state", active_start, "open", "hold")
            add_kf("character_instance", instance_id, "eye_state", blink_t, "closed", "hold")
            add_kf("character_instance", instance_id, "eye_state", min(active_end, blink_t + 140), "open", "hold")

    elif cat in ("walk", "run"):
        is_run = cat == "run"
        clip_state = "RUNNING" if is_run else "WALKING"

        # Anti-slide stride synchronization: tie stride count directly to distance & tempo!
        base_cycle_ms = (420.0 if is_run else 640.0) / speed
        cycles = max(1, min(14, int(round(active_dur / base_cycle_ms))))
        cycle_ms = active_dur / float(cycles)

        raw_dx = _signed_distance(params)
        if raw_dx == 0.0 and params.direction != "in_place":
            # Default stride distance synchronized with step count to prevent skating
            stride_px = (125.0 if is_run else 85.0) * intensity
            raw_dx = stride_px * cycles * (-1.0 if params.direction in ("left", "backward") else 1.0)

        target_x = max(min_x, min(max_x, bx + raw_dx))
        if abs((bx + raw_dx) - target_x) > 1.0:
            warnings.append(
                f"Clamped walk/run end X from {round(bx + raw_dx)}px to visible stage margin ({round(target_x)}px)."
            )

        # Orient facing direction cleanly along horizontal movement
        eff_sx = bsx
        if target_x < bx - 4.0:
            eff_sx = -abs(bsx)
        elif target_x > bx + 4.0:
            eff_sx = abs(bsx)
        if eff_sx != bsx:
            add_kf("character_instance", instance_id, "scale_x", active_start, eff_sx, "hold")

        # Root X translation synchronized smoothly over exact cycle count
        move_easing: EasingType = easing if easing in ("linear", "ease_in_out", "ease_in", "ease_out") else "linear"
        add_kf("character_instance", instance_id, "x", active_start, bx, move_easing)
        add_kf("character_instance", instance_id, "x", active_end, target_x, "hold")

        # Subtle forward lean for run, slight sway for walk
        lean_deg = (7.5 if is_run else 2.2) * intensity * (1.0 if eff_sx >= 0 else -1.0)
        bounce_px = (18.0 if is_run else 10.0) * intensity
        leg_amp = (34.0 if is_run else 22.0) * intensity
        arm_amp = (30.0 if is_run else 17.0) * intensity

        add_kf("character_instance", instance_id, "y", active_start, by, "ease_out")
        add_kf("character_instance", instance_id, "rotation_deg", active_start, brot + lean_deg, "ease_in_out")
        add_part_rot(l_leg, active_start, 0.0, "ease_in_out")
        add_part_rot(r_leg, active_start, 0.0, "ease_in_out")
        add_part_rot(l_arm, active_start, 0.0, "ease_in_out")
        add_part_rot(r_arm, active_start, 0.0, "ease_in_out")

        for c in range(cycles):
            t0 = active_start + c * cycle_ms
            t_q1 = t0 + cycle_ms * 0.25
            t_q2 = t0 + cycle_ms * 0.50
            t_q3 = t0 + cycle_ms * 0.75
            t_q4 = t0 + cycle_ms

            # Double-frequency contact bounce (up at stride apex, planted at passing)
            add_kf("character_instance", instance_id, "y", t_q1, max(min_y, by - bounce_px), "ease_in")
            add_kf("character_instance", instance_id, "y", t_q2, by, "ease_out")
            add_kf("character_instance", instance_id, "y", t_q3, max(min_y, by - bounce_px), "ease_in")
            add_kf("character_instance", instance_id, "y", t_q4, by, "ease_out")

            # Opposite-phase leg stride & counter-phase arm swing around real pivots!
            add_part_rot(l_leg, t_q1, leg_amp, "ease_in_out")
            add_part_rot(r_leg, t_q1, -leg_amp, "ease_in_out")
            add_part_rot(l_arm, t_q1, -arm_amp, "ease_in_out")
            add_part_rot(r_arm, t_q1, arm_amp, "ease_in_out")

            add_part_rot(l_leg, t_q3, -leg_amp, "ease_in_out")
            add_part_rot(r_leg, t_q3, leg_amp, "ease_in_out")
            add_part_rot(l_arm, t_q3, arm_amp, "ease_in_out")
            add_part_rot(r_arm, t_q3, -arm_amp, "ease_in_out")

        # Return smoothly to neutral stance at motion end
        add_kf("character_instance", instance_id, "y", active_end, by, "hold")
        add_kf("character_instance", instance_id, "rotation_deg", active_end, brot, "ease_out")
        add_part_rot(l_leg, active_end, 0.0, "ease_out")
        add_part_rot(r_leg, active_end, 0.0, "ease_out")
        add_part_rot(l_arm, active_end, 0.0, "ease_out")
        add_part_rot(r_arm, active_end, 0.0, "ease_out")

    elif cat == "blink":
        clip_state = "IDLE"
        blink_len = max(90.0, min(260.0, 150.0 / speed))
        if params.loop and active_dur >= 1400:
            interval = max(1200.0, 2800.0 / speed)
            count = max(1, min(10, int(active_dur // interval)))
            add_kf("character_instance", instance_id, "eye_state", active_start, "open", "hold")
            for idx in range(count):
                t_close = active_start + idx * interval + min(300.0, interval * 0.25)
                if t_close + blink_len < active_end:
                    add_kf("character_instance", instance_id, "eye_state", t_close, "closed", "hold")
                    add_kf("character_instance", instance_id, "eye_state", t_close + blink_len, "open", "hold")
            add_kf("character_instance", instance_id, "eye_state", active_end, "open", "hold")
        else:
            t_close = active_start + max(60.0, (active_dur - blink_len) * 0.35)
            t_open = min(active_end, t_close + blink_len)
            add_kf("character_instance", instance_id, "eye_state", active_start, "open", "hold")
            add_kf("character_instance", instance_id, "eye_state", t_close, "closed", "hold")
            add_kf("character_instance", instance_id, "eye_state", t_open, "open", "hold")

    elif cat == "wave":
        clip_state = "IDLE"
        arm = r_arm if params.direction != "left" else (l_arm or r_arm)
        arm = arm or l_arm
        hand = r_hand if arm == r_arm else (l_hand or r_hand)
        sign = -1.0 if arm == r_arm else 1.0
        raise_deg = sign * 58.0 * intensity
        swing_deg = 22.0 * intensity

        waves = max(2, min(8, int(round((active_dur / 420.0) * speed))))
        t_raise = active_start + active_dur * 0.18
        t_lower_start = active_start + active_dur * 0.82
        wave_span = max(120.0, t_lower_start - t_raise)
        step = wave_span / float(waves)

        add_part_rot(arm, active_start, 0.0, "ease_out")
        add_part_rot(arm, t_raise, raise_deg, "ease_in_out")
        if hand:
            add_part_rot(hand, active_start, 0.0, "ease_out")
        if head_slot:
            add_part_rot(head_slot, active_start, 0.0, "ease_in_out")
            add_part_rot(head_slot, t_raise, -sign * 6.0 * intensity, "ease_in_out")

        for w in range(waves):
            t_w = t_raise + (w + 0.5) * step
            offset = swing_deg if w % 2 == 0 else -swing_deg
            add_part_rot(arm, t_w, raise_deg + offset, "ease_in_out")
            if hand:
                add_part_rot(hand, t_w, offset * 0.65, "ease_in_out")

        add_part_rot(arm, t_lower_start, raise_deg, "ease_in")
        add_part_rot(arm, active_end, 0.0, "ease_out")
        if hand:
            add_part_rot(hand, active_end, 0.0, "ease_out")
        if head_slot:
            add_part_rot(head_slot, active_end, 0.0, "ease_in_out")

    elif cat == "look":
        clip_state = "LISTENING"
        sign = -1.0 if params.direction in ("left", "up") else 1.0
        angle = sign * 15.0 * intensity
        t_hold_start = active_start + active_dur * 0.25
        t_hold_end = active_start + active_dur * 0.72
        add_part_rot(head_slot, active_start, 0.0, easing)
        add_part_rot(head_slot, t_hold_start, angle, "hold")
        add_part_rot(head_slot, t_hold_end, angle, easing)
        add_part_rot(head_slot, active_end, 0.0, "ease_out")

    elif cat == "turn":
        clip_state = "TRANSITION"
        target_sx = -abs(bsx) if params.direction == "left" else (abs(bsx) if params.direction == "right" else -bsx)
        t_mid = active_start + active_dur * 0.45
        add_kf("character_instance", instance_id, "scale_x", active_start, bsx, "ease_in")
        add_kf("character_instance", instance_id, "scale_x", t_mid, bsx * 0.12, "ease_out")
        add_kf("character_instance", instance_id, "scale_x", active_end, target_sx, "hold")
        if head_slot:
            add_part_rot(head_slot, active_start, 0.0, "ease_in_out")
            add_part_rot(head_slot, t_mid, 8.0 * intensity, "ease_in_out")
            add_part_rot(head_slot, active_end, 0.0, "ease_out")

    elif cat == "talk":
        clip_state = "SPEAKING"
        # Honest mouth-variant toggling (never claiming phoneme lip-sync!)
        mouth_variants = caps.mouth_variants
        open_key = "open" if "open" in mouth_variants else (
            next((v for v in mouth_variants if v != "closed"), "open")
        )
        closed_key = "closed" if "closed" in mouth_variants else "closed"
        flap_ms = max(130.0, 230.0 / speed)
        flaps = max(2, min(28, int(round(active_dur / flap_ms))))
        step = active_dur / float(flaps)

        add_kf("character_instance", instance_id, "mouth_state", active_start, closed_key, "hold")
        for idx in range(flaps):
            t_f = active_start + idx * step
            state_val = open_key if idx % 2 == 1 else closed_key
            add_kf("character_instance", instance_id, "mouth_state", t_f, state_val, "hold")
        add_kf("character_instance", instance_id, "mouth_state", active_end, closed_key, "hold")

        # Subtle conversational head nods if head slot exists
        if head_slot:
            nod_cycles = max(1, min(6, int(round(active_dur / 800.0))))
            nod_step = active_dur / float(nod_cycles)
            nod_deg = 4.8 * intensity
            add_part_rot(head_slot, active_start, 0.0, "ease_in_out")
            for n in range(nod_cycles):
                add_part_rot(head_slot, active_start + (n + 0.45) * nod_step, nod_deg, "ease_in_out")
                add_part_rot(head_slot, active_start + (n + 1.0) * nod_step, 0.0, "ease_in_out")

    elif cat == "jump":
        clip_state = "REACTING"
        jump_h = min(280.0, 105.0 * intensity)
        dx = _signed_distance(params) if params.direction in ("left", "right", "forward", "backward") else 0.0
        target_x = max(min_x, min(max_x, bx + dx))

        t_crouch = active_start + active_dur * 0.16
        t_takeoff = active_start + active_dur * 0.24
        t_apex = active_start + active_dur * 0.54
        t_land = active_start + active_dur * 0.84

        add_kf("character_instance", instance_id, "y", active_start, by, "ease_in_out")
        add_kf("character_instance", instance_id, "y", t_crouch, min(max_y, by + 16.0 * intensity), "ease_out")
        add_kf("character_instance", instance_id, "y", t_apex, max(min_y, by - jump_h), "ease_in")
        add_kf("character_instance", instance_id, "y", t_land, min(max_y, by + 12.0 * intensity), "ease_out")
        add_kf("character_instance", instance_id, "y", active_end, by, "hold")

        add_kf("character_instance", instance_id, "scale_y", active_start, bsy, "ease_in_out")
        add_kf("character_instance", instance_id, "scale_y", t_crouch, bsy * 0.88, "ease_out")
        add_kf("character_instance", instance_id, "scale_y", t_apex, bsy * 1.08, "ease_in")
        add_kf("character_instance", instance_id, "scale_y", t_land, bsy * 0.86, "ease_out")
        add_kf("character_instance", instance_id, "scale_y", active_end, bsy, "hold")

        if abs(target_x - bx) > 1.0:
            add_kf("character_instance", instance_id, "x", active_start, bx, "hold")
            add_kf("character_instance", instance_id, "x", t_takeoff, bx, "linear")
            add_kf("character_instance", instance_id, "x", t_land, target_x, "hold")

        # Arms lift & legs tuck on rigs that possess limbs
        add_part_rot(l_arm, active_start, 0.0, "ease_out")
        add_part_rot(r_arm, active_start, 0.0, "ease_out")
        add_part_rot(l_arm, t_apex, 42.0 * intensity, "ease_in_out")
        add_part_rot(r_arm, t_apex, -42.0 * intensity, "ease_in_out")
        add_part_rot(l_arm, active_end, 0.0, "ease_out")
        add_part_rot(r_arm, active_end, 0.0, "ease_out")

        add_part_rot(l_leg, active_start, 0.0, "ease_out")
        add_part_rot(r_leg, active_start, 0.0, "ease_out")
        add_part_rot(l_leg, t_apex, -20.0 * intensity, "ease_in_out")
        add_part_rot(r_leg, t_apex, 20.0 * intensity, "ease_in_out")
        add_part_rot(l_leg, active_end, 0.0, "ease_out")
        add_part_rot(r_leg, active_end, 0.0, "ease_out")

    elif cat == "fall":
        clip_state = "REACTING"
        drop_px = abs(params.distance_px) if abs(params.distance_px) > 10 else 160.0 * intensity
        end_y = min(max_y, by + drop_px)
        tilt_sign = -1.0 if params.direction == "left" else 1.0
        tilt_deg = tilt_sign * 72.0 * min(1.3, intensity)

        t_tip = active_start + active_dur * 0.20
        t_impact = active_start + active_dur * 0.78
        t_bounce = active_start + active_dur * 0.89

        add_kf("character_instance", instance_id, "y", active_start, by, "ease_in")
        add_kf("character_instance", instance_id, "y", t_impact, end_y, "ease_out")
        add_kf("character_instance", instance_id, "y", t_bounce, max(min_y, end_y - 16.0 * intensity), "ease_in")
        add_kf("character_instance", instance_id, "y", active_end, end_y, "hold")

        add_kf("character_instance", instance_id, "rotation_deg", active_start, brot, "ease_in")
        add_kf("character_instance", instance_id, "rotation_deg", t_tip, brot + tilt_deg * 0.25, "ease_in")
        add_kf("character_instance", instance_id, "rotation_deg", t_impact, brot + tilt_deg, "ease_out")
        add_kf("character_instance", instance_id, "rotation_deg", active_end, brot + tilt_deg * 0.92, "hold")

        if "scale_animation" in caps.capabilities:
            add_kf("character_instance", instance_id, "scale_y", active_start, bsy, "hold")
            add_kf("character_instance", instance_id, "scale_y", t_impact, bsy * 0.85, "ease_out")
            add_kf("character_instance", instance_id, "scale_y", active_end, bsy, "hold")

        # Flailing arms if rig supports arm_rotation
        add_part_rot(l_arm, active_start, 0.0, "ease_out")
        add_part_rot(r_arm, active_start, 0.0, "ease_out")
        add_part_rot(l_arm, t_impact * 0.5 + active_start * 0.5, 55.0 * intensity, "ease_in_out")
        add_part_rot(r_arm, t_impact * 0.5 + active_start * 0.5, -55.0 * intensity, "ease_in_out")
        add_part_rot(l_arm, active_end, 20.0 * intensity, "ease_out")
        add_part_rot(r_arm, active_end, -20.0 * intensity, "ease_out")

    elif cat == "react":
        clip_state = "REACTING"
        pop_px = 24.0 * intensity
        t_pop = active_start + active_dur * 0.22
        t_settle = active_start + active_dur * 0.58

        add_kf("character_instance", instance_id, "y", active_start, by, "ease_out")
        add_kf("character_instance", instance_id, "y", t_pop, max(min_y, by - pop_px), "ease_in")
        add_kf("character_instance", instance_id, "y", t_settle, by, "ease_out")
        add_kf("character_instance", instance_id, "y", active_end, by, "hold")

        add_kf("character_instance", instance_id, "scale_y", active_start, bsy, "ease_out")
        add_kf("character_instance", instance_id, "scale_y", t_pop, bsy * (1.0 + 0.08 * intensity), "ease_in")
        add_kf("character_instance", instance_id, "scale_y", t_settle, bsy * 0.96, "ease_out")
        add_kf("character_instance", instance_id, "scale_y", active_end, bsy, "hold")

        if head_slot:
            add_part_rot(head_slot, active_start, 0.0, "ease_out")
            add_part_rot(head_slot, t_pop, -10.0 * intensity, "ease_in_out")
            add_part_rot(head_slot, active_end, 0.0, "ease_out")
        if r_arm:
            add_part_rot(r_arm, active_start, 0.0, "ease_out")
            add_part_rot(r_arm, t_pop, -25.0 * intensity, "ease_in_out")
            add_part_rot(r_arm, active_end, 0.0, "ease_out")
        if l_arm:
            add_part_rot(l_arm, active_start, 0.0, "ease_out")
            add_part_rot(l_arm, t_pop, 25.0 * intensity, "ease_in_out")
            add_part_rot(l_arm, active_end, 0.0, "ease_out")

    else:
        # Generic fallback using body subtle movement if a custom preset has unknown category
        if body_slot:
            add_part_rot(body_slot, active_start, 0.0, easing)
            add_part_rot(body_slot, active_start + active_dur * 0.5, 6.0 * intensity, easing)
            add_part_rot(body_slot, active_end, 0.0, "ease_out")

    # Emit state clip metadata with procedural flags DISABLED when explicit keyframes already drive motion
    # (prevents double-bouncing / duplicate animation loops — Section 16!)
    clips.append(
        CharacterAnimationClip(
            clip_id=stable_anim_id("anim_clip", motion_id, instance_id),
            track_id=track_id,
            instance_id=instance_id,
            start_ms=active_start,
            end_ms=max(active_start + 100, active_end),
            animation_state=clip_state,
            procedural=ProceduralAnimationConfig(
                auto_blink=False,
                breathing=False,
                walk_bounce_px=0.0,
            ),
        )
    )

    keyframes.sort(key=lambda k: (k.time_ms, k.target_type, k.target_id, k.property))
    return keyframes, clips, warnings
