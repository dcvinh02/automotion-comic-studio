"""Phase 04 integration tests for Script Engine persistence, Voice Providers, Audio Assets & v1->v2 migration."""

from __future__ import annotations

import sqlite3
from pathlib import Path
from fastapi.testclient import TestClient

from app.config import AppConfig
from app.main import create_app


def _make_client(tmp_path: Path) -> tuple[TestClient, dict[str, str], AppConfig]:
    cfg = AppConfig(workspace_dir=tmp_path / "workspace", auth_token="phase04-secret")
    app = create_app(cfg)
    return TestClient(app), {"X-AMCS-Token": "phase04-secret"}, cfg


def test_script_persistence_character_ref_and_reopen(tmp_path: Path):
    client, headers, _ = _make_client(tmp_path)

    # Create character & project
    char = client.post(
        "/api/v1/characters",
        headers=headers,
        json={"name": "Minh", "description": "Protagonist"},
    ).json()
    proj = client.post(
        "/api/v1/projects",
        headers=headers,
        json={"name": "Episode 01 — Script Test", "duration_ms": 15000},
    ).json()
    pid = proj["meta"]["project_id"]

    # Populate structured script with scenes, dialogue, narration, action
    proj["script"] = {
        "episode_title": "Tập 1: Đêm Mưa",
        "raw_source_text": "Original untouched script text.",
        "scenes": [
            {
                "script_scene_id": "ssc_1",
                "order_index": 0,
                "title": "Cảnh 1 — Phòng Làm Việc",
                "location": "Phòng làm việc",
                "time_of_day": "Đêm",
                "description": "Mưa rơi ngoài cửa sổ.",
                "character_ids": [char["character_id"]],
                "notes": "Giữ nhịp chậm.",
                "entries": [
                    {
                        "entry_id": "ent_1",
                        "entry_type": "narration",
                        "order_index": 0,
                        "narrator_label": "Narrator",
                        "text": "Đêm đó trời đổ mưa lớn.",
                        "emotion": "calm",
                        "delivery_style": "slow",
                        "pause_before_ms": 200,
                        "pause_after_ms": 400,
                        "estimated_duration_ms": 2800,
                    },
                    {
                        "entry_id": "ent_2",
                        "entry_type": "dialogue",
                        "order_index": 1,
                        "character_id": char["character_id"],
                        "text": "Chúng ta phải hoàn thành bản thảo ngay đêm nay!",
                        "emotion": "determined",
                        "delivery_style": "normal",
                        "pause_before_ms": 0,
                        "pause_after_ms": 300,
                        "estimated_duration_ms": 3500,
                    },
                ],
                "estimated_duration_ms": 6300,
            }
        ],
    }

    save_res = client.put(f"/api/v1/projects/{pid}", headers=headers, json=proj)
    assert save_res.status_code == 200

    # Rename character -> script entry still holds stable character_id reference!
    upd_char = client.put(
        f"/api/v1/characters/{char['character_id']}",
        headers=headers,
        json={"name": "Minh (Renamed)"},
    ).json()
    assert upd_char["name"] == "Minh (Renamed)"

    # Reopen project and verify all script data survived verbatim
    reloaded = client.get(f"/api/v1/projects/{pid}", headers=headers).json()
    assert reloaded["script"]["episode_title"] == "Tập 1: Đêm Mưa"
    assert reloaded["script"]["raw_source_text"] == "Original untouched script text."
    assert len(reloaded["script"]["scenes"]) == 1
    entries = reloaded["script"]["scenes"][0]["entries"]
    assert len(entries) == 2
    assert entries[1]["character_id"] == char["character_id"]
    assert entries[1]["text"] == "Chúng ta phải hoàn thành bản thảo ngay đêm nay!"


