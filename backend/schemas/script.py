"""Structured Script Engine schemas (Phase 04 / Version 0.2 Foundation)."""

from __future__ import annotations

from typing import Literal
from pydantic import BaseModel, Field

from schemas.common import utc_now_iso

ScriptEntryType = Literal["dialogue", "narration", "action"]


class ScriptEntry(BaseModel):
    entry_id: str
    entry_type: ScriptEntryType = "dialogue"
    order_index: int = 0
    character_id: str | None = None
    narrator_label: str = "Narrator"
    text: str = ""
    voice_profile_id: str | None = None
    emotion: str = "neutral"
    delivery_style: str = "normal"
    pause_before_ms: int = Field(default=0, ge=0, le=30000)
    pause_after_ms: int = Field(default=300, ge=0, le=30000)
    estimated_duration_ms: int = Field(default=2000, ge=0)
    audio_asset_id: str | None = None
    audio_duration_ms: int | None = None
    sound_effect_ids: list[str] = Field(default_factory=list)


class ScriptScene(BaseModel):
    script_scene_id: str
    linked_stage_scene_id: str | None = None
    order_index: int = 0
    title: str = "Scene 1"
    location: str = ""
    time_of_day: str = ""
    description: str = ""
    background_asset_id: str | None = None
    character_ids: list[str] = Field(default_factory=list)
    notes: str = ""
    entries: list[ScriptEntry] = Field(default_factory=list)
    estimated_duration_ms: int = Field(default=0, ge=0)


class ScriptDocument(BaseModel):
    episode_title: str = ""
    raw_source_text: str = ""
    scenes: list[ScriptScene] = Field(default_factory=list)
    updated_at: str = Field(default_factory=utc_now_iso)
