"""Phase 08 Batch 3 — Export planning: scope resolution, settings validation, encoder selection.

Pure functions (no rendering, no I/O except filesystem checks for the output directory) so the
exact same logic backs `/render/validate` (UI preview) and the real render job.
"""

from __future__ import annotations

import math
import os
import re
import unicodedata
from pathlib import Path

from schemas.export import (
    MAX_DIMENSION,
    MAX_FPS,
    MIN_DIMENSION,
    MIN_FPS,
    RESOLUTION_PRESETS,
    STANDARD_FPS,
    CodecCapability,
    ExportPlan,
    ExportPlanIssue,
    ExportSegment,
    ExportSettings,
    ResolvedEncoder,
)
from schemas.job import ExportPreset, ExportRequest
from schemas.project import ProjectState
from schemas.subtitle import SubtitleSegment
from utils.ffmpeg import FFmpegCapabilities

# ---------------------------------------------------------------------------
# Codec / container matrix
# ---------------------------------------------------------------------------

CODEC_MATRIX: dict[str, dict] = {
    "h264": {
        "label": "H.264 / AVC",
        "containers": ["mp4", "mov"],
        "software": "libx264",
        "hardware": ["h264_videotoolbox", "h264_nvenc", "h264_qsv"],
        "pix_fmts": ["yuv420p", "yuv422p", "yuv444p"],
        "profiles": ["baseline", "main", "high", "high422", "high444"],
    },
    "hevc": {
        "label": "H.265 / HEVC",
        "containers": ["mp4", "mov"],
        "software": "libx265",
        "hardware": ["hevc_videotoolbox", "hevc_nvenc", "hevc_qsv"],
        "pix_fmts": ["yuv420p", "yuv422p", "yuv444p"],
        "profiles": ["main"],
    },
    "vp9": {
        "label": "VP9",
        "containers": ["webm"],
        "software": "libvpx-vp9",
        "hardware": [],
        "pix_fmts": ["yuv420p", "yuv444p"],
        "profiles": ["0", "1"],
    },
    "prores": {
        "label": "Apple ProRes",
        "containers": ["mov"],
        "software": "prores_ks",
        "hardware": [],
        "pix_fmts": ["yuv422p10le", "yuv444p10le"],
        "profiles": ["proxy", "lt", "standard", "hq", "4444"],
    },
}

CONTAINER_AUDIO_CODEC = {"mp4": "aac", "mov": "aac", "webm": "libopus"}
CONTAINER_SOFT_SUBS = {"mp4": "mov_text", "mov": "mov_text"}

X26X_PRESETS = [
    "ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow",
]

# Genuinely different encoder settings per quality preset (software encoders).
SW_QUALITY = {
    "libx264": {
        "draft": ("ultrafast", 30),
        "standard": ("veryfast", 23),
        "high": ("medium", 19),
        "maximum": ("slow", 16),
    },
    "libx265": {
        "draft": ("ultrafast", 32),
        "standard": ("fast", 27),
        "high": ("medium", 23),
        "maximum": ("slow", 20),
    },
}
VP9_QUALITY = {
    "draft": (42, "realtime", 8),
    "standard": (34, "good", 5),
    "high": (30, "good", 3),
    "maximum": (24, "good", 1),
}
PRORES_QUALITY = {"draft": "0", "standard": "2", "high": "3", "maximum": "4"}
PRORES_PROFILE_NAMES = {"proxy": "0", "lt": "1", "standard": "2", "hq": "3", "4444": "4"}
# Hardware encoders have no CRF: bits-per-pixel-per-frame → target bitrate.
HW_BPP = {"draft": 0.045, "standard": 0.09, "high": 0.16, "maximum": 0.26}


def codec_capabilities(caps: FFmpegCapabilities) -> list[CodecCapability]:
    out: list[CodecCapability] = []
    for codec_id, info in CODEC_MATRIX.items():
        sw = info["software"] if info["software"] in caps.video_encoders else None
        hw = [e for e in info["hardware"] if e in caps.video_encoders]
        containers = [
            c for c in info["containers"] if CONTAINER_AUDIO_CODEC[c] in caps.audio_encoders
        ]
        out.append(
            CodecCapability(
                codec=codec_id,  # type: ignore[arg-type]
                label=info["label"],
                containers=containers,  # type: ignore[arg-type]
                software_encoder=sw,
                hardware_encoders=hw,
                available=bool((sw or hw) and containers and caps.available),
            )
        )
    return out


