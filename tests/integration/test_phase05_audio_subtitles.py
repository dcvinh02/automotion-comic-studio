"""Phase 05 Batch 3 integration test: Audio Library (SFX/BGM + CC0 Starter Pack),
Audio Timeline, Subtitle Studio (SRT/ASS, Vietnamese UTF-8), Persistence & Real Export.
"""

from __future__ import annotations

import array
import io
import math
import time
import wave
from pathlib import Path

from fastapi.testclient import TestClient

from app.config import AppConfig
from app.main import create_app
from utils.ffmpeg import FFmpegLocator, ffprobe_json


def _make_wav(duration_s: float = 0.6, freq_hz: float = 440.0, rate: int = 22050) -> bytes:
    n = int(rate * duration_s)
    pcm = array.array("h", (int(12000 * math.sin(2 * math.pi * freq_hz * i / rate)) for i in range(n)))
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(pcm.tobytes())
    return buf.getvalue()


def _make_client(tmp_path: Path) -> tuple[TestClient, dict[str, str], AppConfig]:
    cfg = AppConfig(workspace_dir=tmp_path / "workspace", auth_token="p5b3-token")
    app = create_app(cfg)
    return TestClient(app), {"X-AMCS-Token": "p5b3-token"}, cfg


def test_audio_library_sfx_bgm_separation_starter_pack_and_validation(tmp_path: Path) -> None:
    client, headers, cfg = _make_client(tmp_path)

    with client:
        # 1. Bundled CC0 Starter Pack seeded with 24 SFX + 10 BGM + License Manifest
        sfx_cats = client.get("/api/v1/sounds/categories?audio_type=sfx", headers=headers).json()
        bgm_cats = client.get("/api/v1/sounds/categories?audio_type=bgm", headers=headers).json()
        assert len(sfx_cats) == 24
        assert len(bgm_cats) == 14

        sfx_list = client.get("/api/v1/sounds?audio_type=sfx", headers=headers).json()
        bgm_list = client.get("/api/v1/sounds?audio_type=bgm", headers=headers).json()
        assert len(sfx_list) == 24
        assert len(bgm_list) == 10
        assert all(s["audio_type"] == "sfx" for s in sfx_list)
        assert all(b["audio_type"] == "bgm" for b in bgm_list)

        manifest = client.get("/api/v1/sounds/manifest", headers=headers).json()
        assert manifest["license"] == "CC0-1.0"
        assert manifest["sfx_count"] == 24
        assert manifest["bgm_count"] == 10
        assert len(manifest["assets"]) == 34

        # Bundled audio file actually streams cleanly
        first_bgm = bgm_list[0]
        stream_res = client.get(f"/api/v1/sounds/{first_bgm['sound_id']}/file", headers=headers)
        assert stream_res.status_code == 200
        assert len(stream_res.content) > 1000

        # 2. Import custom SFX and custom BGM -> kept strictly separated
        wav_sfx = _make_wav(0.5, 520.0)
        wav_bgm = _make_wav(1.0, 260.0)

        imp_sfx = client.post(
            "/api/v1/sounds/import",
            headers=headers,
            files={"file": ("custom_punch.wav", wav_sfx, "audio/wav")},
            data={
                "name": "Hero Punch",
                "audio_type": "sfx",
                "category": "punch",
                "tags": "fight,hero",
                "license_source": "user_imported",
                "license_usage": "verified",
            },
        )
        assert imp_sfx.status_code == 201
        sfx_item = imp_sfx.json()
        assert sfx_item["audio_type"] == "sfx"
        assert sfx_item["category"] == "punch"

        imp_bgm = client.post(
            "/api/v1/sounds/import",
            headers=headers,
            files={"file": ("custom_theme.wav", wav_bgm, "audio/wav")},
            data={
                "name": "Morning Theme",
                "audio_type": "bgm",
                "category": "calm",
                "tags": "morning,loop",
                "loopable": "true",
                "license_source": "cc0",
                "license_usage": "verified",
                "license_origin_source": "Studio Original",
            },
        )
        assert imp_bgm.status_code == 201
        bgm_item = imp_bgm.json()
        assert bgm_item["audio_type"] == "bgm"
        assert bgm_item["loopable"] is True

        # Search, tag filter, favorite & rename
        upd = client.patch(
            f"/api/v1/sounds/{bgm_item['sound_id']}",
            headers=headers,
            json={"name": "Morning Theme Renamed", "is_favorite": True},
        )
        assert upd.status_code == 200
        assert upd.json()["name"] == "Morning Theme Renamed"
        assert upd.json()["is_favorite"] is True

        fav_bgm = client.get("/api/v1/sounds?audio_type=bgm&favorites_only=true&tag=morning", headers=headers).json()
        assert len(fav_bgm) == 1
        assert fav_bgm[0]["sound_id"] == bgm_item["sound_id"]

        # 3. Invalid format & corrupt file rejected with HTTP 400
        bad_ext = client.post(
            "/api/v1/sounds/import",
            headers=headers,
            files={"file": ("notes.txt", b"not audio", "text/plain")},
            data={"audio_type": "sfx", "category": "ui"},
        )
        assert bad_ext.status_code == 400

        corrupt_wav = client.post(
            "/api/v1/sounds/import",
            headers=headers,
            files={"file": ("broken.wav", b"not a valid wav header", "audio/wav")},
            data={"audio_type": "sfx", "category": "ui"},
        )
        assert corrupt_wav.status_code == 400

        # 4. Missing file on disk returns clean HTTP 404
        disk_path = cfg.sounds_dir / sfx_item["file_path"]
        assert disk_path.is_file()
        disk_path.unlink()
        missing_res = client.get(f"/api/v1/sounds/{sfx_item['sound_id']}/file", headers=headers)
        assert missing_res.status_code == 404

        # 5. Delete sound cleanly
        del_res = client.delete(f"/api/v1/sounds/{sfx_item['sound_id']}", headers=headers)
        assert del_res.status_code == 204
        assert client.get(f"/api/v1/sounds/{sfx_item['sound_id']}", headers=headers).status_code == 404


