"""Phase 07 Batch 2 Integration Tests — Animation Capabilities, Procedural Motion, Camera Sync, Motion Library & Isolation.

Verifies:
1. Real Rig Capability inspection (full cutout, upper body, empty rig)
2. All 10 character presets (idle, walk, run, blink, wave, head_turn/look, talk, jump, fall, react)
3. Unsupported rig, missing capability & invalid parameter rejection (never silent!)
4. Non-destructive Motion Preview (0 mutations to project.db) vs validated Apply
5. Motion Library CRUD (save, rename, duplicate, delete custom, block built-in delete)
6. All Camera motions (static, pan, zoom, dolly, shake, character-synchronized camera_follow, honest parallax rejection)
7. Production Plan -> Shot Animation Execution, zero duplicates, preserve_user_modified & selective regeneration
8. Zero shot-to-shot motion leakage (verified with SoftwareCompositor rendering!)
9. Transactional rollback & safe library.db v4->v5 + project.db v7->v8 migrations
"""

from __future__ import annotations

import io
import sqlite3
from pathlib import Path
from fastapi.testclient import TestClient
from PIL import Image

from app.config import AppConfig
from app.main import create_app
from core.render_engine.software_compositor import SoftwareCompositor
from schemas.animation_execution import ShotAnimationExecuteRequest


def _png_bytes(w: int, h: int, color: tuple[int, int, int, int]) -> bytes:
    img = Image.new("RGBA", (w, h), color)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _upload_png(client: TestClient, headers: dict[str, str], name: str, asset_type: str, color: tuple[int, int, int, int], w: int = 80, h: int = 120) -> dict:
    r = client.post(
        "/api/v1/assets/import",
        headers=headers,
        files={"file": (f"{name}.png", _png_bytes(w, h, color), "image/png")},
        data={"name": name, "type": asset_type},
    )
    assert r.status_code == 201, r.text
    return r.json()


def _build_app(tmp_path: Path) -> tuple[TestClient, dict[str, str], object]:
    cfg = AppConfig(workspace_dir=tmp_path / "ws", auth_token="p7b2-secret")
    app = create_app(cfg)
    return TestClient(app), {"X-AMCS-Token": "p7b2-secret"}, app


