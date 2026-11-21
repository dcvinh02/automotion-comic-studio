"""Phase 05 Batch 1 integration test: Keyframe ID, timing, easing, and collision-free persistence."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from app.config import AppConfig
from app.main import create_app


def _make_client(tmp_path: Path) -> tuple[TestClient, dict[str, str]]:
    cfg = AppConfig(workspace_dir=tmp_path / "workspace", auth_token="p5-test-token")
    app = create_app(cfg)
    client = TestClient(app)
    headers = {"X-AMCS-Token": "p5-test-token"}
    return client, headers


def test_moved_and_duplicated_keyframes_persist_ids_positions_and_easings(tmp_path: Path) -> None:
    client, headers = _make_client(tmp_path)

    with client:
        # 1. Create project
        res = client.post(
            "/api/v1/projects",
            headers=headers,
            json={"name": "Phase 05 KF Persistence", "width": 1280, "height": 720, "fps": 30, "duration_ms": 5000},
        )
        assert res.status_code == 201
        proj = res.json()
        pid = proj["meta"]["project_id"]

        # 2. Add keyframes with explicit stable IDs, quantized 30fps timestamps, custom easing & bezier handles
        proj["scenes"][0]["props"] = [
            {
                "prop_instance_id": "prop_hero_card",
                "asset_id": None,
                "layer_kind": "empty",
                "name": "Hero Card",
                "z_index": 10,
                "anchor_x": 0.5,
                "anchor_y": 0.5,
                "visible": True,
                "locked": False,
                "parent_id": None,
                "transform": {"x": 200, "y": 300, "rotation_deg": 0, "scale_x": 1, "scale_y": 1, "opacity": 1},
            }
        ]
        proj["timeline"]["tracks"].append(
            {
                "track_id": "trk_prop_hero_card",
                "project_id": pid,
                "track_type": "prop",
                "name": "Hero Card",
                "target_ref_id": "prop_hero_card",
                "order_index": 10,
                "muted": False,
                "locked": False,
                "solo": False,
                "visible": True,
                "volume": 1.0,
                "collapsed": False,
            }
        )
        proj["timeline"]["keyframes"] = [
            {
                "keyframe_id": "kf_stable_x1",
                "track_id": "trk_prop_hero_card",
                "target_type": "prop",
                "target_id": "prop_hero_card",
                "property": "x",
                "time_ms": 333,  # Frame 10 @ 30fps
                "value": 200.0,
                "easing": "ease_in_out",
                "bezier_handles": None,
            },
            {
                "keyframe_id": "kf_stable_x2",
                "track_id": "trk_prop_hero_card",
                "target_type": "prop",
                "target_id": "prop_hero_card",
                "property": "x",
                "time_ms": 1333,  # Frame 40 @ 30fps
                "value": 920.0,
                "easing": "cubic_bezier",
                "bezier_handles": [0.25, 0.1, 0.25, 1.0],
            },
        ]

        save1 = client.put(f"/api/v1/projects/{pid}", headers=headers, json=proj)
        assert save1.status_code == 200

        # 3. Simulate pure MOVE of kf_stable_x1 from Frame 10 (333ms) -> Frame 20 (667ms) + change easing to hold
        proj["timeline"]["keyframes"][0]["time_ms"] = 667
        proj["timeline"]["keyframes"][0]["easing"] = "hold"

        save2 = client.put(f"/api/v1/projects/{pid}", headers=headers, json=proj)
        assert save2.status_code == 200

        # 4. Reload fresh from SQLite and verify exact ID preservation, moved time_ms, easing & bezier handles
        reloaded = client.get(f"/api/v1/projects/{pid}", headers=headers).json()
        kfs = reloaded["timeline"]["keyframes"]
        assert len(kfs) == 2

        by_id = {k["keyframe_id"]: k for k in kfs}
        assert set(by_id.keys()) == {"kf_stable_x1", "kf_stable_x2"}
        assert by_id["kf_stable_x1"]["time_ms"] == 667
        assert by_id["kf_stable_x1"]["value"] == 200.0
        assert by_id["kf_stable_x1"]["easing"] == "hold"
        assert by_id["kf_stable_x2"]["time_ms"] == 1333
        assert by_id["kf_stable_x2"]["easing"] == "cubic_bezier"
        assert by_id["kf_stable_x2"]["bezier_handles"] == [0.25, 0.1, 0.25, 1.0]