def test_subtitles_srt_ass_persistence_and_real_mp4_export(tmp_path: Path) -> None:
    client, headers, cfg = _make_client(tmp_path)

    with client:
        # 1. Validate Vietnamese multiline SRT import + export SRT + export ASS
        srt_text = (
            "1\n"
            "00:00:00,200 --> 00:00:01,800\n"
            "Xin chào mọi người!\n"
            "Đây là phụ đề tiếng Việt.\n\n"
            "2\n"
            "00:00:02,000 --> 00:00:03,200\n"
            "Cảnh hai bắt đầu ngay bây giờ.\n"
        )
        imp = client.post(
            "/api/v1/subtitles/import-srt",
            headers=headers,
            json={"content": srt_text, "default_style_id": "style_bold_comic"},
        )
        assert imp.status_code == 200
        imp_data = imp.json()
        assert imp_data["valid"] is True
        assert len(imp_data["segments"]) == 2
        assert "tiếng Việt" in imp_data["segments"][0]["text"]

        exp_srt = client.post(
            "/api/v1/subtitles/export-srt",
            headers=headers,
            json={"segments": imp_data["segments"]},
        )
        assert exp_srt.status_code == 200
        assert "Xin chào mọi người!" in exp_srt.text
        assert "00:00:00,200 --> 00:00:01,800" in exp_srt.text

        exp_ass = client.post(
            "/api/v1/subtitles/export-ass",
            headers=headers,
            json={"segments": imp_data["segments"], "width": 1280, "height": 720},
        )
        assert exp_ass.status_code == 200
        assert "[V4+ Styles]" in exp_ass.text
        assert r"Xin chào mọi người!\NĐây là phụ đề tiếng Việt." in exp_ass.text

        # 2. Create project -> verify default tracks (Subtitle, Voice, SFX, BGM, Ambient) + persist audio & subtitles
        proj = client.post(
            "/api/v1/projects",
            headers=headers,
            json={
                "name": "Audio & Subtitle Studio Test",
                "width": 640,
                "height": 360,
                "fps": 15,
                "duration_ms": 3500,
            },
        ).json()
        pid = proj["meta"]["project_id"]
        track_types = {t["track_type"] for t in proj["timeline"]["tracks"]}
        assert {"scene", "camera", "subtitle", "voice", "sfx", "bgm", "ambient"}.issubset(track_types)

        sfx_track = next(t for t in proj["timeline"]["tracks"] if t["track_type"] == "sfx")
        bgm_track = next(t for t in proj["timeline"]["tracks"] if t["track_type"] == "bgm")

        # Place bundled SFX + looping BGM on audio tracks + Vietnamese subtitles + custom edited style
        proj["timeline"]["sound_events"] = [
            {
                "event_id": "ev_sfx_1",
                "track_id": sfx_track["track_id"],
                "sound_id": "starter_sfx_punch",
                "start_ms": 300,
                "end_ms": 700,
                "trim_start_ms": 0,
                "volume": 0.9,
                "speed": 1.0,
                "fade_in_ms": 20,
                "fade_out_ms": 40,
                "loop": False,
                "spatial_position": 0.0,
                "source_scene_id": proj["scenes"][0]["scene_id"],
            },
            {
                "event_id": "ev_bgm_1",
                "track_id": bgm_track["track_id"],
                "sound_id": "starter_bgm_calm",
                "start_ms": 0,
                "end_ms": 3500,
                "trim_start_ms": 100,
                "volume": 0.5,
                "speed": 1.0,
                "fade_in_ms": 200,
                "fade_out_ms": 300,
                "loop": True,
                "spatial_position": 0.0,
                "source_scene_id": None,
            },
        ]
        proj["subtitles"]["segments"] = imp_data["segments"]
        proj["subtitles"]["styles"][0]["font_size"] = 50

        save_res = client.put(f"/api/v1/projects/{pid}", headers=headers, json=proj)
        assert save_res.status_code == 200

        # Reload project from SQLite and verify exact persistence of audio clips, trims, fades, subtitles & styles
        reloaded = client.get(f"/api/v1/projects/{pid}", headers=headers).json()
        assert len(reloaded["timeline"]["sound_events"]) == 2
        assert reloaded["timeline"]["sound_events"][1]["trim_start_ms"] == 100
        assert reloaded["timeline"]["sound_events"][1]["loop"] is True
        assert len(reloaded["subtitles"]["segments"]) == 2
        assert reloaded["subtitles"]["styles"][0]["font_size"] == 50

        # 3. Export MP4 with SOFT subtitles (mov_text) + Sidecar SRT + mixed SFX/BGM audio!
        def run_export(filename: str, sub_mode: str, sidecar: bool) -> dict:
            job = client.post(
                "/api/v1/render/export",
                headers=headers,
                json={
                    "project_id": pid,
                    "preset_id": "preset_720p_preview",
                    "output_filename": filename,
                    "chunk_duration_seconds": 5,
                    "render_mode": "software_compositor",
                    "subtitle_mode": sub_mode,
                    "export_srt_sidecar": sidecar,
                    "ignore_warnings": True,
                },
            ).json()
            jid = job["job_id"]
            for _ in range(120):
                cur = client.get(f"/api/v1/jobs/{pid}/{jid}", headers=headers).json()
                if cur["status"] in ("completed", "failed", "cancelled"):
                    return cur
                time.sleep(0.15)
            raise TimeoutError(f"Export job {jid} timed out")

        soft_job = run_export("soft_subs_test.mp4", "soft", True)
        assert soft_job["status"] == "completed", soft_job.get("error_log")
        soft_out = Path(soft_job["output_json"]["output_path"])
        assert soft_out.is_file()
        assert soft_job["output_json"]["subtitle_soft_muxed"] is True

        # Verify sidecar UTF-8 .srt file exists beside the exported .mp4
        sidecar_path = Path(soft_job["output_json"]["subtitle_sidecar_path"])
        assert sidecar_path.is_file()
        assert "Xin chào mọi người!" in sidecar_path.read_text(encoding="utf-8")

        # Verify real audio stream AND mov_text subtitle stream via ffprobe!
        ffprobe = FFmpegLocator.find_ffprobe(cfg)
        assert ffprobe is not None
        probe = ffprobe_json(ffprobe, soft_out)
        stream_types = {s.get("codec_type") for s in probe.get("streams", [])}
        assert {"video", "audio", "subtitle"}.issubset(stream_types)
        sub_streams = [s for s in probe["streams"] if s.get("codec_type") == "subtitle"]
        assert sub_streams[0].get("codec_name") == "mov_text"

        # 4. Export MP4 with BURN-IN subtitles (verifies SoftwareCompositor renders Vietnamese cues cleanly!)
        burn_job = run_export("burn_in_subs_test.mp4", "burn_in", False)
        assert burn_job["status"] == "completed", burn_job.get("error_log")
        burn_out = Path(burn_job["output_json"]["output_path"])
        assert burn_out.is_file() and burn_out.stat().st_size > 10000
