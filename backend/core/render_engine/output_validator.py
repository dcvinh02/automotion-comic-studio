"""Phase 08 Batch 3 — Final output validation.

A job is only marked Completed after the *actual file* passes these checks:
exists / non-empty / readable → ffprobe parses it → video stream with the expected codec,
exact width/height, frame rate and frame count, duration → audio stream (when expected)
with the expected codec and a duration matching the video → soft subtitle stream (when
expected) → full decode pass (`ffmpeg -v error -f null`) with zero decode errors.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from schemas.export import OutputValidationCheck, OutputValidationReport
from utils.ffmpeg import ffprobe_json, run_ffmpeg_async

# ffprobe codec_name for each encoder family
EXPECTED_CODEC_NAMES = {"h264": "h264", "hevc": "hevc", "vp9": "vp9", "prores": "prores"}
EXPECTED_AUDIO_NAMES = {"aac": "aac", "libopus": "opus"}


def _parse_rate(rate: str | None) -> float | None:
    if not rate or rate in ("0/0", "0"):
        return None
    try:
        if "/" in rate:
            n, d = rate.split("/", 1)
            d_f = float(d)
            return float(n) / d_f if d_f else None
        return float(rate)
    except ValueError:
        return None


def _count_video_packets(ffprobe: str, path: Path) -> int | None:
    import subprocess

    proc = subprocess.run(
        [
            ffprobe,
            "-v", "error",
            "-select_streams", "v:0",
            "-count_packets",
            "-show_entries", "stream=nb_read_packets",
            "-of", "json",
            str(path),
        ],
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )
    if proc.returncode != 0:
        return None
    try:
        streams = json.loads(proc.stdout).get("streams", [])
        return int(streams[0]["nb_read_packets"]) if streams else None
    except Exception:
        return None


async def validate_output_file(
    *,
    ffmpeg: str,
    ffprobe: str,
    path: Path,
    expected_width: int,
    expected_height: int,
    expected_fps: int,
    expected_frames: int,
    expected_video_codec: str,
    expected_audio_codec: str | None,
    expect_soft_subtitles: bool = False,
    decode_check: bool = True,
    cancel_event: asyncio.Event | None = None,
) -> OutputValidationReport:
    checks: list[OutputValidationCheck] = []

    def add(check: str, passed: bool, message: str, expected=None, actual=None, severity="critical") -> None:
        checks.append(
            OutputValidationCheck(
                check=check,
                passed=passed,
                severity=severity,
                expected=None if expected is None else str(expected),
                actual=None if actual is None else str(actual),
                message=message,
            )
        )

    report = OutputValidationReport(passed=False)
    if not path.is_file():
        add("file_exists", False, f"Output file does not exist: {path.name}")
        report.checks = checks
        return report
    size = path.stat().st_size
    report.file_size_bytes = size
    add("file_exists", True, "Output file exists.")
    if size <= 0:
        add("file_not_empty", False, "Output file is empty (0 bytes).", ">0", size)
        report.checks = checks
        return report
    add("file_not_empty", True, f"File size {size} bytes.", ">0", size)
    try:
        with path.open("rb") as fh:
            fh.read(1024)
        add("file_readable", True, "File is readable.")
    except OSError as exc:
        add("file_readable", False, f"File cannot be read: {exc}")
        report.checks = checks
        return report

    try:
        info = await asyncio.to_thread(ffprobe_json, ffprobe, path)
    except Exception as exc:
        add("ffprobe_parse", False, f"FFprobe could not parse the file (corrupt or incomplete): {exc}")
        report.checks = checks
        return report
    add("ffprobe_parse", True, "FFprobe parsed the container.")

    fmt = info.get("format", {})
    report.container = fmt.get("format_name")
    streams = info.get("streams", [])
    vstreams = [s for s in streams if s.get("codec_type") == "video"]
    astreams = [s for s in streams if s.get("codec_type") == "audio"]
    sstreams = [s for s in streams if s.get("codec_type") == "subtitle"]

    if not vstreams:
        add("video_stream", False, "No video stream found.")
        report.checks = checks
        return report
    vs = vstreams[0]
    add("video_stream", True, "Video stream present.")

    vcodec = vs.get("codec_name")
    report.video_codec = vcodec
    exp_vcodec = EXPECTED_CODEC_NAMES.get(expected_video_codec, expected_video_codec)
    add("video_codec", vcodec == exp_vcodec, "Video codec matches." if vcodec == exp_vcodec else "Unexpected video codec.", exp_vcodec, vcodec)

    width, height = int(vs.get("width") or 0), int(vs.get("height") or 0)
    report.width, report.height = width, height
    res_ok = width == expected_width and height == expected_height
    add("resolution", res_ok, "Resolution matches." if res_ok else "Resolution mismatch.", f"{expected_width}x{expected_height}", f"{width}x{height}")

    fps = _parse_rate(vs.get("avg_frame_rate")) or _parse_rate(vs.get("r_frame_rate"))
    report.fps = round(fps, 3) if fps else None
    fps_ok = fps is not None and abs(fps - expected_fps) <= 0.02 * expected_fps
    add("frame_rate", fps_ok, "Frame rate matches." if fps_ok else "Frame rate mismatch.", expected_fps, report.fps)

    frames = await asyncio.to_thread(_count_video_packets, ffprobe, path)
    report.frame_count = frames
    frames_ok = frames is not None and frames == expected_frames
    add(
        "frame_count",
        frames_ok,
        "Frame count matches." if frames_ok else "Frame count mismatch (dropped/duplicated frames or incomplete file).",
        expected_frames,
        frames,
    )

    expected_dur = expected_frames / float(expected_fps)
    v_dur = None
    for cand in (vs.get("duration"), fmt.get("duration")):
        try:
            if cand is not None:
                v_dur = float(cand)
                break
        except (TypeError, ValueError):
            continue
    report.duration_s = round(v_dur, 3) if v_dur is not None else None
    dur_tol = max(2.0 / expected_fps, 0.05)
    dur_ok = v_dur is not None and abs(v_dur - expected_dur) <= dur_tol
    add("duration", dur_ok, "Duration matches." if dur_ok else "Duration mismatch.", f"{expected_dur:.3f}s", f"{v_dur:.3f}s" if v_dur is not None else None)

    if expected_audio_codec:
        if not astreams:
            add("audio_stream", False, "Audio was expected but no audio stream exists.")
        else:
            a = astreams[0]
            add("audio_stream", True, "Audio stream present.")
            acodec = a.get("codec_name")
            report.audio_codec = acodec
            exp_a = EXPECTED_AUDIO_NAMES.get(expected_audio_codec, expected_audio_codec)
            add("audio_codec", acodec == exp_a, "Audio codec matches." if acodec == exp_a else "Unexpected audio codec.", exp_a, acodec)
            try:
                report.audio_sample_rate = int(a.get("sample_rate") or 0) or None
            except ValueError:
                report.audio_sample_rate = None
            a_dur = None
            try:
                a_dur = float(a["duration"]) if a.get("duration") else None
            except (TypeError, ValueError):
                a_dur = None
            if a_dur is None and fmt.get("duration"):
                a_dur = float(fmt["duration"])
            report.audio_duration_s = round(a_dur, 3) if a_dur is not None else None
            # AAC/Opus frame granularity (~21-23 ms) + encoder priming → allow 0.12 s
            a_ok = a_dur is not None and abs(a_dur - expected_dur) <= 0.12
            add("audio_duration", a_ok, "Audio duration matches video." if a_ok else "Audio/video duration drift.", f"{expected_dur:.3f}s", f"{a_dur:.3f}s" if a_dur is not None else None)
    else:
        add("audio_stream", not astreams, "No audio stream (audio disabled)." if not astreams else "Unexpected audio stream present.", "none", "present" if astreams else "none", severity="warning")

    if expect_soft_subtitles:
        ok = bool(sstreams)
        report.subtitle_codec = sstreams[0].get("codec_name") if sstreams else None
        add("subtitle_stream", ok, "Soft subtitle stream present." if ok else "Soft subtitles were expected but no subtitle stream exists.", "subtitle", report.subtitle_codec)

    if decode_check:
        rc, _, stderr = await run_ffmpeg_async(
            [ffmpeg, "-hide_banner", "-v", "error", "-i", str(path), "-map", "0:v:0", *(["-map", "0:a:0"] if astreams else []), "-f", "null", "-"],
            cancel_event=cancel_event,
        )
        err = stderr.strip()
        dec_ok = rc == 0 and not err
        add("decode_integrity", dec_ok, "Full decode pass completed without errors." if dec_ok else f"Decode errors: {err[-400:] or f'exit code {rc}'}")

    report.checks = checks
    report.passed = all(c.passed for c in checks if c.severity == "critical")
    return report
