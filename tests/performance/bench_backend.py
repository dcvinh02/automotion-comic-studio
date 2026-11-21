"""Phase 09.2 backend benchmark (run manually; not collected by pytest).

    cd backend && .venv/bin/python ../tests/performance/bench_backend.py [out_dir]

Builds the stress project in a temporary workspace, then measures (median of repeats):
project load/save, API GET/PUT, job listing, QC, and SoftwareCompositor per-frame cost.
Also writes `stress_state.json` + `stress_characters.json` for the frontend benchmark.
"""

from __future__ import annotations

import json
import statistics
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE.parents[1] / "backend"), str(HERE.parents[1] / "tests"), str(HERE)]

from fastapi.testclient import TestClient  # noqa: E402

from app.config import AppConfig  # noqa: E402
from app.main import create_app  # noqa: E402
from core.render_engine.software_compositor import SoftwareCompositor  # noqa: E402
from schemas.job import RenderJob, RenderChunk  # noqa: E402
from stress_project import build_stress_project  # noqa: E402


def med(fn, n=5):
    xs = []
    for _ in range(n):
        t = time.perf_counter()
        fn()
        xs.append((time.perf_counter() - t) * 1000)
    return round(statistics.median(xs), 2)


def main() -> None:
    out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(tempfile.mkdtemp())
    out_dir.mkdir(parents=True, exist_ok=True)
    ws = Path(tempfile.mkdtemp()) / "ws"
    cfg = AppConfig(workspace_dir=ws, auth_token="bench")
    app = create_app(cfg)
    H = {"X-AMCS-Token": "bench"}
    res: dict[str, object] = {}
    with TestClient(app) as c:
        S = app.state.services
        t = time.perf_counter()
        st, chars = build_stress_project(S)
        res["build_stress_project_ms"] = round((time.perf_counter() - t) * 1000)
        pid = st.meta.project_id
        res["counts"] = {
            "scenes": len(st.scenes), "keyframes": len(st.timeline.keyframes), "clips": len(st.timeline.animation_clips),
            "sound_events": len(st.timeline.sound_events), "subtitles": len(st.subtitles.segments), "tracks": len(st.timeline.tracks),
        }
        payload = st.model_dump_json()
        res["state_json_bytes"] = len(payload)
        (out_dir / "stress_state.json").write_text(payload, encoding="utf-8")
        (out_dir / "stress_characters.json").write_text(json.dumps([json.loads(S.library_repo.get_character(ch.character_id).model_dump_json()) for ch in chars]), encoding="utf-8")

        res["repo_get_project_state_ms"] = med(lambda: S.project_repo.get_project_state(pid))
        res["api_get_project_ms"] = med(lambda: c.get(f"/api/v1/projects/{pid}", headers=H))
        body = c.get(f"/api/v1/projects/{pid}", headers=H).json()
        res["api_put_dirty_subtitles_ms"] = med(lambda: c.put(f"/api/v1/projects/{pid}?dirty=subtitles", headers=H, json=body))
        res["api_put_dirty_timeline_ms"] = med(lambda: c.put(f"/api/v1/projects/{pid}?dirty=timeline", headers=H, json=body))
        res["api_put_legacy_full_ms"] = med(lambda: c.put(f"/api/v1/projects/{pid}", headers=H, json=body))

        for i in range(60):
            jid = f"job_bench{i:03d}"
            S.project_repo.save_job(RenderJob(job_id=jid, project_id=pid, status="completed", input_json={"x": 1}, output_json={"output_path": "/x"},
                                              chunks=[RenderChunk(chunk_id=f"{jid}_c{k}", job_id=jid, chunk_index=k, start_frame=k, end_frame=k, output_path="/x") for k in range(5)]))
        res["api_list_jobs_60_ms"] = med(lambda: c.get(f"/api/v1/jobs/{pid}", headers=H))
        res["api_health_ms"] = med(lambda: c.get("/api/v1/health", headers=H))
        res["api_qc_preflight_ms"] = med(lambda: c.post(f"/api/v1/render/qc/{pid}", headers=H), n=3)
        res["api_production_qc_ms"] = med(lambda: c.post(f"/api/v1/qc/{pid}/run", headers=H, json={}), n=3)

        state = S.project_repo.get_project_state(pid)
        comp = SoftwareCompositor(library_repo=S.library_repo, asset_service=S.asset_service, state=state, width=1920, height=1080, fps=30)
        times = [123_456 + i * 33.3 for i in range(10)]
        comp.render_time_rgba(times[0])  # warm image cache
        res["compositor_evaluate_stage_ms"] = med(lambda: [comp.evaluate_stage(tt) for tt in times], n=3)
        res["compositor_evaluate_stage_ms"] = round(res["compositor_evaluate_stage_ms"] / len(times), 2)  # type: ignore[operator]
        res["compositor_render_frame_1080p_ms"] = round(med(lambda: [comp.render_time_rgba(tt) for tt in times], n=3) / len(times), 2)
        comp.close()
    print(json.dumps(res, indent=2, ensure_ascii=False))
    (out_dir / "bench_backend.json").write_text(json.dumps(res, indent=2, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
