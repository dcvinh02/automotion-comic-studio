"""Application configuration for AutoMotion Comic Studio backend."""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


SFX_CATEGORIES: tuple[str, ...] = (
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
)

BGM_CATEGORIES: tuple[str, ...] = (
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
)

LEGACY_SFX_CATEGORIES: tuple[str, ...] = (
    "movement",
    "environment",
    "atmosphere",
    "emotional",
    "notification",
)

SOUND_CATEGORIES: tuple[str, ...] = tuple(
    dict.fromkeys((*SFX_CATEGORIES, *BGM_CATEGORIES, *LEGACY_SFX_CATEGORIES))
)

ASSET_SUBDIRS: tuple[str, ...] = (
    "characters",
    "locations",
    "props",
    "poses",
    "expressions",
    "animations",
    "sounds",
)

PROJECT_SUBDIRS: tuple[str, ...] = (
    "source",
    "scripts",
    "audio",
    "sound_effects",
    "timeline",
    "storyboard",
    "cache",
    "renders",
    "exports",
    "backups",
)


def _default_workspace_dir() -> Path:
    # backend/app/config.py -> repo root is parents[2]
    repo_root = Path(__file__).resolve().parents[2]
    return repo_root / "workspace"


class AppConfig(BaseSettings):
    """Runtime settings loaded from AMCS_* environment variables."""

    model_config = SettingsConfigDict(
        env_prefix="AMCS_",
        env_file=".env",
        extra="ignore",
    )

    host: str = Field(default="127.0.0.1")
    port: int = Field(default=8765)
    auth_token: str = Field(default="")
    parent_pid: int | None = Field(default=None)
    workspace_dir: Path = Field(default_factory=_default_workspace_dir)
    ffmpeg_path: str | None = Field(default=None)
    ffprobe_path: str | None = Field(default=None)
    f5_tts_url: str | None = Field(default=None)
    ai_provider: str | None = Field(default=None)
    ai_model: str | None = Field(default=None)
    ai_base_url: str | None = Field(default=None)
    openai_api_key: str | None = Field(default=None)
    gemini_api_key: str | None = Field(default=None)
    app_version: str = Field(default="0.1.0")
    chunk_duration_seconds: int = Field(default=10)
    max_backups_per_project: int = Field(default=10)

    @property
    def asset_library_dir(self) -> Path:
        return self.workspace_dir / "asset_library"

    @property
    def library_db_path(self) -> Path:
        return self.asset_library_dir / "library.db"

    @property
    def sounds_dir(self) -> Path:
        return self.asset_library_dir / "sounds"

    @property
    def projects_dir(self) -> Path:
        return self.workspace_dir / "projects"

    @property
    def logs_dir(self) -> Path:
        return self.workspace_dir / "logs"

    def project_dir(self, project_id: str) -> Path:
        if not project_id or "/" in project_id or "\\" in project_id or ".." in project_id:
            raise ValueError(f"Invalid project_id: {project_id!r}")
        return self.projects_dir / project_id

    def project_db_path(self, project_id: str) -> Path:
        return self.project_dir(project_id) / "project.db"

    def ensure_workspace_layout(self) -> None:
        """Create required workspace directories idempotently."""
        self.workspace_dir.mkdir(parents=True, exist_ok=True)
        self.asset_library_dir.mkdir(parents=True, exist_ok=True)
        for sub in ASSET_SUBDIRS:
            (self.asset_library_dir / sub).mkdir(parents=True, exist_ok=True)
        for category in SOUND_CATEGORIES:
            (self.sounds_dir / category).mkdir(parents=True, exist_ok=True)
        self.projects_dir.mkdir(parents=True, exist_ok=True)
        self.logs_dir.mkdir(parents=True, exist_ok=True)

    def ensure_project_layout(self, project_id: str) -> Path:
        """Create required per-project directories idempotently."""
        pdir = self.project_dir(project_id)
        pdir.mkdir(parents=True, exist_ok=True)
        for sub in PROJECT_SUBDIRS:
            (pdir / sub).mkdir(parents=True, exist_ok=True)
        return pdir


@lru_cache(maxsize=1)
def get_config() -> AppConfig:
    cfg = AppConfig()
    cfg.ensure_workspace_layout()
    return cfg


def reset_config_cache() -> None:
    """Clear cached config (used in tests when overriding AMCS_WORKSPACE_DIR)."""
    get_config.cache_clear()
