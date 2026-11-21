"""Phase 06 Batch 3 — AI Production Planner Service.

Transforms approved Storyboard shots + Script Analysis + Character/Asset/Audio/Voice/Subtitle
records into structured, grounded, reviewable `ProductionPlanDocument` plans:
- Uses real `LLMProviderRegistry` for creative production direction (poses, animation breakdowns,
  background/prop visual cues, SFX/BGM design, framing notes) — no hardcoded keys, no fake AI
- Grounds EVERY character, rig part, pose/expression, background/prop asset, SFX/BGM clip,
  voice clip, and subtitle segment strictly against real `library.db` & `project.db` IDs
- Enforces honest 2D animation & camera executability + license-safe audio matching
- Computes real data-driven Production Readiness (`ready`, `needs_character`, `needs_rig`,
  `needs_assets`, `needs_animation`, `needs_camera_setup`, `needs_audio`, `needs_review`, `unsupported`)
- Supports hash caching, locked-plan protection, edit-protected single-shot regeneration,
  incremental per-scene save on failure/cancel, and live WebSocket `production_progress`!
"""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import uuid
from collections import Counter, defaultdict
from typing import Any

from pydantic import BaseModel, Field

from app.logging_config import get_logger
from core.production_engine.matcher import (
    evaluate_shot_readiness,
    infer_animation_category,
    map_animation_action,
    match_asset_requirement,
    match_audio_requirement,
)
from core.storyboard_engine.camera_capabilities import (
    evaluate_camera_angle_note,
    evaluate_camera_movement_support,
)
from database.library_repo import LibraryRepository
from database.project_repo import ProjectRepository, holds_project_lock
from providers.interfaces import LLMProvider
from providers.llm_provider import LLMCancelledError, LLMProviderRegistry
from schemas.asset import Asset
from schemas.character import Character
from schemas.common import utc_now_iso
from schemas.production import (
    AnimationActionCategory,
    AnimationActionPlan,
    AssetMatchItem,
    AudioPlanItem,
    CameraProductionPlan,
    CharacterStagingPlan,
    ProductionGenerateRequest,
    ProductionPlanDocument,
    ProductionProgress,
    ProductionShotPlan,
    RegenerateProductionShotRequest,
    VoiceSubtitlePlanItem,
)
from schemas.project import ProjectState
from schemas.sound import SoundAsset
from schemas.storyboard import StoryboardShot
from schemas.voice import VoiceAudioAsset
from workers.ws_hub import WebSocketHub

logger = get_logger("production_engine")

_VALID_ANIM_CATS: set[str] = {
    "idle", "walk", "run", "blink", "talk", "wave", "turn",
    "look", "jump", "fall", "attack", "react", "sit", "stand", "custom",
}


# --- Structured LLM Wire Schemas ---


class _LLMAnimItem(BaseModel):
    character_name: str = ""
    category: str = "idle"
    description: str = ""
    direction_hint: str = ""
    duration_ms: int = 2000


class _LLMAudioCue(BaseModel):
    audio_type: str = "sfx"  # sfx | bgm | ambient
    category: str = ""
    description: str = ""
    offset_ms: int = 0
    volume: float = 0.75
    fade_in_ms: int = 0
    fade_out_ms: int = 0
    loop: bool = False


class _LLMShotProductionProposal(BaseModel):
    shot_id: str = ""
    background_query: str = ""
    prop_queries: list[str] = Field(default_factory=list)
    initial_pose_summary: str = ""
    final_pose_summary: str = ""
    action_summary: str = ""
    start_framing: str = ""
    end_framing: str = ""
    animations: list[_LLMAnimItem] = Field(default_factory=list)
    sfx_cues: list[_LLMAudioCue] = Field(default_factory=list)
    bgm_cues: list[_LLMAudioCue] = Field(default_factory=list)
    ai_notes: str = ""


class _LLMSceneProductionResponse(BaseModel):
    shot_plans: list[_LLMShotProductionProposal] = Field(default_factory=list)


def _norm(s: str) -> str:
    return (s or "").strip().lower()


async def _invoke_structured(
    provider: LLMProvider,
    *,
    prompt: str,
    schema: type[BaseModel],
    system_prompt: str,
    model: str | None,
    cancel_event: asyncio.Event | None,
) -> Any:
    sig = inspect.signature(provider.generate_structured)
    kwargs: dict[str, Any] = {
        "prompt": prompt,
        "schema": schema,
        "system_prompt": system_prompt,
        "model": model,
    }
    if "cancel_event" in sig.parameters:
        kwargs["cancel_event"] = cancel_event
    return await provider.generate_structured(**kwargs)


