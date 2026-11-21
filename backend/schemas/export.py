"""Phase 08 Batch 3 — Export configuration, validation, capabilities & output validation schemas.

`ExportSettings` is the single source of truth for what a render job produces. It is
stored verbatim in `RenderJob.input_json["settings"]` so a job can always be retried,
inspected, or re-exported with exactly the same configuration.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

ExportScopeKind = Literal["project", "scene", "scenes", "shot", "shots", "range"]
ResolutionPresetId = Literal[
    "project", "hd", "fhd", "qhd", "uhd", "portrait_hd", "portrait_fhd", "custom"
]
AspectMode = Literal["fit", "fill", "stretch"]
ContainerFormat = Literal["mp4", "mov", "webm"]
VideoCodecId = Literal["h264", "hevc", "vp9", "prores"]
EncoderPreference = Literal["auto", "software", "hardware"]
QualityPresetId = Literal["draft", "standard", "high", "maximum"]
CollisionPolicy = Literal["auto_number", "overwrite", "fail"]
SubtitleBurnMode = Literal["none", "burn_in", "soft"]
RenderMode = Literal["auto", "pixi_stream", "software_compositor"]

RESOLUTION_PRESETS: dict[str, tuple[int, int]] = {
    "hd": (1280, 720),
    "fhd": (1920, 1080),
    "qhd": (2560, 1440),
    "uhd": (3840, 2160),
    "portrait_hd": (720, 1280),
    "portrait_fhd": (1080, 1920),
}

STANDARD_FPS: tuple[int, ...] = (24, 25, 30, 50, 60)
MIN_DIMENSION = 128
MAX_DIMENSION = 4096
MIN_FPS = 10
MAX_FPS = 120


class ShotRef(BaseModel):
    scene_id: str
    shot_id: str


class ExportScope(BaseModel):
    kind: ExportScopeKind = "project"
    scene_ids: list[str] = Field(default_factory=list)
    shots: list[ShotRef] = Field(default_factory=list)
    range_start_ms: int | None = Field(default=None, ge=0)
    range_end_ms: int | None = Field(default=None, ge=0)


class AdvancedVideoSettings(BaseModel):
    """Optional expert overrides. `None` means "use the quality preset value"."""

    crf: int | None = Field(default=None, ge=0, le=63)
    bitrate_kbps: int | None = Field(default=None, ge=200, le=200000)
    encoder_preset: str | None = Field(default=None, max_length=24)
    profile: str | None = Field(default=None, max_length=24)
    pix_fmt: str | None = Field(default=None, max_length=24)
    keyframe_interval: int | None = Field(default=None, ge=1, le=1200)


class AudioExportSettings(BaseModel):
    enabled: bool = True
    bitrate_kbps: int = Field(default=192, ge=64, le=512)
    sample_rate: Literal[44100, 48000] = 48000
    normalize_loudness: bool = False
    target_lufs: float = Field(default=-16.0, ge=-31.0, le=-8.0)


class SubtitleExportSettings(BaseModel):
    mode: SubtitleBurnMode = "none"
    export_srt: bool = False


class ExportSettings(BaseModel):
    scope: ExportScope = Field(default_factory=ExportScope)
    resolution_preset: ResolutionPresetId = "fhd"
    width: int = Field(default=1920, ge=16, le=8192)
    height: int = Field(default=1080, ge=16, le=8192)
    aspect_mode: AspectMode = "fit"
    fps: int = Field(default=30, ge=1, le=240)
    container: ContainerFormat = "mp4"
    video_codec: VideoCodecId = "h264"
    encoder: EncoderPreference = "auto"
    quality: QualityPresetId = "standard"
    advanced: AdvancedVideoSettings = Field(default_factory=AdvancedVideoSettings)
    audio: AudioExportSettings = Field(default_factory=AudioExportSettings)
    subtitles: SubtitleExportSettings = Field(default_factory=SubtitleExportSettings)
    output_dir: str | None = None
    filename: str | None = Field(default=None, max_length=200)
    collision_policy: CollisionPolicy = "auto_number"
    render_mode: RenderMode = "auto"
    chunk_duration_seconds: int = Field(default=10, ge=2, le=60)
    job_name: str | None = Field(default=None, max_length=160)


class ExportSegment(BaseModel):
    """A contiguous source-timeline window rendered into the output, in output order."""

    label: str
    source_start_ms: float
    duration_ms: float
    frame_count: int
    output_start_frame: int
    scene_id: str | None = None
    shot_id: str | None = None


class ExportPlanIssue(BaseModel):
    code: str
    severity: Literal["error", "warning", "info"]
    field: str | None = None
    message: str


class ResolvedEncoder(BaseModel):
    encoder: str
    is_hardware: bool
    args: list[str]
    description: str
    audio_codec: str
    chunk_extension: str


class ExportPlan(BaseModel):
    """Result of `/render/validate`: resolved settings + every issue found (nothing is rendered)."""

    valid: bool
    issues: list[ExportPlanIssue] = Field(default_factory=list)
    settings: ExportSettings
    segments: list[ExportSegment] = Field(default_factory=list)
    total_frames: int = 0
    duration_ms: float = 0.0
    output_path: str | None = None
    output_path_collision: bool = False
    encoder: ResolvedEncoder | None = None
    renderer: str | None = None
    audio_expected: bool = False
    subtitle_cue_count: int = 0


class CodecCapability(BaseModel):
    codec: VideoCodecId
    label: str
    containers: list[ContainerFormat]
    software_encoder: str | None
    hardware_encoders: list[str]
    available: bool


class FFmpegEnvironment(BaseModel):
    available: bool
    ffmpeg_path: str | None
    ffprobe_path: str | None
    ffmpeg_version: str | None
    ffprobe_version: str | None
    configured_ffmpeg_path: str | None = None
    configured_ffprobe_path: str | None = None
    encoders: list[str] = Field(default_factory=list)
    codecs: list[CodecCapability] = Field(default_factory=list)
    containers: list[ContainerFormat] = Field(default_factory=list)
    audio_encoders: list[str] = Field(default_factory=list)
    hwaccels: list[str] = Field(default_factory=list)
    problems: list[str] = Field(default_factory=list)


class FFmpegConfigUpdate(BaseModel):
    ffmpeg_path: str | None = None
    ffprobe_path: str | None = None


class FFmpegTestResult(BaseModel):
    ok: bool
    ffmpeg_ok: bool
    ffprobe_ok: bool
    encoder_results: dict[str, bool] = Field(default_factory=dict)
    messages: list[str] = Field(default_factory=list)


class OutputValidationCheck(BaseModel):
    check: str
    passed: bool
    severity: Literal["critical", "warning", "info"] = "critical"
    expected: str | None = None
    actual: str | None = None
    message: str = ""


class OutputValidationReport(BaseModel):
    passed: bool
    checks: list[OutputValidationCheck] = Field(default_factory=list)
    file_size_bytes: int = 0
    duration_s: float | None = None
    width: int | None = None
    height: int | None = None
    fps: float | None = None
    frame_count: int | None = None
    video_codec: str | None = None
    audio_codec: str | None = None
    audio_duration_s: float | None = None
    audio_sample_rate: int | None = None
    subtitle_codec: str | None = None
    container: str | None = None
