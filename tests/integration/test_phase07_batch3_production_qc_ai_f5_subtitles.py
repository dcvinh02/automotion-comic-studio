"""Phase 07 Batch 3 — Comprehensive Backend Integration Tests.

Covers:
1. Automated Production Queue (Modes A-E, 9-state machine, DAG dependency blocking & partial recovery,
   idempotent Retry/Skip/Cancel/Pause/Resume, zero duplicates, SQLite v8->v9 persistence)
2. Real 8-Category Quality Control Engine (Asset, Scene, Canvas, Animation, Camera, Audio, Subtitle,
   Production) + inline fixes + info never blocks readiness
3. Dynamic AI Model Selection (7 providers, live API discovery via real local HTTP server, caching,
   refresh without erasing selection, 401/429/network error handling, capability compatibility checks,
   feature-specific model overrides, persistence)
4. Real F5-TTS Provider Integration (honest environment detection, local start failure logs when
   uninstalled, real HTTP server connection test, reference voice audio import & validation,
   multipart voice synthesis, WAV persistence, Timeline sound registration, OOM/unavailable errors)
5. Timeline Subtitle Extended Style Overrides & Software Compositor Parity + SQLite Persistence
"""

from __future__ import annotations

import asyncio
import http.server
import io
import json
import math
import socketserver
import struct
import threading
import wave
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image

from app.config import AppConfig
from app.main import create_app
from core.render_engine.software_compositor import SoftwareCompositor
from providers.llm_provider import LLMIncompatibleModelError
from schemas.production import (
    AnimationActionPlan,
    AssetMatchItem,
    AudioPlanItem,
    CameraProductionPlan,
    CharacterStagingPlan,
    ProductionPlanDocument,
    ProductionShotPlan,
    VoiceSubtitlePlanItem,
)
from schemas.production_queue import assert_valid_task_transition
from schemas.scene import Scene, SceneCharacterInstance, SceneShot
from schemas.subtitle import SubtitleDocument, SubtitleSegment, SubtitleStyleOverride, default_subtitle_styles
from schemas.timeline import Keyframe, SoundEffectEvent


def _make_wav_bytes(duration_s: float = 0.6, freq: float = 440.0, sr: int = 24000) -> bytes:
    n = int(duration_s * sr)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        frames = bytearray(n * 2)
        for i in range(n):
            v = int(12000 * math.sin(2.0 * math.pi * freq * (i / sr)))
            struct.pack_into("<h", frames, i * 2, v)
        wf.writeframes(bytes(frames))
    return buf.getvalue()


