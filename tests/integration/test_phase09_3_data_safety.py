"""Phase 09.3 — Backup, restore, migration and integrity safety (controlled test projects only)."""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import AppConfig
from app.main import create_app
from conftest import make_test_png

H = {"X-AMCS-Token": "p093"}


def _app(tmp_path: Path, **kw):
    cfg = AppConfig(workspace_dir=tmp_path / "ws", auth_token="p093", **kw)
    return create_app(cfg), cfg


def _project(c: TestClient, name="Dự án an toàn") -> tuple[str, dict]:
    p = c.post("/api/v1/projects", headers=H, json={"name": name, "duration_ms": 6000}).json()
    return p["meta"]["project_id"], p


def test_retention_never_deletes_manual_backups_because_of_other_tags(tmp_path: Path):
    app, cfg = _app(tmp_path, max_backups_per_project=4)
    with TestClient(app) as c:
        pid, _ = _project(c)
        manual = [c.post(f"/api/v1/projects/{pid}/backups", headers=H).json()["filename"] for _ in range(2)]
        repo = app.state.services.project_repo
        for _ in range(12):  # e.g. many exports / sync conflicts in a row
            repo.create_backup(pid, tag="pre_export")
            repo.create_backup(pid, tag="conflict")
        names = {b["filename"] for b in c.get(f"/api/v1/projects/{pid}/backups", headers=H).json()}
        assert set(manual) <= names, "manual backups were pruned by automatic backups"
        assert any(n.startswith("project_init_") for n in names), "initial snapshot pruned"
        assert sum(n.startswith("project_pre_export_") for n in names) <= 4


def test_partial_or_corrupt_backups_are_never_listed_or_restored(tmp_path: Path):
    app, cfg = _app(tmp_path)
    with TestClient(app) as c:
        pid, st = _project(c)
        bdir = cfg.project_dir(pid) / "backups"
        (bdir / "project_manual_20990101_000000_000000.db").write_bytes(b"SQLite format 3\x00" + b"\x00" * 50)  # truncated
        listed = c.get(f"/api/v1/projects/{pid}/backups", headers=H).json()
        bad = [b for b in listed if b["filename"].startswith("project_manual_2099")]
        assert bad and bad[0]["valid"] is False
        st["meta"]["name"] = "Bản gốc còn nguyên"
        c.put(f"/api/v1/projects/{pid}?dirty=meta", headers=H, json=st)
        r = c.post(f"/api/v1/projects/{pid}/backups/project_manual_20990101_000000_000000.db/restore", headers=H)
        assert r.status_code == 422
        assert c.get(f"/api/v1/projects/{pid}", headers=H).json()["meta"]["name"] == "Bản gốc còn nguyên"


def test_backup_restore_roundtrip_of_a_full_project(tmp_path: Path):
    app, cfg = _app(tmp_path)
    with TestClient(app) as c:
        S = app.state.services
        asset = S.asset_service.import_image_bytes(data=make_test_png(32, 32), original_filename="nền.png", name="Nền", asset_type="background", folder="t")
        pid, st = _project(c)
        trk = st["timeline"]["tracks"][0]["track_id"]
        st["scenes"][0]["background_asset_id"] = asset.asset_id
        st["scenes"][0]["characters"] = [{"instance_id": "i1", "scene_id": st["scenes"][0]["scene_id"], "character_id": "c1", "display_name": "Minh"}]
        st["timeline"]["keyframes"] = [{"keyframe_id": "k1", "track_id": trk, "target_type": "character_instance", "target_id": "i1", "property": "x", "time_ms": 0, "value": 5}]
        st["subtitles"]["segments"] = [{"subtitle_id": "s1", "text": "Xin chào", "start_ms": 0, "end_ms": 800}]
        st = c.put(f"/api/v1/projects/{pid}?dirty=scenes,timeline,subtitles", headers=H, json=st).json()
        b = c.post(f"/api/v1/projects/{pid}/backups", headers=H).json()
        assert b["valid"] is True and b["tag"] == "manual"
        # damage the working copy
        st["scenes"][0]["characters"] = []
        st["timeline"]["keyframes"] = []
        st["subtitles"]["segments"][0]["text"] = "đã sửa"
        c.put(f"/api/v1/projects/{pid}?dirty=scenes,timeline,subtitles", headers=H, json=st)
        restored = c.post(f"/api/v1/projects/{pid}/backups/{b['filename']}/restore", headers=H).json()
        assert restored["scenes"][0]["characters"][0]["display_name"] == "Minh"
        assert restored["timeline"]["keyframes"][0]["keyframe_id"] == "k1"
        assert restored["subtitles"]["segments"][0]["text"] == "Xin chào"
        assert restored["scenes"][0]["background_asset_id"] == asset.asset_id
        names = [x["filename"] for x in c.get(f"/api/v1/projects/{pid}/backups", headers=H).json()]
        assert any(n.startswith("project_pre_restore_") for n in names), "state before restore must be kept"
    app2, _ = _app(tmp_path)
    with TestClient(app2) as c2:  # reopen
        assert c2.get(f"/api/v1/projects/{pid}", headers=H).json()["subtitles"]["segments"][0]["text"] == "Xin chào"


