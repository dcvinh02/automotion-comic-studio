"""Phase 09.1 — Project state integrity across concurrent writers (frontend autosave vs backend services).

Reproduces two real lost-update bugs found in the audit:
1. A long-running backend job (AI Director) loaded the project, awaited the LLM, then saved its
   stale full copy → user edits autosaved during the analysis were silently reverted.
2. The frontend autosave PUT its whole in-memory copy → AI documents written by the backend in the
   meantime (director / storyboard / production plan) were wiped by the stale client copy.
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import AppConfig
from app.main import create_app
from integration.test_phase06_director import DeterministicScriptLLM, noir_analysis_payload
from schemas.subtitle import SubtitleSegment

H = {"X-AMCS-Token": "p091"}


def _app(tmp_path: Path):
    cfg = AppConfig(workspace_dir=tmp_path / "ws", auth_token="p091")
    app = create_app(cfg)
    return app, cfg


def _seed(client: TestClient) -> tuple[str, dict]:
    proj = client.post("/api/v1/projects", headers=H, json={"name": "Hẻm mưa", "duration_ms": 8000}).json()
    pid = proj["meta"]["project_id"]
    proj["script"] = {
        "episode_title": "Tập 1",
        "raw_source_text": "Mưa đêm rơi.\n\nMinh: \"Đừng đi!\"\n\nTuấn Anh bước tới.\n\nMột giọng lạ: \"Ai đó?\"",
        "scenes": [],
    }
    saved = client.put(f"/api/v1/projects/{pid}", headers=H, json=proj)
    assert saved.status_code == 200
    return pid, saved.json()


def test_backend_job_does_not_revert_user_edits_saved_during_llm_call(tmp_path: Path):
    app, _ = _app(tmp_path)
    with TestClient(app) as client:
        pid, _ = _seed(client)
        repo = app.state.services.project_repo

        async def handler(prompt, schema_name, call_idx, ev):
            # While the "LLM" is thinking, the user edits subtitles and the autosave lands in the DB.
            st = repo.get_project_state(pid)
            st.subtitles.segments.append(SubtitleSegment(subtitle_id="user_sub", text="Chỉnh sửa của người dùng", start_ms=0, end_ms=900))
            st.meta.name = "Tên mới do người dùng đặt"
            repo.save_project_state(st)
            await asyncio.sleep(0)
            return noir_analysis_payload()

        app.state.services.llm_registry.set_override_provider(DeterministicScriptLLM(handler))
        res = client.post(f"/api/v1/director/{pid}/analyze", headers=H, json={"script_source_mode": "auto"})
        assert res.status_code == 200, res.text

        final = client.get(f"/api/v1/projects/{pid}", headers=H).json()
        assert final["director"] and final["director"]["status"] == "analyzed"
        assert any(s["subtitle_id"] == "user_sub" for s in final["subtitles"]["segments"]), "user edit reverted by AI job"
        assert final["meta"]["name"] == "Tên mới do người dùng đặt"


def test_stale_client_save_does_not_wipe_backend_written_sections(tmp_path: Path):
    app, cfg = _app(tmp_path)
    with TestClient(app) as client:
        pid, client_copy = _seed(client)  # the frontend holds this copy (director = null)
        app.state.services.llm_registry.set_override_provider(
            DeterministicScriptLLM(lambda *a: noir_analysis_payload())
        )
        assert client.post(f"/api/v1/director/{pid}/analyze", headers=H, json={"script_source_mode": "auto"}).status_code == 200

        # User edits subtitles in the stale copy; autosave declares the dirty section.
        client_copy["subtitles"]["segments"].append(
            {"subtitle_id": "s1", "text": "Xin chào", "start_ms": 100, "end_ms": 900}
        )
        r = client.put(f"/api/v1/projects/{pid}?dirty=subtitles", headers=H, json=client_copy)
        assert r.status_code == 200, r.text
        assert r.headers.get("x-amcs-conflicts", "") == ""
        merged = r.json()
        assert merged["director"] is not None and merged["director"]["status"] == "analyzed"
        assert [s["subtitle_id"] for s in merged["subtitles"]["segments"]] == ["s1"]

        reopened = client.get(f"/api/v1/projects/{pid}", headers=H).json()
        assert reopened["director"]["status"] == "analyzed", "AI analysis wiped by stale autosave"
        assert reopened["subtitles"]["segments"][0]["text"] == "Xin chào"


def test_section_revisions_and_true_conflict_backup(tmp_path: Path):
    app, cfg = _app(tmp_path)
    with TestClient(app) as client:
        pid, base = _seed(client)
        rev0 = dict(base["revisions"])
        assert set(rev0) >= {"meta", "scenes", "timeline", "script", "subtitles", "director"}

        # Saving an unchanged section must not bump its revision; a changed one must.
        base["subtitles"]["segments"] = [{"subtitle_id": "a", "text": "A", "start_ms": 0, "end_ms": 500}]
        r1 = client.put(f"/api/v1/projects/{pid}?dirty=subtitles", headers=H, json=base).json()
        assert r1["revisions"]["subtitles"] == rev0["subtitles"] + 1
        assert r1["revisions"]["scenes"] == rev0["scenes"]
        assert r1["revisions"]["timeline"] == rev0["timeline"]

        # Another writer changes subtitles; a client still based on rev r1 edits them too → conflict.
        other = client.get(f"/api/v1/projects/{pid}", headers=H).json()
        other["subtitles"]["segments"][0]["text"] = "Server-side change"
        client.put(f"/api/v1/projects/{pid}?dirty=subtitles", headers=H, json=other)

        stale = dict(r1)
        stale["subtitles"] = {**r1["subtitles"], "segments": [{"subtitle_id": "a", "text": "Client change", "start_ms": 0, "end_ms": 500}]}
        before = {b["filename"] for b in client.get(f"/api/v1/projects/{pid}/backups", headers=H).json()}
        r2 = client.put(f"/api/v1/projects/{pid}?dirty=subtitles", headers=H, json=stale)
        assert r2.status_code == 200
        assert r2.headers["x-amcs-conflicts"] == "subtitles"
        assert r2.json()["subtitles"]["segments"][0]["text"] == "Client change"  # explicit latest user edit wins
        after = {b["filename"] for b in client.get(f"/api/v1/projects/{pid}/backups", headers=H).json()}
        new = after - before
        assert len(new) == 1 and "conflict" in next(iter(new)), "the overwritten version must stay recoverable"

        # Unknown section names are rejected instead of silently ignored
        assert client.put(f"/api/v1/projects/{pid}?dirty=bogus", headers=H, json=r2.json()).status_code == 400

        # Legacy clients (no dirty param) keep the old full-save behaviour
        legacy = r2.json()
        legacy["meta"]["name"] = "Legacy save"
        assert client.put(f"/api/v1/projects/{pid}", headers=H, json=legacy).json()["meta"]["name"] == "Legacy save"


def test_v10_project_db_migrates_to_revisions_without_data_loss(tmp_path: Path):
    app, cfg = _app(tmp_path)
    with TestClient(app) as client:
        pid, base = _seed(client)
    db = cfg.project_db_path(pid)
    # Simulate an older project.db (pre-Phase 09.1): drop the revisions table and downgrade version
    conn = sqlite3.connect(db)
    conn.execute("DROP TABLE section_revisions")
    conn.execute("UPDATE schema_meta SET value='10' WHERE key='version'")
    conn.commit()
    conn.close()
    app2 = create_app(cfg)
    with TestClient(app2) as client:
        st = client.get(f"/api/v1/projects/{pid}", headers=H).json()
        assert st["script"]["episode_title"] == "Tập 1" and st["meta"]["name"] == "Hẻm mưa"
        assert all(v >= 0 for v in st["revisions"].values())
    conn = sqlite3.connect(db)
    assert conn.execute("SELECT value FROM schema_meta WHERE key='version'").fetchone()[0] == "11"
    conn.close()


@pytest.mark.asyncio
async def test_backend_writes_emit_project_state_changed_events(tmp_path: Path):
    app, cfg = _app(tmp_path)
    with TestClient(app) as client:
        pid, base = _seed(client)
        events: list[dict] = []
        hub = app.state.services.ws_hub
        orig = hub.broadcast_event

        async def capture(event_type, payload):
            if event_type == "project_state_changed":
                events.append(payload)
            await orig(event_type, payload)

        hub.broadcast_event = capture  # type: ignore[method-assign]
        repo = app.state.services.project_repo
        st = repo.get_project_state(pid)
        st.subtitles.segments.append(SubtitleSegment(subtitle_id="bg", text="nền", start_ms=0, end_ms=100))
        repo.save_project_state(st)  # e.g. a background service write
        for _ in range(50):
            if events:
                break
            client.get("/api/v1/health", headers=H)  # let the loop run the scheduled broadcast
            await asyncio.sleep(0.02)
        assert events and events[-1]["project_id"] == pid and "subtitles" in events[-1]["changed_sections"]
        assert events[-1]["revisions"]["subtitles"] >= 1
        json.dumps(events[-1])


def test_qc_flags_subtitles_outdated_after_script_edit(tmp_path: Path):
    app, _ = _app(tmp_path)
    with TestClient(app) as client:
        pid, st = _seed(client)
        st["script"]["scenes"] = [{"script_scene_id": "ss1", "title": "Cảnh 1", "entries": [
            {"entry_id": "e1", "entry_type": "dialogue", "text": "Đừng đi tiếp nữa, Tuấn Anh!"},
            {"entry_id": "e2", "entry_type": "dialogue", "text": "Ai đang ở đó?"},
        ]}]
        st["subtitles"]["segments"] = [
            {"subtitle_id": "c1", "text": "Đừng đi tiếp nữa,", "start_ms": 0, "end_ms": 900, "script_entry_id": "e1"},
            {"subtitle_id": "c2", "text": "Tuấn Anh!", "start_ms": 900, "end_ms": 1500, "script_entry_id": "e1"},
            {"subtitle_id": "c3", "text": "Ai đang ở đó?", "start_ms": 1500, "end_ms": 2500, "script_entry_id": "e2"},
        ]
        st = client.put(f"/api/v1/projects/{pid}?dirty=script,subtitles", headers=H, json=st).json()
        codes = lambda: [i["subtitle_id"] for i in client.post(f"/api/v1/qc/{pid}/run", headers=H, json={}).json()["issues"] if i["code"] == "OUTDATED_SUBTITLE"]  # noqa: E731
        assert codes() == []  # split cues of an unchanged line are fine
        st["script"]["scenes"][0]["entries"][0]["text"] = "Dừng lại ngay, Tuấn Anh!"
        st["script"]["scenes"][0]["entries"].pop(1)
        client.put(f"/api/v1/projects/{pid}?dirty=script", headers=H, json=st)
        assert sorted(codes()) == ["c1", "c3"]
