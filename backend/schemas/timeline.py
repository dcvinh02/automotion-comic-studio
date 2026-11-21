"""Master Timeline, Keyframe, Animation State, and Sound Effect Event schemas."""

from __future__ import annotations

from typing import Literal
from pydantic import BaseModel, Field

TrackType = Literal[
    "scene",
    "camera",
    "character",
    "prop",
    "sfx",
    "voice",
    "lipsync",
    "ambient",
    "bgm",
    "subtitle",
]

EasingType = Literal[
    "hold",
    "linear",
    "ease_in",
    "ease_out",
    "ease_in_out",
    "step",
    "cubic_bezier",
]

AnimationStateType = Literal[
    "IDLE",
    "WALKING",
    "RUNNING",
    "SPEAKING",
    "LISTENING",
    "REACTING",
    "SURPRISED",
    "ANGRY",
    "SAD",
    "HAPPY",
    "CRYING",
    "TRANSITION",
]

KeyframeTargetType = Literal[
    "character_instance",
    "character_part",
    "prop",
    "camera",
]

KeyframeProperty = Literal[
    "x",
    "y",
    "rotation_deg",
    "scale_x",
    "scale_y",
    "opacity",
    "zoom",
    "expression_id",
    "pose_id",
    "eye_state",
    "mouth_state",
    "animation_state",
]


class Keyframe(BaseModel):
    keyframe_id: str
    track_id: str
    target_type: KeyframeTargetType
    target_id: str
    property: KeyframeProperty
    time_ms: int = Field(ge=0)
    value: float | str
    easing: EasingType = "ease_in_out"
    bezier_handles: tuple[float, float, float, float] | None = None


class ProceduralAnimationConfig(BaseModel):
    auto_blink: bool = True
    blink_interval_ms: int = Field(default=3500, ge=500, le=20000)
    blink_duration_ms: int = Field(default=140, ge=50, le=600)
    breathing: bool = True
    breathing_amplitude: float = Field(default=0.015, ge=0.0, le=0.15)
    breathing_period_ms: int = Field(default=3200, ge=600, le=10000)
    walk_bounce_px: float = Field(default=12.0, ge=0.0, le=80.0)
    walk_cycle_ms: int = Field(default=600, ge=150, le=2000)


class CharacterAnimationClip(BaseModel):
    clip_id: str
    track_id: str
    instance_id: str
    start_ms: int = Field(ge=0)
    end_ms: int = Field(gt=0)
    animation_state: AnimationStateType = "IDLE"
    procedural: ProceduralAnimationConfig = Field(default_factory=ProceduralAnimationConfig)


class SoundEffectEvent(BaseModel):
    event_id: str
    track_id: str
    sound_id: str
    start_ms: int = Field(ge=0)
    end_ms: int = Field(gt=0)
    trim_start_ms: int = Field(default=0, ge=0)
    volume: float = Field(default=0.8, ge=0.0, le=2.0)
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    fade_in_ms: int = Field(default=0, ge=0)
    fade_out_ms: int = Field(default=0, ge=0)
    loop: bool = False
    spatial_position: float = Field(default=0.0, ge=-1.0, le=1.0)
    source_scene_id: str | None = None


class TimelineTrack(BaseModel):
    track_id: str
    project_id: str
    track_type: TrackType
    name: str
    target_ref_id: str | None = None
    order_index: int = 0
    muted: bool = False
    locked: bool = False
    solo: bool = False
    visible: bool = True
    volume: float = Field(default=1.0, ge=0.0, le=2.0)
    collapsed: bool = False


class MasterTimeline(BaseModel):
    project_id: str
    fps: int = Field(default=30, ge=12, le=120)
    total_duration_ms: int = Field(default=30000, gt=0)
    tracks: list[TimelineTrack] = Field(default_factory=list)
    keyframes: list[Keyframe] = Field(default_factory=list)
    animation_clips: list[CharacterAnimationClip] = Field(default_factory=list)
    sound_events: list[SoundEffectEvent] = Field(default_factory=list)
