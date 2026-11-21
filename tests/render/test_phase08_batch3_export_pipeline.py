"""Phase 08 Batch 3 — Export configuration, Render Queue, Output Validation (real FFmpeg).

Unit tests exercise the pure export planner with a synthetic FFmpeg capability set.
Integration tests render tiny real projects (320×180 / ≤3 s) through the actual pipeline and
inspect the resulting files with ffprobe / ffmpeg (pixels, frame counts, audio onset, subs).
"""

from __future__ import annotations

import asyncio
import json
import subprocess
from pathlib import Path

import pytest
from PIL import Image

from app.config import AppConfig
from app.dependencies import build_services
from conftest import make_test_wav
from core.render_engine.export_planner import (
    build_export_plan,
    build_frame_time_map,
    resolve_encoder,
    resolve_segments,
    retime_subtitles,
    sanitize_export_filename,
)
from schemas.export import ExportSettings
from schemas.job import ExportRequest
from schemas.project import ProjectCreateRequest
from schemas.scene import Scene, SceneShot
from schemas.sound import SoundLicense
from schemas.subtitle import SubtitleSegment
from schemas.timeline import SoundEffectEvent
from utils.ffmpeg import FFmpegCapabilities, FFmpegLocator
from workers.job_queue import InvalidJobTransition, JobQueueManager

FAKE_CAPS = FFmpegCapabilities(
    available=True,
    ffmpeg_path="/usr/bin/ffmpeg",
    ffprobe_path="/usr/bin/ffprobe",
    version="ffmpeg version test",
    available_h264_encoders=("libx264", "h264_videotoolbox"),
    recommended_h264_encoder="libx264",
    video_encoders=("libx264", "h264_videotoolbox", "libx265", "libvpx-vp9", "prores_ks"),
    audio_encoders=("aac", "libopus"),
    ffprobe_version="ffprobe version test",
)

RED, GREEN, BLUE = "#C81E1E", "#1EB43C", "#1E3CC8"


# --------------------------------------------------------------------------- fixtures


def _services(tmp_path: Path):
    cfg = AppConfig(workspace_dir=tmp_path / "workspace")
    if not FFmpegLocator.find_ffmpeg(cfg) or not FFmpegLocator.find_ffprobe(cfg):
        pytest.skip("FFmpeg/FFprobe not installed")
    return cfg, build_services(cfg)


def _make_project(services, *, name="Dự án Thử nghiệm", scenes=((RED, 1000), (GREEN, 1000), (BLUE, 1000)), width=640, height=360):
    state = services.project_repo.create_project(
        ProjectCreateRequest(name=name, width=width, height=height, fps=30, duration_ms=sum(d for _, d in scenes))
    )
    pid = state.meta.project_id
    cursor = 0
    state.scenes = []
    for idx, (color, dur) in enumerate(scenes):
        state.scenes.append(
            Scene(
                scene_id=f"scene_{idx + 1}",
                project_id=pid,
                order_index=idx,
                name=f"Cảnh {idx + 1}",
                start_ms=cursor,
                duration_ms=dur,
                background_color=color,
            )
        )
        cursor += dur
    state.timeline.total_duration_ms = cursor
    services.project_repo.save_project_state(state)
    return services.project_repo.get_project_state(pid)


def _settings(**kw) -> ExportSettings:
    base = {
        "resolution_preset": "custom",
        "width": 320,
        "height": 180,
        "fps": 30,
        "quality": "draft",
        "chunk_duration_seconds": 2,
        "render_mode": "software_compositor",
    }
    base.update(kw)
    return ExportSettings.model_validate(base)


def _frame_rgb(ffmpeg: str, path: Path, t: float, tmp: Path) -> tuple[int, int, int]:
    png = tmp / f"f_{t:.3f}.png"
    subprocess.run([ffmpeg, "-y", "-v", "error", "-ss", f"{t:.3f}", "-i", str(path), "-frames:v", "1", str(png)], check=True)
    img = Image.open(png).convert("RGB")
    return img.getpixel((img.width // 2, img.height // 2))


def _close(rgb, hex_color, tol=40):
    h = hex_color.lstrip("#")
    exp = tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))
    return all(abs(a - b) <= tol for a, b in zip(rgb, exp))


def _audio_onset_s(ffmpeg: str, path: Path, thresh: int = 2000) -> float | None:
    raw = subprocess.run(
        [ffmpeg, "-v", "error", "-i", str(path), "-map", "0:a:0", "-ac", "1", "-ar", "8000", "-f", "s16le", "-"],
        capture_output=True,
        check=True,
    ).stdout
    import array

    samples = array.array("h", raw)
    for i, v in enumerate(samples):
        if abs(v) > thresh:
            return i / 8000.0
    return None