# ---------------------------------------------------------------------------
# Legacy (v0.1 preset_id) → ExportSettings
# ---------------------------------------------------------------------------


def settings_from_legacy_request(req: ExportRequest, preset: ExportPreset) -> ExportSettings:
    res_id = "custom"
    for pid, dims in RESOLUTION_PRESETS.items():
        if dims == (preset.width, preset.height):
            res_id = pid
            break
    encoder_pref = "auto"
    if preset.video_codec == "libx264":
        encoder_pref = "software"
    elif preset.video_codec in ("h264_videotoolbox", "h264_nvenc", "h264_qsv"):
        encoder_pref = "hardware"
    return ExportSettings.model_validate(
        {
            "resolution_preset": res_id,
            "width": preset.width,
            "height": preset.height,
            "fps": preset.fps,
            "container": "mp4",
            "video_codec": "h264",
            "encoder": encoder_pref,
            "quality": "standard",
            "audio": {
                "enabled": True,
                "bitrate_kbps": preset.audio_bitrate_kbps,
                "sample_rate": 48000 if preset.sample_rate not in (44100, 48000) else preset.sample_rate,
            },
            "subtitles": {"mode": req.subtitle_mode, "export_srt": req.export_srt_sidecar},
            "output_dir": req.output_dir,
            "filename": req.output_filename,
            "render_mode": req.render_mode,
            "chunk_duration_seconds": req.chunk_duration_seconds,
        }
    )


# ---------------------------------------------------------------------------
# Scope → ordered source segments
# ---------------------------------------------------------------------------


def frames_for_duration(duration_ms: float, fps: int) -> int:
    return max(1, int(math.ceil((duration_ms / 1000.0) * fps - 1e-6)))


def resolve_segments(
    state: ProjectState, settings: ExportSettings
) -> tuple[list[ExportSegment], list[ExportPlanIssue]]:
    scope = settings.scope
    fps = settings.fps
    issues: list[ExportPlanIssue] = []
    windows: list[tuple[str, float, float, str | None, str | None]] = []
    timeline_ms = float(state.timeline.total_duration_ms)
    scenes_sorted = sorted(state.scenes, key=lambda s: (s.start_ms, s.order_index))
    scenes_by_id = {s.scene_id: s for s in state.scenes}

    if scope.kind == "project":
        windows.append(("Project", 0.0, timeline_ms, None, None))
    elif scope.kind in ("scene", "scenes"):
        ids = list(dict.fromkeys(scope.scene_ids))
        if not ids:
            issues.append(ExportPlanIssue(code="SCOPE_EMPTY", severity="error", field="scope", message="Select at least one scene to export."))
        if scope.kind == "scene" and len(ids) > 1:
            issues.append(ExportPlanIssue(code="SCOPE_TOO_MANY", severity="error", field="scope", message="'Current Scene' scope accepts exactly one scene."))
        missing = [i for i in ids if i not in scenes_by_id]
        for mid in missing:
            issues.append(ExportPlanIssue(code="SCOPE_SCENE_NOT_FOUND", severity="error", field="scope", message=f"Scene not found in project: {mid}"))
        wanted = set(ids)
        # Timeline order is the intended order (selection order is not meaningful on a timeline).
        for sc in scenes_sorted:
            if sc.scene_id in wanted:
                windows.append((sc.name, float(sc.start_ms), float(sc.duration_ms), sc.scene_id, None))
    elif scope.kind in ("shot", "shots"):
        refs = list({(r.scene_id, r.shot_id): r for r in scope.shots}.values())
        if not refs:
            issues.append(ExportPlanIssue(code="SCOPE_EMPTY", severity="error", field="scope", message="Select at least one shot to export."))
        if scope.kind == "shot" and len(refs) > 1:
            issues.append(ExportPlanIssue(code="SCOPE_TOO_MANY", severity="error", field="scope", message="'Current Shot' scope accepts exactly one shot."))
        resolved: list[tuple[float, int, str, float, float, str, str]] = []
        for ref in refs:
            sc = scenes_by_id.get(ref.scene_id)
            shot = next((sh for sh in (sc.shots if sc else []) if sh.shot_id == ref.shot_id), None)
            if not sc or not shot:
                issues.append(ExportPlanIssue(code="SCOPE_SHOT_NOT_FOUND", severity="error", field="scope", message=f"Shot not found: {ref.scene_id}/{ref.shot_id}"))
                continue
            start = float(sc.start_ms + shot.start_ms)
            end = min(float(sc.start_ms + sc.duration_ms), start + float(shot.duration_ms))
            if end <= start:
                issues.append(ExportPlanIssue(code="SCOPE_SHOT_OUTSIDE_SCENE", severity="error", field="scope", message=f"Shot '{shot.title}' lies outside its scene duration."))
                continue
            if end < start + shot.duration_ms:
                issues.append(ExportPlanIssue(code="SCOPE_SHOT_TRUNCATED", severity="warning", field="scope", message=f"Shot '{shot.title}' extends past its scene end and is truncated to the scene."))
            resolved.append((start, shot.shot_order, f"{sc.name} · {shot.title}", start, end - start, sc.scene_id, shot.shot_id))
        resolved.sort(key=lambda r: (r[0], r[1]))
        windows.extend((r[2], r[3], r[4], r[5], r[6]) for r in resolved)
    elif scope.kind == "range":
        rs, re_ = scope.range_start_ms, scope.range_end_ms
        if rs is None or re_ is None:
            issues.append(ExportPlanIssue(code="SCOPE_RANGE_MISSING", severity="error", field="scope", message="Timeline range requires both a start and an end time."))
        elif re_ <= rs:
            issues.append(ExportPlanIssue(code="SCOPE_RANGE_INVALID", severity="error", field="scope", message="Range end must be after range start."))
        elif rs >= timeline_ms:
            issues.append(ExportPlanIssue(code="SCOPE_RANGE_OUTSIDE", severity="error", field="scope", message="Range starts after the end of the timeline."))
        else:
            end = min(float(re_), timeline_ms)
            if re_ > timeline_ms:
                issues.append(ExportPlanIssue(code="SCOPE_RANGE_CLAMPED", severity="warning", field="scope", message=f"Range end clamped to timeline duration ({timeline_ms / 1000:.2f}s)."))
            windows.append(("Range", float(rs), end - float(rs), None, None))

    segments: list[ExportSegment] = []
    cursor = 0
    for label, start, dur, scene_id, shot_id in windows:
        n = frames_for_duration(dur, fps)
        segments.append(
            ExportSegment(
                label=label,
                source_start_ms=start,
                duration_ms=n * 1000.0 / fps,
                frame_count=n,
                output_start_frame=cursor,
                scene_id=scene_id,
                shot_id=shot_id,
            )
        )
        cursor += n
    return segments, issues


