"""Integration tests for FastAPI REST endpoints, auth token, persistence, and QC."""

from __future__ import annotations

from pathlib import Path
import pytest
from fastapi.testclient import TestClient

from app.config import AppConfig
from app.main import create_app
from conftest import make_test_png, make_test_wav


@pytest.fixture()
def client(tmp_path: Path):
    cfg = AppConfig(workspace_dir=tmp_path / "workspace", auth_token="secret-123")
    app = create_app(cfg)
    with TestClient(app) as tc:
        yield tc


AUTH_HEADERS = {"X-AMCS-Token": "secret-123"}


def test_auth_enforcement_and_health(client: TestClient):
    # Health is public
    r = client.get("/api/v1/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"

    # Protected route rejects missing token
    assert client.get("/api/v1/projects").status_code == 401
    # Protected route accepts valid token
    assert client.get("/api/v1/projects", headers=AUTH_HEADERS).status_code == 200


def test_full_api_crud_and_reopen_flow(client: TestClient):
    # 1. Create Project
    r_proj = client.post(
        "/api/v1/projects",
        headers=AUTH_HEADERS,
        json={"name": "Comic Ep 1", "width": 1280, "height": 720, "fps": 30, "duration_ms": 6000},
    )
    assert r_proj.status_code == 201
    state = r_proj.json()
    pid = state["meta"]["project_id"]

    # 2. Import PNG assets (body, head, eyes_open, eyes_closed, mouth_closed, mouth_open)
    def upload_png(filename: str, role: str, color):
        resp = client.post(
            "/api/v1/assets/import",
            headers=AUTH_HEADERS,
            files={"file": (filename, make_test_png(120, 120, color), "image/png")},
            data={"name": filename, "type": "character_part", "part_role": role, "folder": "minh", "tags": "minh,hero"},
        )
        assert resp.status_code == 201
        return resp.json()

    body_ast = upload_png("body.png", "body", (40, 110, 210, 255))
    head_ast = upload_png("head.png", "head", (245, 205, 175, 255))
    eyes_open = upload_png("eyes_open.png", "eyes", (25, 25, 30, 255))
    eyes_closed = upload_png("eyes_closed.png", "eyes", (80, 60, 50, 255))
    mouth_closed = upload_png("mouth_closed.png", "mouth", (190, 70, 70, 255))
    mouth_open = upload_png("mouth_open.png", "mouth", (220, 40, 90, 255))

    # Serve file works with query token (needed by PixiJS / <img>)
    r_img = client.get(f"/api/v1/assets/{body_ast['asset_id']}/file?token=secret-123")
    assert r_img.status_code == 200
    assert r_img.headers["content-type"].startswith("image/")

    # 3. Assemble Character with hierarchy + expressions
    r_char = client.post(
        "/api/v1/characters",
        headers=AUTH_HEADERS,
        json={
            "name": "Minh",
            "identity_confirmed": True,
            "parts": [
                {
                    "slot_id": "slot_body",
                    "name": "Body",
                    "part_role": "body",
                    "parent_slot_id": None,
                    "default_asset_id": body_ast["asset_id"],
                    "z_index": 1,
                },
                {
                    "slot_id": "slot_head",
                    "name": "Head",
                    "part_role": "head",
                    "parent_slot_id": "slot_body",
                    "default_asset_id": head_ast["asset_id"],
                    "z_index": 2,
                    "default_transform": {"x": 0, "y": -90, "rotation_deg": 0, "scale_x": 1, "scale_y": 1, "opacity": 1},
                },
                {
                    "slot_id": "slot_eyes",
                    "name": "Eyes",
                    "part_role": "eyes",
                    "parent_slot_id": "slot_head",
                    "default_asset_id": eyes_open["asset_id"],
                    "variants": {"open": eyes_open["asset_id"], "closed": eyes_closed["asset_id"]},
                    "z_index": 3,
                },
                {
                    "slot_id": "slot_mouth",
                    "name": "Mouth",
                    "part_role": "mouth",
                    "parent_slot_id": "slot_head",
                    "default_asset_id": mouth_closed["asset_id"],
                    "variants": {"closed": mouth_closed["asset_id"], "open": mouth_open["asset_id"]},
                    "z_index": 4,
                },
            ],
            "expressions": [
                {
                    "expression_id": "expr_happy",
                    "name": "Happy",
                    "slot_variant_overrides": {"slot_eyes": "open", "slot_mouth": "open"},
                }
            ],
        },
    )
    assert r_char.status_code == 201
    char = r_char.json()

    # 4. Import SFX WAV
    r_sfx = client.post(
        "/api/v1/sounds/import",
        headers=AUTH_HEADERS,
        files={"file": ("pop.wav", make_test_wav(0.4, 660.0), "audio/wav")},
        data={
            "name": "Cartoon Pop",
            "category": "comedy",
            "tags": "pop,funny",
            "license_source": "user_imported",
            "license_usage": "verified",
        },
    )
    assert r_sfx.status_code == 201
    sfx = r_sfx.json()

    # 5. Place character + SFX into ProjectState and save
    scene = state["scenes"][0]
    scene["characters"].append(
        {
            "instance_id": "inst_minh_1",
            "scene_id": scene["scene_id"],
            "character_id": char["character_id"],
            "display_name": "Minh",
            "z_index": 10,
            "initial_transform": {"x": 400, "y": 400, "rotation_deg": 0, "scale_x": 1, "scale_y": 1, "opacity": 1},
            "default_expression_id": "expr_happy",
            "default_eye_state": "open",
            "default_mouth_state": "closed",
        }
    )
    sfx_track_id = next(t["track_id"] for t in state["timeline"]["tracks"] if t["track_type"] == "sfx")
    state["timeline"]["sound_events"].append(
        {
            "event_id": "sfx_ev_1",
            "track_id": sfx_track_id,
            "sound_id": sfx["sound_id"],
            "start_ms": 500,
            "end_ms": 900,
            "volume": 0.85,
            "speed": 1.0,
            "fade_in_ms": 20,
            "fade_out_ms": 50,
            "loop": False,
            "spatial_position": 0.0,
            "source_scene_id": scene["scene_id"],
        }
    )

    r_save = client.put(f"/api/v1/projects/{pid}?backup=true", headers=AUTH_HEADERS, json=state)
    assert r_save.status_code == 200

    # 6. Reopen project and verify state persisted identically
    r_reopen = client.get(f"/api/v1/projects/{pid}", headers=AUTH_HEADERS)
    assert r_reopen.status_code == 200
    reopened = r_reopen.json()
    assert len(reopened["scenes"][0]["characters"]) == 1
    assert len(reopened["timeline"]["sound_events"]) == 1

    # 7. Run pre-flight QC
    r_qc = client.post(f"/api/v1/render/qc/{pid}", headers=AUTH_HEADERS)
    assert r_qc.status_code == 200
    qc = r_qc.json()
    # Critical errors should be 0 (unless ffmpeg is still installing, in which case only FFMPEG_NOT_AVAILABLE)
    non_ffmpeg_criticals = [
        i for i in qc["issues"] if i["severity"] == "critical" and i["code"] != "FFMPEG_NOT_AVAILABLE"
    ]
    assert non_ffmpeg_criticals == []
