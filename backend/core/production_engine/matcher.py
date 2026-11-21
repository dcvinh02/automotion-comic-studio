"""Deterministic Asset Matching, License-Safe Audio Matching, Animation Capability Mapping & Readiness Checker.

Strictly grounded against real `library.db` and `project.db` records:
- Never fabricates asset IDs, character IDs, or sound IDs
- Never auto-selects unverified / copyrighted music
- Never claims unsupported animations or unsupported camera actions are executable
- Flags ambiguous matches (`requires_review`) when multiple library items score similarly
"""

from __future__ import annotations

import re
import uuid
from typing import Any

from schemas.asset import Asset
from schemas.character import Character
from schemas.production import (
    AnimationActionCategory,
    AnimationActionPlan,
    AssetMatchCandidate,
    AssetMatchClassification,
    AssetMatchItem,
    AssetRequirementKind,
    AudioPlanItem,
    AudioSuggestionType,
    ExecutionCapability,
    MissingDependency,
    ProductionReadinessStatus,
    ProductionShotPlan,
)
from schemas.sound import SoundAsset

_STOP_WORDS = {
    "the", "and", "with", "from", "near", "into", "over", "under", "shot", "scene", "angle", "view",
    "trong", "ngoài", "trên", "dưới", "của", "và", "với", "tại", "một", "các", "cảnh", "nhỏ", "lớn",
}

# Bilingual semantic hints to improve genuine matching without forcing unrelated assets
_SEMANTIC_SYNONYMS: dict[str, set[str]] = {
    "rain": {"mưa", "rain", "storm", "wet", "puddle", "drizzle"},
    "wind": {"gió", "wind", "breeze", "gale"},
    "thunder": {"sấm", "sét", "thunder", "lightning"},
    "footsteps": {"bước", "footstep", "footsteps", "walk", "walking", "step"},
    "running": {"chạy", "run", "running", "sprint", "dash"},
    "door": {"cửa", "door", "doors", "knock", "open", "slam"},
    "city": {"thành phố", "hẻm", "alley", "street", "neon", "urban", "phố"},
    "night": {"đêm", "night", "midnight", "dark", "tối", "khuya"},
    "suspense": {"hồi hộp", "căng thẳng", "bí ẩn", "suspense", "mystery", "noir", "tense", "dread"},
    "dramatic": {"kịch tính", "cao trào", "dramatic", "climax", "intense"},
    "sad": {"buồn", "sad", "melancholy", "grief", "cry"},
    "happy": {"vui", "happy", "bright", "cheerful"},
    "action": {"hành động", "action", "chase", "fight", "battle"},
    "calm": {"bình tĩnh", "êm dịu", "calm", "quiet", "peaceful", "ambient"},
    "impact": {"va chạm", "đập", "impact", "hit", "punch", "thud"},
}


def _norm(text: str) -> str:
    return (text or "").strip().lower()


def _tokens(text: str) -> set[str]:
    raw = re.findall(r"[0-9a-zA-ZÀ-ỹ_]+", _norm(text))
    toks = {t for t in raw if len(t) >= 2 and t not in _STOP_WORDS}
    expanded = set(toks)
    for key, syns in _SEMANTIC_SYNONYMS.items():
        if toks & syns:
            # Add ONLY the single canonical semantic concept key so 1 shared adjective
            # never inflates recall across 6 synonym tokens!
            expanded.add(key)
    return expanded


def _score_overlap(query_toks: set[str], target_text: str, extra_tags: list[str] | None = None) -> float:
    if not query_toks:
        return 0.0
    target_toks = _tokens(target_text)
    if extra_tags:
        for tg in extra_tags:
            target_toks |= _tokens(tg)
    if not target_toks:
        return 0.0
    shared = query_toks & target_toks
    if not shared:
        return 0.0
    # Weighted recall + Jaccard blend so short descriptive names score fairly
    recall = len(shared) / max(1, min(len(query_toks), 6))
    jaccard = len(shared) / max(1, len(query_toks | target_toks))
    return min(1.0, round(0.65 * min(1.0, recall) + 0.35 * jaccard, 3))


# --- 1. Asset Matching ---


