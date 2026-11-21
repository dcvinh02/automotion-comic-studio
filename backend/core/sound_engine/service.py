"""Sound Effects Library engine (Spec v2.0 Section 4)."""

from __future__ import annotations

import array
import math
import subprocess
import uuid
from pathlib import Path

from app.config import AppConfig, BGM_CATEGORIES, LEGACY_SFX_CATEGORIES, SFX_CATEGORIES, SOUND_CATEGORIES
from app.logging_config import get_logger
from core.sound_engine.starter_pack import read_starter_manifest, seed_starter_pack_if_needed
from database.library_repo import LibraryRepository
from schemas.common import utc_now_iso
from schemas.sound import AudioType, SoundAsset, SoundCategory, SoundLicense
from schemas.timeline import SoundEffectEvent
from utils.ffmpeg import FFmpegLocator, ffprobe_json
from utils.paths import (
    compute_sha256_bytes,
    safe_resolve_under,
    sanitize_filename,
    to_posix_relative,
)

logger = get_logger("sound_engine")

ALLOWED_AUDIO_EXTENSIONS = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac"}


class SoundService:
    def __init__(self, config: AppConfig, repo: LibraryRepository) -> None:
        self.config = config
        self.repo = repo

    def seed_starter_pack(self, force: bool = False) -> int:
        return seed_starter_pack_if_needed(self.config, self.repo, force=force)

    def get_starter_manifest(self) -> dict:
        return read_starter_manifest(self.config)

    def import_sound_bytes(
        self,
        *,
        data: bytes,
        original_filename: str,
        name: str | None,
        category: SoundCategory,
        audio_type: AudioType = "sfx",
        tags: list[str] | None = None,
        default_volume: float = 0.8,
        loopable: bool = False,
        fade_in_ms: int = 0,
        fade_out_ms: int = 0,
        license_info: SoundLicense | None = None,
    ) -> SoundAsset:
        if audio_type == "bgm":
            if category not in BGM_CATEGORIES:
                raise ValueError(f"Unsupported BGM category: {category!r}")
        else:
            if category not in SFX_CATEGORIES and category not in LEGACY_SFX_CATEGORIES and category not in SOUND_CATEGORIES:
                raise ValueError(f"Unsupported sound category: {category!r}")
        ext = Path(original_filename).suffix.lower()
        if ext not in ALLOWED_AUDIO_EXTENSIONS:
            raise ValueError(
                f"Unsupported audio format {ext!r}. Allowed: WAV, MP3, FLAC, OGG, M4A, AAC"
            )
        if not data:
            raise ValueError("Uploaded audio file is empty")

        sha = compute_sha256_bytes(data)
        existing = self.repo.find_sound_by_sha256(sha, audio_type=audio_type)
        if existing:
            try:
                if self.resolve_sound_file(existing).is_file():
                    return existing
            except ValueError:
                pass

        prefix = "bgm" if audio_type == "bgm" else "sfx"
        sound_id = f"{prefix}_{category}_{uuid.uuid4().hex[:8]}"
        clean_stem = sanitize_filename(Path(original_filename).stem, fallback=sound_id)
        dest_dir = self.config.sounds_dir / audio_type / category
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest_file = dest_dir / f"{clean_stem}_{sound_id[-6:]}{ext}"
        dest_file.write_bytes(data)

        try:
            meta = self._inspect_audio(dest_file)
            peaks = self._extract_waveform_peaks(dest_file, num_buckets=200)
        except Exception:
            dest_file.unlink(missing_ok=True)
            raise

        rel_path = to_posix_relative(dest_file, self.config.sounds_dir)
        display_name = (name or Path(original_filename).stem).strip() or sound_id

        sound = SoundAsset(
            sound_id=sound_id,
            name=display_name,
            audio_type=audio_type,
            category=category,
            tags=[t.strip() for t in (tags or []) if t.strip()],
            file_path=rel_path,
            sha256=sha,
            duration_ms=meta["duration_ms"],
            sample_rate=meta["sample_rate"],
            channels=meta["channels"],
            codec=meta["codec"],
            default_volume=default_volume,
            loopable=loopable,
            fade_in_ms=fade_in_ms,
            fade_out_ms=fade_out_ms,
            is_favorite=False,
            is_bundled=False,
            waveform_peaks=peaks,
            license=license_info or SoundLicense(source="user_imported", usage="verified"),
            created_at=utc_now_iso(),
        )
        self.repo.save_sound(sound)
        logger.info(
            "Imported %s %s (%s, %dms, %s)",
            audio_type,
            sound.sound_id,
            sound.name,
            sound.duration_ms,
            sound.codec,
        )
        return sound

    def replace_sound_bytes(
        self,
        sound_id: str,
        data: bytes,
        original_filename: str,
    ) -> SoundAsset:
        existing = self.repo.get_sound(sound_id)
        if not existing:
            raise FileNotFoundError(f"Sound not found: {sound_id}")

        ext = Path(original_filename).suffix.lower()
        if ext not in ALLOWED_AUDIO_EXTENSIONS:
            raise ValueError(
                f"Unsupported audio format {ext!r}. Allowed: WAV, MP3, FLAC, OGG"
            )
        if not data:
            raise ValueError("Uploaded audio file is empty")

        clean_stem = sanitize_filename(Path(original_filename).stem, fallback=sound_id)
        dest_dir = self.config.sounds_dir / existing.audio_type / existing.category
        dest_dir.mkdir(parents=True, exist_ok=True)
        new_file = dest_dir / f"{clean_stem}_{uuid.uuid4().hex[:6]}{ext}"
        new_file.write_bytes(data)

        try:
            meta = self._inspect_audio(new_file)
            peaks = self._extract_waveform_peaks(new_file, num_buckets=200)
        except Exception:
            new_file.unlink(missing_ok=True)
            raise

        old_path = self.resolve_sound_file(existing)
        updated = existing.model_copy(
            update={
                "file_path": to_posix_relative(new_file, self.config.sounds_dir),
                "sha256": compute_sha256_bytes(data),
                "duration_ms": meta["duration_ms"],
                "sample_rate": meta["sample_rate"],
                "channels": meta["channels"],
                "codec": meta["codec"],
                "waveform_peaks": peaks,
            }
        )
        self.repo.save_sound(updated)
        if old_path.is_file() and old_path.resolve() != new_file.resolve():
            old_path.unlink(missing_ok=True)
        return updated

    def delete_sound_and_file(self, sound_id: str) -> bool:
        deleted = self.repo.delete_sound(sound_id)
        if not deleted:
            return False
        try:
            path = self.resolve_sound_file(deleted)
            if path.is_file():
                path.unlink()
        except Exception as exc:
            logger.warning("Failed to unlink sound file for %s: %s", sound_id, exc)
        return True

    def resolve_sound_file(self, sound: SoundAsset) -> Path:
        return safe_resolve_under(self.config.sounds_dir, sound.file_path)

    def _inspect_audio(self, file_path: Path) -> dict:
        ffprobe = FFmpegLocator.find_ffprobe(self.config)
        if ffprobe:
            try:
                data = ffprobe_json(ffprobe, file_path)
            except Exception as exc:
                raise ValueError(f"Invalid or corrupted audio file '{file_path.name}': {exc}") from exc
            streams = [s for s in data.get("streams", []) if s.get("codec_type") == "audio"]
            if not streams:
                raise ValueError(f"No audio stream found in {file_path.name}")
            stream = streams[0]
            fmt = data.get("format", {})
            dur_raw = stream.get("duration") or fmt.get("duration")
            if not dur_raw:
                raise ValueError(f"Could not determine audio duration for {file_path.name}")
            duration_ms = max(1, int(round(float(dur_raw) * 1000.0)))
            sample_rate = int(stream.get("sample_rate") or 48000)
            channels = int(stream.get("channels") or 2)
            codec = str(stream.get("codec_name") or "unknown")
            return {
                "duration_ms": duration_ms,
                "sample_rate": sample_rate,
                "channels": channels,
                "codec": codec,
            }

        # Fallback for WAV using Python stdlib wave if ffprobe is absent
        if file_path.suffix.lower() == ".wav":
            import wave

            try:
                with wave.open(str(file_path), "rb") as wf:
                    frames = wf.getnframes()
                    rate = wf.getframerate()
                    channels = wf.getnchannels()
                    duration_ms = max(1, int(round((frames / float(rate)) * 1000.0)))
                    return {
                        "duration_ms": duration_ms,
                        "sample_rate": rate,
                        "channels": channels,
                        "codec": "pcm_wav",
                    }
            except Exception as exc:
                raise ValueError(f"Invalid WAV audio file '{file_path.name}': {exc}") from exc
        raise RuntimeError(
            "FFprobe is required to inspect non-WAV audio files (MP3/FLAC/OGG). Please install FFmpeg."
        )

    def _extract_waveform_peaks(self, file_path: Path, num_buckets: int = 200) -> list[float]:
        ffmpeg = FFmpegLocator.find_ffmpeg(self.config)
        raw_samples: array.array | None = None

        if ffmpeg:
            proc = subprocess.run(
                [
                    ffmpeg,
                    "-v",
                    "error",
                    "-i",
                    str(file_path),
                    "-ac",
                    "1",
                    "-ar",
                    "8000",
                    "-f",
                    "s16le",
                    "pipe:1",
                ],
                capture_output=True,
                timeout=20,
                check=False,
            )
            if proc.returncode == 0 and proc.stdout:
                samples = array.array("h")
                # Ensure even byte count for 16-bit PCM
                usable = len(proc.stdout) - (len(proc.stdout) % 2)
                samples.frombytes(proc.stdout[:usable])
                raw_samples = samples

        if raw_samples is None and file_path.suffix.lower() == ".wav":
            import wave

            with wave.open(str(file_path), "rb") as wf:
                if wf.getsampwidth() == 2:
                    raw = wf.readframes(wf.getnframes())
                    samples = array.array("h")
                    usable = len(raw) - (len(raw) % 2)
                    samples.frombytes(raw[:usable])
                    raw_samples = samples

        if not raw_samples:
            return [0.0] * min(num_buckets, 32)

        total = len(raw_samples)
        bucket_count = min(num_buckets, total)
        step = total / float(bucket_count)
        peaks: list[float] = []
        for idx in range(bucket_count):
            start = int(idx * step)
            end = max(start + 1, int((idx + 1) * step))
            segment = raw_samples[start:end]
            peak = max((abs(v) for v in segment), default=0) / 32768.0
            peaks.append(round(min(1.0, peak), 4))
        return peaks

    @staticmethod
    def detect_overlaps(events: list[SoundEffectEvent], max_concurrent: int = 3) -> list[dict]:
        """Detect timeline segments where too many SFX overlap or same SFX overlaps itself."""
        overlaps: list[dict] = []
        sorted_events = sorted(events, key=lambda e: (e.start_ms, e.end_ms))

        # Check same-sound overlaps
        for i, ev in enumerate(sorted_events):
            for other in sorted_events[i + 1 :]:
                if other.start_ms >= ev.end_ms:
                    break
                if other.sound_id == ev.sound_id:
                    overlaps.append(
                        {
                            "type": "duplicate_overlap",
                            "time_ms": other.start_ms,
                            "event_ids": [ev.event_id, other.event_id],
                            "message": f"Same sound effect ({ev.sound_id}) overlaps itself at {other.start_ms}ms",
                        }
                    )

        # Sweep line for concurrent count > max_concurrent
        points: list[tuple[int, int, str]] = []
        for ev in sorted_events:
            points.append((ev.start_ms, 1, ev.event_id))
            points.append((ev.end_ms, -1, ev.event_id))
        points.sort(key=lambda p: (p[0], p[1]))

        active: set[str] = set()
        flagged_times: set[int] = set()
        for t, delta, eid in points:
            if delta == 1:
                active.add(eid)
                if len(active) > max_concurrent and t not in flagged_times:
                    flagged_times.add(t)
                    overlaps.append(
                        {
                            "type": "dense_overlap",
                            "time_ms": t,
                            "event_ids": sorted(active),
                            "message": f"{len(active)} sound effects overlap simultaneously at {t}ms (recommended <= {max_concurrent})",
                        }
                    )
            else:
                active.discard(eid)

        return overlaps
