"""Health & environment diagnostic endpoint."""

from __future__ import annotations

import platform
import sys
from fastapi import APIRouter, Request

from app.config import SOUND_CATEGORIES
from app.dependencies import ServiceContainer
from utils.ffmpeg import probe_ffmpeg_capabilities

router = APIRouter(prefix="/api/v1", tags=["health"])


@router.get("/health")
def get_health(request: Request) -> dict:
    services: ServiceContainer = request.app.state.services
    ffmpeg_caps = probe_ffmpeg_capabilities(services.config)
    return {
        "status": "ok",
        "app_version": services.config.app_version,
        "python_version": platform.python_version(),
        "os": platform.system(),
        "arch": platform.machine(),
        "workspace_dir": str(services.config.workspace_dir),
        "ffmpeg": {
            "available": ffmpeg_caps.available,
            "ffmpeg_path": ffmpeg_caps.ffmpeg_path,
            "ffprobe_path": ffmpeg_caps.ffprobe_path,
            "version": ffmpeg_caps.version,
            "available_h264_encoders": list(ffmpeg_caps.available_h264_encoders),
            "recommended_h264_encoder": ffmpeg_caps.recommended_h264_encoder,
        },
        "pixi_render_worker_connected": services.ws_hub.has_pixi_render_worker,
        "sound_categories": list(SOUND_CATEGORIES),
        "python_executable": sys.executable,
    }