def test_newer_schema_is_refused_and_older_schema_is_backed_up_before_migration(tmp_path: Path):
    app, cfg = _app(tmp_path)
    with TestClient(app) as c:
        pid_new, _ = _project(c, "Từ bản mới hơn")
        pid_old, _ = _project(c, "Từ bản cũ")
    db_new = cfg.project_db_path(pid_new)
    con = sqlite3.connect(db_new)
    con.execute("UPDATE schema_meta SET value='999' WHERE key='version'")
    con.commit()
    con.close()
    db_old = cfg.project_db_path(pid_old)
    con = sqlite3.connect(db_old)
    con.execute("DROP TABLE section_revisions")
    con.execute("UPDATE schema_meta SET value='10' WHERE key='version'")
    con.commit()
    con.close()
    app2, _ = _app(tmp_path)
    with TestClient(app2) as c:
        r = c.get(f"/api/v1/projects/{pid_new}", headers=H)
        assert r.status_code == 409 and r.json()["detail"]["code"] == "PROJECT_VERSION_UNSUPPORTED"
        con = sqlite3.connect(db_new)
        assert con.execute("SELECT value FROM schema_meta WHERE key='version'").fetchone()[0] == "999"  # never downgraded
        con.close()
        assert c.get(f"/api/v1/projects/{pid_old}", headers=H).status_code == 200
        names = [b["filename"] for b in c.get(f"/api/v1/projects/{pid_old}/backups", headers=H).json()]
        assert any(n.startswith("project_pre_migration_") for n in names)


def test_corrupted_project_database_reports_clearly_without_crashing(tmp_path: Path):
    app, cfg = _app(tmp_path)
    with TestClient(app) as c:
        pid, _ = _project(c)
        other, _ = _project(c, "Dự án khác")
    db = cfg.project_db_path(pid)
    data = bytearray(db.read_bytes())
    for i in range(4096, min(len(data), 4096 * 6)):
        data[i] = 0xFF
    db.write_bytes(bytes(data))
    for suffix in ("-wal", "-shm"):
        Path(str(db) + suffix).unlink(missing_ok=True)
    app2, _ = _app(tmp_path)
    with TestClient(app2) as c:
        r = c.get(f"/api/v1/projects/{pid}", headers=H)
        assert r.status_code == 409 and r.json()["detail"]["code"] == "PROJECT_DB_CORRUPT"
        assert r.json()["detail"]["backups"], "valid backups must be offered for recovery"
        assert c.get(f"/api/v1/projects/{other}", headers=H).status_code == 200  # other projects unaffected
        assert c.get("/api/v1/projects", headers=H).status_code == 200