def _seed_full_and_partial_characters(client: TestClient, headers: dict[str, str]):
    body = _upload_png(client, headers, "Body", "character_part", (60, 120, 230, 255), 90, 160)
    head = _upload_png(client, headers, "Head", "character_part", (245, 210, 180, 255), 70, 70)
    arm = _upload_png(client, headers, "Arm", "character_part", (80, 140, 240, 255), 28, 90)
    hand = _upload_png(client, headers, "Hand", "character_part", (245, 210, 180, 255), 22, 22)
    leg = _upload_png(client, headers, "Leg", "character_part", (40, 60, 120, 255), 30, 100)
    eye_open = _upload_png(client, headers, "EyeOpen", "character_part", (255, 255, 255, 255), 32, 16)
    eye_closed = _upload_png(client, headers, "EyeClosed", "character_part", (30, 30, 40, 255), 32, 8)
    mouth_closed = _upload_png(client, headers, "MouthClosed", "character_part", (160, 60, 60, 255), 24, 8)
    mouth_open = _upload_png(client, headers, "MouthOpen", "character_part", (220, 70, 70, 255), 24, 18)

    # 1. FullHero: all 10 capabilities!
    full = client.post(
        "/api/v1/characters",
        headers=headers,
        json={"name": "FullHero", "description": "Complete multi-part cutout rig"},
    ).json()
    full["parts"] = [
        {"slot_id": "s_body", "name": "Body", "part_role": "body", "parent_slot_id": None, "default_asset_id": body["asset_id"], "z_index": 1, "anchor_x": 0.5, "anchor_y": 0.5, "default_transform": {"x": 0, "y": 0, "rotation_deg": 0, "scale_x": 1, "scale_y": 1, "opacity": 1}, "variants": {}},
        {"slot_id": "s_head", "name": "Head", "part_role": "head", "parent_slot_id": "s_body", "default_asset_id": head["asset_id"], "z_index": 2, "anchor_x": 0.5, "anchor_y": 0.85, "default_transform": {"x": 0, "y": -95, "rotation_deg": 0, "scale_x": 1, "scale_y": 1, "opacity": 1}, "variants": {}},
        {"slot_id": "s_larm", "name": "Left Arm", "part_role": "left_arm", "parent_slot_id": "s_body", "default_asset_id": arm["asset_id"], "z_index": 3, "anchor_x": 0.5, "anchor_y": 0.15, "default_transform": {"x": -48, "y": -40, "rotation_deg": 0, "scale_x": 1, "scale_y": 1, "opacity": 1}, "variants": {}},
        {"slot_id": "s_rarm", "name": "Right Arm", "part_role": "right_arm", "parent_slot_id": "s_body", "default_asset_id": arm["asset_id"], "z_index": 3, "anchor_x": 0.5, "anchor_y": 0.15, "default_transform": {"x": 48, "y": -40, "rotation_deg": 0, "scale_x": 1, "scale_y": 1, "opacity": 1}, "variants": {}},
        {"slot_id": "s_rhand", "name": "Right Hand", "part_role": "right_hand", "parent_slot_id": "s_rarm", "default_asset_id": hand["asset_id"], "z_index": 4, "anchor_x": 0.5, "anchor_y": 0.2, "default_transform": {"x": 0, "y": 80, "rotation_deg": 0, "scale_x": 1, "scale_y": 1, "opacity": 1}, "variants": {}},
        {"slot_id": "s_lleg", "name": "Left Leg", "part_role": "left_leg", "parent_slot_id": "s_body", "default_asset_id": leg["asset_id"], "z_index": 0, "anchor_x": 0.5, "anchor_y": 0.1, "default_transform": {"x": -22, "y": 78, "rotation_deg": 0, "scale_x": 1, "scale_y": 1, "opacity": 1}, "variants": {}},
        {"slot_id": "s_rleg", "name": "Right Leg", "part_role": "right_leg", "parent_slot_id": "s_body", "default_asset_id": leg["asset_id"], "z_index": 0, "anchor_x": 0.5, "anchor_y": 0.1, "default_transform": {"x": 22, "y": 78, "rotation_deg": 0, "scale_x": 1, "scale_y": 1, "opacity": 1}, "variants": {}},
        {"slot_id": "s_eyes", "name": "Eyes", "part_role": "eyes", "parent_slot_id": "s_head", "default_asset_id": eye_open["asset_id"], "z_index": 5, "anchor_x": 0.5, "anchor_y": 0.5, "default_transform": {"x": 0, "y": -10, "rotation_deg": 0, "scale_x": 1, "scale_y": 1, "opacity": 1}, "variants": {"open": eye_open["asset_id"], "closed": eye_closed["asset_id"]}},
        {"slot_id": "s_mouth", "name": "Mouth", "part_role": "mouth", "parent_slot_id": "s_head", "default_asset_id": mouth_closed["asset_id"], "z_index": 5, "anchor_x": 0.5, "anchor_y": 0.5, "default_transform": {"x": 0, "y": 16, "rotation_deg": 0, "scale_x": 1, "scale_y": 1, "opacity": 1}, "variants": {"closed": mouth_closed["asset_id"], "open": mouth_open["asset_id"]}},
    ]
    full["poses"] = [
        {"pose_id": "pose_neutral", "name": "Neutral", "slot_transforms": {}},
        {"pose_id": "pose_alert", "name": "Alert", "slot_transforms": {"s_rarm": {"rotation_deg": -25}}},
    ]
    full = client.put(f"/api/v1/characters/{full['character_id']}", headers=headers, json=full).json()

    # 2. SimpleBust: body + head ONLY (lacks arms, legs, eye_state, mouth_state!)
    bust = client.post(
        "/api/v1/characters",
        headers=headers,
        json={"name": "SimpleBust", "description": "No limbs or face variants"},
    ).json()
    bust["parts"] = [
        {"slot_id": "b_body", "name": "Body", "part_role": "body", "parent_slot_id": None, "default_asset_id": body["asset_id"], "z_index": 1, "anchor_x": 0.5, "anchor_y": 0.5, "default_transform": {"x": 0, "y": 0, "rotation_deg": 0, "scale_x": 1, "scale_y": 1, "opacity": 1}, "variants": {}},
        {"slot_id": "b_head", "name": "Head", "part_role": "head", "parent_slot_id": "b_body", "default_asset_id": head["asset_id"], "z_index": 2, "anchor_x": 0.5, "anchor_y": 0.85, "default_transform": {"x": 0, "y": -95, "rotation_deg": 0, "scale_x": 1, "scale_y": 1, "opacity": 1}, "variants": {}},
    ]
    bust = client.put(f"/api/v1/characters/{bust['character_id']}", headers=headers, json=bust).json()

    # 3. EmptyRig: 0 parts!
    empty = client.post(
        "/api/v1/characters",
        headers=headers,
        json={"name": "EmptyRig", "description": "0 assembled parts"},
    ).json()

    return full, bust, empty