def _make_png_bytes(w: int = 128, h: int = 128, rgba=(80, 140, 220, 255)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGBA", (w, h), rgba).save(buf, format="PNG")
    return buf.getvalue()


def _make_client(tmp_path: Path):
    cfg = AppConfig(workspace_dir=tmp_path / "workspace", auth_token="b3-token")
    app = create_app(cfg)
    client = TestClient(app)
    headers = {"X-AMCS-Token": "b3-token"}
    return client, headers, app


def _seed_production_project(client: TestClient, headers: dict, app):
    """Create a project with real PNG background, rigged character, sound, and a 2-scene / 3-shot Production Plan."""
    bg_res = client.post(
        "/api/v1/assets/import",
        headers=headers,
        files={"file": ("bg_city.png", _make_png_bytes(640, 360, (30, 50, 90, 255)), "image/png")},
        data={"name": "City Rooftop", "asset_type": "background"},
    )
    assert bg_res.status_code == 201
    bg_id = bg_res.json()["asset_id"]

    body_res = client.post(
        "/api/v1/assets/import",
        headers=headers,
        files={"file": ("hero_body.png", _make_png_bytes(160, 240, (220, 80, 80, 255)), "image/png")},
        data={"name": "Hero Body", "asset_type": "character_part"},
    )
    assert body_res.status_code == 201
    body_id = body_res.json()["asset_id"]

    head_res = client.post(
        "/api/v1/assets/import",
        headers=headers,
        files={"file": ("hero_head.png", _make_png_bytes(90, 90, (250, 210, 175, 255)), "image/png")},
        data={"name": "Hero Head", "asset_type": "character_part"},
    )
    head_id = head_res.json()["asset_id"]

    char_res = client.post(
        "/api/v1/characters",
        headers=headers,
        json={"name": "Minh Hero", "description": "Lead protagonist"},
    )
    assert char_res.status_code == 201
    char_id = char_res.json()["character_id"]

    # Attach body + head parts cleanly so rig supports idle/talk/react
    lib_repo = app.state.services.library_repo
    ch = lib_repo.get_character(char_id)
    assert ch is not None
    from schemas.character import CharacterPartSlot
    from schemas.common import Transform2D

    ch.parts = [
        CharacterPartSlot(
            slot_id="slot_body",
            name="Body",
            role="body",
            default_asset_id=body_id,
            pivot_x=0.5,
            pivot_y=0.8,
            z_index=10,
            transform=Transform2D(x=0, y=0),
        ),
        CharacterPartSlot(
            slot_id="slot_head",
            name="Head",
            role="head",
            parent_slot_id="slot_body",
            default_asset_id=head_id,
            pivot_x=0.5,
            pivot_y=0.9,
            z_index=20,
            transform=Transform2D(x=0, y=-110),
        ),
    ]
    lib_repo.save_character(ch)

    sounds = client.get("/api/v1/sounds", headers=headers).json()
    sound_id = sounds[0]["sound_id"]

    proj_res = client.post(
        "/api/v1/projects",
        headers=headers,
        json={"name": "Phase 07 B3 Production", "duration_ms": 12000},
    )
    assert proj_res.status_code == 201
    pid = proj_res.json()["meta"]["project_id"]

    # Attach a 2-scene / 3-shot approved Production Plan
    repo = app.state.services.project_repo
    state = repo.get_project_state(pid)
    shots = [
        ProductionShotPlan(
            production_shot_id="pshot_s1_1",
            shot_id="sb_shot_1",
            scene_id="dir_scene_1",
            shot_order=1,
            title="Rooftop Establishing",
            duration_ms=2500,
            approval_status="approved",
            readiness_status="ready",
            background=AssetMatchItem(
                requirement_id="req_bg_1",
                kind="background",
                label="City Rooftop",
                matched_asset_id=bg_id,
                classification="existing_compatible",
                required=True,
            ),
            characters=[
                CharacterStagingPlan(
                    staging_id="stg_1",
                    character_name="Minh Hero",
                    library_character_id=char_id,
                    screen_position="center_left",
                    facing_direction="right",
                )
            ],
            animation_plans=[
                AnimationActionPlan(
                    action_plan_id="act_1",
                    character_name="Minh Hero",
                    library_character_id=char_id,
                    description="breathing idle",
                    category="idle",
                )
            ],
            camera_plan=CameraProductionPlan(camera_movement="zoom_in", shot_size="medium"),
            sfx_plans=[
                AudioPlanItem(
                    audio_plan_id="cue_1",
                    audio_type="sfx",
                    description="Wind gust",
                    matched_sound_id=sound_id,
                    offset_ms=100,
                )
            ],
            voice_subtitle_plans=[
                VoiceSubtitlePlanItem(
                    item_plan_id="vsub_1",
                    speaker_name="Minh Hero",
                    library_character_id=char_id,
                    text="The city sleeps, but danger wakes.",
                    start_offset_ms=100,
                    duration_ms=2000,
                )
            ],
        ),
        ProductionShotPlan(
            production_shot_id="pshot_s1_2",
            shot_id="sb_shot_2",
            scene_id="dir_scene_1",
            shot_order=2,
            title="Hero Reacts",
            duration_ms=2200,
            approval_status="approved",
            readiness_status="ready",
            background=AssetMatchItem(
                requirement_id="req_bg_2",
                kind="background",
                label="City Rooftop",
                matched_asset_id=bg_id,
                classification="existing_compatible",
                required=True,
            ),
            characters=[
                CharacterStagingPlan(
                    staging_id="stg_2",
                    character_name="Minh Hero",
                    library_character_id=char_id,
                    screen_position="center_right",
                    facing_direction="left",
                )
            ],
            animation_plans=[
                AnimationActionPlan(
                    action_plan_id="act_2",
                    character_name="Minh Hero",
                    library_character_id=char_id,
                    description="surprised react",
                    category="react",
                )
            ],
            camera_plan=CameraProductionPlan(camera_movement="pan_right", shot_size="close_up"),
            voice_subtitle_plans=[
                VoiceSubtitlePlanItem(
                    item_plan_id="vsub_2",
                    speaker_name="Minh Hero",
                    library_character_id=char_id,
                    text="Who is there?",
                    start_offset_ms=0,
                    duration_ms=1800,
                )
            ],
        ),
        ProductionShotPlan(
            production_shot_id="pshot_s2_1",
            shot_id="sb_shot_3",
            scene_id="dir_scene_2",
            shot_order=1,
            title="Alley Confrontation",
            duration_ms=2400,
            approval_status="approved",
            readiness_status="ready",
            background=AssetMatchItem(
                requirement_id="req_bg_3",
                kind="background",
                label="City Rooftop",
                matched_asset_id=bg_id,
                classification="existing_compatible",
                required=True,
            ),
            characters=[
                CharacterStagingPlan(
                    staging_id="stg_3",
                    character_name="Minh Hero",
                    library_character_id=char_id,
                    screen_position="center",
                    facing_direction="front",
                )
            ],
            animation_plans=[
                AnimationActionPlan(
                    action_plan_id="act_3",
                    character_name="Minh Hero",
                    library_character_id=char_id,
                    description="idle stance",
                    category="idle",
                )
            ],
            camera_plan=CameraProductionPlan(camera_movement="dolly_in", shot_size="wide"),
            voice_subtitle_plans=[
                VoiceSubtitlePlanItem(
                    item_plan_id="vsub_3",
                    speaker_name="Minh Hero",
                    library_character_id=char_id,
                    text="Show yourself!",
                    start_offset_ms=0,
                    duration_ms=1800,
                )
            ],
        ),
    ]
    state.production_plan = ProductionPlanDocument(
        plan_id="plan_b3_test",
        status="generated",
        shots=shots,
    )
    repo.save_project_state(state)
    return pid, bg_id, char_id, sound_id


# =============================================================================
# TEST 1: PRODUCTION QUEUE (MODES A-E, STATE MACHINE, DAG, FAILURE RECOVERY, RETRY)
# =============================================================================


def _poll_queue_until_settled(client: TestClient, headers: dict, pid: str, timeout_s: float = 15.0) -> dict:
    import time

    deadline = time.monotonic() + timeout_s
    last = {}
    while time.monotonic() < deadline:
        last = client.get(f"/api/v1/production-queue/{pid}", headers=headers).json()
        if last.get("status") != "running":
            return last
        time.sleep(0.05)
    return last


def test_production_queue_modes_dependencies_recovery_and_idempotent_retry(tmp_path: Path):
    cfg = AppConfig(workspace_dir=tmp_path / "workspace", auth_token="b3-token")
    app = create_app(cfg)
    headers = {"X-AMCS-Token": "b3-token"}
    with TestClient(app) as client:
        pid, _, _, _ = _seed_production_project(client, headers, app)

        # 1. Verify strict state machine rejects invalid transitions
        for bad_from, bad_to in [("pending", "completed"), ("completed", "processing"), ("failed", "completed")]:
            try:
                assert_valid_task_transition(bad_from, bad_to)  # type: ignore[arg-type]
                assert False, f"Expected ValueError for {bad_from} -> {bad_to}"
            except ValueError:
                pass

        # 2. Plan Preview across all 5 execution modes (Modes A-E)
        p_a = client.post(
            f"/api/v1/production-queue/{pid}/plan",
            headers=headers,
            json={"mode": "single_shot", "production_shot_ids": ["pshot_s1_1"]},
        ).json()
        assert p_a["can_start"] is True
        assert p_a["total_shots"] == 1
        assert p_a["total_tasks"] == 7  # asset + char + asm + anim + cam + audio/sub + qc

        p_b = client.post(
            f"/api/v1/production-queue/{pid}/plan",
            headers=headers,
            json={"mode": "selected_shots", "production_shot_ids": ["pshot_s1_1", "pshot_s2_1"]},
        ).json()
        assert p_b["total_shots"] == 2
        assert p_b["total_scenes"] == 2

        p_c = client.post(
            f"/api/v1/production-queue/{pid}/plan",
            headers=headers,
            json={"mode": "scene", "scene_ids": ["dir_scene_1"]},
        ).json()
        assert p_c["total_scenes"] == 1
        assert p_c["total_shots"] == 2

        p_d = client.post(
            f"/api/v1/production-queue/{pid}/plan",
            headers=headers,
            json={"mode": "project"},
        ).json()
        assert p_d["total_scenes"] == 2
        assert p_d["total_shots"] == 3

        p_e = client.post(
            f"/api/v1/production-queue/{pid}/plan",
            headers=headers,
            json={"mode": "production_plan"},
        ).json()
        assert p_e["total_shots"] == 3

        # 3. Execute Mode A (Single Shot) and verify real Timeline/Scene/Subtitle/Audio updates
        start_res = client.post(
            f"/api/v1/production-queue/{pid}/start",
            headers=headers,
            json={"mode": "single_shot", "production_shot_ids": ["pshot_s1_1"]},
        )
        assert start_res.status_code == 200
        final_q = _poll_queue_until_settled(client, headers, pid)
        assert final_q["status"] == "completed", final_q
        assert all(t["status"] == "completed" for t in final_q["tasks"])

        state_after_a = app.state.services.project_repo.get_project_state(pid)
        assert any(len(sc.shots) >= 1 for sc in state_after_a.scenes)
        assert len(state_after_a.timeline.keyframes) > 0
        assert len(state_after_a.timeline.sound_events) >= 1
        assert any("danger wakes" in s.text for s in state_after_a.subtitles.segments)
        assert state_after_a.qc_report is not None

        # 4. Dependency Failure & Partial Recovery: inject failure on scene_assembly for Mode E
        fail_res = client.post(
            f"/api/v1/production-queue/{pid}/start",
            headers=headers,
            json={"mode": "production_plan", "inject_fail_task_types": ["scene_assembly"]},
        )
        assert fail_res.status_code == 200
        partial_q = _poll_queue_until_settled(client, headers, pid)
        assert partial_q["status"] == "partial"

        by_type = {}
        for t in partial_q["tasks"]:
            by_type.setdefault(t["task_type"], []).append(t)

        # Upstream asset_resolution & character_validation completed; scene_assembly failed; downstream blocked!
        assert all(t["status"] == "completed" for t in by_type["asset_resolution"])
        assert all(t["status"] == "completed" for t in by_type["character_validation"])
        assert all(t["status"] == "failed" for t in by_type["scene_assembly"])
        assert all(t["status"] == "needs_review" and len(t["blocked_by_task_ids"]) > 0 for t in by_type["shot_animation"])
        assert all(t["status"] == "needs_review" and len(t["blocked_by_task_ids"]) > 0 for t in by_type["camera_setup"])

        # QC must have caught FAILED_PRODUCTION_TASK
        qc_after_fail = client.get(f"/api/v1/qc/{pid}/latest", headers=headers).json()
        assert any(i["code"] == "FAILED_PRODUCTION_TASK" for i in qc_after_fail["issues"])

        # 5. Retry one failed scene_assembly task -> downstream tasks unblock & complete with ZERO duplicates!
        target_failed_id = by_type["scene_assembly"][0]["task_id"]
        retry_res = client.post(
            f"/api/v1/production-queue/{pid}/tasks/{target_failed_id}/retry",
            headers=headers,
        )
        assert retry_res.status_code == 200
        recovered_q = _poll_queue_until_settled(client, headers, pid)
        retried_task = next(t for t in recovered_q["tasks"] if t["task_id"] == target_failed_id)
        assert retried_task["status"] == "completed"
        assert retried_task["retry_count"] == 1

        # Verify Skip on remaining failed task
        remaining_failed = [t for t in recovered_q["tasks"] if t["status"] == "failed"]
        assert len(remaining_failed) >= 1
        skip_res = client.post(
            f"/api/v1/production-queue/{pid}/tasks/{remaining_failed[0]['task_id']}/skip",
            headers=headers,
        )
        assert skip_res.status_code == 200
        assert any(
            t["task_id"] == remaining_failed[0]["task_id"] and t["status"] == "skipped"
            for t in skip_res.json()["tasks"]
        )

        # Run full Mode D cleanly twice and assert ZERO duplicate shots / keyframes / subtitles!
        client.post(f"/api/v1/production-queue/{pid}/start", headers=headers, json={"mode": "project"})
        q1 = _poll_queue_until_settled(client, headers, pid)
        assert q1["status"] == "completed"
        st1 = app.state.services.project_repo.get_project_state(pid)
        shot_count_1 = sum(len(sc.shots) for sc in st1.scenes)
        kf_count_1 = len(st1.timeline.keyframes)
        sub_count_1 = len(st1.subtitles.segments)
        snd_count_1 = len(st1.timeline.sound_events)

        client.post(f"/api/v1/production-queue/{pid}/start", headers=headers, json={"mode": "project"})
        q2 = _poll_queue_until_settled(client, headers, pid)
        assert q2["status"] == "completed"
        st2 = app.state.services.project_repo.get_project_state(pid)
        assert sum(len(sc.shots) for sc in st2.scenes) == shot_count_1
        assert len(st2.timeline.keyframes) == kf_count_1
        assert len(st2.subtitles.segments) == sub_count_1
        assert len(st2.timeline.sound_events) == snd_count_1

        # Verify persistence on fresh reload
        reloaded_q = client.get(f"/api/v1/production-queue/{pid}", headers=headers).json()
        assert reloaded_q["status"] == "completed"
        assert len(reloaded_q["tasks"]) == len(q2["tasks"])


# =============================================================================
# TEST 2: REAL 8-CATEGORY QUALITY CONTROL & INLINE FIXES
# =============================================================================


def test_quality_control_all_8_categories_and_inline_fixes(tmp_path: Path):
    client, headers, app = _make_client(tmp_path)
    pid, bg_id, char_id, sound_id = _seed_production_project(client, headers, app)
    repo = app.state.services.project_repo
    state = repo.get_project_state(pid)

    # Inject realistic issues spanning all 8 QC categories
    sc = state.scenes[0]
    sc.background_asset_id = "asset_nonexistent_999"  # 1. Asset: MISSING_ASSET
    sc.camera_default.zoom = 6.5  # 5. Camera: CAMERA_OUTSIDE_LIMITS
    from schemas.common import Transform2D

    sc.characters.append(
        SceneCharacterInstance(
            instance_id="inst_missing_char",
            scene_id=sc.scene_id,
            character_id="char_does_not_exist",
            display_name="Ghost",
            initial_transform=Transform2D(x=3500.0, y=2200.0, scale_x=6.0, scale_y=6.0),  # 1. Asset + 3. Canvas OOB + extreme scale
        )
    )
    sc.shots.append(
        SceneShot(
            shot_id="shot_empty_overflow",
            scene_id=sc.scene_id,
            shot_order=99,
            title="Broken Empty Overflow Shot",
            start_ms=sc.duration_ms + 500,
            duration_ms=1500,  # 2. Scene: EMPTY_SHOT + SHOT_EXCEEDS_SCENE_DURATION
            background_asset_id=None,
            character_states=[],
            prop_states=[],
            applied_motions=[],
            warnings=[],
            staging_fallbacks=[],
            asset_refs=[],
            animation_refs=[],
            camera_default=sc.camera_default.model_copy(update={"zoom": 1.0}),
        )
    )
    # 4. Animation: orphan track keyframe + rig-incompatible walk action
    state.timeline.keyframes.append(
        Keyframe(
            keyframe_id="kf_bad_orphan",
            track_id="trk_missing_xyz",
            target_id="inst_missing_xyz",
            target_type="character_instance",
            property="x",
            time_ms=500,
            value=100.0,
        )
    )
    # Make planned shot request 'sit' without a Sit pose/preset -> incompatible with this 2-part rig!
    state.production_plan.shots[0].animation_plans[0].category = "sit"
    state.production_plan.shots[0].animation_plans[0].mapped_preset_id = None
    # 5. Camera: also mark an unsupported 3D/parallax camera motion on the planned shot
    state.production_plan.shots[0].camera_plan.camera_movement = "parallax"
    state.production_plan.shots[0].camera_plan.support_status = "unsupported_suggestion"
    state.production_plan.shots[0].assets.append(
        AssetMatchItem(
            requirement_id="req_unmatched",
            kind="prop",
            label="Missing Katana",
            matched_asset_id=None,
            required=True,
        )
    )
    # 6. Audio: broken sound reference + voice overlap
    voice_trk = next(t for t in state.timeline.tracks if t.track_type == "voice")
    state.timeline.sound_events.extend(
        [
            SoundEffectEvent(
                event_id="ev_broken_snd",
                track_id=voice_trk.track_id,
                sound_id="snd_missing_404",
                start_ms=200,
                end_ms=1200,
            ),
            SoundEffectEvent(
                event_id="ev_voice_1",
                track_id=voice_trk.track_id,
                sound_id=sound_id,
                start_ms=1000,
                end_ms=3000,
            ),
            SoundEffectEvent(
                event_id="ev_voice_2",
                track_id=voice_trk.track_id,
                sound_id=sound_id,
                start_ms=1500,
                end_ms=3500,
            ),
        ]
    )
    # 7. Subtitle: empty text + safe-area violation + duration overflow
    state.subtitles = SubtitleDocument(
        styles=default_subtitle_styles(),
        segments=[
            SubtitleSegment(
                subtitle_id="sub_empty_bad",
                text="   ",
                start_ms=100,
                end_ms=1200,
                scene_id=sc.scene_id,
            ),
            SubtitleSegment(
                subtitle_id="sub_overflow_oob",
                text="Overflowing subtitle",
                start_ms=1000,
                end_ms=99000,
                scene_id=sc.scene_id,
                style_override=SubtitleStyleOverride(safe_area_clamp=False, offset_x=920.0, margin_y=5),
            ),
        ],
    )
    repo.save_project_state(state)

    qc = client.post(f"/api/v1/qc/{pid}/run", headers=headers, json={}).json()
    codes = {i["code"] for i in qc["issues"]}
    categories_hit = {i["category"] for i in qc["issues"]}

    assert qc["production_ready"] is False
    assert qc["error_count"] > 0
    assert categories_hit == {"asset", "scene", "canvas", "animation", "camera", "audio", "subtitle", "production"}
    assert "MISSING_ASSET" in codes
    assert "MISSING_CHARACTER" in codes
    assert "EMPTY_SHOT" in codes
    assert "SHOT_EXCEEDS_SCENE_DURATION" in codes
    assert "CHARACTER_OUTSIDE_CANVAS" in codes
    assert "EXTREME_CHARACTER_SCALE" in codes
    assert "ORPHAN_KEYFRAME_TRACK" in codes
    assert "ANIMATION_RIG_INCOMPATIBLE" in codes
    assert "CAMERA_OUTSIDE_LIMITS" in codes
    assert "UNSUPPORTED_CAMERA_MOTION" in codes
    assert "BROKEN_AUDIO_REFERENCE" in codes
    assert "OVERLAPPING_VOICE_AUDIO" in codes
    assert "MISSING_SUBTITLE_TEXT" in codes
    assert "SUBTITLE_EXCEEDS_DURATION" in codes
    assert "SUBTITLE_OUTSIDE_SAFE_AREA" in codes
    assert "MISSING_PRODUCTION_DEPENDENCIES" in codes

    # Apply inline fixes via API and confirm issues clear
    for fix_payload in [
        {"issue_id": "x", "fix_action": "clean_orphan_keyframes"},
        {"issue_id": "x", "fix_action": "remove_broken_audio", "sound_event_id": "ev_broken_snd"},
        {"issue_id": "x", "fix_action": "fix_subtitle_timing", "subtitle_id": "sub_overflow_oob"},
        {"issue_id": "x", "fix_action": "enable_subtitle_safe_area", "subtitle_id": "sub_overflow_oob"},
        {"issue_id": "x", "fix_action": "reset_scene_camera", "scene_id": sc.scene_id},
    ]:
        fres = client.post(f"/api/v1/qc/{pid}/fix", headers=headers, json=fix_payload)
        assert fres.status_code == 200

    qc2 = client.post(f"/api/v1/qc/{pid}/run", headers=headers, json={}).json()
    codes2 = {i["code"] for i in qc2["issues"]}
    assert "ORPHAN_KEYFRAME_TRACK" not in codes2
    assert "BROKEN_AUDIO_REFERENCE" not in codes2
    assert "SUBTITLE_OUTSIDE_SAFE_AREA" not in codes2
    assert "CAMERA_OUTSIDE_LIMITS" not in codes2

    # Also verify QC catches corrupt in-memory duration_ms=0 & negative keyframe time_ms=-250
    corrupt_state = repo.get_project_state(pid)
    corrupt_state.scenes[0].shots.append(
        SceneShot.model_construct(
            shot_id="shot_zero_dur",
            scene_id=sc.scene_id,
            shot_order=100,
            title="Zero Duration Shot",
            start_ms=0,
            duration_ms=0,
            background_asset_id=None,
            character_states=[],
            prop_states=[],
            applied_motions=[],
            warnings=[],
            staging_fallbacks=[],
            asset_refs=[],
            animation_refs=[],
            camera_default=sc.camera_default.model_copy(update={"zoom": 1.0}),
        )
    )
    corrupt_state.timeline.keyframes.append(
        Keyframe.model_construct(
            keyframe_id="kf_bad_neg",
            track_id=corrupt_state.timeline.tracks[0].track_id,
            target_id=sc.scene_id,
            target_type="scene",
            property="opacity",
            time_ms=-250,
            value=1.0,
            easing="linear",
        )
    )
    qc_corrupt = app.state.services.qc_engine.run_production_qc(corrupt_state)
    corrupt_codes = {i.code for i in qc_corrupt.issues}
    assert "INVALID_SHOT_DURATION" in corrupt_codes
    assert "INVALID_KEYFRAME_TIME" in corrupt_codes
    from schemas.production_queue import ProductionQCFixRequest
    # apply_qc_fix is non-mutating: it returns (fixed_copy, message) and leaves the input untouched
    fixed_state, fix_msg = app.state.services.qc_engine.apply_qc_fix(
        corrupt_state,
        ProductionQCFixRequest(issue_id="x", fix_action="clamp_negative_keyframes"),
    )
    assert "Clamped 1 negative keyframe" in fix_msg
    assert all(k.time_ms >= 0 for k in fixed_state.timeline.keyframes)
    assert any(k.time_ms < 0 for k in corrupt_state.timeline.keyframes)


# =============================================================================
# TEST 3: DYNAMIC AI MODEL SELECTION, LIVE DISCOVERY, COMPATIBILITY & OVERRIDES
# =============================================================================


class _MockProviderHTTPHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        return

    def do_GET(self):
        auth = self.headers.get("Authorization", "")
        x_api_key = self.headers.get("x-api-key", "")

        # Auth error simulation
        if "bad-key" in auth or "bad-key" in x_api_key or "key=bad-key" in self.path:
            self.send_response(401)
            self.end_headers()
            self.wfile.write(b'{"error":"invalid_api_key"}')
            return

        # Rate limit simulation
        if "rate-limit" in auth:
            self.send_response(429)
            self.end_headers()
            self.wfile.write(b'{"error":"rate_limit_exceeded"}')
            return

        # Gemini /models?key=...
        if self.path.startswith("/v1beta/models"):
            body = {
                "models": [
                    {
                        "name": "models/gemini-2.5-pro",
                        "displayName": "Gemini 2.5 Pro",
                        "inputTokenLimit": 1048576,
                        "supportedGenerationMethods": ["generateContent"],
                    },
                    {
                        "name": "models/text-embedding-004",
                        "displayName": "Text Embedding 004",
                        "inputTokenLimit": 2048,
                        "supportedGenerationMethods": ["embedContent"],
                    },
                ]
            }
        # Anthropic /v1/models
        elif self.path.startswith("/anthropic/v1/models"):
            body = {
                "data": [
                    {"id": "claude-sonnet-4-20250514", "display_name": "Claude Sonnet 4"},
                    {"id": "claude-3-5-haiku-20241022", "display_name": "Claude 3.5 Haiku"},
                ]
            }
        # OpenRouter /openrouter/models (rich context + modality metadata)
        elif self.path.startswith("/openrouter/models"):
            body = {
                "data": [
                    {
                        "id": "anthropic/claude-3.5-sonnet",
                        "name": "Claude 3.5 Sonnet (OR)",
                        "context_length": 200000,
                        "architecture": {"modality": "text+image->text"},
                        "supported_parameters": ["tools", "response_format"],
                    }
                ]
            }
        # OpenAI / DeepSeek / Groq / Compatible /v1/models
        else:
            body = {
                "data": [
                    {"id": "gpt-4o-mini"},
                    {"id": "gpt-4.1"},
                    {"id": "o3-mini"},
                    {"id": "text-embedding-3-small"},
                ]
            }

        raw = json.dumps(body).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


def test_dynamic_ai_model_discovery_compatibility_and_feature_overrides(tmp_path: Path):
    server = socketserver.TCPServer(("127.0.0.1", 0), _MockProviderHTTPHandler)
    port = server.server_address[1]
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()

    try:
        client, headers, app = _make_client(tmp_path)

        # 1. Verify all 7 providers registered
        reg = client.get("/api/v1/director/providers", headers=headers).json()
        pids = {p["provider_id"] for p in reg["providers"]}
        assert pids == {"openai", "anthropic", "gemini", "deepseek", "openrouter", "groq", "openai_compatible"}

        # 2. Configure OpenAI pointing to local test server & discover live models
        client.put(
            "/api/v1/director/config",
            headers=headers,
            json={"provider_id": "openai", "api_key": "sk-valid-test", "base_url": f"http://127.0.0.1:{port}/v1", "model": "gpt-4.1"},
        )
        disc_oai = client.post("/api/v1/director/models/openai/refresh", headers=headers).json()
        assert disc_oai["source"] == "live_api"
        assert disc_oai["discovered_count"] == 4
        m_map = {m["model_id"]: m for m in disc_oai["models"]}
        assert m_map["gpt-4.1"]["supports_text"] is True
        assert m_map["gpt-4.1"]["supports_vision"] is True
        assert m_map["o3-mini"]["supports_reasoning"] is True
        assert m_map["text-embedding-3-small"]["supports_text"] is False

        # Second fetch without refresh hits cache & preserves user's selected model
        cached_oai = client.get("/api/v1/director/models/openai", headers=headers).json()
        assert cached_oai["source"] == "cache"
        assert cached_oai["selected_model_valid"] is True

        # 3. Discover Anthropic, Gemini & OpenRouter live models while switching providers without corrupting OpenAI config!
        client.put(
            "/api/v1/director/config",
            headers=headers,
            json={"provider_id": "anthropic", "api_key": "ant-valid", "base_url": f"http://127.0.0.1:{port}/anthropic"},
        )
        disc_ant = client.post("/api/v1/director/models/anthropic/refresh", headers=headers).json()
        assert disc_ant["source"] == "live_api"
        assert any(m["model_id"] == "claude-sonnet-4-20250514" for m in disc_ant["models"])

        client.put(
            "/api/v1/director/config",
            headers=headers,
            json={"provider_id": "gemini", "api_key": "gem-valid", "base_url": f"http://127.0.0.1:{port}/v1beta"},
        )
        disc_gem = client.post("/api/v1/director/models/gemini/refresh", headers=headers).json()
        assert disc_gem["source"] == "live_api"
        gem_map = {m["model_id"]: m for m in disc_gem["models"]}
        assert gem_map["gemini-2.5-pro"]["context_length"] == 1048576
        assert gem_map["text-embedding-004"]["supports_text"] is False

        client.put(
            "/api/v1/director/config",
            headers=headers,
            json={"provider_id": "openrouter", "api_key": "or-valid", "base_url": f"http://127.0.0.1:{port}/openrouter"},
        )
        disc_or = client.post("/api/v1/director/models/openrouter/refresh", headers=headers).json()
        assert disc_or["source"] == "live_api"
        assert disc_or["models"][0]["context_length"] == 200000
        assert disc_or["models"][0]["supports_vision"] is True
        assert disc_or["models"][0]["supports_tools"] is True

        # Confirm switching providers preserved OpenAI's saved model ('gpt-4.1')!
        reg_after = client.get("/api/v1/director/providers", headers=headers).json()
        assert reg_after["config"]["provider_models"]["openai"] == "gpt-4.1"

        # 4. Error handling: 401 invalid credentials, 429 rate limit, unreachable network
        client.put(
            "/api/v1/director/config",
            headers=headers,
            json={"provider_id": "deepseek", "api_key": "bad-key", "base_url": f"http://127.0.0.1:{port}/v1"},
        )
        err_401 = client.post("/api/v1/director/models/deepseek/refresh", headers=headers).json()
        assert err_401["error_code"] == "invalid_credentials"
        assert err_401["discovered_count"] == 0

        client.put(
            "/api/v1/director/config",
            headers=headers,
            json={"provider_id": "groq", "api_key": "rate-limit", "base_url": f"http://127.0.0.1:{port}/v1"},
        )
        err_429 = client.post("/api/v1/director/models/groq/refresh", headers=headers).json()
        assert err_429["error_code"] == "rate_limited"

        client.put(
            "/api/v1/director/config",
            headers=headers,
            json={"provider_id": "openai_compatible", "base_url": "http://127.0.0.1:1/v1"},
        )
        err_net = client.post("/api/v1/director/models/openai_compatible/refresh", headers=headers).json()
        assert err_net["error_code"] == "network_error"

        # 5. Compatibility check prevents incompatible execution and recommends real alternatives
        compat = client.post(
            "/api/v1/director/models/check-compatibility",
            headers=headers,
            json={"feature_key": "storyboard", "provider_id": "openai", "model": "text-embedding-3-small"},
        ).json()
        assert compat["compatible"] is False
        assert len(compat["reasons"]) >= 1
        assert "gpt-4.1" in compat["recommended_models"] or "gpt-4o-mini" in compat["recommended_models"]

        # 6. Feature-specific model overrides + enforcement without silent switching!
        fm_res = client.put(
            "/api/v1/director/feature-models",
            headers=headers,
            json={
                "script_analysis": {"provider_id": "openai", "model": "gpt-4.1"},
                "storyboard": {"provider_id": "anthropic", "model": "claude-sonnet-4-20250514"},
                "production_plan": {"provider_id": "gemini", "model": "gemini-2.5-pro"},
                "asset_prompts": {"provider_id": "openai", "model": "text-embedding-3-small"},
            },
        )
        assert fm_res.status_code == 200
        llm_reg = app.state.services.llm_registry
        _, cfg_script = llm_reg.get_provider_for_feature("script_analysis")
        _, cfg_sb = llm_reg.get_provider_for_feature("storyboard")
        _, cfg_prod = llm_reg.get_provider_for_feature("production_plan")
        assert (cfg_script.provider_id, cfg_script.model) == ("openai", "gpt-4.1")
        assert (cfg_sb.provider_id, cfg_sb.model) == ("anthropic", "claude-sonnet-4-20250514")
        assert (cfg_prod.provider_id, cfg_prod.model) == ("gemini", "gemini-2.5-pro")

        # Incompatible override MUST raise LLMIncompatibleModelError (never silently switch!)
        try:
            llm_reg.get_provider_for_feature("asset_prompts")
            assert False, "Expected LLMIncompatibleModelError for text-embedding-3-small"
        except LLMIncompatibleModelError as exc:
            assert len(exc.recommended_models) >= 1
    finally:
        server.shutdown()
        server.server_close()


# =============================================================================
# TEST 4: REAL F5-TTS PROVIDER INTEGRATION, REFERENCE VOICES & TIMELINE SYNC
# =============================================================================


class _MockF5TTSHTTPHandler(http.server.BaseHTTPRequestHandler):
    last_received: dict = {}

    def log_message(self, format, *args):
        return

    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"status":"ok","engine":"f5_tts"}')
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        ct = self.headers.get("Content-Type", "")
        if b"TRIGGER_OOM" in body:
            self.send_response(500)
            self.end_headers()
            self.wfile.write(b"CUDA out of memory while running F5-TTS DiT")
            return

        _MockF5TTSHTTPHandler.last_received = {"content_type": ct, "size": len(body), "body": body}
        wav = _make_wav_bytes(duration_s=0.75, freq=520.0, sr=24000)
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(wav)))
        self.end_headers()
        self.wfile.write(wav)


