"""REST API router for Phase 06 Batch 1 — AI Director Script Intelligence & Scene Breakdown."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from app.dependencies import ServiceContainer
from providers.llm_provider import (
    LLMCancelledError,
    LLMIncompatibleModelError,
    LLMMalformedResponseError,
    LLMNotConfiguredError,
    LLMProviderError,
    LLMTimeoutError,
)
from schemas.director import (
    AIModelDiscoveryResult,
    AIProviderConfig,
    AIProviderConfigUpdate,
    AIProviderRegistryResponse,
    AnalysisProgress,
    DirectorAnalysisDocument,
    DirectorAnalyzeRequest,
    FeatureModelOverride,
    LLMProviderId,
    ModelCompatibilityRequest,
    ModelCompatibilityResult,
    RegenerateSceneRequest,
    SceneBreakdownItem,
)

router = APIRouter(prefix="/api/v1/director", tags=["director"])


def _svc(request: Request) -> ServiceContainer:
    return request.app.state.services


@router.get("/providers", response_model=AIProviderRegistryResponse)
def get_director_providers(request: Request) -> AIProviderRegistryResponse:
    return _svc(request).llm_registry.list_registry_info()


@router.put("/config", response_model=AIProviderConfig)
def update_director_config(
    req: AIProviderConfigUpdate,
    request: Request,
) -> AIProviderConfig:
    try:
        return _svc(request).llm_registry.update_config(req)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/models/{provider_id}", response_model=AIModelDiscoveryResult)
async def get_provider_models(
    provider_id: LLMProviderId,
    request: Request,
    refresh: bool = False,
) -> AIModelDiscoveryResult:
    try:
        return await _svc(request).llm_registry.discover_models(provider_id, force_refresh=refresh)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/models/{provider_id}/refresh", response_model=AIModelDiscoveryResult)
async def refresh_provider_models(
    provider_id: LLMProviderId,
    request: Request,
) -> AIModelDiscoveryResult:
    try:
        return await _svc(request).llm_registry.discover_models(provider_id, force_refresh=True)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.put("/feature-models", response_model=AIProviderConfig)
def update_feature_models(
    feature_models: dict[str, FeatureModelOverride],
    request: Request,
) -> AIProviderConfig:
    try:
        return _svc(request).llm_registry.update_feature_models(feature_models)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/models/check-compatibility", response_model=ModelCompatibilityResult)
def check_model_compatibility(
    req: ModelCompatibilityRequest,
    request: Request,
) -> ModelCompatibilityResult:
    return _svc(request).llm_registry.check_model_compatibility(req)


@router.post("/test-provider")
async def test_director_provider(request: Request) -> dict:
    try:
        return await _svc(request).llm_registry.test_active_provider()
    except LLMIncompatibleModelError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except LLMNotConfiguredError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except LLMTimeoutError as exc:
        raise HTTPException(status_code=504, detail=str(exc)) from exc
    except LLMMalformedResponseError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except LLMProviderError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/{project_id}/analyze", response_model=DirectorAnalysisDocument)
async def analyze_project_script(
    project_id: str,
    req: DirectorAnalyzeRequest,
    request: Request,
) -> DirectorAnalysisDocument:
    try:
        return await _svc(request).director_service.analyze_project_script(project_id, req)
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


@router.get("/{project_id}/progress", response_model=AnalysisProgress)
def get_analysis_progress(project_id: str, request: Request) -> AnalysisProgress:
    return _svc(request).director_service.get_progress(project_id)


@router.post("/{project_id}/cancel", response_model=AnalysisProgress)
def cancel_project_analysis(project_id: str, request: Request) -> AnalysisProgress:
    return _svc(request).director_service.cancel_analysis(project_id)


@router.post(
    "/{project_id}/regenerate-scene/{scene_breakdown_id}",
    response_model=SceneBreakdownItem,
)
async def regenerate_single_scene(
    project_id: str,
    scene_breakdown_id: str,
    req: RegenerateSceneRequest,
    request: Request,
) -> SceneBreakdownItem:
    try:
        return await _svc(request).director_service.regenerate_single_scene(
            project_id,
            scene_breakdown_id,
            req,
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