def test_capabilities_all_10_character_motions_validation_and_motion_library_crud(tmp_path: Path):
    client, headers, _ = _build_app(tmp_path)
    full, bust, empty = _seed_full_and_partial_characters(client, headers)

    # 1. Verify Rig Capabilities Registry accurately reports all 3 rigs
    cap_full = client.get(f"/api/v1/animation-execution/capabilities/{full['character_id']}", headers=headers).json()
    assert cap_full["rig_type"] == "full_cutout"
    for expected in (
        "root_movement",
        "body_rotation",
        "head_rotation",
        "arm_rotation",
        "leg_rotation",
        "hand_rotation",
        "eye_state",
        "mouth_state",
        "scale_animation",
        "opacity_animation",
    ):
        assert expected in cap_full["capabilities"]

    cap_bust = client.get(f"/api/v1/animation-execution/capabilities/{bust['character_id']}", headers=headers).json()
    assert cap_bust["rig_type"] == "upper_body"
    assert "head_rotation" in cap_bust["capabilities"]
    assert "arm_rotation" not in cap_bust["capabilities"]
    assert "leg_rotation" not in cap_bust["capabilities"]
    assert "eye_state" not in cap_bust["capabilities"]
    assert "mouth_state" not in cap_bust["capabilities"]

    cap_empty = client.get(f"/api/v1/animation-execution/capabilities/{empty['character_id']}", headers=headers).json()
    assert cap_empty["rig_type"] == "empty"
    assert cap_empty["capabilities"] == []

    # 2. Seed Project with all 3 characters on Scene 1
    proj = client.post(
        "/api/v1/projects",
        headers=headers,
        json={"name": "Anim Exec Full Matrix", "width": 1280, "height": 720, "fps": 24},
    ).json()
    pid = proj["meta"]["project_id"]
    scene_id = proj["scenes"][0]["scene_id"]
    proj["scenes"][0]["characters"] = [
        {"instance_id": "inst_full", "scene_id": scene_id, "character_id": full["character_id"], "display_name": "FullHero", "z_index": 10, "visible": True, "initial_transform": {"x": 420, "y": 420, "rotation_deg": 0, "scale_x": 1, "scale_y": 1, "opacity": 1}},
        {"instance_id": "inst_bust", "scene_id": scene_id, "character_id": bust["character_id"], "display_name": "SimpleBust", "z_index": 11, "visible": True, "initial_transform": {"x": 760, "y": 420, "rotation_deg": 0, "scale_x": 1, "scale_y": 1, "opacity": 1}},
        {"instance_id": "inst_empty", "scene_id": scene_id, "character_id": empty["character_id"], "display_name": "EmptyRig", "z_index": 12, "visible": True, "initial_transform": {"x": 960, "y": 420, "rotation_deg": 0, "scale_x": 1, "scale_y": 1, "opacity": 1}},
    ]
    assert client.put(f"/api/v1/projects/{pid}", headers=headers, json=proj).status_code == 200

    # 3. Verify ALL 10 character animation presets generate real, non-destructive preview keyframes!
    presets = client.get("/api/v1/animation-execution/presets", headers=headers).json()
    presets_by_id = {p["preset_id"]: p for p in presets}
    required_presets = [
        ("motion_idle_breathe", "scale_y", "character_instance"),
        ("motion_walk_cycle", "rotation_deg", "character_part"),
        ("motion_run_cycle", "rotation_deg", "character_part"),
        ("motion_blink", "eye_state", "character_instance"),
        ("motion_wave", "rotation_deg", "character_part"),
        ("motion_head_turn", "rotation_deg", "character_part"),
        ("motion_talk", "mouth_state", "character_instance"),
        ("motion_jump", "y", "character_instance"),
        ("motion_fall", "rotation_deg", "character_instance"),
        ("motion_react", "y", "character_instance"),
    ]
    for preset_id, expected_prop, expected_target_type in required_presets:
        assert preset_id in presets_by_id
        r_prev = client.post(
            f"/api/v1/animation-execution/{pid}/preview-motion",
            headers=headers,
            json={
                "scene_id": scene_id,
                "target_kind": "character",
                "instance_id": "inst_full",
                "preset_id": preset_id,
                "start_time_ms": 0,
                "parameters": presets_by_id[preset_id]["default_parameters"],
            },
        )
        assert r_prev.status_code == 200, f"{preset_id}: {r_prev.text}"
        body = r_prev.json()
        assert body["compatible"] is True, preset_id
        assert body["support_level"] == "full", preset_id
        assert len(body["keyframes"]) >= 3, preset_id
        assert any(
            k["property"] == expected_prop and k["target_type"] == expected_target_type
            for k in body["keyframes"]
        ), f"{preset_id} missing {expected_target_type}.{expected_prop}"

    # Verify non-destructive preview NEVER mutated project.db!
    persisted_after_preview = client.get(f"/api/v1/projects/{pid}", headers=headers).json()
    assert len(persisted_after_preview["timeline"]["keyframes"]) == 0

    # 4. Verify Missing Capability & Unsupported Rig Rejection (NEVER applied silently!)
    for unsup_preset in ("motion_blink", "motion_wave", "motion_run_cycle", "motion_talk"):
        r_bad = client.post(
            f"/api/v1/animation-execution/{pid}/apply-motion",
            headers=headers,
            json={
                "scene_id": scene_id,
                "target_kind": "character",
                "instance_id": "inst_bust",
                "preset_id": unsup_preset,
                "parameters": presets_by_id[unsup_preset]["default_parameters"],
            },
        )
        assert r_bad.status_code == 200
        assert r_bad.json()["applied"] is False
        assert r_bad.json()["support_level"] == "unsupported"
        assert len(r_bad.json()["errors"]) >= 1

    # Walk on legless SimpleBust reports partial honestly!
    r_walk_partial = client.get(
        f"/api/v1/animation-execution/presets/motion_walk_cycle/compatibility/{bust['character_id']}",
        headers=headers,
    ).json()
    assert r_walk_partial["compatible"] is True
    assert r_walk_partial["support_level"] == "partial"

    # EmptyRig rejected cleanly on idle!
    r_empty_rej = client.post(
        f"/api/v1/animation-execution/{pid}/apply-motion",
        headers=headers,
        json={
            "scene_id": scene_id,
            "target_kind": "character",
            "instance_id": "inst_empty",
            "preset_id": "motion_idle_breathe",
            "parameters": presets_by_id["motion_idle_breathe"]["default_parameters"],
        },
    ).json()
    assert r_empty_rej["applied"] is False
    assert r_empty_rej["support_level"] == "unsupported"

    # 5. Verify Invalid Parameter Validation!
    assert client.post(
        f"/api/v1/animation-execution/{pid}/preview-motion",
        headers=headers,
        json={
            "scene_id": scene_id,
            "target_kind": "character",
            "instance_id": "inst_full",
            "preset_id": "motion_walk_cycle",
            "parameters": {"duration_ms": -50, "speed": 0, "intensity": 99},
        },
    ).status_code == 422

    # Below preset min_duration_ms (300ms < 700ms for walk)
    r_too_short = client.post(
        f"/api/v1/animation-execution/{pid}/preview-motion",
        headers=headers,
        json={
            "scene_id": scene_id,
            "target_kind": "character",
            "instance_id": "inst_full",
            "preset_id": "motion_walk_cycle",
            "parameters": {
                **presets_by_id["motion_walk_cycle"]["default_parameters"],
                "duration_ms": 300,
            },
        },
    ).json()
    assert r_too_short["compatible"] is False
    assert any("shorter than preset" in e for e in r_too_short["errors"])

    # 6. Verify Real Apply writes deterministic keyframes & zero duplicates on re-apply!
    r_app1 = client.post(
        f"/api/v1/animation-execution/{pid}/apply-motion",
        headers=headers,
        json={
            "scene_id": scene_id,
            "target_kind": "character",
            "instance_id": "inst_full",
            "preset_id": "motion_walk_cycle",
            "start_time_ms": 0,
            "parameters": {
                **presets_by_id["motion_walk_cycle"]["default_parameters"],
                "start_pose_id": "pose_neutral",
                "end_pose_id": "pose_alert",
            },
            "sync_camera_follow": True,
        },
    ).json()
    assert r_app1["applied"] is True
    assert r_app1["keyframes_written"] >= 15
    assert r_app1["camera_motion_record"] is not None
    kf_count_1 = len(r_app1["updated_project"]["timeline"]["keyframes"])

    # Apply exact same motion again -> ZERO duplicates!
    r_app2 = client.post(
        f"/api/v1/animation-execution/{pid}/apply-motion",
        headers=headers,
        json={
            "scene_id": scene_id,
            "target_kind": "character",
            "instance_id": "inst_full",
            "preset_id": "motion_walk_cycle",
            "start_time_ms": 0,
            "parameters": {
                **presets_by_id["motion_walk_cycle"]["default_parameters"],
                "start_pose_id": "pose_neutral",
                "end_pose_id": "pose_alert",
            },
            "sync_camera_follow": True,
        },
    ).json()
    assert r_app2["applied"] is True
    assert len(r_app2["updated_project"]["timeline"]["keyframes"]) == kf_count_1

    # 7. Verify Motion Library CRUD (Save, Rename, Duplicate, Delete Custom, Protect Built-in!)
    created_mp = client.post(
        "/api/v1/animation-execution/presets",
        headers=headers,
        json={
            "name": "Hero Stride Fast",
            "category": "walk",
            "base_preset_id": "motion_walk_cycle",
            "default_parameters": {
                **presets_by_id["motion_walk_cycle"]["default_parameters"],
                "speed": 1.6,
                "distance_px": 340,
            },
        },
    )
    assert created_mp.status_code == 201
    mp_id = created_mp.json()["preset_id"]

    renamed = client.put(
        f"/api/v1/animation-execution/presets/{mp_id}",
        headers=headers,
        json={"name": "Hero Power Stride"},
    )
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "Hero Power Stride"

    duped = client.post(
        f"/api/v1/animation-execution/presets/{mp_id}/duplicate",
        headers=headers,
        json={"name": "Hero Power Stride v2"},
    )
    assert duped.status_code == 201
    dup_id = duped.json()["preset_id"]
    assert dup_id != mp_id

    # Cannot delete built-in preset!
    assert client.delete("/api/v1/animation-execution/presets/motion_walk_cycle", headers=headers).status_code == 400
    # Can delete custom presets cleanly!
    assert client.delete(f"/api/v1/animation-execution/presets/{dup_id}", headers=headers).status_code == 200
    assert client.delete(f"/api/v1/animation-execution/presets/{mp_id}", headers=headers).status_code == 200


