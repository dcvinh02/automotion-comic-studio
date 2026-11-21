"""Render, Export configuration, FFmpeg environment, Render Queue and Export History endpoints."""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import FileResponse, PlainTextResponse

from app.dependencies import FFMPEG_SETTINGS_KEY, ServiceContainer
from core.render_engine.export_planner import CONTAINER_AUDIO_CODEC, CODEC_MATRIX, codec_capabilities
from core.render_engine.orchestrator import ExportValidationError
from schemas.export import (
    ExportPlan,
    FFmpegConfigUpdate,
    FFmpegEnvironment,
    FFmpegTestResult,
)
from schemas.job import (
    ExportPreset,
    ExportPresetCreateRequest,
    ExportRequest,
    JobMoveRequest,
    RenderJob,
)
from schemas.quality import QCReport
from utils.ffmpeg import invalidate_ffmpeg_cache, probe_ffmpeg_capabilities, smoke_test_encoder
from workers.job_queue import InvalidJobTransition

router = APIRouter(prefix="/api/v1", tags=["render_jobs"])

_SMOKE_EXTRA = {
    "libx264": ["-preset", "ultrafast"],
    "libx265": ["-preset", "ultrafast", "-x265-params", "log-level=error"],
    "libvpx-vp9": ["-deadline", "realtime", "-cpu-used", "8"],
    "prores_ks": ["-profile:v", "0"],
}


def _svc(request: Request) -> ServiceContainer:
    return request.app.state.services


def _environment(services: ServiceContainer, force: bool = False) -> FFmpegEnvironment:
    caps = probe_ffmpeg_capabilities(services.config, force=force)
    saved = services.library_repo.get_app_setting(FFMPEG_SETTINGS_KEY) or {}
    containers = sorted({c for cap in codec_capabilities(caps) if cap.available for c in cap.containers})
    return FFmpegEnvironment(
        available=caps.available,
        ffmpeg_path=caps.ffmpeg_path,
        ffprobe_path=caps.ffprobe_path,
        ffmpeg_version=caps.version,
        ffprobe_version=caps.ffprobe_version,
        configured_ffmpeg_path=saved.get("ffmpeg_path") or services.config.ffmpeg_path,
        configured_ffprobe_path=saved.get("ffprobe_path") or services.config.ffprobe_path,
        encoders=[e for e in caps.video_encoders if any(e == m["software"] or e in m["hardware"] for m in CODEC_MATRIX.values())],
        codecs=codec_capabilities(caps),
        containers=containers,  # type: ignore[arg-type]
        audio_encoders=[a for a in caps.audio_encoders if a in set(CONTAINER_AUDIO_CODEC.values())],
        hwaccels=list(caps.hwaccels),
        problems=list(caps.problems),
    )


# --------------------------------------------------------------------------- presets / QC


@router.get("/render/presets", response_model=list[ExportPreset])
def list_export_presets(request: Request) -> list[ExportPreset]:
    return _svc(request).library_repo.list_export_presets()


@router.post("/render/presets", response_model=ExportPreset, status_code=status.HTTP_201_CREATED)
def create_export_preset(req: ExportPresetCreateRequest, request: Request) -> ExportPreset:
    return _svc(request).library_repo.create_export_preset(req)


