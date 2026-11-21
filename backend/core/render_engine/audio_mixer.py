"""FFmpeg Master Timeline Audio Mixer (SFX mixing, fades, speed, peak detection)."""

from __future__ import annotations

import asyncio
import re
from pathlib import Path

from app.config import AppConfig
from app.logging_config import get_logger
from core.sound_engine.service import SoundService
from database.library_repo import LibraryRepository
from schemas.project import ProjectState
from utils.ffmpeg import FFmpegLocator, run_ffmpeg_async

logger = get_logger("audio_mixer")

_MAX_VOL_RE = re.compile(r"max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB")


def _build_atempo_chain(speed: float) -> list[str]:
    """FFmpeg atempo accepts [0.5, 2.0]; chain filters if needed."""
    clamped = max(0.5, min(2.0, speed))
    if abs(clamped - 1.0) < 1e-4:
        return []
    return [f"atempo={clamped:.4f}"]


async def mix_project_audio(
    *,
    config: AppConfig,
    library_repo: LibraryRepository,
    sound_service: SoundService,
    state: ProjectState,
    output_wav_path: Path,
    sample_rate: int = 48000,
    cancel_event: asyncio.Event | None = None,
    duration_ms: float | None = None,
    measure_peak: bool = True,
) -> tuple[Path, float | None]:
    """Mix all active SFX/voice/BGM/ambient events from Master Timeline into a stereo WAV file.

    `duration_ms` overrides the bed length (must cover every exported segment).
    Returns (output_wav_path, peak_db).
    """
    ffmpeg = FFmpegLocator.find_ffmpeg(config)
    if not ffmpeg:
        raise RuntimeError("FFmpeg binary not found for audio mixing")

    output_wav_path.parent.mkdir(parents=True, exist_ok=True)
    duration_s = max(0.1, (duration_ms if duration_ms is not None else state.timeline.total_duration_ms) / 1000.0)

    tracks_by_id = {t.track_id: t for t in state.timeline.tracks}
    solo_audio_tracks = {
        t.track_id
        for t in state.timeline.tracks
        if t.track_type in ("sfx", "voice", "ambient", "bgm") and t.solo
    }

    active_events = []
    for ev in state.timeline.sound_events:
        track = tracks_by_id.get(ev.track_id)
        if track:
            if track.muted:
                continue
            if solo_audio_tracks and track.track_id not in solo_audio_tracks:
                continue
            track_vol = track.volume
        else:
            track_vol = 1.0

        sound = library_repo.get_sound(ev.sound_id)
        if not sound:
            continue
        sfile = sound_service.resolve_sound_file(sound)
        if not sfile.is_file():
            continue
        if ev.start_ms >= duration_s * 1000.0:
            continue
        active_events.append((ev, sound, sfile, track_vol))

    # Base silent bed of exact timeline duration ensures output WAV matches video length
    cmd: list[str] = [
        ffmpeg,
        "-y",
        "-hide_banner",
        "-f",
        "lavfi",
        "-t",
        f"{duration_s:.3f}",
        "-i",
        f"anullsrc=channel_layout=stereo:sample_rate={sample_rate}",
    ]

    if not active_events:
        cmd.extend(["-c:a", "pcm_s16le", "-ar", str(sample_rate), "-ac", "2", str(output_wav_path)])
        rc, _, stderr = await run_ffmpeg_async(cmd, cancel_event=cancel_event)
        if rc != 0:
            raise RuntimeError(f"FFmpeg silent audio generation failed: {stderr.strip()}")
        return output_wav_path, -91.0

    filter_chains: list[str] = []
    mix_labels: list[str] = ["[0:a]"]

    for idx, (ev, sound, sfile, track_vol) in enumerate(active_events, start=1):
        cmd.extend(["-i", str(sfile)])

        clip_dur_s = max(0.01, (ev.end_ms - ev.start_ms) / 1000.0)
        trim_start_s = max(0.0, ev.trim_start_ms / 1000.0)
        chain: list[str] = [
            f"aresample={sample_rate}",
            "aformat=channel_layouts=stereo",
        ]

        if ev.loop:
            # Loop audio enough times to cover clip duration
            chain.append("aloop=loop=-1:size=2147483647")

        chain.append(f"atrim=start={trim_start_s:.4f}:duration={clip_dur_s * ev.speed:.4f}")
        chain.append("asetpts=PTS-STARTPTS")
        chain.extend(_build_atempo_chain(ev.speed))
        # Re-trim post atempo to exact clip duration
        chain.append(f"atrim=duration={clip_dur_s:.4f}")
        chain.append("asetpts=PTS-STARTPTS")

        if ev.fade_in_ms > 0:
            fade_in_s = min(clip_dur_s, ev.fade_in_ms / 1000.0)
            chain.append(f"afade=t=in:st=0:d={fade_in_s:.4f}")
        if ev.fade_out_ms > 0:
            fade_out_s = min(clip_dur_s, ev.fade_out_ms / 1000.0)
            fade_out_start = max(0.0, clip_dur_s - fade_out_s)
            chain.append(f"afade=t=out:st={fade_out_start:.4f}:d={fade_out_s:.4f}")

        # Stereo panning (-1 left -> +1 right)
        pan = max(-1.0, min(1.0, ev.spatial_position))
        if abs(pan) > 1e-3:
            left_gain = min(1.0, 1.0 - pan)
            right_gain = min(1.0, 1.0 + pan)
            chain.append(f"pan=stereo|c0={left_gain:.3f}*c0|c1={right_gain:.3f}*c1")

        gain = max(0.0, ev.volume * track_vol)
        chain.append(f"volume={gain:.4f}")

        if ev.start_ms > 0:
            chain.append(f"adelay={ev.start_ms}|{ev.start_ms}")

        label = f"[sfx{idx}]"
        filter_chains.append(f"[{idx}:a]" + ",".join(chain) + label)
        mix_labels.append(label)

    # Mix without auto-attenuation, then apply soft peak limiter (prevent clipping)
    mix_expr = (
        "".join(mix_labels)
        + f"amix=inputs={len(mix_labels)}:duration=first:dropout_transition=0:normalize=0,"
        # level=false: no auto make-up gain (keeps the 0.95 ceiling); latency=true: no 5 ms delay
        + "alimiter=limit=0.95:attack=5:release=50:level=false:latency=true,"
        + f"atrim=duration={duration_s:.3f}[aout]"
    )
    filter_chains.append(mix_expr)

    cmd.extend(
        [
            "-filter_complex",
            ";".join(filter_chains),
            "-map",
            "[aout]",
            "-c:a",
            "pcm_s16le",
            "-ar",
            str(sample_rate),
            "-ac",
            "2",
            str(output_wav_path),
        ]
    )

    rc, _, stderr = await run_ffmpeg_async(cmd, cancel_event=cancel_event)
    if rc != 0:
        raise RuntimeError(f"FFmpeg audio mix failed: {stderr.strip()}")

    peak_db = (
        await measure_audio_peak_db(ffmpeg, output_wav_path, cancel_event=cancel_event)
        if measure_peak
        else None
    )
    logger.info("Mixed %d SFX events into %s (peak=%.2f dB)", len(active_events), output_wav_path.name, peak_db or -91.0)
    return output_wav_path, peak_db


