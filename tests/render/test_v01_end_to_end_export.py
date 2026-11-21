"""End-to-end Version 0.1 Acceptance Test (Render & MP4 Export Verification).

Proves the complete Master Prompt Section 10 & Spec v2.0 Section 9 workflow:
Import PNG -> Assemble Cutout Character -> Place on Scene -> Change Expression
-> Keyframe & Procedural Motion + Camera Zoom/Pan -> Import & Place SFX
-> Save & Reopen -> Pre-flight QC -> Chunked Export 30s MP4 -> Verify Video/Audio
Streams & Actual Frame Motion via FFprobe/FFmpeg -> Verify Chunk Resume!
"""

from __future__ import annotations

import asyncio
import io
import subprocess
from pathlib import Path
import pytest
from PIL import Image, ImageChops, ImageDraw

from app.config import AppConfig
from app.dependencies import build_services
from conftest import make_test_wav
from schemas.character import CharacterCreateRequest, CharacterPartSlot, ExpressionPreset
from schemas.common import CameraState, Transform2D
from schemas.job import ExportRequest
from schemas.project import ProjectCreateRequest
from schemas.scene import Scene, SceneCharacterInstance
from schemas.sound import SoundLicense
from schemas.timeline import (
    CharacterAnimationClip,
    Keyframe,
    ProceduralAnimationConfig,
    SoundEffectEvent,
    TimelineTrack,
)
from utils.ffmpeg import FFmpegLocator, ffprobe_json


def _draw_png(width: int, height: int, draw_fn) -> bytes:
    img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw_fn(draw, width, height)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _create_comic_art_assets(services):
    bg1 = services.asset_service.import_image_bytes(
        data=_draw_png(
            1280,
            720,
            lambda d, w, h: (
                d.rectangle([0, 0, w, h], fill=(28, 36, 56, 255)),
                d.rectangle([0, h - 180, w, h], fill=(52, 58, 72, 255)),
                d.rectangle([120, 90, 420, 320], fill=(120, 175, 225, 255), outline=(220, 230, 240, 255), width=6),
            ),
        ),
        original_filename="classroom_bg.png",
        name="Classroom Background",
        asset_type="background",
        folder="locations",
    )
    bg2 = services.asset_service.import_image_bytes(
        data=_draw_png(
            1280,
            720,
            lambda d, w, h: (
                d.rectangle([0, 0, w, h], fill=(56, 32, 46, 255)),
                d.rectangle([0, h - 180, w, h], fill=(70, 52, 58, 255)),
                d.ellipse([900, 70, 1080, 250], fill=(245, 195, 95, 255)),
            ),
        ),
        original_filename="sunset_hall_bg.png",
        name="Sunset Hallway",
        asset_type="background",
        folder="locations",
    )
    body = services.asset_service.import_image_bytes(
        data=_draw_png(
            180,
            240,
            lambda d, w, h: d.rounded_rectangle([20, 10, w - 20, h - 10], radius=32, fill=(52, 118, 219, 255), outline=(255, 255, 255, 255), width=4),
        ),
        original_filename="hero_body.png",
        name="Hero Body",
        asset_type="character_part",
        part_role="body",
        folder="hero",
    )
    head = services.asset_service.import_image_bytes(
        data=_draw_png(
            160,
            160,
            lambda d, w, h: d.ellipse([10, 10, w - 10, h - 10], fill=(246, 206, 174, 255), outline=(60, 40, 30, 255), width=4),
        ),
        original_filename="hero_head.png",
        name="Hero Head",
        asset_type="character_part",
        part_role="head",
        folder="hero",
    )
    eyes_open = services.asset_service.import_image_bytes(
        data=_draw_png(
            100,
            40,
            lambda d, w, h: (
                d.ellipse([10, 6, 36, 34], fill=(20, 22, 28, 255)),
                d.ellipse([64, 6, 90, 34], fill=(20, 22, 28, 255)),
            ),
        ),
        original_filename="eyes_open.png",
        name="Eyes Open",
        asset_type="character_part",
        part_role="eyes",
        folder="hero",
    )
    eyes_closed = services.asset_service.import_image_bytes(
        data=_draw_png(
            100,
            40,
            lambda d, w, h: (
                d.line([10, 20, 38, 20], fill=(20, 22, 28, 255), width=5),
                d.line([62, 20, 90, 20], fill=(20, 22, 28, 255), width=5),
            ),
        ),
        original_filename="eyes_closed.png",
        name="Eyes Closed",
        asset_type="character_part",
        part_role="eyes",
        folder="hero",
    )
    mouth_closed = services.asset_service.import_image_bytes(
        data=_draw_png(
            80,
            36,
            lambda d, w, h: d.line([16, 18, 64, 18], fill=(165, 55, 65, 255), width=5),
        ),
        original_filename="mouth_closed.png",
        name="Mouth Closed",
        asset_type="character_part",
        part_role="mouth",
        folder="hero",
    )
    mouth_smile = services.asset_service.import_image_bytes(
        data=_draw_png(
            80,
            36,
            lambda d, w, h: d.arc([12, 2, 68, 32], start=10, end=170, fill=(210, 50, 75, 255), width=6),
        ),
        original_filename="mouth_smile.png",
        name="Mouth Smile",
        asset_type="character_part",
        part_role="mouth",
        folder="hero",
    )
    return {
        "bg1": bg1,
        "bg2": bg2,
        "body": body,
        "head": head,
        "eyes_open": eyes_open,
        "eyes_closed": eyes_closed,
        "mouth_closed": mouth_closed,
        "mouth_smile": mouth_smile,
    }


