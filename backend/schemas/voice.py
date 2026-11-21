"""Voice Engine schemas — Providers, Profiles, and Generated Voice Audio Assets."""

from __future__ import annotations

from typing import Literal
from pydantic import BaseModel, Field

from schemas.common import utc_now_iso

VoiceProviderKind = Literal["local_os_tts", "real_local_ai", "real_cloud_ai", "dev_mock"]


class VoiceSettingSpec(BaseModel):
    key: str
    label: str
    type: Literal["number", "select"] = "number"
    min: float | None = None
    max: float | None = None
    step: float | None = None
    default: float | str = 1.0
    options: list[str] = Field(default_factory=list)


class VoiceOption(BaseModel):
    voice_id: str
    name: str
    language: str
    gender: str = "unspecified"
    description: str = ""


class VoiceProviderInfo(BaseModel):
    provider_id: str
    display_name: str
    provider_kind: VoiceProviderKind
    is_mock: bool = False
    is_configured: bool = False
    status_message: str = ""
    supported_languages: list[str] = Field(default_factory=list)
    supported_settings: list[VoiceSettingSpec] = Field(default_factory=list)
    voices: list[VoiceOption] = Field(default_factory=list)


class VoiceProfile(BaseModel):
    voice_profile_id: str
    name: str = Field(min_length=1, max_length=140)
    provider_id: str
    provider_voice_id: str
    language: str = "vi-VN"
    settings: dict[str, float | str] = Field(default_factory=dict)
    created_at: str = Field(default_factory=utc_now_iso)
    updated_at: str = Field(default_factory=utc_now_iso)


class VoiceProfileUpsertRequest(BaseModel):
    name: str = Field(min_length=1, max_length=140)
    provider_id: str
    provider_voice_id: str
    language: str = "vi-VN"
    settings: dict[str, float | str] = Field(default_factory=dict)


class CharacterVoiceAssignRequest(BaseModel):
    voice_profile_id: str | None = None


class VoiceAudioAsset(BaseModel):
    audio_asset_id: str
    project_id: str
    entry_id: str | None = None
    character_id: str | None = None
    voice_profile_id: str | None = None
    provider_id: str
    provider_voice_id: str
    provider_kind: VoiceProviderKind
    is_mock: bool = False
    text: str
    file_path: str
    duration_ms: int = Field(ge=0)
    sample_rate: int = 48000
    channels: int = 1
    codec: str = "pcm_s16le"
    waveform_peaks: list[float] = Field(default_factory=list)
    created_at: str = Field(default_factory=utc_now_iso)


class VoiceGenerateRequest(BaseModel):
    project_id: str
    text: str = Field(min_length=1, max_length=5000)
    entry_id: str | None = None
    character_id: str | None = None
    voice_profile_id: str | None = None
    provider_id: str | None = None
    provider_voice_id: str | None = None
    language: str | None = None
    settings: dict[str, float | str] = Field(default_factory=dict)


# --- Phase 07 Batch 3: Real F5-TTS Configuration, Status & Reference Voice Schemas ---

F5TTSServiceMode = Literal["external_http", "local_managed"]
F5TTSDevicePreference = Literal["auto", "cuda", "mps", "cpu"]


class F5TTSConfig(BaseModel):
    mode: F5TTSServiceMode = "external_http"
    service_url: str = "http://127.0.0.1:7860"
    python_executable: str = ""
    model_name: str = "F5TTS_v1_Base"
    device_preference: F5TTSDevicePreference = "auto"
    default_language: str = "vi-VN"
    timeout_seconds: int = Field(default=120, ge=10, le=600)
    nfe_step: int = Field(default=32, ge=8, le=64)
    cfg_strength: float = Field(default=2.0, ge=0.5, le=5.0)
    cross_fade_duration: float = Field(default=0.15, ge=0.0, le=1.0)


class F5TTSConfigUpdate(BaseModel):
    mode: F5TTSServiceMode | None = None
    service_url: str | None = None
    python_executable: str | None = None
    model_name: str | None = None
    device_preference: F5TTSDevicePreference | None = None
    default_language: str | None = None
    timeout_seconds: int | None = Field(default=None, ge=10, le=600)
    nfe_step: int | None = Field(default=None, ge=8, le=64)
    cfg_strength: float | None = Field(default=None, ge=0.5, le=5.0)
    cross_fade_duration: float | None = Field(default=None, ge=0.0, le=1.0)


class F5TTSReferenceVoice(BaseModel):
    ref_id: str
    name: str = Field(min_length=1, max_length=120)
    language: str = "vi-VN"
    transcript: str = Field(min_length=1, max_length=1000)
    file_path: str
    duration_ms: int = Field(ge=0)
    sample_rate: int = 48000
    channels: int = 1
    waveform_peaks: list[float] = Field(default_factory=list)
    created_at: str = Field(default_factory=utc_now_iso)


class F5TTSStatus(BaseModel):
    mode: F5TTSServiceMode
    service_url: str
    installed: bool = False
    cli_path: str | None = None
    gradio_cli_path: str | None = None
    torch_installed: bool = False
    gpu_available: bool = False
    gpu_backend: Literal["cuda", "mps", "cpu", "none"] = "none"
    device_info: str = ""
    cpu_fallback_supported: bool = True
    managed_process_running: bool = False
    managed_pid: int | None = None
    connection_ok: bool = False
    service_status: Literal["running", "stopped", "not_installed", "error", "unreachable"] = "stopped"
    model_status: Literal["ready", "not_loaded", "not_installed", "unknown"] = "unknown"
    status_message: str = ""
    install_instructions: list[str] = Field(default_factory=list)
    logs: list[str] = Field(default_factory=list)
    reference_count: int = 0
    config: F5TTSConfig = Field(default_factory=F5TTSConfig)


class F5TTSTestConnectionResult(BaseModel):
    ok: bool
    status_code: int | None = None
    latency_ms: int = 0
    detected_api_style: Literal["http_api", "gradio", "unknown"] = "unknown"
    message: str = ""


class F5TTSTestGenerateRequest(BaseModel):
    project_id: str
    text: str = Field(min_length=1, max_length=1000)
    ref_id: str | None = None
    language: str | None = None
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    nfe_step: int | None = Field(default=None, ge=8, le=64)
    cfg_strength: float | None = Field(default=None, ge=0.5, le=5.0)
