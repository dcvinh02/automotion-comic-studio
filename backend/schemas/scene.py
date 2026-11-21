"""Scene, Editable Shot Structure, and Stage Instance schemas."""

from __future__ import annotations

from typing import Literal
from pydantic import BaseModel, Field

from schemas.animation_execution import GeneratedMotionRecord
from schemas.common import CameraState, Transform2D, utc_now_iso

TransitionType = Literal["cut", "fade", "cross_dissolve"]
ShotExecutionStatus = Literal["assembled", "partial", "edited", "warning"]


class SceneCharacterInstance(BaseModel):
    instance_id: str
    scene_id: str
    character_id: str
    display_name: str
    z_index: int = 10
    visible: bool = True
    locked: bool = False
    initial_transform: Transform2D = Field(
        default_factory=lambda: Transform2D(x=960.0, y=540.0)
    )
    default_expression_id: str | None = None
    default_pose_id: str | None = None
    default_eye_state: str = "open"
    default_mouth_state: str = "closed"


class ScenePropInstance(BaseModel):
    prop_instance_id: str
    asset_id: str | None = None
    layer_kind: Literal["prop", "empty"] = "prop"
    name: str
    z_index: int = 5
    anchor_x: float = Field(default=0.5, ge=0.0, le=1.0)
    anchor_y: float = Field(default=0.5, ge=0.0, le=1.0)
    visible: bool = True
    locked: bool = False
    parent_id: str | None = None
    transform: Transform2D = Field(
        default_factory=lambda: Transform2D(x=960.0, y=540.0)
    )


class ShotCharacterState(BaseModel):
    """Per-shot isolated character placement & pose state referencing a real SceneCharacterInstance."""

    instance_id: str
    character_id: str
    display_name: str
    visible: bool = True
    z_index: int = 14
    transform: Transform2D = Field(
        default_factory=lambda: Transform2D(x=960.0, y=540.0)
    )
    facing_direction: str = "front"
    screen_position: str = "center"
    depth_layer: str = "midground"
    pose_id: str | None = None
    expression_id: str | None = None
    animation_state: str | None = None
    staging_fallback_used: bool = False
    staging_fallback_reason: str = ""


class ShotPropState(BaseModel):
    """Per-shot isolated prop / environment / foreground state referencing a real ScenePropInstance."""

    prop_instance_id: str
    asset_id: str | None = None
    name: str
    role: Literal["prop", "environment", "foreground"] = "prop"
    visible: bool = True
    z_index: int = 12
    transform: Transform2D = Field(
        default_factory=lambda: Transform2D(x=960.0, y=540.0)
    )


class SceneShot(BaseModel):
    """Editable, persistent Shot structure owned by a Scene with isolated state."""

    shot_id: str
    scene_id: str
    production_shot_id: str | None = None
    storyboard_shot_id: str | None = None
    shot_order: int = Field(default=1, ge=1)
    title: str = "Shot 1"
    start_ms: int = Field(default=0, ge=0)  # Scene-relative start time
    duration_ms: int = Field(default=3000, gt=0)
    background_asset_id: str | None = None
    background_color: str | None = None
    camera_default: CameraState = Field(default_factory=CameraState)
    character_states: list[ShotCharacterState] = Field(default_factory=list)
    prop_states: list[ShotPropState] = Field(default_factory=list)
    asset_refs: list[str] = Field(default_factory=list)
    animation_refs: list[str] = Field(default_factory=list)
    applied_motions: list[GeneratedMotionRecord] = Field(default_factory=list)
    execution_status: ShotExecutionStatus = "assembled"
    warnings: list[str] = Field(default_factory=list)
    staging_fallbacks: list[str] = Field(default_factory=list)
    updated_at: str = Field(default_factory=utc_now_iso)


class SceneExecutionMeta(BaseModel):
    """Ownership & audit metadata recorded on a Scene assembled by the Scene Execution Engine."""

    executed: bool = False
    production_plan_id: str | None = None
    source_scene_id: str | None = None
    executed_at: str | None = None
    owned_shot_ids: list[str] = Field(default_factory=list)
    owned_character_instance_ids: list[str] = Field(default_factory=list)
    owned_prop_instance_ids: list[str] = Field(default_factory=list)
    execution_warnings: list[str] = Field(default_factory=list)


class Scene(BaseModel):
    scene_id: str
    project_id: str
    order_index: int = 0
    name: str = "Scene 1"
    start_ms: int = Field(default=0, ge=0)
    duration_ms: int = Field(default=10000, gt=0)
    background_asset_id: str | None = None
    background_color: str = "#14161A"
    transition_in: TransitionType = "cut"
    transition_duration_ms: int = Field(default=500, ge=0, le=5000)
    camera_default: CameraState = Field(default_factory=CameraState)
    characters: list[SceneCharacterInstance] = Field(default_factory=list)
    props: list[ScenePropInstance] = Field(default_factory=list)
    shots: list[SceneShot] = Field(default_factory=list)
    execution_meta: SceneExecutionMeta | None = None
