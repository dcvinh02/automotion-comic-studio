"""REST API router for Phase 06 Batch 3 — AI Production Planner & Readiness Checking."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from app.dependencies import ServiceContainer
from providers.llm_provider import (
    LLMCancelledError,
    LLMMalformedResponseError,
    LLMNotConfiguredError,
    LLMProviderError,
    LLMTimeoutError,
)
from schemas.production import (
    ProductionGenerateRequest,
    ProductionPlanDocument,
    ProductionProgress,
    ProductionShotPlan,
    RegenerateProductionShotRequest,
)

router = APIRouter(prefix="/api/v1/production", tags=["production"])


def _svc(request: Request) -> ServiceContainer:
    return request.app.state.services


@router.post("/{project_id}/generate", response_model=ProductionPlanDocument)
async def generate_production_plan(
    project_id: str,
    req: ProductionGenerateRequest,
    request: Request,
) -> ProductionPlanDocument:
    try:
        return await _svc(request).production_service.generate_production_plan(project_id, req)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except LLMNotConfiguredError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except LLMCancelledError as exc:
        raise HTTPException(status_code=499, detail=str(exc)) from exc
    except LLMTimeoutError as exc:
        raise HTTPException(status_code=504, detail=str(exc)) from exc
    except LLMMalformedResponseError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except LLMProviderError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/{project_id}/scenes/{scene_id}/generate", response_model=ProductionPlanDocument)
async def generate_scene_production_plan(
    project_id: str,
    scene_id: str,
    req: ProductionGenerateRequest,
    request: Request,
) -> ProductionPlanDocument:
    scoped = req.model_copy(update={"scene_ids": [scene_id], "force": True})
    return await generate_production_plan(project_id, scoped, request)


@router.post(
    "/{project_id}/shots/{production_shot_id}/regenerate",
    response_model=ProductionShotPlan,
)
async def regenerate_production_shot(
    project_id: str,
    production_shot_id: str,
    req: RegenerateProductionShotRequest,
    request: Request,
) -> ProductionShotPlan:
    try:
        return await _svc(request).production_service.regenerate_single_shot_plan(
            project_id, production_shot_id, req
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except LLMNotConfiguredError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except LLMTimeoutError as exc:
        raise HTTPException(status_code=504, detail=str(exc)) from exc
    except LLMMalformedResponseError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except LLMProviderError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/{project_id}/refresh-readiness", response_model=ProductionPlanDocument)
def refresh_production_readiness(
    project_id: str,
    request: Request,
) -> ProductionPlanDocument:
    try:
        return _svc(request).production_service.refresh_readiness(project_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/{project_id}/progress", response_model=ProductionProgress)
def get_production_progress(project_id: str, request: Request) -> ProductionProgress:
    return _svc(request).production_service.get_progress(project_id)


@router.post("/{project_id}/cancel", response_model=ProductionProgress)
def cancel_production_generation(project_id: str, request: Request) -> ProductionProgress:
    return _svc(request).production_service.cancel_generation(project_id)
