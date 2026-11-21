"""FastAPI entrypoint for AutoMotion Comic Studio backend."""

from __future__ import annotations

import asyncio
import os
import signal
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from api import animation_execution, assets, characters, director, health, production, production_queue, projects, render, scene_execution, sounds, storyboard, subtitles, voice, ws
from app.config import AppConfig, get_config
from app.dependencies import build_services
from app.logging_config import get_logger, setup_logging

logger = get_logger("main")


def _is_pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False


def create_app(config: AppConfig | None = None) -> FastAPI:
    cfg = config or get_config()
    setup_logging(cfg.logs_dir)
    services = build_services(cfg)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.services = services
        loop = asyncio.get_running_loop()

        def _on_project_state(event: dict) -> None:
            # Saves happen on the loop thread and in worker threads; schedule the WS broadcast safely.
            def _emit() -> None:
                loop.create_task(services.ws_hub.broadcast_event("project_state_changed", event))

            try:
                if asyncio.get_running_loop() is loop:
                    _emit()
                    return
            except RuntimeError:
                pass
            if not loop.is_closed():
                loop.call_soon_threadsafe(_emit)

        services.project_repo.add_state_listener(_on_project_state)
        try:
            services.job_queue.recover_on_startup()
        except Exception as exc:  # recovery must never block startup
            logger.warning("Render queue recovery failed: %s", exc)
        logger.info(
            "AutoMotion Comic Studio backend v%s started (workspace=%s)",
            cfg.app_version,
            cfg.workspace_dir,
        )
        watchdog_task: asyncio.Task | None = None
        if cfg.parent_pid:
            async def _watch_parent() -> None:
                while True:
                    await asyncio.sleep(2.0)
                    if not _is_pid_alive(cfg.parent_pid or 0):
                        logger.warning(
                            "Parent Electron process (pid=%s) exited; shutting down backend cleanly.",
                            cfg.parent_pid,
                        )
                        await services.production_queue_service.shutdown()
                        await services.voice_service.stop_f5_service()
                        await services.job_queue.shutdown()
                        os.kill(os.getpid(), signal.SIGTERM)
                        return

            watchdog_task = asyncio.create_task(_watch_parent(), name="parent-pid-watchdog")

        try:
            yield
        finally:
            if watchdog_task:
                watchdog_task.cancel()
            await services.production_queue_service.shutdown()
            await services.voice_service.stop_f5_service()
            await services.job_queue.shutdown()
            logger.info("Backend shut down cleanly.")

    app = FastAPI(
        title="AutoMotion Comic Studio Backend",
        version=cfg.app_version,
        lifespan=lifespan,
    )
    app.state.services = services

    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://127.0.0.1:5173",
            "http://localhost:5173",
            "file://",
            "null",
        ],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def auth_middleware(request: Request, call_next):
        expected = cfg.auth_token
        path = request.url.path
        if expected and path.startswith("/api/v1/") and path != "/api/v1/health":
            token = request.headers.get("x-amcs-token") or request.query_params.get("token")
            if token != expected:
                return JSONResponse(status_code=401, content={"detail": "Unauthorized"})
        return await call_next(request)

    app.include_router(health.router)
    app.include_router(projects.router)
    app.include_router(assets.router)
    app.include_router(characters.router)
    app.include_router(sounds.router)
    app.include_router(subtitles.router)
    app.include_router(voice.router)
    app.include_router(director.router)
    app.include_router(storyboard.router)
    app.include_router(production.router)
    app.include_router(scene_execution.router)
    app.include_router(animation_execution.router)
    app.include_router(production_queue.router)
    app.include_router(render.router)
    app.include_router(ws.router)

    return app


app = create_app()


if __name__ == "__main__":
    import uvicorn

    cfg = get_config()
    uvicorn.run(
        "app.main:app",
        host=cfg.host,
        port=cfg.port,
        reload=False,
        log_level="info",
    )