def _production_system_prompt(language: str) -> str:
    lang_rule = {
        "vi": "Write descriptions, pose summaries, framing notes, and production notes in natural Vietnamese.",
        "en": "Write descriptions, pose summaries, framing notes, and production notes in natural English.",
        "auto": "Write descriptions and notes in the same language as the storyboard shots.",
    }.get(language, "Match the storyboard language.")

    return (
        "You are a Senior 2D Motion Comic Production Planner & Animation Pipeline Engineer.\n"
        "Convert the approved Storyboard Shots into structured production instructions.\n\n"
        "STRICT RULES:\n"
        "1. NEVER invent asset IDs, character IDs, or sound IDs — return semantic queries/categories only; the backend grounds them against the real Asset & Audio Libraries.\n"
        "2. ANIMATION CATEGORIES: choose only from idle, walk, run, blink, talk, wave, turn, look, jump, fall, attack, react, sit, stand, custom.\n"
        "3. AUDIO CATEGORIES: suggest realistic Motion Comic SFX categories (e.g. rain, wind, thunder, footsteps, walking, running, doors, impact, suspense, transitions) and BGM categories (e.g. suspense, dramatic, emotional, sad, happy, action, ambient, calm, fantasy) with sensible volume (0.2–0.9) and timing offset_ms.\n"
        "4. KEEP IT PRACTICAL: Suggest 1–3 purposeful animation actions and 0–2 SFX cues per shot, plus 1 BGM/ambient cue on the opening shot of a scene when mood calls for it.\n"
        f"5. LANGUAGE: {lang_rule}\n"
        "Return ONLY valid JSON conforming strictly to the requested schema."
    )


def _scene_storyboard_hash(shots: list[StoryboardShot]) -> str:
    payload = [
        {
            "shot_id": s.shot_id,
            "shot_order": s.shot_order,
            "title": s.title,
            "shot_size": s.shot_size,
            "camera_angle": s.camera_angle,
            "camera_movement": s.camera_movement,
            "duration_ms": s.duration_ms,
            "environment": s.environment,
            "props_in_shot": s.props_in_shot,
            "characters": [
                {
                    "name": c.character_name,
                    "lib": c.library_character_id,
                    "pos": c.screen_position,
                    "facing": c.facing_direction,
                    "action": c.action,
                    "expression": c.expression,
                    "movement": c.movement,
                }
                for c in s.characters
            ],
        }
        for s in shots
    ]
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()[:16]


