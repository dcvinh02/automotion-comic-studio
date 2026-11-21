"""Phase 07 Batch 2 — REST API for Animation Capabilities, Motion Library, Motion Preview & Execution."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request

from app.dependencies import ServiceContainer
from schemas.animation_execution import (
    CharacterRigCapabilities,
    MotionApplyRequest,
    MotionApplyResponse,
    MotionCompatibilityResult,
    MotionPreset,
    MotionPresetCreateRequest,
    MotionPresetDuplicateRequest,
    MotionPresetUpdateRequest,
    MotionPreviewRequest,
    MotionPreviewResponse,
    ShotAnimationExecuteRequest,
    ShotAnimationExecuteResponse,
)

router = APIRouter(prefix="/api/v1/animation-execution", tags=["animation-execution"])


# --- 1. Rig Capabilities ---


@router.get("/capabilities/{character_id}", response_model=CharacterRigCapabilities)
def get_character_capabilities(character_id: str, request: Request) -> CharacterRigCapabilities:
    services: ServiceContainer = request.app.state.services
    try:
        return services.animation_execution_service.get_character_capabilities(character_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


# --- 2. Reusable Motion Library CRUD ---


@router.get("/presets", response_model=list[MotionPreset])
def list_motion_presets(
    request: Request,
    category: str | None = Query(default=None),
) -> list[MotionPreset]:
    services: ServiceContainer = request.app.state.services
    return services.library_repo.list_motion_presets(category=category)


@router.post("/presets", response_model=MotionPreset, status_code=201)
def create_motion_preset(req: MotionPresetCreateRequest, request: Request) -> MotionPreset:
    services: ServiceContainer = request.app.state.services
    return services.library_repo.create_motion_preset(req)


@router.put("/presets/{preset_id}", response_model=MotionPreset)
def update_motion_preset(
    preset_id: str, req: MotionPresetUpdateRequest, request: Request
) -> MotionPreset:
    services: ServiceContainer = request.app.state.services
    updated = services.library_repo.update_motion_preset(preset_id, req)
    if not updated:
        raise HTTPException(status_code=404, detail=f"Motion preset not found: {preset_id}")
    return updated


@router.post("/presets/{preset_id}/duplicate", response_model=MotionPreset, status_code=201)
def duplicate_motion_preset(
    preset_id: str,
    request: Request,
    req: MotionPresetDuplicateRequest | None = None,
) -> MotionPreset:
    services: ServiceContainer = request.app.state.services
    dup = services.library_repo.duplicate_motion_preset(
        preset_id, new_name=req.name if req else None
    )
    if not dup:
        raise HTTPException(status_code=404, detail=f"Motion preset not found: {preset_id}")
    return dup


@router.delete("/presets/{preset_id}")
def delete_motion_preset(preset_id: str, request: Request) -> dict[str, bool]:
    services: ServiceContainer = request.app.state.services
    ok, err = services.library_repo.delete_motion_preset(preset_id)
    if not ok:
        status_code = 404 if "not found" in err.lower() else 400
        raise HTTPException(status_code=status_code, detail=err)
    return {"deleted": True}


@router.get(
    "/presets/{preset_id}/compatibility/{character_id}",
    response_model=MotionCompatibilityResult,
)
def check_preset_compatibility(
    preset_id: str, character_id: str, request: Request
) -> MotionCompatibilityResult:
    services: ServiceContainer = request.app.state.services
    try:
        return services.animation_execution_service.check_preset_for_character(
            preset_id, character_id
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


# --- 3. Non-Destructive Motion Preview & Validated Motion Apply ---


@router.post("/{project_id}/preview-motion", response_model=MotionPreviewResponse)
def preview_motion(
    project_id: str, req: MotionPreviewRequest, request: Request
) -> MotionPreviewResponse:
    services: ServiceContainer = request.app.state.services
    try:
        return services.animation_execution_service.preview_motion(project_id, req)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/{project_id}/apply-motion", response_model=MotionApplyResponse)
def apply_motion(
    project_id: str, req: MotionApplyRequest, request: Request
) -> MotionApplyResponse:
    services: ServiceContainer = request.app.state.services
    try:
        return services.animation_execution_service.apply_motion(project_id, req)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# --- 4. Production Plan -> Shot Character & Camera Motion Execution ---


@router.post("/{project_id}/execute-shots", response_model=ShotAnimationExecuteResponse)
def execute_shot_animations(
    project_id: str, req: ShotAnimationExecuteRequest, request: Request
) -> ShotAnimationExecuteResponse:
    services: ServiceContainer = request.app.state.services
    try:
        return services.animation_execution_service.execute_shots(project_id, req)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