def build_frame_time_map(segments: list[ExportSegment], fps: int) -> list[float]:
    """Output frame index → source timeline time (ms). Changing fps changes real sampling."""
    times: list[float] = []
    for seg in segments:
        for k in range(seg.frame_count):
            times.append(seg.source_start_ms + (k * 1000.0) / fps)
    return times


def retime_subtitles(
    subtitles: list[SubtitleSegment], segments: list[ExportSegment]
) -> list[SubtitleSegment]:
    """Map enabled source cues onto the output timeline (clipped to each exported segment)."""
    out: list[SubtitleSegment] = []
    out_offset_ms = 0.0
    for seg in segments:
        seg_start = seg.source_start_ms
        seg_end = seg.source_start_ms + seg.duration_ms
        for cue in subtitles:
            if not cue.enabled or not cue.text.strip():
                continue
            s = max(float(cue.start_ms), seg_start)
            e = min(float(cue.end_ms), seg_end)
            if e - s < 1.0:
                continue
            start_ms = int(round(out_offset_ms + s - seg_start))
            end_ms = int(round(out_offset_ms + e - seg_start))
            if end_ms <= start_ms:
                continue
            out.append(
                cue.model_copy(
                    update={
                        "subtitle_id": f"{cue.subtitle_id}@{seg.output_start_frame}",
                        "start_ms": start_ms,
                        "end_ms": end_ms,
                    }
                )
            )
        out_offset_ms += seg.duration_ms
    return out


# ---------------------------------------------------------------------------
# Encoder resolution
# ---------------------------------------------------------------------------


