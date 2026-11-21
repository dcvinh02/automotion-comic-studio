"""Audio Library API endpoints — Separated SFX & BGM + CC0 Starter Manifest (Phase 05 Batch 3)."""

from __future__ import annotations

from fastapi import APIRouter, File, Form, HTTPException, Query, Request, UploadFile, status
from fastapi.responses import FileResponse

from app.dependencies import ServiceContainer
from schemas.sound import (
    AudioType,
    LicenseSource,
    LicenseUsage,
    SoundAsset,
    SoundCategory,
    SoundLicense,
    SoundUpdateRequest,
)
from schemas.timeline import SoundEffectEvent

router = APIRouter(prefix="/api/v1/sounds", tags=["sounds"])

SFX_CATEGORY_METADATA = [
    {"id": "footsteps", "audio_type": "sfx", "label": "Footsteps", "description": "Single footsteps on wood, stone, grass"},
    {"id": "walking", "audio_type": "sfx", "label": "Walking", "description": "Continuous walking steps and pacing"},
    {"id": "running", "audio_type": "sfx", "label": "Running", "description": "Fast sprint, chase, and rushing footsteps"},
    {"id": "punch", "audio_type": "sfx", "label": "Punch", "description": "Punches, slaps, martial arts hits"},
    {"id": "impact", "audio_type": "sfx", "label": "Impact", "description": "Heavy slams, falls, crashes, collisions"},
    {"id": "doors", "audio_type": "sfx", "label": "Doors", "description": "Opening, closing, knocking, latches"},
    {"id": "objects", "audio_type": "sfx", "label": "Objects", "description": "Props, cups, chairs, utensils, drawers"},
    {"id": "paper", "audio_type": "sfx", "label": "Paper", "description": "Page flips, rustling, writing, tearing"},
    {"id": "glass", "audio_type": "sfx", "label": "Glass", "description": "Glass clinks, shatters, chimes"},
    {"id": "wind", "audio_type": "sfx", "label": "Wind", "description": "Breezes, gusts, howling outdoor wind"},
    {"id": "rain", "audio_type": "sfx", "label": "Rain", "description": "Light drizzle, rainstorm, raindrops"},
    {"id": "thunder", "audio_type": "sfx", "label": "Thunder", "description": "Lightning cracks and rolling thunder"},
    {"id": "fire", "audio_type": "sfx", "label": "Fire", "description": "Campfire crackles, flames, torches"},
    {"id": "water", "audio_type": "sfx", "label": "Water", "description": "Drops, splashes, pouring, streams"},
    {"id": "crowd", "audio_type": "sfx", "label": "Crowd", "description": "Chatter, applause, murmurs, cheering"},
    {"id": "animals", "audio_type": "sfx", "label": "Animals", "description": "Birds, pets, wildlife calls"},
    {"id": "vehicles", "audio_type": "sfx", "label": "Vehicles", "description": "Cars, engines, pass-bys, sirens, brakes"},
    {"id": "magic", "audio_type": "sfx", "label": "Magic", "description": "Spells, sparkles, energy bursts, portals"},
    {"id": "horror", "audio_type": "sfx", "label": "Horror", "description": "Creepy drones, stingers, eerie textures"},
    {"id": "suspense", "audio_type": "sfx", "label": "Suspense", "description": "Heartbeats, tension pulses, mystery hits"},
    {"id": "transitions", "audio_type": "sfx", "label": "Transitions", "description": "Whooshes, swipes, scene cuts, risers"},
    {"id": "ui", "audio_type": "sfx", "label": "UI", "description": "Pops, notifications, clicks, bubble chimes"},
    {"id": "comedy", "audio_type": "sfx", "label": "Comedy", "description": "Boings, slides, cartoon hits, quirky pops"},
    {"id": "cinematic", "audio_type": "sfx", "label": "Cinematic", "description": "Trailer booms, hits, sub drops, brass"},
]

BGM_CATEGORY_METADATA = [
    {"id": "cinematic", "audio_type": "bgm", "label": "Cinematic", "description": "Orchestral and epic narrative themes"},
    {"id": "emotional", "audio_type": "bgm", "label": "Emotional", "description": "Heartfelt piano and warm story beds"},
    {"id": "sad", "audio_type": "bgm", "label": "Sad", "description": "Melancholic minor-key reflection loops"},
    {"id": "happy", "audio_type": "bgm", "label": "Happy", "description": "Upbeat, cheerful, lighthearted loops"},
    {"id": "romantic", "audio_type": "bgm", "label": "Romantic", "description": "Gentle waltz, warm affectionate melodies"},
    {"id": "suspense", "audio_type": "bgm", "label": "Suspense", "description": "Investigative pulses and tension beds"},
    {"id": "horror", "audio_type": "bgm", "label": "Horror", "description": "Dark eerie ambience and unsettling tones"},
    {"id": "action", "audio_type": "bgm", "label": "Action", "description": "Fast-paced chase and battle rhythms"},
    {"id": "adventure", "audio_type": "bgm", "label": "Adventure", "description": "Journey, discovery, heroic exploration"},
    {"id": "ambient", "audio_type": "bgm", "label": "Ambient", "description": "Subtle atmospheric underscore textures"},
    {"id": "comedy", "audio_type": "bgm", "label": "Comedy", "description": "Playful, bouncy comic background loops"},
    {"id": "dramatic", "audio_type": "bgm", "label": "Dramatic", "description": "High-stakes confrontation and climax beds"},
    {"id": "calm", "audio_type": "bgm", "label": "Calm", "description": "Peaceful slice-of-life and quiet scenes"},
    {"id": "fantasy", "audio_type": "bgm", "label": "Fantasy", "description": "Magical harp, enchanted worlds, wonder"},
]