def match_asset_requirement(
    *,
    kind: AssetRequirementKind,
    label: str,
    query: str,
    assets: list[Asset],
    required: bool = True,
    specialized_art_note: str = "",
) -> AssetMatchItem:
    """Match a background, prop, or effect requirement against real `Asset`s in `library.db`."""
    req_id = f"areq_{uuid.uuid4().hex[:8]}"

    if specialized_art_note:
        # e.g., Bird's-eye / Worm's-eye dedicated background art check
        pass

    # Filter strictly by compatible AssetType so unrelated asset types are NEVER auto-selected
    if kind == "background":
        pool = [a for a in assets if a.type == "background"]
    elif kind == "prop":
        pool = [a for a in assets if a.type == "prop"]
    elif kind == "character_part":
        pool = [a for a in assets if a.type == "character_part"]
    else:
        pool = [a for a in assets if a.type in ("prop", "spritesheet")]

    q_toks = _tokens(f"{label} {query}")
    scored: list[tuple[float, Asset]] = []
    for ast in pool:
        # Exact name match gets top score
        if _norm(ast.name) == _norm(label) or (_norm(query) and _norm(ast.name) == _norm(query)):
            score = 0.98
        else:
            score = _score_overlap(q_toks, f"{ast.name} {ast.folder}", ast.tags)
        if score >= 0.38:
            scored.append((score, ast))

    scored.sort(key=lambda x: (-x[0], x[1].name))
    top_candidates = [
        AssetMatchCandidate(
            asset_id=a.asset_id,
            name=a.name,
            asset_type=a.type,
            score=sc,
            reason=f"Matched {a.type} '{a.name}' (score {int(sc * 100)}%)",
        )
        for sc, a in scored[:4]
    ]

    if not top_candidates:
        classification: AssetMatchClassification = (
            "requires_new_asset" if specialized_art_note else "missing"
        )
        return AssetMatchItem(
            requirement_id=req_id,
            kind=kind,
            label=label,
            query=query,
            classification=classification,
            matched_asset_id=None,
            matched_asset_name="",
            candidates=[],
            required=required,
            notes=specialized_art_note or f"No matching {kind} asset found in Asset Library.",
        )

    best_score, best_asset = scored[0]
    second_score = scored[1][0] if len(scored) >= 2 else 0.0

    # Ambiguous match: two or more distinct assets have nearly identical strong scores -> requires_review!
    if len(scored) >= 2 and best_score >= 0.45 and abs(best_score - second_score) <= 0.08 and best_score < 0.95:
        return AssetMatchItem(
            requirement_id=req_id,
            kind=kind,
            label=label,
            query=query,
            classification="requires_review",
            matched_asset_id=None,
            matched_asset_name="",
            candidates=top_candidates,
            required=required,
            notes="Multiple similarly matching assets found — please pick the intended asset.",
        )

    if best_score >= 0.62 and not specialized_art_note:
        return AssetMatchItem(
            requirement_id=req_id,
            kind=kind,
            label=label,
            query=query,
            classification="existing_compatible",
            matched_asset_id=best_asset.asset_id,
            matched_asset_name=best_asset.name,
            candidates=top_candidates,
            required=required,
            notes=f"Matched compatible {kind} asset '{best_asset.name}'.",
        )

    return AssetMatchItem(
        requirement_id=req_id,
        kind=kind,
        label=label,
        query=query,
        classification="existing_potentially_compatible",
        matched_asset_id=best_asset.asset_id,
        matched_asset_name=best_asset.name,
        candidates=top_candidates,
        required=required,
        notes=specialized_art_note or f"Partial semantic match to '{best_asset.name}'; verify before applying.",
    )


# --- 2. License-Safe Audio Matching ---


def is_sound_license_safe(sound: SoundAsset) -> tuple[bool, str]:
    """Never auto-place copyrighted or unverified music."""
    if sound.is_bundled:
        return True, f"Bundled starter pack ({sound.license.source.upper()})"
    if sound.license.usage == "verified" and sound.license.source in ("cc0", "royalty_free", "user_imported", "cc_by"):
        return True, f"Verified license ({sound.license.source})"
    return False, f"Unverified license ({sound.license.source}/{sound.license.usage}) — skipped for auto-placement."