async def _run(services, pid, settings: ExportSettings, start_mode="render_now", timeout=120.0):
    job = await services.job_queue.enqueue_export(ExportRequest(project_id=pid, settings=settings, start_mode=start_mode))
    if start_mode == "render_now":
        await services.job_queue.wait_for_job(job.job_id, timeout=timeout)
    return services.project_repo.get_job(pid, job.job_id)


# --------------------------------------------------------------------------- unit: planner


def test_resolution_presets_fps_and_dimension_validation(tmp_path: Path):
    cfg = AppConfig(workspace_dir=tmp_path / "ws")
    services = build_services(cfg)
    state = _make_project(services)
    pdir = cfg.project_dir(state.meta.project_id)

    for preset, dims in {"hd": (1280, 720), "fhd": (1920, 1080), "qhd": (2560, 1440), "uhd": (3840, 2160), "portrait_hd": (720, 1280), "portrait_fhd": (1080, 1920)}.items():
        plan = build_export_plan(state=state, settings=_settings(resolution_preset=preset), caps=FAKE_CAPS, project_dir=pdir, reserved_paths=set(), pixi_connected=False)
        assert (plan.settings.width, plan.settings.height) == dims, preset
        assert plan.valid, [i.message for i in plan.issues if i.severity == "error"]

    plan = build_export_plan(state=state, settings=_settings(resolution_preset="project"), caps=FAKE_CAPS, project_dir=pdir, reserved_paths=set(), pixi_connected=False)
    assert (plan.settings.width, plan.settings.height) == (640, 360)

    bad_odd = build_export_plan(state=state, settings=_settings(width=321, height=180), caps=FAKE_CAPS, project_dir=pdir, reserved_paths=set(), pixi_connected=False)
    assert not bad_odd.valid and any(i.code == "ODD_DIMENSIONS" for i in bad_odd.issues)
    bad_big = build_export_plan(state=state, settings=_settings(width=8000, height=180), caps=FAKE_CAPS, project_dir=pdir, reserved_paths=set(), pixi_connected=False)
    assert not bad_big.valid and any(i.code == "RESOLUTION_OUT_OF_RANGE" for i in bad_big.issues)
    bad_fps = build_export_plan(state=state, settings=_settings(fps=5), caps=FAKE_CAPS, project_dir=pdir, reserved_paths=set(), pixi_connected=False)
    assert not bad_fps.valid and any(i.code == "FPS_OUT_OF_RANGE" for i in bad_fps.issues)

    # FPS drives real frame generation: 3 s @24 = 72 frames, @60 = 180 frames, timestamps differ
    for fps, frames in ((24, 72), (25, 75), (30, 90), (50, 150), (60, 180)):
        p = build_export_plan(state=state, settings=_settings(fps=fps), caps=FAKE_CAPS, project_dir=pdir, reserved_paths=set(), pixi_connected=False)
        assert p.total_frames == frames
        times = build_frame_time_map(p.segments, fps)
        assert len(times) == frames and times[1] == pytest.approx(1000.0 / fps)

    # Portrait export of a landscape project reports aspect handling
    plan = build_export_plan(state=state, settings=_settings(resolution_preset="portrait_hd"), caps=FAKE_CAPS, project_dir=pdir, reserved_paths=set(), pixi_connected=False)
    assert any(i.code == "ASPECT_DIFFERS" for i in plan.issues)

    # FFmpeg missing → export is not offered as valid
    missing = FFmpegCapabilities(available=False, ffmpeg_path=None, ffprobe_path=None, version=None, available_h264_encoders=(), recommended_h264_encoder="libx264", problems=("FFmpeg executable was not found",))
    plan = build_export_plan(state=state, settings=_settings(), caps=missing, project_dir=pdir, reserved_paths=set(), pixi_connected=False)
    assert not plan.valid and any(i.code == "FFMPEG_MISSING" for i in plan.issues)


