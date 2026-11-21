"""Unit tests for AutoMotion Comic Studio backend core engines."""

from __future__ import annotations

import io
import math
import struct
import wave
from pathlib import Path
import pytest
from PIL import Image

from app.config import AppConfig
from app.dependencies import build_services
from schemas.character import CharacterCreateRequest, CharacterPartSlot
from schemas.sound import SoundLicense
from schemas.timeline import SoundEffectEvent


def make_test_png(width: int = 128, height: int = 128, color=(220, 60, 60, 255)) -> bytes:
    buf = io.BytesIO()
    img = Image.new("RGBA", (width, height), color)
    img.save(buf, format="PNG")
    return buf.getvalue()


def make_test_wav(duration_s: float = 0.6, freq_hz: float = 440.0, sample_rate: int = 44100) -> bytes:
    buf = io.BytesIO()
    num_frames = int(duration_s * sample_rate)
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        frames = bytearray()
        for i in range(num_frames):
            val = int(16000 * math.sin(2.0 * math.pi * freq_hz * i / sample_rate))
            frames.extend(struct.pack("<h", val))
        wf.writeframes(bytes(frames))
    return buf.getvalue()


@pytest.fixture()
def services(tmp_path: Path):
    cfg = AppConfig(workspace_dir=tmp_path / "workspace", auth_token="test-secret-token")
    return build_services(cfg)


def test_workspace_layout_and_presets_seeded(services):
    assert (services.config.sounds_dir / "footsteps").is_dir()
    assert (services.config.sounds_dir / "notification").is_dir()
    presets = services.library_repo.list_export_presets()
    preset_ids = {p.preset_id for p in presets}
    assert "preset_720p_preview" in preset_ids
    assert "preset_1080p_final" in preset_ids


def test_asset_import_and_rig_cycle_detection(services):
    body_png = make_test_png(200, 300, (50, 120, 220, 255))
    asset = services.asset_service.import_image_bytes(
        data=body_png,
        original_filename="hero_body.png",
        name="Hero Body",
        asset_type="character_part",
        part_role="body",
        folder="hero",
        tags=["hero", "body"],
    )
    assert asset.width == 200
    assert asset.height == 300
    assert services.asset_service.resolve_asset_file(asset).is_file()

    # Valid hierarchical rig passes
    valid_char = services.asset_service.create_character(
        CharacterCreateRequest(
            name="Minh",
            identity_confirmed=True,
            parts=[
                CharacterPartSlot(slot_id="body", name="Body", part_role="body", default_asset_id=asset.asset_id, z_index=1),
                CharacterPartSlot(slot_id="head", name="Head", part_role="head", parent_slot_id="body", z_index=2),
            ],
        )
    )
    assert valid_char.character_id.startswith("char_")

    # Cyclic rig must be rejected
    with pytest.raises(ValueError, match="Cycle detected"):
        services.asset_service.create_character(
            CharacterCreateRequest(
                name="BrokenRig",
                parts=[
                    CharacterPartSlot(slot_id="a", name="A", parent_slot_id="b"),
                    CharacterPartSlot(slot_id="b", name="B", parent_slot_id="a"),
                ],
            )
        )


def test_sound_import_waveform_and_overlap_detection(services):
    wav_bytes = make_test_wav(0.5, 520.0)
    sound = services.sound_service.import_sound_bytes(
        data=wav_bytes,
        original_filename="step_soft.wav",
        name="Footstep Soft",
        category="footsteps",
        tags=["walking", "indoor"],
        license_info=SoundLicense(source="cc0", usage="verified", attribution="Test"),
    )
    assert sound.duration_ms >= 480
    assert len(sound.waveform_peaks) > 10
    assert max(sound.waveform_peaks) > 0.2

    # Overlap detection catches duplicate same-sound overlap
    events = [
        SoundEffectEvent(event_id="e1", track_id="t1", sound_id=sound.sound_id, start_ms=1000, end_ms=1600),
        SoundEffectEvent(event_id="e2", track_id="t1", sound_id=sound.sound_id, start_ms=1200, end_ms=1800),
    ]
    overlaps = services.sound_service.detect_overlaps(events)
    assert len(overlaps) == 1
    assert overlaps[0]["type"] == "duplicate_overlap"