def match_audio_requirement(
    *,
    audio_type: AudioSuggestionType,
    category: str,
    description: str,
    sounds: list[SoundAsset],
    offset_ms: int = 0,
    duration_ms: int | None = None,
    volume: float = 0.8,
    fade_in_ms: int = 0,
    fade_out_ms: int = 0,
    loop: bool = False,
) -> AudioPlanItem:
    """Match an SFX/BGM/Ambient cue strictly against license-safe real `SoundAsset`s."""
    plan_id = f"audp_{uuid.uuid4().hex[:8]}"

    # Filter strictly by SFX vs BGM separation and license safety
    want_type = "bgm" if audio_type == "bgm" else "sfx"
    safe_pool: list[SoundAsset] = []
    for snd in sounds:
        snd_type = snd.audio_type or "sfx"
        if audio_type == "bgm" and snd_type != "bgm":
            continue
        if audio_type == "sfx" and snd_type != "sfx":
            continue
        if audio_type == "ambient" and snd_type not in ("sfx", "bgm"):
            continue
        ok, _ = is_sound_license_safe(snd)
        if ok:
            safe_pool.append(snd)

    q_toks = _tokens(f"{category} {description}")
    cat_norm = _norm(category)
    scored: list[tuple[float, SoundAsset]] = []

    for snd in safe_pool:
        score = _score_overlap(q_toks, f"{snd.name} {snd.category}", snd.tags)
        if cat_norm and _norm(snd.category) == cat_norm:
            score = min(1.0, max(score, 0.72) + 0.18)
        if score >= 0.28:
            scored.append((round(score, 3), snd))

    scored.sort(key=lambda x: (-x[0], x[1].name))
    candidates = [
        AssetMatchCandidate(
            asset_id=s.sound_id,
            name=s.name,
            asset_type=f"{s.audio_type}:{s.category}",
            score=sc,
            reason=f"{s.category} ({s.license.source.upper()})",
        )
        for sc, s in scored[:4]
    ]

    if not candidates:
        return AudioPlanItem(
            audio_plan_id=plan_id,
            audio_type=audio_type,
            category=category,
            description=description,
            match_classification="missing",
            matched_sound_id=None,
            matched_sound_name="",
            license_verified=False,
            license_note="",
            candidates=[],
            offset_ms=offset_ms,
            duration_ms=duration_ms,
            volume=volume,
            fade_in_ms=fade_in_ms,
            fade_out_ms=fade_out_ms,
            loop=loop,
            notes=f"No verified license-safe {audio_type.upper()} matched '{category or description}'. Search or import in Audio Library.",
        )

    best_score, best_snd = scored[0]
    ok, lic_note = is_sound_license_safe(best_snd)
    classification: AssetMatchClassification = (
        "existing_compatible" if best_score >= 0.6 else "existing_potentially_compatible"
    )
    return AudioPlanItem(
        audio_plan_id=plan_id,
        audio_type=audio_type,
        category=category or best_snd.category,
        description=description,
        match_classification=classification,
        matched_sound_id=best_snd.sound_id,
        matched_sound_name=best_snd.name,
        license_verified=ok,
        license_note=lic_note,
        candidates=candidates,
        offset_ms=offset_ms,
        duration_ms=duration_ms or best_snd.duration_ms,
        volume=volume,
        fade_in_ms=fade_in_ms,
        fade_out_ms=fade_out_ms,
        loop=loop or best_snd.loopable if audio_type in ("bgm", "ambient") else False,
        notes=f"Matched verified audio '{best_snd.name}' ({lic_note}).",
    )


# --- 3. Animation Capability Mapping ---


_ACTION_KEYWORDS: list[tuple[AnimationActionCategory, tuple[str, ...]]] = [
    ("run", ("run", "sprint", "dash", "chạy", "lao nhanh")),
    ("walk", ("walk", "step", "approach", "cross", "stroll", "bước", "đi bộ", "đi tới", "tiến tới")),
    ("talk", ("talk", "speak", "say", "shout", "whisper", "warn", "nói", "cảnh báo", "hét", "thì thầm", "hỏi")),
    ("wave", ("wave", "raise hand", "beckon", "vẫy", "giơ tay")),
    ("blink", ("blink", "wink", "chớp mắt")),
    ("jump", ("jump", "leap", "hop", "nhảy", "bật")),
    ("fall", ("fall", "collapse", "drop down", "tumble", "ngã", "rơi xuống", "gục")),
    ("attack", ("attack", "punch", "kick", "slash", "strike", "shoot", "tấn công", "đấm", "đá", "chém")),
    ("sit", ("sit", "seated", "ngồi")),
    ("turn", ("turn", "spin", "pivot", "quay lại", "quay đầu", "xoay người")),
    ("look", ("look", "glance", "stare", "gaze", "nhìn", "liếc", "quan sát")),
    ("react", ("react", "flinch", "startle", "shock", "surprise", "giật mình", "bất ngờ", "phản ứng", "sốc")),
    ("stand", ("stand", "stands", "đứng")),
    ("idle", ("idle", "wait", "breathe", "still", "chờ", "đứng yên", "thở")),
]


