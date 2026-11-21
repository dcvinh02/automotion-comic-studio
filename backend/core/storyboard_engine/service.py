"""Phase 06 Batch 2 — AI Storyboard, Shot Planning & Camera Direction Service.

Transforms approved scenes into structured, cinematographically grounded shot plans:
- Reuses Batch 1 `DirectorAnalysisDocument` (accepted scenes), `ScriptDocument`, Stage `Scene`s,
  and global `library.db` `Character`s without duplicating data or inventing character assets
- Uses the real `LLMProviderRegistry` (no hardcoded keys, no fake AI fallback)
- Enforces honest 2D Camera capability tagging (`supported` / `2d_approximation` / `unsupported_suggestion`)
- Runs deterministic continuity analysis across consecutive shots
- Supports hash-based unchanged-scene skipping, locked-shot preservation, confirmed full-scene replace,
  single-shot regeneration preserving `user_edited_fields`, async cancellation, and incremental persistence
  so completed scenes survive mid-run failures!
"""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import uuid
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel, Field

from app.logging_config import get_logger
from core.storyboard_engine.camera_capabilities import (
    build_default_2d_camera_plan,
    estimate_shot_duration_ms,
    evaluate_camera_angle_note,
    evaluate_camera_movement_support,
    recalculate_scene_shot_timings,
)
from core.storyboard_engine.continuity import analyze_storyboard_continuity
from database.library_repo import LibraryRepository
from database.project_repo import ProjectRepository
from providers.interfaces import LLMProvider
from providers.llm_provider import LLMCancelledError, LLMProviderRegistry
from schemas.common import utc_now_iso
from schemas.project import ProjectState
from schemas.storyboard import (
    Camera2DKeyPlan,
    CameraAngle,
    CameraMovement,
    ContinuityCheckResponse,
    DepthLayer,
    FacingDirection,
    RegenerateShotRequest,
    SceneStoryboardGenerateRequest,
    ScreenPosition,
    ShotCharacterStaging,
    ShotScriptRef,
    ShotSize,
    ShotTransition,
    StoryboardDocument,
    StoryboardGenerateRequest,
    StoryboardGenerationRecord,
    StoryboardProgress,
    StoryboardShot,
)
from workers.ws_hub import WebSocketHub

logger = get_logger("storyboard_engine")

_VALID_SHOT_SIZES: set[str] = {
    "extreme_wide", "wide", "full", "medium_full", "medium",
    "medium_close_up", "close_up", "extreme_close_up",
    "over_the_shoulder", "pov", "insert",
}
_VALID_ANGLES: set[str] = {
    "eye_level", "low_angle", "high_angle", "birds_eye",
    "worms_eye", "dutch_angle", "over_the_shoulder", "pov",
}
_VALID_MOVEMENTS: set[str] = {
    "static", "pan_left", "pan_right", "tilt_up", "tilt_down",
    "zoom_in", "zoom_out", "dolly_in", "dolly_out",
    "tracking", "camera_follow", "shake", "parallax",
}
_VALID_POSITIONS: set[str] = {
    "far_left", "left", "center_left", "center", "center_right", "right", "far_right", "offscreen",
}
_VALID_DEPTHS: set[str] = {"foreground", "midground", "background"}
_VALID_FACINGS: set[str] = {
    "left", "right", "front", "back", "three_quarter_left", "three_quarter_right",
}
_VALID_TRANSITIONS: set[str] = {
    "cut", "fade", "cross_dissolve", "match_cut", "whip_pan", "sound_bridge",
}


# --- Structured LLM Wire Schemas ---


class _LLMShotStaging(BaseModel):
    character_name: str
    visible: bool = True
    speaking: bool = False
    reacting: bool = False
    screen_position: str = "center"
    depth_layer: str = "midground"
    facing_direction: str = "front"
    action: str = ""
    expression: str = "neutral"
    movement: str = ""


class _LLMShotScriptRef(BaseModel):
    ref_id: str = ""
    item_type: str = "dialogue"
    speaker_name: str = ""
    text_excerpt: str = ""


class _LLMShotProposal(BaseModel):
    title: str = ""
    purpose: str = ""
    shot_size: str = "medium"
    camera_angle: str = "eye_level"
    camera_movement: str = "static"
    duration_ms: int = 3500
    characters: list[_LLMShotStaging] = Field(default_factory=list)
    dialogue_refs: list[_LLMShotScriptRef] = Field(default_factory=list)
    narration_refs: list[_LLMShotScriptRef] = Field(default_factory=list)
    environment: str = ""
    visual_focus: str = ""
    emotional_emphasis: str = ""
    props_in_shot: list[str] = Field(default_factory=list)
    transition_out: str = "cut"
    ai_rationale: str = ""
    confidence: float = 0.82
    warnings: list[str] = Field(default_factory=list)


class _LLMSceneShotsResponse(BaseModel):
    shots: list[_LLMShotProposal] = Field(default_factory=list)
    scene_notes: str = ""


@dataclass
class ApprovedSceneContext:
    scene_id: str
    scene_number: int
    title: str
    location: str
    time_of_day: str
    environment: str
    main_action: str
    emotional_beat: str
    scene_purpose: str
    conflict: str
    atmosphere: str
    visual_opportunities: list[str]
    characters_present: list[str]
    source_text: str
    dialogue_lines: list[dict[str, str]]
    narration_lines: list[dict[str, str]]
    target_duration_ms: int
    scene_breakdown_id: str | None = None
    script_scene_id: str | None = None
    stage_scene_id: str | None = None
    source_kind: str = "director_accepted"

    def content_hash(self) -> str:
        raw = json.dumps(
            {
                "scene_id": self.scene_id,
                "title": self.title,
                "location": self.location,
                "time_of_day": self.time_of_day,
                "environment": self.environment,
                "main_action": self.main_action,
                "emotional_beat": self.emotional_beat,
                "characters_present": self.characters_present,
                "source_text": self.source_text,
                "dialogue_lines": self.dialogue_lines,
                "narration_lines": self.narration_lines,
            },
            ensure_ascii=False,
            sort_keys=True,
        )
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def _norm(value: str) -> str:
    return (value or "").strip().lower()


