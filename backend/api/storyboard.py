"""REST API router for Phase 06 Batch 2 — AI Storyboard, Shot Planning & Camera Direction."""

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
from schemas.storyboard import (
    ContinuityCheckResponse,
    RegenerateShotRequest,
    SceneStoryboardGenerateRequest,
    StoryboardDocument,
    StoryboardGenerateRequest,
    StoryboardProgress,
    StoryboardShot,
)

router = APIRouter(prefix="/api/v1/storyboard", tags=["storyboard"])


def _svc(request: Request) -> ServiceContainer:
    return request.app.state.services


@router.get("/{project_id}/approved-scenes")
def list_approved_scenes(project_id: str, request: Request) -> list[dict]:
    try:
        return _svc(request).storyboard_service.list_approved_scenes_summary(project_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/{project_id}/generate", response_model=StoryboardDocument)
async def generate_storyboard(
    project_id: str,
    req: StoryboardGenerateRequest,
    request: Request,
) -> StoryboardDocument:
    try:
        return await _svc(request).storyboard_service.generate_storyboard(project_id, req)
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


@router.post("/{project_id}/scenes/{scene_id}/generate", response_model=StoryboardDocument)
async def generate_scene_storyboard(
    project_id: str,
    scene_id: str,
    req: SceneStoryboardGenerateRequest,
    request: Request,
) -> StoryboardDocument:
    try:
        return await _svc(request).storyboard_service.generate_scene_storyboard(
            project_id, scene_id, req
        )
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


@router.post("/{project_id}/shots/{shot_id}/regenerate", response_model=StoryboardShot)
async def regenerate_single_shot(
    project_id: str,
    shot_id: str,
    req: RegenerateShotRequest,
    request: Request,
) -> StoryboardShot:
    try:
        return await _svc(request).storyboard_service.regenerate_single_shot(
            project_id, shot_id, req
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


@router.post("/{project_id}/continuity-check", response_model=ContinuityCheckResponse)
def run_continuity_check(project_id: str, request: Request) -> ContinuityCheckResponse:
    try:
        return _svc(request).storyboard_service.run_continuity_check(project_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/{project_id}/progress", response_model=StoryboardProgress)
def get_storyboard_progress(project_id: str, request: Request) -> StoryboardProgress:
    return _svc(request).storyboard_service.get_progress(project_id)


@router.post("/{project_id}/cancel", response_model=StoryboardProgress)
def cancel_storyboard_generation(project_id: str, request: Request) -> StoryboardProgress:
    return _svc(request).storyboard_service.cancel_generation(project_id)