def test_scope_resolution_order_and_errors(tmp_path: Path):
    services = build_services(AppConfig(workspace_dir=tmp_path / "ws"))
    state = _make_project(services)
    state.scenes[1].shots = [
        SceneShot(shot_id="sh_b", scene_id="scene_2", shot_order=2, title="B", start_ms=500, duration_ms=500),
        SceneShot(shot_id="sh_a", scene_id="scene_2", shot_order=1, title="A", start_ms=0, duration_ms=500),
    ]

    segs, issues = resolve_segments(state, _settings())
    assert not issues and len(segs) == 1 and segs[0].frame_count == 90

    segs, issues = resolve_segments(state, _settings(scope={"kind": "scene", "scene_ids": ["scene_2"]}))
    assert not issues and segs[0].source_start_ms == 1000 and segs[0].frame_count == 30

    # Selection order does not matter: timeline order is preserved, duplicates removed
    segs, _ = resolve_segments(state, _settings(scope={"kind": "scenes", "scene_ids": ["scene_3", "scene_1", "scene_3"]}))
    assert [s.scene_id for s in segs] == ["scene_1", "scene_3"]
    assert [s.output_start_frame for s in segs] == [0, 30]

    segs, _ = resolve_segments(state, _settings(scope={"kind": "shots", "shots": [{"scene_id": "scene_2", "shot_id": "sh_b"}, {"scene_id": "scene_2", "shot_id": "sh_a"}]}))
    assert [s.shot_id for s in segs] == ["sh_a", "sh_b"]
    assert segs[1].source_start_ms == 1500

    segs, issues = resolve_segments(state, _settings(scope={"kind": "range", "range_start_ms": 500, "range_end_ms": 9000}))
    assert segs[0].source_start_ms == 500 and segs[0].frame_count == 75
    assert any(i.code == "SCOPE_RANGE_CLAMPED" for i in issues)

    for bad in (
        {"kind": "scene", "scene_ids": []},
        {"kind": "scene", "scene_ids": ["nope"]},
        {"kind": "scene", "scene_ids": ["scene_1", "scene_2"]},
        {"kind": "shot", "shots": [{"scene_id": "scene_2", "shot_id": "missing"}]},
        {"kind": "range", "range_start_ms": 2000, "range_end_ms": 1000},
        {"kind": "range", "range_start_ms": 5000, "range_end_ms": 6000},
    ):
        _, issues = resolve_segments(state, _settings(scope=bad))
        assert any(i.severity == "error" for i in issues), bad


def test_quality_presets_codecs_and_advanced_conflicts():
    def args(**kw):
        enc, issues = resolve_encoder(_settings(**kw), FAKE_CAPS, 320, 180)
        return enc, issues

    seen = set()
    for q in ("draft", "standard", "high", "maximum"):
        enc, issues = args(quality=q)
        assert enc and enc.encoder == "libx264" and not [i for i in issues if i.severity == "error"]
        seen.add(tuple(enc.args))
    assert len(seen) == 4, "every quality preset must produce different encoder settings"
    enc, _ = args(quality="maximum")
    assert "-crf" in enc.args and enc.args[enc.args.index("-crf") + 1] == "16"
    assert enc.args[enc.args.index("-preset") + 1] == "slow"

    enc, _ = args(advanced={"crf": 10, "encoder_preset": "veryslow", "keyframe_interval": 12})
    assert enc.args[enc.args.index("-crf") + 1] == "10" and "veryslow" in enc.args and enc.args[enc.args.index("-g") + 1] == "12"
    enc, _ = args(advanced={"bitrate_kbps": 2500})
    assert "-crf" not in enc.args and "2500k" in enc.args

    enc, _ = args(encoder="hardware")
    assert enc.encoder == "h264_videotoolbox" and enc.is_hardware
    hw_sizes = {args(encoder="hardware", quality=q)[0].args[args(encoder="hardware", quality=q)[0].args.index("-b:v") + 1] for q in ("draft", "standard", "high", "maximum")}
    assert len(hw_sizes) == 4
    _, issues = args(encoder="hardware", advanced={"crf": 20})
    assert any(i.code == "CRF_UNSUPPORTED" for i in issues)

    _, issues = args(video_codec="vp9", container="mp4")
    assert any(i.code == "CODEC_CONTAINER_INCOMPATIBLE" for i in issues)
    enc, issues = args(video_codec="vp9", container="webm")
    assert enc.encoder == "libvpx-vp9" and enc.audio_codec == "libopus"
    enc, _ = args(video_codec="hevc", container="mov")
    assert enc.encoder == "libx265" and "hvc1" in enc.args
    enc, _ = args(video_codec="prores", container="mov", quality="high")
    assert enc.encoder == "prores_ks" and enc.args[enc.args.index("-profile:v") + 1] == "3"

    _, issues = args(advanced={"profile": "main", "pix_fmt": "yuv444p"})
    assert any(i.code == "PROFILE_PIX_FMT_CONFLICT" for i in issues)
    _, issues = args(advanced={"pix_fmt": "rgb24"})
    assert any(i.code == "PIX_FMT_UNSUPPORTED" for i in issues)
    _, issues = args(advanced={"encoder_preset": "turbo"})
    assert any(i.code == "ENCODER_PRESET_INVALID" for i in issues)


