"""Phase 07 Batch 2 — Animation Capability, Procedural Motion, Camera Motion & Motion Library schemas."""

from __future__ import annotations

from typing import Any, Literal
from pydantic import BaseModel, Field

from schemas.common import utc_now_iso
from schemas.production import AnimationActionCategory
from schemas.storyboard import CameraMovement
from schemas.timeline import CharacterAnimationClip, EasingType, Keyframe

RigCapability = Literal[
    "root_movement",
    "body_rotation",
    "head_rotation",
    "arm_rotation",
    "leg_rotation",
    "hand_rotation",
    "eye_state",
    "mouth_state",
    "scale_animation",
    "opacity_animation",
]

RigType = Literal["full_cutout", "upper_body", "simple_cutout", "empty"]

MotionDirection = Literal[
    "left",
    "right",
    "up",
    "down",
    "forward",
    "backward",
    "in_place",
]

MotionSupportLevel = Literal["full", "partial", "unsupported"]


class CharacterRigCapabilities(BaseModel):
    """Exact runtime capabilities exposed by a real Character Library rig."""

    character_id: str
    character_name: str
    rig_type: RigType = "empty"
    part_count: int = 0
    capabilities: list[RigCapability] = Field(default_factory=list)
    available_part_roles: list[str] = Field(default_factory=list)
    part_slots_by_role: dict[str, str] = Field(default_factory=dict)
    eye_variants: list[str] = Field(default_factory=list)
    mouth_variants: list[str] = Field(default_factory=list)
    pose_ids: list[str] = Field(default_factory=list)
    pose_names: dict[str, str] = Field(default_factory=dict)
    expression_ids: list[str] = Field(default_factory=list)
    limitations: list[str] = Field(default_factory=list)


class MotionParameters(BaseModel):
    """Validated user/AI-configurable parameters for character motion generation."""

    duration_ms: int = Field(default=2000, ge=250, le=60000)
    speed: float = Field(default=1.0, ge=0.25, le=3.0)
    intensity: float = Field(default=1.0, ge=0.1, le=2.5)
    distance_px: float = Field(default=240.0, ge=-2400.0, le=2400.0)
    direction: MotionDirection = "right"
    start_pose_id: str | None = None
    end_pose_id: str | None = None
    easing: EasingType = "ease_in_out"
    loop: bool = False
    delay_ms: int = Field(default=0, ge=0, le=30000)


class CameraMotionParameters(BaseModel):
    """Validated parameters for 2D camera motion execution."""

    movement: CameraMovement = "static"
    start_x: float = Field(default=0.0, ge=-4000.0, le=4000.0)
    start_y: float = Field(default=0.0, ge=-4000.0, le=4000.0)
    start_zoom: float = Field(default=1.0, ge=0.2, le=4.0)
    start_rotation_deg: float = Field(default=0.0, ge=-45.0, le=45.0)
    end_x: float = Field(default=0.0, ge=-4000.0, le=4000.0)
    end_y: float = Field(default=0.0, ge=-4000.0, le=4000.0)
    end_zoom: float = Field(default=1.0, ge=0.2, le=4.0)
    end_rotation_deg: float = Field(default=0.0, ge=-45.0, le=45.0)
    duration_ms: int = Field(default=3000, ge=250, le=60000)
    easing: EasingType = "ease_in_out"
    shake_intensity_px: float = Field(default=12.0, ge=1.0, le=80.0)
    shake_frequency_hz: float = Field(default=8.0, ge=1.0, le=20.0)
    follow_instance_id: str | None = None
    follow_strength: float = Field(default=0.85, ge=0.1, le=1.0)
    focus_target_id: str | None = None
    delay_ms: int = Field(default=0, ge=0, le=30000)


class MotionPreset(BaseModel):
    """Reusable animation preset persisted in the global Motion Library (`library.db`)."""

    preset_id: str
    name: str
    category: AnimationActionCategory
    description: str = ""
    is_builtin: bool = False
    required_capabilities: list[RigCapability] = Field(default_factory=list)
    optional_capabilities: list[RigCapability] = Field(default_factory=list)
    supported_rig_types: list[RigType] = Field(
        default_factory=lambda: ["full_cutout", "upper_body", "simple_cutout"]
    )
    motion_targets: list[str] = Field(default_factory=list)
    supported_easings: list[EasingType] = Field(
        default_factory=lambda: ["linear", "ease_in", "ease_out", "ease_in_out", "hold"]
    )
    min_duration_ms: int = Field(default=300, ge=100, le=60000)
    max_duration_ms: int = Field(default=30000, ge=500, le=60000)
    default_parameters: MotionParameters = Field(default_factory=MotionParameters)
    limitations: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    created_at: str = Field(default_factory=utc_now_iso)
    updated_at: str = Field(default_factory=utc_now_iso)


class MotionPresetCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    category: AnimationActionCategory = "idle"
    description: str = ""
    base_preset_id: str | None = None
    required_capabilities: list[RigCapability] | None = None
    optional_capabilities: list[RigCapability] | None = None
    default_parameters: MotionParameters = Field(default_factory=MotionParameters)
    limitations: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)


class MotionPresetUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = None
    default_parameters: MotionParameters | None = None
    tags: list[str] | None = None
    limitations: list[str] | None = None


class MotionPresetDuplicateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)


class MotionCompatibilityResult(BaseModel):
    preset_id: str
    preset_name: str
    character_id: str
    character_name: str
    compatible: bool
    support_level: MotionSupportLevel
    missing_capabilities: list[RigCapability] = Field(default_factory=list)
    available_optional_capabilities: list[RigCapability] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    limitations: list[str] = Field(default_factory=list)


