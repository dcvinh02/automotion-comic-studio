"""Subtitle Studio schemas — independent timeline subtitle model & reusable styles (Phase 05 Batch 3)."""

from __future__ import annotations

from typing import Literal
from pydantic import BaseModel, Field

SubtitlePosition = Literal["bottom", "center", "top"]
SubtitleAlignment = Literal["left", "center", "right"]
SubtitleFontWeight = Literal["normal", "semibold", "bold", "extrabold"]
SubtitleTimingSource = Literal["manual", "voice_duration", "estimated", "imported_srt"]


class SubtitleStyle(BaseModel):
    style_id: str
    name: str = Field(min_length=1, max_length=100)
    is_builtin: bool = False
    font_family: str = "Inter, 'Noto Sans', Arial, sans-serif"
    font_size: int = Field(default=44, ge=14, le=120)
    font_weight: SubtitleFontWeight = "bold"
    italic: bool = False
    underline: bool = False
    letter_spacing: float = Field(default=0.0, ge=-6.0, le=32.0)
    text_color: str = "#ffffff"
    outline_color: str = "#000000"
    outline_width: float = Field(default=3.0, ge=0.0, le=12.0)
    shadow_enabled: bool = True
    shadow_color: str = "#000000"
    shadow_opacity: float = Field(default=0.78, ge=0.0, le=1.0)
    shadow_blur: float = Field(default=6.0, ge=0.0, le=24.0)
    shadow_offset_x: float = Field(default=0.0, ge=-20.0, le=20.0)
    shadow_offset_y: float = Field(default=3.0, ge=-20.0, le=20.0)
    background_enabled: bool = False
    background_color: str = "#090b10"
    background_opacity: float = Field(default=0.65, ge=0.0, le=1.0)
    background_padding_x: int = Field(default=18, ge=0, le=120)
    background_padding_y: int = Field(default=10, ge=0, le=100)
    alignment: SubtitleAlignment = "center"
    position: SubtitlePosition = "bottom"
    offset_x: float = Field(default=0.0, ge=-960.0, le=960.0)
    offset_y: float = Field(default=0.0, ge=-540.0, le=540.0)
    margin_x: int = Field(default=80, ge=0, le=400)
    margin_y: int = Field(default=56, ge=0, le=400)
    line_spacing: float = Field(default=1.25, ge=1.0, le=2.4)
    max_width_pct: int = Field(default=82, ge=20, le=98)
    box_height_px: int = Field(default=0, ge=0, le=600)
    word_wrap: bool = True
    safe_area_clamp: bool = True


class SubtitleStyleOverride(BaseModel):
    """Per-segment style overrides — prevents modifying one timeline subtitle from leaking to others."""

    font_family: str | None = None
    font_size: int | None = Field(default=None, ge=14, le=120)
    font_weight: SubtitleFontWeight | None = None
    italic: bool | None = None
    underline: bool | None = None
    letter_spacing: float | None = Field(default=None, ge=-6.0, le=32.0)
    text_color: str | None = None
    outline_color: str | None = None
    outline_width: float | None = Field(default=None, ge=0.0, le=12.0)
    shadow_enabled: bool | None = None
    shadow_color: str | None = None
    shadow_opacity: float | None = Field(default=None, ge=0.0, le=1.0)
    shadow_blur: float | None = Field(default=None, ge=0.0, le=24.0)
    shadow_offset_x: float | None = Field(default=None, ge=-20.0, le=20.0)
    shadow_offset_y: float | None = Field(default=None, ge=-20.0, le=20.0)
    background_enabled: bool | None = None
    background_color: str | None = None
    background_opacity: float | None = Field(default=None, ge=0.0, le=1.0)
    background_padding_x: int | None = Field(default=None, ge=0, le=120)
    background_padding_y: int | None = Field(default=None, ge=0, le=100)
    alignment: SubtitleAlignment | None = None
    position: SubtitlePosition | None = None
    offset_x: float | None = Field(default=None, ge=-960.0, le=960.0)
    offset_y: float | None = Field(default=None, ge=-540.0, le=540.0)
    margin_x: int | None = Field(default=None, ge=0, le=400)
    margin_y: int | None = Field(default=None, ge=0, le=400)
    line_spacing: float | None = Field(default=None, ge=1.0, le=2.4)
    max_width_pct: int | None = Field(default=None, ge=20, le=98)
    box_height_px: int | None = Field(default=None, ge=0, le=600)
    word_wrap: bool | None = None
    safe_area_clamp: bool | None = None


