"""FFmpeg / FFprobe discovery, capability probing, and safe subprocess execution.

All FFmpeg invocations use argv lists (`create_subprocess_exec` / `subprocess.run` with a
list), never shell strings, so paths containing spaces, quotes, or Vietnamese characters
are passed verbatim.
"""

from __future__ import annotations

import asyncio
import json
import os
import platform
import re
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Awaitable, Callable, Sequence

from app.config import AppConfig
from app.logging_config import get_logger

logger = get_logger("ffmpeg")

_H264_CANDIDATES = ("h264_videotoolbox", "h264_nvenc", "h264_qsv", "libx264")
_ENCODER_LINE_RE = re.compile(r"^\s*([VAS])[A-Z.]{5}\s+(\S+)\s", re.MULTILINE)


@dataclass(frozen=True)
class FFmpegCapabilities:
    available: bool
    ffmpeg_path: str | None
    ffprobe_path: str | None
    version: str | None
    available_h264_encoders: tuple[str, ...]
    recommended_h264_encoder: str
    video_encoders: tuple[str, ...] = ()
    audio_encoders: tuple[str, ...] = ()
    subtitle_encoders: tuple[str, ...] = ()
    hwaccels: tuple[str, ...] = ()
    ffprobe_version: str | None = None
    problems: tuple[str, ...] = field(default_factory=tuple)


class FFmpegLocator:
    """Resolve FFmpeg & FFprobe binaries safely on macOS and Windows."""

    @staticmethod
    def _candidate_paths(binary_name: str, explicit_path: str | None) -> list[Path]:
        candidates: list[Path] = []
        if explicit_path:
            candidates.append(Path(explicit_path).expanduser())

        ext = ".exe" if platform.system() == "Windows" else ""
        exe_name = f"{binary_name}{ext}"

        # Check bundled resources/bin next to repo root (for packaged desktop app)
        repo_root = Path(__file__).resolve().parents[2]
        candidates.append(repo_root / "resources" / "bin" / exe_name)

        # Check PATH
        found_in_path = shutil.which(binary_name)
        if found_in_path:
            candidates.append(Path(found_in_path))

        # Common macOS Homebrew locations (Electron GUI apps often miss Homebrew PATH)
        if platform.system() == "Darwin":
            candidates.append(Path("/opt/homebrew/bin") / binary_name)
            candidates.append(Path("/usr/local/bin") / binary_name)

        return candidates

    @staticmethod
    def _is_executable(path: Path) -> bool:
        return path.is_file() and os.access(path, os.X_OK)

    @classmethod
    def find_ffmpeg(cls, config: AppConfig) -> str | None:
        for path in cls._candidate_paths("ffmpeg", config.ffmpeg_path):
            if cls._is_executable(path):
                return str(path)
        return None

    @classmethod
    def find_ffprobe(cls, config: AppConfig) -> str | None:
        for path in cls._candidate_paths("ffprobe", config.ffprobe_path):
            if cls._is_executable(path):
                return str(path)
        return None


_CAPS_CACHE: dict[tuple, tuple[float, FFmpegCapabilities]] = {}
_CAPS_LOCK = threading.Lock()
_CAPS_TTL_S = 60.0


def invalidate_ffmpeg_cache() -> None:
    with _CAPS_LOCK:
        _CAPS_CACHE.clear()


def _first_line(argv: list[str]) -> str | None:
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=8, check=False)
        if proc.returncode == 0 and proc.stdout:
            return proc.stdout.splitlines()[0].strip()
    except Exception as exc:
        logger.warning("Failed to run %s: %s", argv[0], exc)
    return None


