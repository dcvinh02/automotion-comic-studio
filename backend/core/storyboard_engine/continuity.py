"""Deterministic Continuity Analysis across consecutive Storyboard Shots.

Checks:
- Character screen position jumps without movement justification
- Character facing direction / 180-degree screen direction flips without turning action
- Entry & exit continuity (exited character still visible without re-entering)
- Character disappearance mid-dialogue in wide/medium shots
- Reaction shots referencing absent/invisible characters
- Unexpected scene location / environment shifts inside the same scene
- Prop continuity across consecutive shots
- Missing Library Character assets (never inventing assets)

Never auto-rewrites user content; produces reviewable `ContinuityWarning` objects.
"""

from __future__ import annotations

import hashlib
from collections import defaultdict

from schemas.storyboard import ContinuityWarning, ScreenPosition, StoryboardShot

_POS_INDEX: dict[ScreenPosition, int] = {
    "far_left": -3,
    "left": -2,
    "center_left": -1,
    "center": 0,
    "center_right": 1,
    "right": 2,
    "far_right": 3,
    "offscreen": 99,
}

_MOVEMENT_CUES = (
    "walk", "run", "cross", "move", "step", "rush", "dash", "jump", "approach", "slide", "enter", "reposition",
    "bước", "chạy", "đi qua", "di chuyển", "lao", "tiến", "lùi", "sang", "vào",
)

_TURN_CUES = (
    "turn", "spin", "look back", "look away", "pivot", "twist", "face", "glances", "reverse",
    "quay", "ngoái", "xoay", "nhìn sang", "quay đầu", "đối mặt",
)

_EXIT_CUES = (
    "exit", "leave", "leaves", "walk out", "walks out", "runs out", "disappear", "vanish", "depart",
    "rời đi", "rời khỏi", "bước ra", "đi khuất", "biến mất", "thoát ra",
)

_ENTER_CUES = (
    "enter", "enters", "return", "returns", "comes back", "steps back", "reappear", "arrives",
    "bước vào", "quay lại", "trở lại", "xuất hiện",
)

_PROP_RELEASE_CUES = (
    "drop", "drops", "put down", "puts down", "place", "places", "throw", "throws", "hand", "gives", "pocket", "hide",
    "đặt xuống", "thả", "ném", "cất", "trao", "đưa cho", "buông",
)


def _norm(text: str) -> str:
    return (text or "").strip().lower()


def _has_any(text: str, cues: tuple[str, ...]) -> bool:
    low = _norm(text)
    return any(c in low for c in cues)


def _stable_warning_id(scene_id: str, shot_id: str, category: str, detail_key: str) -> str:
    digest = hashlib.sha1(f"{scene_id}|{shot_id}|{category}|{detail_key}".encode("utf-8")).hexdigest()[:10]
    return f"cw_{digest}"


def _is_left_facing(facing: str) -> bool:
    return facing in ("left", "three_quarter_left")


def _is_right_facing(facing: str) -> bool:
    return facing in ("right", "three_quarter_right")


def _env_tokens(env: str) -> set[str]:
    stop = {
        "the", "a", "an", "in", "on", "at", "of", "and", "with", "to", "from", "near", "by", "under",
        "trong", "ngoài", "trên", "dưới", "của", "và", "với", "tại", "ở", "một", "các",
    }
    words = [w.strip(".,;:!?()[]\"'—-") for w in _norm(env).split()]
    return {w for w in words if len(w) >= 3 and w not in stop}