def test_output_path_sanitizing_collisions_and_subtitle_retiming(tmp_path: Path):
    assert sanitize_export_filename("Tập 1: Mở đầu / phần*2?.mp4") == "Tập 1_ Mở đầu _ phần_2_.mp4"
    assert "/" not in sanitize_export_filename("../../etc/passwd") and ".." not in sanitize_export_filename("../../etc/passwd")[:2]
    assert sanitize_export_filename("CON.mp4").startswith("_")
    assert sanitize_export_filename("   ") == "export"

    cfg = AppConfig(workspace_dir=tmp_path / "ws")
    services = build_services(cfg)
    state = _make_project(services)
    pdir = cfg.project_dir(state.meta.project_id)
    out_dir = tmp_path / "Xuất bản video"
    out_dir.mkdir()
    (out_dir / "Tập 1.mp4").write_bytes(b"existing user file")

    def plan(**kw):
        return build_export_plan(state=state, settings=_settings(output_dir=str(out_dir), filename="Tập 1.mp4", **kw), caps=FAKE_CAPS, project_dir=pdir, reserved_paths={str(out_dir / "Tập 1 (1).mp4")}, pixi_connected=False)

    p = plan()
    assert p.valid and p.output_path.endswith("Tập 1 (2).mp4"), p.output_path  # (1) reserved by a queued job
    p = plan(collision_policy="fail")
    assert not p.valid and any(i.code == "OUTPUT_EXISTS" for i in p.issues)
    p = plan(collision_policy="overwrite")
    assert p.valid and any(i.code == "OUTPUT_WILL_OVERWRITE" for i in p.issues)
    p = plan(container="webm", video_codec="vp9")
    assert p.output_path.endswith("Tập 1.webm")
    bad = build_export_plan(state=state, settings=_settings(output_dir=str(pdir / "renders" / "x")), caps=FAKE_CAPS, project_dir=pdir, reserved_paths=set(), pixi_connected=False)
    assert any(i.code == "OUTPUT_DIR_IN_TEMP" for i in bad.issues)
    rel = build_export_plan(state=state, settings=_settings(output_dir="relative/dir"), caps=FAKE_CAPS, project_dir=pdir, reserved_paths=set(), pixi_connected=False)
    assert any(i.code == "OUTPUT_DIR_NOT_ABSOLUTE" for i in rel.issues)

    subs = [
        SubtitleSegment(subtitle_id="a", text="Xin chào", start_ms=200, end_ms=900),
        SubtitleSegment(subtitle_id="b", text="Cảnh hai", start_ms=1100, end_ms=1600),
        SubtitleSegment(subtitle_id="c", text="Tắt", start_ms=2100, end_ms=2600, enabled=False),
    ]
    segs, _ = resolve_segments(state, _settings(scope={"kind": "scenes", "scene_ids": ["scene_2", "scene_3"]}))
    cues = retime_subtitles(subs, segs)
    assert [(c.text, c.start_ms, c.end_ms) for c in cues] == [("Cảnh hai", 100, 600)]
    segs, _ = resolve_segments(state, _settings(scope={"kind": "range", "range_start_ms": 500, "range_end_ms": 1500}))
    cues = retime_subtitles(subs, segs)
    assert [(c.text, c.start_ms, c.end_ms) for c in cues] == [("Xin chào", 0, 400), ("Cảnh hai", 600, 1000)]


# --------------------------------------------------------------------------- integration: real exports


@pytest.mark.asyncio
async def test_scene_scope_fps_audio_sync_and_vietnamese_paths(tmp_path: Path):
    cfg, services = _services(tmp_path)
    ffmpeg = FFmpegLocator.find_ffmpeg(cfg)
    state = _make_project(services)
    pid = state.meta.project_id
    beep = services.sound_service.import_sound_bytes(
        data=make_test_wav(0.3, 880.0), original_filename="beep.wav", name="Beep", category="ui",
        license_info=SoundLicense(source="user_imported", usage="verified"),
    )
    sfx_track = next(t.track_id for t in state.timeline.tracks if t.track_type == "sfx")
    # Beep at 1.5 s in source = 0.5 s into scene 2
    state.timeline.sound_events.append(SoundEffectEvent(event_id="ev_beep", track_id=sfx_track, sound_id=beep.sound_id, start_ms=1500, end_ms=1800, volume=1.0))
    services.project_repo.save_project_state(state)

    out_dir = tmp_path / "Thư mục xuất có dấu cách"
    job = await _run(services, pid, _settings(fps=24, scope={"kind": "scene", "scene_ids": ["scene_2"]}, output_dir=str(out_dir), filename="Cảnh hai — bản nháp"))
    assert job.status == "completed", job.error_log
    out = Path(job.output_json["output_path"])
    assert out.parent == out_dir and out.name == "Cảnh hai — bản nháp.mp4" and out.is_file()
    v = job.output_json["validation"]
    assert v["passed"] and v["frame_count"] == 24 and v["width"] == 320 and v["height"] == 180 and v["fps"] == 24
    # Only scene 2 content (green) — scene 1 (red) must not leak in
    assert _close(_frame_rgb(ffmpeg, out, 0.05, tmp_path), GREEN)
    assert _close(_frame_rgb(ffmpeg, out, 0.95, tmp_path), GREEN)
    onset = _audio_onset_s(ffmpeg, out)
    assert onset is not None and abs(onset - 0.5) < 0.04, onset
    assert abs(v["audio_duration_s"] - 1.0) <= 0.12
    # Temp chunks cleaned, no partial file left beside the output
    assert not (cfg.project_dir(pid) / "renders" / job.job_id).exists()
    assert not [p for p in out_dir.iterdir() if ".partial" in p.name]

    # Re-export same name → never overwrites, auto-numbered
    job2 = await _run(services, pid, _settings(fps=24, scope={"kind": "scene", "scene_ids": ["scene_2"]}, output_dir=str(out_dir), filename="Cảnh hai — bản nháp"))
    assert job2.status == "completed" and Path(job2.output_json["output_path"]).name == "Cảnh hai — bản nháp (1).mp4"
    assert out.is_file()


