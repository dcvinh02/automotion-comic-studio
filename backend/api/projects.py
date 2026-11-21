"""Project CRUD, persistence, backup & restore endpoints."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException, Query, Request, Response, status

import shutil
from pathlib import Path

from pydantic import BaseModel

from app.dependencies import ServiceContainer
from database.backup import cleanup_stale_partials
from core.project_integrity import check_project_integrity, relink_asset_references
from schemas.project import (
    ProjectDuplicateRequest,
    PROJECT_SECTIONS,
    BackupInfo,
    ProjectCreateRequest,
    ProjectState,
    ProjectSummary,
)

router = APIRouter(prefix="/api/v1/projects", tags=["projects"])


@router.get("", response_model=list[ProjectSummary])
def list_projects(request: Request) -> list[ProjectSummary]:
    services: ServiceContainer = request.app.state.services
    return services.project_repo.list_projects()


@router.post("", response_model=ProjectState, status_code=status.HTTP_201_CREATED)
def create_project(req: ProjectCreateRequest, request: Request) -> ProjectState:
    services: ServiceContainer = request.app.state.services
    return services.project_repo.create_project(req)


@router.get("/{project_id}", response_model=ProjectState)
def get_project(project_id: str, request: Request) -> ProjectState:
    services: ServiceContainer = request.app.state.services
    try:
        return services.project_repo.get_project_state(project_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.put("/{project_id}", response_model=ProjectState)
async def save_project(
    project_id: str,
    state: ProjectState,
    request: Request,
    response: Response,
    backup: bool = Query(default=False),
    dirty: str | None = Query(
        default=None,
        description="Comma-separated sections changed by the client (Phase 09.1). Omit for a legacy full save.",
    ),
) -> ProjectState:
    if state.meta.project_id != project_id:
        raise HTTPException(
            status_code=400,
            detail="Path project_id does not match payload meta.project_id",
        )
    dirty_sections: list[str] | None = None
    if dirty is not None:
        dirty_sections = [d.strip() for d in dirty.split(",") if d.strip()]
        unknown = sorted(set(dirty_sections) - set(PROJECT_SECTIONS))
        if unknown:
            raise HTTPException(status_code=400, detail=f"Unknown project sections: {unknown}")
    services: ServiceContainer = request.app.state.services
    try:
        # Run in a worker thread: the save may wait on the per-project lock held by a background job.
        saved, conflicts = await asyncio.to_thread(
            services.project_repo.save_client_state, state, dirty_sections, backup
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    response.headers["X-AMCS-Conflicts"] = ",".join(conflicts)
    await services.ws_hub.broadcast_event(
        "project_saved",
        {"project_id": project_id, "updated_at": saved.meta.updated_at},
    )
    return saved


@router.post("/{project_id}/duplicate", response_model=ProjectState, status_code=status.HTTP_201_CREATED)
async def duplicate_project(project_id: str, req: ProjectDuplicateRequest, request: Request) -> ProjectState:
    """Save As / save recovered work as a new project. The source project is never modified."""
    services: ServiceContainer = request.app.state.services
    if req.state is not None and req.state.meta.project_id != project_id:
        raise HTTPException(status_code=400, detail="state.meta.project_id must match the source project")
    try:
        return await asyncio.to_thread(services.project_repo.duplicate_project, project_id, req.name, req.state)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/{project_id}/integrity")
def project_integrity(project_id: str, request: Request) -> dict:
    """Structural integrity report (diagnostic only — never modifies the project)."""
    services: ServiceContainer = request.app.state.services
    try:
        st = services.project_repo.get_project_state(project_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return check_project_integrity(st, services.library_repo, services.asset_service, services.sound_service)


class RelinkRequest(BaseModel):
    from_asset_id: str
    to_asset_id: str


@router.post("/{project_id}/relink-asset", response_model=ProjectState)
def relink_asset(project_id: str, req: RelinkRequest, request: Request, response: Response) -> ProjectState:
    """Point every reference to a missing asset at a user-chosen replacement (backup taken first)."""
    services: ServiceContainer = request.app.state.services
    target = services.library_repo.get_asset(req.to_asset_id)
    if not target or not services.asset_service.resolve_asset_file(target).is_file():
        raise HTTPException(status_code=422, detail="The replacement asset does not exist or its file is missing.")
    repo = services.project_repo
    with repo.project_lock(project_id):
        st = repo.get_project_state(project_id)
        new_st, count = relink_asset_references(st, req.from_asset_id, req.to_asset_id)
        if count == 0:
            raise HTTPException(status_code=404, detail="This project does not reference that asset.")
        repo.create_backup(project_id, tag="pre_relink")
        saved = repo.patch_project_sections(project_id, scenes=new_st.scenes)
    response.headers["X-AMCS-Relinked"] = str(count)
    return saved


def _dir_size(path: Path) -> int:
    total = 0
    if path.is_dir():
        for f in path.rglob("*"):
            try:
                if f.is_file():
                    total += f.stat().st_size
            except OSError:
                pass
    return total


@router.get("/{project_id}/storage")
def project_storage(project_id: str, request: Request) -> dict:
    """Where this project's disk space goes (read-only)."""
    services: ServiceContainer = request.app.state.services
    pdir = services.config.project_dir(project_id)
    if not pdir.is_dir():
        raise HTTPException(status_code=404, detail=f"Project not found: {project_id}")
    db = sum((pdir / n).stat().st_size for n in ("project.db", "project.db-wal") if (pdir / n).is_file())
    parts = {
        "database": db,
        "backups": _dir_size(pdir / "backups"),
        "render_temp": _dir_size(pdir / "renders"),
        "exports": _dir_size(pdir / "exports"),
        "media": sum(_dir_size(pdir / d) for d in ("source", "audio", "sound_effects", "scripts", "timeline", "storyboard")),
        "cache": _dir_size(pdir / "cache"),
    }
    return {"project_id": project_id, "bytes": parts, "total_bytes": sum(parts.values()), "path": str(pdir)}


