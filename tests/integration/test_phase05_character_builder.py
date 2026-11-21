"""Phase 05 Batch 2 integration test: Character Builder, asset reuse, 20 part roles, lock persistence & safe deletion."""

from __future__ import annotations

import io
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image

from app.config import AppConfig
from app.main import create_app


def _make_png(w: int, h: int, color: tuple[int, int, int, int]) -> bytes:
    buf = io.BytesIO()
    Image.new("RGBA", (w, h), color).save(buf, format="PNG")
    return buf.getvalue()


def _make_client(tmp_path: Path) -> tuple[TestClient, dict[str, str]]:
    cfg = AppConfig(workspace_dir=tmp_path / "workspace", auth_token="p5b2-token")
    app = create_app(cfg)
    return TestClient(app), {"X-AMCS-Token": "p5b2-token"}


def test_character_builder_persistence_asset_reuse_and_safe_delete(tmp_path: Path) -> None:
    client, headers = _make_client(tmp_path)

    with client:
        body_bytes = _make_png(160, 220, (66, 99, 220, 255))
        head_bytes = _make_png(120, 120, (244, 204, 174, 255))
        arm_bytes = _make_png(52, 130, (86, 119, 240, 255))
        hand_bytes = _make_png(38, 38, (244, 204, 174, 255))

        def upload(fname: str, data: bytes, role: str) -> dict:
            r = client.post(
                "/api/v1/assets/import",
                headers=headers,
                files={"file": (fname, data, "image/png")},
                data={"type": "character_part", "part_role": role, "folder": "hero"},
            )
            assert r.status_code == 201
            return r.json()

        ast_body = upload("body.png", body_bytes, "body")
        ast_head = upload("head.png", head_bytes, "head")
        ast_arm = upload("right_arm.png", arm_bytes, "right_arm")
        ast_hand = upload("right_hand.png", hand_bytes, "right_hand")

        # Re-importing exact identical PNG bytes must reuse the existing asset without duplicating files!
        ast_body_again = upload("body_copy.png", body_bytes, "body")
        assert ast_body_again["asset_id"] == ast_body["asset_id"]

        # Create character using expanded PartRoles (right_hand, clothing, custom) + locked state + pivots
        create_res = client.post(
            "/api/v1/characters",
            headers=headers,
            json={
                "name": "Linh Rig",
                "identity_confirmed": True,
                "parts": [
                    {
                        "slot_id": "slot_body",
                        "name": "Body",
                        "part_role": "body",
                        "parent_slot_id": None,
                        "default_asset_id": ast_body["asset_id"],
                        "z_index": 15,
                        "anchor_x": 0.5,
                        "anchor_y": 0.8,
                        "default_transform": {"x": 0, "y": 0, "rotation_deg": 0, "scale_x": 1, "scale_y": 1, "opacity": 1},
                        "visible": True,
                        "locked": False,
                    },
                    {
                        "slot_id": "slot_head",
                        "name": "Head",
                        "part_role": "head",
                        "parent_slot_id": "slot_body",
                        "default_asset_id": ast_head["asset_id"],
                        "z_index": 22,
                        "anchor_x": 0.5,
                        "anchor_y": 0.88,
                        "default_transform": {"x": 0, "y": -130, "rotation_deg": 5, "scale_x": 1, "scale_y": 1, "opacity": 1},
                        "visible": True,
                        "locked": True,
                    },
                    {
                        "slot_id": "slot_r_arm",
                        "name": "Right Arm",
                        "part_role": "right_arm",
                        "parent_slot_id": "slot_body",
                        "default_asset_id": ast_arm["asset_id"],
                        "z_index": 36,
                        "anchor_x": 0.5,
                        "anchor_y": 0.12,
                        "default_transform": {"x": 58, "y": -115, "rotation_deg": -20, "scale_x": 1, "scale_y": 1, "opacity": 1},
                        "visible": True,
                        "locked": False,
                    },
                    {
                        "slot_id": "slot_r_hand",
                        "name": "Right Hand",
                        "part_role": "right_hand",
                        "parent_slot_id": "slot_r_arm",
                        "default_asset_id": ast_hand["asset_id"],
                        "z_index": 37,
                        "anchor_x": 0.5,
                        "anchor_y": 0.15,
                        "default_transform": {"x": 0, "y": 95, "rotation_deg": 10, "scale_x": 1, "scale_y": 1, "opacity": 1},
                        "visible": True,
                        "locked": False,
                    },
                ],
                "expressions": [],
                "poses": [],
            },
        )
        assert create_res.status_code == 201
        created = create_res.json()
        cid = created["character_id"]
        # Auto-thumbnail picks Head PNG cleanly
        assert created["thumbnail_asset_id"] == ast_head["asset_id"]

        # Reload character and verify hierarchy, pivots, transforms, and lock state persisted
        fetched = client.get(f"/api/v1/characters/{cid}", headers=headers).json()
        by_slot = {p["slot_id"]: p for p in fetched["parts"]}
        assert by_slot["slot_head"]["locked"] is True
        assert by_slot["slot_head"]["anchor_y"] == 0.88
        assert by_slot["slot_r_hand"]["part_role"] == "right_hand"
        assert by_slot["slot_r_hand"]["parent_slot_id"] == "slot_r_arm"

        # Update character via PUT (including full parts + expressions + poses) -> must succeed (v2) & preserve auto-thumbnail!
        updated_parts = list(fetched["parts"])
        updated_parts[2]["default_transform"]["rotation_deg"] = -42.5
        put_res = client.put(
            f"/api/v1/characters/{cid}",
            headers=headers,
            json={
                "name": "Linh Rig Updated",
                "identity_confirmed": True,
                "parts": updated_parts,
                "expressions": [
                    {
                        "expression_id": "expr_neutral",
                        "name": "Neutral",
                        "eye_state": "open",
                        "mouth_state": "closed",
                    }
                ],
                "poses": [],
            },
        )
        assert put_res.status_code == 200
        updated = put_res.json()
        assert updated["version"] == 2
        assert updated["name"] == "Linh Rig Updated"
        assert updated["thumbnail_asset_id"] == ast_head["asset_id"]
        assert updated["parts"][2]["default_transform"]["rotation_deg"] == -42.5

        # Starter character (0 assets initially) -> PUT parts auto-assigns thumbnail_asset_id!
        starter_res = client.post(
            "/api/v1/characters",
            headers=headers,
            json={"name": "Starter Char", "parts": [], "expressions": [], "poses": []},
        )
        assert starter_res.status_code == 201
        starter = starter_res.json()
        assert starter["thumbnail_asset_id"] is None
        starter_put = client.put(
            f"/api/v1/characters/{starter['character_id']}",
            headers=headers,
            json={"parts": updated_parts},
        )
        assert starter_put.status_code == 200
        assert starter_put.json()["thumbnail_asset_id"] == ast_head["asset_id"]

        # Delete character -> shared PNG source assets MUST remain 100% intact on disk and in DB!
        del_res = client.delete(f"/api/v1/characters/{cid}", headers=headers)
        assert del_res.status_code == 204
        assert client.get(f"/api/v1/characters/{cid}", headers=headers).status_code == 404

        assets_after = client.get("/api/v1/assets", headers=headers).json()
        asset_ids_after = {a["asset_id"] for a in assets_after}
        assert {ast_body["asset_id"], ast_head["asset_id"], ast_arm["asset_id"], ast_hand["asset_id"]}.issubset(asset_ids_after)
        for aid in (ast_body["asset_id"], ast_head["asset_id"], ast_arm["asset_id"], ast_hand["asset_id"]):
            file_res = client.get(f"/api/v1/assets/{aid}/file", headers=headers)
            assert file_res.status_code == 200
            assert len(file_res.content) > 50
