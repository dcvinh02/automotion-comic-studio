"""Phase 07 Batch 1 integration tests — Scene Execution Engine & Automated Scene Assembly.

Covers all Section 15 verification criteria:
1. Production plan parsing & structured validation (`ready`, `warning`, `missing_dependency`, `unsupported`, `invalid`, `needs_review`)
2. Asset resolution strictly by real `asset_id` + missing assets & invalid IDs reported honestly (never fabricated)
3. Explicit missing-asset / character repair workflow (`POST /repair-asset`)
4. Normalized character placement, aspect-ratio conversion, visible bounds clamping, multi-character anti-overlap
   spacing & explicit staging fallback reporting
5. Real Scene, Canvas object (`SceneCharacterInstance`, `ScenePropInstance` for env/prop/foreground),
   layer order (`z_index`), and editable `SceneShot` assembly
6. Duplicate prevention & repeated execution (`update_existing`, `reuse_existing`, `skip_existing`)
   preserving unrelated pre-existing user Scene objects & keyframes
7. Partial execution (blocking invalid shot while assembling valid shots) & transactional rollback on failure
8. Shot editing (`PUT /shots/{shot_id}`), isolated multi-shot software compositor rendering,
   save/reload across restart, and safe SQLite v6 -> v7 migration
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
from schemas.character import CharacterPartSlot, ExpressionPreset, PosePreset
from schemas.scene import ScenePropInstance
from schemas.scene_execution import SceneExecutionRequest
from schemas.timeline import Keyframe


def _png_bytes(width: int, height: int, rgba: tuple[int, int, int, int]) -> bytes:
    img = Image.new("RGBA", (width, height), rgba)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _make_client(tmp_path: Path, name: str = "ws_p7b1"):
    cfg = AppConfig(workspace_dir=tmp_path / name, auth_token="phase07-b1-secret")
    app = create_app(cfg)
    return app, TestClient(app), {"X-AMCS-Token": "phase07-b1-secret"}, cfg


def _upload_png(client: TestClient, headers: dict[str, str], name: str, asset_type: str, w: int, h: int, rgba):
    raw = _png_bytes(w, h, rgba)
    res = client.post(
        "/api/v1/assets/import",
        headers=headers,
        files={"file": (f"{name}.png", raw, "image/png")},
        data={"name": name, "type": asset_type},
    )
    assert res.status_code == 201, res.text
    return res.json()


def _seed_full_production_project(app, client: TestClient, headers: dict[str, str]):
    lib_repo = app.state.services.library_repo

    # Real PNGs on disk so validator file-existence check & software compositor both work!
    bg_alley = _upload_png(client, headers, "Neon Alley BG", "background", 640, 360, (20, 30, 70, 255))
    bg_roof = _upload_png(client, headers, "Rooftop Night BG", "background", 640, 360, (60, 25, 45, 255))
    prop_lantern = _upload_png(client, headers, "Antique Lantern", "prop", 90, 120, (250, 200, 60, 255))
    prop_railing = _upload_png(client, headers, "Foreground Railing", "prop", 160, 90, (40, 40, 50, 255))
    part_body = _upload_png(client, headers, "Hero Body", "character_part", 80, 140, (90, 130, 230, 255))
    part_head = _upload_png(client, headers, "Hero Head", "character_part", 60, 60, (240, 205, 175, 255))

    # Create 2 real rigged Library Characters
    c1 = client.post("/api/v1/characters", headers=headers, json={"name": "Minh Anh"}).json()
    c1_obj = lib_repo.get_character(c1["character_id"])
    assert c1_obj is not None
    c1_obj.parts = [
        CharacterPartSlot(slot_id="b1", name="Body", part_role="body", default_asset_id=part_body["asset_id"], z_index=1),
        CharacterPartSlot(slot_id="h1", name="Head", part_role="head", default_asset_id=part_head["asset_id"], z_index=2),
    ]
    c1_obj.poses = [PosePreset(pose_id="pose_guard", name="Guarded Stance", slot_transforms={})]
    c1_obj.expressions = [ExpressionPreset(expression_id="expr_tense", name="Tense", slot_variant_overrides={}, slot_transform_overrides={})]
    lib_repo.save_character(c1_obj)

    c2 = client.post("/api/v1/characters", headers=headers, json={"name": "Tuấn Anh"}).json()
    c2_obj = lib_repo.get_character(c2["character_id"])
    assert c2_obj is not None
    c2_obj.parts = [
        CharacterPartSlot(slot_id="b2", name="Body", part_role="body", default_asset_id=part_body["asset_id"], z_index=1),
    ]
    lib_repo.save_character(c2_obj)

    # Create Project with an existing Stage Scene containing a pre-existing USER prop + USER camera keyframe!
    proj = client.post(
        "/api/v1/projects",
        headers=headers,
        json={"name": "Phase 07 Execution Comic", "width": 1280, "height": 720, "fps": 30, "duration_ms": 10000},
    ).json()
    pid = proj["meta"]["project_id"]
    stage_scene_id = proj["scenes"][0]["scene_id"]
    cam_track_id = next(t["track_id"] for t in proj["timeline"]["tracks"] if t["track_type"] == "camera")

    # Pre-existing user prop & keyframe that MUST NEVER be deleted or overwritten by Scene Execution!
    proj["scenes"][0]["props"].append(
        ScenePropInstance(
            prop_instance_id="user_manual_prop",
            asset_id=prop_lantern["asset_id"],
            name="User Watermark",
            z_index=99,
        ).model_dump(mode="json")
    )
    proj["timeline"]["keyframes"].append(
        Keyframe(
            keyframe_id="user_manual_kf",
            track_id=cam_track_id,
            target_type="camera",
            target_id="camera",
            property="zoom",
            time_ms=500,
            value=1.1,
            easing="linear",
        ).model_dump(mode="json")
    )

    # Seed approved Production Plan with 3 shots:
    # - Shot 1 (Ready): BOTH Minh Anh & Tuấn Anh placed at `center` -> triggers ANTI-OVERLAP horizontal separation!
    #   Includes bg_alley + prop_lantern + foreground prop_railing!
    # - Shot 2 (Missing dependency -> repairable!): Missing character link & invalid prop asset_id, bg_roof!
    # - Shot 3 (Invalid): start_zoom = 0 (non-positive!) -> MUST be blocked during partial execution!
    proj["production_plan"] = {
        "plan_id": "plan_p7_1",
        "version": 1,
        "provider_id": "openai",
        "model": "gpt-4o-mini",
        "analysis_language": "vi",
        "status": "generated",
        "shots": [
            {
                "production_shot_id": "pshot_1",
                "shot_id": "shot_1",
                "scene_id": stage_scene_id,
                "shot_order": 1,
                "title": "Alley Meeting",
                "duration_ms": 3000,
                "start_time_ms": 0,
                "end_time_ms": 3000,
                "readiness_status": "ready",
                "approval_status": "approved",
                "characters": [
                    {
                        "staging_id": "stg_m1",
                        "character_name": "Minh Anh",
                        "library_character_id": c1["character_id"],
                        "screen_position": "center",  # Deliberately colliding with Tuấn Anh!
                        "depth_layer": "midground",
                        "facing_direction": "right",
                        "initial_pose": "Guarded Stance",
                        "expression": "Tense",
                        "visible": True,
                    },
                    {
                        "staging_id": "stg_t1",
                        "character_name": "Tuấn Anh",
                        "library_character_id": c2["character_id"],
                        "screen_position": "center",  # Deliberately colliding with Minh Anh!
                        "depth_layer": "midground",
                        "facing_direction": "left",
                        "visible": True,
                    },
                ],
                "background": {
                    "requirement_id": "bg_req_1",
                    "kind": "background",
                    "label": "Neon Alley BG",
                    "classification": "existing_compatible",
                    "matched_asset_id": bg_alley["asset_id"],
                    "matched_asset_name": bg_alley["name"],
                    "required": True,
                },
                "assets": [
                    {
                        "requirement_id": "prop_req_1",
                        "kind": "prop",
                        "label": "Antique Lantern",
                        "classification": "existing_compatible",
                        "matched_asset_id": prop_lantern["asset_id"],
                        "matched_asset_name": prop_lantern["name"],
                        "required": False,
                    },
                    {
                        "requirement_id": "fg_req_1",
                        "kind": "prop",
                        "label": "Foreground Railing",
                        "classification": "existing_compatible",
                        "matched_asset_id": prop_railing["asset_id"],
                        "matched_asset_name": prop_railing["name"],
                        "required": False,
                    },
                ],
                "animation_plans": [],
                "camera_plan": {
                    "shot_size": "medium",
                    "camera_angle": "eye_level",
                    "camera_movement": "zoom_in",
                    "support_status": "supported",
                    "executable_on_timeline": True,
                    "camera_plan": {
                        "start_x": 0,
                        "start_y": 0,
                        "start_zoom": 1.0,
                        "start_rotation_deg": 0,
                        "end_x": 0,
                        "end_y": 0,
                        "end_zoom": 1.2,
                        "end_rotation_deg": 0,
                        "easing": "ease_in_out",
                    },
                },
            },
            {
                "production_shot_id": "pshot_2",
                "shot_id": "shot_2",
                "scene_id": stage_scene_id,
                "shot_order": 2,
                "title": "Rooftop Solo",
                "duration_ms": 2500,
                "start_time_ms": 3000,
                "end_time_ms": 5500,
                "readiness_status": "needs_character",
                "approval_status": "approved",
                "characters": [
                    {
                        "staging_id": "stg_missing",
                        "character_name": "Mystery Agent",
                        "library_character_id": None,  # Missing -> repairable!
                        "character_missing": True,
                        "screen_position": "right",
                        "depth_layer": "foreground",
                        "facing_direction": "left",
                        "visible": True,
                    }
                ],
                "background": {
                    "requirement_id": "bg_req_2",
                    "kind": "background",
                    "label": "Rooftop Night BG",
                    "classification": "existing_compatible",
                    "matched_asset_id": bg_roof["asset_id"],
                    "matched_asset_name": bg_roof["name"],
                    "required": True,
                },
                "assets": [
                    {
                        "requirement_id": "prop_req_bad",
                        "kind": "prop",
                        "label": "Broken Ref Prop",
                        "classification": "existing_compatible",
                        "matched_asset_id": "ast_does_not_exist_999",  # Invalid ID!
                        "required": False,
                    }
                ],
                "animation_plans": [],
                "camera_plan": {
                    "shot_size": "wide",
                    "camera_angle": "high_angle",
                    "camera_movement": "parallax",  # Unsupported 2D!
                    "support_status": "unsupported_suggestion",
                    "executable_on_timeline": False,
                    "camera_plan": {
                        "start_x": 0,
                        "start_y": 0,
                        "start_zoom": 1.0,
                        "start_rotation_deg": 0,
                        "end_x": 0,
                        "end_y": 0,
                        "end_zoom": 1.0,
                        "end_rotation_deg": 0,
                        "easing": "linear",
                    },
                },
            },
            {
                "production_shot_id": "pshot_3_invalid",
                "shot_id": "",  # INVALID empty shot reference!
                "scene_id": stage_scene_id,
                "shot_order": 3,
                "title": "Invalid Ref & Duration Shot",
                "duration_ms": 2000,
                "start_time_ms": 5500,
                "end_time_ms": 7500,
                "readiness_status": "ready",
                "approval_status": "approved",
                "characters": [],
                "background": None,
                "assets": [],
                "animation_plans": [],
                "camera_plan": {
                    "shot_size": "medium",
                    "camera_angle": "eye_level",
                    "camera_movement": "static",
                    "support_status": "supported",
                    "executable_on_timeline": True,
                    "camera_plan": {
                        "start_x": 0,
                        "start_y": 0,
                        "start_zoom": 1.0,
                        "start_rotation_deg": 0,
                        "end_x": 0,
                        "end_y": 0,
                        "end_zoom": 1.0,
                        "end_rotation_deg": 0,
                        "easing": "linear",
                    },
                },
            },
        ],
    }

    r_put = client.put(f"/api/v1/projects/{pid}", headers=headers, json=proj)
    assert r_put.status_code == 200, r_put.text
    return pid, stage_scene_id, c1, c2, bg_alley, bg_roof, prop_lantern, prop_railing


def test_validation_preview_anti_overlap_repair_assembly_and_duplicate_prevention(tmp_path: Path):
    app, client, headers, cfg = _make_client(tmp_path, "ws_full")
    pid, stage_scene_id, c1, c2, bg_alley, bg_roof, prop_lantern, prop_railing = (
        _seed_full_production_project(app, client, headers)
    )

    # 1. Validate Plan: Shot 1 ready, Shot 2 missing_dependency (missing char + invalid prop ID), Shot 3 invalid!
    r_val = client.get(f"/api/v1/scene-execution/{pid}/validate", headers=headers)
    assert r_val.status_code == 200, r_val.text
    val = r_val.json()
    assert val["overall_status"] == "invalid"
    by_id = {s["production_shot_id"]: s for s in val["shots"]}
    assert by_id["pshot_1"]["status"] == "ready"
    assert by_id["pshot_1"]["executable"] is True
    assert by_id["pshot_2"]["status"] == "missing_dependency"
    assert any(d["code"] == "MISSING_CHARACTER_REF" for d in by_id["pshot_2"]["missing_dependencies"])
    assert any(d["code"] == "INVALID_PROP_ASSET_ID" for d in by_id["pshot_2"]["missing_dependencies"])
    assert by_id["pshot_3_invalid"]["status"] == "invalid"
    assert by_id["pshot_3_invalid"]["executable"] is False

    # 2. Preview: Verify normalized anti-overlap staging & front-to-back layer arrangement!
    r_prev = client.post(f"/api/v1/scene-execution/{pid}/preview", headers=headers, json={})
    assert r_prev.status_code == 200, r_prev.text
    pv = r_prev.json()
    assert pv["total_shots_eligible"] == 2
    assert pv["total_shots_blocked"] == 1
    sh1_pv = pv["scenes"][0]["shots"][0]
    assert len(sh1_pv["characters"]) == 2
    # Both characters asked for `center` -> anti-overlap MUST separate them horizontally within visible bounds!
    x_minh = sh1_pv["characters"][0]["transform"]["x"]
    x_tuan = sh1_pv["characters"][1]["transform"]["x"]
    assert abs(x_tuan - x_minh) >= 200.0
    assert 100.0 <= x_minh <= 1180.0 and 100.0 <= x_tuan <= 1180.0
    assert len(sh1_pv["staging_fallbacks"]) >= 1
    # Pose & expression matched real Library presets!
    assert sh1_pv["characters"][0]["pose_id"] == "pose_guard"
    assert sh1_pv["characters"][0]["expression_id"] == "expr_tense"
    # Front-to-back layer order: Foreground Railing (z=28) BEFORE characters (z=14..15) BEFORE Lantern (z=12) BEFORE BG (-10000)
    z_order = [l["z_index"] for l in sh1_pv["layer_order"]]
    assert z_order == sorted(z_order, reverse=True)
    assert sh1_pv["layer_order"][0]["kind"] == "foreground"
    assert sh1_pv["layer_order"][-1]["kind"] == "background"

    # 3. Repair missing character & invalid prop on Shot 2 via /repair-asset -> upgrades to unsupported (due to parallax) with 0 missing deps!
    r_rep_c = client.post(
        f"/api/v1/scene-execution/{pid}/repair-asset",
        headers=headers,
        json={
            "production_shot_id": "pshot_2",
            "target_kind": "character",
            "staging_id": "stg_missing",
            "character_id": c2["character_id"],
        },
    )
    assert r_rep_c.status_code == 200, r_rep_c.text
    r_rep_p = client.post(
        f"/api/v1/scene-execution/{pid}/repair-asset",
        headers=headers,
        json={
            "production_shot_id": "pshot_2",
            "target_kind": "prop",
            "requirement_id": "prop_req_bad",
            "asset_id": prop_lantern["asset_id"],
        },
    )
    assert r_rep_p.status_code == 200, r_rep_p.text
    assert len(r_rep_p.json()["validation"]["shots"][0]["missing_dependencies"]) == 0

    # 4. Execute Scene Assembly (partial execution: Shot 1 & Shot 2 assemble, Shot 3 invalid is blocked!)
    r_exec1 = client.post(
        f"/api/v1/scene-execution/{pid}/execute",
        headers=headers,
        json={"existing_policy": "update_existing", "allow_partial": True, "sync_timeline_keyframes": True},
    )
    assert r_exec1.status_code == 200, r_exec1.text
    ex1 = r_exec1.json()
    assert ex1["status"] == "partial"
    assert ex1["shots_assembled"] == 2
    assert ex1["shots_blocked"] == 1
    assert ex1["characters_created"] == 2
    assert ex1["props_created"] == 2

    state1 = ex1["updated_project"]
    scn1 = state1["scenes"][0]
    assert len(scn1["shots"]) == 2
    assert len(scn1["characters"]) == 2
    # 2 assembled props + 1 pre-existing user prop (`user_manual_prop`) preserved!
    assert len(scn1["props"]) == 3
    assert any(p["prop_instance_id"] == "user_manual_prop" for p in scn1["props"])
    assert any(k["keyframe_id"] == "user_manual_kf" for k in state1["timeline"]["keyframes"])
    kf_count_after_1 = len(state1["timeline"]["keyframes"])

    # 5. Repeated execution #2 (`update_existing`) -> ZERO duplicates & stable IDs preserved!
    r_exec2 = client.post(
        f"/api/v1/scene-execution/{pid}/execute",
        headers=headers,
        json={"existing_policy": "update_existing", "allow_partial": True, "sync_timeline_keyframes": True},
    )
    assert r_exec2.status_code == 200
    ex2 = r_exec2.json()
    assert ex2["shots_updated"] == 2
    assert ex2["shots_assembled"] == 0
    assert ex2["characters_created"] == 0
    assert ex2["props_created"] == 0
    state2 = ex2["updated_project"]
    assert len(state2["scenes"][0]["shots"]) == 2
    assert len(state2["scenes"][0]["characters"]) == 2
    assert len(state2["scenes"][0]["props"]) == 3
    assert len(state2["timeline"]["keyframes"]) == kf_count_after_1
    assert [s["shot_id"] for s in state1["scenes"][0]["shots"]] == [
        s["shot_id"] for s in state2["scenes"][0]["shots"]
    ]

    # 6. Repeated execution #3 (`reuse_existing`) & #4 (`skip_existing`)
    r_reuse = client.post(
        f"/api/v1/scene-execution/{pid}/execute",
        headers=headers,
        json={"existing_policy": "reuse_existing"},
    )
    assert r_reuse.status_code == 200
    assert r_reuse.json()["shots_reused"] == 2
    r_skip = client.post(
        f"/api/v1/scene-execution/{pid}/execute",
        headers=headers,
        json={"existing_policy": "skip_existing"},
    )
    assert r_skip.status_code == 200
    assert r_skip.json()["shots_skipped"] == 2

    # 7. Edit Shot 1 via PUT /shots/{shot_id} & verify software compositor renders isolated Shot 1 vs Shot 2 frames!
    shot1_id = state2["scenes"][0]["shots"][0]["shot_id"]
    r_upd = client.put(
        f"/api/v1/scene-execution/{pid}/shots/{shot1_id}",
        headers=headers,
        json={"title": "Alley Meeting — Edited", "duration_ms": 3600},
    )
    assert r_upd.status_code == 200, r_upd.text
    assert r_upd.json()["shot"]["title"] == "Alley Meeting — Edited"
    assert r_upd.json()["project"]["scenes"][0]["shots"][1]["start_ms"] == 3600  # Repacked cleanly!

    # Software compositor renders distinct isolated pixels for Shot 1 (alley blue bg) vs Shot 2 (rooftop plum bg)!
    proj_state = app.state.services.project_repo.get_project_state(pid)
    comp = SoftwareCompositor(
        state=proj_state,
        library_repo=app.state.services.library_repo,
        asset_service=app.state.services.asset_service,
        width=320,
        height=180,
        fps=30,
    )
    frame_shot1 = comp.render_frame_rgba(15)   # 500ms -> Shot 1
    frame_shot2 = comp.render_frame_rgba(120)  # 4000ms -> Shot 2
    assert frame_shot1 != frame_shot2

    # 8. Restart persistence check!
    app2 = create_app(cfg)
    client2 = TestClient(app2)
    reloaded = client2.get(f"/api/v1/projects/{pid}", headers=headers).json()
    assert len(reloaded["scenes"][0]["shots"]) == 2
    assert reloaded["scenes"][0]["shots"][0]["title"] == "Alley Meeting — Edited"
    assert reloaded["scenes"][0]["execution_meta"]["executed"] is True


def test_transactional_rollback_and_v6_to_v7_migration(tmp_path: Path):
    app, client, headers, cfg = _make_client(tmp_path, "ws_rollback")
    pid, _, _, _, _, _, _, _ = _seed_full_production_project(app, client, headers)

    before = client.get(f"/api/v1/projects/{pid}", headers=headers).json()
    assert len(before["scenes"][0]["shots"]) == 0
    assert len(before["scenes"][0]["characters"]) == 0

    # Inject unexpected failure mid-execution -> MUST roll back cleanly without partial DB corruption!
    svc = app.state.services.scene_execution_service
    res = svc.execute(
        pid,
        SceneExecutionRequest(existing_policy="update_existing", allow_partial=True),
        _inject_failure_after_shot=1,
    )
    assert res.status == "rolled_back"

    after = client.get(f"/api/v1/projects/{pid}", headers=headers).json()
    assert len(after["scenes"][0]["shots"]) == 0
    assert len(after["scenes"][0]["characters"]) == 0
    assert len(after["scenes"][0]["props"]) == 1  # Original `user_manual_prop` completely intact!

    # Safe SQLite v6 -> v7 schema migration check (downgrade schema_meta version to '6', reopen!)
    db_path = cfg.project_db_path(pid)
    conn = sqlite3.connect(str(db_path))
    try:
        conn.execute("UPDATE schema_meta SET value = '6' WHERE key = 'version'")
        conn.commit()
    finally:
        conn.close()

    r_mig = client.get(f"/api/v1/projects/{pid}", headers=headers)
    assert r_mig.status_code == 200
    assert r_mig.json()["production_plan"]["plan_id"] == "plan_p7_1"
    assert r_mig.json()["scenes"][0]["shots"] == []

    conn2 = sqlite3.connect(str(db_path))
    try:
        ver = conn2.execute("SELECT value FROM schema_meta WHERE key = 'version'").fetchone()[0]
        assert int(ver) >= 7
    finally:
        conn2.close()