@router.post("/render/qc/{project_id}", response_model=QCReport)
def run_quality_control(project_id: str, request: Request) -> QCReport:
    services = _svc(request)
    try:
        state = services.project_repo.get_project_state(project_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return services.qc_engine.run_preflight(state)


# --------------------------------------------------------------------------- FFmpeg environment


@router.get("/render/environment", response_model=FFmpegEnvironment)
def get_render_environment(request: Request, refresh: bool = False) -> FFmpegEnvironment:
    return _environment(_svc(request), force=refresh)


@router.put("/render/environment/config", response_model=FFmpegEnvironment)
def update_ffmpeg_config(req: FFmpegConfigUpdate, request: Request) -> FFmpegEnvironment:
    services = _svc(request)
    cleaned: dict[str, str | None] = {}
    for key, raw in (("ffmpeg_path", req.ffmpeg_path), ("ffprobe_path", req.ffprobe_path)):
        val = (raw or "").strip() or None
        if val:
            p = Path(val).expanduser()
            if not p.is_file() or not os.access(p, os.X_OK):
                raise HTTPException(status_code=422, detail=f"{key} is not an executable file: {val}")
            val = str(p)
        cleaned[key] = val
    services.library_repo.set_app_setting(FFMPEG_SETTINGS_KEY, cleaned)
    services.config.ffmpeg_path = cleaned["ffmpeg_path"]
    services.config.ffprobe_path = cleaned["ffprobe_path"]
    invalidate_ffmpeg_cache()
    return _environment(services, force=True)


@router.post("/render/environment/test", response_model=FFmpegTestResult)
def test_ffmpeg_environment(request: Request) -> FFmpegTestResult:
    services = _svc(request)
    caps = probe_ffmpeg_capabilities(services.config, force=True)
    messages: list[str] = list(caps.problems)
    results: dict[str, bool] = {}
    if caps.ffmpeg_path:
        for info in CODEC_MATRIX.values():
            for enc in [info["software"], *info["hardware"]]:
                if enc in caps.video_encoders:
                    ok, err = smoke_test_encoder(caps.ffmpeg_path, enc, _SMOKE_EXTRA.get(enc, []))
                    results[enc] = ok
                    if not ok:
                        messages.append(f"{enc}: {err or 'encode test failed'}")
    if caps.version:
        messages.insert(0, caps.version)
    return FFmpegTestResult(
        ok=caps.available and any(results.values()),
        ffmpeg_ok=bool(caps.version),
        ffprobe_ok=bool(caps.ffprobe_version),
        encoder_results=results,
        messages=messages,
    )


# --------------------------------------------------------------------------- validate / export


@router.post("/render/validate", response_model=ExportPlan)
def validate_export(req: ExportRequest, request: Request) -> ExportPlan:
    services = _svc(request)
    try:
        state = services.project_repo.get_project_state(req.project_id)
        settings = services.render_orchestrator.resolve_settings(req)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return services.render_orchestrator.plan_export(state, settings, services.job_queue.reserved_output_paths())


@router.post("/render/export", response_model=RenderJob, status_code=status.HTTP_202_ACCEPTED)
async def start_export(req: ExportRequest, request: Request) -> RenderJob:
    services = _svc(request)
    try:
        state = services.project_repo.get_project_state(req.project_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    qc_report = services.qc_engine.run_preflight(state)
    if not qc_report.passed:
        raise HTTPException(
            status_code=422,
            detail={"message": "Pre-flight quality control failed with critical errors.", "qc_report": qc_report.model_dump()},
        )
    if not req.ignore_warnings and qc_report.warning_count > 0:
        raise HTTPException(
            status_code=422,
            detail={"message": "Pre-flight quality control reported warnings.", "qc_report": qc_report.model_dump()},
        )
    try:
        return await services.job_queue.enqueue_export(req)
    except ExportValidationError as exc:
        raise HTTPException(status_code=422, detail={"message": str(exc), "plan": exc.plan.model_dump()}) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


# --------------------------------------------------------------------------- queue


@router.get("/render/queue")
def get_queue_state(request: Request) -> dict:
    return _svc(request).job_queue.queue_state()


@router.post("/render/queue/start")
async def start_render_queue(request: Request) -> dict:
    return await _svc(request).job_queue.start_queue()


@router.post("/render/queue/stop")
async def stop_render_queue(request: Request) -> dict:
    return await _svc(request).job_queue.stop_queue()


@router.get("/jobs/{project_id}", response_model=list[RenderJob])
def list_project_jobs(project_id: str, request: Request) -> list[RenderJob]:
    return _svc(request).project_repo.list_jobs(project_id)


@router.get("/jobs/{project_id}/{job_id}", response_model=RenderJob)
def get_project_job(project_id: str, job_id: str, request: Request) -> RenderJob:
    job = _svc(request).project_repo.get_job(project_id, job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Job not found: {job_id}")
    return job


async def _job_action(coro) -> RenderJob:
    try:
        result = await coro
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except InvalidJobTransition as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if result is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return result


@router.post("/jobs/{project_id}/{job_id}/cancel", response_model=RenderJob)
async def cancel_project_job(project_id: str, job_id: str, request: Request) -> RenderJob:
    return await _job_action(_svc(request).job_queue.cancel_job(project_id, job_id))


@router.post("/jobs/{project_id}/{job_id}/pause", response_model=RenderJob)
async def pause_project_job(project_id: str, job_id: str, request: Request) -> RenderJob:
    return await _job_action(_svc(request).job_queue.pause_job(project_id, job_id))


@router.post("/jobs/{project_id}/{job_id}/resume", response_model=RenderJob)
async def resume_project_job(project_id: str, job_id: str, request: Request) -> RenderJob:
    return await _job_action(_svc(request).job_queue.resume_job(project_id, job_id))


@router.post("/jobs/{project_id}/{job_id}/retry", response_model=RenderJob)
async def retry_project_job(project_id: str, job_id: str, request: Request) -> RenderJob:
    return await _job_action(_svc(request).job_queue.retry_job(project_id, job_id))


@router.post("/jobs/{project_id}/{job_id}/skip", response_model=RenderJob)
async def skip_project_job(project_id: str, job_id: str, request: Request) -> RenderJob:
    return await _job_action(_svc(request).job_queue.skip_job(project_id, job_id))


@router.post("/jobs/{project_id}/{job_id}/move", response_model=list[RenderJob])
async def move_project_job(project_id: str, job_id: str, req: JobMoveRequest, request: Request) -> list[RenderJob]:
    try:
        return await _svc(request).job_queue.move_job(project_id, job_id, req.direction)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except InvalidJobTransition as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.delete("/jobs/{project_id}/{job_id}")
async def remove_project_job(project_id: str, job_id: str, request: Request) -> dict:
    """Remove a queue/history entry. The exported video file is NEVER deleted by this call."""
    try:
        removed = await _svc(request).job_queue.remove_job(project_id, job_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except InvalidJobTransition as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"removed": removed, "output_file_deleted": False}


@router.post("/jobs/{project_id}/{job_id}/reexport", response_model=RenderJob, status_code=status.HTTP_202_ACCEPTED)
async def reexport_project_job(project_id: str, job_id: str, request: Request, start_mode: str = "queue") -> RenderJob:
    """Create a NEW job with the same settings, rendering the project's current content."""
    services = _svc(request)
    job = services.project_repo.get_job(project_id, job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Job not found: {job_id}")
    settings = job.input_json.get("settings")
    if not settings:
        raise HTTPException(status_code=409, detail="This legacy job has no stored export settings to re-export.")
    req = ExportRequest(
        project_id=project_id,
        settings=settings,
        start_mode="render_now" if start_mode == "render_now" else "queue",
    )
    return await start_export(req, request)


@router.get("/jobs/{project_id}/{job_id}/output")
def get_job_output_file(project_id: str, job_id: str, request: Request) -> FileResponse:
    job = _svc(request).project_repo.get_job(project_id, job_id)
    if not job or job.status != "completed" or not job.output_json:
        raise HTTPException(status_code=404, detail="No completed output for this job.")
    path = Path(str(job.output_json.get("output_path") or ""))
    if not path.is_file():
        raise HTTPException(status_code=410, detail=f"Output file no longer exists: {path}")
    media = {".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm"}.get(path.suffix.lower(), "application/octet-stream")
    return FileResponse(path, media_type=media, filename=path.name)


@router.get("/jobs/{project_id}/{job_id}/log", response_class=PlainTextResponse)
def get_job_log(project_id: str, job_id: str, request: Request) -> str:
    services = _svc(request)
    p = services.render_orchestrator.job_log_path(project_id, job_id)
    if not p.is_file():
        raise HTTPException(status_code=404, detail="No log for this job yet.")
    return p.read_text(encoding="utf-8", errors="replace")[-200_000:]