def resolve_encoder(
    settings: ExportSettings, caps: FFmpegCapabilities, width: int, height: int
) -> tuple[ResolvedEncoder | None, list[ExportPlanIssue]]:
    issues: list[ExportPlanIssue] = []
    info = CODEC_MATRIX[settings.video_codec]
    container = settings.container
    if container not in info["containers"]:
        issues.append(
            ExportPlanIssue(
                code="CODEC_CONTAINER_INCOMPATIBLE",
                severity="error",
                field="video_codec",
                message=f"{info['label']} cannot be stored in .{container}. Supported: {', '.join('.' + c for c in info['containers'])}.",
            )
        )
        return None, issues

    sw = info["software"] if info["software"] in caps.video_encoders else None
    hw = next((e for e in info["hardware"] if e in caps.video_encoders), None)
    if settings.encoder == "software":
        encoder = sw
    elif settings.encoder == "hardware":
        encoder = hw
    else:
        # Auto prefers the software encoder: deterministic, CRF-based quality presets.
        encoder = sw or hw
    if not encoder:
        what = "hardware" if settings.encoder == "hardware" else "an"
        issues.append(
            ExportPlanIssue(
                code="ENCODER_UNAVAILABLE",
                severity="error",
                field="encoder",
                message=f"No {what} {info['label']} encoder is available in this FFmpeg build.",
            )
        )
        return None, issues

    audio_codec = CONTAINER_AUDIO_CODEC[container]
    if settings.audio.enabled and audio_codec not in caps.audio_encoders:
        issues.append(
            ExportPlanIssue(code="AUDIO_ENCODER_UNAVAILABLE", severity="error", field="audio", message=f"Audio encoder '{audio_codec}' required for .{container} is not available.")
        )

    is_hw = encoder in info["hardware"]
    adv = settings.advanced
    q = settings.quality
    fps = settings.fps
    args: list[str] = ["-c:v", encoder]
    desc = ""

    # Pixel format
    default_pix = "yuv422p10le" if settings.video_codec == "prores" else "yuv420p"
    if settings.video_codec == "prores" and (q == "maximum" or adv.profile == "4444"):
        default_pix = "yuv444p10le"
    pix_fmt = adv.pix_fmt or default_pix
    if pix_fmt not in info["pix_fmts"]:
        issues.append(ExportPlanIssue(code="PIX_FMT_UNSUPPORTED", severity="error", field="advanced.pix_fmt", message=f"Pixel format '{pix_fmt}' is not supported for {info['label']} (allowed: {', '.join(info['pix_fmts'])})."))
        pix_fmt = default_pix
    if is_hw and pix_fmt != "yuv420p":
        issues.append(ExportPlanIssue(code="PIX_FMT_HW_UNSUPPORTED", severity="error", field="advanced.pix_fmt", message="Hardware encoders only support yuv420p here. Use the software encoder for 4:2:2 / 4:4:4."))
        pix_fmt = "yuv420p"
    if pix_fmt.startswith("yuv420") and (width % 2 or height % 2):
        issues.append(ExportPlanIssue(code="ODD_DIMENSIONS", severity="error", field="width", message=f"{pix_fmt} requires even width and height (got {width}×{height})."))

    # Profile
    profile = adv.profile
    if profile and profile not in info["profiles"]:
        issues.append(ExportPlanIssue(code="PROFILE_UNSUPPORTED", severity="error", field="advanced.profile", message=f"Profile '{profile}' is not valid for {info['label']} (allowed: {', '.join(info['profiles'])})."))
        profile = None
    if settings.video_codec == "h264" and profile in ("baseline", "main", "high") and pix_fmt != "yuv420p":
        issues.append(ExportPlanIssue(code="PROFILE_PIX_FMT_CONFLICT", severity="error", field="advanced.profile", message=f"H.264 profile '{profile}' only supports yuv420p; use high422/high444 or change pixel format."))
    if settings.video_codec == "h264" and profile == "baseline" and adv.keyframe_interval is None:
        pass  # valid; baseline just disables B-frames

    # Rate control per encoder family
    crf_capable = encoder in ("libx264", "libx265", "libvpx-vp9")
    if adv.crf is not None and not crf_capable:
        issues.append(ExportPlanIssue(code="CRF_UNSUPPORTED", severity="error", field="advanced.crf", message=f"CRF is not supported by {encoder}. Use bitrate instead (or the software encoder)."))
    if adv.crf is not None and encoder in ("libx264", "libx265") and adv.crf > 51:
        issues.append(ExportPlanIssue(code="CRF_OUT_OF_RANGE", severity="error", field="advanced.crf", message="CRF for H.264/H.265 must be between 0 and 51."))

    if encoder in ("libx264", "libx265"):
        preset_name, crf = SW_QUALITY[encoder][q]
        if adv.encoder_preset:
            if adv.encoder_preset not in X26X_PRESETS:
                issues.append(ExportPlanIssue(code="ENCODER_PRESET_INVALID", severity="error", field="advanced.encoder_preset", message=f"Encoder preset must be one of: {', '.join(X26X_PRESETS)}."))
            else:
                preset_name = adv.encoder_preset
        args += ["-preset", preset_name]
        if adv.bitrate_kbps:
            b = adv.bitrate_kbps
            args += ["-b:v", f"{b}k", "-maxrate", f"{int(b * 1.5)}k", "-bufsize", f"{b * 2}k"]
            desc = f"{encoder} preset={preset_name} ABR {b} kbps"
        else:
            crf_val = adv.crf if adv.crf is not None else crf
            args += ["-crf", str(crf_val)]
            desc = f"{encoder} preset={preset_name} CRF {crf_val}"
        if encoder == "libx265":
            args += ["-x265-params", "log-level=error"]
        if profile:
            args += ["-profile:v", profile]
    elif encoder == "libvpx-vp9":
        crf, deadline, cpu_used = VP9_QUALITY[q]
        if adv.encoder_preset:
            if adv.encoder_preset not in ("realtime", "good", "best"):
                issues.append(ExportPlanIssue(code="ENCODER_PRESET_INVALID", severity="error", field="advanced.encoder_preset", message="VP9 deadline must be realtime, good or best."))
            else:
                deadline = adv.encoder_preset
        if adv.bitrate_kbps:
            args += ["-b:v", f"{adv.bitrate_kbps}k"]
            desc = f"libvpx-vp9 {deadline} {adv.bitrate_kbps} kbps"
        else:
            crf_val = adv.crf if adv.crf is not None else crf
            args += ["-crf", str(crf_val), "-b:v", "0"]
            desc = f"libvpx-vp9 {deadline} CRF {crf_val}"
        args += ["-deadline", deadline, "-cpu-used", str(cpu_used), "-row-mt", "1"]
        if profile:
            args += ["-profile:v", profile]
        if pix_fmt == "yuv444p" and profile != "1":
            args += ["-profile:v", "1"]
    elif encoder == "prores_ks":
        prof = PRORES_PROFILE_NAMES.get(profile or "", PRORES_QUALITY[q])
        if prof == "4" and pix_fmt != "yuv444p10le":
            pix_fmt = "yuv444p10le"
        if prof != "4" and pix_fmt == "yuv444p10le" and not profile:
            prof = "4"
        args += ["-profile:v", prof, "-vendor", "apl0"]
        desc = f"prores_ks profile {prof}"
        if adv.bitrate_kbps:
            issues.append(ExportPlanIssue(code="BITRATE_IGNORED", severity="warning", field="advanced.bitrate_kbps", message="ProRes is a fixed-quality intra codec; the bitrate override is ignored."))
        if adv.encoder_preset:
            issues.append(ExportPlanIssue(code="ENCODER_PRESET_IGNORED", severity="warning", field="advanced.encoder_preset", message="Encoder preset is ignored for ProRes."))
    else:  # hardware encoders
        bpp = HW_BPP[q] * (0.6 if settings.video_codec == "hevc" else 1.0)
        b = adv.bitrate_kbps or max(64, int(bpp * width * height * fps / 1000.0))
        args += ["-b:v", f"{b}k", "-maxrate", f"{int(b * 1.5)}k", "-bufsize", f"{b * 2}k"]
        if encoder.endswith("_videotoolbox"):
            args += ["-allow_sw", "1"]
        if profile:
            args += ["-profile:v", profile]
        desc = f"{encoder} {b} kbps"
        if adv.encoder_preset:
            issues.append(ExportPlanIssue(code="ENCODER_PRESET_IGNORED", severity="warning", field="advanced.encoder_preset", message="Encoder preset is ignored for hardware encoders."))

    # GOP / keyframes
    if settings.video_codec != "prores":
        gop = adv.keyframe_interval or max(1, fps * 2)
        args += ["-g", str(gop)]
    elif adv.keyframe_interval:
        issues.append(ExportPlanIssue(code="KEYINT_IGNORED", severity="warning", field="advanced.keyframe_interval", message="ProRes is intra-only; keyframe interval is ignored."))

    if settings.video_codec == "hevc":
        args += ["-tag:v", "hvc1"]

    # RGBA → YUV with an explicit BT.709 matrix + matching tags (correct colors in players)
    vf = f"scale=out_color_matrix=bt709:out_range=tv,format={pix_fmt}"
    args += [
        "-vf", vf,
        "-pix_fmt", pix_fmt,
        "-colorspace", "bt709",
        "-color_primaries", "bt709",
        "-color_trc", "bt709",
        "-color_range", "tv",
    ]

    return (
        ResolvedEncoder(
            encoder=encoder,
            is_hardware=is_hw,
            args=args,
            description=desc,
            audio_codec=audio_codec,
            chunk_extension=f".{container}",
        ),
        issues,
    )


