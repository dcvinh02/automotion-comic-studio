"""Service container & dependency wiring for FastAPI."""

from __future__ import annotations

from dataclasses import dataclass

from app.config import AppConfig, get_config
from core.animation_execution_engine.service import AnimationExecutionService
from core.asset_engine.service import AssetService
from core.director_engine.service import DirectorService
from core.production_engine.service import ProductionPlannerService
from core.production_queue_engine.service import ProductionQueueService
from core.quality_engine.checker import QualityControlEngine
from core.render_engine.orchestrator import RenderOrchestrator
from core.scene_execution_engine.service import SceneExecutionService
from core.sound_engine.service import SoundService
from core.storyboard_engine.service import StoryboardService
from core.voice_engine.service import VoiceService
from database.library_repo import LibraryRepository
from database.project_repo import ProjectRepository
from providers.llm_provider import LLMProviderRegistry
from workers.job_queue import JobQueueManager
from workers.ws_hub import WebSocketHub


@dataclass
class ServiceContainer:
    config: AppConfig
    project_repo: ProjectRepository
    library_repo: LibraryRepository
    asset_service: AssetService
    sound_service: SoundService
    voice_service: VoiceService
    llm_registry: LLMProviderRegistry
    director_service: DirectorService
    storyboard_service: StoryboardService
    production_service: ProductionPlannerService
    scene_execution_service: SceneExecutionService
    animation_execution_service: AnimationExecutionService
    production_queue_service: ProductionQueueService
    qc_engine: QualityControlEngine
    ws_hub: WebSocketHub
    render_orchestrator: RenderOrchestrator
    job_queue: JobQueueManager


FFMPEG_SETTINGS_KEY = "ffmpeg_config"


def apply_saved_ffmpeg_config(cfg: AppConfig, library_repo: LibraryRepository) -> None:
    """Apply user-configured FFmpeg/FFprobe paths (AMCS_FFMPEG_PATH env vars take precedence)."""
    try:
        saved = library_repo.get_app_setting(FFMPEG_SETTINGS_KEY) or {}
    except Exception:
        return
    if not cfg.ffmpeg_path and saved.get("ffmpeg_path"):
        cfg.ffmpeg_path = str(saved["ffmpeg_path"])
    if not cfg.ffprobe_path and saved.get("ffprobe_path"):
        cfg.ffprobe_path = str(saved["ffprobe_path"])


def build_services(config: AppConfig | None = None) -> ServiceContainer:
    cfg = config or get_config()
    cfg.ensure_workspace_layout()
    project_repo = ProjectRepository(cfg)
    library_repo = LibraryRepository(cfg)
    apply_saved_ffmpeg_config(cfg, library_repo)
    asset_service = AssetService(cfg, library_repo)
    sound_service = SoundService(cfg, library_repo)
    sound_service.seed_starter_pack()
    voice_service = VoiceService(cfg, library_repo, project_repo, sound_service)
    llm_registry = LLMProviderRegistry(cfg, library_repo)
    qc_engine = QualityControlEngine(cfg, library_repo, asset_service, sound_service)
    ws_hub = WebSocketHub()
    director_service = DirectorService(
        project_repo=project_repo,
        library_repo=library_repo,
        llm_registry=llm_registry,
        ws_hub=ws_hub,
    )
    storyboard_service = StoryboardService(
        project_repo=project_repo,
        library_repo=library_repo,
        llm_registry=llm_registry,
        ws_hub=ws_hub,
    )
    production_service = ProductionPlannerService(
        project_repo=project_repo,
        library_repo=library_repo,
        llm_registry=llm_registry,
        ws_hub=ws_hub,
    )
    scene_execution_service = SceneExecutionService(
        project_repo=project_repo,
        library_repo=library_repo,
        asset_service=asset_service,
    )
    animation_execution_service = AnimationExecutionService(
        project_repo=project_repo,
        library_repo=library_repo,
    )
    production_queue_service = ProductionQueueService(
        project_repo=project_repo,
        library_repo=library_repo,
        asset_service=asset_service,
        scene_execution_service=scene_execution_service,
        animation_execution_service=animation_execution_service,
        qc_engine=qc_engine,
        ws_hub=ws_hub,
    )
    render_orchestrator = RenderOrchestrator(
        config=cfg,
        project_repo=project_repo,
        library_repo=library_repo,
        asset_service=asset_service,
        sound_service=sound_service,
        qc_engine=qc_engine,
        ws_hub=ws_hub,
    )
    job_queue = JobQueueManager(project_repo, render_orchestrator)
    return ServiceContainer(
        config=cfg,
        project_repo=project_repo,
        library_repo=library_repo,
        asset_service=asset_service,
        sound_service=sound_service,
        voice_service=voice_service,
        llm_registry=llm_registry,
        director_service=director_service,
        storyboard_service=storyboard_service,
        production_service=production_service,
        scene_execution_service=scene_execution_service,
        animation_execution_service=animation_execution_service,
        production_queue_service=production_queue_service,
        qc_engine=qc_engine,
        ws_hub=ws_hub,
        render_orchestrator=render_orchestrator,
        job_queue=job_queue,
    )
