"""Phase 06 Batch 3 — AI Production Planner & Timeline Integration schemas."""

from __future__ import annotations

from typing import Any, Literal
from pydantic import BaseModel, Field

from schemas.common import utc_now_iso
from schemas.storyboard import (
    Camera2DKeyPlan,
    CameraAngle,
    CameraMovement,
    CameraSupportStatus,
    DepthLayer,
    FacingDirection,
    ScreenPosition,
    ShotSize,
    ShotTransition,
)
from schemas.timeline import AnimationStateType

AssetMatchClassification = Literal[
    "existing_compatible",
    "existing_potentially_compatible",
    "missing",
    "requires_new_asset",
    "requires_review",
]

AssetRequirementKind = Literal[
    "character",
    "character_part",
    "background",
    "prop",
    "expression",
    "pose",
    "effect",
]

AnimationActionCategory = Literal[
    "idle",
    "walk",
    "run",
    "blink",
    "talk",
    "wave",
    "turn",
    "look",
    "jump",
    "fall",
    "attack",
    "react",
    "sit",
    "stand",
    "custom",
]

ProductionReadinessStatus = Literal[
    "ready",
    "needs_assets",
    "needs_character",
    "needs_rig",
    "needs_animation",
    "needs_camera_setup",
    "needs_audio",
    "needs_review",
    "unsupported",
]

ExecutionCapability = Literal["full", "partial", "blocked"]
ProductionApprovalStatus = Literal["pending", "approved", "rejected", "edited"]
AudioSuggestionType = Literal["sfx", "bgm", "ambient"]
TimelineInsertionStrategy = Literal[
    "update_owned_only",
    "skip_conflicting",
    "append_after_existing",
]


class AssetMatchCandidate(BaseModel):
    asset_id: str
    name: str
    asset_type: str = ""
    score: float = Field(default=0.0, ge=0.0, le=1.0)
    reason: str = ""


class AssetMatchItem(BaseModel):
    requirement_id: str
    kind: AssetRequirementKind
    label: str
    query: str = ""
    classification: AssetMatchClassification = "missing"
    matched_asset_id: str | None = None
    matched_asset_name: str = ""
    candidates: list[AssetMatchCandidate] = Field(default_factory=list)
    required: bool = True
    notes: str = ""


class CharacterStagingPlan(BaseModel):
    staging_id: str
    character_name: str
    character_analysis_id: str | None = None
    library_character_id: str | None = None
    character_missing: bool = False
    rig_missing: bool = False
    visible: bool = True
    speaking: bool = False
    reacting: bool = False
    screen_position: ScreenPosition = "center"
    relative_position: str = ""
    depth_layer: DepthLayer = "midground"
    facing_direction: FacingDirection = "front"
    initial_pose: str = ""
    initial_pose_id: str | None = None
    final_pose: str = ""
    final_pose_id: str | None = None
    expression: str = "neutral"
    expression_id: str | None = None
    action: str = ""
    movement: str = ""
    entrance: str = ""
    exit: str = ""
    suggestion_note: str = ""


class AnimationActionPlan(BaseModel):
    action_plan_id: str
    character_name: str = ""
    library_character_id: str | None = None
    category: AnimationActionCategory = "idle"
    description: str = ""
    supported: bool = True
    mapped_animation_state: AnimationStateType | None = None
    mapped_preset_id: str | None = None
    required_rig: bool = True
    required_parts: list[str] = Field(default_factory=list)
    missing_parts: list[str] = Field(default_factory=list)
    parameters: dict[str, Any] = Field(default_factory=dict)
    estimated_duration_ms: int = Field(default=2000, ge=300, le=60000)
    unsupported_reason: str = ""
    manual_alternative: str = ""


class CameraProductionPlan(BaseModel):
    shot_size: ShotSize = "medium"
    camera_angle: CameraAngle = "eye_level"
    camera_movement: CameraMovement = "static"
    support_status: CameraSupportStatus = "supported"
    support_note: str = ""
    angle_note: str = ""
    start_framing: str = ""
    end_framing: str = ""
    focus_target: str = ""
    duration_ms: int = Field(default=3500, ge=500, le=60000)
    transition_out: ShotTransition = "cut"
    camera_plan: Camera2DKeyPlan = Field(default_factory=Camera2DKeyPlan)
    executable_on_timeline: bool = True


class AudioPlanItem(BaseModel):
    audio_plan_id: str
    audio_type: AudioSuggestionType = "sfx"
    category: str = ""
    description: str = ""
    match_classification: AssetMatchClassification = "missing"
    matched_sound_id: str | None = None
    matched_sound_name: str = ""
    license_verified: bool = False
    license_note: str = ""
    candidates: list[AssetMatchCandidate] = Field(default_factory=list)
    offset_ms: int = Field(default=0, ge=0)
    duration_ms: int | None = None
    volume: float = Field(default=0.8, ge=0.0, le=2.0)
    fade_in_ms: int = Field(default=0, ge=0)
    fade_out_ms: int = Field(default=0, ge=0)
    loop: bool = False
    notes: str = ""