@pytest.mark.asyncio
async def test_multi_shot_order_range_subtitles_and_formats(tmp_path: Path):
    cfg, services = _services(tmp_path)
    ffmpeg = FFmpegLocator.find_ffmpeg(cfg)
    state = _make_project(services)
    pid = state.meta.project_id
    state.scenes[0].shots = [SceneShot(shot_id="s1a", scene_id="scene_1", shot_order=1, title="Mở", start_ms=0, duration_ms=1000)]
    state.scenes[2].shots = [SceneShot(shot_id="s3a", scene_id="scene_3", shot_order=1, title="Kết", start_ms=0, duration_ms=1000)]
    state.subtitles.segments = [
        SubtitleSegment(subtitle_id="sub1", text="Xin chào các bạn! Tiếng Việt có dấu.", start_ms=100, end_ms=900),
        SubtitleSegment(subtitle_id="sub3", text="Hẹn gặp lại", start_ms=2100, end_ms=2900),
    ]
    services.project_repo.save_project_state(state)

    # Shots selected in reverse order → rendered in timeline order (red then blue)
    job = await _run(services, pid, _settings(scope={"kind": "shots", "shots": [{"scene_id": "scene_3", "shot_id": "s3a"}, {"scene_id": "scene_1", "shot_id": "s1a"}]}, subtitles={"mode": "soft", "export_srt": True}))
    assert job.status == "completed", job.error_log
    out = Path(job.output_json["output_path"])
    assert _close(_frame_rgb(ffmpeg, out, 0.5, tmp_path), RED) and _close(_frame_rgb(ffmpeg, out, 1.5, tmp_path), BLUE)
    assert job.output_json["validation"]["frame_count"] == 60 and job.output_json["subtitle_soft_muxed"]
    srt = Path(job.output_json["subtitle_sidecar_path"]).read_text(encoding="utf-8")
    assert "Xin chào các bạn! Tiếng Việt có dấu." in srt and "00:00:01,100 --> 00:00:01,900" in srt

    # Burn-in: subtitle pixels present during the cue, absent outside it
    job_b = await _run(services, pid, _settings(scope={"kind": "range", "range_start_ms": 0, "range_end_ms": 1000}, subtitles={"mode": "burn_in"}, filename="burn"))
    assert job_b.status == "completed", job_b.error_log
    png = tmp_path / "burn.png"
    out_b = Path(job_b.output_json["output_path"])
    subprocess.run([ffmpeg, "-y", "-v", "error", "-ss", "0.5", "-i", str(out_b), "-frames:v", "1", str(png)], check=True)
    img = Image.open(png).convert("RGB")
    lower = img.crop((0, int(img.height * 0.6), img.width, img.height))
    bright = sum(1 for px in list(lower.getdata()) if sum(px) > 600)
    assert bright > 30, "burned-in white subtitle text expected in the lower third"
    subprocess.run([ffmpeg, "-y", "-v", "error", "-ss", "0.95", "-i", str(out_b), "-frames:v", "1", str(png)], check=True)
    lower2 = Image.open(png).convert("RGB").crop((0, int(img.height * 0.6), img.width, img.height))
    assert sum(1 for px in list(lower2.getdata()) if sum(px) > 600) < bright / 4

    # WebM/VP9 + Opus, HEVC/MOV, ProRes/MOV (only those available in this FFmpeg build)
    env = services.render_orchestrator.plan_export(state, _settings(), set())
    assert env.valid
    caps_ok = {c.codec for c in __import__("core.render_engine.export_planner", fromlist=["codec_capabilities"]).codec_capabilities(__import__("utils.ffmpeg", fromlist=["probe_ffmpeg_capabilities"]).probe_ffmpeg_capabilities(cfg)) if c.available}
    for codec, container, exp_audio in (("vp9", "webm", "opus"), ("hevc", "mov", "aac"), ("prores", "mov", "aac")):
        if codec not in caps_ok:
            continue
        j = await _run(services, pid, _settings(video_codec=codec, container=container, scope={"kind": "scene", "scene_ids": ["scene_3"]}, filename=f"fmt_{codec}"))
        assert j.status == "completed", (codec, j.error_log)
        v = j.output_json["validation"]
        assert v["video_codec"] == codec and v["audio_codec"] == exp_audio and v["frame_count"] == 30
        assert _close(_frame_rgb(ffmpeg, Path(j.output_json["output_path"]), 0.5, tmp_path), BLUE)