def test_save_as_integrity_relink_and_storage_cleanup(tmp_path: Path):
    app, cfg = _app(tmp_path)
    with TestClient(app) as c:
        S = app.state.services
        a1 = S.asset_service.import_image_bytes(data=make_test_png(16, 16), original_filename="cũ.png", name="Cũ", asset_type="prop", folder="t")
        a2 = S.asset_service.import_image_bytes(data=make_test_png(16, 16, (0, 200, 0, 255)), original_filename="mới.png", name="Mới", asset_type="prop", folder="t")
        pid, st = _project(c, "Gốc")
        sid = st["scenes"][0]["scene_id"]
        st["scenes"][0]["props"] = [{"prop_instance_id": "p1", "asset_id": a1.asset_id, "name": "Ghế"}]
        trk = st["timeline"]["tracks"][0]["track_id"]
        st["timeline"]["keyframes"] = [
            {"keyframe_id": "k1", "track_id": trk, "target_type": "prop", "target_id": "p1", "property": "x", "time_ms": 0, "value": 1},
            {"keyframe_id": "k_orphan", "track_id": trk, "target_type": "prop", "target_id": "gone", "property": "x", "time_ms": 0, "value": 1},
        ]
        st = c.put(f"/api/v1/projects/{pid}?dirty=scenes,timeline", headers=H, json=st).json()

        # Save As with recovered (unsaved) content → new independent project, original untouched
        recovered = dict(st)
        recovered["subtitles"] = {**st["subtitles"], "segments": [{"subtitle_id": "r1", "text": "Khôi phục", "start_ms": 0, "end_ms": 500}]}
        dup = c.post(f"/api/v1/projects/{pid}/duplicate", headers=H, json={"name": "Bản khôi phục", "state": recovered})
        assert dup.status_code == 201, dup.text
        d = dup.json()
        assert d["meta"]["project_id"] != pid and d["meta"]["name"] == "Bản khôi phục"
        assert d["subtitles"]["segments"][0]["text"] == "Khôi phục"
        assert all(s["project_id"] == d["meta"]["project_id"] for s in d["scenes"])
        assert c.get(f"/api/v1/projects/{pid}", headers=H).json()["subtitles"]["segments"] == []
        assert {p["name"] for p in c.get("/api/v1/projects", headers=H).json()} >= {"Gốc", "Bản khôi phục"}

        # Integrity: orphan keyframe reported, missing asset reported (file deleted), nothing removed
        S.asset_service.resolve_asset_file(a1).unlink()
        rep = c.get(f"/api/v1/projects/{pid}/integrity", headers=H).json()
        codes = {i["code"] for i in rep["issues"]}
        assert {"ORPHAN_KEYFRAME", "MISSING_ASSET"} <= codes and rep["ok"] is False
        assert rep["missing_assets"][0]["asset_id"] == a1.asset_id and rep["missing_assets"][0]["used_by"]
        assert len(c.get(f"/api/v1/projects/{pid}", headers=H).json()["timeline"]["keyframes"]) == 2  # diagnostic only

        # Relink to an explicitly chosen replacement (backup first); invalid target refused
        assert c.post(f"/api/v1/projects/{pid}/relink-asset", headers=H, json={"from_asset_id": a1.asset_id, "to_asset_id": "nope"}).status_code == 422
        r = c.post(f"/api/v1/projects/{pid}/relink-asset", headers=H, json={"from_asset_id": a1.asset_id, "to_asset_id": a2.asset_id})
        assert r.status_code == 200 and r.headers["x-amcs-relinked"] == "1"
        assert r.json()["scenes"][0]["props"][0]["asset_id"] == a2.asset_id
        assert any(b["filename"].startswith("project_pre_relink_") for b in c.get(f"/api/v1/projects/{pid}/backups", headers=H).json())
        assert "MISSING_ASSET" not in {i["code"] for i in c.get(f"/api/v1/projects/{pid}/integrity", headers=H).json()["issues"]}

        # Storage: orphan render temp removed; temp of a failed (retryable) job kept
        renders = cfg.project_dir(pid) / "renders"
        (renders / "job_orphan123").mkdir(parents=True)
        (renders / "job_orphan123" / "chunk_0000.mp4").write_bytes(b"x" * 5000)
        from schemas.job import RenderJob
        S.project_repo.save_job(RenderJob(job_id="job_failed01", project_id=pid, status="failed"))
        (renders / "job_failed01").mkdir()
        (renders / "job_failed01" / "chunk_0000.mp4").write_bytes(b"y" * 100)
        info = c.get(f"/api/v1/projects/{pid}/storage", headers=H).json()
        assert info["bytes"]["render_temp"] >= 5100 and info["total_bytes"] > 0
        res = c.post(f"/api/v1/projects/{pid}/storage/cleanup", headers=H).json()
        assert res["removed_render_dirs"] == ["job_orphan123"] and res["freed_bytes"] == 5000
        assert (renders / "job_failed01").is_dir()


def test_damaged_project_is_listed_and_restorable_and_delete_goes_to_trash(tmp_path: Path):
    app, cfg = _app(tmp_path)
    with TestClient(app) as c:
        pid, st = _project(c, "Sẽ bị hỏng")
        st["subtitles"]["segments"] = [{"subtitle_id": "s1", "text": "Dữ liệu quan trọng", "start_ms": 0, "end_ms": 500}]
        c.put(f"/api/v1/projects/{pid}?dirty=subtitles", headers=H, json=st)
        good = c.post(f"/api/v1/projects/{pid}/backups", headers=H).json()
    db = cfg.project_db_path(pid)
    for suffix in ("-wal", "-shm"):
        Path(str(db) + suffix).unlink(missing_ok=True)
    db.write_bytes(b"garbage, not a database" * 200)
    app2, _ = _app(tmp_path)
    with TestClient(app2) as c:
        listed = {p["project_id"]: p for p in c.get("/api/v1/projects", headers=H).json()}
        assert listed[pid]["health"] == "damaged"  # not silently hidden
        err = c.get(f"/api/v1/projects/{pid}", headers=H).json()["detail"]
        assert err["code"] == "PROJECT_DB_CORRUPT" and any(b["filename"] == good["filename"] for b in err["backups"])
        restored = c.post(f"/api/v1/projects/{pid}/backups/{good['filename']}/restore", headers=H)
        assert restored.status_code == 200, restored.text
        assert restored.json()["subtitles"]["segments"][0]["text"] == "Dữ liệu quan trọng"
        assert c.get("/api/v1/projects", headers=H).json()[0]["health"] == "ok"

        assert c.delete(f"/api/v1/projects/{pid}", headers=H).status_code == 204
        assert pid not in {p["project_id"] for p in c.get("/api/v1/projects", headers=H).json()}
        trashed = list((cfg.workspace_dir / ".trash").glob(f"{pid}__deleted_*"))
        assert len(trashed) == 1 and (trashed[0] / "project.db").is_file() and any((trashed[0] / "backups").iterdir())
