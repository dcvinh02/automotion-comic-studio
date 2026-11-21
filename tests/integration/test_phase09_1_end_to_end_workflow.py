"""Phase 09.1 — End-to-end production workflow through the real API, render and export.

Project → Script → Scene → Character/Asset → Animation → Camera → Audio → Subtitles →
Compositing → Render → Export → Reopen. Every step is verified on real data: saved project
state, section revisions, actual rendered pixels, audio sample onsets and ffprobe metadata.
"""

from __future__ import annotations

import io
import json
import subprocess
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.config import AppConfig
from app.main import create_app
from conftest import make_test_wav
from utils.ffmpeg import FFmpegLocator

H = {"X-AMCS-Token": "e2e"}
RED, GREEN, BLUE, BG = (220, 40, 40), (40, 200, 60), (40, 70, 220), "#202020"


def _png(w: int, h: int, rgb) -> bytes:
    buf = io.BytesIO()
    Image.new("RGBA", (w, h), (*rgb, 255)).save(buf, format="PNG")
    return buf.getvalue()


def _frame(ffmpeg: str, path: str, t: float, tmp: Path) -> Image.Image:
    out = tmp / f"fr_{t:.3f}_{Path(path).stem}.png"
    subprocess.run([ffmpeg, "-y", "-v", "error", "-ss", f"{t:.3f}", "-i", path, "-frames:v", "1", str(out)], check=True)
    return Image.open(out).convert("RGB")


def _is(px, rgb, tol=45) -> bool:
    return all(abs(a - b) <= tol for a, b in zip(px, rgb))


def _onsets(ffmpeg: str, path: str) -> list[float]:
    import array

    raw = subprocess.run([ffmpeg, "-v", "error", "-i", path, "-map", "0:a:0", "-ac", "1", "-ar", "8000", "-f", "s16le", "-"], capture_output=True, check=True).stdout
    a = array.array("h", raw)
    on, last = [], -1.0
    for i, v in enumerate(a):
        t = i / 8000.0
        if abs(v) > 1500 and t - last > 0.2:
            on.append(round(t, 3))
        if abs(v) > 1500:
            last = t
    return on


def _wait_job(client, pid, jid, timeout=120):
    end = time.time() + timeout
    while time.time() < end:
        j = client.get(f"/api/v1/jobs/{pid}/{jid}", headers=H).json()
        if j["status"] in ("completed", "failed", "cancelled"):
            return j
        time.sleep(0.15)
    raise TimeoutError(jid)


