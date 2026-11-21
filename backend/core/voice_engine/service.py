"""Voice Production Engine Service (Phase 04 / Version 0.2 Foundation)."""

from __future__ import annotations

import asyncio
import tempfile
import uuid
from pathlib import Path

from app.config import AppConfig
from app.logging_config import get_logger
from core.sound_engine.service import SoundService
from database.library_repo import LibraryRepository
from database.project_repo import ProjectRepository
from providers.voice_provider import F5TTSProvider, VoiceProviderRegistry
from schemas.common import utc_now_iso
from schemas.sound import SoundAsset, SoundLicense
from schemas.voice import (
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
from utils.ffmpeg import FFmpegLocator
from utils.paths import safe_resolve_under, to_posix_relative

logger = get_logger("voice_engine")


class VoiceService:
    def __init__(
        self,
        config: AppConfig,
        library_repo: LibraryRepository,
        project_repo: ProjectRepository,
        sound_service: SoundService,
    ) -> None:
        self.config = config
        self.library_repo = library_repo
        self.project_repo = project_repo
        self.sound_service = sound_service
        self.registry = VoiceProviderRegistry(config, library_repo=library_repo)

    @property
    def f5_provider(self) -> F5TTSProvider:
        return self.registry.f5_provider

    async def get_f5_status(self, probe_connection: bool = False) -> F5TTSStatus:
        return await self.f5_provider.get_status(probe_connection=probe_connection)

    def update_f5_config(self, patch: F5TTSConfigUpdate) -> F5TTSConfig:
        return self.f5_provider.update_config(patch)

    async def start_f5_service(self) -> F5TTSStatus:
        return await self.f5_provider.start_managed_service()

    async def stop_f5_service(self) -> F5TTSStatus:
        return await self.f5_provider.stop_managed_service()

    async def test_f5_connection(self) -> F5TTSTestConnectionResult:
        return await self.f5_provider.test_connection()

    def list_f5_references(self) -> list[F5TTSReferenceVoice]:
        return self.f5_provider.list_references()

    def resolve_f5_reference_file(self, ref_id: str) -> Path:
        refs = self.f5_provider.list_references()
        ref = next((r for r in refs if r.ref_id == ref_id), None)
        if not ref:
            raise FileNotFoundError(f"F5-TTS reference voice not found: {ref_id}")
        return self.f5_provider.resolve_reference_audio_path(ref)

    async def import_f5_reference_voice(
        self,
        *,
        data: bytes,
        original_filename: str,
        name: str,
        transcript: str,
        language: str = "vi-VN",
    ) -> F5TTSReferenceVoice:
        clean_name = (name or "").strip()
        clean_transcript = (transcript or "").strip()
        if not clean_name:
            raise ValueError("Reference voice name is required.")
        if not clean_transcript:
            raise ValueError("Reference voice transcript is required for F5-TTS voice conditioning.")
        if not data or len(data) < 44:
            raise ValueError("Reference audio file is empty or too small.")

        ext = Path(original_filename or "ref.wav").suffix.lower()
        if ext not in {".wav", ".mp3", ".ogg", ".flac", ".m4a", ".aac"}:
            raise ValueError(
                f"Unsupported reference audio format '{ext or 'unknown'}'. Use WAV, MP3, FLAC, OGG, or M4A."
            )

        ref_id = f"f5ref_{uuid.uuid4().hex[:10]}"
        refs_dir = self.config.workspace_dir / "asset_library" / "voice_refs"
        refs_dir.mkdir(parents=True, exist_ok=True)
        dest_wav = refs_dir / f"{ref_id}.wav"

        ffmpeg = FFmpegLocator.find_ffmpeg(self.config)
        if ffmpeg:
            with tempfile.TemporaryDirectory(prefix="amcs_f5ref_") as tmp_dir:
                raw_path = Path(tmp_dir) / f"input{ext}"
                raw_path.write_bytes(data)
                proc = await asyncio.create_subprocess_exec(
                    ffmpeg,
                    "-y",
                    "-i",
                    str(raw_path),
                    "-ar",
                    "24000",
                    "-ac",
                    "1",
                    "-c:a",
                    "pcm_s16le",
                    str(dest_wav),
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                _, err = await proc.communicate()
                if proc.returncode != 0 or not dest_wav.is_file() or dest_wav.stat().st_size <= 44:
                    raise ValueError(
                        f"Invalid or unreadable reference audio file: {err.decode('utf-8', errors='ignore')[:200]}"
                    )
        else:
            if not data.startswith(b"RIFF"):
                raise ValueError("Only PCM WAV reference audio is supported when FFmpeg is unavailable.")
            dest_wav.write_bytes(data)

        audio_meta = self.sound_service._inspect_audio(dest_wav)
        if audio_meta["duration_ms"] < 300:
            dest_wav.unlink(missing_ok=True)
            raise ValueError(
                f"Reference voice audio is too short ({audio_meta['duration_ms']}ms). Provide at least 0.3s (ideally 3–12s) of clear speech."
            )
        peaks = self.sound_service._extract_waveform_peaks(dest_wav, num_buckets=120)
        rel_path = to_posix_relative(dest_wav, self.config.workspace_dir)

        ref = F5TTSReferenceVoice(
            ref_id=ref_id,
            name=clean_name,
            language=(language or "vi-VN").strip(),
            transcript=clean_transcript,
            file_path=rel_path,
            duration_ms=audio_meta["duration_ms"],
            sample_rate=audio_meta["sample_rate"],
            channels=audio_meta["channels"],
            waveform_peaks=peaks,
            created_at=utc_now_iso(),
        )
        refs = self.f5_provider.list_references()
        refs.append(ref)
        self.f5_provider.save_references(refs)
        return ref

    def delete_f5_reference_voice(self, ref_id: str) -> bool:
        refs = self.f5_provider.list_references()
        target = next((r for r in refs if r.ref_id == ref_id), None)
        if not target:
            return False
        try:
            p = self.f5_provider.resolve_reference_audio_path(target)
            p.unlink(missing_ok=True)
        except Exception:
            pass
        self.f5_provider.save_references([r for r in refs if r.ref_id != ref_id])
        return True

    async def test_f5_generation(self, req: F5TTSTestGenerateRequest) -> VoiceAudioAsset:
        settings: dict[str, float | str] = {"speed": req.speed}
        if req.nfe_step is not None:
            settings["nfe_step"] = req.nfe_step
        if req.cfg_strength is not None:
            settings["cfg_strength"] = req.cfg_strength
        if req.ref_id:
            settings["ref_id"] = req.ref_id
        return await self.generate_voice_audio(
            VoiceGenerateRequest(
                project_id=req.project_id,
                text=req.text,
                provider_id="f5_tts",
                provider_voice_id=req.ref_id or "f5_default_ref",
                language=req.language,
                settings=settings,
            )
        )

    def list_providers(self) -> list[VoiceProviderInfo]:
        return self.registry.list_infos()

    def list_profiles(self) -> list[VoiceProfile]:
        return self.library_repo.list_voice_profiles()

    def create_profile(self, req: VoiceProfileUpsertRequest) -> VoiceProfile:
        provider = self.registry.get(req.provider_id)
        if not provider:
            raise ValueError(f"Unknown voice provider: {req.provider_id!r}")
        return self.library_repo.create_voice_profile(req)

    def update_profile(self, voice_profile_id: str, req: VoiceProfileUpsertRequest) -> VoiceProfile:
        provider = self.registry.get(req.provider_id)
        if not provider:
            raise ValueError(f"Unknown voice provider: {req.provider_id!r}")
        updated = self.library_repo.update_voice_profile(voice_profile_id, req)
        if not updated:
            raise FileNotFoundError(f"Voice profile not found: {voice_profile_id}")
        return updated

    def delete_profile(self, voice_profile_id: str) -> bool:
        return self.library_repo.delete_voice_profile(voice_profile_id)

    def assign_profile_to_character(
        self, character_id: str, voice_profile_id: str | None
    ):
        if voice_profile_id:
            if not self.library_repo.get_voice_profile(voice_profile_id):
                raise FileNotFoundError(f"Voice profile not found: {voice_profile_id}")
        updated = self.library_repo.assign_character_voice_profile(character_id, voice_profile_id)
        if not updated:
            raise FileNotFoundError(f"Character not found: {character_id}")
        return updated

    async def generate_voice_audio(self, req: VoiceGenerateRequest) -> VoiceAudioAsset:
        text = req.text.strip()
        if not text:
            raise ValueError("Dialogue or narration text cannot be empty.")

        pdir = self.config.ensure_project_layout(req.project_id)
        if not (pdir / "project.db").is_file():
            raise FileNotFoundError(f"Project not found: {req.project_id}")

        # Resolve voice profile (explicit -> character's assigned profile -> explicit provider fields)
        profile: VoiceProfile | None = None
        if req.voice_profile_id:
            profile = self.library_repo.get_voice_profile(req.voice_profile_id)
        elif req.character_id:
            char = self.library_repo.get_character(req.character_id)
            if char and char.voice_profile_id:
                profile = self.library_repo.get_voice_profile(char.voice_profile_id)

        provider_id = req.provider_id or (profile.provider_id if profile else None)
        if not provider_id:
            raise ValueError(
                "No voice provider or character voice profile assigned. Assign a voice first."
            )

        provider = self.registry.get(provider_id)
        if not provider:
            raise ValueError(f"Voice provider not found: {provider_id}")

        info = provider.get_info()
        if not info.is_configured:
            raise RuntimeError(
                info.status_message or f"Voice provider '{info.display_name}' is not configured."
            )

        voice_id = (
            req.provider_voice_id
            or (profile.provider_voice_id if profile else None)
            or (info.voices[0].voice_id if info.voices else "default")
        )
        language = (
            req.language
            or (profile.language if profile else None)
            or (info.supported_languages[0] if info.supported_languages else "vi-VN")
        )
        merged_settings = {**(profile.settings if profile else {}), **(req.settings or {})}

        audio_asset_id = f"va_{uuid.uuid4().hex[:10]}"
        voice_dir = pdir / "audio" / "voice"
        voice_dir.mkdir(parents=True, exist_ok=True)
        dest_wav = voice_dir / f"{audio_asset_id}.wav"

        synth_meta = await provider.synthesize(
            text=text,
            voice_id=voice_id,
            language=language,
            settings=merged_settings,
            output_wav_path=dest_wav,
        )

        # Extract real duration & real waveform peaks from the generated WAV file
        audio_meta = self.sound_service._inspect_audio(dest_wav)
        peaks = self.sound_service._extract_waveform_peaks(dest_wav, num_buckets=160)

        rel_path = to_posix_relative(dest_wav, pdir)
        asset = VoiceAudioAsset(
            audio_asset_id=audio_asset_id,
            project_id=req.project_id,
            entry_id=req.entry_id,
            character_id=req.character_id,
            voice_profile_id=profile.voice_profile_id if profile else req.voice_profile_id,
            provider_id=info.provider_id,
            provider_voice_id=str(synth_meta.get("provider_voice_id", voice_id)),
            provider_kind=info.provider_kind,
            is_mock=bool(synth_meta.get("is_mock", info.is_mock)),
            text=text,
            file_path=rel_path,
            duration_ms=audio_meta["duration_ms"],
            sample_rate=audio_meta["sample_rate"],
            channels=audio_meta["channels"],
            codec=audio_meta["codec"],
            waveform_peaks=peaks,
            created_at=utc_now_iso(),
        )
        self.project_repo.save_voice_audio_asset(asset)
        logger.info(
            "Generated voice audio %s via %s (mock=%s, %dms)",
            asset.audio_asset_id,
            asset.provider_id,
            asset.is_mock,
            asset.duration_ms,
        )
        return asset

    def resolve_voice_audio_file(self, project_id: str, audio_asset_id: str) -> Path:
        asset = self.project_repo.get_voice_audio_asset(project_id, audio_asset_id)
        if not asset:
            raise FileNotFoundError(f"Voice audio asset not found: {audio_asset_id}")
        pdir = self.config.project_dir(project_id)
        return safe_resolve_under(pdir, asset.file_path)

    def register_voice_asset_as_timeline_sound(
        self, project_id: str, audio_asset_id: str, label: str | None = None
    ) -> SoundAsset:
        """Imports the generated voice WAV into SoundService so it plays and exports on Timeline Voice Track."""
        asset = self.project_repo.get_voice_audio_asset(project_id, audio_asset_id)
        if not asset:
            raise FileNotFoundError(f"Voice audio asset not found: {audio_asset_id}")
        wav_path = self.resolve_voice_audio_file(project_id, audio_asset_id)
        if not wav_path.is_file():
            raise FileNotFoundError(f"Voice WAV file missing on disk: {wav_path}")

        display_name = (label or asset.text[:36]).strip() or asset.audio_asset_id
        prefix = "[MOCK] " if asset.is_mock else "[Voice] "
        return self.sound_service.import_sound_bytes(
            data=wav_path.read_bytes(),
            original_filename=f"{asset.audio_asset_id}.wav",
            name=f"{prefix}{display_name}",
            category="emotional",
            tags=["voice", asset.provider_id, *(["mock"] if asset.is_mock else [])],
            default_volume=1.0,
            license_info=SoundLicense(
                source="user_imported",
                usage="verified",
                attribution=f"Generated via {asset.provider_id} ({asset.provider_voice_id})",
            ),
        )