@pytest.mark.asyncio
async def test_portrait_fit_letterbox_and_quality_presets_differ(tmp_path: Path):
    cfg, services = _services(tmp_path)
    ffmpeg = FFmpegLocator.find_ffmpeg(cfg)
    state = _make_project(services, scenes=((RED, 1000),))
    pid = state.meta.project_id
    job = await _run(services, pid, _settings(width=180, height=320, aspect_mode="fit"))
    assert job.status == "completed", job.error_log
    png = tmp_path / "p.png"
    subprocess.run([ffmpeg, "-y", "-v", "error", "-ss", "0.5", "-i", job.output_json["output_path"], "-frames:v", "1", str(png)], check=True)
    img = Image.open(png).convert("RGB")
    assert img.size == (180, 320)
    assert sum(img.getpixel((90, 10))) < 60  # letterbox bar (black), not stretched red
    assert _close(img.getpixel((90, 160)), RED)

    # Draft vs Maximum: genuinely different encodes → measurably different quality (PSNR vs a
    # lossless CRF 0 reference of the very same frames)
    bars = services.asset_service.import_image_bytes(
        data=_noise_png(), original_filename="noise.png", name="Noise", asset_type="background", folder="locations"
    )
    st = services.project_repo.get_project_state(pid)
    st.scenes[0].background_asset_id = bars.asset_id
    services.project_repo.save_project_state(st)
    outs = {}
    for q, adv in (("draft", {}), ("maximum", {}), ("ref", {"crf": 0})):
        j = await _run(services, pid, _settings(quality="draft" if q == "ref" else q, advanced=adv, filename=f"q_{q}", audio={"enabled": False}))
        assert j.status == "completed", j.error_log
        assert j.output_json["audio_codec"] is None and j.output_json["validation"]["passed"]
        outs[q] = j.output_json["output_path"]

    def psnr(a: str, b: str) -> float:
        err = subprocess.run([ffmpeg, "-hide_banner", "-i", a, "-i", b, "-lavfi", "psnr", "-f", "null", "-"], capture_output=True, text=True).stderr
        return float(err.split("average:")[1].split()[0])

    p_draft, p_max = psnr(outs["draft"], outs["ref"]), psnr(outs["maximum"], outs["ref"])
    assert p_max > p_draft + 3.0, (p_draft, p_max)


def _noise_png() -> bytes:
    import io
    import random

    rnd = random.Random(7)
    img = Image.new("RGB", (320, 180))
    img.putdata([(rnd.randint(0, 255), rnd.randint(0, 255), rnd.randint(0, 255)) for _ in range(320 * 180)])
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


