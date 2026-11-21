"""2D Cutout Character Rig, Expression, and Pose schemas (Module 02 & 06)."""

from __future__ import annotations

from pydantic import BaseModel, Field

from schemas.asset import PartRole
from schemas.common import Transform2D, utc_now_iso


class CharacterPartSlot(BaseModel):
    slot_id: str
    name: str
    part_role: PartRole = "other"
    parent_slot_id: str | None = None
    default_asset_id: str | None = None
    variants: dict[str, str] = Field(default_factory=dict)
    z_index: int = 0
    anchor_x: float = Field(default=0.5, ge=0.0, le=1.0)
    anchor_y: float = Field(default=0.5, ge=0.0, le=1.0)
    default_transform: Transform2D = Field(default_factory=Transform2D)
    visible: bool = True
    locked: bool = False


class PartialTransform2D(BaseModel):
    x: float | None = None
    y: float | None = None
    rotation_deg: float | None = None
    scale_x: float | None = None
    scale_y: float | None = None
    opacity: float | None = Field(default=None, ge=0.0, le=1.0)


class ExpressionPreset(BaseModel):
    expression_id: str
    name: str
    slot_variant_overrides: dict[str, str] = Field(default_factory=dict)
    slot_transform_overrides: dict[str, PartialTransform2D] = Field(default_factory=dict)


class PosePreset(BaseModel):
    pose_id: str
    name: str
    slot_transforms: dict[str, PartialTransform2D] = Field(default_factory=dict)


class Character(BaseModel):
    character_id: str
    name: str
    description: str = ""
    tags: list[str] = Field(default_factory=list)
    identity_confirmed: bool = False
    thumbnail_asset_id: str | None = None
    voice_profile_id: str | None = None
    parts: list[CharacterPartSlot] = Field(default_factory=list)
    expressions: list[ExpressionPreset] = Field(default_factory=list)
    poses: list[PosePreset] = Field(default_factory=list)
    version: int = Field(default=1, ge=1)
    created_at: str = Field(default_factory=utc_now_iso)
    updated_at: str = Field(default_factory=utc_now_iso)


class CharacterCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = ""
    tags: list[str] = Field(default_factory=list)
    identity_confirmed: bool = False
    thumbnail_asset_id: str | None = None
    voice_profile_id: str | None = None
    parts: list[CharacterPartSlot] = Field(default_factory=list)
    expressions: list[ExpressionPreset] = Field(default_factory=list)
    poses: list[PosePreset] = Field(default_factory=list)


class CharacterUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = None
    tags: list[str] | None = None
    identity_confirmed: bool | None = None
    thumbnail_asset_id: str | None = None
    voice_profile_id: str | None = None
    parts: list[CharacterPartSlot] | None = None
    expressions: list[ExpressionPreset] | None = None
    poses: list[PosePreset] | None = None