def test_voice_providers_profiles_generation_preview_and_error_handling(tmp_path: Path):
    client, headers, _ = _make_client(tmp_path)

    # 1. List providers -> dev_mock and f5_tts must always exist
    providers = client.get("/api/v1/voice/providers", headers=headers).json()
    by_id = {p["provider_id"]: p for p in providers}
    assert "dev_mock" in by_id
    assert by_id["dev_mock"]["is_mock"] is True
    assert by_id["dev_mock"]["is_configured"] is True
    assert "f5_tts" in by_id
    assert by_id["f5_tts"]["is_mock"] is False
    assert by_id["f5_tts"]["is_configured"] is False

    # 2. Create character & voice profile & assign voice to character
    char = client.post("/api/v1/characters", headers=headers, json={"name": "Lan"}).json()
    prof = client.post(
        "/api/v1/voice/profiles",
        headers=headers,
        json={
            "name": "Lan Dev Mock",
            "provider_id": "dev_mock",
            "provider_voice_id": "mock_tone_high",
            "language": "vi-VN",
            "settings": {"speed": 1.1, "pitch": 2},
        },
    )
    assert prof.status_code == 201
    profile = prof.json()

    assigned = client.put(
        f"/api/v1/voice/characters/{char['character_id']}/assign",
        headers=headers,
        json={"voice_profile_id": profile["voice_profile_id"]},
    )
    assert assigned.status_code == 200
    assert assigned.json()["voice_profile_id"] == profile["voice_profile_id"]

    # 3. Create project & test unconfigured provider error handling (F5-TTS returns 422 clearly!)
    proj = client.post(
        "/api/v1/projects",
        headers=headers,
        json={"name": "Voice Pipeline Test", "duration_ms": 10000},
    ).json()
    pid = proj["meta"]["project_id"]

    err_res = client.post(
        "/api/v1/voice/generate",
        headers=headers,
        json={
            "project_id": pid,
            "text": "Hello F5-TTS",
            "provider_id": "f5_tts",
        },
    )
    assert err_res.status_code == 422
    assert "AMCS_F5_TTS_URL" in err_res.json()["detail"]

    # 4. Generate audio via character's assigned profile (dev_mock)
    gen_res = client.post(
        "/api/v1/voice/generate",
        headers=headers,
        json={
            "project_id": pid,
            "entry_id": "ent_voice_1",
            "character_id": char["character_id"],
            "text": "Xin chào, đây là câu thoại thử nghiệm cho quy trình giọng đọc.",
        },
    )
    assert gen_res.status_code == 201
    audio = gen_res.json()
    assert audio["is_mock"] is True
    assert audio["duration_ms"] >= 500
    assert len(audio["waveform_peaks"]) > 20
    assert audio["file_path"].startswith("audio/voice/")

    # 5. Serve real WAV bytes for audio preview
    wav_res = client.get(
        f"/api/v1/voice/audio/{pid}/{audio['audio_asset_id']}/file",
        headers=headers,
    )
    assert wav_res.status_code == 200
    assert wav_res.content[:4] == b"RIFF"

    # 6. Register generated audio as a timeline SoundAsset for Voice Track
    reg_res = client.post(
        f"/api/v1/voice/audio/{pid}/{audio['audio_asset_id']}/register-sound",
        headers=headers,
        json={"label": "Lan Line 1"},
    )
    assert reg_res.status_code == 200
    assert "[MOCK]" in reg_res.json()["name"]

    # 7. If macOS local_os_tts is available, verify real non-mock spoken synthesis too!
    if "local_os_tts" in by_id and by_id["local_os_tts"]["is_configured"]:
        local_voice = by_id["local_os_tts"]["voices"][0]["voice_id"]
        real_res = client.post(
            "/api/v1/voice/generate",
            headers=headers,
            json={
                "project_id": pid,
                "text": "Testing real offline speech.",
                "provider_id": "local_os_tts",
                "provider_voice_id": local_voice,
                "settings": {"speed": 1.0},
            },
        )
        assert real_res.status_code == 201
        real_audio = real_res.json()
        assert real_audio["is_mock"] is False
        assert real_audio["provider_kind"] == "local_os_tts"
        assert real_audio["duration_ms"] >= 400


def test_v1_project_db_migrates_safely_without_data_loss(tmp_path: Path):
    client, headers, cfg = _make_client(tmp_path)
    proj = client.post(
        "/api/v1/projects",
        headers=headers,
        json={"name": "Legacy V1 Project", "duration_ms": 8000},
    ).json()
    pid = proj["meta"]["project_id"]

    # Simulate legacy v1 project_state table lacking script_json column
    db_path = cfg.project_db_path(pid)
    conn = sqlite3.connect(db_path)
    try:
        row = conn.execute("SELECT scenes_json, timeline_json, updated_at FROM project_state WHERE id = 1").fetchone()
        conn.execute("DROP TABLE project_state")
        conn.execute(
            "CREATE TABLE project_state (id INTEGER PRIMARY KEY CHECK (id = 1), scenes_json TEXT NOT NULL, timeline_json TEXT NOT NULL, updated_at TEXT NOT NULL)"
        )
        conn.execute(
            "INSERT INTO project_state (id, scenes_json, timeline_json, updated_at) VALUES (1, ?, ?, ?)",
            row,
        )
        conn.commit()
    finally:
        conn.close()

    # Opening via API auto-migrates project_state cleanly and preserves scenes/timeline
    reopened = client.get(f"/api/v1/projects/{pid}", headers=headers)
    assert reopened.status_code == 200
    body = reopened.json()
    assert body["meta"]["name"] == "Legacy V1 Project"
    assert len(body["scenes"]) == 1
    assert body["script"]["episode_title"] == "Legacy V1 Project"