async def measure_audio_peak_db(
    ffmpeg: str,
    wav_path: Path,
    cancel_event: asyncio.Event | None = None,
) -> float | None:
    rc, _, stderr = await run_ffmpeg_async(
        [ffmpeg, "-hide_banner", "-i", str(wav_path), "-af", "volumedetect", "-f", "null", "-"],
        cancel_event=cancel_event,
    )
    if rc != 0:
        return None
    match = _MAX_VOL_RE.search(stderr)
    return float(match.group(1)) if match else None


_LUFS_RE = re.compile(r"I:\s*(-?\d+(?:\.\d+)?)\s*LUFS")


async def measure_integrated_loudness(
    ffmpeg: str,
    wav_path: Path,
    cancel_event: asyncio.Event | None = None,
) -> float | None:
    """EBU R128 integrated loudness (LUFS) of a mixed file, or None if it cannot be measured."""
    rc, _, stderr = await run_ffmpeg_async(
        [ffmpeg, "-hide_banner", "-nostats", "-i", str(wav_path), "-af", "ebur128=framelog=quiet", "-f", "null", "-"],
        cancel_event=cancel_event,
    )
    if rc != 0:
        return None
    matches = _LUFS_RE.findall(stderr)
    if not matches:
        return None
    val = float(matches[-1])
    return None if val <= -70.0 else val