def _probe_uncached(config: AppConfig) -> FFmpegCapabilities:
    ffmpeg = FFmpegLocator.find_ffmpeg(config)
    ffprobe = FFmpegLocator.find_ffprobe(config)
    problems: list[str] = []
    if config.ffmpeg_path and (not ffmpeg or Path(ffmpeg) != Path(config.ffmpeg_path).expanduser()):
        problems.append(f"Configured FFmpeg path is not an executable file: {config.ffmpeg_path}")
    if config.ffprobe_path and (not ffprobe or Path(ffprobe) != Path(config.ffprobe_path).expanduser()):
        problems.append(f"Configured FFprobe path is not an executable file: {config.ffprobe_path}")
    if not ffmpeg:
        problems.append("FFmpeg executable was not found (checked configured path, PATH, Homebrew).")
    if not ffprobe:
        problems.append("FFprobe executable was not found (checked configured path, PATH, Homebrew).")

    if not ffmpeg or not ffprobe:
        return FFmpegCapabilities(
            available=False,
            ffmpeg_path=ffmpeg,
            ffprobe_path=ffprobe,
            version=_first_line([ffmpeg, "-version"]) if ffmpeg else None,
            available_h264_encoders=(),
            recommended_h264_encoder="libx264",
            ffprobe_version=_first_line([ffprobe, "-version"]) if ffprobe else None,
            problems=tuple(problems),
        )

    version_line = _first_line([ffmpeg, "-version"])
    ffprobe_version = _first_line([ffprobe, "-version"])
    if not version_line:
        problems.append("FFmpeg did not respond to -version.")
    if not ffprobe_version:
        problems.append("FFprobe did not respond to -version.")

    video_enc: list[str] = []
    audio_enc: list[str] = []
    sub_enc: list[str] = []
    try:
        proc = subprocess.run(
            [ffmpeg, "-hide_banner", "-encoders"],
            capture_output=True,
            text=True,
            timeout=8,
            check=False,
        )
        if proc.returncode == 0:
            for kind, name in _ENCODER_LINE_RE.findall(proc.stdout):
                if name == "=":
                    continue
                {"V": video_enc, "A": audio_enc, "S": sub_enc}[kind].append(name)
    except Exception as exc:
        logger.warning("Failed to probe ffmpeg encoders: %s", exc)
        problems.append(f"Could not list FFmpeg encoders: {exc}")

    hwaccels: list[str] = []
    try:
        proc = subprocess.run(
            [ffmpeg, "-hide_banner", "-hwaccels"], capture_output=True, text=True, timeout=8, check=False
        )
        if proc.returncode == 0:
            lines = [ln.strip() for ln in proc.stdout.splitlines()]
            hwaccels = [ln for ln in lines if ln and not ln.lower().startswith("hardware acceleration")]
    except Exception:
        pass

    h264 = [c for c in _H264_CANDIDATES if c in video_enc]
    recommended = "libx264"
    if platform.system() == "Darwin" and "h264_videotoolbox" in h264:
        recommended = "h264_videotoolbox"
    elif "h264_nvenc" in h264:
        recommended = "h264_nvenc"
    elif "h264_qsv" in h264:
        recommended = "h264_qsv"

    return FFmpegCapabilities(
        available=bool(version_line and ffprobe_version),
        ffmpeg_path=ffmpeg,
        ffprobe_path=ffprobe,
        version=version_line,
        available_h264_encoders=tuple(h264),
        recommended_h264_encoder=recommended,
        video_encoders=tuple(video_enc),
        audio_encoders=tuple(audio_enc),
        subtitle_encoders=tuple(sub_enc),
        hwaccels=tuple(hwaccels),
        ffprobe_version=ffprobe_version,
        problems=tuple(problems),
    )


def probe_ffmpeg_capabilities(config: AppConfig, *, force: bool = False) -> FFmpegCapabilities:
    """Detect FFmpeg/FFprobe paths, version and encoders (cached ~60s per configured path)."""
    key = (config.ffmpeg_path, config.ffprobe_path, os.environ.get("PATH", ""))
    now = time.monotonic()
    with _CAPS_LOCK:
        hit = _CAPS_CACHE.get(key)
        if hit and not force and now - hit[0] < _CAPS_TTL_S:
            return hit[1]
    caps = _probe_uncached(config)
    with _CAPS_LOCK:
        _CAPS_CACHE[key] = (time.monotonic(), caps)
    return caps


