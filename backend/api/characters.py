"""Character Rig, Expression & Pose API endpoints (Module 02)."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request, status

from app.dependencies import ServiceContainer
from core.asset_engine.references import find_character_references
from schemas.character import Character, CharacterCreateRequest, CharacterUpdateRequest

router = APIRouter(prefix="/api/v1/characters", tags=["characters"])


@router.get("", response_model=list[Character])
def list_characters(
    request: Request,
    search: str | None = Query(default=None),
) -> list[Character]:
    services: ServiceContainer = request.app.state.services
    return services.library_repo.list_characters(search=search)


@router.post("", response_model=Character, status_code=status.HTTP_201_CREATED)
def create_character(req: CharacterCreateRequest, request: Request) -> Character:
    services: ServiceContainer = request.app.state.services
    try:
        return services.asset_service.create_character(req)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/{character_id}", response_model=Character)
def get_character(character_id: str, request: Request) -> Character:
    services: ServiceContainer = request.app.state.services
    char = services.library_repo.get_character(character_id)
    if not char:
        raise HTTPException(status_code=404, detail=f"Character not found: {character_id}")
    return char


@router.put("/{character_id}", response_model=Character)
def update_character(
    character_id: str,
    req: CharacterUpdateRequest,
    request: Request,
) -> Character:
    services: ServiceContainer = request.app.state.services
    try:
        updated = services.asset_service.update_character(character_id, req)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not updated:
        raise HTTPException(status_code=404, detail=f"Character not found: {character_id}")
    return updated


@router.delete("/{character_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_character(character_id: str, request: Request, force: bool = False) -> None:
    services: ServiceContainer = request.app.state.services
    if not force:
        refs = find_character_references(character_id, services.project_repo)
        if refs:
            raise HTTPException(
                status_code=409,
                detail={"message": f"Character is still placed in {len(refs)} project(s).", "references": refs},
            )
    if not services.library_repo.delete_character(character_id):
        raise HTTPException(status_code=404, detail=f"Character not found: {character_id}")
