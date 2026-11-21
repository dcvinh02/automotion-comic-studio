"""Phase 06 Batch 1 — Script Intelligence Engine & Automatic Scene Breakdown schemas."""

from __future__ import annotations

from typing import Any, Literal
from pydantic import BaseModel, Field

from schemas.common import utc_now_iso

LLMProviderId = Literal[
    "openai",
    "anthropic",
    "gemini",
    "deepseek",
    "openrouter",
    "groq",
    "openai_compatible",
]
AIFeatureKey = Literal[
    "script_analysis",
    "script_generation",
    "character_analysis",
    "storyboard",
    "ai_director",
    "production_plan",
    "animation_planning",
    "asset_prompts",
]
AnalysisLanguage = Literal["auto", "vi", "en"]
ScriptSourceMode = Literal["auto", "raw_text", "structured_scenes", "custom_text"]
ReviewStatus = Literal["pending", "accepted", "rejected", "edited"]
ExtractedItemType = Literal[
    "dialogue",
    "narration",
    "internal_thought",
    "action",
    "scene_description",
    "sound_cue",
]
SceneImportance = Literal["low", "medium", "high", "climax"]


# --- AI Provider Config, Dynamic Model Discovery & Feature Overrides ---


class AIModelInfo(BaseModel):
    model_id: str
    display_name: str
    provider_id: LLMProviderId
    source: Literal["discovered", "catalog", "manual"] = "catalog"
    context_length: int | None = None
    supports_text: bool = True
    supports_structured_json: bool = True
    supports_vision: bool = False
    supports_reasoning: bool = False
    supports_tools: bool = False
    deprecated: bool = False
    notes: str = ""


class AIModelDiscoveryResult(BaseModel):
    provider_id: LLMProviderId
    models: list[AIModelInfo] = Field(default_factory=list)
    source: Literal["live_api", "cache", "catalog_fallback"] = "catalog_fallback"
    discovered_count: int = 0
    fetched_at: str | None = None
    error: str | None = None
    error_code: Literal[
        "none",
        "missing_credentials",
        "invalid_credentials",
        "rate_limited",
        "network_error",
        "http_error",
    ] = "none"
    selected_model_valid: bool = True
    selected_model_warning: str = ""


class FeatureModelOverride(BaseModel):
    provider_id: LLMProviderId | None = None
    model: str | None = None


class ModelCompatibilityRequest(BaseModel):
    feature_key: AIFeatureKey
    provider_id: LLMProviderId
    model: str
    estimated_input_chars: int = Field(default=0, ge=0)
    requires_vision: bool = False
    requires_tools: bool = False


class ModelCompatibilityResult(BaseModel):
    compatible: bool
    feature_key: AIFeatureKey
    provider_id: LLMProviderId
    model: str
    reasons: list[str] = Field(default_factory=list)
    recommended_models: list[str] = Field(default_factory=list)


class AIProviderConfig(BaseModel):
    provider_id: LLMProviderId = "openai"
    model: str = "gpt-4o-mini"
    base_url: str = ""
    api_key_configured: bool = False
    api_key_masked: str = ""
    api_key_source: Literal["none", "env", "settings"] = "none"
    timeout_seconds: int = Field(default=60, ge=5, le=300)
    max_retries: int = Field(default=2, ge=0, le=5)
    analysis_language: AnalysisLanguage = "auto"
    max_chunk_chars: int = Field(default=6000, ge=1500, le=32000)
    provider_models: dict[str, str] = Field(default_factory=dict)
    provider_base_urls: dict[str, str] = Field(default_factory=dict)
    feature_models: dict[str, FeatureModelOverride] = Field(default_factory=dict)


class AIProviderConfigUpdate(BaseModel):
    provider_id: LLMProviderId | None = None
    model: str | None = None
    base_url: str | None = None
    api_key: str | None = None
    clear_api_key: bool = False
    timeout_seconds: int | None = Field(default=None, ge=5, le=300)
    max_retries: int | None = Field(default=None, ge=0, le=5)
    analysis_language: AnalysisLanguage | None = None
    max_chunk_chars: int | None = Field(default=None, ge=1500, le=32000)
    feature_models: dict[str, FeatureModelOverride] | None = None


class AIProviderInfo(BaseModel):
    provider_id: LLMProviderId
    display_name: str
    is_configured: bool
    api_key_masked: str = ""
    api_key_source: Literal["none", "env", "settings"] = "none"
    default_model: str
    selected_model: str = ""
    suggested_models: list[str] = Field(default_factory=list)
    default_base_url: str = ""
    saved_base_url: str = ""
    supports_model_discovery: bool = True
    supports_structured_output: bool = True
    context_limit_chars: int = 32000
    cached_models_count: int = 0
    last_discovered_at: str | None = None
    status_message: str = ""


class AIProviderRegistryResponse(BaseModel):
    config: AIProviderConfig
    providers: list[AIProviderInfo] = Field(default_factory=list)
    feature_keys: list[AIFeatureKey] = Field(
        default_factory=lambda: [
            "script_analysis",
            "script_generation",
            "character_analysis",
            "storyboard",
            "ai_director",
            "production_plan",
            "animation_planning",
            "asset_prompts",
        ]
    )


# --- Script Intelligence Domain Models ---


class NarrativeBeat(BaseModel):
    beat_id: str
    stage: str = ""  # introduction | setup | rising_action | conflict | turning_point | climax | resolution | custom
    label: str = ""
    summary: str = ""
    source_paragraphs: list[int] = Field(default_factory=list)
    uncertainty_note: str = ""
    confidence: float = Field(default=0.75, ge=0.0, le=1.0)