def _extract_frame_image(ffmpeg: str, mp4_path: Path, time_sec: float, out_png: Path) -> Image.Image:
    proc = subprocess.run(
        [
            ffmpeg,
            "-y",
            "-v",
            "error",
            "-ss",
            f"{time_sec:.2f}",
            "-i",
            str(mp4_path),
            "-frames:v",
            "1",
            str(out_png),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, f"Failed extracting frame at {time_sec}s: {proc.stderr}"
    return Image.open(out_png).convert("RGB")


@pytest.mark.asyncio
async def test_v01_30s_animated_mp4_export_and_resume(tmp_path: Path):
    cfg = AppConfig(workspace_dir=tmp_path / "workspace")
    ffmpeg = FFmpegLocator.find_ffmpeg(cfg)
    ffprobe = FFmpegLocator.find_ffprobe(cfg)
    if not ffmpeg or not ffprobe:
        pytest.skip("FFmpeg/FFprobe not installed in this environment")

    services = build_services(cfg)

    # 1. Import multi-part PNGs
    art = _create_comic_art_assets(services)

    # 2. Assemble cutout character with hierarchy & expressions
    hero = services.asset_service.create_character(
        CharacterCreateRequest(
            name="Minh Hero",
            identity_confirmed=True,
            parts=[
                CharacterPartSlot(
                    slot_id="slot_body",
                    name="Body",
                    part_role="body",
                    parent_slot_id=None,
                    default_asset_id=art["body"].asset_id,
                    z_index=10,
                    anchor_x=0.5,
                    anchor_y=0.8,
                ),
                CharacterPartSlot(
                    slot_id="slot_head",
                    name="Head",
                    part_role="head",
                    parent_slot_id="slot_body",
                    default_asset_id=art["head"].asset_id,
                    z_index=20,
                    anchor_x=0.5,
                    anchor_y=0.85,
                    default_transform=Transform2D(x=0, y=-150),
                ),
                CharacterPartSlot(
                    slot_id="slot_eyes",
                    name="Eyes",
                    part_role="eyes",
                    parent_slot_id="slot_head",
                    default_asset_id=art["eyes_open"].asset_id,
                    variants={
                        "open": art["eyes_open"].asset_id,
                        "closed": art["eyes_closed"].asset_id,
                    },
                    z_index=30,
                    default_transform=Transform2D(x=0, y=-20),
                ),
                CharacterPartSlot(
                    slot_id="slot_mouth",
                    name="Mouth",
                    part_role="mouth",
                    parent_slot_id="slot_head",
                    default_asset_id=art["mouth_closed"].asset_id,
                    variants={
                        "closed": art["mouth_closed"].asset_id,
                        "smile": art["mouth_smile"].asset_id,
                    },
                    z_index=31,
                    default_transform=Transform2D(x=0, y=28),
                ),
            ],
            expressions=[
                ExpressionPreset(
                    expression_id="expr_neutral",
                    name="Neutral",
                    slot_variant_overrides={"slot_eyes": "open", "slot_mouth": "closed"},
                ),
                ExpressionPreset(
                    expression_id="expr_happy",
                    name="Happy",
                    slot_variant_overrides={"slot_eyes": "open", "slot_mouth": "smile"},
                ),
            ],
        )
    )

    # 3. Import 2 SFX clips with verified license
    sfx_step = services.sound_service.import_sound_bytes(
        data=make_test_wav(0.8, 320.0),
        original_filename="footsteps.wav",
        name="Footsteps Walk",
        category="footsteps",
        tags=["walk"],
        license_info=SoundLicense(source="user_imported", usage="verified"),
    )
    sfx_door = services.sound_service.import_sound_bytes(
        data=make_test_wav(0.6, 580.0),
        original_filename="door_close.wav",
        name="Door Close",
        category="doors",
        tags=["door"],
        license_info=SoundLicense(source="cc0", usage="verified"),
    )

    # 4. Create 30-second 2-scene animated project
    state = services.project_repo.create_project(
        ProjectCreateRequest(
            name="V01_Acceptance_30s",
            width=1280,
            height=720,
            fps=30,
            duration_ms=30000,
        )
    )
    pid = state.meta.project_id
    sfx_track_id = next(t.track_id for t in state.timeline.tracks if t.track_type == "sfx")
    cam_track_id = next(t.track_id for t in state.timeline.tracks if t.track_type == "camera")
    char_track_id = "trk_char_hero"

    state.timeline.tracks.append(
        TimelineTrack(
            track_id=char_track_id,
            project_id=pid,
            track_type="character",
            name="Char: Minh Hero",
            target_ref_id="inst_hero_1",
            order_index=2,
        )
    )

    scene1 = Scene(
        scene_id="scene_1",
        project_id=pid,
        order_index=0,
        name="Classroom",
        start_ms=0,
        duration_ms=15000,
        background_asset_id=art["bg1"].asset_id,
        transition_in="fade",
        transition_duration_ms=600,
        camera_default=CameraState(x=0, y=0, zoom=1.0),
        characters=[
            SceneCharacterInstance(
                instance_id="inst_hero_1",
                scene_id="scene_1",
                character_id=hero.character_id,
                display_name="Minh Hero",
                z_index=10,
                initial_transform=Transform2D(x=240, y=520),
                default_expression_id="expr_neutral",
            )
        ],
    )
    scene2 = Scene(
        scene_id="scene_2",
        project_id=pid,
        order_index=1,
        name="Sunset Hallway",
        start_ms=15000,
        duration_ms=15000,
        background_asset_id=art["bg2"].asset_id,
        transition_in="fade",
        transition_duration_ms=800,
        camera_default=CameraState(x=0, y=0, zoom=1.15),
        characters=[
            SceneCharacterInstance(
                instance_id="inst_hero_2",
                scene_id="scene_2",
                character_id=hero.character_id,
                display_name="Minh Hero",
                z_index=10,
                initial_transform=Transform2D(x=980, y=520),
                default_expression_id="expr_happy",
            )
        ],
    )
    state.scenes = [scene1, scene2]

    # Motion keyframes (character walks right, changes expression, camera zooms & pans)
    state.timeline.keyframes = [
        Keyframe(keyframe_id="kf1", track_id=char_track_id, target_type="character_instance", target_id="inst_hero_1", property="x", time_ms=0, value=240.0, easing="ease_in_out"),
        Keyframe(keyframe_id="kf2", track_id=char_track_id, target_type="character_instance", target_id="inst_hero_1", property="x", time_ms=14000, value=980.0, easing="ease_in_out"),
        Keyframe(keyframe_id="kf3", track_id=char_track_id, target_type="character_instance", target_id="inst_hero_1", property="expression_id", time_ms=7000, value="expr_happy", easing="step"),
        Keyframe(keyframe_id="kf4", track_id=cam_track_id, target_type="camera", target_id="camera", property="zoom", time_ms=0, value=1.0, easing="ease_in_out"),
        Keyframe(keyframe_id="kf5", track_id=cam_track_id, target_type="camera", target_id="camera", property="zoom", time_ms=15000, value=1.3, easing="ease_in_out"),
        Keyframe(keyframe_id="kf6", track_id=cam_track_id, target_type="camera", target_id="camera", property="x", time_ms=15000, value=60.0, easing="linear"),
        Keyframe(keyframe_id="kf7", track_id=cam_track_id, target_type="camera", target_id="camera", property="x", time_ms=28000, value=-80.0, easing="linear"),
    ]
    state.timeline.animation_clips = [
        CharacterAnimationClip(
            clip_id="aclip_1",
            track_id=char_track_id,
            instance_id="inst_hero_1",
            start_ms=0,
            end_ms=15000,
            animation_state="WALKING",
            procedural=ProceduralAnimationConfig(auto_blink=True, breathing=True, walk_bounce_px=16.0),
        )
    ]
    state.timeline.sound_events = [
        SoundEffectEvent(
            event_id="sfx_ev_1",
            track_id=sfx_track_id,
            sound_id=sfx_step.sound_id,
            start_ms=1000,
            end_ms=4000,
            volume=0.85,
            speed=1.0,
            fade_in_ms=100,
            fade_out_ms=150,
            loop=True,
            source_scene_id="scene_1",
        ),
        SoundEffectEvent(
            event_id="sfx_ev_2",
            track_id=sfx_track_id,
            sound_id=sfx_door.sound_id,
            start_ms=15200,
            end_ms=15800,
            volume=0.9,
            speed=1.0,
            fade_in_ms=20,
            fade_out_ms=80,
            loop=False,
            source_scene_id="scene_2",
        ),
    ]

    # Save & Reopen from SQLite
    services.project_repo.save_project_state(state, create_backup=True)
    reopened = services.project_repo.get_project_state(pid)
    assert len(reopened.scenes) == 2
    assert len(reopened.timeline.keyframes) == 7
    assert len(reopened.timeline.sound_events) == 2

    # 5. Pre-flight QC passes with 0 critical errors
    qc = services.qc_engine.run_preflight(reopened)
    assert qc.passed, f"QC failed unexpectedly: {qc.issues}"
    assert qc.critical_count == 0

    # 6. Execute 3-chunk 30-second MP4 Export (10s/chunk)
    job = await services.job_queue.enqueue_export(
        ExportRequest(
            project_id=pid,
            preset_id="preset_720p_preview",
            output_filename="acceptance_30s.mp4",
            chunk_duration_seconds=10,
            render_mode="software_compositor",
        )
    )
    assert len(job.chunks) == 3
    await services.job_queue.wait_for_job(job.job_id, timeout=120.0)

    final_job = services.project_repo.get_job(pid, job.job_id)
    assert final_job is not None
    assert final_job.status == "completed", f"Job failed: {final_job.error_log}"
    assert all(c.status == "completed" for c in final_job.chunks)

    mp4_path = Path(final_job.output_json["output_path"])
    assert mp4_path.is_file() and mp4_path.stat().st_size > 20_000

    # 7. Probe MP4 streams via ffprobe
    probe = ffprobe_json(ffprobe, mp4_path)
    v_streams = [s for s in probe["streams"] if s["codec_type"] == "video"]
    a_streams = [s for s in probe["streams"] if s["codec_type"] == "audio"]
    assert len(v_streams) == 1
    assert len(a_streams) == 1
    assert int(v_streams[0]["width"]) == 1280
    assert int(v_streams[0]["height"]) == 720
    duration_s = float(probe["format"]["duration"])
    assert 29.0 <= duration_s <= 31.0, f"Unexpected MP4 duration: {duration_s}"
    assert final_job.output_json["audio_peak_db"] is not None
    assert final_job.output_json["audio_peak_db"] > -35.0

    # 8. Extract sample frames & verify real non-black animated motion!
    f_early = _extract_frame_image(ffmpeg, mp4_path, 2.0, tmp_path / "f2.png")
    f_mid = _extract_frame_image(ffmpeg, mp4_path, 12.0, tmp_path / "f12.png")
    f_scene2 = _extract_frame_image(ffmpeg, mp4_path, 22.0, tmp_path / "f22.png")

    # Frames must NOT be black
    assert sum(f_early.getchannel("R").tobytes()) > 1_000_000
    # Character moved across scene 1 -> frame at 2s differs substantially from frame at 12s
    diff_motion = ImageChops.difference(f_early, f_mid).getbbox()
    assert diff_motion is not None
    mean_diff_1 = sum(ImageChops.difference(f_early, f_mid).getchannel("R").tobytes()) / (1280 * 720)
    assert mean_diff_1 > 2.5, f"Expected clear animation movement, got mean pixel diff {mean_diff_1}"
    # Scene 2 background changed -> frame at 22s differs heavily from scene 1
    mean_diff_2 = sum(ImageChops.difference(f_early, f_scene2).getchannel("R").tobytes()) / (1280 * 720)
    assert mean_diff_2 > 15.0

    # 9. Completed exports are final: temp chunks are cleaned up and a completed job cannot be
    #    "resumed" again (Phase 08 Batch 3 state machine). Chunk resume on pause/failure is
    #    covered in tests/render/test_phase08_batch3_export_pipeline.py.
    assert not Path(final_job.chunks[0].output_path).exists()
    from workers.job_queue import InvalidJobTransition

    with pytest.raises(InvalidJobTransition):
        await services.job_queue.retry_job(pid, job.job_id)
