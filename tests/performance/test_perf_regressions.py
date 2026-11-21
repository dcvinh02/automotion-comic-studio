"""Phase 09.2 — Performance regression guards (structural where possible, generous time limits).

Thresholds are ~30× above measured values on the development machine so normal timing noise
never fails them, while re-introducing the original O(objects × properties × keyframes) lookups,
per-reference QC database round-trips, or non-deterministic parallel rendering would.
"""

from __future__ import annotations

import os
import subprocess
import tempfile
import time
from pathlib import Path

import pytest

from app.config import AppConfig
from app.dependencies import build_services
from core.render_engine.software_compositor import SoftwareCompositor
from schemas.job import ExportRequest
from stress_project import build_stress_project
from utils.ffmpeg import FFmpegLocator


@pytest.fixture(scope="module")
def stress():
    services = build_services(AppConfig(workspace_dir=Path(tempfile.mkdtemp()) / "ws"))
    st, _ = build_stress_project(services, scenes=12, assets=60)
    return services, services.project_repo.get_project_state(st.meta.project_id)


def test_render_evaluation_uses_keyframe_index(stress):
    services, st = stress
    assert len(st.timeline.keyframes) > 2000
    comp = SoftwareCompositor(library_repo=services.library_repo, asset_service=services.asset_service, state=st, width=640, height=360, fps=30)
    comp.evaluate_stage(1000)
    t = time.perf_counter()
    for i in range(200):
        comp.evaluate_stage(1000 + i * 600)
    per_frame_ms = (time.perf_counter() - t) * 1000 / 200
    assert per_frame_ms < 5.0, f"evaluate_stage {per_frame_ms:.2f} ms/frame (indexed lookup measured ~0.15 ms)"


def test_qc_does_one_library_lookup_per_distinct_item(stress, monkeypatch):
    services, st = stress
    import database.library_repo as lib

    calls = {"n": 0}
    real = lib.connect_sqlite

    def counting(path):
        calls["n"] += 1
        return real(path)

    monkeypatch.setattr(lib, "connect_sqlite", counting)
    services.qc_engine.run_preflight(st)
    preflight = calls["n"]
    calls["n"] = 0
    services.qc_engine.run_production_qc(st)
    production = calls["n"]
    distinct = len({a for sc in st.scenes for a in [sc.background_asset_id, *(p.asset_id for p in sc.props)] if a}) \
        + len({c.character_id for sc in st.scenes for c in sc.characters}) + len({e.sound_id for e in st.timeline.sound_events})
    # before Phase 09.2 these were one connection per *reference* (hundreds on this project)
    assert preflight <= distinct + 25, (preflight, distinct)
    assert production <= distinct + 25, (production, distinct)


@pytest.mark.asyncio
async def test_parallel_frame_rendering_is_bit_identical(tmp_path: Path, monkeypatch):
    cfg = AppConfig(workspace_dir=tmp_path / "ws")
    if not FFmpegLocator.find_ffmpeg(cfg):
        pytest.skip("FFmpeg not installed")
    services = build_services(cfg)
    st, _ = build_stress_project(services, scenes=2, assets=30)
    hashes = {}
    for threads in ("1", "4"):
        monkeypatch.setenv("AMCS_RENDER_THREADS", threads)
        job = await services.job_queue.enqueue_export(ExportRequest(project_id=st.meta.project_id, settings={
            "scope": {"kind": "range", "range_start_ms": 9000, "range_end_ms": 11000}, "resolution_preset": "custom",
            "width": 480, "height": 270, "quality": "draft", "filename": f"t{threads}", "render_mode": "software_compositor",
            "chunk_duration_seconds": 2, "audio": {"enabled": False},
        }))
        await services.job_queue.wait_for_job(job.job_id, timeout=300)
        job = services.project_repo.get_job(st.meta.project_id, job.job_id)
        assert job.status == "completed", job.error_log
        md5 = subprocess.run([FFmpegLocator.find_ffmpeg(cfg), "-v", "error", "-i", job.output_json["output_path"], "-map", "0:v", "-f", "framemd5", "-"],
                             capture_output=True, text=True, check=True).stdout
        hashes[threads] = [ln.split(",")[-1].strip() for ln in md5.splitlines() if not ln.startswith("#")]
    assert len(hashes["1"]) == 60
    assert hashes["1"] == hashes["4"], "parallel rendering changed the output frames"
    assert os.environ.get("AMCS_RENDER_THREADS") == "4"
