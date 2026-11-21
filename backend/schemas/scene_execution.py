"""Phase 07 Batch 1 — Scene Execution Engine, Validation & Assembly Preview Schemas."""

from __future__ import annotations

from typing import Any, Literal
from pydantic import BaseModel, Field

from schemas.common import CameraState, Transform2D, utc_now_iso

ExecutionValidationStatus = Literal[
    "ready",
    "warning",
    "missing_dependency",
    "unsupported",
    "invalid",
    "needs_review",
]

ExistingExecutionPolicy = Literal[
    "update_existing",
    "reuse_existing",
    "skip_existing",
]


class ValidationIssue(BaseModel):
    issue_id: str
    code: str
    severity: Literal["error", "warning", "info"]
    category: Literal[
        "scene_ref",
        "shot_ref",
        "character",
        "rig",
        "asset",
        "background",
        "animation",
        "camera",
        "duration",
        "dimensions",
        "staging",
        "existing_state",
    ]
    label: str
    message: str
    suggested_action: str = ""
    production_shot_id: str | None = None
    requirement_id: str | None = None
    staging_id: str | None = None
    repairable: bool = False


class ShotValidationResult(BaseModel):
    production_shot_id: str
    shot_id: str
    scene_id: str
    shot_order: int
    title: str
    status: ExecutionValidationStatus
    executable: bool = True
    already_executed: bool = False
    existing_shot_id: str | None = None
    issues: list[ValidationIssue] = Field(default_factory=list)
    missing_dependencies: list[ValidationIssue] = Field(default_factory=list)
    unsupported_actions: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class SceneValidationReport(BaseModel):
    project_id: str
    plan_id: str | None = None
    overall_status: ExecutionValidationStatus
    stage_width: int
    stage_height: int
    fps: int
    total_shots: int = 0
    ready_count: int = 0
    warning_count: int = 0
    missing_dependency_count: int = 0
    unsupported_count: int = 0
    invalid_count: int = 0
    needs_review_count: int = 0
    already_executed_count: int = 0
    project_issues: list[ValidationIssue] = Field(default_factory=list)
    shots: list[ShotValidationResult] = Field(default_factory=list)
    checked_at: str = Field(default_factory=utc_now_iso)


class StagedCharacterPlacement(BaseModel):
    staging_id: str
    stable_instance_id: str
    character_name: str
    library_character_id: str | None = None
    resolved: bool = False
    screen_position: str = "center"
    depth_layer: str = "midground"
    facing_direction: str = "front"
    normalized_x: float = 0.5
    normalized_y: float = 0.58
    transform: Transform2D = Field(default_factory=Transform2D)
    z_index: int = 14
    visible: bool = True
    pose_id: str | None = None
    pose_name: str = ""
    expression_id: str | None = None
    expression_name: str = ""
    fallback_used: bool = False
    fallback_reason: str = ""


class StagedObjectPlacement(BaseModel):
    requirement_id: str
    stable_prop_instance_id: str
    name: str
    role: Literal["background", "environment", "prop", "foreground"] = "prop"
    asset_id: str | None = None
    asset_name: str = ""
    resolved: bool = False
    transform: Transform2D = Field(default_factory=Transform2D)
    z_index: int = 12
    visible: bool = True
    notes: str = ""


class LayerPreviewEntry(BaseModel):
    layer_id: str
    name: str
    kind: Literal["background", "character", "prop", "environment", "foreground"]
    z_index: int
    resolved: bool = True


class ShotAssemblyPreview(BaseModel):
    production_shot_id: str
    stable_shot_id: str
    scene_id: str
    target_stage_scene_id: str
    shot_order: int
    title: str
    start_ms: int
    end_ms: int
    duration_ms: int
    validation_status: ExecutionValidationStatus
    executable: bool = True
    already_executed: bool = False
    background: StagedObjectPlacement | None = None
    characters: list[StagedCharacterPlacement] = Field(default_factory=list)
    objects: list[StagedObjectPlacement] = Field(default_factory=list)
    layer_order: list[LayerPreviewEntry] = Field(default_factory=list)
    camera_default: CameraState = Field(default_factory=CameraState)
    camera_executable: bool = True
    missing_dependencies: list[ValidationIssue] = Field(default_factory=list)
    unsupported_actions: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    staging_fallbacks: list[str] = Field(default_factory=list)
    expected_timeline_changes: list[str] = Field(default_factory=list)


class SceneAssemblyPreviewGroup(BaseModel):
    source_scene_id: str
    target_stage_scene_id: str
    scene_name: str
    will_create_scene: bool = False
    already_executed: bool = False
    start_ms: int = 0
    total_duration_ms: int = 0
    existing_user_object_count: int = 0
    shots: list[ShotAssemblyPreview] = Field(default_factory=list)


class SceneExecutionPreview(BaseModel):
    project_id: str
    plan_id: str | None = None
    validation: SceneValidationReport
    scenes: list[SceneAssemblyPreviewGroup] = Field(default_factory=list)
    total_shots_eligible: int = 0
    total_shots_blocked: int = 0
    has_existing_execution: bool = False
    recommended_policy: ExistingExecutionPolicy = "update_existing"
    expected_timeline_summary: list[str] = Field(default_factory=list)


class SceneExecutionPreviewRequest(BaseModel):
    scene_ids: list[str] | None = None
    production_shot_ids: list[str] | None = None
    include_unapproved: bool = False


class SceneExecutionRequest(BaseModel):
    scene_ids: list[str] | None = None
    production_shot_ids: list[str] | None = None
    skip_shot_ids: list[str] = Field(default_factory=list)
    include_unapproved: bool = False
    existing_policy: ExistingExecutionPolicy = "update_existing"
    allow_partial: bool = True
    sync_timeline_keyframes: bool = True


class ShotExecutionOutcome(BaseModel):
    production_shot_id: str
    stable_shot_id: str
    target_stage_scene_id: str
    shot_order: int
    title: str
    outcome: Literal["assembled", "updated", "reused", "skipped", "blocked", "failed"]
    reason: str = ""
    characters_assembled: int = 0
    objects_assembled: int = 0
    warnings: list[str] = Field(default_factory=list)
    staging_fallbacks: list[str] = Field(default_factory=list)


class SceneExecutionResult(BaseModel):
    project_id: str
    status: Literal["completed", "partial", "no_changes", "rolled_back"]
    scenes_created: int = 0
    scenes_updated: int = 0
    shots_assembled: int = 0
    shots_updated: int = 0
    shots_reused: int = 0
    shots_skipped: int = 0
    shots_blocked: int = 0
    characters_created: int = 0
    characters_reused: int = 0
    props_created: int = 0
    props_reused: int = 0
    keyframes_synced: int = 0
    warnings: list[str] = Field(default_factory=list)
    outcomes: list[ShotExecutionOutcome] = Field(default_factory=list)
    updated_project: dict[str, Any] | None = None
    executed_at: str = Field(default_factory=utc_now_iso)


class RepairAssetRequest(BaseModel):
    production_shot_id: str
    target_kind: Literal["background", "prop", "character"]
    requirement_id: str | None = None
    staging_id: str | None = None
    asset_id: str | None = None
    character_id: str | None = None


class UpdateSceneShotRequest(BaseModel):
    title: str | None = None
    duration_ms: int | None = Field(default=None, gt=0)
    background_asset_id: str | None = None
    clear_background: bool = False
    camera_default: CameraState | None = None
    character_states: list[dict[str, Any]] | None = None
    prop_states: list[dict[str, Any]] | None = None