# ---------------------------------------------------------------------------
# Output path handling
# ---------------------------------------------------------------------------

_ILLEGAL_FILENAME_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_WINDOWS_RESERVED = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


def sanitize_export_filename(name: str, fallback: str = "export") -> str:
    """Keep Unicode letters (Vietnamese diacritics), digits and spaces; strip only unsafe chars."""
    # Separators are replaced (not used to split), so a name can never escape its folder.
    base = unicodedata.normalize("NFC", str(name))
    cleaned = _ILLEGAL_FILENAME_CHARS.sub("_", base)
    cleaned = re.sub(r"\s+", " ", cleaned).strip().strip(".").strip()
    stem = cleaned.rsplit(".", 1)[0] if "." in cleaned else cleaned
    if stem.upper() in _WINDOWS_RESERVED:
        cleaned = f"_{cleaned}"
    # Keep well under common 255-byte filesystem limits (UTF-8 Vietnamese can be 3 bytes/char)
    while len(cleaned.encode("utf-8")) > 180:
        cleaned = cleaned[:-1]
    return cleaned or fallback


def default_filename(state: ProjectState, settings: ExportSettings, segments: list[ExportSegment]) -> str:
    scope = settings.scope.kind
    base = state.meta.name
    if scope in ("scene", "shot") and segments:
        base = f"{base} - {segments[0].label}"
    elif scope in ("scenes", "shots"):
        base = f"{base} - {len(segments)} {'scenes' if scope == 'scenes' else 'shots'}"
    elif scope == "range":
        base = f"{base} - range"
    return base


