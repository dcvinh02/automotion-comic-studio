"""Asset management schemas (Module 02)."""

from __future__ import annotations

from typing import Literal
from pydantic import BaseModel, Field

from schemas.common import AnchorPoint, utc_now_iso

AssetScope = Literal["global", "project"]
AssetType = Literal["character_part", "background", "prop", "spritesheet"]
PartRole = Literal[
    "body",
    "head",
    "hair",
    "hair_back",
    "hair_front",
    "eyes",
    "eyebrows",
    "mouth",
    "left_arm",
    "right_arm",
    "left_hand",
    "right_hand",
    "left_leg",
    "right_leg",
    "left_foot",
    "right_foot",
    "clothing",
    "accessory",
    "custom",
    "other",
]


class Asset(BaseModel):
    asset_id: str
    scope: AssetScope = "global"
    project_id: str | None = None
    type: AssetType = "character_part"
    part_role: PartRole | None = None
    name: str
    folder: str = "general"
    tags: list[str] = Field(default_factory=list)
    file_path: str
    sha256: str
    width: int = Field(ge=1)
    height: int = Field(ge=1)
    default_anchor: AnchorPoint = Field(default_factory=AnchorPoint)
    version: int = Field(default=1, ge=1)
    identity_verified: bool = False
    created_at: str = Field(default_factory=utc_now_iso)


class AssetUpdateRequest(BaseModel):
    name: str | None = None
    type: AssetType | None = None
    part_role: PartRole | None = None
    folder: str | None = None
    tags: list[str] | None = None
    default_anchor: AnchorPoint | None = None
    identity_verified: bool | None = None
