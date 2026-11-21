"""Shared geometric and utility Pydantic schemas."""

from __future__ import annotations

from datetime import datetime, timezone
from pydantic import BaseModel, Field


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class AnchorPoint(BaseModel):
    x: float = Field(default=0.5, ge=0.0, le=1.0)
    y: float = Field(default=0.5, ge=0.0, le=1.0)


class Transform2D(BaseModel):
    x: float = 0.0
    y: float = 0.0
    rotation_deg: float = 0.0
    scale_x: float = 1.0
    scale_y: float = 1.0
    opacity: float = Field(default=1.0, ge=0.0, le=1.0)


class CameraState(BaseModel):
    x: float = 0.0
    y: float = 0.0
    zoom: float = Field(default=1.0, gt=0.05, le=10.0)
    rotation_deg: float = 0.0