def analyze_storyboard_continuity(
    shots: list[StoryboardShot],
    existing_warnings: list[ContinuityWarning] | None = None,
) -> list[ContinuityWarning]:
    """Run deterministic continuity checks across all scenes and preserve reviewed/dismissed flags."""
    prev_flags = {
        w.warning_id: (w.reviewed, w.dismissed)
        for w in (existing_warnings or [])
    }
    warnings: list[ContinuityWarning] = []

    def add_warn(
        *,
        scene_id: str,
        shot_id: str,
        prev_shot_id: str | None,
        category: ContinuityWarning.__annotations__.get("category", "action_continuity"),
        severity: str,
        title: str,
        description: str,
        key: str,
    ) -> None:
        wid = _stable_warning_id(scene_id, shot_id, str(category), key)
        reviewed, dismissed = prev_flags.get(wid, (False, False))
        warnings.append(
            ContinuityWarning(
                warning_id=wid,
                scene_id=scene_id,
                shot_id=shot_id,
                previous_shot_id=prev_shot_id,
                category=category,  # type: ignore[arg-type]
                severity=severity,  # type: ignore[arg-type]
                title=title,
                description=description,
                reviewed=reviewed,
                dismissed=dismissed,
            )
        )

    shots_by_scene: dict[str, list[StoryboardShot]] = defaultdict(list)
    for shot in shots:
        shots_by_scene[shot.scene_id].append(shot)

    for scene_id, scene_shots in shots_by_scene.items():
        ordered = sorted(scene_shots, key=lambda s: (s.shot_order, s.start_time_ms))

        # Track speakers across the scene for mid-dialogue disappearance checks
        speaking_indices_by_char: dict[str, list[int]] = defaultdict(list)
        for idx, sh in enumerate(ordered):
            for ch in sh.characters:
                if ch.speaking:
                    speaking_indices_by_char[_norm(ch.character_name)].append(idx)
            for dlg in sh.dialogue_refs:
                if dlg.speaker_name:
                    speaking_indices_by_char[_norm(dlg.speaker_name)].append(idx)

        for idx, curr in enumerate(ordered):
            prev = ordered[idx - 1] if idx > 0 else None
            curr_chars = {_norm(c.character_name): c for c in curr.characters}

            # 1. Missing Library Character Asset checks
            for ch in curr.characters:
                if ch.is_missing_asset or not ch.library_character_id:
                    add_warn(
                        scene_id=scene_id,
                        shot_id=curr.shot_id,
                        prev_shot_id=None,
                        category="missing_character_asset",
                        severity="info",
                        title=f"Unlinked character asset: {ch.character_name}",
                        description=(
                            f"Shot {curr.shot_order} stages '{ch.character_name}', which is not yet linked to a "
                            "Character Library rig. Link an existing character before animating."
                        ),
                        key=f"missing_{_norm(ch.character_name)}",
                    )

            # 2. Reaction shot or dialogue referencing a character not visibly present
            for ch in curr.characters:
                if ch.reacting and not ch.visible:
                    add_warn(
                        scene_id=scene_id,
                        shot_id=curr.shot_id,
                        prev_shot_id=prev.shot_id if prev else None,
                        category="reaction_missing_character",
                        severity="warning",
                        title=f"Invisible reacting character: {ch.character_name}",
                        description=(
                            f"Shot {curr.shot_order} marks '{ch.character_name}' as reacting while visible=False."
                        ),
                        key=f"react_inv_{_norm(ch.character_name)}",
                    )

            for dlg in curr.dialogue_refs:
                spk = _norm(dlg.speaker_name)
                if spk and spk not in curr_chars and curr.shot_size not in ("insert", "pov"):
                    # Flag only if speaker isn't staged at all (neither onscreen nor explicitly offscreen)
                    add_warn(
                        scene_id=scene_id,
                        shot_id=curr.shot_id,
                        prev_shot_id=prev.shot_id if prev else None,
                        category="dialogue_gap",
                        severity="warning",
                        title=f"Dialogue speaker not staged: {dlg.speaker_name}",
                        description=(
                            f"Shot {curr.shot_order} references dialogue by '{dlg.speaker_name}', "
                            "but that character is not listed in the shot's character staging (even as offscreen)."
                        ),
                        key=f"dlg_missing_{spk}",
                    )

            if prev is None:
                continue

            prev_chars = {_norm(c.character_name): c for c in prev.characters}
            is_reverse_cut = (
                curr.shot_size == "over_the_shoulder"
                or prev.shot_size == "over_the_shoulder"
                or curr.camera_angle in ("over_the_shoulder", "pov")
            )

            # 3. Consecutive-shot per-character continuity checks
            for cname_norm, c_curr in curr_chars.items():
                c_prev = prev_chars.get(cname_norm)
                if c_prev is None:
                    continue

                combined_motion = f"{c_prev.action} {c_prev.movement} {c_curr.action} {c_curr.movement}"

                # 3a. Exited in previous shot yet still visible in current shot without re-entering
                if (
                    _has_any(f"{c_prev.action} {c_prev.movement}", _EXIT_CUES)
                    and c_curr.visible
                    and c_curr.screen_position != "offscreen"
                    and not _has_any(f"{c_curr.action} {c_curr.movement}", _ENTER_CUES)
                ):
                    add_warn(
                        scene_id=scene_id,
                        shot_id=curr.shot_id,
                        prev_shot_id=prev.shot_id,
                        category="entry_exit",
                        severity="warning",
                        title=f"Entry/Exit mismatch: {c_curr.character_name}",
                        description=(
                            f"'{c_curr.character_name}' appeared to exit in Shot {prev.shot_order} "
                            f"('{c_prev.movement or c_prev.action}'), yet remains visible in Shot {curr.shot_order} without re-entering."
                        ),
                        key=f"exit_{cname_norm}",
                    )

                if c_prev.visible and c_curr.visible:
                    p1 = _POS_INDEX.get(c_prev.screen_position, 0)
                    p2 = _POS_INDEX.get(c_curr.screen_position, 0)

                    # 3b. Large screen position jump (e.g., left -> right) without movement justification
                    if (
                        p1 != 99
                        and p2 != 99
                        and abs(p1 - p2) >= 3
                        and not is_reverse_cut
                        and not _has_any(combined_motion, _MOVEMENT_CUES)
                    ):
                        add_warn(
                            scene_id=scene_id,
                            shot_id=curr.shot_id,
                            prev_shot_id=prev.shot_id,
                            category="position_jump",
                            severity="warning",
                            title=f"Sudden screen position jump: {c_curr.character_name}",
                            description=(
                                f"'{c_curr.character_name}' shifts from {c_prev.screen_position} (Shot {prev.shot_order}) "
                                f"to {c_curr.screen_position} (Shot {curr.shot_order}) without a crossing/movement action."
                            ),
                            key=f"pos_{cname_norm}",
                        )

                    # 3c. Facing direction flip (180-degree rule / screen direction) without turning action
                    flipped = (
                        (_is_left_facing(c_prev.facing_direction) and _is_right_facing(c_curr.facing_direction))
                        or (_is_right_facing(c_prev.facing_direction) and _is_left_facing(c_curr.facing_direction))
                    )
                    if flipped and not is_reverse_cut and not _has_any(combined_motion, _TURN_CUES):
                        add_warn(
                            scene_id=scene_id,
                            shot_id=curr.shot_id,
                            prev_shot_id=prev.shot_id,
                            category="facing_flip",
                            severity="warning",
                            title=f"Facing / screen direction flip: {c_curr.character_name}",
                            description=(
                                f"'{c_curr.character_name}' changes facing from {c_prev.facing_direction} (Shot {prev.shot_order}) "
                                f"to {c_curr.facing_direction} (Shot {curr.shot_order}) without a turning action or reverse angle."
                            ),
                            key=f"facing_{cname_norm}",
                        )

            # 4. Character disappears during ongoing dialogue in wide/full/medium two-shot
            if curr.shot_size in ("extreme_wide", "wide", "full", "medium_full"):
                for cname_norm, c_prev in prev_chars.items():
                    if cname_norm in curr_chars:
                        continue
                    if _has_any(f"{c_prev.action} {c_prev.movement}", _EXIT_CUES):
                        continue
                    speak_idxs = speaking_indices_by_char.get(cname_norm, [])
                    speaks_before = any(i <= idx - 1 for i in speak_idxs)
                    speaks_after = any(i >= idx + 1 for i in speak_idxs)
                    if speaks_before and speaks_after:
                        add_warn(
                            scene_id=scene_id,
                            shot_id=curr.shot_id,
                            prev_shot_id=prev.shot_id,
                            category="character_disappearance",
                            severity="warning",
                            title=f"Character missing in wide shot: {c_prev.character_name}",
                            description=(
                                f"'{c_prev.character_name}' participates in dialogue before and after Shot {curr.shot_order} "
                                f"({curr.shot_size}), but disappears from staging without an exit action."
                            ),
                            key=f"disappear_{cname_norm}",
                        )

            # 5. Unexpected scene environment/location shift within the same scene
            prev_env = _env_tokens(prev.environment)
            curr_env = _env_tokens(curr.environment)
            if (
                len(prev_env) >= 2
                and len(curr_env) >= 2
                and len(prev_env & curr_env) == 0
                and curr.shot_size not in ("close_up", "extreme_close_up", "insert")
                and prev.transition_out == "cut"
            ):
                add_warn(
                    scene_id=scene_id,
                    shot_id=curr.shot_id,
                    prev_shot_id=prev.shot_id,
                    category="location_shift",
                    severity="info",
                    title=f"Possible environment shift (Shot {prev.shot_order} -> {curr.shot_order})",
                    description=(
                        f"Environment changed from '{prev.environment}' to '{curr.environment}' on a direct cut within the same scene."
                    ),
                    key=f"env_{prev.shot_order}_{curr.shot_order}",
                )

            # 6. Prop continuity across same-character consecutive shots
            if prev.props_in_shot and curr.shot_size not in ("extreme_wide", "wide"):
                shared_visible = {
                    n for n, c in curr_chars.items() if c.visible and n in prev_chars and prev_chars[n].visible
                }
                curr_props_norm = {_norm(p) for p in curr.props_in_shot}
                action_blob = " ".join(
                    f"{c.action} {c.movement}" for c in [*prev.characters, *curr.characters]
                )
                if shared_visible and not _has_any(action_blob, _PROP_RELEASE_CUES):
                    for prop in prev.props_in_shot:
                        pn = _norm(prop)
                        if pn and pn not in curr_props_norm and pn in _norm(curr.visual_focus + " " + curr.purpose):
                            add_warn(
                                scene_id=scene_id,
                                shot_id=curr.shot_id,
                                prev_shot_id=prev.shot_id,
                                category="prop_continuity",
                                severity="info",
                                title=f"Prop tracking check: {prop}",
                                description=(
                                    f"Prop '{prop}' appeared in Shot {prev.shot_order} and is referenced in Shot {curr.shot_order}'s focus, "
                                    "but is missing from props_in_shot."
                                ),
                                key=f"prop_{pn}",
                            )

    return warnings
