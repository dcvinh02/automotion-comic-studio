"""REST API router for Voice Engine (Providers, Profiles, Character Assignment, Generation & Audio Preview)."""

from __future__ import annotations

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app.dependencies import ServiceContainer
from schemas.character import Character
from schemas.sound import SoundAsset
from schemas.voice import (
    CharacterVoiceAssignRequest,
    F5TTSConfig,
    F5TTSConfigUpdate,
    F5TTSReferenceVoice,
    F5TTSStatus,
    F5TTSTestConnectionResult,
    F5TTSTestGenerateRequest,
    VoiceAudioAsset,
    VoiceGenerateRequest,
    VoiceProfile,
    VoiceProfileUpsertRequest,
    VoiceProviderInfo,
)

router = APIRouter(prefix="/api/v1/voice", tags=["voice"])


def _svc(request: Request) -> ServiceContainer:
    return request.app.state.services


@router.get("/providers", response_model=list[VoiceProviderInfo])
def list_voice_providers(request: Request) -> list[VoiceProviderInfo]:
    return _svc(request).voice_service.list_providers()


@router.get("/profiles", response_model=list[VoiceProfile])
def list_voice_profiles(request: Request) -> list[VoiceProfile]:
    return _svc(request).voice_service.list_profiles()


@router.post("/profiles", response_model=VoiceProfile, status_code=201)
def create_voice_profile(req: VoiceProfileUpsertRequest, request: Request) -> VoiceProfile:
    try:
        return _svc(request).voice_service.create_profile(req)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.put("/profiles/{voice_profile_id}", response_model=VoiceProfile)
def update_voice_profile(
    voice_profile_id: str, req: VoiceProfileUpsertRequest, request: Request
) -> VoiceProfile:
    try:
        return _svc(request).voice_service.update_profile(voice_profile_id, req)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.delete("/profiles/{voice_profile_id}", status_code=204)
def delete_voice_profile(voice_profile_id: str, request: Request) -> None:
    deleted = _svc(request).voice_service.delete_profile(voice_profile_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Voice profile not found: {voice_profile_id}")


@router.put("/characters/{character_id}/assign", response_model=Character)
def assign_character_voice(
    character_id: str, req: CharacterVoiceAssignRequest, request: Request
) -> Character:
    try:
        return _svc(request).voice_service.assign_profile_to_character(
            character_id, req.voice_profile_id
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/generate", response_model=VoiceAudioAsset, status_code=201)
async def generate_voice_audio(
    req: VoiceGenerateRequest, request: Request
) -> VoiceAudioAsset:
    try:
        return await _svc(request).voice_service.generate_voice_audio(req)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/audio/{project_id}", response_model=list[VoiceAudioAsset])
def list_project_voice_audio(project_id: str, request: Request) -> list[VoiceAudioAsset]:
    return _svc(request).project_repo.list_voice_audio_assets(project_id)


@router.get("/audio/{project_id}/{audio_asset_id}/file")
def get_voice_audio_file(project_id: str, audio_asset_id: str, request: Request) -> FileResponse:
    try:
        path = _svc(request).voice_service.resolve_voice_audio_file(project_id, audio_asset_id)
    except (FileNotFoundError, ValueError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Voice audio file missing on disk.")
    return FileResponse(path, media_type="audio/wav", filename=path.name)


class RegisterTimelineSoundRequest(BaseModel):
    label: str | None = None


@router.post("/audio/{project_id}/{audio_asset_id}/register-sound", response_model=SoundAsset)
def register_voice_as_sound(
    project_id: str,
    audio_asset_id: str,
    req: RegisterTimelineSoundRequest,
    request: Request,
) -> SoundAsset:
    try:
        return _svc(request).voice_service.register_voice_asset_as_timeline_sound(
            project_id, audio_asset_id, label=req.label
        )
    except (FileNotFoundError, ValueError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


# --- Phase 07 Batch 3: Real F5-TTS Configuration, Lifecycle & Voice Reference Endpoints ---


@router.get("/f5-tts/status", response_model=F5TTSStatus)
async def get_f5_tts_status(request: Request, probe: bool = False) -> F5TTSStatus:
    return await _svc(request).voice_service.get_f5_status(probe_connection=probe)


@router.put("/f5-tts/config", response_model=F5TTSConfig)
def update_f5_tts_config(req: F5TTSConfigUpdate, request: Request) -> F5TTSConfig:
    return _svc(request).voice_service.update_f5_config(req)


@router.post("/f5-tts/start", response_model=F5TTSStatus)
async def start_f5_tts_service(request: Request) -> F5TTSStatus:
    try:
        return await _svc(request).voice_service.start_f5_service()
    except RuntimeError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/f5-tts/stop", response_model=F5TTSStatus)
async def stop_f5_tts_service(request: Request) -> F5TTSStatus:
    return await _svc(request).voice_service.stop_f5_service()


@router.post("/f5-tts/test-connection", response_model=F5TTSTestConnectionResult)
async def test_f5_tts_connection(request: Request) -> F5TTSTestConnectionResult:
    return await _svc(request).voice_service.test_f5_connection()


@router.post("/f5-tts/test-generate", response_model=VoiceAudioAsset, status_code=201)
async def test_f5_tts_generate(
    req: F5TTSTestGenerateRequest,
    request: Request,
) -> VoiceAudioAsset:
    try:
        return await _svc(request).voice_service.test_f5_generation(req)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/f5-tts/references", response_model=list[F5TTSReferenceVoice])
def list_f5_tts_references(request: Request) -> list[F5TTSReferenceVoice]:
    return _svc(request).voice_service.list_f5_references()


@router.post("/f5-tts/references", response_model=F5TTSReferenceVoice, status_code=201)
async def import_f5_tts_reference(
    request: Request,
    file: UploadFile = File(...),
    name: str = Form(...),
    transcript: str = Form(...),
    language: str = Form("vi-VN"),
) -> F5TTSReferenceVoice:
    try:
        data = await file.read()
        return await _svc(request).voice_service.import_f5_reference_voice(
            data=data,
            original_filename=file.filename or "reference.wav",
            name=name,
            transcript=transcript,
            language=language,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/f5-tts/references/{ref_id}/file")
def get_f5_tts_reference_file(ref_id: str, request: Request) -> FileResponse:
    try:
        path = _svc(request).voice_service.resolve_f5_reference_file(ref_id)
    except (FileNotFoundError, ValueError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Reference voice audio missing on disk.")
    return FileResponse(path, media_type="audio/wav", filename=path.name)


@router.delete("/f5-tts/references/{ref_id}", status_code=204)
def delete_f5_tts_reference(ref_id: str, request: Request) -> None:
    deleted = _svc(request).voice_service.delete_f5_reference_voice(ref_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"F5-TTS reference voice not found: {ref_id}")