def resolve_output_path(
    *,
    state: ProjectState,
    settings: ExportSettings,
    segments: list[ExportSegment],
    project_dir: Path,
    reserved_paths: set[str],
) -> tuple[Path | None, bool, list[ExportPlanIssue]]:
    issues: list[ExportPlanIssue] = []
    ext = f".{settings.container}"
    raw_name = (settings.filename or "").strip() or default_filename(state, settings, segments)
    name = sanitize_export_filename(raw_name, fallback=f"{state.meta.project_id}_export")
    stem = name
    lower = name.lower()
    for known in (".mp4", ".mov", ".webm", ".mkv", ".m4v"):
        if lower.endswith(known):
            stem = name[: -len(known)]
            break
    stem = stem.strip() or "export"

    if settings.output_dir and settings.output_dir.strip():
        out_dir = Path(settings.output_dir.strip()).expanduser()
        if not out_dir.is_absolute():
            issues.append(ExportPlanIssue(code="OUTPUT_DIR_NOT_ABSOLUTE", severity="error", field="output_dir", message="Output folder must be an absolute path."))
            return None, False, issues
        out_dir = out_dir.resolve()
    else:
        out_dir = (project_dir / "exports").resolve()

    renders_root = (project_dir / "renders").resolve()
    if out_dir == renders_root or renders_root in out_dir.parents:
        issues.append(ExportPlanIssue(code="OUTPUT_DIR_IN_TEMP", severity="error", field="output_dir", message="Output folder cannot be inside the temporary renders folder (it is cleaned automatically)."))
        return None, False, issues

    if out_dir.exists():
        if not out_dir.is_dir():
            issues.append(ExportPlanIssue(code="OUTPUT_DIR_NOT_DIR", severity="error", field="output_dir", message=f"Output path exists and is not a folder: {out_dir}"))
            return None, False, issues
        if not os.access(out_dir, os.W_OK):
            issues.append(ExportPlanIssue(code="OUTPUT_DIR_NOT_WRITABLE", severity="error", field="output_dir", message=f"Output folder is not writable: {out_dir}"))
            return None, False, issues
    else:
        parent = next((p for p in out_dir.parents if p.exists()), None)
        if parent is None or not os.access(parent, os.W_OK):
            issues.append(ExportPlanIssue(code="OUTPUT_DIR_UNCREATABLE", severity="error", field="output_dir", message=f"Output folder does not exist and cannot be created: {out_dir}"))
            return None, False, issues
        issues.append(ExportPlanIssue(code="OUTPUT_DIR_WILL_CREATE", severity="info", field="output_dir", message=f"Output folder will be created: {out_dir}"))

    candidate = out_dir / f"{stem}{ext}"
    collided = candidate.exists() or str(candidate) in reserved_paths
    if collided:
        policy = settings.collision_policy
        if policy == "fail":
            issues.append(ExportPlanIssue(code="OUTPUT_EXISTS", severity="error", field="filename", message=f"A file named '{candidate.name}' already exists (or is reserved by a queued job)."))
            return candidate, True, issues
        if policy == "overwrite":
            if str(candidate) in reserved_paths:
                issues.append(ExportPlanIssue(code="OUTPUT_RESERVED", severity="error", field="filename", message=f"'{candidate.name}' is the output of another queued job; choose a different name."))
            else:
                issues.append(ExportPlanIssue(code="OUTPUT_WILL_OVERWRITE", severity="warning", field="filename", message=f"Existing file '{candidate.name}' will be replaced after the new export is validated."))
            return candidate, True, issues
        candidate = next_free_path(out_dir, stem, ext, reserved_paths)
        issues.append(ExportPlanIssue(code="OUTPUT_RENAMED", severity="info", field="filename", message=f"'{stem}{ext}' already exists; the export will be saved as '{candidate.name}'."))
    return candidate, collided, issues