class ProductionPlannerService:
    """Orchestrates AI Production Plan generation, readiness evaluation, regeneration & progress."""

    def __init__(
        self,
        *,
        project_repo: ProjectRepository,
        library_repo: LibraryRepository,
        llm_registry: LLMProviderRegistry,
        ws_hub: WebSocketHub,
    ) -> None:
        self.project_repo = project_repo
        self.library_repo = library_repo
        self.llm_registry = llm_registry
        self.ws_hub = ws_hub
        self._progress: dict[str, ProductionProgress] = {}
        self._cancel_events: dict[str, asyncio.Event] = {}
        self._active_locks: dict[str, asyncio.Lock] = {}

    def _get_lock(self, project_id: str) -> asyncio.Lock:
        if project_id not in self._active_locks:
            self._active_locks[project_id] = asyncio.Lock()
        return self._active_locks[project_id]

    def get_progress(self, project_id: str) -> ProductionProgress:
        return self._progress.get(project_id) or ProductionProgress(
            project_id=project_id, status="idle"
        )

    def cancel_generation(self, project_id: str) -> ProductionProgress:
        ev = self._cancel_events.get(project_id)
        if ev:
            ev.set()
        prog = self.get_progress(project_id)
        if prog.status == "running":
            prog = prog.model_copy(
                update={
                    "status": "cancelled",
                    "message": "Cancellation requested...",
                    "ended_at": utc_now_iso(),
                }
            )
            self._progress[project_id] = prog
        return prog

    async def _set_progress(self, prog: ProductionProgress) -> None:
        self._progress[prog.project_id] = prog
        try:
            await self.ws_hub.broadcast_event("production_progress", prog.model_dump())
        except Exception:
            pass

    def _load_library_context(self, project_id: str):
        chars = self.library_repo.list_characters()
        assets = self.library_repo.list_assets()
        sounds = self.library_repo.list_sounds()
        voice_assets = self.project_repo.list_voice_audio_assets(project_id)
        return (
            chars,
            {c.character_id: c for c in chars},
            assets,
            {a.asset_id: a for a in assets},
            sounds,
            {s.sound_id: s for s in sounds},
            voice_assets,
        )

    def _build_shot_plan_from_storyboard(
        self,
        *,
        sb_shot: StoryboardShot,
        llm_prop: _LLMShotProductionProposal | None,
        state: ProjectState,
        all_sb_shots: list[StoryboardShot],
        chars: list[Character],
        chars_by_id: dict[str, Character],
        assets: list[Asset],
        assets_by_id: dict[str, Asset],
        sounds: list[SoundAsset],
        sounds_by_id: dict[str, SoundAsset],
        voice_assets: list[VoiceAudioAsset],
        existing_plan: ProductionShotPlan | None = None,
    ) -> ProductionShotPlan:
        chars_by_norm = {_norm(c.name): c for c in chars}

        # Count dialogue ref appearances across all storyboard shots to detect multi-shot spanning lines
        ref_counter: Counter[str] = Counter()
        for s in all_sb_shots:
            for r in [*s.dialogue_refs, *s.narration_refs]:
                if r.ref_id:
                    ref_counter[r.ref_id] += 1

        # 1. Character Staging Plans (strictly grounded to real library characters & their real expressions/poses)
        char_plans: list[CharacterStagingPlan] = []
        for idx, st in enumerate(sb_shot.characters):
            lib_ch = (
                chars_by_id.get(st.library_character_id)
                if st.library_character_id
                else chars_by_norm.get(_norm(st.character_name))
            )
            expr_id = None
            pose_id = None
            if lib_ch:
                want_expr = _norm(st.expression)
                matched_expr = next(
                    (e for e in lib_ch.expressions if want_expr and (want_expr in _norm(e.name) or _norm(e.name) in want_expr)),
                    None,
                )
                if matched_expr:
                    expr_id = matched_expr.expression_id
                want_pose = _norm(llm_prop.initial_pose_summary if llm_prop else st.action)
                matched_pose = next(
                    (p for p in lib_ch.poses if want_pose and (_norm(p.name) in want_pose or want_pose in _norm(p.name))),
                    None,
                )
                if matched_pose:
                    pose_id = matched_pose.pose_id

            rel_pos = (
                f"{st.depth_layer} / {st.screen_position}"
                + (f" (char #{idx + 1} of {len(sb_shot.characters)})" if len(sb_shot.characters) > 1 else "")
            )
            char_plans.append(
                CharacterStagingPlan(
                    staging_id=st.staging_id,
                    character_name=lib_ch.name if lib_ch else st.character_name,
                    character_analysis_id=st.character_analysis_id,
                    library_character_id=lib_ch.character_id if lib_ch else None,
                    character_missing=lib_ch is None,
                    rig_missing=(lib_ch is None or len(lib_ch.parts) == 0),
                    visible=st.visible,
                    speaking=st.speaking,
                    reacting=st.reacting,
                    screen_position=st.screen_position,
                    relative_position=rel_pos,
                    depth_layer=st.depth_layer,
                    facing_direction=st.facing_direction,
                    initial_pose=(llm_prop.initial_pose_summary if llm_prop else "") or st.action or "standing",
                    initial_pose_id=pose_id,
                    final_pose=(llm_prop.final_pose_summary if llm_prop else ""),
                    expression=st.expression or "neutral",
                    expression_id=expr_id,
                    action=st.action,
                    movement=st.movement,
                    entrance="enters frame" if any(k in _norm(st.movement) for k in ("enter", "bước vào", "xuất hiện")) else "",
                    exit="exits frame" if any(k in _norm(st.movement) for k in ("exit", "leave", "rời đi", "bước ra")) else "",
                )
            )

        # 2. Asset Matching — Background + Props
        bg_query = (llm_prop.background_query if llm_prop and llm_prop.background_query.strip() else sb_shot.environment).strip()
        specialized_art = ""
        if sb_shot.camera_angle in ("birds_eye", "worms_eye"):
            specialized_art = f"Camera angle '{sb_shot.camera_angle}' requires dedicated perspective background art."
        bg_match = (
            match_asset_requirement(
                kind="background",
                label=sb_shot.environment or "Scene Background",
                query=bg_query,
                assets=assets,
                required=True,
                specialized_art_note=specialized_art,
            )
            if bg_query
            else None
        )

        prop_names = list(dict.fromkeys([*sb_shot.props_in_shot, *(llm_prop.prop_queries if llm_prop else [])]))
        asset_matches: list[AssetMatchItem] = []
        for p_name in prop_names[:6]:
            if not p_name.strip():
                continue
            asset_matches.append(
                match_asset_requirement(
                    kind="prop",
                    label=p_name.strip(),
                    query=p_name.strip(),
                    assets=assets,
                    required=False,
                )
            )

        # 3. Animation Plans (grounded against real rig capabilities!)
        anim_plans: list[AnimationActionPlan] = []
        char_plan_by_norm = {_norm(c.character_name): c for c in char_plans}

        if llm_prop and llm_prop.animations:
            for raw_a in llm_prop.animations[:5]:
                cp = char_plan_by_norm.get(_norm(raw_a.character_name)) or (char_plans[0] if char_plans else None)
                cname = cp.character_name if cp else (raw_a.character_name.strip() or "Character")
                lib_ch = chars_by_id.get(cp.library_character_id) if (cp and cp.library_character_id) else None
                cat: AnimationActionCategory = (
                    raw_a.category if raw_a.category in _VALID_ANIM_CATS else infer_animation_category(raw_a.description)  # type: ignore[assignment]
                )
                anim_plans.append(
                    map_animation_action(
                        character_name=cname,
                        character=lib_ch,
                        category=cat,
                        description=raw_a.description.strip() or (cp.action if cp else cat),
                        duration_ms=max(400, min(sb_shot.duration_ms, int(raw_a.duration_ms or sb_shot.duration_ms))),
                        direction_hint=raw_a.direction_hint or (cp.movement if cp else ""),
                    )
                )
        else:
            for cp in char_plans:
                lib_ch = chars_by_id.get(cp.library_character_id) if cp.library_character_id else None
                cat = infer_animation_category(
                    f"{cp.action} {cp.movement}", speaking=cp.speaking, reacting=cp.reacting
                )
                anim_plans.append(
                    map_animation_action(
                        character_name=cp.character_name,
                        character=lib_ch,
                        category=cat,
                        description=cp.action or cp.movement or cat,
                        duration_ms=sb_shot.duration_ms,
                        direction_hint=cp.movement,
                    )
                )

        # 4. Camera Production Plan (honest 2D capability check!)
        sup_status, sup_note = evaluate_camera_movement_support(sb_shot.camera_movement)
        angle_note = evaluate_camera_angle_note(sb_shot.camera_angle)
        cam_plan = CameraProductionPlan(
            shot_size=sb_shot.shot_size,
            camera_angle=sb_shot.camera_angle,
            camera_movement=sb_shot.camera_movement,
            support_status=sup_status,
            support_note=sup_note,
            angle_note=angle_note,
            start_framing=(llm_prop.start_framing if llm_prop and llm_prop.start_framing else f"{sb_shot.shot_size} / {sb_shot.camera_angle}"),
            end_framing=(llm_prop.end_framing if llm_prop and llm_prop.end_framing else f"{sb_shot.camera_movement} -> {sb_shot.visual_focus or sb_shot.title}"),
            focus_target=sb_shot.visual_focus or sb_shot.title,
            duration_ms=sb_shot.duration_ms,
            transition_out=sb_shot.transition_out,
            camera_plan=sb_shot.camera_plan,
            executable_on_timeline=(sup_status == "supported"),
        )

        # 5. Voice & Subtitle Plans (connect existing ScriptEntry, VoiceAudioAsset & SubtitleSegment without duplication!)
        all_script_entries = [
            ent
            for sc in (state.script.scenes if state.script else [])
            for ent in sc.entries
        ]
        voice_by_entry = {va.entry_id: va for va in voice_assets if va.entry_id}
        subs_by_entry = {
            seg.script_entry_id: seg
            for seg in (state.subtitles.segments if state.subtitles else [])
            if seg.script_entry_id
        }
        subs_by_text = {
            _norm(seg.text): seg
            for seg in (state.subtitles.segments if state.subtitles else [])
            if seg.text.strip()
        }

        vs_plans: list[VoiceSubtitlePlanItem] = []
        cursor_offset = 150
        for ref in [*sb_shot.dialogue_refs, *sb_shot.narration_refs]:
            if not ref.text_excerpt.strip():
                continue
            matched_entry = next(
                (e for e in all_script_entries if e.entry_id == ref.ref_id or _norm(e.text) == _norm(ref.text_excerpt)),
                None,
            )
            va = (
                voice_by_entry.get(matched_entry.entry_id)
                if matched_entry
                else voice_by_entry.get(ref.ref_id)
            )
            if va is None and matched_entry and matched_entry.audio_asset_id:
                va = next((v for v in voice_assets if v.audio_asset_id == matched_entry.audio_asset_id), None)

            existing_sub = (
                subs_by_entry.get(matched_entry.entry_id)
                if matched_entry
                else subs_by_text.get(_norm(ref.text_excerpt))
            )
            spk_cp = char_plan_by_norm.get(_norm(ref.speaker_name))
            word_count = max(1, len(ref.text_excerpt.split()))
            est_dur = max(1200, min(sb_shot.duration_ms, word_count * 380 + 400))
            exact_dur = va.duration_ms if (va and va.duration_ms > 0) else (
                matched_entry.audio_duration_ms if (matched_entry and matched_entry.audio_duration_ms) else None
            )

            # Check if a matching voice SoundAsset was already registered in library.db
            matched_voice_sound = None
            if va:
                matched_voice_sound = next(
                    (s for s in sounds if va.audio_asset_id in s.file_path or va.file_path in s.file_path),
                    None,
                )

            vs_plans.append(
                VoiceSubtitlePlanItem(
                    item_plan_id=f"vsp_{uuid.uuid4().hex[:8]}",
                    item_type="narration" if ref.item_type in ("narration", "action") else ("internal_thought" if ref.item_type == "internal_thought" else "dialogue"),
                    script_ref_id=ref.ref_id,
                    script_entry_id=matched_entry.entry_id if matched_entry else None,
                    speaker_name=ref.speaker_name,
                    library_character_id=(
                        matched_entry.character_id
                        if (matched_entry and matched_entry.character_id)
                        else (spk_cp.library_character_id if spk_cp else None)
                    ),
                    text=ref.text_excerpt,
                    voice_audio_asset_id=va.audio_asset_id if va else None,
                    voice_sound_id=matched_voice_sound.sound_id if matched_voice_sound else None,
                    subtitle_segment_id=existing_sub.subtitle_id if existing_sub else None,
                    spans_multiple_shots=(ref_counter.get(ref.ref_id, 0) >= 2),
                    sync_mode="exact_voice" if exact_dur else "estimated",
                    start_offset_ms=min(max(0, sb_shot.duration_ms - 600), cursor_offset),
                    duration_ms=int(exact_dur or est_dur),
                    notes=(
                        "Exact voice clip timing available."
                        if exact_dur
                        else "Estimated reading duration (no voice clip generated yet)."
                    ),
                )
            )
            cursor_offset = min(sb_shot.duration_ms - 500, cursor_offset + int(exact_dur or est_dur) + 150)

        # 6. License-Safe Audio Matching (SFX & BGM)
        sfx_plans: list[AudioPlanItem] = []
        bgm_plans: list[AudioPlanItem] = []

        if llm_prop:
            for cue in llm_prop.sfx_cues[:4]:
                atype = "ambient" if cue.audio_type == "ambient" else "sfx"
                sfx_plans.append(
                    match_audio_requirement(
                        audio_type=atype,
                        category=cue.category.strip(),
                        description=cue.description.strip(),
                        sounds=sounds,
                        offset_ms=max(0, min(sb_shot.duration_ms - 200, int(cue.offset_ms or 0))),
                        volume=max(0.05, min(1.5, float(cue.volume or 0.8))),
                        fade_in_ms=max(0, int(cue.fade_in_ms or 0)),
                        fade_out_ms=max(0, int(cue.fade_out_ms or 0)),
                        loop=bool(cue.loop),
                    )
                )
            for cue in llm_prop.bgm_cues[:2]:
                bgm_plans.append(
                    match_audio_requirement(
                        audio_type="bgm",
                        category=cue.category.strip(),
                        description=cue.description.strip(),
                        sounds=sounds,
                        offset_ms=0,
                        duration_ms=sb_shot.duration_ms,
                        volume=max(0.05, min(1.0, float(cue.volume or 0.45))),
                        fade_in_ms=max(0, int(cue.fade_in_ms or 500)),
                        fade_out_ms=max(0, int(cue.fade_out_ms or 600)),
                        loop=True,
                    )
                )

        # Preserve prior timeline_refs if regenerating an existing production shot cleanly
        prev_refs = existing_plan.timeline_refs if existing_plan else None
        plan = ProductionShotPlan(
            production_shot_id=(
                existing_plan.production_shot_id if existing_plan else f"pshot_{uuid.uuid4().hex[:8]}"
            ),
            shot_id=sb_shot.shot_id,
            scene_id=sb_shot.scene_id,
            shot_order=sb_shot.shot_order,
            title=sb_shot.title,
            duration_ms=sb_shot.duration_ms,
            start_time_ms=sb_shot.start_time_ms,
            end_time_ms=sb_shot.end_time_ms,
            approval_status="pending",
            locked=False,
            characters=char_plans,
            background=bg_match,
            assets=asset_matches,
            initial_pose_summary=(llm_prop.initial_pose_summary if llm_prop else ""),
            final_pose_summary=(llm_prop.final_pose_summary if llm_prop else ""),
            action_summary=(llm_prop.action_summary if llm_prop else sb_shot.purpose),
            animation_plans=anim_plans,
            camera_plan=cam_plan,
            voice_subtitle_plans=vs_plans,
            sfx_plans=sfx_plans,
            bgm_plans=bgm_plans,
            transition_out=sb_shot.transition_out,
            warnings=list(sb_shot.warnings),
            ai_notes=(llm_prop.ai_notes if llm_prop else ""),
            timeline_refs=prev_refs if prev_refs else ProductionShotPlan.model_fields["timeline_refs"].default_factory(),  # type: ignore[misc]
        )

        # Evaluate real data-driven readiness against live library & project records!
        evaluated = evaluate_shot_readiness(
            plan,
            characters_by_id=chars_by_id,
            assets_by_id=assets_by_id,
            sounds_by_id=sounds_by_id,
        )
        evaluated.original_ai_snapshot = evaluated.model_dump(exclude={"original_ai_snapshot"})
        return evaluated

    async def generate_production_plan(
        self,
        project_id: str,
        req: ProductionGenerateRequest,
    ) -> ProductionPlanDocument:
        """Generate structured production plans from approved Storyboard shots with incremental persistence."""
        lock = self._get_lock(project_id)
        if lock.locked():
            raise RuntimeError("A production plan generation job is already running for this project.")

        async with lock:
            state = self.project_repo.get_project_state(project_id)
            if not state.storyboard or not state.storyboard.shots:
                raise ValueError(
                    "No storyboard shots exist yet. Generate and review Storyboard shots before creating a Production Plan."
                )

            all_sb_shots = state.storyboard.shots
            shots_by_scene: dict[str, list[StoryboardShot]] = defaultdict(list)
            scene_order: list[str] = []
            for sh in all_sb_shots:
                if sh.scene_id not in shots_by_scene:
                    scene_order.append(sh.scene_id)
                shots_by_scene[sh.scene_id].append(sh)

            target_scene_ids = (
                [sid for sid in scene_order if sid in set(req.scene_ids)]
                if req.scene_ids
                else scene_order
            )
            if not target_scene_ids:
                raise FileNotFoundError("None of the requested scene_ids exist in the storyboard.")

            provider, ai_cfg = self.llm_registry.get_provider_for_feature("production_plan")
            analysis_lang = req.analysis_language or ai_cfg.analysis_language
            sys_prompt = _production_system_prompt(analysis_lang)

            chars, chars_by_id, assets, assets_by_id, sounds, sounds_by_id, voice_assets = (
                self._load_library_context(project_id)
            )
            # Supply available real asset/audio category summaries so LLM recommends realistic cues (NEVER raw IDs!)
            avail_bg_names = [a.name for a in assets if a.type == "background"][:20]
            avail_prop_names = [a.name for a in assets if a.type == "prop"][:20]
            avail_sfx_cats = sorted({s.category for s in sounds if (s.audio_type or "sfx") == "sfx"})
            avail_bgm_cats = sorted({s.category for s in sounds if s.audio_type == "bgm"})

            existing_doc = state.production_plan or ProductionPlanDocument(
                plan_id=f"pplan_{uuid.uuid4().hex[:10]}",
                version=0,
            )
            working_shots = list(existing_doc.shots)
            working_hashes = dict(existing_doc.scene_hashes)

            cancel_event = asyncio.Event()
            self._cancel_events[project_id] = cancel_event
            started_at = utc_now_iso()
            total_scenes = len(target_scene_ids)
            completed_scenes = 0

            await self._set_progress(
                ProductionProgress(
                    project_id=project_id,
                    status="running",
                    stage="preparing",
                    current_scene=0,
                    total_scenes=total_scenes,
                    progress_pct=5.0,
                    message=f"Preparing production plans for {total_scenes} scene(s)...",
                    started_at=started_at,
                )
            )

            def _persist(doc_status: str) -> ProductionPlanDocument:
                doc = ProductionPlanDocument(
                    plan_id=existing_doc.plan_id or f"pplan_{uuid.uuid4().hex[:10]}",
                    version=existing_doc.version + 1,
                    provider_id=ai_cfg.provider_id,
                    model=ai_cfg.model,
                    analysis_language=analysis_lang,  # type: ignore[arg-type]
                    status=doc_status,  # type: ignore[arg-type]
                    shots=working_shots,
                    scene_hashes=working_hashes,
                    updated_at=utc_now_iso(),
                )
                latest = self.project_repo.get_project_state(project_id)
                self.project_repo.save_project_state(
                    latest.model_copy(update={"production_plan": doc}),
                    create_backup=False,
                )
                return doc

            try:
                for idx, sid in enumerate(target_scene_ids, start=1):
                    if cancel_event.is_set():
                        raise LLMCancelledError("Production planning cancelled by user.")

                    sc_shots = sorted(shots_by_scene[sid], key=lambda s: s.shot_order)
                    sc_hash = _scene_storyboard_hash(sc_shots)
                    existing_for_scene = [p for p in working_shots if p.scene_id == sid]
                    existing_by_shot_id = {p.shot_id: p for p in existing_for_scene}

                    # Skip unchanged scene if not forced and plans already exist
                    if (
                        not req.force
                        and existing_for_scene
                        and working_hashes.get(sid) == sc_hash
                    ):
                        # Still refresh readiness deterministically in case user added assets/characters!
                        refreshed = [
                            evaluate_shot_readiness(
                                p,
                                characters_by_id=chars_by_id,
                                assets_by_id=assets_by_id,
                                sounds_by_id=sounds_by_id,
                            )
                            for p in existing_for_scene
                        ]
                        other = [p for p in working_shots if p.scene_id != sid]
                        working_shots = self._sort_plans_by_scene_order([*other, *refreshed], scene_order)
                        completed_scenes += 1
                        continue

                    unlocked_sb_shots = [
                        sh
                        for sh in sc_shots
                        if not (
                            req.preserve_locked
                            and sh.shot_id in existing_by_shot_id
                            and existing_by_shot_id[sh.shot_id].locked
                        )
                    ]

                    await self._set_progress(
                        ProductionProgress(
                            project_id=project_id,
                            status="running",
                            stage="planning_scene",
                            current_scene=idx,
                            total_scenes=total_scenes,
                            current_scene_title=sc_shots[0].title if sc_shots else sid,
                            progress_pct=round(((idx - 0.5) / total_scenes) * 90.0, 1),
                            message=f"Planning production for Scene {idx}/{total_scenes} ({len(unlocked_sb_shots)} shot(s))...",
                            started_at=started_at,
                        )
                    )

                    llm_by_shot_id: dict[str, _LLMShotProductionProposal] = {}
                    if unlocked_sb_shots:
                        shots_payload = [
                            {
                                "shot_id": s.shot_id,
                                "shot_order": s.shot_order,
                                "title": s.title,
                                "purpose": s.purpose,
                                "shot_size": s.shot_size,
                                "camera_angle": s.camera_angle,
                                "camera_movement": s.camera_movement,
                                "duration_ms": s.duration_ms,
                                "environment": s.environment,
                                "visual_focus": s.visual_focus,
                                "emotional_emphasis": s.emotional_emphasis,
                                "props_in_shot": s.props_in_shot,
                                "characters": [
                                    {
                                        "name": c.character_name,
                                        "speaking": c.speaking,
                                        "reacting": c.reacting,
                                        "action": c.action,
                                        "movement": c.movement,
                                        "expression": c.expression,
                                    }
                                    for c in s.characters
                                ],
                                "dialogue": [d.text_excerpt for d in s.dialogue_refs],
                            }
                            for s in unlocked_sb_shots
                        ]
                        prompt = (
                            f"SCENE ID: {sid}\n"
                            f"AVAILABLE BACKGROUND ASSET NAMES: {json.dumps(avail_bg_names, ensure_ascii=False)}\n"
                            f"AVAILABLE PROP ASSET NAMES: {json.dumps(avail_prop_names, ensure_ascii=False)}\n"
                            f"AVAILABLE SFX CATEGORIES: {json.dumps(avail_sfx_cats, ensure_ascii=False)}\n"
                            f"AVAILABLE BGM CATEGORIES: {json.dumps(avail_bgm_cats, ensure_ascii=False)}\n"
                            f"STORYBOARD SHOTS TO PLAN:\n{json.dumps(shots_payload, ensure_ascii=False)}\n\n"
                            "Return `shot_plans` matching each `shot_id` with pose summaries, practical animation action categories, "
                            "background/prop semantic queries, framing notes, and SFX/BGM cue suggestions."
                        )
                        llm_res: _LLMSceneProductionResponse = await _invoke_structured(
                            provider,
                            prompt=prompt,
                            schema=_LLMSceneProductionResponse,
                            system_prompt=sys_prompt,
                            model=ai_cfg.model,
                            cancel_event=cancel_event,
                        )
                        for p_idx, prop_item in enumerate(llm_res.shot_plans):
                            key = prop_item.shot_id.strip()
                            if key:
                                llm_by_shot_id[key] = prop_item
                            elif p_idx < len(unlocked_sb_shots):
                                llm_by_shot_id[unlocked_sb_shots[p_idx].shot_id] = prop_item

                    next_scene_plans: list[ProductionShotPlan] = []
                    for sh in sc_shots:
                        prev_p = existing_by_shot_id.get(sh.shot_id)
                        if req.preserve_locked and prev_p and prev_p.locked:
                            # Keep locked plan intact, only refreshing live readiness diagnostics
                            next_scene_plans.append(
                                evaluate_shot_readiness(
                                    prev_p,
                                    characters_by_id=chars_by_id,
                                    assets_by_id=assets_by_id,
                                    sounds_by_id=sounds_by_id,
                                )
                            )
                            continue
                        built = self._build_shot_plan_from_storyboard(
                            sb_shot=sh,
                            llm_prop=llm_by_shot_id.get(sh.shot_id),
                            state=state,
                            all_sb_shots=all_sb_shots,
                            chars=chars,
                            chars_by_id=chars_by_id,
                            assets=assets,
                            assets_by_id=assets_by_id,
                            sounds=sounds,
                            sounds_by_id=sounds_by_id,
                            voice_assets=voice_assets,
                            existing_plan=prev_p,
                        )
                        next_scene_plans.append(built)

                    other = [p for p in working_shots if p.scene_id != sid]
                    working_shots = self._sort_plans_by_scene_order(
                        [*other, *next_scene_plans], scene_order
                    )
                    working_hashes[sid] = sc_hash
                    completed_scenes += 1

                    # Incremental persistence after every scene so completed scenes survive failure/cancel!
                    _persist("partial" if idx < total_scenes else "generated")

                final_doc = _persist("generated")
                await self._set_progress(
                    ProductionProgress(
                        project_id=project_id,
                        status="completed",
                        stage="completed",
                        current_scene=total_scenes,
                        total_scenes=total_scenes,
                        progress_pct=100.0,
                        message=f"Production plan ready: {len(final_doc.shots)} shot plan(s) analyzed.",
                        started_at=started_at,
                        ended_at=utc_now_iso(),
                    )
                )
                return final_doc

            except LLMCancelledError as exc:
                if completed_scenes > 0:
                    _persist("partial")
                await self._set_progress(
                    ProductionProgress(
                        project_id=project_id,
                        status="cancelled",
                        stage="cancelled",
                        current_scene=completed_scenes,
                        total_scenes=total_scenes,
                        progress_pct=round((completed_scenes / max(1, total_scenes)) * 100.0, 1),
                        message=str(exc),
                        error=str(exc),
                        started_at=started_at,
                        ended_at=utc_now_iso(),
                    )
                )
                raise
            except Exception as exc:
                if completed_scenes > 0:
                    _persist("partial")
                await self._set_progress(
                    ProductionProgress(
                        project_id=project_id,
                        status="partial" if completed_scenes > 0 else "failed",
                        stage="failed",
                        current_scene=completed_scenes,
                        total_scenes=total_scenes,
                        progress_pct=round((completed_scenes / max(1, total_scenes)) * 100.0, 1),
                        message=f"Production planning failed: {exc}",
                        error=str(exc),
                        started_at=started_at,
                        ended_at=utc_now_iso(),
                    )
                )
                raise
            finally:
                self._cancel_events.pop(project_id, None)

    async def regenerate_single_shot_plan(
        self,
        project_id: str,
        production_shot_id: str,
        req: RegenerateProductionShotRequest,
    ) -> ProductionShotPlan:
        """Regenerate one unlocked production shot plan while preserving `user_edited_fields`."""
        state = self.project_repo.get_project_state(project_id)
        if not state.production_plan:
            raise FileNotFoundError("No production plan exists for this project yet.")

        doc = state.production_plan
        idx = next(
            (i for i, p in enumerate(doc.shots) if p.production_shot_id == production_shot_id),
            -1,
        )
        if idx == -1:
            raise FileNotFoundError(f"Production shot plan not found: {production_shot_id}")

        existing = doc.shots[idx]
        if existing.locked:
            raise ValueError(
                f"Production plan for Shot #{existing.shot_order} is locked. Unlock it before regenerating."
            )

        sb_shots = state.storyboard.shots if state.storyboard else []
        sb_shot = next((s for s in sb_shots if s.shot_id == existing.shot_id), None)
        if sb_shot is None:
            raise FileNotFoundError(f"Underlying storyboard shot not found: {existing.shot_id}")

        provider, ai_cfg = self.llm_registry.get_provider_for_feature("production_plan")
        sys_prompt = _production_system_prompt(doc.analysis_language)
        chars, chars_by_id, assets, assets_by_id, sounds, sounds_by_id, voice_assets = (
            self._load_library_context(project_id)
        )

        prompt = (
            f"Regenerate the production plan for Shot #{sb_shot.shot_order} ('{sb_shot.title}').\n"
            f"STORYBOARD SHOT: {json.dumps(sb_shot.model_dump(exclude={'original_ai_snapshot'}), ensure_ascii=False)}\n"
            f"USER INSTRUCTIONS: {req.instructions or '(Refine animation mapping, pose notes, and SFX/BGM cues.)'}\n"
            "Return a single JSON production shot proposal."
        )
        llm_prop: _LLMShotProductionProposal = await _invoke_structured(
            provider,
            prompt=prompt,
            schema=_LLMShotProductionProposal,
            system_prompt=sys_prompt,
            model=ai_cfg.model,
            cancel_event=None,
        )

        fresh = self._build_shot_plan_from_storyboard(
            sb_shot=sb_shot,
            llm_prop=llm_prop,
            state=state,
            all_sb_shots=sb_shots,
            chars=chars,
            chars_by_id=chars_by_id,
            assets=assets,
            assets_by_id=assets_by_id,
            sounds=sounds,
            sounds_by_id=sounds_by_id,
            voice_assets=voice_assets,
            existing_plan=existing,
        )

        preserved = set(existing.user_edited_fields) if req.preserve_user_edits else set()

        def pick(field: str) -> Any:
            return getattr(existing, field) if field in preserved else getattr(fresh, field)

        merged = existing.model_copy(
            update={
                "title": pick("title"),
                "duration_ms": pick("duration_ms"),
                "characters": pick("characters"),
                "background": pick("background"),
                "assets": pick("assets"),
                "initial_pose_summary": pick("initial_pose_summary"),
                "final_pose_summary": pick("final_pose_summary"),
                "action_summary": pick("action_summary"),
                "animation_plans": pick("animation_plans"),
                "camera_plan": pick("camera_plan"),
                "sfx_plans": pick("sfx_plans"),
                "bgm_plans": pick("bgm_plans"),
                "ai_notes": pick("ai_notes"),
                "user_edited_fields": list(existing.user_edited_fields) if req.preserve_user_edits else [],
                "approval_status": "edited" if preserved else "pending",
            }
        )
        final_shot = evaluate_shot_readiness(
            merged,
            characters_by_id=chars_by_id,
            assets_by_id=assets_by_id,
            sounds_by_id=sounds_by_id,
        )

        next_shots = list(doc.shots)
        next_shots[idx] = final_shot
        next_doc = doc.model_copy(update={"shots": next_shots, "updated_at": utc_now_iso()})
        self.project_repo.patch_project_sections(project_id, production_plan=next_doc)
        return final_shot

    @holds_project_lock
    def refresh_readiness(self, project_id: str) -> ProductionPlanDocument:
        """Deterministically re-evaluate readiness and asset validity against live library/project data (0 AI calls)."""
        state = self.project_repo.get_project_state(project_id)
        if not state.production_plan:
            raise FileNotFoundError("No production plan exists for this project yet.")

        _, chars_by_id, _, assets_by_id, _, sounds_by_id, _ = self._load_library_context(project_id)
        updated_shots = [
            evaluate_shot_readiness(
                sh,
                characters_by_id=chars_by_id,
                assets_by_id=assets_by_id,
                sounds_by_id=sounds_by_id,
            )
            for sh in state.production_plan.shots
        ]
        next_doc = state.production_plan.model_copy(
            update={"shots": updated_shots, "updated_at": utc_now_iso()}
        )
        self.project_repo.save_project_state(
            state.model_copy(update={"production_plan": next_doc}),
            create_backup=False,
        )
        return next_doc

    @staticmethod
    def _sort_plans_by_scene_order(
        plans: list[ProductionShotPlan],
        scene_order: list[str],
    ) -> list[ProductionShotPlan]:
        rank = {sid: i for i, sid in enumerate(scene_order)}
        return sorted(plans, key=lambda p: (rank.get(p.scene_id, 99999), p.shot_order))
