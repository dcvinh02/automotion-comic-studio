"""Phase 07 Batch 3 — Automated Production Queue, Dependency DAG & 8-Category QC Schemas."""

from __future__ import annotations

from typing import Any, Literal
from pydantic import BaseModel, Field

from schemas.common import utc_now_iso

# --- Strict 9-State Production Task State Machine ---

ProductionTaskStatus = Literal[
    "pending",
    "queued",
    "validating",
    "processing",
    "completed",
    "failed",
    "needs_review",
    "skipped",
    "cancelled",
]

VALID_TASK_TRANSITIONS: dict[ProductionTaskStatus, set[ProductionTaskStatus]] = {
    "pending": {"queued", "skipped", "cancelled"},
    "queued": {"validating", "processing", "cancelled", "skipped", "failed"},
    "validating": {"processing", "failed", "needs_review", "cancelled"},
    "processing": {"completed", "failed", "needs_review", "cancelled"},
    "failed": {"queued", "skipped", "cancelled"},
    "needs_review": {"queued", "completed", "skipped", "cancelled"},
    "skipped": {"queued"},
    "cancelled": {"queued"},
    "completed": {"queued"},
}


def is_valid_task_transition(
    current: ProductionTaskStatus,
    target: ProductionTaskStatus,
) -> bool:
    return target in VALID_TASK_TRANSITIONS.get(current, set())


def assert_valid_task_transition(
    current: ProductionTaskStatus,
    target: ProductionTaskStatus,
) -> None:
    if not is_valid_task_transition(current, target):
        raise ValueError(
            f"Invalid production task transition: '{current}' -> '{target}'. "
            f"Allowed: {sorted(VALID_TASK_TRANSITIONS.get(current, set()))}"
        )


# --- Execution Modes & DAG Task Types ---

ProductionExecutionMode = Literal[
    "single_shot",
    "selected_shots",
    "scene",
    "project",
    "production_plan",
]

ProductionTaskType = Literal[
    "asset_resolution",
    "character_validation",
    "scene_assembly",
    "shot_animation",
    "camera_setup",
    "audio_subtitle_sync",
    "qc_validation",
]

QueueRunStatus = Literal[
    "idle",
    "running",
    "paused",
    "completed",
    "partial",
    "failed",
    "cancelled",
]


class ProductionQueueTask(BaseModel):
    task_id: str
    run_id: str
    task_name: str
    task_type: ProductionTaskType
    scene_id: str | None = None
    stage_scene_id: str | None = None
    scene_number: int = 1
    scene_title: str = ""
    shot_id: str | None = None
    production_shot_id: str | None = None
    shot_number: int = 0
    shot_title: str = ""
    status: ProductionTaskStatus = "pending"
    progress_pct: float = Field(default=0.0, ge=0.0, le=100.0)
    depends_on_task_ids: list[str] = Field(default_factory=list)
    blocked_by_task_ids: list[str] = Field(default_factory=list)
    message: str = ""
    error_details: str | None = None
    warnings: list[str] = Field(default_factory=list)
    retry_count: int = 0
    result_summary: dict[str, Any] = Field(default_factory=dict)
    timeline_time_ms: int | None = None
    started_at: str | None = None
    completed_at: str | None = None
    created_at: str = Field(default_factory=utc_now_iso)


class ProductionQueueDocument(BaseModel):
    run_id: str | None = None
    mode: ProductionExecutionMode = "production_plan"
    status: QueueRunStatus = "idle"
    selected_scene_ids: list[str] = Field(default_factory=list)
    selected_shot_ids: list[str] = Field(default_factory=list)
    include_unapproved: bool = False
    tasks: list[ProductionQueueTask] = Field(default_factory=list)
    started_at: str | None = None
    completed_at: str | None = None
    updated_at: str = Field(default_factory=utc_now_iso)


class ProductionQueueStartRequest(BaseModel):
    mode: ProductionExecutionMode = "production_plan"
    scene_ids: list[str] = Field(default_factory=list)
    production_shot_ids: list[str] = Field(default_factory=list)
    include_unapproved: bool = False
    include_animation: bool = True
    include_camera: bool = True
    include_audio_subtitles: bool = True
    run_qc_after: bool = True
    preserve_user_modified: bool = True
    # Optional test hook for deterministic failure/recovery verification (never used in normal production)
    inject_fail_task_types: list[ProductionTaskType] = Field(default_factory=list)


class ProductionQueuePlanPreview(BaseModel):
    project_id: str
    mode: ProductionExecutionMode
    total_scenes: int = 0
    total_shots: int = 0
    total_tasks: int = 0
    tasks: list[ProductionQueueTask] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    blocking_errors: list[str] = Field(default_factory=list)
    can_start: bool = True


# --- Real 8-Category Quality Control Schemas ---

ProductionQCCategory = Literal[
    "asset",
    "scene",
    "canvas",
    "animation",
    "camera",
    "audio",
    "subtitle",
    "production",
]

ProductionQCSeverity = Literal["error", "warning", "info"]

QCNavTarget = Literal[
    "stage",
    "timeline",
    "storyboard",
    "production",
    "subtitles",
    "assets",
    "characters",
    "audio",
    "queue",
]


class ProductionQCIssue(BaseModel):
    issue_id: str
    code: str
    category: ProductionQCCategory
    severity: ProductionQCSeverity
    title: str
    description: str
    scene_id: str | None = None
    scene_number: int | None = None
    shot_id: str | None = None
    shot_number: int | None = None
    asset_id: str | None = None
    subtitle_id: str | None = None
    sound_event_id: str | None = None
    task_id: str | None = None
    time_ms: int | None = None
    root_cause: str = ""
    recommended_action: str = ""
    nav_target: QCNavTarget = "stage"
    fix_action: str | None = None


class ProductionQCReport(BaseModel):
    project_id: str
    scope: Literal["project", "scenes"] = "project"
    scene_ids: list[str] = Field(default_factory=list)
    error_count: int = 0
    warning_count: int = 0
    info_count: int = 0
    passed_checks: int = 0
    total_checks: int = 0
    readiness_score: int = Field(default=100, ge=0, le=100)
    production_ready: bool = True
    category_summary: dict[str, dict[str, int]] = Field(default_factory=dict)
    issues: list[ProductionQCIssue] = Field(default_factory=list)
    checked_at: str = Field(default_factory=utc_now_iso)


class ProductionQCRunRequest(BaseModel):
    scene_ids: list[str] | None = None


class ProductionQCFixRequest(BaseModel):
    issue_id: str
    fix_action: str
    scene_id: str | None = None
    shot_id: str | None = None
    subtitle_id: str | None = None
    sound_event_id: str | None = None
