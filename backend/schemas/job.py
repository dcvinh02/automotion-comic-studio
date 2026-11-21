"""Job Queue, Chunk Rendering, and Export Preset schemas (Spec v2.0 Section 6)."""

from __future__ import annotations

from typing import Any, Literal
from pydantic import BaseModel, Field

from schemas.common import utc_now_iso
from schemas.export import ExportSettings

# Phase 08 Batch 3 render-job state machine. "running" is kept only so legacy rows load;
# new jobs move through queued -> preparing -> rendering -> encoding -> validating.
JobStatus = Literal[
    "pending",
    "queued",
    "preparing",
    "rendering",
    "encoding",
    "validating",
    "running",
    "paused",
    "completed",
    "failed",
    "cancelled",
]
ACTIVE_JOB_STATUSES: frozenset[str] = frozenset(
    {"preparing", "rendering", "encoding", "validating", "running"}
)
WAITING_JOB_STATUSES: frozenset[str] = frozenset({"pending", "queued"})
TERMINAL_JOB_STATUSES: frozenset[str] = frozenset({"completed", "failed", "cancelled"})
JobType = Literal["export_mp4", "import_audio"]
VideoCodecOption = Literal["auto", "h264_videotoolbox", "h264_nvenc", "h264_qsv", "libx264"]


class ExportPreset(BaseModel):
    preset_id: str
    name: str = Field(min_length=1, max_length=100)
    width: int = Field(ge=320, le=3840)
    height: int = Field(ge=240, le=2160)
    fps: int = Field(ge=12, le=120)
    video_codec: VideoCodecOption = "auto"
    video_bitrate_kbps: int = Field(default=8000, ge=500, le=80000)
    audio_codec: Literal["aac"] = "aac"
    audio_bitrate_kbps: int = Field(default=192, ge=64, le=512)
    sample_rate: int = Field(default=48000, ge=22050, le=96000)
    is_builtin: bool = False


class ExportPresetCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    width: int = Field(default=1920, ge=320, le=3840)
    height: int = Field(default=1080, ge=240, le=2160)
    fps: int = Field(default=30, ge=12, le=120)
    video_codec: VideoCodecOption = "auto"
    video_bitrate_kbps: int = Field(default=8000, ge=500, le=80000)
    audio_bitrate_kbps: int = Field(default=192, ge=64, le=512)
    sample_rate: int = Field(default=48000, ge=22050, le=96000)


class RenderChunk(BaseModel):
    chunk_id: str
    job_id: str
    chunk_index: int = Field(ge=0)
    start_frame: int = Field(ge=0)
    end_frame: int = Field(ge=0)
    output_path: str
    status: JobStatus = "pending"
    retry_count: int = 0
    error_message: str | None = None


class RenderJob(BaseModel):
    job_id: str
    project_id: str
    job_type: JobType = "export_mp4"
    status: JobStatus = "pending"
    progress_pct: float = Field(default=0.0, ge=0.0, le=100.0)
    message: str = ""
    input_json: dict[str, Any] = Field(default_factory=dict)
    output_json: dict[str, Any] | None = None
    error_log: str | None = None
    retry_count: int = 0
    depends_on_job_id: str | None = None
    chunks: list[RenderChunk] = Field(default_factory=list)
    name: str = ""
    queue_position: int = 0
    progress: dict[str, Any] = Field(default_factory=dict)
    started_at: str | None = None
    ended_at: str | None = None
    created_at: str = Field(default_factory=utc_now_iso)


class ExportRequest(BaseModel):
    project_id: str
    preset_id: str = "preset_1080p_final"
    output_filename: str | None = None
    output_dir: str | None = None
    chunk_duration_seconds: int = Field(default=10, ge=2, le=60)
    render_mode: Literal["auto", "pixi_stream", "software_compositor"] = "auto"
    subtitle_mode: Literal["none", "burn_in", "soft"] = "none"
    export_srt_sidecar: bool = False
    ignore_warnings: bool = True
    # Phase 08 Batch 3: full export configuration. When omitted, it is derived from preset_id
    # and the legacy fields above (backward compatible with v0.1 clients).
    settings: ExportSettings | None = None
    start_mode: Literal["render_now", "queue"] = "render_now"


class JobMoveRequest(BaseModel):
    direction: Literal["up", "down"]
