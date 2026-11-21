"""Project CRUD, persistence, backup & restore endpoints."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException, Query, Request, Response, status

from app.dependencies import ServiceContainer
from schemas.project import (
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
def create_backup(project_id: str, request: Request) -> BackupInfo:
    services: ServiceContainer = request.app.state.services
    try:
        return services.project_repo.create_backup(project_id, tag="manual")
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