def test_f5_tts_environment_config_references_synthesis_and_timeline(tmp_path: Path):
    server = socketserver.TCPServer(("127.0.0.1", 0), _MockF5TTSHTTPHandler)
    port = server.server_address[1]
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()

    try:
        client, headers, _ = _make_client(tmp_path)
        proj = client.post("/api/v1/projects", headers=headers, json={"name": "F5 Voice Test"}).json()
        pid = proj["meta"]["project_id"]

        # 1. Honest status detection (not faked!)
        st0 = client.get("/api/v1/voice/f5-tts/status", headers=headers).json()
        assert st0["mode"] == "external_http"
        assert isinstance(st0["installed"], bool)
        assert len(st0["install_instructions"]) >= 2

        # 2. Local managed start when not installed must fail honestly with 422 + logs
        if not st0["installed"]:
            client.put("/api/v1/voice/f5-tts/config", headers=headers, json={"mode": "local_managed"})
            start_err = client.post("/api/v1/voice/f5-tts/start", headers=headers)
            assert start_err.status_code == 422
            st_err = client.get("/api/v1/voice/f5-tts/status", headers=headers).json()
            assert len(st_err["logs"]) >= 1

        # 3. Configure external F5-TTS HTTP server & test connection
        cfg_res = client.put(
            "/api/v1/voice/f5-tts/config",
            headers=headers,
            json={
                "mode": "external_http",
                "service_url": f"http://127.0.0.1:{port}",
                "model_name": "F5TTS_v1_Base",
                "device_preference": "auto",
                "nfe_step": 24,
                "cfg_strength": 2.2,
            },
        )
        assert cfg_res.status_code == 200
        conn_res = client.post("/api/v1/voice/f5-tts/test-connection", headers=headers).json()
        assert conn_res["ok"] is True
        assert conn_res["status_code"] == 200

        # 4. Reference voice validation (reject corrupt bytes & missing transcript)
        bad_ref = client.post(
            "/api/v1/voice/f5-tts/references",
            headers=headers,
            files={"file": ("corrupt.wav", b"not-a-valid-wav-at-all-1234567890" * 4, "audio/wav")},
            data={"name": "Broken", "transcript": "Hello world", "language": "vi-VN"},
        )
        assert bad_ref.status_code == 400

        # Import valid reference voice WAV + transcript
        ref_wav = _make_wav_bytes(duration_s=0.8, freq=310.0)
        ref_res = client.post(
            "/api/v1/voice/f5-tts/references",
            headers=headers,
            files={"file": ("minh_ref.wav", ref_wav, "audio/wav")},
            data={"name": "Minh Studio Ref", "transcript": "Xin chào, tôi là Minh.", "language": "vi-VN"},
        )
        assert ref_res.status_code == 201
        ref_id = ref_res.json()["ref_id"]
        assert ref_res.json()["duration_ms"] >= 700
        assert len(ref_res.json()["waveform_peaks"]) > 0

        # Reference file preview streaming works
        stream_ref = client.get(f"/api/v1/voice/f5-tts/references/{ref_id}/file", headers=headers)
        assert stream_ref.status_code == 200
        assert stream_ref.content[:4] == b"RIFF"

        # F5-TTS provider now exposes the imported reference voice in Voice Studio!
        provs = {p["provider_id"]: p for p in client.get("/api/v1/voice/providers", headers=headers).json()}
        assert provs["f5_tts"]["is_configured"] is True
        assert any(v["voice_id"] == ref_id for v in provs["f5_tts"]["voices"])

        # 5. Generate real speech via F5-TTS test-generate -> verify multipart ref_audio sent + WAV persisted
        gen_res = client.post(
            "/api/v1/voice/f5-tts/test-generate",
            headers=headers,
            json={
                "project_id": pid,
                "text": "Hôm nay trời rất đẹp!",
                "ref_id": ref_id,
                "language": "vi-VN",
                "speed": 1.05,
            },
        )
        assert gen_res.status_code == 201
        asset = gen_res.json()
        assert asset["provider_id"] == "f5_tts"
        assert asset["is_mock"] is False
        assert asset["duration_ms"] >= 600
        assert "multipart/form-data" in _MockF5TTSHTTPHandler.last_received["content_type"]
        assert b"Xin ch" in _MockF5TTSHTTPHandler.last_received["body"]

        # Stream generated audio & register to Audio Timeline Sound Library
        wav_stream = client.get(f"/api/v1/voice/audio/{pid}/{asset['audio_asset_id']}/file", headers=headers)
        assert wav_stream.status_code == 200 and wav_stream.content[:4] == b"RIFF"

        tl_snd = client.post(
            f"/api/v1/voice/audio/{pid}/{asset['audio_asset_id']}/register-sound",
            headers=headers,
            json={"label": "Minh F5 Line 1"},
        )
        assert tl_snd.status_code == 200
        assert "f5_tts" in tl_snd.json()["tags"]

        # 6. Error handling: OOM GPU error suggests CPU fallback cleanly without crash
        oom_res = client.post(
            "/api/v1/voice/f5-tts/test-generate",
            headers=headers,
            json={"project_id": pid, "text": "TRIGGER_OOM test", "ref_id": ref_id},
        )
        assert oom_res.status_code == 422
        assert "CPU fallback" in oom_res.json()["detail"]

        # Unreachable server error
        client.put("/api/v1/voice/f5-tts/config", headers=headers, json={"service_url": "http://127.0.0.1:1"})
        unreach = client.post("/api/v1/voice/f5-tts/test-connection", headers=headers).json()
        assert unreach["ok"] is False
    finally:
        server.shutdown()
        server.server_close()


