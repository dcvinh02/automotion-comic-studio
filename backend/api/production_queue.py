"""REST API router for Phase 07 Batch 3 — Automated Production Queue & 8-Category Quality Control."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from app.dependencies import ServiceContainer
from schemas.production_queue import (
    ProductionQCFixRequest,
    ProductionQCReport,
    ProductionQCRunRequest,
    ProductionQueueDocument,
    ProductionQueuePlanPreview,
    ProductionQueueStartRequest,
)

router = APIRouter(prefix="/api/v1", tags=["production_queue_qc"])


def _svc(request: Request) -> ServiceContainer:
    return request.app.state.services


# --- Production Queue Endpoints ---


@router.get("/production-queue/{project_id}", response_model=ProductionQueueDocument)
def get_production_queue(project_id: str, request: Request) -> ProductionQueueDocument:
    try:
        return _svc(request).production_queue_service.get_queue(project_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/production-queue/{project_id}/plan", response_model=ProductionQueuePlanPreview)
def plan_production_queue(
    project_id: str,
    req: ProductionQueueStartRequest,
    request: Request,
) -> ProductionQueuePlanPreview:
    try:
        return _svc(request).production_queue_service.build_plan_preview(project_id, req)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/production-queue/{project_id}/start", response_model=ProductionQueueDocument)
async def start_production_queue(
    project_id: str,
    req: ProductionQueueStartRequest,
    request: Request,
) -> ProductionQueueDocument:
    try:
        return await _svc(request).production_queue_service.start_production(project_id, req)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/production-queue/{project_id}/pause", response_model=ProductionQueueDocument)
async def pause_production_queue(project_id: str, request: Request) -> ProductionQueueDocument:
    try:
        return await _svc(request).production_queue_service.pause_queue(project_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/production-queue/{project_id}/resume", response_model=ProductionQueueDocument)
async def resume_production_queue(project_id: str, request: Request) -> ProductionQueueDocument:
    try:
        return await _svc(request).production_queue_service.resume_queue(project_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/production-queue/{project_id}/cancel", response_model=ProductionQueueDocument)
async def cancel_production_queue(project_id: str, request: Request) -> ProductionQueueDocument:
    try:
        return await _svc(request).production_queue_service.cancel_queue(project_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post(
    "/production-queue/{project_id}/tasks/{task_id}/retry",
    response_model=ProductionQueueDocument,
)
async def retry_production_task(
    project_id: str,
    task_id: str,
    request: Request,
) -> ProductionQueueDocument:
    try:
        return await _svc(request).production_queue_service.retry_task(project_id, task_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post(
    "/production-queue/{project_id}/tasks/{task_id}/skip",
    response_model=ProductionQueueDocument,
)
async def skip_production_task(
    project_id: str,
    task_id: str,
    request: Request,
) -> ProductionQueueDocument:
    try:
        return await _svc(request).production_queue_service.skip_task(project_id, task_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post(
    "/production-queue/{project_id}/tasks/{task_id}/cancel",
    response_model=ProductionQueueDocument,
)
async def cancel_production_task(
    project_id: str,
    task_id: str,
    request: Request,
) -> ProductionQueueDocument:
    try:
        return await _svc(request).production_queue_service.cancel_task(project_id, task_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# --- 8-Category Quality Control Endpoints ---


@router.post("/qc/{project_id}/run", response_model=ProductionQCReport)
def run_project_qc(
    project_id: str,
    req: ProductionQCRunRequest,
    request: Request,
) -> ProductionQCReport:
    try:
        return _svc(request).production_queue_service.run_qc(project_id, scene_ids=req.scene_ids)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/qc/{project_id}/latest", response_model=ProductionQCReport)
def get_latest_project_qc(project_id: str, request: Request) -> ProductionQCReport:
    try:
        state = _svc(request).project_repo.get_project_state(project_id)
        if state.qc_report is not None:
            return state.qc_report
        return _svc(request).production_queue_service.run_qc(project_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/qc/{project_id}/fix")
def fix_project_qc_issue(
    project_id: str,
    req: ProductionQCFixRequest,
    request: Request,
) -> dict:
    try:
        report, message, saved = _svc(request).production_queue_service.apply_qc_fix(project_id, req)
        return {
            "ok": True,
            "message": message,
            "report": report.model_dump(mode="json"),
            "updated_project": saved.model_dump(mode="json"),
        }
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