def _dedupe_strs(values: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for v in values:
        clean = (v or "").strip()
        if not clean:
            continue
        k = clean.lower()
        if k not in seen:
            seen.add(k)
            out.append(clean)
    return out


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


def _storyboard_system_prompt(language: str) -> str:
    lang_rule = {
        "vi": "Write shot titles, purposes, actions, environment, visual focus, emotional emphasis, and AI rationale in natural Vietnamese. Keep verbatim dialogue excerpts in their original script language.",
        "en": "Write shot titles, purposes, actions, environment, visual focus, emotional emphasis, and AI rationale in natural English. Keep verbatim dialogue excerpts in their original script language.",
        "auto": "Write shot titles, purposes, actions, environment, visual focus, emotional emphasis, and AI rationale in the SAME primary language as the script. Keep verbatim dialogue excerpts unchanged.",
    }.get(language, "Match the script language.")

    return (
        "You are a Senior Film Director, Storyboard Artist, Cinematography Expert, and 2D Motion Comic Pipeline Engineer.\n"
        "Transform the provided APPROVED SCENE into a structured, cohesive storyboard shot plan.\n\n"
        "STRICT CINEMATOGRAPHY & 2D PIPELINE RULES:\n"
        "1. STORYTELLING ECONOMY: Do NOT over-fragment scenes or create redundant filler shots. Typically 2–6 purposeful shots per scene depending on dialogue, beats, and action.\n"
        "2. VALID SHOT SIZES ONLY: extreme_wide, wide, full, medium_full, medium, medium_close_up, close_up, extreme_close_up, over_the_shoulder, pov, insert.\n"
        "3. VALID CAMERA ANGLES ONLY (motivate every angle by story intent — never random!): eye_level, low_angle, high_angle, birds_eye, worms_eye, dutch_angle, over_the_shoulder, pov.\n"
        "4. VALID CAMERA MOVEMENTS ONLY: static, pan_left, pan_right, tilt_up, tilt_down, zoom_in, zoom_out, dolly_in, dolly_out, tracking, camera_follow, shake, parallax.\n"
        "   - Prefer 2D-executable movements (static, pan_left, pan_right, tilt_up, tilt_down, zoom_in, zoom_out) unless storytelling specifically warrants a suggestion.\n"
        "5. VALID CHARACTER STAGING: Only stage characters grounded in the scene/project character list — NEVER invent fictional characters! Specify visible, speaking, reacting, screen_position (far_left, left, center_left, center, center_right, right, far_right, offscreen), depth_layer (foreground, midground, background), facing_direction (left, right, front, back, three_quarter_left, three_quarter_right), action, expression, movement.\n"
        "6. CONTINUITY: Maintain consistent left/right screen positions, 180-degree facing direction, entries/exits, and prop continuity across consecutive shots unless explicitly motivated by character movement.\n"
        "7. VARIED REALISTIC DURATIONS: Set `duration_ms` based on dialogue length, reading speed, action complexity, emotional beat, and camera movement — NEVER assign identical arbitrary durations to every shot.\n"
        "8. DIALOGUE & NARRATION REFS: Reference the exact `ref_id` and verbatim text of lines covered by each shot.\n"
        f"9. LANGUAGE: {lang_rule}\n"
        "Return ONLY valid JSON conforming strictly to the requested schema."
    )


def resolve_approved_scenes(state: ProjectState) -> list[ApprovedSceneContext]:
    """Resolve approved scenes from Batch 1 Director analysis (accepted scenes) or existing project scenes."""
    approved: list[ApprovedSceneContext] = []

    stage_by_id = {s.scene_id: s for s in state.scenes}
    script_by_id = {s.script_scene_id: s for s in state.script.scenes}

    # 1. Prefer explicitly accepted scenes from Batch 1 AI Director analysis
    if state.director and state.director.scenes:
        items_by_id = {it.item_id: it for it in state.director.extracted_items}
        chars_by_id = {c.character_analysis_id: c for c in state.director.characters}
        accepted = [s for s in state.director.scenes if s.review_status == "accepted"]
        for idx, sb in enumerate(accepted, start=1):
            canonical_id = sb.applied_stage_scene_id or sb.scene_breakdown_id
            stage_sc = stage_by_id.get(sb.applied_stage_scene_id or "")
            target_ms = (
                stage_sc.duration_ms
                if stage_sc
                else int(round(((sb.suggested_duration_min_s + sb.suggested_duration_max_s) / 2.0) * 1000))
            )
            dlg_lines: list[dict[str, str]] = []
            for did in sb.dialogue_item_ids:
                it = items_by_id.get(did)
                if it:
                    spk_ch = chars_by_id.get(it.speaker_character_analysis_id or "")
                    dlg_lines.append(
                        {
                            "ref_id": it.item_id,
                            "item_type": it.item_type,
                            "speaker": spk_ch.canonical_name if spk_ch else it.speaker_name_raw,
                            "text": it.original_text,
                        }
                    )
            nar_lines: list[dict[str, str]] = []
            for nid in sb.narration_item_ids:
                it = items_by_id.get(nid)
                if it:
                    nar_lines.append(
                        {
                            "ref_id": it.item_id,
                            "item_type": it.item_type,
                            "speaker": it.speaker_name_raw,
                            "text": it.original_text,
                        }
                    )
            approved.append(
                ApprovedSceneContext(
                    scene_id=canonical_id,
                    scene_number=idx,
                    title=sb.title or f"Scene {idx}",
                    location=sb.location,
                    time_of_day=sb.time_of_day,
                    environment=sb.environment or sb.location,
                    main_action=sb.main_action,
                    emotional_beat=sb.emotional_beat,
                    scene_purpose=sb.scene_purpose,
                    conflict=sb.conflict,
                    atmosphere=sb.atmosphere,
                    visual_opportunities=list(sb.visual_opportunities),
                    characters_present=list(sb.characters_present),
                    source_text=sb.source_text,
                    dialogue_lines=dlg_lines,
                    narration_lines=nar_lines,
                    target_duration_ms=max(2000, target_ms),
                    scene_breakdown_id=sb.scene_breakdown_id,
                    script_scene_id=sb.applied_script_scene_id,
                    stage_scene_id=sb.applied_stage_scene_id,
                    source_kind="director_accepted",
                )
            )
        if approved:
            return approved

    # 2. Fallback: existing structured ScriptScenes (when user authored scenes manually)
    if state.script and state.script.scenes:
        for idx, ssc in enumerate(state.script.scenes, start=1):
            canonical_id = ssc.linked_stage_scene_id or ssc.script_scene_id
            stage_sc = stage_by_id.get(ssc.linked_stage_scene_id or "")
            dlg_lines = [
                {
                    "ref_id": e.entry_id,
                    "item_type": "dialogue",
                    "speaker": e.narrator_label or "",
                    "text": e.text,
                }
                for e in ssc.entries
                if e.entry_type == "dialogue" and e.text.strip()
            ]
            nar_lines = [
                {
                    "ref_id": e.entry_id,
                    "item_type": "narration" if e.entry_type == "narration" else "action",
                    "speaker": e.narrator_label or "",
                    "text": e.text,
                }
                for e in ssc.entries
                if e.entry_type in ("narration", "action") and e.text.strip()
            ]
            approved.append(
                ApprovedSceneContext(
                    scene_id=canonical_id,
                    scene_number=idx,
                    title=ssc.title or f"Scene {idx}",
                    location=ssc.location,
                    time_of_day=ssc.time_of_day,
                    environment=ssc.location,
                    main_action=ssc.description,
                    emotional_beat="",
                    scene_purpose=ssc.notes,
                    conflict="",
                    atmosphere="",
                    visual_opportunities=[],
                    characters_present=[],
                    source_text="\n".join(e.text for e in ssc.entries if e.text.strip()),
                    dialogue_lines=dlg_lines,
                    narration_lines=nar_lines,
                    target_duration_ms=max(
                        3000,
                        stage_sc.duration_ms if stage_sc else (ssc.estimated_duration_ms or 8000),
                    ),
                    script_scene_id=ssc.script_scene_id,
                    stage_scene_id=ssc.linked_stage_scene_id,
                    source_kind="script_scene",
                )
            )
        return approved

    # 3. Fallback: Stage Scenes when no script/director scenes exist yet
    for idx, sc in enumerate(sorted(state.scenes, key=lambda x: x.order_index), start=1):
        approved.append(
            ApprovedSceneContext(
                scene_id=sc.scene_id,
                scene_number=idx,
                title=sc.name or f"Scene {idx}",
                location="",
                time_of_day="",
                environment="",
                main_action="",
                emotional_beat="",
                scene_purpose="",
                conflict="",
                atmosphere="",
                visual_opportunities=[],
                characters_present=[c.display_name for c in sc.characters],
                source_text="",
                dialogue_lines=[],
                narration_lines=[],
                target_duration_ms=max(3000, sc.duration_ms),
                script_scene_id=script_by_id.get(sc.scene_id).script_scene_id if sc.scene_id in script_by_id else None,
                stage_scene_id=sc.scene_id,
                source_kind="stage_scene",
            )
        )
    return approved


class StoryboardService:
    """Orchestrates AI Storyboard generation, shot regeneration, continuity & progress."""

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
        self._progress: dict[str, StoryboardProgress] = {}
        self._cancel_events: dict[str, asyncio.Event] = {}
        self._active_locks: dict[str, asyncio.Lock] = {}

    def _get_lock(self, project_id: str) -> asyncio.Lock:
        if project_id not in self._active_locks:
            self._active_locks[project_id] = asyncio.Lock()
        return self._active_locks[project_id]

    def get_progress(self, project_id: str) -> StoryboardProgress:
        return self._progress.get(project_id) or StoryboardProgress(
            project_id=project_id, status="idle"
        )

    def cancel_generation(self, project_id: str) -> StoryboardProgress:
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

    async def _set_progress(self, prog: StoryboardProgress) -> None:
        self._progress[prog.project_id] = prog
        try:
            await self.ws_hub.broadcast_event("storyboard_progress", prog.model_dump())
        except Exception:
            pass

    def list_approved_scenes_summary(self, project_id: str) -> list[dict[str, Any]]:
        state = self.project_repo.get_project_state(project_id)
        approved = resolve_approved_scenes(state)
        existing_shots = state.storyboard.shots if state.storyboard else []
        existing_hashes = state.storyboard.scene_hashes if state.storyboard else {}

        summaries: list[dict[str, Any]] = []
        for sc in approved:
            sc_shots = [sh for sh in existing_shots if sh.scene_id == sc.scene_id]
            total_shot_ms = sum(sh.duration_ms for sh in sc_shots)
            locked_count = sum(1 for sh in sc_shots if sh.locked)
            summaries.append(
                {
                    "scene_id": sc.scene_id,
                    "scene_number": sc.scene_number,
                    "title": sc.title,
                    "location": sc.location,
                    "time_of_day": sc.time_of_day,
                    "characters_present": sc.characters_present,
                    "target_duration_ms": sc.target_duration_ms,
                    "total_shot_duration_ms": total_shot_ms,
                    "shot_count": len(sc_shots),
                    "locked_shot_count": locked_count,
                    "is_stale": bool(
                        sc_shots and existing_hashes.get(sc.scene_id) != sc.content_hash()
                    ),
                    "source_kind": sc.source_kind,
                    "scene_breakdown_id": sc.scene_breakdown_id,
                    "script_scene_id": sc.script_scene_id,
                    "stage_scene_id": sc.stage_scene_id,
                }
            )
        return summaries

    def _build_character_lookup(self, state: ProjectState) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]]]:
        """Build grounded character lookup from Library Characters + Batch 1 Director Characters."""
        lib_chars = self.library_repo.list_characters()
        lib_by_id = {c.character_id: c for c in lib_chars}
        lib_by_norm = {_norm(c.name): c for c in lib_chars}

        lookup: dict[str, dict[str, Any]] = {}
        roster_summary: list[dict[str, Any]] = []

        # 1. Batch 1 extracted characters (including aliases & explicit library links)
        if state.director and state.director.characters:
            for ch in state.director.characters:
                lib_obj = (
                    lib_by_id.get(ch.linked_character_id)
                    if ch.linked_character_id
                    else lib_by_norm.get(_norm(ch.canonical_name))
                )
                entry = {
                    "canonical_name": ch.canonical_name,
                    "character_analysis_id": ch.character_analysis_id,
                    "library_character_id": lib_obj.character_id if lib_obj else None,
                    "role": ch.role,
                    "expressions": [e.name for e in lib_obj.expressions] if lib_obj else [],
                }
                lookup[_norm(ch.canonical_name)] = entry
                for al in ch.aliases:
                    ak = _norm(al)
                    if ak and ak not in lookup:
                        lookup[ak] = entry
                roster_summary.append(entry)

        # 2. Any remaining Library Characters not yet in director list
        for lc in lib_chars:
            key = _norm(lc.name)
            if key not in lookup:
                entry = {
                    "canonical_name": lc.name,
                    "character_analysis_id": None,
                    "library_character_id": lc.character_id,
                    "role": lc.description,
                    "expressions": [e.name for e in lc.expressions],
                }
                lookup[key] = entry
                roster_summary.append(entry)

        return lookup, roster_summary

    def _normalize_shot(
        self,
        raw: _LLMShotProposal,
        *,
        scene_ctx: ApprovedSceneContext,
        char_lookup: dict[str, dict[str, Any]],
        shot_order: int,
        existing_shot_id: str | None = None,
    ) -> StoryboardShot:
        shot_size: ShotSize = (
            raw.shot_size if raw.shot_size in _VALID_SHOT_SIZES else "medium"  # type: ignore[assignment]
        )
        camera_angle: CameraAngle = (
            raw.camera_angle if raw.camera_angle in _VALID_ANGLES else "eye_level"  # type: ignore[assignment]
        )
        camera_movement: CameraMovement = (
            raw.camera_movement if raw.camera_movement in _VALID_MOVEMENTS else "static"  # type: ignore[assignment]
        )
        transition_out: ShotTransition = (
            raw.transition_out if raw.transition_out in _VALID_TRANSITIONS else "cut"  # type: ignore[assignment]
        )

        support_status, support_note = evaluate_camera_movement_support(camera_movement)
        angle_note = evaluate_camera_angle_note(camera_angle)
        cam_plan: Camera2DKeyPlan = build_default_2d_camera_plan(
            shot_size, camera_angle, camera_movement
        )

        warnings = _dedupe_strs(list(raw.warnings))
        if support_status == "unsupported_suggestion":
            warnings.append(f"Camera movement '{camera_movement}': {support_note}")

        # Ground character staging strictly against existing character references (never invent library IDs!)
        staged: list[ShotCharacterStaging] = []
        seen_names: set[str] = set()
        for raw_st in raw.characters:
            cname = (raw_st.character_name or "").strip()
            if not cname:
                continue
            info = char_lookup.get(_norm(cname))
            resolved_name = info["canonical_name"] if info else cname
            if _norm(resolved_name) in seen_names:
                continue
            seen_names.add(_norm(resolved_name))

            lib_id = info["library_character_id"] if info else None
            analysis_id = info["character_analysis_id"] if info else None
            missing_asset = lib_id is None
            if missing_asset:
                warnings.append(
                    f"Character '{resolved_name}' has no linked Character Library asset yet."
                )

            pos: ScreenPosition = (
                raw_st.screen_position if raw_st.screen_position in _VALID_POSITIONS else "center"  # type: ignore[assignment]
            )
            depth: DepthLayer = (
                raw_st.depth_layer if raw_st.depth_layer in _VALID_DEPTHS else "midground"  # type: ignore[assignment]
            )
            facing: FacingDirection = (
                raw_st.facing_direction if raw_st.facing_direction in _VALID_FACINGS else "front"  # type: ignore[assignment]
            )
            staged.append(
                ShotCharacterStaging(
                    staging_id=f"stg_{uuid.uuid4().hex[:8]}",
                    character_analysis_id=analysis_id,
                    library_character_id=lib_id,
                    character_name=resolved_name,
                    is_missing_asset=missing_asset,
                    visible=bool(raw_st.visible) and pos != "offscreen",
                    speaking=bool(raw_st.speaking),
                    reacting=bool(raw_st.reacting),
                    screen_position=pos,
                    depth_layer=depth,
                    facing_direction=facing,
                    action=raw_st.action.strip(),
                    expression=raw_st.expression.strip() or "neutral",
                    movement=raw_st.movement.strip(),
                )
            )

        # Ground dialogue & narration references against authoritative scene lines when matching ref_id
        scene_dlg_by_id = {d["ref_id"]: d for d in scene_ctx.dialogue_lines}
        scene_nar_by_id = {n["ref_id"]: n for n in scene_ctx.narration_lines}

        dlg_refs: list[ShotScriptRef] = []
        for r in raw.dialogue_refs:
            auth = scene_dlg_by_id.get(r.ref_id)
            excerpt = auth["text"] if auth else (r.text_excerpt or "").strip()
            if not excerpt:
                continue
            dlg_refs.append(
                ShotScriptRef(
                    ref_id=r.ref_id or f"ref_{uuid.uuid4().hex[:6]}",
                    item_type="internal_thought" if r.item_type == "internal_thought" else "dialogue",
                    speaker_name=(auth["speaker"] if auth else r.speaker_name).strip(),
                    text_excerpt=excerpt,
                )
            )

        nar_refs: list[ShotScriptRef] = []
        for r in raw.narration_refs:
            auth = scene_nar_by_id.get(r.ref_id)
            excerpt = auth["text"] if auth else (r.text_excerpt or "").strip()
            if not excerpt:
                continue
            nar_refs.append(
                ShotScriptRef(
                    ref_id=r.ref_id or f"ref_{uuid.uuid4().hex[:6]}",
                    item_type="action" if r.item_type == "action" else "narration",
                    speaker_name=(auth["speaker"] if auth else r.speaker_name).strip(),
                    text_excerpt=excerpt,
                )
            )

        action_blob = " ".join(c.action for c in staged if c.action) or raw.purpose
        duration_ms = estimate_shot_duration_ms(
            dialogue_refs=dlg_refs,
            narration_refs=nar_refs,
            action_text=action_blob,
            camera_movement=camera_movement,
            emotional_emphasis=raw.emotional_emphasis,
            shot_size=shot_size,
            ai_suggested_ms=raw.duration_ms if raw.duration_ms else None,
        )

        shot = StoryboardShot(
            shot_id=existing_shot_id or f"shot_{uuid.uuid4().hex[:8]}",
            scene_id=scene_ctx.scene_id,
            scene_breakdown_id=scene_ctx.scene_breakdown_id,
            script_scene_id=scene_ctx.script_scene_id,
            shot_order=shot_order,
            title=raw.title.strip() or f"{scene_ctx.title} — Shot {shot_order}",
            purpose=raw.purpose.strip(),
            shot_size=shot_size,
            camera_angle=camera_angle,
            camera_movement=camera_movement,
            camera_support_status=support_status,
            camera_support_note=support_note,
            camera_angle_note=angle_note,
            camera_plan=cam_plan,
            duration_ms=duration_ms,
            start_time_ms=0,
            end_time_ms=duration_ms,
            characters=staged,
            dialogue_refs=dlg_refs,
            narration_refs=nar_refs,
            environment=raw.environment.strip() or scene_ctx.environment or scene_ctx.location,
            visual_focus=raw.visual_focus.strip(),
            emotional_emphasis=raw.emotional_emphasis.strip() or scene_ctx.emotional_beat,
            props_in_shot=_dedupe_strs(raw.props_in_shot),
            transition_out=transition_out,
            ai_rationale=raw.ai_rationale.strip(),
            confidence=max(0.0, min(1.0, float(raw.confidence))),
            warnings=_dedupe_strs(warnings),
            locked=False,
            user_edited_fields=[],
        )
        shot.original_ai_snapshot = shot.model_dump(exclude={"original_ai_snapshot"})
        return shot

    def _build_scene_prompt(
        self,
        *,
        state: ProjectState,
        scene_ctx: ApprovedSceneContext,
        roster: list[dict[str, Any]],
        previous_scene_last_shot: StoryboardShot | None,
        locked_shots: list[StoryboardShot],
        instructions: str = "",
    ) -> str:
        story_brief = ""
        if state.director and state.director.story_overview:
            ov = state.director.story_overview
            story_brief = f"STORY: {ov.title} ({ov.genre}) | Tone: {ov.narrative_tone} | Premise: {ov.premise}\n"

        roster_json = json.dumps(roster, ensure_ascii=False)
        dlg_json = json.dumps(scene_ctx.dialogue_lines, ensure_ascii=False)
        nar_json = json.dumps(scene_ctx.narration_lines, ensure_ascii=False)

        prev_ctx = ""
        if previous_scene_last_shot is not None:
            prev_ctx = (
                f"PREVIOUS SCENE LAST SHOT (for transition continuity): "
                f"{previous_scene_last_shot.title} | size={previous_scene_last_shot.shot_size} | "
                f"transition_out={previous_scene_last_shot.transition_out}\n"
            )

        locked_ctx = ""
        if locked_shots:
            locked_brief = [
                {
                    "shot_order": s.shot_order,
                    "title": s.title,
                    "shot_size": s.shot_size,
                    "camera_angle": s.camera_angle,
                    "characters": [
                        {
                            "name": c.character_name,
                            "pos": c.screen_position,
                            "facing": c.facing_direction,
                        }
                        for c in s.characters
                    ],
                }
                for s in locked_shots
            ]
            locked_ctx = (
                f"LOCKED SHOTS IN THIS SCENE (preserved — plan complementary unlocked shots maintaining continuity): "
                f"{json.dumps(locked_brief, ensure_ascii=False)}\n"
            )

        extra = f"USER DIRECTOR INSTRUCTIONS: {instructions}\n" if instructions.strip() else ""

        return (
            f"{story_brief}"
            f"PROJECT RESOLUTION: {state.meta.width}x{state.meta.height} @ {state.meta.fps}fps\n"
            f"KNOWN CHARACTERS (DO NOT INVENT NEW CHARACTERS): {roster_json}\n"
            f"{prev_ctx}"
            f"{locked_ctx}"
            f"APPROVED SCENE #{scene_ctx.scene_number}: {scene_ctx.title}\n"
            f"- Location: {scene_ctx.location or 'Unspecified'} | Time of Day: {scene_ctx.time_of_day or 'Unspecified'}\n"
            f"- Environment: {scene_ctx.environment}\n"
            f"- Characters Present: {', '.join(scene_ctx.characters_present) or '(none listed)'}\n"
            f"- Main Action: {scene_ctx.main_action}\n"
            f"- Emotional Beat: {scene_ctx.emotional_beat} | Conflict: {scene_ctx.conflict}\n"
            f"- Atmosphere: {scene_ctx.atmosphere} | Visual Opportunities: {'; '.join(scene_ctx.visual_opportunities)}\n"
            f"- Target Scene Duration: ~{scene_ctx.target_duration_ms} ms\n"
            f"- Verbatim Dialogue Lines: {dlg_json}\n"
            f"- Verbatim Narration/Action Lines: {nar_json}\n"
            f"- Grounded Source Text:\n{scene_ctx.source_text}\n"
            f"{extra}\n"
            "Generate a tight, purposeful storyboard shot list (`shots`) covering this scene with varied realistic `duration_ms`, "
            "clear camera direction, grounded character staging, and continuity across consecutive shots."
        )

    async def generate_storyboard(
        self,
        project_id: str,
        req: StoryboardGenerateRequest,
    ) -> StoryboardDocument:
        """Generate or update storyboard shots across approved scenes with incremental persistence."""
        if req.strategy == "replace_all" and not req.confirm_replace_all:
            raise ValueError(
                "Regenerating and replacing all shots (including locked shots) requires explicit user confirmation (`confirm_replace_all=true`)."
            )

        lock = self._get_lock(project_id)
        if lock.locked():
            raise RuntimeError("A storyboard generation job is already running for this project.")

        async with lock:
            state = self.project_repo.get_project_state(project_id)
            approved_all = resolve_approved_scenes(state)
            if not approved_all:
                raise ValueError(
                    "No approved scenes available for storyboard generation. Approve at least one scene in AI Director or add scenes to the project first."
                )

            if req.scene_ids:
                requested_set = set(req.scene_ids)
                targets = [sc for sc in approved_all if sc.scene_id in requested_set]
                if not targets:
                    raise FileNotFoundError("None of the requested scene_ids matched approved scenes.")
            else:
                targets = approved_all

            provider, ai_cfg = self.llm_registry.get_provider_for_feature("storyboard")
            analysis_lang = req.analysis_language or ai_cfg.analysis_language
            sys_prompt = _storyboard_system_prompt(analysis_lang)
            char_lookup, roster = self._build_character_lookup(state)

            existing_doc = state.storyboard or StoryboardDocument(
                storyboard_id=f"sbdoc_{uuid.uuid4().hex[:10]}",
                version=0,
            )
            working_shots = list(existing_doc.shots)
            working_hashes = dict(existing_doc.scene_hashes)
            working_history = list(existing_doc.generation_history)

            cancel_event = asyncio.Event()
            self._cancel_events[project_id] = cancel_event
            started_at = utc_now_iso()
            total_scenes = len(targets)
            generated_count = 0
            preserved_locked_total = 0
            completed_scenes = 0

            await self._set_progress(
                StoryboardProgress(
                    project_id=project_id,
                    status="running",
                    stage="preparing",
                    current_scene=0,
                    total_scenes=total_scenes,
                    progress_pct=5.0,
                    message=f"Preparing storyboard plan for {total_scenes} approved scene(s)...",
                    started_at=started_at,
                )
            )

            def _persist_current(doc_status: str) -> StoryboardDocument:
                nonlocal working_shots
                working_shots = recalculate_scene_shot_timings(working_shots)
                warnings = analyze_storyboard_continuity(
                    working_shots, existing_doc.continuity_warnings
                )
                doc = StoryboardDocument(
                    storyboard_id=existing_doc.storyboard_id or f"sbdoc_{uuid.uuid4().hex[:10]}",
                    version=existing_doc.version + 1,
                    provider_id=ai_cfg.provider_id,
                    model=ai_cfg.model,
                    analysis_language=analysis_lang,  # type: ignore[arg-type]
                    status=doc_status,  # type: ignore[arg-type]
                    shots=working_shots,
                    continuity_warnings=warnings,
                    scene_hashes=working_hashes,
                    generation_history=working_history[-25:],
                    updated_at=utc_now_iso(),
                )
                latest_state = self.project_repo.get_project_state(project_id)
                self.project_repo.save_project_state(
                    latest_state.model_copy(update={"storyboard": doc}),
                    create_backup=False,
                )
                return doc

            try:
                prev_scene_last_shot: StoryboardShot | None = None
                for idx, sc in enumerate(targets, start=1):
                    if cancel_event.is_set():
                        raise LLMCancelledError("Storyboard generation cancelled by user.")

                    sc_hash = sc.content_hash()
                    existing_for_scene = [s for s in working_shots if s.scene_id == sc.scene_id]

                    # Skip unchanged scenes when not forced
                    if (
                        not req.force
                        and existing_for_scene
                        and working_hashes.get(sc.scene_id) == sc_hash
                    ):
                        completed_scenes += 1
                        prev_scene_last_shot = existing_for_scene[-1]
                        await self._set_progress(
                            StoryboardProgress(
                                project_id=project_id,
                                status="running",
                                stage="skipping_unchanged",
                                current_scene=idx,
                                total_scenes=total_scenes,
                                current_scene_title=sc.title,
                                progress_pct=round((idx / total_scenes) * 90.0, 1),
                                message=f"Scene {idx}/{total_scenes} unchanged — reusing existing {len(existing_for_scene)} shot(s).",
                                started_at=started_at,
                            )
                        )
                        continue

                    locked_shots = (
                        [s for s in existing_for_scene if s.locked]
                        if req.strategy == "preserve_locked"
                        else []
                    )
                    preserved_locked_total += len(locked_shots)

                    await self._set_progress(
                        StoryboardProgress(
                            project_id=project_id,
                            status="running",
                            stage="generating_scene",
                            current_scene=idx,
                            total_scenes=total_scenes,
                            current_scene_title=sc.title,
                            progress_pct=round(((idx - 0.5) / total_scenes) * 90.0, 1),
                            message=f"Directing shots for Scene {idx}/{total_scenes}: {sc.title}...",
                            started_at=started_at,
                        )
                    )

                    prompt = self._build_scene_prompt(
                        state=state,
                        scene_ctx=sc,
                        roster=roster,
                        previous_scene_last_shot=prev_scene_last_shot,
                        locked_shots=locked_shots,
                    )
                    llm_out: _LLMSceneShotsResponse = await _invoke_structured(
                        provider,
                        prompt=prompt,
                        schema=_LLMSceneShotsResponse,
                        system_prompt=sys_prompt,
                        model=ai_cfg.model,
                        cancel_event=cancel_event,
                    )

                    if not llm_out.shots:
                        raise ValueError(
                            f"AI provider returned zero storyboard shots for scene '{sc.title}'."
                        )

                    new_scene_shots: list[StoryboardShot] = []
                    for s_i, raw_sh in enumerate(llm_out.shots, start=1):
                        new_scene_shots.append(
                            self._normalize_shot(
                                raw_sh,
                                scene_ctx=sc,
                                char_lookup=char_lookup,
                                shot_order=s_i,
                            )
                        )

                    # Merge locked shots back into their anchored positions when preserving locked shots
                    if locked_shots:
                        merged_scene_shots = self._merge_locked_and_generated(
                            locked_shots, new_scene_shots
                        )
                    else:
                        merged_scene_shots = new_scene_shots

                    # Replace only this scene's shots inside `working_shots` preserving other scenes' order
                    other_shots = [s for s in working_shots if s.scene_id != sc.scene_id]
                    working_shots = self._insert_scene_shots_in_approved_order(
                        other_shots, merged_scene_shots, approved_all
                    )
                    working_hashes[sc.scene_id] = sc_hash
                    generated_count += len(new_scene_shots)
                    completed_scenes += 1
                    prev_scene_last_shot = merged_scene_shots[-1] if merged_scene_shots else None

                    # Persist incrementally after EACH scene so completed work survives partial failure!
                    _persist_current("partial" if idx < total_scenes else "generated")

                working_history.append(
                    StoryboardGenerationRecord(
                        record_id=f"sbrec_{uuid.uuid4().hex[:8]}",
                        scope="storyboard" if len(targets) > 1 else "scene",
                        target_id="all" if len(targets) > 1 else targets[0].scene_id,
                        strategy=req.strategy,
                        provider_id=ai_cfg.provider_id,
                        model=ai_cfg.model,
                        shots_generated=generated_count,
                        preserved_locked_count=preserved_locked_total,
                        warnings_count=len(
                            analyze_storyboard_continuity(working_shots, existing_doc.continuity_warnings)
                        ),
                        status="completed",
                        message=f"Generated {generated_count} shot(s) across {completed_scenes} scene(s).",
                    )
                )
                final_doc = _persist_current("generated")

                await self._set_progress(
                    StoryboardProgress(
                        project_id=project_id,
                        status="completed",
                        stage="completed",
                        current_scene=total_scenes,
                        total_scenes=total_scenes,
                        progress_pct=100.0,
                        message=f"Storyboard complete: {len(final_doc.shots)} shot(s), {len(final_doc.continuity_warnings)} continuity check(s).",
                        started_at=started_at,
                        ended_at=utc_now_iso(),
                    )
                )
                return final_doc

            except LLMCancelledError as exc:
                if completed_scenes > 0:
                    working_history.append(
                        StoryboardGenerationRecord(
                            record_id=f"sbrec_{uuid.uuid4().hex[:8]}",
                            scope="storyboard",
                            target_id="partial",
                            strategy=req.strategy,
                            provider_id=ai_cfg.provider_id,
                            model=ai_cfg.model,
                            shots_generated=generated_count,
                            preserved_locked_count=preserved_locked_total,
                            status="cancelled",
                            message=f"Cancelled after {completed_scenes}/{total_scenes} scene(s); completed work preserved.",
                        )
                    )
                    _persist_current("partial")
                await self._set_progress(
                    StoryboardProgress(
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
                    working_history.append(
                        StoryboardGenerationRecord(
                            record_id=f"sbrec_{uuid.uuid4().hex[:8]}",
                            scope="storyboard",
                            target_id="partial",
                            strategy=req.strategy,
                            provider_id=ai_cfg.provider_id,
                            model=ai_cfg.model,
                            shots_generated=generated_count,
                            preserved_locked_count=preserved_locked_total,
                            status="partial",
                            message=f"Failed after {completed_scenes}/{total_scenes} scene(s): {exc}",
                        )
                    )
                    _persist_current("partial")
                await self._set_progress(
                    StoryboardProgress(
                        project_id=project_id,
                        status="partial" if completed_scenes > 0 else "failed",
                        stage="failed",
                        current_scene=completed_scenes,
                        total_scenes=total_scenes,
                        progress_pct=round((completed_scenes / max(1, total_scenes)) * 100.0, 1),
                        message=f"Storyboard generation failed: {exc}",
                        error=str(exc),
                        started_at=started_at,
                        ended_at=utc_now_iso(),
                    )
                )
                raise
            finally:
                self._cancel_events.pop(project_id, None)

    async def generate_scene_storyboard(
        self,
        project_id: str,
        scene_id: str,
        req: SceneStoryboardGenerateRequest,
    ) -> StoryboardDocument:
        """Generate or regenerate shots for a single approved scene."""
        if req.strategy == "replace_all" and not req.confirm_replace_all:
            raise ValueError(
                "Regenerating the entire scene (including locked shots) requires explicit confirmation (`confirm_replace_all=true`)."
            )

        lock = self._get_lock(project_id)
        if lock.locked():
            raise RuntimeError("A storyboard generation job is already running for this project.")

        async with lock:
            state = self.project_repo.get_project_state(project_id)
            approved_all = resolve_approved_scenes(state)
            target_idx = next((i for i, sc in enumerate(approved_all) if sc.scene_id == scene_id), -1)
            if target_idx == -1:
                raise FileNotFoundError(f"Approved scene not found: {scene_id}")

            sc = approved_all[target_idx]
            provider, ai_cfg = self.llm_registry.get_provider_for_feature("storyboard")
            analysis_lang = req.analysis_language or ai_cfg.analysis_language
            sys_prompt = _storyboard_system_prompt(analysis_lang)
            char_lookup, roster = self._build_character_lookup(state)

            existing_doc = state.storyboard or StoryboardDocument(
                storyboard_id=f"sbdoc_{uuid.uuid4().hex[:10]}",
                version=0,
            )
            existing_for_scene = [s for s in existing_doc.shots if s.scene_id == scene_id]
            locked_shots = (
                [s for s in existing_for_scene if s.locked]
                if req.strategy == "preserve_locked"
                else []
            )

            prev_scene_last: StoryboardShot | None = None
            if target_idx > 0:
                prev_sid = approved_all[target_idx - 1].scene_id
                prev_shots = [s for s in existing_doc.shots if s.scene_id == prev_sid]
                if prev_shots:
                    prev_scene_last = prev_shots[-1]

            prompt = self._build_scene_prompt(
                state=state,
                scene_ctx=sc,
                roster=roster,
                previous_scene_last_shot=prev_scene_last,
                locked_shots=locked_shots,
                instructions=req.instructions,
            )
            llm_out: _LLMSceneShotsResponse = await _invoke_structured(
                provider,
                prompt=prompt,
                schema=_LLMSceneShotsResponse,
                system_prompt=sys_prompt,
                model=ai_cfg.model,
                cancel_event=None,
            )
            if not llm_out.shots:
                raise ValueError(f"AI provider returned zero storyboard shots for scene '{sc.title}'.")

            generated = [
                self._normalize_shot(raw_sh, scene_ctx=sc, char_lookup=char_lookup, shot_order=i)
                for i, raw_sh in enumerate(llm_out.shots, start=1)
            ]
            merged = (
                self._merge_locked_and_generated(locked_shots, generated)
                if locked_shots
                else generated
            )
            other_shots = [s for s in existing_doc.shots if s.scene_id != scene_id]
            all_shots = recalculate_scene_shot_timings(
                self._insert_scene_shots_in_approved_order(other_shots, merged, approved_all)
            )
            warnings = analyze_storyboard_continuity(all_shots, existing_doc.continuity_warnings)

            hashes = dict(existing_doc.scene_hashes)
            hashes[scene_id] = sc.content_hash()
            history = list(existing_doc.generation_history)
            history.append(
                StoryboardGenerationRecord(
                    record_id=f"sbrec_{uuid.uuid4().hex[:8]}",
                    scope="scene",
                    target_id=scene_id,
                    strategy=req.strategy,
                    provider_id=ai_cfg.provider_id,
                    model=ai_cfg.model,
                    shots_generated=len(generated),
                    preserved_locked_count=len(locked_shots),
                    warnings_count=len(warnings),
                    status="completed",
                    message=f"Scene '{sc.title}': {len(generated)} shot(s) generated, {len(locked_shots)} locked preserved.",
                )
            )

            next_doc = StoryboardDocument(
                storyboard_id=existing_doc.storyboard_id or f"sbdoc_{uuid.uuid4().hex[:10]}",
                version=existing_doc.version + 1,
                provider_id=ai_cfg.provider_id,
                model=ai_cfg.model,
                analysis_language=analysis_lang,  # type: ignore[arg-type]
                status="generated",
                shots=all_shots,
                continuity_warnings=warnings,
                scene_hashes=hashes,
                generation_history=history[-25:],
                updated_at=utc_now_iso(),
            )
            self.project_repo.patch_project_sections(project_id, storyboard=next_doc)
            return next_doc

    async def regenerate_single_shot(
        self,
        project_id: str,
        shot_id: str,
        req: RegenerateShotRequest,
    ) -> StoryboardShot:
        """Regenerate one unlocked shot with neighboring continuity context while preserving `user_edited_fields`."""
        state = self.project_repo.get_project_state(project_id)
        if not state.storyboard:
            raise FileNotFoundError("No storyboard exists for this project yet.")

        doc = state.storyboard
        idx = next((i for i, s in enumerate(doc.shots) if s.shot_id == shot_id), -1)
        if idx == -1:
            raise FileNotFoundError(f"Storyboard shot not found: {shot_id}")

        existing = doc.shots[idx]
        if existing.locked:
            raise ValueError(
                f"Shot #{existing.shot_order} ('{existing.title}') is locked. Unlock it before regenerating."
            )

        approved = resolve_approved_scenes(state)
        scene_ctx = next((s for s in approved if s.scene_id == existing.scene_id), None)
        if scene_ctx is None:
            scene_ctx = ApprovedSceneContext(
                scene_id=existing.scene_id,
                scene_number=1,
                title=existing.title,
                location=existing.environment,
                time_of_day="",
                environment=existing.environment,
                main_action=existing.purpose,
                emotional_beat=existing.emotional_emphasis,
                scene_purpose=existing.purpose,
                conflict="",
                atmosphere="",
                visual_opportunities=[],
                characters_present=[c.character_name for c in existing.characters],
                source_text="",
                dialogue_lines=[],
                narration_lines=[],
                target_duration_ms=existing.duration_ms,
                scene_breakdown_id=existing.scene_breakdown_id,
                script_scene_id=existing.script_scene_id,
            )

        scene_shots = [s for s in doc.shots if s.scene_id == existing.scene_id]
        pos_in_scene = next((i for i, s in enumerate(scene_shots) if s.shot_id == shot_id), 0)
        prev_sh = scene_shots[pos_in_scene - 1] if pos_in_scene > 0 else None
        next_sh = scene_shots[pos_in_scene + 1] if pos_in_scene + 1 < len(scene_shots) else None

        provider, ai_cfg = self.llm_registry.get_provider_for_feature("storyboard")
        sys_prompt = _storyboard_system_prompt(doc.analysis_language)
        char_lookup, roster = self._build_character_lookup(state)

        prompt = (
            f"Regenerate ONLY Shot #{existing.shot_order} in Scene '{scene_ctx.title}'.\n"
            f"KNOWN CHARACTERS: {json.dumps(roster, ensure_ascii=False)}\n"
            f"PREVIOUS SHOT: {prev_sh.title if prev_sh else '(Start of scene)'} "
            f"{json.dumps([{'name': c.character_name, 'pos': c.screen_position, 'facing': c.facing_direction} for c in prev_sh.characters], ensure_ascii=False) if prev_sh else ''}\n"
            f"CURRENT SHOT TO IMPROVE: {json.dumps(existing.model_dump(exclude={'original_ai_snapshot'}), ensure_ascii=False)}\n"
            f"NEXT SHOT: {next_sh.title if next_sh else '(End of scene)'}\n"
            f"USER INSTRUCTIONS: {req.instructions or '(Refine visual framing, camera direction, and character staging while maintaining strict continuity.)'}\n"
            "Return a single JSON shot proposal."
        )

        proposal: _LLMShotProposal = await _invoke_structured(
            provider,
            prompt=prompt,
            schema=_LLMShotProposal,
            system_prompt=sys_prompt,
            model=ai_cfg.model,
            cancel_event=None,
        )

        fresh = self._normalize_shot(
            proposal,
            scene_ctx=scene_ctx,
            char_lookup=char_lookup,
            shot_order=existing.shot_order,
            existing_shot_id=existing.shot_id,
        )

        preserved = set(existing.user_edited_fields) if req.preserve_user_edits else set()

        def pick(field: str) -> Any:
            return getattr(existing, field) if field in preserved else getattr(fresh, field)

        final_movement: CameraMovement = pick("camera_movement")
        final_angle: CameraAngle = pick("camera_angle")
        final_size: ShotSize = pick("shot_size")
        sup_status, sup_note = evaluate_camera_movement_support(final_movement)
        angle_note = evaluate_camera_angle_note(final_angle)
        cam_plan = (
            existing.camera_plan
            if "camera_plan" in preserved
            else build_default_2d_camera_plan(final_size, final_angle, final_movement)
        )

        regenerated = existing.model_copy(
            update={
                "title": pick("title"),
                "purpose": pick("purpose"),
                "shot_size": final_size,
                "camera_angle": final_angle,
                "camera_movement": final_movement,
                "camera_support_status": sup_status,
                "camera_support_note": sup_note,
                "camera_angle_note": angle_note,
                "camera_plan": cam_plan,
                "duration_ms": pick("duration_ms"),
                "characters": pick("characters"),
                "dialogue_refs": pick("dialogue_refs"),
                "narration_refs": pick("narration_refs"),
                "environment": pick("environment"),
                "visual_focus": pick("visual_focus"),
                "emotional_emphasis": pick("emotional_emphasis"),
                "props_in_shot": pick("props_in_shot"),
                "transition_out": pick("transition_out"),
                "ai_rationale": pick("ai_rationale"),
                "confidence": fresh.confidence,
                "warnings": fresh.warnings,
                "user_edited_fields": list(existing.user_edited_fields) if req.preserve_user_edits else [],
            }
        )

        next_shots = list(doc.shots)
        next_shots[idx] = regenerated
        next_shots = recalculate_scene_shot_timings(next_shots)
        recalculated_shot = next(s for s in next_shots if s.shot_id == shot_id)
        warnings = analyze_storyboard_continuity(next_shots, doc.continuity_warnings)
        history = list(doc.generation_history)
        history.append(
            StoryboardGenerationRecord(
                record_id=f"sbrec_{uuid.uuid4().hex[:8]}",
                scope="shot",
                target_id=shot_id,
                strategy="preserve_user_edits" if req.preserve_user_edits else "replace_shot",
                provider_id=ai_cfg.provider_id,
                model=ai_cfg.model,
                shots_generated=1,
                warnings_count=len(warnings),
                status="completed",
                message=f"Regenerated shot #{recalculated_shot.shot_order} (preserved {len(preserved)} edited field(s)).",
            )
        )
        next_doc = doc.model_copy(
            update={
                "shots": next_shots,
                "continuity_warnings": warnings,
                "generation_history": history[-25:],
                "updated_at": utc_now_iso(),
            }
        )
        self.project_repo.patch_project_sections(project_id, storyboard=next_doc)
        return recalculated_shot

    def run_continuity_check(self, project_id: str) -> ContinuityCheckResponse:
        state = self.project_repo.get_project_state(project_id)
        if not state.storyboard or not state.storyboard.shots:
            return ContinuityCheckResponse(warnings=[], total_shots_checked=0)
        warnings = analyze_storyboard_continuity(
            state.storyboard.shots,
            state.storyboard.continuity_warnings,
        )
        next_doc = state.storyboard.model_copy(
            update={"continuity_warnings": warnings, "updated_at": utc_now_iso()}
        )
        self.project_repo.save_project_state(
            state.model_copy(update={"storyboard": next_doc}),
            create_backup=False,
        )
        return ContinuityCheckResponse(
            warnings=warnings,
            total_shots_checked=len(state.storyboard.shots),
        )

    @staticmethod
    def _merge_locked_and_generated(
        locked_shots: list[StoryboardShot],
        generated_shots: list[StoryboardShot],
    ) -> list[StoryboardShot]:
        """Keep every locked shot intact at its relative slot while placing generated shots around them."""
        locked_sorted = sorted(locked_shots, key=lambda s: s.shot_order)
        locked_slots: dict[int, StoryboardShot] = {s.shot_order: s for s in locked_sorted}
        max_slot = max(
            max((s.shot_order for s in locked_sorted), default=0),
            len(locked_sorted) + len(generated_shots),
        )
        gen_iter = iter(generated_shots)
        merged: list[StoryboardShot] = []
        for slot in range(1, max_slot + 1):
            if slot in locked_slots:
                merged.append(locked_slots[slot])
            else:
                nxt = next(gen_iter, None)
                if nxt is not None:
                    merged.append(nxt)
        for rem in gen_iter:
            merged.append(rem)
        return merged

    @staticmethod
    def _insert_scene_shots_in_approved_order(
        other_shots: list[StoryboardShot],
        scene_shots: list[StoryboardShot],
        approved_scenes: list[ApprovedSceneContext],
    ) -> list[StoryboardShot]:
        order_map = {sc.scene_id: idx for idx, sc in enumerate(approved_scenes)}
        combined = [*other_shots, *scene_shots]
        combined.sort(key=lambda s: (order_map.get(s.scene_id, 99999), s.shot_order))
        return combined
