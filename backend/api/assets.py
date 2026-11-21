"""Asset Management API endpoints (Module 02)."""

from __future__ import annotations

from fastapi import APIRouter, File, Form, HTTPException, Query, Request, UploadFile, status
from fastapi.responses import FileResponse

from app.dependencies import ServiceContainer
from core.asset_engine.references import find_asset_references
from schemas.asset import Asset, AssetScope, AssetType, AssetUpdateRequest, PartRole

router = APIRouter(prefix="/api/v1/assets", tags=["assets"])


@router.get("", response_model=list[Asset])
def list_assets(
    request: Request,
    type: str | None = Query(default=None),
    folder: str | None = Query(default=None),
    search: str | None = Query(default=None),
    tag: str | None = Query(default=None),
) -> list[Asset]:
    services: ServiceContainer = request.app.state.services
    return services.library_repo.list_assets(
        asset_type=type, folder=folder, search=search, tag=tag
    )


@router.post("/import", response_model=Asset, status_code=status.HTTP_201_CREATED)
async def import_asset(
    request: Request,
    file: UploadFile = File(...),
    name: str | None = Form(default=None),
    type: AssetType = Form(default="character_part"),
    part_role: PartRole | None = Form(default=None),
    folder: str = Form(default="general"),
    tags: str = Form(default=""),
    scope: AssetScope = Form(default="global"),
    project_id: str | None = Form(default=None),
    anchor_x: float = Form(default=0.5),
    anchor_y: float = Form(default=0.5),
    identity_verified: bool = Form(default=True),
) -> Asset:
    services: ServiceContainer = request.app.state.services
    raw = await file.read()
    tag_list = [t.strip() for t in tags.split(",") if t.strip()]
    try:
        return services.asset_service.import_image_bytes(
            data=raw,
            original_filename=file.filename or "asset.png",
            name=name,
            asset_type=type,
            part_role=part_role,
            folder=folder,
            tags=tag_list,
            scope=scope,
            project_id=project_id,
            anchor_x=anchor_x,
            anchor_y=anchor_y,
            identity_verified=identity_verified,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/{asset_id}", response_model=Asset)
def get_asset(asset_id: str, request: Request) -> Asset:
    services: ServiceContainer = request.app.state.services
    asset = services.library_repo.get_asset(asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail=f"Asset not found: {asset_id}")
    return asset


@router.patch("/{asset_id}", response_model=Asset)
def update_asset(asset_id: str, req: AssetUpdateRequest, request: Request) -> Asset:
    services: ServiceContainer = request.app.state.services
    updated = services.library_repo.update_asset(asset_id, req)
    if not updated:
        raise HTTPException(status_code=404, detail=f"Asset not found: {asset_id}")
    return updated


@router.get("/{asset_id}/references")
def asset_references(asset_id: str, request: Request) -> list[dict]:
    services: ServiceContainer = request.app.state.services
    return find_asset_references(asset_id, services.library_repo, services.project_repo)


@router.delete("/{asset_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_asset(asset_id: str, request: Request, force: bool = False) -> None:
    services: ServiceContainer = request.app.state.services
    if not force:
        refs = find_asset_references(asset_id, services.library_repo, services.project_repo)
        if refs:
            raise HTTPException(
                status_code=409,
                detail={"message": f"Asset is still used in {len(refs)} place(s).", "references": refs},
            )
    ok = services.asset_service.delete_asset_and_file(asset_id)
    if not ok:
        raise HTTPException(status_code=404, detail=f"Asset not found: {asset_id}")


@router.get("/{asset_id}/file")
def serve_asset_file(asset_id: str, request: Request) -> FileResponse:
    services: ServiceContainer = request.app.state.services
    asset = services.library_repo.get_asset(asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail=f"Asset not found: {asset_id}")
    path = services.asset_service.resolve_asset_file(asset)
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"Asset file missing on disk: {asset.file_path}")
    return FileResponse(
        path=path,
        headers={"Cache-Control": "public, max-age=31536000, immutable", "ETag": asset.sha256},
    )
