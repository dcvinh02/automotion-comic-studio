"""Audio Library schemas — separated SFX & BGM with full license metadata (Phase 05 Batch 3)."""

from __future__ import annotations

from typing import Literal
from pydantic import BaseModel, Field

from schemas.common import utc_now_iso

AudioType = Literal["sfx", "bgm"]

SfxCategory = Literal[
    "footsteps",
    "walking",
    "running",
    "punch",
    "impact",
    "doors",
    "objects",
    "paper",
    "glass",
    "wind",
    "rain",
    "thunder",
    "fire",
    "water",
    "crowd",
    "animals",
    "vehicles",
    "magic",
    "horror",
    "suspense",
    "transitions",
    "ui",
    "comedy",
    "cinematic",
    # Backward-compatible Phase 01-04 legacy SFX categories
    "movement",
    "environment",
    "atmosphere",
    "emotional",
    "notification",
]

BgmCategory = Literal[
    "cinematic",
    "emotional",
    "sad",
    "happy",
    "romantic",
    "suspense",
    "horror",
    "action",
    "adventure",
    "ambient",
    "comedy",
    "dramatic",
    "calm",
    "fantasy",
]

SoundCategory = Literal[
    # SFX (24 core)
    "footsteps",
    "walking",
    "running",
    "punch",
    "impact",
    "doors",
    "objects",
    "paper",
    "glass",
    "wind",
    "rain",
    "thunder",
    "fire",
    "water",
    "crowd",
    "animals",
    "vehicles",
    "magic",
    "horror",
    "suspense",
    "transitions",
    "ui",
    "comedy",
    "cinematic",
    # BGM-specific additions
    "emotional",
    "sad",
    "happy",
    "romantic",
    "action",
    "adventure",
    "ambient",
    "dramatic",
    "calm",
    "fantasy",
    # Backward-compatible legacy SFX categories
    "movement",
    "environment",
    "atmosphere",
    "notification",
]

LicenseSource = Literal["user_imported", "cc0", "cc_by", "royalty_free", "custom"]
LicenseUsage = Literal["verified", "unverified"]


class SoundLicense(BaseModel):
    source: LicenseSource = "user_imported"
    usage: LicenseUsage = "verified"
    attribution: str = ""
    notes: str = ""
    origin_source: str = ""


class SoundAsset(BaseModel):
    sound_id: str
    name: str
    audio_type: AudioType = "sfx"
    category: SoundCategory
    tags: list[str] = Field(default_factory=list)
    file_path: str
    sha256: str
    duration_ms: int = Field(ge=1)
    sample_rate: int = Field(default=48000, ge=8000)
    channels: int = Field(default=2, ge=1)
    codec: str = "unknown"
    default_volume: float = Field(default=0.8, ge=0.0, le=2.0)
    loopable: bool = False
    fade_in_ms: int = Field(default=0, ge=0)
    fade_out_ms: int = Field(default=0, ge=0)
    is_favorite: bool = False
    is_bundled: bool = False
    waveform_peaks: list[float] = Field(default_factory=list)
    license: SoundLicense = Field(default_factory=SoundLicense)
    created_at: str = Field(default_factory=utc_now_iso)


class SoundUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=140)
    audio_type: AudioType | None = None
    category: SoundCategory | None = None
    tags: list[str] | None = None
    default_volume: float | None = Field(default=None, ge=0.0, le=2.0)
    loopable: bool | None = None
    fade_in_ms: int | None = Field(default=None, ge=0)
    fade_out_ms: int | None = Field(default=None, ge=0)
    is_favorite: bool | None = None
    license: SoundLicense | None = None