class GeneratedMotionRecord(BaseModel):
    """Persistent audit & ownership record for an applied character or camera motion on a SceneShot."""

    motion_id: str
    source_action_plan_id: str | None = None
    preset_id: str
    preset_name: str
    category: str
    target_kind: Literal["character", "camera"] = "character"
    instance_id: str | None = None
    character_id: str | None = None
    parameters: MotionParameters = Field(default_factory=MotionParameters)
    camera_parameters: CameraMotionParameters | None = None
    start_ms: int = Field(default=0, ge=0)
    end_ms: int = Field(default=2000, ge=0)
    keyframe_ids: list[str] = Field(default_factory=list)
    clip_ids: list[str] = Field(default_factory=list)
    support_level: MotionSupportLevel = "full"
    warnings: list[str] = Field(default_factory=list)
    user_modified: bool = False
    applied_at: str = Field(default_factory=utc_now_iso)


class MotionPreviewRequest(BaseModel):
    """Non-destructive motion preview request (NEVER mutates project.db!)."""

    scene_id: str
    shot_id: str | None = None
    target_kind: Literal["character", "camera"] = "character"
    instance_id: str | None = None
    preset_id: str | None = None
    start_time_ms: int | None = Field(default=None, ge=0)
    parameters: MotionParameters = Field(default_factory=MotionParameters)
    camera_parameters: CameraMotionParameters | None = None
    sync_camera_follow: bool = False


class MotionPreviewResponse(BaseModel):
    compatible: bool
    support_level: MotionSupportLevel
    compatibility: MotionCompatibilityResult | None = None
    start_ms: int = 0
    end_ms: int = 0
    keyframes: list[Keyframe] = Field(default_factory=list)
    animation_clips: list[CharacterAnimationClip] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)
    sync_summary: str = ""


class MotionApplyRequest(BaseModel):
    """Apply a validated character or camera motion onto real Timeline keyframes."""

    scene_id: str
    shot_id: str | None = None
    target_kind: Literal["character", "camera"] = "character"
    instance_id: str | None = None
    preset_id: str | None = None
    motion_id: str | None = None
    start_time_ms: int | None = Field(default=None, ge=0)
    parameters: MotionParameters = Field(default_factory=MotionParameters)
    camera_parameters: CameraMotionParameters | None = None
    sync_camera_follow: bool = False
    allow_partial: bool = True


class MotionApplyResponse(BaseModel):
    applied: bool
    support_level: MotionSupportLevel
    motion_record: GeneratedMotionRecord | None = None
    camera_motion_record: GeneratedMotionRecord | None = None
    keyframes_written: int = 0
    clips_written: int = 0
    warnings: list[str] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)
    updated_project: dict[str, Any] | None = None


class ActionMappingReport(BaseModel):
    """Structured mapping outcome for a single Production Plan AnimationActionPlan."""

    action_plan_id: str
    character_name: str
    instance_id: str | None = None
    character_id: str | None = None
    category: AnimationActionCategory
    description: str = ""
    mapped_preset_id: str | None = None
    mapped_preset_name: str = ""
    support_level: MotionSupportLevel = "unsupported"
    executable: bool = False
    skipped_user_modified: bool = False
    missing_capabilities: list[RigCapability] = Field(default_factory=list)
    keyframes_count: int = 0
    warnings: list[str] = Field(default_factory=list)
    unsupported_reason: str = ""
    manual_alternative: str = ""


class CameraExecutionReport(BaseModel):
    """Structured camera motion execution outcome for a single shot."""

    movement: CameraMovement = "static"
    support_level: MotionSupportLevel = "full"
    executable: bool = True
    synchronized_with_instance_id: str | None = None
    skipped_user_modified: bool = False
    keyframes_count: int = 0
    warnings: list[str] = Field(default_factory=list)
    unsupported_reason: str = ""


class ShotAnimationExecutionOutcome(BaseModel):
    shot_id: str
    scene_id: str
    production_shot_id: str | None = None
    shot_order: int = 1
    title: str = ""
    start_ms: int = 0
    end_ms: int = 0
    status: Literal["executed", "partial", "skipped", "blocked", "preview"] = "executed"
    actions: list[ActionMappingReport] = Field(default_factory=list)
    camera: CameraExecutionReport | None = None
    keyframes_generated: int = 0
    clips_generated: int = 0
    sync_notes: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class ShotAnimationExecuteRequest(BaseModel):
    """Execute or preview AI Production Plan character animations & camera motion on assembled shots."""

    scene_ids: list[str] | None = None
    shot_ids: list[str] | None = None
    production_shot_ids: list[str] | None = None
    include_character_motion: bool = True
    include_camera_motion: bool = True
    sync_camera_with_character: bool = True
    preserve_user_modified: bool = True
    regenerate_motion_ids: list[str] = Field(default_factory=list)
    allow_partial: bool = True
    dry_run: bool = False


class ShotAnimationExecuteResponse(BaseModel):
    project_id: str
    dry_run: bool = False
    status: Literal["completed", "partial", "no_changes", "rolled_back"] = "completed"
    shots_processed: int = 0
    actions_executed: int = 0
    actions_unsupported: int = 0
    actions_skipped_user_edited: int = 0
    cameras_executed: int = 0
    cameras_unsupported: int = 0
    total_keyframes_written: int = 0
    total_clips_written: int = 0
    outcomes: list[ShotAnimationExecutionOutcome] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)
    updated_project: dict[str, Any] | None = None