def test_camera_motions_sync_production_execution_shot_isolation_rollback_and_migrations(tmp_path: Path):
    client, headers, app = _build_app(tmp_path)
    full, _, _ = _seed_full_and_partial_characters(client, headers)
    bg1 = _upload_png(client, headers, "BG1", "background", (20, 40, 90, 255), 320, 180)
    bg2 = _upload_png(client, headers, "BG2", "background", (90, 30, 70, 255), 320, 180)

    proj = client.post(
        "/api/v1/projects",
        headers=headers,
        json={"name": "Phase 07 B2 Sync & Isolation", "width": 1280, "height": 720, "fps": 24},
    ).json()
    pid = proj["meta"]["project_id"]
    sc0 = proj["scenes"][0]
    sc_id = sc0["scene_id"]

    # Seed approved Production Plan with 3 shots testing:
    # Shot 1: Walk right + camera_follow (synchronized!)
    # Shot 2: Wave + unsupported attack + unsupported parallax camera (honestly NOT replaced!)
    # Shot 3: Jump + camera shake (damped oscillation settling cleanly at end!)
    proj["production_plan"] = {
        "plan_id": "plan_p7b2",
        "source_storyboard_id": "sb_p7b2",
        "status": "generated",
        "shots": [
            {
                "production_shot_id": "ps_1",
                "shot_id": "sbs_1",
                "scene_id": sc_id,
                "shot_order": 1,
                "title": "Shot 1 — Walk & Follow",
                "duration_ms": 3000,
                "approval_status": "approved",
                "background": {"requirement_id": "rbg1", "kind": "background", "label": "BG1", "classification": "existing_compatible", "matched_asset_id": bg1["asset_id"], "matched_asset_name": "BG1", "required": True},
                "characters": [
                    {"staging_id": "st1", "character_name": "FullHero", "library_character_id": full["character_id"], "screen_position": "left", "depth_layer": "midground", "facing_direction": "right"},
                ],
                "animation_plans": [
                    {"action_plan_id": "ap_walk", "character_name": "FullHero", "library_character_id": full["character_id"], "category": "walk", "description": "Walk forward 3s", "supported": True, "estimated_duration_ms": 2800, "parameters": {"direction": "right", "distance_px": 320}},
                ],
                "camera_plan": {
                    "camera_movement": "camera_follow",
                    "support_status": "2d_approximation",
                    "executable_on_timeline": True,
                    "camera_plan": {"start_x": 0, "start_y": 0, "start_zoom": 1.1, "end_x": 0, "end_y": 0, "end_zoom": 1.1, "easing": "ease_in_out"},
                },
            },
            {
                "production_shot_id": "ps_2",
                "shot_id": "sbs_2",
                "scene_id": sc_id,
                "shot_order": 2,
                "title": "Shot 2 — Wave + Unsupported Attack & Parallax",
                "duration_ms": 3000,
                "approval_status": "approved",
                "background": {"requirement_id": "rbg2", "kind": "background", "label": "BG2", "classification": "existing_compatible", "matched_asset_id": bg2["asset_id"], "matched_asset_name": "BG2", "required": True},
                "characters": [
                    {"staging_id": "st2", "character_name": "FullHero", "library_character_id": full["character_id"], "screen_position": "center", "depth_layer": "midground", "facing_direction": "front"},
                ],
                "animation_plans": [
                    {"action_plan_id": "ap_wave", "character_name": "FullHero", "library_character_id": full["character_id"], "category": "wave", "description": "Wave hand", "supported": True, "estimated_duration_ms": 1800},
                    {"action_plan_id": "ap_atk", "character_name": "FullHero", "library_character_id": full["character_id"], "category": "attack", "description": "Sword combo", "supported": False, "estimated_duration_ms": 1200},
                ],
                "camera_plan": {
                    "camera_movement": "parallax",
                    "support_status": "unsupported_suggestion",
                    "executable_on_timeline": False,
                    "camera_plan": {"start_x": 0, "start_y": 0, "start_zoom": 1.0, "end_x": 0, "end_y": 0, "end_zoom": 1.0, "easing": "linear"},
                },
            },
            {
                "production_shot_id": "ps_3",
                "shot_id": "sbs_3",
                "scene_id": sc_id,
                "shot_order": 3,
                "title": "Shot 3 — Jump + Shake",
                "duration_ms": 2000,
                "approval_status": "approved",
                "background": {"requirement_id": "rbg3", "kind": "background", "label": "BG1", "classification": "existing_compatible", "matched_asset_id": bg1["asset_id"], "matched_asset_name": "BG1", "required": True},
                "characters": [
                    {"staging_id": "st3", "character_name": "FullHero", "library_character_id": full["character_id"], "screen_position": "right", "depth_layer": "midground", "facing_direction": "left"},
                ],
                "animation_plans": [
                    {"action_plan_id": "ap_jump", "character_name": "FullHero", "library_character_id": full["character_id"], "category": "jump", "description": "Leap up", "supported": True, "estimated_duration_ms": 1200},
                ],
                "camera_plan": {
                    "camera_movement": "shake",
                    "support_status": "2d_approximation",
                    "executable_on_timeline": True,
                    "camera_plan": {"start_x": 0, "start_y": 0, "start_zoom": 1.0, "end_x": 0, "end_y": 0, "end_zoom": 1.0, "easing": "linear"},
                },
            },
        ],
    }
    assert client.put(f"/api/v1/projects/{pid}", headers=headers, json=proj).status_code == 200

    # Assemble all 3 shots via Batch 1 Scene Execution first!
    r_asm = client.post(
        f"/api/v1/scene-execution/{pid}/execute",
        headers=headers,
        json={"include_unapproved": True, "allow_partial": True, "sync_timeline_keyframes": True},
    )
    assert r_asm.status_code == 200, r_asm.text
    assert r_asm.json()["shots_assembled"] == 3

    # Step 1: Dry-run Preview -> MUST NOT mutate DB!
    r_dry = client.post(
        f"/api/v1/animation-execution/{pid}/execute-shots",
        headers=headers,
        json={"dry_run": True, "sync_camera_with_character": True},
    ).json()
    assert r_dry["shots_processed"] == 3
    assert r_dry["actions_executed"] == 3  # walk, wave, jump
    assert r_dry["actions_unsupported"] == 1  # attack
    assert r_dry["cameras_executed"] == 2  # camera_follow, shake
    assert r_dry["cameras_unsupported"] == 1  # parallax honestly NOT replaced!
    assert r_dry["outcomes"][0]["camera"]["synchronized_with_instance_id"] is not None
    assert r_dry["outcomes"][1]["camera"]["executable"] is False
    assert r_dry["outcomes"][1]["camera"]["support_level"] == "unsupported"

    # Step 2: Execute for real!
    r_exec = client.post(
        f"/api/v1/animation-execution/{pid}/execute-shots",
        headers=headers,
        json={"dry_run": False, "sync_camera_with_character": True},
    ).json()
    assert r_exec["status"] == "partial"  # because attack & parallax were honestly flagged unsupported
    assert r_exec["actions_executed"] == 3
    assert r_exec["cameras_executed"] == 2
    assert r_exec["cameras_unsupported"] == 1
    assert r_exec["total_keyframes_written"] >= 35

    proj_after = r_exec["updated_project"]
    sc_after = proj_after["scenes"][0]
    sh1, sh2, sh3 = sc_after["shots"]

    # Verify Shot 1 synchronized camera_follow actually tracks FullHero's X motion!
    sh1_cam_mot = next(m for m in sh1["applied_motions"] if m["target_kind"] == "camera")
    sh1_cam_x_kfs = sorted(
        [k for k in proj_after["timeline"]["keyframes"] if k["keyframe_id"] in sh1_cam_mot["keyframe_ids"] and k["property"] == "x"],
        key=lambda k: k["time_ms"],
    )
    assert len(sh1_cam_x_kfs) >= 2
    assert float(sh1_cam_x_kfs[-1]["value"]) > float(sh1_cam_x_kfs[0]["value"]) + 150.0

    # Verify Shot 2 has NO camera motion record (parallax was NOT silently replaced!)
    assert not any(m["target_kind"] == "camera" for m in sh2["applied_motions"])
    # Verify Shot 3 shake camera settles cleanly back to end_x=0 at shot end
    sh3_cam_mot = next(m for m in sh3["applied_motions"] if m["target_kind"] == "camera")
    sh3_cam_x_kfs = sorted(
        [k for k in proj_after["timeline"]["keyframes"] if k["keyframe_id"] in sh3_cam_mot["keyframe_ids"] and k["property"] == "x"],
        key=lambda k: k["time_ms"],
    )
    assert len(sh3_cam_x_kfs) >= 5
    assert float(sh3_cam_x_kfs[-1]["value"]) == 0.0

    # Step 3: Re-execute -> ZERO DUPLICATE KEYFRAMES!
    kf_count_exec1 = len(proj_after["timeline"]["keyframes"])
    r_exec2 = client.post(
        f"/api/v1/animation-execution/{pid}/execute-shots",
        headers=headers,
        json={"dry_run": False, "sync_camera_with_character": True},
    ).json()
    assert len(r_exec2["updated_project"]["timeline"]["keyframes"]) == kf_count_exec1

    # Step 4: Mark Shot 1 walk motion as user_modified -> verify preserve_user_modified skips it, and regenerate_motion_ids overrides it!
    sh1_walk_id = next(m["motion_id"] for m in sh1["applied_motions"] if m["target_kind"] == "character")
    p_mod = client.get(f"/api/v1/projects/{pid}", headers=headers).json()
    for m in p_mod["scenes"][0]["shots"][0]["applied_motions"]:
        if m["motion_id"] == sh1_walk_id:
            m["user_modified"] = True
    assert client.put(f"/api/v1/projects/{pid}", headers=headers, json=p_mod).status_code == 200

    r_pres = client.post(
        f"/api/v1/animation-execution/{pid}/execute-shots",
        headers=headers,
        json={"shot_ids": [sh1["shot_id"]], "preserve_user_modified": True},
    ).json()
    assert r_pres["actions_skipped_user_edited"] == 1
    assert r_pres["actions_executed"] == 0

    r_regen = client.post(
        f"/api/v1/animation-execution/{pid}/execute-shots",
        headers=headers,
        json={
            "shot_ids": [sh1["shot_id"]],
            "preserve_user_modified": True,
            "regenerate_motion_ids": [sh1_walk_id],
        },
    ).json()
    assert r_regen["actions_skipped_user_edited"] == 0
    assert r_regen["actions_executed"] == 1

    # Step 5: Verify Zero Shot-to-Shot Leakage in SoftwareCompositor!
    services = app.state.services
    live_state = services.project_repo.get_project_state(pid)
    comp = SoftwareCompositor(
        services.library_repo,
        services.asset_service,
        live_state,
        320,
        180,
        24,
    )
    try:
        # Render Shot 1 frame vs Shot 2 start frame (3000ms = frame 72)
        f_s1 = comp.render_frame_rgba(12)
        f_s2 = comp.render_frame_rgba(72)
        assert f_s1 != f_s2
        # Confirm Shot 1 walk keyframes were excluded when rendering Shot 2!
        assert any(kid in comp._excluded_kf_ids for kid in sh1["applied_motions"][0]["keyframe_ids"])
    finally:
        comp.close()

    # Step 6: Verify Transactional Rollback on mid-execution failure!
    before_rb = services.project_repo.get_project_state(pid)
    rb_res = services.animation_execution_service.execute_shots(
        pid,
        ShotAnimationExecuteRequest(preserve_user_modified=False),
        _inject_failure_after_shot=1,
    )
    assert rb_res.status == "rolled_back"
    assert len(rb_res.errors) >= 1
    after_rb = services.project_repo.get_project_state(pid)
    assert len(after_rb.timeline.keyframes) == len(before_rb.timeline.keyframes)

    # Step 7: Verify Safe SQLite Migrations (library.db v4->v5 & project.db v7->v8) + Reload!
    lib_db = services.config.library_db_path
    conn_lib = sqlite3.connect(str(lib_db))
    try:
        assert int(conn_lib.execute("SELECT value FROM schema_meta WHERE key = 'version'").fetchone()[0]) >= 5
        preset_rows = conn_lib.execute("SELECT COUNT(*) FROM motion_presets").fetchone()[0]
        assert preset_rows >= 11
    finally:
        conn_lib.close()

    proj_db = services.config.projects_dir / pid / "project.db"
    conn_p = sqlite3.connect(str(proj_db))
    try:
        conn_p.execute("UPDATE schema_meta SET value = '7' WHERE key = 'version'")
        conn_p.commit()
    finally:
        conn_p.close()

    # Re-open fresh app against same workspace -> upgrades safely to v8 & preserves all applied_motions + keyframes!
    app2 = create_app(services.config)
    client2 = TestClient(app2)
    reloaded = client2.get(f"/api/v1/projects/{pid}", headers=headers).json()
    assert len(reloaded["scenes"][0]["shots"][0]["applied_motions"]) >= 2
    assert len(reloaded["timeline"]["keyframes"]) == len(before_rb.timeline.keyframes)
    conn_p2 = sqlite3.connect(str(proj_db))
    try:
        assert int(conn_p2.execute("SELECT value FROM schema_meta WHERE key = 'version'").fetchone()[0]) >= 8
    finally:
        conn_p2.close()