def infer_animation_category(action_text: str, speaking: bool = False, reacting: bool = False) -> AnimationActionCategory:
    low = _norm(action_text)
    if low:
        for cat, cues in _ACTION_KEYWORDS:
            if any(c in low for c in cues):
                return cat
    if speaking:
        return "talk"
    if reacting:
        return "react"
    return "idle"


def map_animation_action(
    *,
    character_name: str,
    character: Character | None,
    category: AnimationActionCategory,
    description: str,
    duration_ms: int,
    direction_hint: str = "",
) -> AnimationActionPlan:
    """Honest mapping from an animation action to real Cutout Rig & Timeline capabilities."""
    aid = f"anim_{uuid.uuid4().hex[:8]}"
    parts = character.parts if character else []
    part_roles = {p.part_role for p in parts}
    eyes_slot = next((p for p in parts if p.part_role == "eyes"), None)
    mouth_slot = next((p for p in parts if p.part_role == "mouth"), None)
    poses_norm = {_norm(p.name): p for p in (character.poses if character else [])}

    if character is None:
        return AnimationActionPlan(
            action_plan_id=aid,
            character_name=character_name,
            library_character_id=None,
            category=category,
            description=description,
            supported=False,
            required_rig=True,
            required_parts=["character_rig"],
            missing_parts=["character_rig"],
            estimated_duration_ms=max(400, duration_ms),
            unsupported_reason=f"Character '{character_name}' is not linked to a Character Library rig.",
            manual_alternative="Link an existing Character or create one in Character Builder.",
        )

    if len(parts) == 0:
        return AnimationActionPlan(
            action_plan_id=aid,
            character_name=character_name,
            library_character_id=character.character_id,
            category=category,
            description=description,
            supported=False,
            required_rig=True,
            required_parts=["body"],
            missing_parts=["body"],
            estimated_duration_ms=max(400, duration_ms),
            unsupported_reason=f"Character '{character.name}' has 0 PNG rig parts assembled.",
            manual_alternative="Assemble transparent PNG body parts in Cutout Rig Editor.",
        )

    if category in ("idle", "stand"):
        return AnimationActionPlan(
            action_plan_id=aid,
            character_name=character_name,
            library_character_id=character.character_id,
            category=category,
            description=description or "Idle breathing",
            supported=True,
            mapped_animation_state="IDLE",
            mapped_preset_id="idle_breathe",
            required_rig=True,
            required_parts=["body"],
            missing_parts=[],
            parameters={"breathing": True, "auto_blink": bool(eyes_slot and "closed" in eyes_slot.variants)},
            estimated_duration_ms=max(800, duration_ms),
        )

    if category == "walk":
        missing = [r for r in ("left_leg", "right_leg") if r not in part_roles]
        move_dir = "left" if "left" in _norm(direction_hint) or "trái" in _norm(direction_hint) else "right"
        return AnimationActionPlan(
            action_plan_id=aid,
            character_name=character_name,
            library_character_id=character.character_id,
            category="walk",
            description=description or "Walk cycle",
            supported=True,
            mapped_animation_state="WALKING",
            mapped_preset_id="walk_cycle",
            required_rig=True,
            required_parts=["left_leg", "right_leg"],
            missing_parts=missing,
            parameters={"direction": move_dir, "walk_cycle_ms": 600, "walk_bounce_px": 12},
            estimated_duration_ms=max(1000, duration_ms),
            unsupported_reason=(
                "Rig lacks left_leg/right_leg parts; only root walk bounce + horizontal translation will run."
                if missing
                else ""
            ),
        )

    if category == "run":
        missing = [r for r in ("left_leg", "right_leg") if r not in part_roles]
        move_dir = "left" if "left" in _norm(direction_hint) or "trái" in _norm(direction_hint) else "right"
        return AnimationActionPlan(
            action_plan_id=aid,
            character_name=character_name,
            library_character_id=character.character_id,
            category="run",
            description=description or "Run cycle",
            supported=True,
            mapped_animation_state="RUNNING",
            mapped_preset_id="move_left" if move_dir == "left" else "move_right",
            required_rig=True,
            required_parts=["left_leg", "right_leg"],
            missing_parts=missing,
            parameters={"direction": move_dir, "walk_cycle_ms": 420, "walk_bounce_px": 18},
            estimated_duration_ms=max(800, duration_ms),
            unsupported_reason=(
                "Rig lacks leg parts; root sprint translation will run without limb swing."
                if missing
                else ""
            ),
        )

    if category == "blink":
        has_closed = bool(eyes_slot and "closed" in eyes_slot.variants)
        return AnimationActionPlan(
            action_plan_id=aid,
            character_name=character_name,
            library_character_id=character.character_id,
            category="blink",
            description=description or "Eye blink",
            supported=has_closed,
            mapped_animation_state="IDLE" if has_closed else None,
            required_rig=True,
            required_parts=["eyes:closed"],
            missing_parts=[] if has_closed else ["eyes:closed"],
            parameters={"auto_blink": True, "blink_duration_ms": 140},
            estimated_duration_ms=max(500, min(duration_ms, 1500)),
            unsupported_reason="" if has_closed else "Rig lacks an `eyes` part with a `closed` variant PNG.",
            manual_alternative="" if has_closed else "Add a `closed` eye variant in Cutout Rig Editor.",
        )

    if category == "talk":
        has_mouth = bool(mouth_slot and ("open" in mouth_slot.variants or len(mouth_slot.variants) >= 2))
        return AnimationActionPlan(
            action_plan_id=aid,
            character_name=character_name,
            library_character_id=character.character_id,
            category="talk",
            description=description or "Speaking animation",
            supported=True,
            mapped_animation_state="SPEAKING",
            required_rig=True,
            required_parts=["mouth:open"],
            missing_parts=[] if has_mouth else ["mouth:open"],
            parameters={"mouth_toggle_ms": 220, "has_mouth_variants": has_mouth},
            estimated_duration_ms=max(800, duration_ms),
            unsupported_reason=(
                ""
                if has_mouth
                else "Rig lacks a `mouth` `open` variant; SPEAKING state clip will apply without visible lip flaps."
            ),
            manual_alternative="" if has_mouth else "Add `open`/`closed` mouth variants in Cutout Rig Editor.",
        )

    if category == "wave":
        arm_slot = next((p for p in parts if p.part_role in ("right_arm", "left_arm")), None)
        return AnimationActionPlan(
            action_plan_id=aid,
            character_name=character_name,
            library_character_id=character.character_id,
            category="wave",
            description=description or "Arm wave",
            supported=arm_slot is not None,
            mapped_animation_state="IDLE",
            mapped_preset_id="part_wave" if arm_slot else None,
            required_rig=True,
            required_parts=["right_arm|left_arm"],
            missing_parts=[] if arm_slot else ["right_arm|left_arm"],
            parameters={"arm_slot_id": arm_slot.slot_id if arm_slot else None, "swing_deg": 28},
            estimated_duration_ms=max(800, min(duration_ms, 2400)),
            unsupported_reason="" if arm_slot else "Rig has no `right_arm` or `left_arm` cutout part.",
            manual_alternative="" if arm_slot else "Add an arm part slot in Cutout Rig Editor or animate manually.",
        )

    if category == "look":
        head_slot = next((p for p in parts if p.part_role == "head"), None)
        return AnimationActionPlan(
            action_plan_id=aid,
            character_name=character_name,
            library_character_id=character.character_id,
            category="look",
            description=description or "Head turn / look",
            supported=head_slot is not None,
            mapped_animation_state="LISTENING",
            mapped_preset_id="part_head_tilt" if head_slot else None,
            required_rig=True,
            required_parts=["head"],
            missing_parts=[] if head_slot else ["head"],
            parameters={"head_slot_id": head_slot.slot_id if head_slot else None, "tilt_deg": 10},
            estimated_duration_ms=max(600, min(duration_ms, 1800)),
            unsupported_reason="" if head_slot else "Rig has no `head` cutout part for independent head rotation.",
            manual_alternative="" if head_slot else "Add a `head` part in Cutout Rig Editor.",
        )

    if category == "turn":
        return AnimationActionPlan(
            action_plan_id=aid,
            character_name=character_name,
            library_character_id=character.character_id,
            category="turn",
            description=description or "2D horizontal facing flip",
            supported=True,
            mapped_animation_state="TRANSITION",
            mapped_preset_id="flip_horizontal",
            required_rig=True,
            required_parts=["body"],
            missing_parts=[],
            parameters={"scale_x_flip": True},
            estimated_duration_ms=max(400, min(duration_ms, 900)),
            unsupported_reason="Executes as 2D horizontal mirror flip (scale_x sign); true 3D turnaround requires separate art.",
        )

    if category == "jump":
        return AnimationActionPlan(
            action_plan_id=aid,
            character_name=character_name,
            library_character_id=character.character_id,
            category="jump",
            description=description or "Jump bounce",
            supported=True,
            mapped_animation_state="REACTING",
            mapped_preset_id="bounce",
            required_rig=True,
            required_parts=["body"],
            missing_parts=[],
            parameters={"bounce_height_px": 95},
            estimated_duration_ms=max(700, min(duration_ms, 1500)),
        )

    if category == "react":
        return AnimationActionPlan(
            action_plan_id=aid,
            character_name=character_name,
            library_character_id=character.character_id,
            category="react",
            description=description or "Reaction beat",
            supported=True,
            mapped_animation_state="REACTING",
            required_rig=True,
            required_parts=["body"],
            missing_parts=[],
            parameters={"react_bounce_px": 18},
            estimated_duration_ms=max(600, min(duration_ms, 1800)),
        )

    if category == "sit":
        sit_pose = next((p for k, p in poses_norm.items() if "sit" in k or "ngồi" in k), None)
        if sit_pose:
            return AnimationActionPlan(
                action_plan_id=aid,
                character_name=character_name,
                library_character_id=character.character_id,
                category="sit",
                description=description or f"Sitting pose ({sit_pose.name})",
                supported=True,
                mapped_animation_state="IDLE",
                required_rig=True,
                required_parts=["body"],
                missing_parts=[],
                parameters={"pose_id": sit_pose.pose_id},
                estimated_duration_ms=max(800, duration_ms),
            )
        return AnimationActionPlan(
            action_plan_id=aid,
            character_name=character_name,
            library_character_id=character.character_id,
            category="sit",
            description=description or "Sit down",
            supported=False,
            required_rig=True,
            required_parts=["pose:sit"],
            missing_parts=["pose:sit"],
            estimated_duration_ms=max(800, duration_ms),
            unsupported_reason="No sitting Pose Preset exists on this character rig.",
            manual_alternative="Create a 'Sit' pose preset in Cutout Rig Editor or keyframe leg joints manually.",
        )

    if category == "fall":
        return AnimationActionPlan(
            action_plan_id=aid,
            character_name=character_name,
            library_character_id=character.character_id,
            category="fall",
            description=description or "Fall / drop",
            supported=True,
            mapped_animation_state="REACTING",
            mapped_preset_id="motion_fall",
            required_rig=True,
            required_parts=["body"],
            missing_parts=[],
            parameters={"distance_px": 180, "direction": "down"},
            estimated_duration_ms=max(600, min(duration_ms, 2400)),
        )

    # attack, custom -> honestly unsupported for automated execution!
    reason_map = {
        "attack": "Combat/attack choreography requires custom pose keyframes and smear/weapon layers.",
        "custom": "Custom action cannot be mapped automatically to a built-in 2D animation preset.",
    }
    alt_map = {
        "attack": "Create custom attack pose presets in Cutout Rig Editor and keyframe impact timing manually.",
        "custom": "Animate manually using Character/Part keyframes on the Master Timeline.",
    }
    return AnimationActionPlan(
        action_plan_id=aid,
        character_name=character_name,
        library_character_id=character.character_id,
        category=category,
        description=description or category,
        supported=False,
        required_rig=True,
        required_parts=[],
        missing_parts=[],
        estimated_duration_ms=max(800, duration_ms),
        unsupported_reason=reason_map.get(category, "Action not natively automated."),
        manual_alternative=alt_map.get(category, "Keyframe manually on the Master Timeline."),
    )


