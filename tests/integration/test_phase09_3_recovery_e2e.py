"""Phase 09.3 — Real autosave + crash-recovery test (Tests A–E).

A real backend process and a real "editor" process (the actual useProjectStore + RecoveryStore code,
bundled with esbuild and run in Node) are started. The backend is SIGKILLed while edits are unsaved,
then the editor process is SIGKILLed (no clean shutdown). After restarting both, recovery must be
detected, validated (a corrupt recovery file must not break anything), applied, and saved.
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
BACKEND = REPO / "backend"
ESBUILD = REPO / "frontend" / "node_modules" / ".bin" / "esbuild"
TOKEN = "e2e093"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _start_backend(ws: Path, port: int) -> subprocess.Popen:
    env = {**os.environ, "AMCS_WORKSPACE_DIR": str(ws), "AMCS_AUTH_TOKEN": TOKEN, "AMCS_PORT": str(port)}
    proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(port), "--log-level", "warning"],
                            cwd=BACKEND, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(150):
        try:
            urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{port}/api/v1/health", headers={"X-AMCS-Token": TOKEN}), timeout=1)
            return proc
        except Exception:
            time.sleep(0.1)
    proc.kill()
    raise RuntimeError("backend did not start")


def _api(port: int, method: str, path: str, body=None):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", method=method, headers={"X-AMCS-Token": TOKEN, "Content-Type": "application/json"},
                                 data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read() or b"null")


def _read_until(proc: subprocess.Popen, step: str, log: list[dict]) -> dict:
    assert proc.stdout is not None
    while True:
        line = proc.stdout.readline()
        if not line:
            raise AssertionError(f"client exited before '{step}': {log} {proc.stderr.read() if proc.stderr else ''}")
        msg = json.loads(line)
        log.append(msg)
        if msg.get("step") == "error":
            raise AssertionError(msg["message"])
        if msg.get("step") == step:
            return msg


@pytest.mark.skipif(not ESBUILD.exists() or shutil.which("node") is None, reason="node/esbuild not available")
def test_autosave_backend_crash_app_crash_and_recovery(tmp_path: Path):
    bundle = tmp_path / "client.cjs"
    b = subprocess.run([str(ESBUILD), str(Path(__file__).with_name("recovery_e2e_client.ts")), "--bundle", "--platform=node", "--format=cjs",
                        f"--alias:@={REPO / 'frontend' / 'src'}", f"--outfile={bundle}", "--log-level=error"], capture_output=True, text=True)
    assert b.returncode == 0, b.stderr
    ws, rec = tmp_path / "ws", tmp_path / "userData" / "recovery"
    port = _free_port()
    backend = _start_backend(ws, port)
    try:
        pid = _api(port, "POST", "/api/v1/projects", {"name": "Truyện thử khôi phục", "duration_ms": 6000})["meta"]["project_id"]
        other = _api(port, "POST", "/api/v1/projects", {"name": "Dự án không liên quan", "duration_ms": 6000})["meta"]["project_id"]
        base = f"http://127.0.0.1:{port}"
        log: list[dict] = []
        client = subprocess.Popen(["node", str(bundle), "session", base, TOKEN, str(rec), pid], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        # Test B: edits are recognised as unsaved; Test A: the autosave path persisted real data
        assert _read_until(client, "dirty_after_edit", log)["isDirty"] is True
        assert _read_until(client, "autosaved", log) == {"step": "autosaved", "isDirty": False, "saveError": None}
        assert _api(port, "GET", f"/api/v1/projects/{pid}")["scenes"][0]["name"] == "Cảnh đã autosave"
        assert _read_until(client, "unsaved_detected", log)["isDirty"] is True
        _read_until(client, "ready_for_backend_crash", log)

        backend.send_signal(signal.SIGKILL)  # backend crashes
        backend.wait()
        client.stdin.write("go\n")
        client.stdin.flush()
        st = _read_until(client, "save_after_backend_crash", log)
        assert st["failed"] and st["saveError"] and st["isDirty"] and st["recoveryFiles"] == 1
        assert st["unhandled"] == [], f"unhandled promise rejections in editor code: {st['unhandled']}"
        _read_until(client, "ready_for_app_crash", log)
        client.send_signal(signal.SIGKILL)  # the editor/app crashes too (no clean shutdown)
        client.wait()

        # Test D/E fixtures: a corrupt recovery file and a candidate for an unrelated project
        (rec / f"{pid}__corrupt.json").write_text('{"format": "amcs-recovery", "version": 1, broken', encoding="utf-8")
        (rec / f"{other}__2026-11-21T00-00-00-000Z.json").write_text(json.dumps({
            "format": "amcs-recovery", "version": 1, "project_id": other, "project_name": "Dự án không liên quan",
            "created_at": "2026-11-21T00:00:00.000Z", "reason": "unsaved", "base_revisions": {}, "dirty_sections": ["script"],
            "sections": {"script": {"episode_title": "X", "raw_source_text": "khác", "scenes": []}},
        }), encoding="utf-8")

        backend = _start_backend(ws, port)  # restart
        r = subprocess.run(["node", str(bundle), "restart", base, TOKEN, str(rec), pid, other], capture_output=True, text=True, timeout=120)
        assert r.returncode == 0, r.stdout + r.stderr
        msgs = [json.loads(x) for x in r.stdout.splitlines()]
        start = next(m for m in msgs if m["step"] == "startup")
        done = next(m for m in msgs if m["step"] == "recovered")

        # Test C: crash detected, our candidate found with the right sections
        assert start["previousRunCrashed"] is True
        mine = [v for v in start["valid"] if v["project"] == pid]
        assert len(mine) == 1 and "subtitles" in mine[0]["sections"]
        # Test D: the corrupt file is reported, not fatal
        assert any(i["file"] == f"{pid}__corrupt.json" for i in start["invalid"])
        # Test E: unrelated project's candidate stays separate and untouched
        assert any(v["project"] == other for v in start["valid"])
        assert done["otherProjectCandidates"] == 1
        # Recovered data persisted (autosaved scene name kept, unsaved subtitle recovered), backup first
        assert done["sceneName"] == "Cảnh đã autosave"
        assert done["subtitles"] == ["Lời thoại chưa kịp lưu"]
        assert "pre_recovery" in done["backups"]
        assert done["remainingForProject"] == 0  # recovery data cleared only after a successful save
        assert _api(port, "GET", f"/api/v1/projects/{other}")["script"]["raw_source_text"] == ""  # never auto-applied
    finally:
        backend.kill()
        backend.wait()