@pytest.mark.asyncio
async def test_queue_order_pause_resume_cancel_retry_remove_and_recovery(tmp_path: Path, monkeypatch):
    cfg, services = _services(tmp_path)
    import time as _time

    from core.render_engine.software_compositor import SoftwareCompositor

    real_render = SoftwareCompositor.render_time_rgba

    def slow_render(self, t):  # ~10 ms/frame so pause/cancel always land mid-render
        _time.sleep(0.01)
        return real_render(self, t)

    monkeypatch.setattr(SoftwareCompositor, "render_time_rgba", slow_render)
    state = _make_project(services, scenes=((RED, 3000), (GREEN, 3000)))
    pid = state.meta.project_id
    q = services.job_queue

    # Add to queue without starting: nothing renders
    a = await q.enqueue_export(ExportRequest(project_id=pid, settings=_settings(filename="A"), start_mode="queue"))
    b = await q.enqueue_export(ExportRequest(project_id=pid, settings=_settings(filename="B", scope={"kind": "scene", "scene_ids": ["scene_2"]}), start_mode="queue"))
    c = await q.enqueue_export(ExportRequest(project_id=pid, settings=_settings(filename="C", scope={"kind": "scene", "scene_ids": ["scene_1"]}), start_mode="queue"))
    await asyncio.sleep(0.3)
    assert {services.project_repo.get_job(pid, j.job_id).status for j in (a, b, c)} == {"queued"}
    assert not q.queue_running

    # Invalid transitions are rejected
    with pytest.raises(InvalidJobTransition):
        await q.retry_job(pid, a.job_id)
    with pytest.raises(InvalidJobTransition):
        await q.skip_job(pid, a.job_id)

    # Reorder: C up twice → first; remove B (pending) → its temp dir is gone
    await q.move_job(pid, c.job_id, "up")
    await q.move_job(pid, c.job_id, "up")
    assert await q.remove_job(pid, b.job_id)
    assert services.project_repo.get_job(pid, b.job_id) is None
    assert not (cfg.project_dir(pid) / "renders" / b.job_id).exists()

    await q.start_queue()
    await q.wait_for_job(c.job_id, timeout=60)
    assert services.project_repo.get_job(pid, c.job_id).status == "completed"

    # A is running now: pause after the first chunk completes
    for _ in range(400):
        ja = services.project_repo.get_job(pid, a.job_id)
        if any(ch.status == "completed" for ch in ja.chunks):
            break
        await asyncio.sleep(0.05)
    paused = await q.pause_job(pid, a.job_id)
    assert paused.status == "paused", paused.message
    first_chunk = Path(paused.chunks[0].output_path)
    assert paused.chunks[0].status == "completed" and first_chunk.is_file()
    mtime = first_chunk.stat().st_mtime_ns
    assert not q.queue_running  # pausing the running job pauses the queue
    assert not any(".partial" in p.name for p in (cfg.project_dir(pid) / "exports").iterdir())

    resumed = await q.resume_job(pid, a.job_id)
    assert resumed.status in ("queued", "preparing", "rendering")
    # cancel while rendering → cancelled, no output, chunk 0 kept for retry
    for _ in range(200):
        if q.is_active(a.job_id) and services.project_repo.get_job(pid, a.job_id).status == "rendering":
            break
        await asyncio.sleep(0.05)
    await asyncio.sleep(0.3)
    cancelled = await q.cancel_job(pid, a.job_id)
    assert cancelled.status == "cancelled", cancelled.status
    assert not cancelled.output_json or "output_path" not in cancelled.output_json
    assert first_chunk.stat().st_mtime_ns == mtime  # resumed run did not re-render chunk 0
    assert not any(".partial" in p.name for p in (cfg.project_dir(pid) / "exports").iterdir())
    retried = await q.retry_job(pid, a.job_id)
    assert retried.retry_count == 1
    await q.wait_for_job(a.job_id, timeout=60)
    assert first_chunk.exists() is False  # temp cleaned after success
    done = services.project_repo.get_job(pid, a.job_id)
    assert done.status == "completed", done.error_log
    assert done.output_json["validation"]["frame_count"] == 180

    # Removing a history entry never deletes the exported video
    out_c = Path(services.project_repo.get_job(pid, c.job_id).output_json["output_path"])
    assert await q.remove_job(pid, c.job_id)
    assert out_c.is_file()

    # Restart recovery: an interrupted active job is marked failed (not re-run); queued jobs wait
    d = await q.enqueue_export(ExportRequest(project_id=pid, settings=_settings(filename="D"), start_mode="queue"))
    e = await q.enqueue_export(ExportRequest(project_id=pid, settings=_settings(filename="E"), start_mode="queue"))
    jd = services.project_repo.get_job(pid, d.job_id)
    services.project_repo.save_job(jd.model_copy(update={"status": "rendering"}))
    fresh = JobQueueManager(services.project_repo, services.render_orchestrator)
    summary = fresh.recover_on_startup()
    assert summary == {"interrupted": 1, "waiting": 1}
    jd2 = services.project_repo.get_job(pid, d.job_id)
    assert jd2.status == "failed" and "Interrupted" in (jd2.error_log or "")
    assert services.project_repo.get_job(pid, e.job_id).status == "queued" and not fresh.queue_running
    # A second recovery must not create duplicates or change anything
    assert fresh.recover_on_startup()["interrupted"] == 0
    assert len([j for j in services.project_repo.list_jobs(pid) if j.job_id in (d.job_id, e.job_id)]) == 2


@pytest.mark.asyncio
async def test_failed_validation_is_never_marked_completed(tmp_path: Path, monkeypatch):
    cfg, services = _services(tmp_path)
    state = _make_project(services, scenes=((RED, 1000),))
    pid = state.meta.project_id
    import core.render_engine.orchestrator as orch

    real = orch.validate_output_file

    async def wrong_expectation(**kw):
        kw["expected_frames"] = kw["expected_frames"] + 5  # simulate dropped frames
        return await real(**kw)

    monkeypatch.setattr(orch, "validate_output_file", wrong_expectation)
    out_dir = tmp_path / "out"
    job = await _run(services, pid, _settings(output_dir=str(out_dir), filename="bad"))
    assert job.status == "failed"
    assert "frame_count" in (job.error_log or "")
    assert not (out_dir / "bad.mp4").exists(), "invalid output must never appear at the final path"
    assert Path(job.output_json["failed_output_path"]).is_file()  # kept for inspection
    assert job.output_json["validation"]["passed"] is False

    # Retry after the problem is fixed → completes and reuses the rendered chunks
    monkeypatch.setattr(orch, "validate_output_file", real)
    chunk_mtime = Path(job.chunks[0].output_path).stat().st_mtime_ns
    await services.job_queue.retry_job(pid, job.job_id)
    await services.job_queue.wait_for_job(job.job_id, timeout=60)
    done = services.project_repo.get_job(pid, job.job_id)
    assert done.status == "completed" and (out_dir / "bad.mp4").is_file()
    assert chunk_mtime  # chunk existed before retry


