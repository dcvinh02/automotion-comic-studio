"""Quality Control schemas (Spec v2.0 Section 7)."""

from __future__ import annotations

from typing import Literal
from pydantic import BaseModel, Field

QCSeverity = Literal["critical", "warning", "info"]


class QCIssue(BaseModel):
    code: str
    severity: QCSeverity
    category: Literal[
        "missing_asset",
        "missing_sound",
        "character_identity",
        "timeline_integrity",
        "sound_overlap",
        "sound_license",
        "audio_clipping",
        "render_integrity",
        "animation_quality",
    ]
    message: str
    scene_id: str | None = None
    time_ms: int | None = None
    ref_id: str | None = None


class QCReport(BaseModel):
    project_id: str
    passed: bool
    critical_count: int = 0
    warning_count: int = 0
    issues: list[QCIssue] = Field(default_factory=list)
    audio_peak_db: float | None = None
