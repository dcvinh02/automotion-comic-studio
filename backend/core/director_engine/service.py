"""Phase 06 Batch 1 — Script Intelligence Engine & Automatic Scene Breakdown Service.

Orchestrates real LLM structured analysis with:
- Grounded paragraph indexing (never mutating the user's original script)
- Large-script chunking with rolling context & post-chunk consolidation
- Conservative alias resolution & explicit ambiguity flagging
- Verbatim dialogue / narration preservation
- Per-scene regeneration preserving user-edited fields
- Async progress tracking, duplicate-request guard, and cancellation
"""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import re
import uuid
from typing import Any

from pydantic import BaseModel, Field

from app.logging_config import get_logger
from database.library_repo import LibraryRepository
from database.project_repo import ProjectRepository
from providers.interfaces import LLMProvider
from providers.llm_provider import (
    LLMCancelledError,
    LLMProviderRegistry,
    PROVIDER_CATALOG,
)
from schemas.common import utc_now_iso
from schemas.director import (
    AIProviderConfig,
    AnalysisLanguage,
    AnalysisProgress,
    CharacterRelationship,
    DirectorAnalysisDocument,
    DirectorAnalyzeRequest,
    ExtractedCharacter,
    ExtractedItemType,
    ExtractedScriptItem,
    NarrativeBeat,
    ProductionAnalysis,
    RegenerateSceneRequest,
    SceneBreakdownItem,
    SceneImportance,
    StoryOverview,
)
from schemas.project import ProjectState
from workers.ws_hub import WebSocketHub

logger = get_logger("director_engine")


# --- Structured LLM Wire Schemas (validated by Pydantic before touching project data) ---


class _LLMCharacterRelation(BaseModel):
    target_name: str = ""
    relationship_type: str = ""
    description: str = ""


class _LLMExtractedCharacter(BaseModel):
    canonical_name: str
    aliases: list[str] = Field(default_factory=list)
    ambiguous_aliases: list[str] = Field(default_factory=list)
    role: str = ""
    personality: str = ""
    appearance_description: str = "unspecified"
    appearance_specified: bool = False
    relationships: list[_LLMCharacterRelation] = Field(default_factory=list)
    narrative_importance: str = "supporting"
    emotional_states: list[str] = Field(default_factory=list)
    actions: list[str] = Field(default_factory=list)
    confidence: float = 0.8
    notes: str = ""


class _LLMExtractedItem(BaseModel):
    item_type: str = "dialogue"
    original_text: str
    speaker_name_raw: str = ""
    speaker_unresolved: bool = False
    paragraph_index: int = 0
    language: str = "unknown"
    emotion: str = ""
    notes: str = ""


class _LLMSceneProposal(BaseModel):
    title: str = ""
    source_paragraphs: list[int] = Field(default_factory=list)
    location: str = ""
    time_of_day: str = ""
    environment: str = ""
    characters_present: list[str] = Field(default_factory=list)
    character_entrances: list[str] = Field(default_factory=list)
    character_exits: list[str] = Field(default_factory=list)
    main_action: str = ""
    emotional_beat: str = ""
    scene_purpose: str = ""
    conflict: str = ""
    visual_opportunities: list[str] = Field(default_factory=list)
    atmosphere: str = ""
    suggested_duration_min_s: int = 6
    suggested_duration_max_s: int = 12
    importance: str = "medium"
    transition_suggestion: str = ""
    ai_confidence: float = 0.8
    unresolved_questions: list[str] = Field(default_factory=list)


class _LLMNarrativeBeat(BaseModel):
    stage: str = ""
    label: str = ""
    summary: str = ""
    source_paragraphs: list[int] = Field(default_factory=list)
    uncertainty_note: str = ""
    confidence: float = 0.75


class _LLMStoryOverview(BaseModel):
    title: str = ""
    genre: str = ""
    premise: str = ""
    synopsis: str = ""
    themes: list[str] = Field(default_factory=list)
    narrative_tone: str = ""
    story_structure: str = ""
    structure_uncertainty: str = ""
    conflict: str = ""
    turning_points: list[str] = Field(default_factory=list)
    climax: str = ""
    ending: str = ""
    narrative_beats: list[_LLMNarrativeBeat] = Field(default_factory=list)


class _LLMProductionAnalysis(BaseModel):
    visual_opportunities: list[str] = Field(default_factory=list)
    action_moments: list[str] = Field(default_factory=list)
    emotional_beats: list[str] = Field(default_factory=list)
    dramatic_pauses: list[str] = Field(default_factory=list)
    establishing_shots: list[str] = Field(default_factory=list)
    environmental_details: list[str] = Field(default_factory=list)
    transition_ideas: list[str] = Field(default_factory=list)
    vfx_scenes: list[str] = Field(default_factory=list)


class _LLMChunkAnalysisResult(BaseModel):
    rolling_summary: str = ""
    story_overview: _LLMStoryOverview | None = None
    production_analysis: _LLMProductionAnalysis | None = None
    characters: list[_LLMExtractedCharacter] = Field(default_factory=list)
    extracted_items: list[_LLMExtractedItem] = Field(default_factory=list)
    scenes: list[_LLMSceneProposal] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class _LLMGlobalSynthesisResult(BaseModel):
    story_overview: _LLMStoryOverview = Field(default_factory=_LLMStoryOverview)
    production_analysis: _LLMProductionAnalysis = Field(default_factory=_LLMProductionAnalysis)
    warnings: list[str] = Field(default_factory=list)


# --- Helpers ---

_VALID_ITEM_TYPES: set[str] = {
    "dialogue",
    "narration",
    "internal_thought",
    "action",
    "scene_description",
    "sound_cue",
}
_VALID_IMPORTANCE: set[str] = {"low", "medium", "high", "climax"}
_VALID_CHAR_IMPORTANCE: set[str] = {"main", "supporting", "minor", "unspecified"}