def test_project_backup_and_restore(services):
    from schemas.project import ProjectCreateRequest

    state = services.project_repo.create_project(ProjectCreateRequest(name="Episode 01", duration_ms=15000))
    pid = state.meta.project_id
    b1 = services.project_repo.create_backup(pid, tag="checkpoint")

    # Modify project name & save
    modified = state.model_copy(update={"meta": state.meta.model_copy(update={"name": "Modified Title"})})
    services.project_repo.save_project_state(modified)
    assert services.project_repo.get_project_state(pid).meta.name == "Modified Title"

    # Restore backup reverts title safely
    restored = services.project_repo.restore_backup(pid, b1.filename)
    assert restored.meta.name == "Episode 01"


def test_phase03_prop_hierarchy_pivot_and_hold_easing(services):
    from core.render_engine.software_compositor import SoftwareCompositor
    from schemas.common import Transform2D
    from schemas.project import ProjectCreateRequest
    from schemas.scene import ScenePropInstance
    from schemas.timeline import Keyframe

    red_asset = services.asset_service.import_image_bytes(
        data=make_test_png(64, 64, (240, 30, 30, 255)),
        original_filename="parent_box.png",
        name="Parent Box",
        asset_type="prop",
    )
    blue_asset = services.asset_service.import_image_bytes(
        data=make_test_png(40, 40, (30, 80, 240, 255)),
        original_filename="child_arm.png",
        name="Child Arm",
        asset_type="prop",
    )

    state = services.project_repo.create_project(
        ProjectCreateRequest(name="Phase 03 Hierarchy", width=640, height=360, fps=25, duration_ms=4000)
    )
    pid = state.meta.project_id
    state.scenes[0].props = [
        ScenePropInstance(
            prop_instance_id="p_parent",
            asset_id=red_asset.asset_id,
            name="Parent Box",
            z_index=5,
            anchor_x=0.5,
            anchor_y=0.5,
            visible=True,
            locked=False,
            parent_id=None,
            transform=Transform2D(x=200, y=180, rotation_deg=0, scale_x=1, scale_y=1, opacity=1),
        ),
        ScenePropInstance(
            prop_instance_id="p_child",
            asset_id=blue_asset.asset_id,
            name="Child Arm",
            z_index=6,
            anchor_x=0.5,
            anchor_y=0.1,
            visible=True,
            locked=True,
            parent_id="p_parent",
            transform=Transform2D(x=100, y=0, rotation_deg=0, scale_x=1, scale_y=1, opacity=1),
        ),
    ]
    state.timeline.keyframes = [
        Keyframe(
            keyframe_id="kf_hold_0",
            track_id=state.timeline.tracks[0].track_id,
            target_type="prop",
            target_id="p_parent",
            property="x",
            time_ms=0,
            value=200,
            easing="hold",
        ),
        Keyframe(
            keyframe_id="kf_hold_1",
            track_id=state.timeline.tracks[0].track_id,
            target_type="prop",
            target_id="p_parent",
            property="x",
            time_ms=2000,
            value=440,
            easing="hold",
        ),
    ]

    # Persist to SQLite and reload cleanly
    services.project_repo.save_project_state(state)
    reloaded = services.project_repo.get_project_state(pid)
    assert reloaded.meta.fps == 25
    assert reloaded.scenes[0].props[1].parent_id == "p_parent"
    assert reloaded.scenes[0].props[1].anchor_y == 0.1
    assert reloaded.scenes[0].props[1].locked is True
    assert reloaded.timeline.keyframes[0].easing == "hold"

    # Render frames at t=1000ms (frame 25 @ 25fps -> hold stays at x=200) vs t=2000ms (frame 50 -> jumps to x=440)
    comp = SoftwareCompositor(services.library_repo, services.asset_service, reloaded, 640, 360, 25)
    try:
        rgba_mid = comp.render_frame_rgba(25)
        rgba_end = comp.render_frame_rgba(50)
        assert len(rgba_mid) == 640 * 360 * 4
        assert rgba_mid != rgba_end
    finally:
        comp.close()
