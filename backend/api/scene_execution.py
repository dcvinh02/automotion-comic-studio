"""Phase 07 Batch 1 — Scene Execution Engine & Automated Scene Assembly REST API."""

from __future__ import annotations

from typing import Any
from fastapi import APIRouter, HTTPException, Query, Request

from app.dependencies import ServiceContainer
from schemas.scene_execution import (
    RepairAssetRequest,
    SceneExecutionPreview,
    SceneExecutionPreviewRequest,
    SceneExecutionRequest,
    SceneExecutionResult,
    SceneValidationReport,
    UpdateSceneShotRequest,
)

router = APIRouter(prefix="/api/v1/scene-execution", tags=["scene-execution"])


@router.get("/{project_id}/validate", response_model=SceneValidationReport)
def validate_scene_execution(
    project_id: str,
    request: Request,
    include_unapproved: bool = Query(default=True),
) -> SceneValidationReport:
    services: ServiceContainer = request.app.state.services
    try:
        return services.scene_execution_service.validate(
            project_id, include_unapproved=include_unapproved
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/{project_id}/preview", response_model=SceneExecutionPreview)
def preview_scene_execution(
    project_id: str,
    req: SceneExecutionPreviewRequest,
    request: Request,
) -> SceneExecutionPreview:
    services: ServiceContainer = request.app.state.services
    try:
        return services.scene_execution_service.preview(project_id, req)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/{project_id}/execute", response_model=SceneExecutionResult)
def execute_scene_assembly(
    project_id: str,
    req: SceneExecutionRequest,
    request: Request,
) -> SceneExecutionResult:
    services: ServiceContainer = request.app.state.services
    try:
        return services.scene_execution_service.execute(project_id, req)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/{project_id}/repair-asset")
def repair_missing_asset(
    project_id: str,
    req: RepairAssetRequest,
    request: Request,
) -> dict[str, Any]:
    services: ServiceContainer = request.app.state.services
    try:
        return services.scene_execution_service.repair_missing_asset(project_id, req)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.put("/{project_id}/shots/{shot_id}")
def update_executed_shot(
    project_id: str,
    shot_id: str,
    req: UpdateSceneShotRequest,
    request: Request,
) -> dict[str, Any]:
    services: ServiceContainer = request.app.state.services
    try:
        return services.scene_execution_service.update_shot(project_id, shot_id, req)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