def default_subtitle_styles() -> list[SubtitleStyle]:
    """Return the 5 editable built-in Subtitle Style presets."""
    return [
        SubtitleStyle(
            style_id="style_classic_white",
            name="Classic White",
            is_builtin=True,
            font_family="Inter, 'Noto Sans', Arial, sans-serif",
            font_size=44,
            font_weight="bold",
            text_color="#ffffff",
            outline_color="#000000",
            outline_width=3.0,
            shadow_enabled=True,
            shadow_color="#000000",
            shadow_blur=6.0,
            shadow_offset_x=0.0,
            shadow_offset_y=3.0,
            background_enabled=False,
            background_color="#090b10",
            background_opacity=0.65,
            alignment="center",
            position="bottom",
            margin_x=80,
            margin_y=56,
            line_spacing=1.25,
            max_width_pct=82,
            word_wrap=True,
        ),
        SubtitleStyle(
            style_id="style_cinematic",
            name="Cinematic",
            is_builtin=True,
            font_family="Georgia, 'Noto Serif', serif",
            font_size=40,
            font_weight="semibold",
            text_color="#f8f5ec",
            outline_color="#111317",
            outline_width=1.5,
            shadow_enabled=True,
            shadow_color="#000000",
            shadow_blur=10.0,
            shadow_offset_x=0.0,
            shadow_offset_y=2.0,
            background_enabled=False,
            background_color="#000000",
            background_opacity=0.45,
            alignment="center",
            position="bottom",
            margin_x=110,
            margin_y=48,
            line_spacing=1.35,
            max_width_pct=78,
            word_wrap=True,
        ),
        SubtitleStyle(
            style_id="style_bold_comic",
            name="Bold Comic",
            is_builtin=True,
            font_family="'Arial Black', Impact, 'Noto Sans', sans-serif",
            font_size=48,
            font_weight="extrabold",
            text_color="#fde047",
            outline_color="#111317",
            outline_width=5.0,
            shadow_enabled=True,
            shadow_color="#000000",
            shadow_blur=4.0,
            shadow_offset_x=3.0,
            shadow_offset_y=4.0,
            background_enabled=False,
            background_color="#111317",
            background_opacity=0.75,
            alignment="center",
            position="bottom",
            margin_x=72,
            margin_y=60,
            line_spacing=1.2,
            max_width_pct=84,
            word_wrap=True,
        ),
        SubtitleStyle(
            style_id="style_minimal",
            name="Minimal",
            is_builtin=True,
            font_family="Inter, 'Helvetica Neue', Arial, sans-serif",
            font_size=36,
            font_weight="normal",
            text_color="#f1f5f9",
            outline_color="#0f172a",
            outline_width=1.0,
            shadow_enabled=True,
            shadow_color="#000000",
            shadow_blur=4.0,
            shadow_offset_x=0.0,
            shadow_offset_y=1.0,
            background_enabled=False,
            background_color="#000000",
            background_opacity=0.4,
            alignment="center",
            position="bottom",
            margin_x=96,
            margin_y=44,
            line_spacing=1.32,
            max_width_pct=80,
            word_wrap=True,
        ),
        SubtitleStyle(
            style_id="style_high_contrast",
            name="High Contrast",
            is_builtin=True,
            font_family="Inter, 'Noto Sans', Arial, sans-serif",
            font_size=44,
            font_weight="bold",
            text_color="#ffffff",
            outline_color="#000000",
            outline_width=0.0,
            shadow_enabled=False,
            shadow_color="#000000",
            shadow_blur=0.0,
            shadow_offset_x=0.0,
            shadow_offset_y=0.0,
            background_enabled=True,
            background_color="#090b10",
            background_opacity=0.86,
            alignment="center",
            position="bottom",
            margin_x=80,
            margin_y=54,
            line_spacing=1.28,
            max_width_pct=84,
            word_wrap=True,
        ),
    ]


class SubtitleSegment(BaseModel):
    subtitle_id: str
    text: str = ""
    start_ms: int = Field(ge=0)
    end_ms: int = Field(gt=0)
    scene_id: str | None = None
    speaker_character_id: str | None = None
    speaker_name: str = ""
    script_entry_id: str | None = None
    voice_audio_asset_id: str | None = None
    timing_source: SubtitleTimingSource = "manual"
    style_id: str = "style_classic_white"
    position_override: SubtitlePosition | None = None
    style_override: SubtitleStyleOverride | None = None
    enabled: bool = True


def resolve_effective_subtitle_style(
    styles: list[SubtitleStyle],
    seg: SubtitleSegment,
    default_style_id: str = "style_classic_white",
) -> SubtitleStyle:
    """Resolve base SubtitleStyle merged with per-segment style_override and position_override."""
    style_list = styles or default_subtitle_styles()
    base = next(
        (s for s in style_list if s.style_id == seg.style_id),
        next((s for s in style_list if s.style_id == default_style_id), style_list[0]),
    )
    overrides: dict = {}
    if seg.style_override is not None:
        overrides = seg.style_override.model_dump(exclude_none=True)
    if seg.position_override is not None and "position" not in overrides:
        overrides["position"] = seg.position_override
    if not overrides:
        return base
    return base.model_copy(update=overrides)


class SubtitleDocument(BaseModel):
    default_style_id: str = "style_classic_white"
    styles: list[SubtitleStyle] = Field(default_factory=default_subtitle_styles)
    segments: list[SubtitleSegment] = Field(default_factory=list)


class SrtImportRequest(BaseModel):
    content: str
    default_style_id: str = "style_classic_white"
    scene_id: str | None = None


class SrtValidationIssue(BaseModel):
    line: int
    severity: Literal["warning", "error"]
    message: str


class SrtImportResponse(BaseModel):
    valid: bool
    segments: list[SubtitleSegment] = Field(default_factory=list)
    issues: list[SrtValidationIssue] = Field(default_factory=list)


class SubtitleExportRequest(BaseModel):
    segments: list[SubtitleSegment]
    styles: list[SubtitleStyle] = Field(default_factory=default_subtitle_styles)
    width: int = Field(default=1920, ge=320, le=3840)
    height: int = Field(default=1080, ge=240, le=2160)
    include_disabled: bool = False