class StoryOverview(BaseModel):
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
    narrative_beats: list[NarrativeBeat] = Field(default_factory=list)


class ProductionAnalysis(BaseModel):
    visual_opportunities: list[str] = Field(default_factory=list)
    action_moments: list[str] = Field(default_factory=list)
    emotional_beats: list[str] = Field(default_factory=list)
    dramatic_pauses: list[str] = Field(default_factory=list)
    establishing_shots: list[str] = Field(default_factory=list)
    environmental_details: list[str] = Field(default_factory=list)
    transition_ideas: list[str] = Field(default_factory=list)
    vfx_scenes: list[str] = Field(default_factory=list)


class CharacterRelationship(BaseModel):
    target_character_analysis_id: str | None = None
    target_name: str = ""
    relationship_type: str = ""
    description: str = ""


class ExtractedCharacter(BaseModel):
    character_analysis_id: str
    canonical_name: str
    aliases: list[str] = Field(default_factory=list)
    ambiguous_aliases: list[str] = Field(default_factory=list)
    role: str = ""
    personality: str = ""
    appearance_description: str = "unspecified"
    appearance_specified: bool = False
    relationships: list[CharacterRelationship] = Field(default_factory=list)
    narrative_importance: Literal["main", "supporting", "minor", "unspecified"] = "supporting"
    dialogue_item_ids: list[str] = Field(default_factory=list)
    emotional_states: list[str] = Field(default_factory=list)
    actions: list[str] = Field(default_factory=list)
    first_appearance_paragraph: int | None = None
    last_appearance_paragraph: int | None = None
    linked_character_id: str | None = None
    review_status: ReviewStatus = "pending"
    user_edited_fields: list[str] = Field(default_factory=list)
    confidence: float = Field(default=0.8, ge=0.0, le=1.0)
    notes: str = ""


class ExtractedScriptItem(BaseModel):
    item_id: str
    item_type: ExtractedItemType = "dialogue"
    original_text: str
    speaker_character_analysis_id: str | None = None
    speaker_name_raw: str = ""
    speaker_unresolved: bool = False
    scene_breakdown_id: str | None = None
    order_index: int = 0
    paragraph_index: int = 0
    language: str = "unknown"
    emotion: str = ""
    notes: str = ""


class SceneBreakdownItem(BaseModel):
    scene_breakdown_id: str
    scene_number: int = Field(default=1, ge=1)
    title: str = ""
    source_paragraphs: list[int] = Field(default_factory=list)
    source_text: str = ""
    location: str = ""
    time_of_day: str = ""
    environment: str = ""
    characters_present: list[str] = Field(default_factory=list)
    character_entrances: list[str] = Field(default_factory=list)
    character_exits: list[str] = Field(default_factory=list)
    main_action: str = ""
    dialogue_item_ids: list[str] = Field(default_factory=list)
    narration_item_ids: list[str] = Field(default_factory=list)
    emotional_beat: str = ""
    scene_purpose: str = ""
    conflict: str = ""
    visual_opportunities: list[str] = Field(default_factory=list)
    atmosphere: str = ""
    suggested_duration_min_s: int = Field(default=6, ge=1, le=600)
    suggested_duration_max_s: int = Field(default=12, ge=1, le=600)
    importance: SceneImportance = "medium"
    transition_suggestion: str = ""
    ai_confidence: float = Field(default=0.8, ge=0.0, le=1.0)
    unresolved_questions: list[str] = Field(default_factory=list)
    review_status: ReviewStatus = "pending"
    user_edited_fields: list[str] = Field(default_factory=list)
    applied_script_scene_id: str | None = None
    applied_stage_scene_id: str | None = None
    original_ai_snapshot: dict[str, Any] | None = None


class AnalysisProgress(BaseModel):
    project_id: str
    status: Literal["idle", "running", "completed", "failed", "cancelled"] = "idle"
    stage: str = ""
    current_chunk: int = 0
    total_chunks: int = 0
    progress_pct: float = Field(default=0.0, ge=0.0, le=100.0)
    message: str = ""
    context_limit_warning: str = ""
    error: str | None = None
    started_at: str | None = None
    ended_at: str | None = None


class DirectorAnalysisDocument(BaseModel):
    analysis_id: str = ""
    version: int = 1
    script_source_mode: ScriptSourceMode = "auto"
    source_script_hash: str = ""
    source_paragraphs: list[str] = Field(default_factory=list)
    provider_id: str = ""
    model: str = ""
    analysis_language: AnalysisLanguage = "auto"
    status: Literal["idle", "analyzed", "partially_accepted", "accepted", "error"] = "idle"
    analyzed_at: str | None = None
    updated_at: str = Field(default_factory=utc_now_iso)
    story_overview: StoryOverview = Field(default_factory=StoryOverview)
    production_analysis: ProductionAnalysis = Field(default_factory=ProductionAnalysis)
    characters: list[ExtractedCharacter] = Field(default_factory=list)
    extracted_items: list[ExtractedScriptItem] = Field(default_factory=list)
    scenes: list[SceneBreakdownItem] = Field(default_factory=list)
    original_scenes_snapshot: list[dict[str, Any]] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    context_strategy_note: str = ""


# --- API Requests ---


class DirectorAnalyzeRequest(BaseModel):
    script_source_mode: ScriptSourceMode = "auto"
    custom_script_text: str | None = None
    analysis_language: AnalysisLanguage | None = None
    force: bool = False
    max_chunk_chars: int | None = Field(default=None, ge=1500, le=32000)


class RegenerateSceneRequest(BaseModel):
    instructions: str = ""
    preserve_user_edits: bool = True