@router.post("/{project_id}/storage/cleanup")
def cleanup_project_storage(project_id: str, request: Request) -> dict:
    """Remove render temp folders that no longer back a resumable job, and interrupted backup files.

    Never touches exports, backups, media or temp files of queued/paused/failed/cancelled jobs
    (those are kept so Retry/Resume can reuse finished chunks)."""
    services: ServiceContainer = request.app.state.services
    pdir = services.config.project_dir(project_id)
    renders = pdir / "renders"
    keep_status = {"pending", "queued", "preparing", "rendering", "encoding", "validating", "running", "paused", "failed", "cancelled"}
    jobs = {j.job_id: j.status for j in services.project_repo.list_jobs(project_id)}
    freed = 0
    removed: list[str] = []
    if renders.is_dir():
        for child in renders.iterdir():
            if not child.is_dir() or not child.name.startswith("job_"):
                continue
            if jobs.get(child.name) in keep_status:
                continue
            size = _dir_size(child)
            shutil.rmtree(child, ignore_errors=True)
            freed += size
            removed.append(child.name)
    partials = cleanup_stale_partials(pdir / "backups", older_than_s=0)
    return {"removed_render_dirs": removed, "removed_partial_backups": partials, "freed_bytes": freed}


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(project_id: str, request: Request) -> None:
    services: ServiceContainer = request.app.state.services
    try:
        services.project_repo.delete_project(project_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/{project_id}/backups", response_model=list[BackupInfo])
def list_backups(project_id: str, request: Request) -> list[BackupInfo]:
    services: ServiceContainer = request.app.state.services
    try:
        return services.project_repo.list_backups(project_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/{project_id}/backups", response_model=BackupInfo, status_code=status.HTTP_201_CREATED)
def create_backup(project_id: str, request: Request, tag: str = Query(default="manual")) -> BackupInfo:
    services: ServiceContainer = request.app.state.services
    if tag not in ("manual", "pre_recovery"):
        raise HTTPException(status_code=400, detail="tag must be 'manual' or 'pre_recovery'")
    try:
        return services.project_repo.create_backup(project_id, tag=tag)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/{project_id}/backups/{filename}/restore", response_model=ProjectState)
def restore_backup(project_id: str, filename: str, request: Request) -> ProjectState:
    services: ServiceContainer = request.app.state.services
    try:
        return services.project_repo.restore_backup(project_id, filename)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