# --- 4. Real Data-Driven Production Readiness Checker ---


def evaluate_shot_readiness(
    shot: ProductionShotPlan,
    *,
    characters_by_id: dict[str, Character],
    assets_by_id: dict[str, Asset],
    sounds_by_id: dict[str, SoundAsset],
) -> ProductionShotPlan:
    """Inspect real project & library records to compute exact readiness, dependencies & capability."""
    deps: list[MissingDependency] = []
    reasons: list[str] = []

    def add_dep(
        kind: MissingDependency.__annotations__.get("kind", "asset"),
        severity: str,
        label: str,
        reason: str,
        action: str,
    ) -> None:
        deps.append(
            MissingDependency(
                dependency_id=f"dep_{uuid.uuid4().hex[:7]}",
                kind=kind,  # type: ignore[arg-type]
                severity=severity,  # type: ignore[arg-type]
                label=label,
                reason=reason,
                suggested_action=action,
            )
        )
        reasons.append(reason)

    # 1. Validate Characters & Rigs against real `library.db`
    updated_chars = []
    has_missing_char = False
    has_missing_rig = False
    for ch in shot.characters:
        lib_ch = characters_by_id.get(ch.library_character_id) if ch.library_character_id else None
        if lib_ch is None:
            has_missing_char = True
            updated_chars.append(
                ch.model_copy(
                    update={
                        "library_character_id": None,
                        "character_missing": True,
                        "rig_missing": True,
                        "suggestion_note": "Link an existing Character Library item or create a new character in Character Builder.",
                    }
                )
            )
            add_dep(
                "character",
                "blocking",
                ch.character_name,
                f"Character '{ch.character_name}' is not linked to a real Character Library record.",
                "Link an existing character or create one in Character Builder.",
            )
        elif len(lib_ch.parts) == 0:
            has_missing_rig = True
            updated_chars.append(
                ch.model_copy(
                    update={
                        "character_missing": False,
                        "rig_missing": True,
                        "suggestion_note": f"Character '{lib_ch.name}' has no assembled PNG rig parts.",
                    }
                )
            )
            add_dep(
                "rig",
                "blocking",
                lib_ch.name,
                f"Character '{lib_ch.name}' has 0 assembled rig parts.",
                "Assemble transparent PNG parts in Cutout Rig Editor.",
            )
        else:
            updated_chars.append(
                ch.model_copy(
                    update={"character_missing": False, "rig_missing": False}
                )
            )

    # 2. Validate Background & Prop Asset Matches (never accept stale/invalid asset IDs!)
    has_missing_asset = False
    has_ambiguous_review = False

    def _validate_asset(item: AssetMatchItem) -> AssetMatchItem:
        nonlocal has_missing_asset, has_ambiguous_review
        if item.matched_asset_id and item.matched_asset_id not in assets_by_id:
            item = item.model_copy(
                update={
                    "matched_asset_id": None,
                    "matched_asset_name": "",
                    "classification": "missing",
                    "notes": "Previously referenced asset ID no longer exists in Asset Library.",
                }
            )
        if item.classification in ("missing", "requires_new_asset") and item.required:
            has_missing_asset = True
            add_dep(
                "asset",
                "warning",
                item.label,
                f"Missing {item.kind} asset: {item.label}.",
                "Import a matching PNG asset or assign one from Asset Library.",
            )
        elif item.classification == "requires_review":
            has_ambiguous_review = True
            add_dep(
                "review",
                "warning",
                item.label,
                f"Ambiguous {item.kind} match for '{item.label}' — user selection required.",
                "Choose the intended asset from the matched candidates.",
            )
        return item

    updated_bg = _validate_asset(shot.background) if shot.background else None
    updated_assets = [_validate_asset(a) for a in shot.assets]

    # 3. Validate Animation Plans
    has_unsupported_anim = False
    has_missing_anim_parts = False
    updated_anims: list[AnimationActionPlan] = []
    for ap in shot.animation_plans:
        lib_ch = characters_by_id.get(ap.library_character_id) if ap.library_character_id else None
        # Re-evaluate against live rig if character exists
        if lib_ch is not None and ap.library_character_id:
            remapped = map_animation_action(
                character_name=ap.character_name,
                character=lib_ch,
                category=ap.category,
                description=ap.description,
                duration_ms=ap.estimated_duration_ms,
                direction_hint=str(ap.parameters.get("direction", "")),
            )
            ap = ap.model_copy(
                update={
                    "supported": remapped.supported,
                    "mapped_animation_state": remapped.mapped_animation_state,
                    "mapped_preset_id": remapped.mapped_preset_id,
                    "required_parts": remapped.required_parts,
                    "missing_parts": remapped.missing_parts,
                    "unsupported_reason": remapped.unsupported_reason,
                    "manual_alternative": remapped.manual_alternative,
                }
            )
        updated_anims.append(ap)
        if not ap.supported:
            has_unsupported_anim = True
            add_dep(
                "animation",
                "warning",
                f"{ap.character_name}: {ap.category}",
                ap.unsupported_reason or f"Animation '{ap.category}' is not natively supported.",
                ap.manual_alternative or "Keyframe this action manually on the Timeline.",
            )
        elif ap.missing_parts:
            has_missing_anim_parts = True
            add_dep(
                "rig",
                "info",
                f"{ap.character_name}: {', '.join(ap.missing_parts)}",
                ap.unsupported_reason or f"Missing optional rig parts: {', '.join(ap.missing_parts)}.",
                "Add missing body part slots or variants in Cutout Rig Editor for full motion.",
            )

    # 4. Validate Camera Production Plan
    has_unsupported_cam = shot.camera_plan.support_status == "unsupported_suggestion"
    has_approx_cam = shot.camera_plan.support_status == "2d_approximation"
    if has_unsupported_cam:
        add_dep(
            "camera",
            "warning",
            f"Camera: {shot.camera_plan.camera_movement}",
            shot.camera_plan.support_note or "Unsupported 2D camera movement (suggestion only).",
            "Switch to an executable 2D movement (static/pan/tilt/zoom) or animate layers manually.",
        )
    elif has_approx_cam:
        add_dep(
            "camera",
            "info",
            f"Camera: {shot.camera_plan.camera_movement}",
            shot.camera_plan.support_note or "Camera movement uses 2D approximation.",
            "Review 2D approximation framing or switch to explicit pan/zoom keyframes.",
        )

    # 5. Validate Audio Plans (SFX & BGM — verify real sound_id & verified license!)
    has_missing_audio = False

    def _validate_audio(item: AudioPlanItem) -> AudioPlanItem:
        nonlocal has_missing_audio
        if item.matched_sound_id:
            snd = sounds_by_id.get(item.matched_sound_id)
            if snd is None:
                item = item.model_copy(
                    update={
                        "matched_sound_id": None,
                        "matched_sound_name": "",
                        "match_classification": "missing",
                        "license_verified": False,
                        "notes": "Referenced audio asset no longer exists in Audio Library.",
                    }
                )
            else:
                ok, lic_note = is_sound_license_safe(snd)
                if not ok:
                    item = item.model_copy(
                        update={
                            "matched_sound_id": None,
                            "matched_sound_name": "",
                            "match_classification": "requires_review",
                            "license_verified": False,
                            "license_note": lic_note,
                        }
                    )
        if not item.matched_sound_id:
            has_missing_audio = True
            add_dep(
                "audio",
                "info",
                f"{item.audio_type.upper()}: {item.category or item.description}",
                f"No verified audio asset linked for {item.audio_type.upper()} '{item.description or item.category}'.",
                "Search or import a license-safe audio clip in Audio Library.",
            )
        return item

    updated_sfx = [_validate_audio(s) for s in shot.sfx_plans]
    updated_bgm = [_validate_audio(b) for b in shot.bgm_plans]

    # 6. Derive exact Readiness Status & Execution Capability
    status: ProductionReadinessStatus = "ready"
    if has_missing_char:
        status = "needs_character"
    elif has_missing_rig:
        status = "needs_rig"
    elif has_unsupported_anim and has_unsupported_cam:
        status = "unsupported"
    elif has_unsupported_anim:
        status = "needs_animation"
    elif has_unsupported_cam:
        status = "needs_camera_setup"
    elif has_missing_asset:
        status = "needs_assets"
    elif has_ambiguous_review:
        status = "needs_review"
    elif has_missing_audio:
        status = "needs_audio"
    elif has_missing_anim_parts or has_approx_cam:
        status = "needs_review"
    else:
        status = "ready"

    # Determine whether Timeline execution is full, partial, or blocked
    can_execute_anything = (
        shot.camera_plan.executable_on_timeline
        or any(not c.character_missing for c in updated_chars)
        or any(s.matched_sound_id for s in [*updated_sfx, *updated_bgm])
        or len(shot.voice_subtitle_plans) > 0
        or (updated_bg is not None and updated_bg.matched_asset_id is not None)
    )
    if status == "ready":
        capability: ExecutionCapability = "full"
    elif can_execute_anything:
        capability = "partial"
    else:
        capability = "blocked"

    return shot.model_copy(
        update={
            "characters": updated_chars,
            "background": updated_bg,
            "assets": updated_assets,
            "animation_plans": updated_anims,
            "sfx_plans": updated_sfx,
            "bgm_plans": updated_bgm,
            "readiness_status": status,
            "readiness_reasons": reasons,
            "execution_capability": capability,
            "missing_dependencies": deps,
        }
    )