def test_render_api_validate_environment_history_and_output(tmp_path: Path):
    import time

    from fastapi.testclient import TestClient

    from app.main import create_app

    cfg = AppConfig(workspace_dir=tmp_path / "ws", auth_token="tok")
    if not FFmpegLocator.find_ffmpeg(cfg):
        pytest.skip("FFmpeg not installed")
    app = create_app(cfg)
    h = {"x-amcs-token": "tok"}
    with TestClient(app) as client:
        services = app.state.services
        state = _make_project(services, scenes=((RED, 1000),))
        pid = state.meta.project_id

        env = client.get("/api/v1/render/environment", headers=h).json()
        assert env["available"] and "libx264" in env["encoders"] and "mp4" in env["containers"]
        test = client.post("/api/v1/render/environment/test", headers=h).json()
        assert test["ffmpeg_ok"] and test["ffprobe_ok"] and test["encoder_results"].get("libx264") is True
        bad = client.put("/api/v1/render/environment/config", headers=h, json={"ffmpeg_path": "/nonexistent/ffmpeg"})
        assert bad.status_code == 422

        body = {"project_id": pid, "settings": json.loads(_settings(filename="api export").model_dump_json())}
        plan = client.post("/api/v1/render/validate", headers=h, json=body).json()
        assert plan["valid"] and plan["total_frames"] == 30 and plan["output_path"].endswith("api export.mp4")
        invalid = dict(body, settings={**body["settings"], "width": 333})
        r = client.post("/api/v1/render/export", headers=h, json=invalid)
        assert r.status_code == 422 and r.json()["detail"]["plan"]["valid"] is False

        job = client.post("/api/v1/render/export", headers=h, json=body).json()
        for _ in range(300):
            cur = client.get(f"/api/v1/jobs/{pid}/{job['job_id']}", headers=h).json()
            if cur["status"] in ("completed", "failed", "cancelled"):
                break
            time.sleep(0.1)
        assert cur["status"] == "completed", cur.get("error_log")
        assert cur["progress"]["frames_done"] == 30 and cur["output_json"]["validation"]["passed"]
        vid = client.get(f"/api/v1/jobs/{pid}/{job['job_id']}/output?token=tok")
        assert vid.status_code == 200 and vid.headers["content-type"] == "video/mp4" and len(vid.content) == cur["output_json"]["file_size_bytes"]
        assert "Export completed" in client.get(f"/api/v1/jobs/{pid}/{job['job_id']}/log", headers=h).text
        assert client.post(f"/api/v1/jobs/{pid}/{job['job_id']}/pause", headers=h).status_code == 409

        re = client.post(f"/api/v1/jobs/{pid}/{job['job_id']}/reexport", headers=h).json()
        assert re["status"] == "queued" and re["input_json"]["output_path"].endswith("api export (1).mp4")
        assert client.delete(f"/api/v1/jobs/{pid}/{re['job_id']}", headers=h).json()["removed"] is True
        rm = client.delete(f"/api/v1/jobs/{pid}/{job['job_id']}", headers=h).json()
        assert rm == {"removed": True, "output_file_deleted": False}
        assert Path(cur["output_json"]["output_path"]).is_file()


@pytest.mark.asyncio
async def test_loudness_normalization_hits_target_without_touching_source(tmp_path: Path):
    cfg, services = _services(tmp_path)
    state = _make_project(services, scenes=((RED, 2000),))
    pid = state.meta.project_id
    snd = services.sound_service.import_sound_bytes(
        data=make_test_wav(0.5, 440.0), original_filename="quiet.wav", name="Quiet", category="ui",
        license_info=SoundLicense(source="user_imported", usage="verified"),
    )
    src_file = services.sound_service.resolve_sound_file(snd)
    src_bytes = src_file.read_bytes()
    sfx = next(t.track_id for t in state.timeline.tracks if t.track_type == "sfx")
    state.timeline.sound_events.append(SoundEffectEvent(event_id="q", track_id=sfx, sound_id=snd.sound_id, start_ms=200, end_ms=700, volume=0.15))
    services.project_repo.save_project_state(state)

    plain = await _run(services, pid, _settings(filename="plain"))
    assert plain.status == "completed" and plain.output_json["audio_loudness_lufs"] < -24
    assert any(w["code"] == "AUDIO_TOO_QUIET" for w in plain.output_json["warnings"]) is (plain.output_json["audio_loudness_lufs"] < -30)
    for target in (-16.0, -23.0):
        job = await _run(services, pid, _settings(filename=f"norm{target}", audio={"enabled": True, "normalize_loudness": True, "target_lufs": target}))
        assert job.status == "completed", job.error_log
        assert abs(job.output_json["audio_loudness_lufs"] - target) <= 0.5, job.output_json["audio_loudness_lufs"]
        assert job.output_json["audio_peak_db"] <= -0.9  # limiter ceiling respected
    assert src_file.read_bytes() == src_bytes  # source audio never modified