def next_free_path(out_dir: Path, stem: str, ext: str, reserved_paths: set[str] | None = None) -> Path:
    reserved = reserved_paths or set()
    for i in range(1, 10000):
        p = out_dir / f"{stem} ({i}){ext}"
        if not p.exists() and str(p) not in reserved:
            return p
    raise RuntimeError("Could not find a free output filename")


# ---------------------------------------------------------------------------
# Full plan
# ---------------------------------------------------------------------------


def normalize_dimensions(settings: ExportSettings, state: ProjectState) -> ExportSettings:
    if settings.resolution_preset == "project":
        w, h = state.meta.width, state.meta.height
    elif settings.resolution_preset in RESOLUTION_PRESETS:
        w, h = RESOLUTION_PRESETS[settings.resolution_preset]
    else:
        w, h = settings.width, settings.height
    return settings.model_copy(update={"width": int(w), "height": int(h)})


def build_export_plan(
    *,
    state: ProjectState,
    settings: ExportSettings,
    caps: FFmpegCapabilities,
    project_dir: Path,
    reserved_paths: set[str],
    pixi_connected: bool,
) -> ExportPlan:
    settings = normalize_dimensions(settings, state)
    issues: list[ExportPlanIssue] = []
    w, h, fps = settings.width, settings.height, settings.fps

    if not caps.available:
        issues.append(ExportPlanIssue(code="FFMPEG_MISSING", severity="error", field=None, message="FFmpeg/FFprobe is not available. " + " ".join(caps.problems)))

    if not (MIN_DIMENSION <= w <= MAX_DIMENSION) or not (MIN_DIMENSION <= h <= MAX_DIMENSION):
        issues.append(ExportPlanIssue(code="RESOLUTION_OUT_OF_RANGE", severity="error", field="width", message=f"Resolution must be between {MIN_DIMENSION} and {MAX_DIMENSION} px per side (got {w}×{h})."))
    if not (MIN_FPS <= fps <= MAX_FPS):
        issues.append(ExportPlanIssue(code="FPS_OUT_OF_RANGE", severity="error", field="fps", message=f"Frame rate must be between {MIN_FPS} and {MAX_FPS} fps (got {fps})."))
    elif fps not in STANDARD_FPS:
        issues.append(ExportPlanIssue(code="FPS_NONSTANDARD", severity="info", field="fps", message=f"{fps} fps is non-standard; some players/platforms may resample it."))

    proj_aspect = state.meta.width / float(state.meta.height)
    out_aspect = w / float(h)
    aspect_differs = abs(proj_aspect - out_aspect) > 0.01
    if aspect_differs:
        mode_desc = {
            "fit": "letterboxed/pillarboxed (whole stage visible)",
            "fill": "cropped to fill the frame",
            "stretch": "stretched (distorts the image)",
        }[settings.aspect_mode]
        issues.append(ExportPlanIssue(
            code="ASPECT_DIFFERS",
            severity="warning" if settings.aspect_mode == "stretch" else "info",
            field="aspect_mode",
            message=f"Output aspect {w}×{h} differs from the project stage {state.meta.width}×{state.meta.height}; the image will be {mode_desc}.",
        ))
    if w * h > state.meta.width * state.meta.height * 1.05:
        issues.append(ExportPlanIssue(code="UPSCALED", severity="info", field="width", message="Output is larger than the project stage; bitmap assets are upscaled."))

    segments, scope_issues = resolve_segments(state, settings)
    issues.extend(scope_issues)
    total_frames = sum(s.frame_count for s in segments)
    duration_ms = total_frames * 1000.0 / fps if fps else 0.0
    if not state.scenes:
        issues.append(ExportPlanIssue(code="NO_SCENES", severity="warning", field="scope", message="The project has no scenes; the video will only contain the background color."))

    encoder, enc_issues = (None, [])
    if caps.available:
        encoder, enc_issues = resolve_encoder(settings, caps, w, h)
    issues.extend(enc_issues)

    # Renderer selection
    renderer = "software_compositor"
    if settings.render_mode == "pixi_stream":
        if not pixi_connected:
            issues.append(ExportPlanIssue(code="PIXI_NOT_CONNECTED", severity="error", field="render_mode", message="The PixiJS WebGL render worker is not connected."))
        elif aspect_differs and settings.aspect_mode != "stretch":
            issues.append(ExportPlanIssue(code="PIXI_ASPECT_UNSUPPORTED", severity="error", field="render_mode", message="The PixiJS stream renderer cannot letterbox/crop; use Auto or Software Compositor for a different aspect ratio."))
        else:
            renderer = "pixi_stream"
    elif settings.render_mode == "auto" and pixi_connected and not aspect_differs:
        renderer = "pixi_stream"

    # Subtitles
    sub_mode = settings.subtitles.mode
    cues = retime_subtitles(state.subtitles.segments, segments) if segments else []
    if sub_mode == "soft" and settings.container not in CONTAINER_SOFT_SUBS:
        issues.append(ExportPlanIssue(code="SOFT_SUBS_UNSUPPORTED", severity="error", field="subtitles.mode", message=f"Soft (selectable) subtitles are not supported in .{settings.container}. Use burn-in or an external SRT."))
    if (sub_mode != "none" or settings.subtitles.export_srt) and not cues:
        issues.append(ExportPlanIssue(code="NO_SUBTITLES_IN_SCOPE", severity="warning", field="subtitles.mode", message="No enabled subtitle cues fall inside the export scope; no subtitles will be written."))

    # Audio
    audio_expected = settings.audio.enabled
    if audio_expected and segments:
        audible = _audible_event_count(state, segments)
        if audible == 0:
            issues.append(ExportPlanIssue(code="NO_AUDIO_IN_SCOPE", severity="warning", field="audio", message="No audible clips fall inside the export scope; a silent audio track will be written."))
    if not settings.audio.enabled:
        issues.append(ExportPlanIssue(code="AUDIO_DISABLED", severity="info", field="audio", message="Audio is disabled; the video will have no audio stream."))

    # Output path
    out_path, collided, out_issues = resolve_output_path(
        state=state, settings=settings, segments=segments, project_dir=project_dir, reserved_paths=reserved_paths
    )
    issues.extend(out_issues)

    if total_frames > 0 and w * h >= 3840 * 2160 and settings.quality == "maximum":
        issues.append(ExportPlanIssue(code="HEAVY_RENDER", severity="info", field="quality", message="4K at Maximum quality is slow and produces large files."))

    valid = not any(i.severity == "error" for i in issues) and total_frames > 0
    return ExportPlan(
        valid=valid,
        issues=issues,
        settings=settings,
        segments=segments,
        total_frames=total_frames,
        duration_ms=duration_ms,
        output_path=str(out_path) if out_path else None,
        output_path_collision=collided,
        encoder=encoder,
        renderer=renderer,
        audio_expected=audio_expected,
        subtitle_cue_count=len(cues),
    )


def _audible_event_count(state: ProjectState, segments: list[ExportSegment]) -> int:
    tracks = {t.track_id: t for t in state.timeline.tracks}
    solo = {t.track_id for t in state.timeline.tracks if t.solo and t.track_type in ("sfx", "voice", "ambient", "bgm")}
    count = 0
    for ev in state.timeline.sound_events:
        tr = tracks.get(ev.track_id)
        if tr and (tr.muted or (solo and tr.track_id not in solo)):
            continue
        if ev.volume <= 0:
            continue
        for seg in segments:
            if ev.start_ms < seg.source_start_ms + seg.duration_ms and ev.end_ms > seg.source_start_ms:
                count += 1
                break
    return count