class VoiceSubtitlePlanItem(BaseModel):
    item_plan_id: str
    item_type: Literal["dialogue", "narration", "internal_thought"] = "dialogue"
    script_ref_id: str = ""
    script_entry_id: str | None = None
    speaker_name: str = ""
    library_character_id: str | None = None
    text: str = ""
    voice_audio_asset_id: str | None = None
    voice_sound_id: str | None = None
    subtitle_segment_id: str | None = None
    spans_multiple_shots: bool = False
    sync_mode: Literal["exact_voice", "estimated"] = "estimated"
    start_offset_ms: int = Field(default=0, ge=0)
    duration_ms: int = Field(default=2000, ge=400, le=60000)
    notes: str = ""


class MissingDependency(BaseModel):
    dependency_id: str
    kind: Literal[
        "character",
        "rig",
        "asset",
        "animation",
        "camera",
        "audio",
        "voice",
        "review",
    ]
    severity: Literal["info", "warning", "blocking"] = "warning"
    label: str
    reason: str
    suggested_action: str = ""


class TimelineAppliedRefs(BaseModel):
    applied: bool = False
    applied_at: str | None = None
    stage_scene_id: str | None = None
    applied_start_ms: int = 0
    applied_end_ms: int = 0
    character_instance_ids: list[str] = Field(default_factory=list)
    keyframe_ids: list[str] = Field(default_factory=list)
    animation_clip_ids: list[str] = Field(default_factory=list)
    sound_event_ids: list[str] = Field(default_factory=list)
    subtitle_ids: list[str] = Field(default_factory=list)
    skipped_operations: list[str] = Field(default_factory=list)


class ProductionShotPlan(BaseModel):
    production_shot_id: str
    shot_id: str
    scene_id: str
    shot_order: int = Field(default=1, ge=1)
    title: str = ""
    duration_ms: int = Field(default=3500, ge=500, le=60000)
    start_time_ms: int = Field(default=0, ge=0)
    end_time_ms: int = Field(default=3500, ge=0)
    readiness_status: ProductionReadinessStatus = "needs_review"
    readiness_reasons: list[str] = Field(default_factory=list)
    execution_capability: ExecutionCapability = "partial"
    approval_status: ProductionApprovalStatus = "pending"
    locked: bool = False

    characters: list[CharacterStagingPlan] = Field(default_factory=list)
    background: AssetMatchItem | None = None
    assets: list[AssetMatchItem] = Field(default_factory=list)
    initial_pose_summary: str = ""
    final_pose_summary: str = ""
    action_summary: str = ""
    animation_plans: list[AnimationActionPlan] = Field(default_factory=list)
    camera_plan: CameraProductionPlan = Field(default_factory=CameraProductionPlan)
    voice_subtitle_plans: list[VoiceSubtitlePlanItem] = Field(default_factory=list)
    sfx_plans: list[AudioPlanItem] = Field(default_factory=list)
    bgm_plans: list[AudioPlanItem] = Field(default_factory=list)
    transition_out: ShotTransition = "cut"

    warnings: list[str] = Field(default_factory=list)
    missing_dependencies: list[MissingDependency] = Field(default_factory=list)
    user_edited_fields: list[str] = Field(default_factory=list)
    timeline_refs: TimelineAppliedRefs = Field(default_factory=TimelineAppliedRefs)
    ai_notes: str = ""
    original_ai_snapshot: dict[str, Any] | None = None


class ProductionProgress(BaseModel):
    project_id: str
    status: Literal["idle", "running", "completed", "partial", "failed", "cancelled"] = "idle"
    stage: str = ""
    current_scene: int = 0
    total_scenes: int = 0
    current_scene_title: str = ""
    progress_pct: float = Field(default=0.0, ge=0.0, le=100.0)
    message: str = ""
    error: str | None = None
    started_at: str | None = None
    ended_at: str | None = None


class ProductionPlanDocument(BaseModel):
    plan_id: str = ""
    version: int = 1
    provider_id: str = ""
    model: str = ""
    analysis_language: Literal["auto", "vi", "en"] = "auto"
    status: Literal["idle", "generated", "partial", "edited", "applied", "error"] = "idle"
    shots: list[ProductionShotPlan] = Field(default_factory=list)
    scene_hashes: dict[str, str] = Field(default_factory=dict)
    updated_at: str = Field(default_factory=utc_now_iso)


# --- API Request Models ---


class ProductionGenerateRequest(BaseModel):
    scene_ids: list[str] | None = None
    force: bool = False
    preserve_locked: bool = True
    use_ai_enrichment: bool = True
    analysis_language: Literal["auto", "vi", "en"] | None = None


class RegenerateProductionShotRequest(BaseModel):
    instructions: str = ""
    preserve_user_edits: bool = True