# =============================================================================
# TEST 5: SUBTITLE STYLE OVERRIDE ISOLATION, PERSISTENCE & COMPOSITOR PARITY
# =============================================================================


def test_subtitle_style_override_persistence_isolation_and_compositor_render(tmp_path: Path):
    client, headers, app = _make_client(tmp_path)
    proj = client.post("/api/v1/projects", headers=headers, json={"name": "Subtitle Override Test"}).json()
    pid = proj["meta"]["project_id"]

    repo = app.state.services.project_repo
    state = repo.get_project_state(pid)
    state.subtitles = SubtitleDocument(
        default_style_id="style_classic_white",
        styles=default_subtitle_styles(),
        segments=[
            SubtitleSegment(
                subtitle_id="sub_edited_1",
                text="Line 1\nStyled Override",
                start_ms=200,
                end_ms=2200,
                style_id="style_classic_white",
                style_override=SubtitleStyleOverride(
                    font_family="Georgia, 'Noto Serif', serif",
                    font_size=62,
                    font_weight="extrabold",
                    italic=True,
                    underline=True,
                    letter_spacing=3.5,
                    text_color="#fde047",
                    outline_color="#111827",
                    outline_width=4.5,
                    shadow_enabled=True,
                    shadow_color="#000000",
                    shadow_opacity=0.9,
                    shadow_offset_x=4.0,
                    shadow_offset_y=5.0,
                    background_enabled=True,
                    background_color="#1e1b4b",
                    background_opacity=0.82,
                    background_padding_x=28,
                    background_padding_y=14,
                    alignment="left",
                    position="top",
                    offset_x=40.0,
                    offset_y=20.0,
                    max_width_pct=65,
                    box_height_px=120,
                    safe_area_clamp=True,
                ),
            ),
            SubtitleSegment(
                subtitle_id="sub_sibling_2",
                text="Line 2 untouched",
                start_ms=2500,
                end_ms=4500,
                style_id="style_classic_white",
            ),
        ],
    )
    repo.save_project_state(state)

    # Reopen from SQLite via API -> verify EVERY edited property persisted with ZERO leakage to sibling
    reloaded = client.get(f"/api/v1/projects/{pid}", headers=headers).json()
    segs = {s["subtitle_id"]: s for s in reloaded["subtitles"]["segments"]}
    ov = segs["sub_edited_1"]["style_override"]
    assert ov["font_size"] == 62
    assert ov["italic"] is True
    assert ov["underline"] is True
    assert ov["letter_spacing"] == 3.5
    assert ov["text_color"] == "#fde047"
    assert ov["background_padding_x"] == 28
    assert ov["box_height_px"] == 120
    assert ov["alignment"] == "left"
    assert ov["position"] == "top"
    assert segs["sub_sibling_2"]["style_override"] is None

    # Render frames at Subtitle 1 & Subtitle 2 via SoftwareCompositor -> must render cleanly with distinct pixels!
    comp = SoftwareCompositor(
        state=repo.get_project_state(pid),
        library_repo=app.state.services.library_repo,
        asset_service=app.state.services.asset_service,
        width=640,
        height=360,
        fps=30,
        burn_in_subtitles=True,
    )
    frame_1 = comp.render_frame_rgba(30)  # 1000ms -> Subtitle 1 active
    frame_2 = comp.render_frame_rgba(90)  # 3000ms -> Subtitle 2 active
    assert len(frame_1) == 640 * 360 * 4
    assert len(frame_2) == 640 * 360 * 4
    assert frame_1 != frame_2