def test_full_production_workflow_end_to_end(tmp_path: Path):
    cfg = AppConfig(workspace_dir=tmp_path / "ws", auth_token="e2e")
    ffmpeg = FFmpegLocator.find_ffmpeg(cfg)
    if not ffmpeg or not FFmpegLocator.find_ffprobe(cfg):
        pytest.skip("FFmpeg not installed")
    app = create_app(cfg)
    with TestClient(app) as c:
        S = app.state.services
        imp = lambda name, rgb, w, h, kind="prop", role=None: S.asset_service.import_image_bytes(  # noqa: E731
            data=_png(w, h, rgb), original_filename=f"{name}.png", name=name, asset_type=kind, part_role=role, folder="e2e").asset_id
        body = imp("Thân", RED, 60, 120, "character_part", "body")
        prop_green = imp("Hộp xanh lá", GREEN, 80, 80)
        prop_blue = imp("Hộp xanh dương", BLUE, 80, 80)
        hero = c.post("/api/v1/characters", headers=H, json={
            "name": "Minh Anh", "identity_confirmed": True,
            "parts": [{"slot_id": "body", "name": "Body", "part_role": "body", "default_asset_id": body, "z_index": 1}],
        }).json()
        beep = S.sound_service.import_sound_bytes(data=make_test_wav(0.3, 700.0), original_filename="beep.wav", name="Bíp", category="ui",
                                                  license_info={"source": "user_imported", "usage": "verified"})

        # STEP 1 — PROJECT
        proj = c.post("/api/v1/projects", headers=H, json={"name": "E2E Truyện", "width": 640, "height": 360, "fps": 30, "duration_ms": 4000}).json()
        assert "meta" in proj, proj
        pid = proj["meta"]["project_id"]
        assert proj["meta"]["width"] == 640 and proj["revisions"]["meta"] >= 1

        # STEP 2 — SCRIPT: edit & save only the script section
        st = c.get(f"/api/v1/projects/{pid}", headers=H).json()
        rev_before = dict(st["revisions"])
        st["script"]["raw_source_text"] = "Cảnh 1: Minh Anh đi ngang sân.\n\nCảnh 2: Trời tối dần."
        st = c.put(f"/api/v1/projects/{pid}?dirty=script", headers=H, json=st).json()
        assert st["script"]["raw_source_text"].startswith("Cảnh 1: Minh Anh")
        assert st["revisions"]["script"] == rev_before["script"] + 1
        assert st["revisions"]["scenes"] == rev_before["scenes"] and st["revisions"]["timeline"] == rev_before["timeline"]

        # STEP 3/4 — SCENES, CHARACTER & ASSETS (character behind a green prop, then camera scene)
        sfx = next(t["track_id"] for t in st["timeline"]["tracks"] if t["track_type"] == "sfx")
        st["scenes"] = [
            {"scene_id": "sc1", "project_id": pid, "order_index": 0, "name": "Sân trường", "start_ms": 0, "duration_ms": 2000, "background_color": BG,
             "characters": [{"instance_id": "minh", "scene_id": "sc1", "character_id": hero["character_id"], "display_name": "Minh Anh",
                             "z_index": 10, "initial_transform": {"x": 120, "y": 180}}],
             "props": [{"prop_instance_id": "hop", "asset_id": prop_green, "name": "Hộp", "z_index": 20, "transform": {"x": 520, "y": 180}}]},
            {"scene_id": "sc2", "project_id": pid, "order_index": 1, "name": "Hoàng hôn", "start_ms": 2000, "duration_ms": 2000, "background_color": BG,
             "transition_in": "fade", "transition_duration_ms": 500,
             "props": [{"prop_instance_id": "hop2", "asset_id": prop_blue, "name": "Hộp 2", "transform": {"x": 320, "y": 180}}]},
        ]
        # STEP 5 — ANIMATION: character walks x 120 → 520 over 0..1000 ms (passes behind the green box)
        # STEP 6 — CAMERA: zoom 1 → 2 across scene 2
        kfs = [
            {"keyframe_id": "kx0", "track_id": sfx, "target_type": "character_instance", "target_id": "minh", "property": "x", "time_ms": 0, "value": 120, "easing": "linear"},
            {"keyframe_id": "kx1", "track_id": sfx, "target_type": "character_instance", "target_id": "minh", "property": "x", "time_ms": 1000, "value": 520, "easing": "linear"},
            {"keyframe_id": "kz0", "track_id": sfx, "target_type": "camera", "target_id": "camera", "property": "zoom", "time_ms": 2000, "value": 1.0, "easing": "linear"},
            {"keyframe_id": "kz1", "track_id": sfx, "target_type": "camera", "target_id": "camera", "property": "zoom", "time_ms": 3500, "value": 2.0, "easing": "linear"},
        ]
        st["timeline"]["keyframes"] = kfs
        # STEP 7 — AUDIO: audible beep at 0.5 s, a muted-track beep at 1.5 s, a beep at 3.0 s
        st["timeline"]["tracks"].append({"track_id": "trk_muted", "project_id": pid, "track_type": "sfx", "name": "Muted", "muted": True})
        st["timeline"]["sound_events"] = [
            {"event_id": "b1", "track_id": sfx, "sound_id": beep.sound_id, "start_ms": 500, "end_ms": 800, "volume": 1.0, "source_scene_id": "sc1"},
            {"event_id": "b2", "track_id": "trk_muted", "sound_id": beep.sound_id, "start_ms": 1500, "end_ms": 1800, "volume": 1.0},
            {"event_id": "b3", "track_id": sfx, "sound_id": beep.sound_id, "start_ms": 3000, "end_ms": 3300, "volume": 1.0, "source_scene_id": "sc2"},
        ]
        # STEP 8 — SUBTITLES (Vietnamese)
        st["subtitles"]["segments"] = [{"subtitle_id": "s1", "text": "Xin chào, tôi là Minh Anh!", "start_ms": 100, "end_ms": 1900, "scene_id": "sc1"}]
        st = c.put(f"/api/v1/projects/{pid}?dirty=scenes,timeline,subtitles", headers=H, json=st).json()
        assert [s["scene_id"] for s in st["scenes"]] == ["sc1", "sc2"]
        assert {k["keyframe_id"] for k in st["timeline"]["keyframes"]} == {"kx0", "kx1", "kz0", "kz1"}  # stable IDs, no duplicates

        # Reference integrity: in-use library items cannot be deleted silently
        r = c.delete(f"/api/v1/assets/{prop_green}", headers=H)
        assert r.status_code == 409 and r.json()["detail"]["references"][0]["name"] == "E2E Truyện"
        assert c.delete(f"/api/v1/characters/{hero['character_id']}", headers=H).status_code == 409
        assert c.get(f"/api/v1/assets/{prop_green}", headers=H).status_code == 200

        # STEP 9–11 — COMPOSITING + RENDER + EXPORT of the current state
        def export(name: str, **settings) -> dict:
            body = {"project_id": pid, "settings": {"resolution_preset": "project", "fps": 30, "quality": "high", "filename": name,
                                                   "render_mode": "software_compositor", "chunk_duration_seconds": 2, **settings}}
            r = c.post("/api/v1/render/export", headers=H, json=body)
            assert r.status_code == 202, r.text
            j = _wait_job(c, pid, r.json()["job_id"])
            assert j["status"] == "completed", j.get("error_log")
            return j

        job = export("toàn bộ", subtitles={"mode": "burn_in", "export_srt": True})
        out = job["output_json"]["output_path"]
        v = job["output_json"]["validation"]
        assert v["passed"] and (v["width"], v["height"], v["fps"], v["frame_count"]) == (640, 360, 30.0, 120)
        assert v["video_codec"] == "h264" and v["audio_codec"] == "aac" and abs(v["duration_s"] - 4.0) < 0.05

        f0 = _frame(ffmpeg, out, 0.0, tmp_path)
        f05 = _frame(ffmpeg, out, 0.5, tmp_path)
        assert _is(f0.getpixel((120, 180)), RED), "character at keyframe x=120"
        assert _is(f05.getpixel((320, 180)), RED) and not _is(f05.getpixel((120, 180)), RED), "animation moved the character"
        f1 = _frame(ffmpeg, out, 1.0, tmp_path)
        assert _is(f1.getpixel((520, 180)), GREEN), "layer order: green prop (z=20) above character (z=10)"
        lower = f1.crop((0, 270, 640, 360))
        assert sum(1 for px in lower.getdata() if sum(px) > 650) > 40, "burned-in subtitle visible"
        f_fade = _frame(ffmpeg, out, 2.1, tmp_path)
        f_full = _frame(ffmpeg, out, 2.6, tmp_path)
        assert sum(f_fade.getpixel((320, 180))) < sum(f_full.getpixel((320, 180))) * 0.6, "fade-in transition applied"
        f_zoom = _frame(ffmpeg, out, 3.9, tmp_path)
        blue_cols = sum(1 for x in range(640) if _is(f_zoom.getpixel((x, 180)), BLUE))
        blue_cols_start = sum(1 for x in range(640) if _is(f_full.getpixel((x, 180)), BLUE))
        # 80 px prop × camera zoom: zoom(2.6 s) = 1 + 0.6/1.5 = 1.4 → 112 px; zoom(3.9 s) = 2.0 → 160 px
        assert abs(blue_cols_start - 112) <= 4 and abs(blue_cols - 160) <= 4, f"camera zoom ({blue_cols_start} → {blue_cols})"
        on = _onsets(ffmpeg, out)
        assert len(on) == 2 and abs(on[0] - 0.5) < 0.04 and abs(on[1] - 3.0) < 0.04, f"audio onsets {on} (muted track must be silent)"
        srt = Path(job["output_json"]["subtitle_sidecar_path"]).read_text(encoding="utf-8")
        assert "Xin chào, tôi là Minh Anh!" in srt

        # STEP 4 (asset swap) + "render uses the CURRENT project state": swap the green prop to blue
        st = c.get(f"/api/v1/projects/{pid}", headers=H).json()
        st["scenes"][0]["props"][0]["asset_id"] = prop_blue
        st = c.put(f"/api/v1/projects/{pid}?dirty=scenes", headers=H, json=st).json()
        job2 = export("sau khi đổi", scope={"kind": "scene", "scene_ids": ["sc1"]}, audio={"enabled": False})
        f = _frame(ffmpeg, job2["output_json"]["output_path"], 1.0, tmp_path)
        assert _is(f.getpixel((520, 180)), BLUE), "render uses the swapped asset"
        assert job2["output_json"]["validation"]["frame_count"] == 60 and job2["output_json"]["audio_codec"] is None
        assert c.delete(f"/api/v1/assets/{prop_green}", headers=H).status_code == 204  # no longer referenced → allowed

    # STEP 12 — REOPEN (new process-equivalent app on the same workspace)
    app2 = create_app(cfg)
    with TestClient(app2) as c2:
        re = c2.get(f"/api/v1/projects/{pid}", headers=H).json()
        assert re["script"]["raw_source_text"].startswith("Cảnh 1: Minh Anh")
        assert re["scenes"][0]["props"][0]["asset_id"] == prop_blue
        assert [k["keyframe_id"] for k in sorted(re["timeline"]["keyframes"], key=lambda k: k["keyframe_id"])] == ["kx0", "kx1", "kz0", "kz1"]
        assert re["subtitles"]["segments"][0]["text"] == "Xin chào, tôi là Minh Anh!"
        assert re["revisions"] == st["revisions"]
        jobs = c2.get(f"/api/v1/jobs/{pid}", headers=H).json()
        assert sum(1 for j in jobs if j["status"] == "completed") == 2 and all(Path(j["output_json"]["output_path"]).is_file() for j in jobs)
        json.dumps(re)
