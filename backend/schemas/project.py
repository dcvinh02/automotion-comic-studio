"""Project metadata and full project state schemas."""

from __future__ import annotations

from pydantic import BaseModel, Field

from schemas.common import utc_now_iso
from schemas.director import DirectorAnalysisDocument
from schemas.production import ProductionPlanDocument
from schemas.production_queue import ProductionQCReport, ProductionQueueDocument
from schemas.scene import Scene
from schemas.script import ScriptDocument
from schemas.storyboard import StoryboardDocument
from schemas.subtitle import SubtitleDocument
from schemas.timeline import MasterTimeline


class ProjectMeta(BaseModel):
    project_id: str
    name: str = Field(min_length=1, max_length=160)
    description: str = ""
    schema_version: str = "0.1.0"
    width: int = Field(default=1920, ge=320, le=3840)
    height: int = Field(default=1080, ge=240, le=2160)
    fps: int = Field(default=30, ge=12, le=120)
    duration_ms: int = Field(default=30000, gt=0)
    default_export_preset_id: str = "preset_1080p_final"
    auto_save_enabled: bool = True
    created_at: str = Field(default_factory=utc_now_iso)
    updated_at: str = Field(default_factory=utc_now_iso)


class ProjectState(BaseModel):
    meta: ProjectMeta
    scenes: list[Scene] = Field(default_factory=list)
    timeline: MasterTimeline
    script: ScriptDocument = Field(default_factory=ScriptDocument)
    subtitles: SubtitleDocument = Field(default_factory=SubtitleDocument)
    director: DirectorAnalysisDocument | None = None
    storyboard: StoryboardDocument | None = None
    production_plan: ProductionPlanDocument | None = None
    production_queue: ProductionQueueDocument | None = None
    qc_report: ProductionQCReport | None = None
    # Phase 09.1: per-section revision counters (server-maintained). Clients send back the
    # revisions their copy is based on so concurrent writes can be detected per section.
    revisions: dict[str, int] = Field(default_factory=dict)


PROJECT_SECTIONS: tuple[str, ...] = (
    "meta",
    "scenes",
    "timeline",
    "script",
    "subtitles",
    "director",
    "storyboard",
    "production_plan",
    "production_queue",
    "qc_report",
)


class ProjectCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    description: str = ""
    width: int = Field(default=1920, ge=320, le=3840)
    height: int = Field(default=1080, ge=240, le=2160)
    fps: int = Field(default=30, ge=12, le=120)
    duration_ms: int = Field(default=30000, gt=0)


class ProjectSummary(BaseModel):
    project_id: str
    name: str
    description: str
    width: int
    height: int
    fps: int
    duration_ms: int
    scene_count: int = 0
    created_at: str
    updated_at: str


class BackupInfo(BaseModel):
    backup_id: str
    filename: str
    created_at: str
    size_bytes: int