def ffprobe_json(ffprobe_path: str, media_path: Path, extra_args: Sequence[str] = ()) -> dict:
    """Run ffprobe safely using argv list and return parsed JSON."""
    proc = subprocess.run(
        [
            ffprobe_path,
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            *extra_args,
            str(media_path),
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=120,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ffprobe failed for {media_path.name}: {proc.stderr.strip()}")
    return json.loads(proc.stdout)


async def _terminate_process(proc: asyncio.subprocess.Process, grace_s: float = 3.0) -> None:
    """Terminate an FFmpeg child and make sure it is reaped (no orphaned processes)."""
    if proc.returncode is not None:
        return
    try:
        proc.terminate()
    except ProcessLookupError:
        return
    try:
        await asyncio.wait_for(proc.wait(), timeout=grace_s)
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except ProcessLookupError:
            return
        await proc.wait()


async def run_ffmpeg_async(
    args: Sequence[str],
    cancel_event: asyncio.Event | None = None,
) -> tuple[int, str, str]:
    """Run an FFmpeg subprocess asynchronously with optional cancellation."""
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    async def _watch_cancel() -> None:
        if cancel_event is None:
            return
        await cancel_event.wait()
        if proc.returncode is None:
            logger.info("Cancelling FFmpeg process pid=%s", proc.pid)
            await _terminate_process(proc)

    watcher = asyncio.create_task(_watch_cancel()) if cancel_event is not None else None
    try:
        stdout_b, stderr_b = await proc.communicate()
    except asyncio.CancelledError:
        await _terminate_process(proc)
        raise
    finally:
        if watcher is not None:
            watcher.cancel()
            try:
                await watcher
            except asyncio.CancelledError:
                pass

    return (
        proc.returncode if proc.returncode is not None else -1,
        stdout_b.decode("utf-8", errors="replace"),
        stderr_b.decode("utf-8", errors="replace"),
    )


async def run_ffmpeg_with_progress(
    args: Sequence[str],
    *,
    total_duration_s: float,
    on_progress: Callable[[float], Awaitable[None]] | None = None,
    cancel_event: asyncio.Event | None = None,
) -> tuple[int, str]:
    """Run FFmpeg with `-progress pipe:1` and report real fractional progress (0..1).

    `args` must NOT already contain `-progress`; it is inserted after the binary.
    Returns (returncode, stderr_tail).
    """
    argv = [args[0], "-nostats", "-progress", "pipe:1", *args[1:]]
    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stderr_chunks: list[bytes] = []

    async def _drain_stderr() -> None:
        assert proc.stderr is not None
        while True:
            block = await proc.stderr.read(4096)
            if not block:
                break
            stderr_chunks.append(block)
            # keep memory bounded
            if sum(len(b) for b in stderr_chunks) > 64_000:
                del stderr_chunks[: len(stderr_chunks) // 2]

    async def _read_progress() -> None:
        assert proc.stdout is not None
        last_reported = -1.0
        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            text = line.decode("utf-8", errors="replace").strip()
            if text.startswith("out_time_us=") or text.startswith("out_time_ms="):
                try:
                    us = int(text.split("=", 1)[1])
                except ValueError:
                    continue
                frac = max(0.0, min(1.0, (us / 1_000_000.0) / max(0.001, total_duration_s)))
                if on_progress and frac - last_reported >= 0.02:
                    last_reported = frac
                    await on_progress(frac)

    async def _watch_cancel() -> None:
        if cancel_event is None:
            return
        await cancel_event.wait()
        await _terminate_process(proc)

    watcher = asyncio.create_task(_watch_cancel()) if cancel_event is not None else None
    try:
        await asyncio.gather(_drain_stderr(), _read_progress())
        await proc.wait()
    except asyncio.CancelledError:
        await _terminate_process(proc)
        raise
    finally:
        if watcher is not None:
            watcher.cancel()
            try:
                await watcher
            except asyncio.CancelledError:
                pass
    tail = b"".join(stderr_chunks).decode("utf-8", errors="replace")[-4000:]
    return (proc.returncode if proc.returncode is not None else -1, tail)


def smoke_test_encoder(ffmpeg_path: str, encoder: str, extra: Sequence[str] = (), container: str = "mp4") -> tuple[bool, str]:
    """Encode 0.2s of synthetic video with the given encoder to a null muxer to prove it works."""
    argv = [
        ffmpeg_path,
        "-hide_banner",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=256x144:rate=10:duration=0.2",
        "-c:v",
        encoder,
        *extra,
        "-f",
        "null",
        "-",
    ]
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=30, check=False)
    except Exception as exc:
        return False, str(exc)
    return proc.returncode == 0, proc.stderr.strip()[-400:]