async def build_export_audio(
    *,
    ffmpeg: str,
    master_wav: Path,
    output_wav: Path,
    segments: list[tuple[float, float]],
    sample_rate: int,
    normalize_loudness: bool = False,
    target_lufs: float = -16.0,
    cancel_event: asyncio.Event | None = None,
) -> Path:
    """Cut each exported (start_ms, duration_ms) window out of the master mix and join them.

    Each window is trimmed to its exact frame-aligned video duration so audio and video stay
    sample-accurately in sync across scope boundaries. Optional EBU R128 loudness
    normalization is applied to this export copy only (source audio is never modified).
    """
    total_s = sum(d for _, d in segments) / 1000.0
    parts: list[str] = []
    labels: list[str] = []
    for idx, (start_ms, dur_ms) in enumerate(segments):
        lab = f"[s{idx}]"
        parts.append(
            f"[0:a]atrim=start={start_ms / 1000.0:.6f}:duration={dur_ms / 1000.0:.6f},asetpts=PTS-STARTPTS{lab}"
        )
        labels.append(lab)
    chain_in = labels[0]
    if len(labels) > 1:
        parts.append("".join(labels) + f"concat=n={len(labels)}:v=0:a=1[cat]")
        chain_in = "[cat]"
    post: list[str] = [f"aresample={sample_rate}"]
    post.append(f"apad=whole_dur={total_s:.6f}")
    post.append(f"atrim=duration={total_s:.6f}")
    parts.append(chain_in + ",".join(post) + "[aout]")
    output_wav.parent.mkdir(parents=True, exist_ok=True)
    rc, _, stderr = await run_ffmpeg_async(
        [
            ffmpeg, "-y", "-hide_banner", "-i", str(master_wav),
            "-filter_complex", ";".join(parts),
            "-map", "[aout]", "-c:a", "pcm_s16le", "-ar", str(sample_rate), "-ac", "2",
            str(output_wav),
        ],
        cancel_event=cancel_event,
    )
    if rc != 0:
        raise RuntimeError(f"FFmpeg export audio assembly failed: {stderr.strip()[-600:]}")

    if normalize_loudness:
        # Measured linear gain to the target (exact for the export copy), then a true peak
        # ceiling at -1 dBFS. Single-pass `loudnorm` overshoots badly on short/sparse dialogue.
        measured = await measure_integrated_loudness(ffmpeg, output_wav, cancel_event=cancel_event)
        if measured is not None:
            gain_db = max(-30.0, min(30.0, target_lufs - measured))
            normalized = output_wav.with_name(output_wav.stem + "_norm.wav")
            rc, _, stderr = await run_ffmpeg_async(
                [
                    ffmpeg, "-y", "-hide_banner", "-i", str(output_wav),
                    "-af", f"volume={gain_db:.3f}dB,alimiter=limit=0.891:attack=5:release=50:level=false:latency=true",
                    "-c:a", "pcm_s16le", "-ar", str(sample_rate), "-ac", "2", str(normalized),
                ],
                cancel_event=cancel_event,
            )
            if rc != 0:
                raise RuntimeError(f"FFmpeg loudness normalization failed: {stderr.strip()[-600:]}")
            normalized.replace(output_wav)
    return output_wav