# Backward-compatible export name
CATEGORY_METADATA = SFX_CATEGORY_METADATA


@router.get("/categories")
def list_sound_categories(
    audio_type: AudioType | None = Query(default=None),
) -> list[dict]:
    if audio_type == "bgm":
        return BGM_CATEGORY_METADATA
    if audio_type == "sfx":
        return SFX_CATEGORY_METADATA
    return SFX_CATEGORY_METADATA


@router.get("/manifest")
def get_starter_audio_manifest(request: Request) -> dict:
    services: ServiceContainer = request.app.state.services
    return services.sound_service.get_starter_manifest()


@router.get("", response_model=list[SoundAsset])
def list_sounds(
    request: Request,
    audio_type: AudioType | None = Query(default=None),
    category: str | None = Query(default=None),
    search: str | None = Query(default=None),
    tag: str | None = Query(default=None),
    favorites_only: bool = Query(default=False),
) -> list[SoundAsset]:
    services: ServiceContainer = request.app.state.services
    return services.library_repo.list_sounds(
        audio_type=audio_type,
        category=category,
        search=search,
        tag=tag,
        favorites_only=favorites_only,
    )


@router.post("/import", response_model=SoundAsset, status_code=status.HTTP_201_CREATED)
async def import_sound(
    request: Request,
    file: UploadFile = File(...),
    name: str | None = Form(default=None),
    audio_type: AudioType = Form(default="sfx"),
    category: SoundCategory = Form(default="objects"),
    tags: str = Form(default=""),
    default_volume: float = Form(default=0.8),
    loopable: bool = Form(default=False),
    fade_in_ms: int = Form(default=0),
    fade_out_ms: int = Form(default=0),
    license_source: LicenseSource = Form(default="user_imported"),
    license_usage: LicenseUsage = Form(default="verified"),
    license_attribution: str = Form(default=""),
    license_notes: str = Form(default=""),
    license_origin_source: str = Form(default=""),
) -> SoundAsset:
    services: ServiceContainer = request.app.state.services
    raw = await file.read()
    tag_list = [t.strip() for t in tags.split(",") if t.strip()]
    lic = SoundLicense(
        source=license_source,
        usage=license_usage,
        attribution=license_attribution,
        notes=license_notes,
        origin_source=license_origin_source,
    )
    try:
        return services.sound_service.import_sound_bytes(
            data=raw,
            original_filename=file.filename or "sound.wav",
            name=name,
            audio_type=audio_type,
            category=category,
            tags=tag_list,
            default_volume=default_volume,
            loopable=loopable,
            fade_in_ms=fade_in_ms,
            fade_out_ms=fade_out_ms,
            license_info=lic,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/{sound_id}", response_model=SoundAsset)
def get_sound(sound_id: str, request: Request) -> SoundAsset:
    services: ServiceContainer = request.app.state.services
    sound = services.library_repo.get_sound(sound_id)
    if not sound:
        raise HTTPException(status_code=404, detail=f"Sound not found: {sound_id}")
    return sound


@router.patch("/{sound_id}", response_model=SoundAsset)
def update_sound(sound_id: str, req: SoundUpdateRequest, request: Request) -> SoundAsset:
    services: ServiceContainer = request.app.state.services
    updated = services.library_repo.update_sound(sound_id, req)
    if not updated:
        raise HTTPException(status_code=404, detail=f"Sound not found: {sound_id}")
    return updated


@router.put("/{sound_id}/replace", response_model=SoundAsset)
async def replace_sound_file(
    sound_id: str,
    request: Request,
    file: UploadFile = File(...),
) -> SoundAsset:
    services: ServiceContainer = request.app.state.services
    raw = await file.read()
    try:
        return services.sound_service.replace_sound_bytes(
            sound_id=sound_id,
            data=raw,
            original_filename=file.filename or "sound.wav",
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.delete("/{sound_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_sound(sound_id: str, request: Request) -> None:
    services: ServiceContainer = request.app.state.services
    if not services.sound_service.delete_sound_and_file(sound_id):
        raise HTTPException(status_code=404, detail=f"Sound not found: {sound_id}")


@router.get("/{sound_id}/file")
def serve_sound_file(sound_id: str, request: Request) -> FileResponse:
    services: ServiceContainer = request.app.state.services
    sound = services.library_repo.get_sound(sound_id)
    if not sound:
        raise HTTPException(status_code=404, detail=f"Sound not found: {sound_id}")
    path = services.sound_service.resolve_sound_file(sound)
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"Sound file missing on disk: {sound.file_path}")
    return FileResponse(path=path, headers={"ETag": sound.sha256})


@router.post("/overlaps")
def detect_sound_overlaps(events: list[SoundEffectEvent]) -> dict:
    from core.sound_engine.service import SoundService

    overlaps = SoundService.detect_overlaps(events)
    return {"count": len(overlaps), "overlaps": overlaps}
