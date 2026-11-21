"""Phase 06 Batch 2 — AI Storyboard, Shot Planning, Camera Direction & Continuity schemas."""

from __future__ import annotations

from typing import Any, Literal
from pydantic import BaseModel, Field

from schemas.common import utc_now_iso

ShotSize = Literal[
    "extreme_wide",
    "wide",
    "full",
    "medium_full",
    "medium",
    "medium_close_up",
    "close_up",
    "extreme_close_up",
    "over_the_shoulder",
    "pov",
    "insert",
]

CameraAngle = Literal[
    "eye_level",
    "low_angle",
    "high_angle",
    "birds_eye",
    "worms_eye",
    "dutch_angle",
    "over_the_shoulder",
    "pov",
]

CameraMovement = Literal[
    "static",
    "pan_left",
    "pan_right",
    "tilt_up",
    "tilt_down",
    "zoom_in",
    "zoom_out",
    "dolly_in",
    "dolly_out",
    "tracking",
    "camera_follow",
    "shake",
    "parallax",
]

CameraSupportStatus = Literal[
    "supported",
    "2d_approximation",
    "unsupported_suggestion",
]

ScreenPosition = Literal[
    "far_left",
    "left",
    "center_left",
    "center",
    "center_right",
    "right",
    "far_right",
    "offscreen",
]

DepthLayer = Literal["foreground", "midground", "background"]

FacingDirection = Literal[
    "left",
    "right",
    "front",
    "back",
    "three_quarter_left",
    "three_quarter_right",
]

ShotTransition = Literal[
    "cut",
    "fade",
    "cross_dissolve",
    "match_cut",
    "whip_pan",
    "sound_bridge",
]

ContinuityCategory = Literal[
    "position_jump",
    "facing_flip",
    "screen_direction",
    "entry_exit",
    "location_shift",
    "character_disappearance",
    "reaction_missing_character",
    "dialogue_gap",
    "action_continuity",
    "prop_continuity",
    "missing_character_asset",
]

RegenerateStrategy = Literal["preserve_locked", "replace_all"]


class Camera2DKeyPlan(BaseModel):
    """Executable 2D camera start/end framing parameters matching `CameraState` (x, y, zoom, rotation_deg)."""

    start_x: float = 0.0
    start_y: float = 0.0
    start_zoom: float = Field(default=1.0, gt=0.1, le=6.0)
    start_rotation_deg: float = Field(default=0.0, ge=-45.0, le=45.0)
    end_x: float = 0.0
    end_y: float = 0.0
    end_zoom: float = Field(default=1.0, gt=0.1, le=6.0)
    end_rotation_deg: float = Field(default=0.0, ge=-45.0, le=45.0)
    easing: Literal["linear", "ease_in", "ease_out", "ease_in_out", "hold"] = "ease_in_out"


class ShotCharacterStaging(BaseModel):
    staging_id: str
    character_analysis_id: str | None = None
    library_character_id: str | None = None
    character_name: str
    is_missing_asset: bool = False
    visible: bool = True
    speaking: bool = False
    reacting: bool = False
    screen_position: ScreenPosition = "center"
    depth_layer: DepthLayer = "midground"
    facing_direction: FacingDirection = "front"
    action: str = ""
    expression: str = "neutral"
    movement: str = ""


class ShotScriptRef(BaseModel):
    ref_id: str
    item_type: Literal["dialogue", "narration", "internal_thought", "action"] = "dialogue"
    speaker_name: str = ""
    text_excerpt: str = ""


class StoryboardShot(BaseModel):
    shot_id: str
    scene_id: str
    scene_breakdown_id: str | None = None
    script_scene_id: str | None = None
    shot_order: int = Field(default=1, ge=1)
    title: str = ""
    purpose: str = ""
    shot_size: ShotSize = "medium"
    camera_angle: CameraAngle = "eye_level"
    camera_movement: CameraMovement = "static"
    camera_support_status: CameraSupportStatus = "supported"
    camera_support_note: str = ""
    camera_angle_note: str = ""
    camera_plan: Camera2DKeyPlan = Field(default_factory=Camera2DKeyPlan)
    duration_ms: int = Field(default=3500, ge=500, le=60000)
    start_time_ms: int = Field(default=0, ge=0)
    end_time_ms: int = Field(default=3500, ge=0)
    characters: list[ShotCharacterStaging] = Field(default_factory=list)
    dialogue_refs: list[ShotScriptRef] = Field(default_factory=list)
    narration_refs: list[ShotScriptRef] = Field(default_factory=list)
    environment: str = ""
    visual_focus: str = ""
    emotional_emphasis: str = ""
    props_in_shot: list[str] = Field(default_factory=list)
    transition_out: ShotTransition = "cut"
    ai_rationale: str = ""
    confidence: float = Field(default=0.8, ge=0.0, le=1.0)
    warnings: list[str] = Field(default_factory=list)
    locked: bool = False
    user_edited_fields: list[str] = Field(default_factory=list)
    original_ai_snapshot: dict[str, Any] | None = None


class ContinuityWarning(BaseModel):
    warning_id: str
    scene_id: str
    shot_id: str
    previous_shot_id: str | None = None
    category: ContinuityCategory
    severity: Literal["info", "warning", "error"] = "warning"
    title: str
    description: str
    reviewed: bool = False
    dismissed: bool = False


class StoryboardGenerationRecord(BaseModel):
    record_id: str
    scope: Literal["storyboard", "scene", "shot"] = "scene"
    target_id: str = ""
    strategy: str = "preserve_locked"
    provider_id: str = ""
    model: str = ""
    shots_generated: int = 0
    preserved_locked_count: int = 0
    warnings_count: int = 0
    status: Literal["completed", "partial", "failed", "cancelled"] = "completed"
    message: str = ""
    created_at: str = Field(default_factory=utc_now_iso)


class StoryboardProgress(BaseModel):
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


class StoryboardDocument(BaseModel):
    storyboard_id: str = ""
    version: int = 1
    provider_id: str = ""
    model: str = ""
    analysis_language: Literal["auto", "vi", "en"] = "auto"
    status: Literal["idle", "generated", "partial", "edited", "error"] = "idle"
    shots: list[StoryboardShot] = Field(default_factory=list)
    continuity_warnings: list[ContinuityWarning] = Field(default_factory=list)
    scene_hashes: dict[str, str] = Field(default_factory=dict)
    generation_history: list[StoryboardGenerationRecord] = Field(default_factory=list)
    updated_at: str = Field(default_factory=utc_now_iso)


# --- API Request Models ---


class StoryboardGenerateRequest(BaseModel):
    scene_ids: list[str] | None = None
    force: bool = False
    strategy: RegenerateStrategy = "preserve_locked"
    confirm_replace_all: bool = False
    analysis_language: Literal["auto", "vi", "en"] | None = None


class SceneStoryboardGenerateRequest(BaseModel):
    force: bool = True
    strategy: RegenerateStrategy = "preserve_locked"
    confirm_replace_all: bool = False
    instructions: str = ""
    analysis_language: Literal["auto", "vi", "en"] | None = None


class RegenerateShotRequest(BaseModel):
    instructions: str = ""
    preserve_user_edits: bool = True


class ContinuityCheckResponse(BaseModel):
    warnings: list[ContinuityWarning] = Field(default_factory=list)
    total_shots_checked: int = 0