def _norm_name(name: str) -> str:
    return re.sub(r"\s+", " ", (name or "").strip().lower())


def _dedupe_strs(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for x in items:
        clean = (x or "").strip()
        if not clean:
            continue
        k = clean.lower()
        if k not in seen:
            seen.add(k)
            out.append(clean)
    return out


def extract_script_paragraphs(
    state: ProjectState,
    *,
    mode: str = "auto",
    custom_text: str | None = None,
) -> tuple[list[str], str]:
    """Extract clean ordered paragraphs from script without ever mutating project.script."""
    resolved_mode = mode
    raw_blob = ""

    if mode == "custom_text":
        raw_blob = (custom_text or "").strip()
    elif mode == "raw_text":
        raw_blob = (state.script.raw_source_text or "").strip()
    elif mode == "structured_scenes":
        raw_blob = _flatten_structured_script(state)
    else:
        # auto: prefer raw_source_text if present, else flatten structured scenes
        if (state.script.raw_source_text or "").strip():
            raw_blob = state.script.raw_source_text.strip()
            resolved_mode = "raw_text"
        else:
            raw_blob = _flatten_structured_script(state)
            resolved_mode = "structured_scenes"

    if not raw_blob:
        raise ValueError(
            "Script is empty. Write or paste script text in Script Editor or AI Director before running analysis."
        )

    # Reject binary/control-char junk or trivially meaningless non-text input
    printable = sum(1 for ch in raw_blob if ch.isprintable() or ch in "\n\r\t")
    if len(raw_blob) > 0 and (printable / float(len(raw_blob))) < 0.85:
        raise ValueError("Invalid script content: contains excessive non-printable binary characters.")
    if not any(ch.isalnum() for ch in raw_blob):
        raise ValueError("Invalid script content: no readable words found.")

    normalized = raw_blob.replace("\r\n", "\n").replace("\r", "\n")
    blocks = [b.strip() for b in re.split(r"\n\s*\n+", normalized) if b.strip()]
    # If user wrote single-newline-separated screenplay lines with no blank lines, split cleanly by line
    if len(blocks) == 1 and "\n" in blocks[0]:
        blocks = [ln.strip() for ln in blocks[0].split("\n") if ln.strip()]

    return blocks, resolved_mode


def _flatten_structured_script(state: ProjectState) -> str:
    chunks: list[str] = []
    for idx, sc in enumerate(sorted(state.script.scenes, key=lambda s: s.order_index), start=1):
        header_parts = [f"Scene {idx}: {sc.title}".strip()]
        if sc.location:
            header_parts.append(f"[{sc.location}]")
        if sc.time_of_day:
            header_parts.append(f"({sc.time_of_day})")
        chunks.append(" ".join(header_parts))
        if sc.description.strip():
            chunks.append(sc.description.strip())
        for entry in sorted(sc.entries, key=lambda e: e.order_index):
            txt = entry.text.strip()
            if not txt:
                continue
            if entry.entry_type == "dialogue":
                speaker = entry.character_id or "SPEAKER"
                chunks.append(f"{speaker}: {txt}")
            elif entry.entry_type == "narration":
                chunks.append(f"[{entry.narrator_label or 'Narrator'}] {txt}")
            else:
                chunks.append(txt)
    return "\n\n".join(chunks).strip()


def split_paragraphs_into_chunks(
    paragraphs: list[str],
    max_chunk_chars: int = 6000,
) -> list[list[tuple[int, str]]]:
    """Split numbered paragraphs into token-safe chunks without ever truncating text."""
    limit = max(1200, max_chunk_chars)
    chunks: list[list[tuple[int, str]]] = []
    current: list[tuple[int, str]] = []
    cur_len = 0

    for idx, para in enumerate(paragraphs):
        p_len = len(para) + 12
        if current and cur_len + p_len > limit:
            chunks.append(current)
            current = [(idx, para)]
            cur_len = p_len
        else:
            current.append((idx, para))
            cur_len += p_len

    if current:
        chunks.append(current)
    return chunks


def _language_directive(lang: AnalysisLanguage) -> str:
    if lang == "vi":
        return "Write all analysis descriptions, summaries, scene titles, and notes in Vietnamese (Tiếng Việt). ALWAYS preserve `original_text` of extracted dialogue/narration in the script's original language verbatim."
    if lang == "en":
        return "Write all analysis descriptions, summaries, scene titles, and notes in English. ALWAYS preserve `original_text` of extracted dialogue/narration in the script's original language verbatim."
    return "Write analysis descriptions in the primary language of the script (Vietnamese if Vietnamese, English if English). ALWAYS preserve `original_text` of extracted dialogue/narration verbatim in its original language."


def _system_prompt(lang: AnalysisLanguage) -> str:
    return (
        "You are an expert 2D Motion Comic Script Intelligence & Storyboarding Director.\n"
        "Strict Production Rules:\n"
        "1. NEVER invent story events or character visual appearances. If a character's physical appearance is not explicitly described in the script, set `appearance_description` to \"unspecified\" and `appearance_specified` to false.\n"
        "2. Resolve character aliases conservatively when context clearly refers to the same person (e.g. 'Minh' and 'Minh Anh'). Place any uncertain/ambiguous nickname or pronoun reference into `ambiguous_aliases` for human review.\n"
        "3. Preserve `original_text` of every dialogue, narration, internal_thought, action, scene_description, and sound_cue VERBATIM from the script. Do NOT rewrite dialogue. If a speaker is uncertain, set `speaker_unresolved` to true.\n"
        "4. Propose meaningful production scenes based on location changes, time shifts, dramatic transitions, entrances/exits, or visual context changes — NOT arbitrary paragraph length.\n"
        "5. Do NOT force a rigid three-act structure; if narrative structure is ambiguous, explain clearly in `structure_uncertainty`.\n"
        "6. Ground every scene with accurate 0-based `source_paragraphs` indices from the provided numbered paragraphs.\n"
        f"7. {_language_directive(lang)}"
    )


async def _invoke_structured(
    provider: LLMProvider,
    *,
    prompt: str,
    schema: type[BaseModel],
    system_prompt: str,
    model: str,
    cancel_event: asyncio.Event | None,
) -> Any:
    """Invoke LLMProvider.generate_structured, passing cancel_event if supported."""
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


class DirectorService:
    """Orchestrates Script Intelligence, Chunked Analysis, Scene Regeneration & Progress."""

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
        self._progress: dict[str, AnalysisProgress] = {}
        self._cancel_events: dict[str, asyncio.Event] = {}
        self._active_locks: dict[str, asyncio.Lock] = {}

    def _get_lock(self, project_id: str) -> asyncio.Lock:
        if project_id not in self._active_locks:
            self._active_locks[project_id] = asyncio.Lock()
        return self._active_locks[project_id]

    def get_progress(self, project_id: str) -> AnalysisProgress:
        return self._progress.get(project_id) or AnalysisProgress(project_id=project_id, status="idle")

    def cancel_analysis(self, project_id: str) -> AnalysisProgress:
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

    async def _set_progress(self, progress: AnalysisProgress) -> None:
        self._progress[progress.project_id] = progress
        try:
            await self.ws_hub.broadcast_event("director_progress", progress.model_dump())
        except Exception:
            pass

    async def analyze_project_script(
        self,
        project_id: str,
        req: DirectorAnalyzeRequest,
    ) -> DirectorAnalysisDocument:
        lock = self._get_lock(project_id)
        if lock.locked():
            raise RuntimeError("An AI script analysis is already running for this project.")

        async with lock:
            state = self.project_repo.get_project_state(project_id)
            paragraphs, resolved_mode = extract_script_paragraphs(
                state,
                mode=req.script_source_mode,
                custom_text=req.custom_script_text,
            )

            script_hash = hashlib.sha256("\n\n".join(paragraphs).encode("utf-8")).hexdigest()
            provider, ai_cfg = self.llm_registry.get_provider_for_feature("script_analysis")
            analysis_lang: AnalysisLanguage = req.analysis_language or ai_cfg.analysis_language

            # Avoid redundant re-analysis of identical unchanged script unless force=True
            if (
                not req.force
                and state.director is not None
                and state.director.source_script_hash == script_hash
                and state.director.status in ("analyzed", "partially_accepted", "accepted")
                and state.director.analysis_language == analysis_lang
                and len(state.director.scenes) > 0
            ):
                logger.info("Reusing cached director analysis for project %s (hash unchanged)", project_id)
                return state.director

            cancel_event = asyncio.Event()
            self._cancel_events[project_id] = cancel_event
            started_at = utc_now_iso()

            chunk_limit = req.max_chunk_chars or ai_cfg.max_chunk_chars
            provider_meta = PROVIDER_CATALOG.get(ai_cfg.provider_id, {})
            ctx_limit = int(provider_meta.get("context_limit_chars", 32000))
            total_chars = sum(len(p) for p in paragraphs)
            chunks = split_paragraphs_into_chunks(paragraphs, max_chunk_chars=chunk_limit)
            total_chunks = len(chunks)

            context_warning = ""
            context_note = f"Single-pass analysis ({len(paragraphs)} paragraphs, {total_chars} chars)."
            if total_chunks > 1:
                context_note = (
                    f"Chunked rolling-context analysis: {total_chunks} chunks "
                    f"({len(paragraphs)} paragraphs, {total_chars} chars, limit {chunk_limit} chars/chunk) "
                    "followed by cross-chunk character/scene consolidation."
                )
                if total_chars > ctx_limit:
                    context_warning = (
                        f"Script length ({total_chars} chars) exceeds single-request context budget "
                        f"({ctx_limit} chars); automatically split into {total_chunks} lossless chunks."
                    )

            await self._set_progress(
                AnalysisProgress(
                    project_id=project_id,
                    status="running",
                    stage="preparing",
                    current_chunk=0,
                    total_chunks=total_chunks,
                    progress_pct=5.0,
                    message=f"Preparing {len(paragraphs)} paragraphs across {total_chunks} chunk(s)...",
                    context_limit_warning=context_warning,
                    started_at=started_at,
                )
            )

            existing_lib_chars = self.library_repo.list_characters()
            sys_prompt = _system_prompt(analysis_lang)

            rolling_summary = ""
            known_chars_brief: list[dict[str, Any]] = []
            chunk_results: list[tuple[list[tuple[int, str]], _LLMChunkAnalysisResult]] = []

            try:
                for c_idx, chunk_pairs in enumerate(chunks, start=1):
                    if cancel_event.is_set():
                        raise LLMCancelledError("Script analysis cancelled by user.")

                    pct = 10.0 + ((c_idx - 1) / float(max(1, total_chunks))) * 68.0
                    await self._set_progress(
                        AnalysisProgress(
                            project_id=project_id,
                            status="running",
                            stage="analyzing_chunk",
                            current_chunk=c_idx,
                            total_chunks=total_chunks,
                            progress_pct=round(pct, 1),
                            message=f"Analyzing chunk {c_idx}/{total_chunks} via {ai_cfg.provider_id} ({ai_cfg.model})...",
                            context_limit_warning=context_warning,
                            started_at=started_at,
                        )
                    )

                    formatted_paras = "\n".join(f"[P{idx}] {txt}" for idx, txt in chunk_pairs)
                    context_header = ""
                    if c_idx > 1:
                        context_header = (
                            f"PREVIOUS STORY SUMMARY:\n{rolling_summary or '(none)'}\n\n"
                            f"KNOWN CHARACTERS SO FAR (reuse canonical names & resolve aliases consistently):\n"
                            f"{known_chars_brief}\n\n"
                        )

                    include_overview_note = (
                        "Include complete `story_overview` and `production_analysis`."
                        if total_chunks == 1
                        else "Focus on accurate `rolling_summary`, `characters`, `extracted_items`, and `scenes` for this chunk."
                    )

                    user_prompt = (
                        f"PROJECT: {state.meta.name}\n"
                        f"EPISODE TITLE: {state.script.episode_title or state.meta.name}\n"
                        f"CHUNK {c_idx} OF {total_chunks} (paragraph indices P{chunk_pairs[0][0]}..P{chunk_pairs[-1][0]}):\n\n"
                        f"{context_header}"
                        f"SCRIPT PARAGRAPHS:\n{formatted_paras}\n\n"
                        f"INSTRUCTIONS:\n{include_overview_note}\n"
                        "Return structured JSON strictly matching the schema."
                    )

                    chunk_res: _LLMChunkAnalysisResult = await _invoke_structured(
                        provider,
                        prompt=user_prompt,
                        schema=_LLMChunkAnalysisResult,
                        system_prompt=sys_prompt,
                        model=ai_cfg.model,
                        cancel_event=cancel_event,
                    )
                    chunk_results.append((chunk_pairs, chunk_res))
                    if chunk_res.rolling_summary.strip():
                        rolling_summary = (
                            (rolling_summary + " " + chunk_res.rolling_summary.strip()).strip()[-1500:]
                        )
                    for ch in chunk_res.characters:
                        if not any(_norm_name(k["name"]) == _norm_name(ch.canonical_name) for k in known_chars_brief):
                            known_chars_brief.append(
                                {"name": ch.canonical_name, "aliases": ch.aliases[:6]}
                            )

                if cancel_event.is_set():
                    raise LLMCancelledError("Script analysis cancelled by user.")

                # Consolidate characters, items, scenes across all chunks
                await self._set_progress(
                    AnalysisProgress(
                        project_id=project_id,
                        status="running",
                        stage="consolidating",
                        current_chunk=total_chunks,
                        total_chunks=total_chunks,
                        progress_pct=82.0,
                        message="Consolidating characters, aliases, dialogue, and scene boundaries...",
                        context_limit_warning=context_warning,
                        started_at=started_at,
                    )
                )

                consolidated_chars, consolidated_items, consolidated_scenes, warnings = (
                    self._consolidate_chunks(
                        paragraphs=paragraphs,
                        chunk_results=chunk_results,
                        existing_library_chars=existing_lib_chars,
                    )
                )

                # Story Overview + Production Analysis
                if total_chunks == 1 and chunk_results[0][1].story_overview is not None:
                    story_ov = self._convert_story_overview(chunk_results[0][1].story_overview)
                    prod_an = self._convert_production_analysis(chunk_results[0][1].production_analysis)
                else:
                    await self._set_progress(
                        AnalysisProgress(
                            project_id=project_id,
                            status="running",
                            stage="synthesizing_overview",
                            current_chunk=total_chunks,
                            total_chunks=total_chunks,
                            progress_pct=90.0,
                            message="Synthesizing full story overview & production analysis...",
                            context_limit_warning=context_warning,
                            started_at=started_at,
                        )
                    )
                    scene_briefs = "\n".join(
                        f"Scene {s.scene_number:02d} (P{s.source_paragraphs[:1] or ['?']}): {s.title} — {s.scene_purpose or s.main_action}"
                        for s in consolidated_scenes
                    )
                    char_briefs = ", ".join(c.canonical_name for c in consolidated_chars) or "(no named characters)"
                    synth_prompt = (
                        f"PROJECT: {state.meta.name}\n"
                        f"ROLLING SUMMARY:\n{rolling_summary}\n\n"
                        f"CHARACTERS: {char_briefs}\n\n"
                        f"CONSOLIDATED SCENES ({len(consolidated_scenes)}):\n{scene_briefs}\n\n"
                        "Produce the complete global `story_overview` (including `narrative_beats` and honest `structure_uncertainty` if ambiguous) and `production_analysis`."
                    )
                    synth: _LLMGlobalSynthesisResult = await _invoke_structured(
                        provider,
                        prompt=synth_prompt,
                        schema=_LLMGlobalSynthesisResult,
                        system_prompt=sys_prompt,
                        model=ai_cfg.model,
                        cancel_event=cancel_event,
                    )
                    story_ov = self._convert_story_overview(synth.story_overview)
                    prod_an = self._convert_production_analysis(synth.production_analysis)
                    warnings.extend(synth.warnings)

                if not story_ov.title:
                    story_ov.title = state.script.episode_title or state.meta.name
                if context_warning:
                    warnings.insert(0, context_warning)

                now = utc_now_iso()
                prev_version = state.director.version if state.director else 0
                doc = DirectorAnalysisDocument(
                    analysis_id=f"dir_{uuid.uuid4().hex[:10]}",
                    version=prev_version + 1,
                    script_source_mode=resolved_mode,  # type: ignore[arg-type]
                    source_script_hash=script_hash,
                    source_paragraphs=paragraphs,
                    provider_id=ai_cfg.provider_id,
                    model=ai_cfg.model,
                    analysis_language=analysis_lang,
                    status="analyzed",
                    analyzed_at=now,
                    updated_at=now,
                    story_overview=story_ov,
                    production_analysis=prod_an,
                    characters=consolidated_chars,
                    extracted_items=consolidated_items,
                    scenes=consolidated_scenes,
                    original_scenes_snapshot=[s.model_dump(exclude={"original_ai_snapshot"}) for s in consolidated_scenes],
                    warnings=_dedupe_strs(warnings),
                    context_strategy_note=context_note,
                )

                # Persist director analysis into project.db WITHOUT touching state.script or state.scenes!
                # Re-read and replace ONLY the director section: `state` was loaded before the
                # LLM calls and saving it would revert edits made meanwhile (Phase 09.1 fix).
                self.project_repo.patch_project_sections(project_id, director=doc)

                await self._set_progress(
                    AnalysisProgress(
                        project_id=project_id,
                        status="completed",
                        stage="completed",
                        current_chunk=total_chunks,
                        total_chunks=total_chunks,
                        progress_pct=100.0,
                        message=f"Analysis complete: {len(consolidated_chars)} character(s), {len(consolidated_scenes)} proposed scene(s).",
                        context_limit_warning=context_warning,
                        started_at=started_at,
                        ended_at=utc_now_iso(),
                    )
                )
                return doc

            except LLMCancelledError as exc:
                await self._set_progress(
                    AnalysisProgress(
                        project_id=project_id,
                        status="cancelled",
                        stage="cancelled",
                        current_chunk=len(chunk_results),
                        total_chunks=total_chunks,
                        progress_pct=0.0,
                        message=str(exc),
                        error=str(exc),
                        started_at=started_at,
                        ended_at=utc_now_iso(),
                    )
                )
                raise
            except Exception as exc:
                await self._set_progress(
                    AnalysisProgress(
                        project_id=project_id,
                        status="failed",
                        stage="failed",
                        current_chunk=len(chunk_results),
                        total_chunks=total_chunks,
                        progress_pct=0.0,
                        message=f"Analysis failed: {exc}",
                        error=str(exc),
                        started_at=started_at,
                        ended_at=utc_now_iso(),
                    )
                )
                raise
            finally:
                self._cancel_events.pop(project_id, None)

    async def regenerate_single_scene(
        self,
        project_id: str,
        scene_breakdown_id: str,
        req: RegenerateSceneRequest,
    ) -> SceneBreakdownItem:
        """Regenerate one proposed scene from its grounded source text while preserving user_edited_fields."""
        state = self.project_repo.get_project_state(project_id)
        if not state.director:
            raise FileNotFoundError("No AI Director analysis exists for this project yet.")

        doc = state.director
        idx = next(
            (i for i, s in enumerate(doc.scenes) if s.scene_breakdown_id == scene_breakdown_id),
            -1,
        )
        if idx == -1:
            raise FileNotFoundError(f"Scene breakdown not found: {scene_breakdown_id}")

        existing = doc.scenes[idx]
        provider, ai_cfg = self.llm_registry.get_provider_for_feature("ai_director")
        sys_prompt = _system_prompt(doc.analysis_language)
        prev_title = doc.scenes[idx - 1].title if idx > 0 else "(Start of story)"
        next_title = doc.scenes[idx + 1].title if idx + 1 < len(doc.scenes) else "(End of story)"

        prompt = (
            f"Regenerate the scene breakdown for Scene {existing.scene_number:02d}.\n"
            f"PREVIOUS SCENE: {prev_title}\n"
            f"NEXT SCENE: {next_title}\n"
            f"SOURCE PARAGRAPHS ({existing.source_paragraphs}):\n{existing.source_text}\n\n"
            f"USER INSTRUCTIONS: {req.instructions or '(Improve visual specificity, atmosphere, and production clarity while staying strictly grounded in the source text.)'}\n"
            "Return a single JSON scene proposal."
        )

        proposal: _LLMSceneProposal = await _invoke_structured(
            provider,
            prompt=prompt,
            schema=_LLMSceneProposal,
            system_prompt=sys_prompt,
            model=ai_cfg.model,
            cancel_event=None,
        )

        preserved = set(existing.user_edited_fields) if req.preserve_user_edits else set()

        def pick(field: str, new_val: Any) -> Any:
            if field in preserved:
                return getattr(existing, field)
            return new_val

        min_s = max(1, min(600, int(proposal.suggested_duration_min_s or 6)))
        max_s = max(min_s, min(600, int(proposal.suggested_duration_max_s or max(min_s + 4, 12))))
        imp = proposal.importance if proposal.importance in _VALID_IMPORTANCE else existing.importance

        regenerated = existing.model_copy(
            update={
                "title": pick("title", proposal.title.strip() or existing.title),
                "location": pick("location", proposal.location.strip()),
                "time_of_day": pick("time_of_day", proposal.time_of_day.strip()),
                "environment": pick("environment", proposal.environment.strip()),
                "characters_present": pick("characters_present", _dedupe_strs(proposal.characters_present)),
                "character_entrances": pick("character_entrances", _dedupe_strs(proposal.character_entrances)),
                "character_exits": pick("character_exits", _dedupe_strs(proposal.character_exits)),
                "main_action": pick("main_action", proposal.main_action.strip()),
                "emotional_beat": pick("emotional_beat", proposal.emotional_beat.strip()),
                "scene_purpose": pick("scene_purpose", proposal.scene_purpose.strip()),
                "conflict": pick("conflict", proposal.conflict.strip()),
                "visual_opportunities": pick("visual_opportunities", _dedupe_strs(proposal.visual_opportunities)),
                "atmosphere": pick("atmosphere", proposal.atmosphere.strip()),
                "suggested_duration_min_s": pick("suggested_duration_min_s", min_s),
                "suggested_duration_max_s": pick("suggested_duration_max_s", max_s),
                "importance": pick("importance", imp),
                "transition_suggestion": pick("transition_suggestion", proposal.transition_suggestion.strip()),
                "ai_confidence": max(0.0, min(1.0, float(proposal.ai_confidence))),
                "unresolved_questions": _dedupe_strs(proposal.unresolved_questions),
                "review_status": "edited" if preserved else "pending",
            }
        )

        next_scenes = list(doc.scenes)
        next_scenes[idx] = regenerated
        next_doc = doc.model_copy(update={"scenes": next_scenes, "updated_at": utc_now_iso()})
        self.project_repo.patch_project_sections(project_id, director=next_doc)
        return regenerated

    def _consolidate_chunks(
        self,
        *,
        paragraphs: list[str],
        chunk_results: list[tuple[list[tuple[int, str]], _LLMChunkAnalysisResult]],
        existing_library_chars: list,
    ) -> tuple[
        list[ExtractedCharacter],
        list[ExtractedScriptItem],
        list[SceneBreakdownItem],
        list[str],
    ]:
        warnings: list[str] = []
        lib_by_norm = {_norm_name(c.name): c.character_id for c in existing_library_chars}

        # 1. Consolidate Characters & Aliases conservatively across all chunks
        # Detect aliases claimed by >= 2 distinct canonical names so we NEVER over-merge them!
        alias_claims: dict[str, set[str]] = {}
        for _, res in chunk_results:
            for raw_ch in res.characters:
                cn = _norm_name(raw_ch.canonical_name)
                if not cn:
                    continue
                for al in raw_ch.aliases:
                    ak = _norm_name(al)
                    if ak and ak != cn:
                        alias_claims.setdefault(ak, set()).add(cn)
        shared_ambiguous_aliases = {ak for ak, owners in alias_claims.items() if len(owners) >= 2}

        chars: list[ExtractedCharacter] = []
        canonical_to_char: dict[str, ExtractedCharacter] = {}
        alias_to_char: dict[str, ExtractedCharacter] = {}

        def find_matching_char(
            name: str, aliases: list[str], same_chunk_ids: set[str]
        ) -> ExtractedCharacter | None:
            cn_key = _norm_name(name)
            # 1) Exact canonical name match always merges cleanly
            if cn_key in canonical_to_char:
                return canonical_to_char[cn_key]
            # 2) Cross-chunk match: incoming canonical name matches an unambiguous alias of an earlier chunk's character
            if cn_key and cn_key not in shared_ambiguous_aliases and cn_key in alias_to_char:
                cand = alias_to_char[cn_key]
                if cand.character_analysis_id not in same_chunk_ids:
                    return cand
            # 3) Cross-chunk match: an earlier chunk's canonical name appears explicitly in incoming aliases
            for al in aliases:
                ak = _norm_name(al)
                if ak and ak not in shared_ambiguous_aliases and ak in canonical_to_char:
                    cand = canonical_to_char[ak]
                    if cand.character_analysis_id not in same_chunk_ids:
                        return cand
            return None

        for chunk_pairs, res in chunk_results:
            warnings.extend(res.warnings)
            chunk_p_start = chunk_pairs[0][0]
            chunk_p_end = chunk_pairs[-1][0]
            same_chunk_ids: set[str] = set()

            for raw_ch in res.characters:
                cname = raw_ch.canonical_name.strip()
                if not cname:
                    continue
                matched = find_matching_char(cname, raw_ch.aliases, same_chunk_ids)
                if matched:
                    # Merge cleanly without losing any prior information
                    extra_aliases = [cname, *raw_ch.aliases]
                    matched.aliases = [
                        a
                        for a in _dedupe_strs([*matched.aliases, *extra_aliases])
                        if _norm_name(a) != _norm_name(matched.canonical_name)
                    ]
                    matched.ambiguous_aliases = _dedupe_strs(
                        [*matched.ambiguous_aliases, *raw_ch.ambiguous_aliases]
                    )
                    if not matched.role and raw_ch.role.strip():
                        matched.role = raw_ch.role.strip()
                    if not matched.personality and raw_ch.personality.strip():
                        matched.personality = raw_ch.personality.strip()
                    if (not matched.appearance_specified) and raw_ch.appearance_specified and raw_ch.appearance_description.strip().lower() != "unspecified":
                        matched.appearance_description = raw_ch.appearance_description.strip()
                        matched.appearance_specified = True
                    matched.emotional_states = _dedupe_strs([*matched.emotional_states, *raw_ch.emotional_states])
                    matched.actions = _dedupe_strs([*matched.actions, *raw_ch.actions])
                    for rel in raw_ch.relationships:
                        if rel.target_name.strip() and not any(
                            _norm_name(r.target_name) == _norm_name(rel.target_name) for r in matched.relationships
                        ):
                            matched.relationships.append(
                                CharacterRelationship(
                                    target_name=rel.target_name.strip(),
                                    relationship_type=rel.relationship_type.strip(),
                                    description=rel.description.strip(),
                                )
                            )
                    matched.last_appearance_paragraph = max(
                        matched.last_appearance_paragraph if matched.last_appearance_paragraph is not None else chunk_p_end,
                        chunk_p_end,
                    )
                    same_chunk_ids.add(matched.character_analysis_id)
                    canonical_to_char[_norm_name(matched.canonical_name)] = matched
                    for a in matched.aliases:
                        ak = _norm_name(a)
                        if ak and ak not in shared_ambiguous_aliases:
                            alias_to_char[ak] = matched
                else:
                    cid = f"achar_{uuid.uuid4().hex[:8]}"
                    imp = (
                        raw_ch.narrative_importance
                        if raw_ch.narrative_importance in _VALID_CHAR_IMPORTANCE
                        else "supporting"
                    )
                    app_desc = (raw_ch.appearance_description or "").strip()
                    app_spec = bool(
                        raw_ch.appearance_specified
                        and app_desc
                        and app_desc.lower() not in ("unspecified", "unknown", "none", "không rõ", "chưa mô tả")
                    )
                    clean_aliases = [
                        a for a in _dedupe_strs(raw_ch.aliases) if _norm_name(a) != _norm_name(cname)
                    ]
                    linked_lib = lib_by_norm.get(_norm_name(cname))
                    if not linked_lib:
                        for al in clean_aliases:
                            ak = _norm_name(al)
                            if ak not in shared_ambiguous_aliases and ak in lib_by_norm:
                                linked_lib = lib_by_norm[ak]
                                break

                    new_ch = ExtractedCharacter(
                        character_analysis_id=cid,
                        canonical_name=cname,
                        aliases=clean_aliases,
                        ambiguous_aliases=_dedupe_strs(raw_ch.ambiguous_aliases),
                        role=raw_ch.role.strip(),
                        personality=raw_ch.personality.strip(),
                        appearance_description=app_desc if app_spec else "unspecified",
                        appearance_specified=app_spec,
                        relationships=[
                            CharacterRelationship(
                                target_name=r.target_name.strip(),
                                relationship_type=r.relationship_type.strip(),
                                description=r.description.strip(),
                            )
                            for r in raw_ch.relationships
                            if r.target_name.strip()
                        ],
                        narrative_importance=imp,  # type: ignore[arg-type]
                        emotional_states=_dedupe_strs(raw_ch.emotional_states),
                        actions=_dedupe_strs(raw_ch.actions),
                        first_appearance_paragraph=chunk_p_start,
                        last_appearance_paragraph=chunk_p_end,
                        linked_character_id=linked_lib,
                        confidence=max(0.0, min(1.0, float(raw_ch.confidence))),
                        notes=raw_ch.notes.strip(),
                    )
                    chars.append(new_ch)
                    same_chunk_ids.add(new_ch.character_analysis_id)
                    canonical_to_char[_norm_name(new_ch.canonical_name)] = new_ch
                    for a in new_ch.aliases:
                        ak = _norm_name(a)
                        if ak and ak not in shared_ambiguous_aliases:
                            alias_to_char[ak] = new_ch

        # Flag shared ambiguous aliases & cross-character partial-token ambiguity (e.g. "Anh" in "Minh Anh" & "Tuấn Anh")
        for ch in chars:
            for al in ch.aliases:
                if _norm_name(al) in shared_ambiguous_aliases:
                    if al.lower() not in [a.lower() for a in ch.ambiguous_aliases]:
                        ch.ambiguous_aliases.append(al)
            tokens = _norm_name(ch.canonical_name).split()
            for other in chars:
                if other.character_analysis_id == ch.character_analysis_id:
                    continue
                other_tokens = _norm_name(other.canonical_name).split()
                shared_short = set(tokens) & set(other_tokens)
                for tok in shared_short:
                    if len(tok) >= 2 and any(_norm_name(al) == tok for al in [*ch.aliases, *other.aliases]):
                        if tok not in [a.lower() for a in ch.ambiguous_aliases]:
                            ch.ambiguous_aliases.append(tok)

        # Combine safe canonical + unambiguous alias lookup for speakers & relationships
        safe_name_lookup: dict[str, ExtractedCharacter] = {**alias_to_char, **canonical_to_char}
        alias_to_char = safe_name_lookup

        # Resolve relationship target IDs
        for ch in chars:
            for rel in ch.relationships:
                target = alias_to_char.get(_norm_name(rel.target_name))
                if target:
                    rel.target_character_analysis_id = target.character_analysis_id

        # 2. Consolidate Extracted Dialogue / Narration / Action / Sound items verbatim
        items: list[ExtractedScriptItem] = []
        order_counter = 0
        for chunk_pairs, res in chunk_results:
            valid_p_indices = [idx for idx, _ in chunk_pairs]
            p_min, p_max = valid_p_indices[0], valid_p_indices[-1]
            for raw_it in res.extracted_items:
                orig = (raw_it.original_text or "").strip()
                if not orig:
                    continue
                itype: ExtractedItemType = (
                    raw_it.item_type if raw_it.item_type in _VALID_ITEM_TYPES else "narration"  # type: ignore[assignment]
                )
                p_idx = raw_it.paragraph_index
                if p_idx < 0 or p_idx >= len(paragraphs):
                    p_idx = p_min
                elif p_idx < p_min or p_idx > p_max:
                    p_idx = max(p_min, min(p_max, p_idx))

                speaker_raw = (raw_it.speaker_name_raw or "").strip()
                matched_char = alias_to_char.get(_norm_name(speaker_raw)) if speaker_raw else None
                unresolved = bool(
                    raw_it.speaker_unresolved
                    or (itype in ("dialogue", "internal_thought") and not matched_char and not speaker_raw)
                )

                iid = f"sitem_{uuid.uuid4().hex[:8]}"
                item = ExtractedScriptItem(
                    item_id=iid,
                    item_type=itype,
                    original_text=orig,
                    speaker_character_analysis_id=matched_char.character_analysis_id if matched_char else None,
                    speaker_name_raw=speaker_raw,
                    speaker_unresolved=unresolved,
                    order_index=order_counter,
                    paragraph_index=p_idx,
                    language=(raw_it.language or "unknown").strip(),
                    emotion=(raw_it.emotion or "").strip(),
                    notes=(raw_it.notes or "").strip(),
                )
                items.append(item)
                order_counter += 1

                if matched_char:
                    if itype in ("dialogue", "internal_thought"):
                        matched_char.dialogue_item_ids.append(iid)
                    if matched_char.first_appearance_paragraph is None or p_idx < matched_char.first_appearance_paragraph:
                        matched_char.first_appearance_paragraph = p_idx
                    if matched_char.last_appearance_paragraph is None or p_idx > matched_char.last_appearance_paragraph:
                        matched_char.last_appearance_paragraph = p_idx

        # 3. Consolidate Proposed Scenes (grounding exact source_text + deduplicating overlap across chunks)
        scenes: list[SceneBreakdownItem] = []
        seen_para_ranges: set[tuple[int, ...]] = set()

        for chunk_pairs, res in chunk_results:
            chunk_indices = [idx for idx, _ in chunk_pairs]
            for raw_sc in res.scenes:
                valid_ps = sorted(
                    {p for p in raw_sc.source_paragraphs if 0 <= p < len(paragraphs)}
                )
                if not valid_ps:
                    valid_ps = list(chunk_indices)
                key = tuple(valid_ps)
                if key in seen_para_ranges:
                    continue
                seen_para_ranges.add(key)

                # Ground exact original script text from authoritative source paragraphs
                grounded_text = "\n\n".join(paragraphs[p] for p in valid_ps)
                sid = f"sb_{uuid.uuid4().hex[:8]}"

                # Map character names to canonical names when matched
                resolved_present = _dedupe_strs(
                    [
                        alias_to_char[_norm_name(n)].canonical_name if _norm_name(n) in alias_to_char else n
                        for n in raw_sc.characters_present
                    ]
                )
                min_s = max(1, min(600, int(raw_sc.suggested_duration_min_s or 6)))
                max_s = max(min_s, min(600, int(raw_sc.suggested_duration_max_s or max(min_s + 4, 12))))
                imp: SceneImportance = (
                    raw_sc.importance if raw_sc.importance in _VALID_IMPORTANCE else "medium"  # type: ignore[assignment]
                )

                # Attach dialogue/narration items whose paragraph_index belongs to this scene
                p_set = set(valid_ps)
                dlg_ids: list[str] = []
                nar_ids: list[str] = []
                for it in items:
                    if it.paragraph_index in p_set and it.scene_breakdown_id is None:
                        it.scene_breakdown_id = sid
                        if it.item_type in ("dialogue", "internal_thought"):
                            dlg_ids.append(it.item_id)
                        elif it.item_type in ("narration", "scene_description"):
                            nar_ids.append(it.item_id)

                sc_item = SceneBreakdownItem(
                    scene_breakdown_id=sid,
                    scene_number=len(scenes) + 1,
                    title=raw_sc.title.strip() or f"Scene {len(scenes) + 1:02d}",
                    source_paragraphs=valid_ps,
                    source_text=grounded_text,
                    location=raw_sc.location.strip(),
                    time_of_day=raw_sc.time_of_day.strip(),
                    environment=raw_sc.environment.strip(),
                    characters_present=resolved_present,
                    character_entrances=_dedupe_strs(raw_sc.character_entrances),
                    character_exits=_dedupe_strs(raw_sc.character_exits),
                    main_action=raw_sc.main_action.strip(),
                    dialogue_item_ids=dlg_ids,
                    narration_item_ids=nar_ids,
                    emotional_beat=raw_sc.emotional_beat.strip(),
                    scene_purpose=raw_sc.scene_purpose.strip(),
                    conflict=raw_sc.conflict.strip(),
                    visual_opportunities=_dedupe_strs(raw_sc.visual_opportunities),
                    atmosphere=raw_sc.atmosphere.strip(),
                    suggested_duration_min_s=min_s,
                    suggested_duration_max_s=max_s,
                    importance=imp,
                    transition_suggestion=raw_sc.transition_suggestion.strip(),
                    ai_confidence=max(0.0, min(1.0, float(raw_sc.ai_confidence))),
                    unresolved_questions=_dedupe_strs(raw_sc.unresolved_questions),
                    review_status="pending",
                    user_edited_fields=[],
                )
                sc_item.original_ai_snapshot = sc_item.model_dump(exclude={"original_ai_snapshot"})
                scenes.append(sc_item)

        # Ensure chronological scene order & sequential scene numbers
        scenes.sort(key=lambda s: (s.source_paragraphs[0] if s.source_paragraphs else 999999, s.scene_number))
        for i, sc in enumerate(scenes, start=1):
            sc.scene_number = i

        return chars, items, scenes, warnings

    @staticmethod
    def _convert_story_overview(raw: _LLMStoryOverview | None) -> StoryOverview:
        if raw is None:
            return StoryOverview()
        return StoryOverview(
            title=raw.title.strip(),
            genre=raw.genre.strip(),
            premise=raw.premise.strip(),
            synopsis=raw.synopsis.strip(),
            themes=_dedupe_strs(raw.themes),
            narrative_tone=raw.narrative_tone.strip(),
            story_structure=raw.story_structure.strip(),
            structure_uncertainty=raw.structure_uncertainty.strip(),
            conflict=raw.conflict.strip(),
            turning_points=_dedupe_strs(raw.turning_points),
            climax=raw.climax.strip(),
            ending=raw.ending.strip(),
            narrative_beats=[
                NarrativeBeat(
                    beat_id=f"beat_{i + 1}_{uuid.uuid4().hex[:5]}",
                    stage=b.stage.strip(),
                    label=b.label.strip(),
                    summary=b.summary.strip(),
                    source_paragraphs=list(b.source_paragraphs),
                    uncertainty_note=b.uncertainty_note.strip(),
                    confidence=max(0.0, min(1.0, float(b.confidence))),
                )
                for i, b in enumerate(raw.narrative_beats)
            ],
        )

    @staticmethod
    def _convert_production_analysis(raw: _LLMProductionAnalysis | None) -> ProductionAnalysis:
        if raw is None:
            return ProductionAnalysis()
        return ProductionAnalysis(
            visual_opportunities=_dedupe_strs(raw.visual_opportunities),
            action_moments=_dedupe_strs(raw.action_moments),
            emotional_beats=_dedupe_strs(raw.emotional_beats),
            dramatic_pauses=_dedupe_strs(raw.dramatic_pauses),
            establishing_shots=_dedupe_strs(raw.establishing_shots),
            environmental_details=_dedupe_strs(raw.environmental_details),
            transition_ideas=_dedupe_strs(raw.transition_ideas),
            vfx_scenes=_dedupe_strs(raw.vfx_scenes),
        )
