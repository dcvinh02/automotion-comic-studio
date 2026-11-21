"""Chunked Render Orchestrator (Module 07, Phase 08 Batch 3 export pipeline).

PROJECT SNAPSHOT → EXPORT PLAN (scope/settings/encoder) → chunked frame generation
(SoftwareCompositor or PixiJS stream, sampled at the *export* fps through a frame→time map)
→ streaming per-chunk video encoding → master audio mix → frame-exact segment audio →
concat + mux into a temporary file → ffprobe/decode validation → atomic move to the final
path (collision-safe) → export history metadata → temp cleanup.

Stop requests (pause / cancel / shutdown) terminate FFmpeg immediately; completed chunks are
kept so Resume / Retry continue from the last completed chunk.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import time
import uuid
from pathlib import Path

from app.config import AppConfig
from app.logging_config import get_logger
from core.asset_engine.service import AssetService
from core.quality_engine.checker import QualityControlEngine
from core.render_engine.audio_mixer import (
    build_export_audio,
    measure_audio_peak_db,
    measure_integrated_loudness,
    mix_project_audio,
)
from core.render_engine.export_planner import (
    CONTAINER_SOFT_SUBS,
    build_export_plan,
    build_frame_time_map,
    next_free_path,
    resolve_encoder,
    retime_subtitles,
    settings_from_legacy_request,
)
from core.render_engine.output_validator import validate_output_file
from core.render_engine.software_compositor import SoftwareCompositor
from core.sound_engine.service import SoundService
from core.subtitle_engine.service import serialize_srt
from database.library_repo import LibraryRepository
from database.project_repo import ProjectRepository
from schemas.common import utc_now_iso
from schemas.export import ExportPlan, ExportSegment, ExportSettings, ResolvedEncoder
from schemas.job import ExportPreset, ExportRequest, RenderChunk, RenderJob
from schemas.project import ProjectState
from utils.ffmpeg import (
    _terminate_process,
    probe_ffmpeg_capabilities,
    run_ffmpeg_with_progress,
)
from workers.ws_hub import WebSocketHub

logger = get_logger("render_orchestrator")


class ExportValidationError(Exception):
    def __init__(self, plan: ExportPlan) -> None:
        errors = [i.message for i in plan.issues if i.severity == "error"]
        super().__init__("; ".join(errors) or "Export settings are invalid.")
        self.plan = plan


class JobControl:
    """Cooperative stop signal for one running job (pause / cancel / shutdown)."""

    def __init__(self) -> None:
        self.stop_event = asyncio.Event()
        self.reason: str | None = None

    def request(self, reason: str) -> None:
        # cancel/shutdown always win over pause
        if self.reason is None or reason in ("cancel", "shutdown"):
            self.reason = reason
        self.stop_event.set()

    @property
    def stopped(self) -> bool:
        return self.stop_event.is_set()


class _StopRequested(Exception):
    pass


class RenderOrchestrator:
    def __init__(
        self,
        *,
        config: AppConfig,
        project_repo: ProjectRepository,
        library_repo: LibraryRepository,
        asset_service: AssetService,
        sound_service: SoundService,
        qc_engine: QualityControlEngine,
        ws_hub: WebSocketHub,
    ) -> None:
        self.config = config
        self.project_repo = project_repo
        self.library_repo = library_repo
        self.asset_service = asset_service
        self.sound_service = sound_service
        self.qc_engine = qc_engine
        self.ws_hub = ws_hub

    # ------------------------------------------------------------------
    # Planning
    # ------------------------------------------------------------------

    def resolve_settings(self, req: ExportRequest) -> ExportSettings:
        if req.settings is not None:
            return req.settings
        preset = self.library_repo.get_export_preset(req.preset_id)
        if not preset:
            raise FileNotFoundError(f"Export preset not found: {req.preset_id}")
        return settings_from_legacy_request(req, preset)

    def plan_export(
        self,
        state: ProjectState,
        settings: ExportSettings,
        reserved_paths: set[str] | None = None,
    ) -> ExportPlan:
        caps = probe_ffmpeg_capabilities(self.config)
        return build_export_plan(
            state=state,
            settings=settings,
            caps=caps,
            project_dir=self.config.project_dir(state.meta.project_id),
            reserved_paths=reserved_paths or set(),
            pixi_connected=self.ws_hub.has_pixi_render_worker,
        )

    def prepare_export_job(
        self,
        req: ExportRequest,
        reserved_paths: set[str] | None = None,
        queue_position: int = 0,
    ) -> tuple[RenderJob, ExportPlan]:
        state = self.project_repo.get_project_state(req.project_id)
        settings = self.resolve_settings(req)
        plan = self.plan_export(state, settings, reserved_paths)
        if not plan.valid:
            raise ExportValidationError(plan)
        settings = plan.settings
        fps = settings.fps
        total_frames = plan.total_frames
        frames_per_chunk = max(fps, settings.chunk_duration_seconds * fps)
        num_chunks = max(1, -(-total_frames // frames_per_chunk))

        job_id = f"job_{uuid.uuid4().hex[:10]}"
        pdir = self.config.project_dir(req.project_id)
        renders_dir = pdir / "renders" / job_id
        renders_dir.mkdir(parents=True, exist_ok=True)

        # Snapshot the project content at queue time: what you queued is what renders, and
        # resumed chunks always match the chunks rendered earlier.
        snapshot_path = renders_dir / "project_snapshot.json"
        snapshot_path.write_text(state.model_dump_json(), encoding="utf-8")

        ext = plan.encoder.chunk_extension if plan.encoder else ".mp4"
        chunks: list[RenderChunk] = []
        for idx in range(num_chunks):
            start_frame = idx * frames_per_chunk
            end_frame = min(total_frames - 1, (idx + 1) * frames_per_chunk - 1)
            chunks.append(
                RenderChunk(
                    chunk_id=f"{job_id}_c{idx:04d}",
                    job_id=job_id,
                    chunk_index=idx,
                    start_frame=start_frame,
                    end_frame=end_frame,
                    output_path=str(renders_dir / f"chunk_{idx:04d}{ext}"),
                    status="pending",
                )
            )

        scope_label = _scope_label(settings, plan.segments)
        name = (settings.job_name or "").strip() or f"{state.meta.name} · {scope_label}"
        job = RenderJob(
            job_id=job_id,
            project_id=req.project_id,
            job_type="export_mp4",
            status="queued",
            progress_pct=0.0,
            message=f"Queued ({total_frames} frames @ {fps}fps, {num_chunks} chunk(s))",
            name=name[:160],
            queue_position=queue_position,
            input_json={
                "settings": settings.model_dump(),
                "project_name": state.meta.name,
                "scope_label": scope_label,
                "segments": [s.model_dump() for s in plan.segments],
                "total_frames": total_frames,
                "duration_ms": plan.duration_ms,
                "output_path": plan.output_path,
                "renderer": plan.renderer,
                "encoder": plan.encoder.model_dump() if plan.encoder else None,
                "audio_expected": plan.audio_expected,
                "snapshot_path": str(snapshot_path),
                "plan_issues": [i.model_dump() for i in plan.issues if i.severity != "error"],
                # legacy keys kept for v0.1 clients
                "preset_id": req.preset_id,
                "render_mode": settings.render_mode,
                "subtitle_mode": settings.subtitles.mode,
                "export_srt_sidecar": settings.subtitles.export_srt,
                "chunk_duration_seconds": settings.chunk_duration_seconds,
            },
            progress={
                "stage": "queued",
                "frames_done": 0,
                "total_frames": total_frames,
                "chunk_count": num_chunks,
                "active_seconds": 0.0,
            },
            chunks=chunks,
            created_at=utc_now_iso(),
        )
        self.project_repo.save_job(job)
        return job, plan

    # ------------------------------------------------------------------
    # Execution
    # ------------------------------------------------------------------

    async def execute_job(self, job_id: str, project_id: str, control: JobControl | asyncio.Event) -> RenderJob:
        if isinstance(control, asyncio.Event):  # backward compatibility with v0.1 callers
            ev = control
            control = JobControl()
            control.stop_event = ev
            control.reason = "cancel"
        job = self.project_repo.get_job(project_id, job_id)
        if not job:
            raise FileNotFoundError(f"Job not found: {job_id}")

        run_started = time.monotonic()
        settings = ExportSettings.model_validate(job.input_json.get("settings") or {})
        segments = [ExportSegment.model_validate(s) for s in job.input_json.get("segments", [])]
        total_frames = int(job.input_json["total_frames"])
        fps = settings.fps
        log_lines: list[str] = []
        compositor: SoftwareCompositor | None = None
        progress = dict(job.progress or {})

        def log(msg: str) -> None:
            line = f"[{utc_now_iso()}] {msg}"
            log_lines.append(line)
            logger.info("%s: %s", job_id, msg)

        async def set_stage(stage: str, message: str, pct: float | None = None) -> None:
            nonlocal job
            progress["stage"] = stage
            progress["active_seconds"] = round(base_active + (time.monotonic() - run_started), 2)
            upd: dict = {"status": stage if stage in ("preparing", "rendering", "encoding", "validating") else job.status, "message": message, "progress": dict(progress)}
            if pct is not None:
                upd["progress_pct"] = round(min(100.0, max(0.0, pct)), 1)
            job = job.model_copy(update=upd)
            self.project_repo.save_job(job)
            await self._broadcast_job(job)
            log(message)

        base_active = float(progress.get("active_seconds") or 0.0)
        renders_dir = Path(job.chunks[0].output_path).parent if job.chunks else self.config.project_dir(project_id) / "renders" / job_id
        temp_output: Path | None = None
        try:
            job = job.model_copy(update={"started_at": job.started_at or utc_now_iso(), "error_log": None, "ended_at": None})
            await set_stage("preparing", "Preparing render (loading project snapshot, checking FFmpeg)...", 0.0)

            state = self._load_snapshot(job, project_id)
            caps = probe_ffmpeg_capabilities(self.config)
            if not caps.available or not caps.ffmpeg_path or not caps.ffprobe_path:
                raise RuntimeError("FFmpeg/FFprobe is not available: " + " ".join(caps.problems))
            ffmpeg, ffprobe = caps.ffmpeg_path, caps.ffprobe_path

            encoder, enc_issues = resolve_encoder(settings, caps, settings.width, settings.height)
            enc_errors = [i.message for i in enc_issues if i.severity == "error"]
            if encoder is None or enc_errors:
                raise RuntimeError("Encoder configuration invalid: " + "; ".join(enc_errors or ["no encoder"]))
            stored_chunk_encoder = job.input_json.get("chunk_encoder")
            completed_any = any(c.status == "completed" for c in job.chunks)
            if completed_any and stored_chunk_encoder and stored_chunk_encoder != encoder.encoder:
                # Concatenating chunks from different encoders is unsafe → re-render everything.
                log(f"Encoder changed ({stored_chunk_encoder} -> {encoder.encoder}); re-rendering all chunks for a consistent stream.")
                self._reset_chunks(job)
                completed_any = False

            renderer = job.input_json.get("renderer") or "software_compositor"
            if renderer == "pixi_stream" and not self.ws_hub.has_pixi_render_worker:
                if settings.render_mode == "pixi_stream":
                    raise RuntimeError("PixiJS offscreen render worker is not connected.")
                log("PixiJS worker not connected; falling back to the software compositor.")
                renderer = "software_compositor"
            if renderer == "pixi_stream" and completed_any and job.input_json.get("renderer_used") not in (None, "pixi_stream"):
                renderer = job.input_json["renderer_used"]

            if job.retry_count == 0 and not completed_any:
                try:
                    self.project_repo.create_backup(project_id, tag="pre_export")
                except Exception as exc:
                    log(f"Pre-export backup skipped: {exc}")

            frame_times = build_frame_time_map(segments, fps)
            if len(frame_times) != total_frames:
                raise RuntimeError(f"Internal frame map mismatch ({len(frame_times)} != {total_frames}).")

            if renderer == "software_compositor":
                compositor = SoftwareCompositor(
                    library_repo=self.library_repo,
                    asset_service=self.asset_service,
                    state=state,
                    width=settings.width,
                    height=settings.height,
                    fps=fps,
                    burn_in_subtitles=settings.subtitles.mode == "burn_in",
                    aspect_mode=settings.aspect_mode,
                )

            job = job.model_copy(update={"input_json": {**job.input_json, "renderer_used": renderer, "chunk_encoder": encoder.encoder}})

            # ---------------- Frame generation + streaming chunk encode ----------------
            frames_done = sum(c.end_frame - c.start_frame + 1 for c in job.chunks if c.status == "completed" and Path(c.output_path).is_file() and Path(c.output_path).stat().st_size > 0)
            frames_this_run = 0
            render_t0 = time.monotonic()
            progress.update({"frames_done": frames_done, "total_frames": total_frames, "eta_seconds": None, "render_fps": None})
            await set_stage("rendering", f"Rendering frames ({renderer}, {encoder.description})...", frames_done / total_frames * 90.0)

            last_emit = 0.0

            async def on_frame(done_in_chunk: int, chunk: RenderChunk, base: int) -> None:
                nonlocal frames_this_run, last_emit
                frames_this_run += 1
                now = time.monotonic()
                if now - last_emit < 0.25:
                    return
                last_emit = now
                done = base + done_in_chunk
                elapsed = now - render_t0
                rate = frames_this_run / elapsed if elapsed > 0 else 0.0
                eta = None
                # Only report an ETA once there is enough real throughput data
                if frames_this_run >= max(fps, 20) and elapsed >= 2.0 and rate > 0:
                    eta = round((total_frames - done) / rate, 1)
                progress.update({
                    "frames_done": done,
                    "render_fps": round(rate, 2),
                    "eta_seconds": eta,
                    "chunk_index": chunk.chunk_index,
                    "active_seconds": round(base_active + (now - run_started), 2),
                })
                pct = done / total_frames * 90.0
                await self.ws_hub.broadcast_event(
                    "job_progress",
                    {
                        "job_id": job.job_id,
                        "project_id": job.project_id,
                        "status": "rendering",
                        "progress_pct": round(pct, 1),
                        "message": f"Rendering frame {done}/{total_frames} (chunk {chunk.chunk_index + 1}/{len(job.chunks)})",
                        "progress": dict(progress),
                    },
                )

            for chunk in sorted(job.chunks, key=lambda c: c.chunk_index):
                chunk_file = Path(chunk.output_path)
                count = chunk.end_frame - chunk.start_frame + 1
                if chunk.status == "completed" and chunk_file.is_file() and chunk_file.stat().st_size > 0:
                    continue
                if control.stopped:
                    raise _StopRequested()
                self.project_repo.update_chunk_status(project_id, chunk.chunk_id, "rendering")
                chunk.status = "rendering"
                times = frame_times[chunk.start_frame : chunk.end_frame + 1]
                try:
                    if renderer == "pixi_stream":
                        await self._render_chunk_pixi(job=job, chunk=chunk, settings=settings, state=state, ffmpeg_path=ffmpeg, encoder=encoder, control=control, frame_times=times, on_frame=lambda i, c=chunk, b=frames_done: on_frame(i, c, b))
                    else:
                        assert compositor is not None
                        await self._render_chunk_software(chunk=chunk, settings=settings, compositor=compositor, ffmpeg_path=ffmpeg, encoder=encoder, control=control, frame_times=times, on_frame=lambda i, c=chunk, b=frames_done: on_frame(i, c, b))
                except _StopRequested:
                    chunk_file.unlink(missing_ok=True)
                    self.project_repo.update_chunk_status(project_id, chunk.chunk_id, "pending")
                    chunk.status = "pending"
                    raise
                except Exception as exc:
                    chunk_file.unlink(missing_ok=True)
                    self.project_repo.update_chunk_status(project_id, chunk.chunk_id, "failed", error_message=str(exc)[-1000:], retry_count=chunk.retry_count + 1)
                    chunk.status = "failed"
                    raise
                self.project_repo.update_chunk_status(project_id, chunk.chunk_id, "completed")
                chunk.status = "completed"
                frames_done += count
                progress["frames_done"] = frames_done
                await set_stage("rendering", f"Rendered chunk {chunk.chunk_index + 1}/{len(job.chunks)} ({frames_done}/{total_frames} frames)", frames_done / total_frames * 90.0)

            if control.stopped:
                raise _StopRequested()
            progress["eta_seconds"] = None

            # ---------------- Audio ----------------
            export_wav: Path | None = None
            peak_db: float | None = None
            loudness: float | None = None
            if settings.audio.enabled:
                await set_stage("encoding", "Mixing timeline audio (voice, dialogue, SFX, BGM, ambient)...", 91.0)
                sr = 48000 if settings.container == "webm" else settings.audio.sample_rate
                bed_ms = max([s.source_start_ms + s.duration_ms for s in segments] + [float(state.timeline.total_duration_ms)])
                master_wav = renders_dir / "master_audio.wav"
                await mix_project_audio(
                    config=self.config,
                    library_repo=self.library_repo,
                    sound_service=self.sound_service,
                    state=state,
                    output_wav_path=master_wav,
                    sample_rate=sr,
                    cancel_event=control.stop_event,
                    duration_ms=bed_ms + 50.0,
                    measure_peak=False,
                )
                if control.stopped:
                    raise _StopRequested()
                export_wav = renders_dir / "export_audio.wav"
                await build_export_audio(
                    ffmpeg=ffmpeg,
                    master_wav=master_wav,
                    output_wav=export_wav,
                    segments=[(s.source_start_ms, s.duration_ms) for s in segments],
                    sample_rate=sr,
                    normalize_loudness=settings.audio.normalize_loudness,
                    target_lufs=settings.audio.target_lufs,
                    cancel_event=control.stop_event,
                )
                if control.stopped:
                    raise _StopRequested()
                peak_db = await measure_audio_peak_db(ffmpeg, export_wav, cancel_event=control.stop_event)
                loudness = await measure_integrated_loudness(ffmpeg, export_wav, cancel_event=control.stop_event)
                if control.stopped:
                    raise _StopRequested()

            # ---------------- Subtitles ----------------
            cues = retime_subtitles(state.subtitles.segments, segments)
            srt_content = serialize_srt(cues, include_disabled=False) if cues else ""
            soft_srt_path: Path | None = None
            if settings.subtitles.mode == "soft" and srt_content.strip() and settings.container in CONTAINER_SOFT_SUBS:
                soft_srt_path = renders_dir / "subtitles.srt"
                soft_srt_path.write_text(srt_content, encoding="utf-8")

            # ---------------- Concat + mux into a temp file ----------------
            planned = Path(job.input_json.get("output_path") or (self.config.project_dir(project_id) / "exports" / f"{job_id}.{settings.container}"))
            planned.parent.mkdir(parents=True, exist_ok=True)
            temp_output = planned.parent / f".{planned.stem}.{job_id}.partial{planned.suffix}"
            temp_output.unlink(missing_ok=True)

            concat_list = renders_dir / "concat_list.txt"
            concat_list.write_text(
                "\n".join(
                    "file '" + Path(c.output_path).resolve().as_posix().replace("'", "'\\''") + "'"
                    for c in sorted(job.chunks, key=lambda c: c.chunk_index)
                ) + "\n",
                encoding="utf-8",
            )
            mux: list[str] = [ffmpeg, "-y", "-hide_banner", "-v", "error", "-f", "concat", "-safe", "0", "-i", str(concat_list)]
            if export_wav:
                mux += ["-i", str(export_wav)]
            if soft_srt_path:
                mux += ["-sub_charenc", "UTF-8", "-i", str(soft_srt_path)]
            mux += ["-map", "0:v:0"]
            if export_wav:
                mux += ["-map", "1:a:0"]
            if soft_srt_path:
                mux += ["-map", f"{2 if export_wav else 1}:s:0"]
            mux += ["-c:v", "copy"]
            if export_wav:
                mux += ["-c:a", encoder.audio_codec, "-b:a", f"{settings.audio.bitrate_kbps}k", "-ar", str(48000 if settings.container == "webm" else settings.audio.sample_rate), "-ac", "2"]
            if soft_srt_path:
                mux += ["-c:s", "mov_text", "-metadata:s:s:0", "language=vie"]
            mux += ["-metadata", f"title={state.meta.name}", "-metadata", "encoder=AutoMotion Comic Studio"]
            if settings.container in ("mp4", "mov"):
                mux += ["-movflags", "+faststart"]
            mux.append(str(temp_output))

            total_s = total_frames / float(fps)

            async def on_mux(frac: float) -> None:
                progress["mux_fraction"] = round(frac, 3)
                await self.ws_hub.broadcast_event(
                    "job_progress",
                    {"job_id": job.job_id, "project_id": job.project_id, "status": "encoding", "progress_pct": round(93.0 + frac * 3.0, 1), "message": f"Muxing final file {int(frac * 100)}%", "progress": dict(progress)},
                )

            await set_stage("encoding", f"Joining {len(job.chunks)} chunk(s) and muxing final .{settings.container}...", 93.0)
            rc, tail = await run_ffmpeg_with_progress(mux, total_duration_s=total_s, on_progress=on_mux, cancel_event=control.stop_event)
            if control.stopped:
                raise _StopRequested()
            if rc != 0:
                raise RuntimeError(f"FFmpeg final mux failed (exit {rc}): {tail.strip()[-800:]}")

            # ---------------- Validate the actual file ----------------
            await set_stage("validating", "Validating output file (ffprobe metadata, frame count, full decode)...", 96.0)
            report = await validate_output_file(
                ffmpeg=ffmpeg,
                ffprobe=ffprobe,
                path=temp_output,
                expected_width=settings.width,
                expected_height=settings.height,
                expected_fps=fps,
                expected_frames=total_frames,
                expected_video_codec=settings.video_codec,
                expected_audio_codec=encoder.audio_codec if export_wav else None,
                expect_soft_subtitles=bool(soft_srt_path),
                cancel_event=control.stop_event,
            )
            if control.stopped:
                raise _StopRequested()
            if not report.passed:
                failed = [c for c in report.checks if not c.passed and c.severity == "critical"]
                kept = renders_dir / f"failed_output{planned.suffix}"
                try:
                    os.replace(temp_output, kept)
                except OSError:
                    kept = temp_output
                temp_output = None
                job = job.model_copy(update={"output_json": {"validation": report.model_dump(), "failed_output_path": str(kept)}})
                raise RuntimeError(
                    "Output validation failed: "
                    + "; ".join(f"{c.check} (expected {c.expected}, got {c.actual})" for c in failed)
                )

            # ---------------- Move into place (collision-safe) ----------------
            final_path = self._finalize_output(temp_output, planned, settings, want_srt=bool(settings.subtitles.export_srt and srt_content.strip()))
            temp_output = None
            sidecar: Path | None = None
            if settings.subtitles.export_srt and srt_content.strip():
                sidecar = final_path.with_suffix(".srt")
                sidecar.write_text(srt_content, encoding="utf-8")

            warnings: list[dict] = list(job.input_json.get("plan_issues") or [])
            warnings = [w for w in warnings if w.get("severity") == "warning"]
            if peak_db is not None and peak_db > -0.1:
                warnings.append({"code": "AUDIO_NEAR_CLIPPING", "severity": "warning", "message": f"Audio peak reached {peak_db:.2f} dBFS (soft limiter engaged); check loud clips."})
            if loudness is not None and loudness > -9.0:
                warnings.append({"code": "AUDIO_TOO_LOUD", "severity": "warning", "message": f"Integrated loudness {loudness:.1f} LUFS is very loud (streaming targets ≈ -14 to -16 LUFS)."})
            if loudness is not None and loudness < -30.0:
                warnings.append({"code": "AUDIO_TOO_QUIET", "severity": "warning", "message": f"Integrated loudness {loudness:.1f} LUFS is very quiet; consider enabling normalization."})
            warnings.extend({"code": f"VALIDATION_{c.check.upper()}", "severity": "warning", "message": c.message} for c in report.checks if not c.passed and c.severity != "critical")

            active_s = round(base_active + (time.monotonic() - run_started), 2)
            progress.update({"stage": "completed", "frames_done": total_frames, "eta_seconds": None, "active_seconds": active_s})
            completed_at = utc_now_iso()
            job = job.model_copy(
                update={
                    "status": "completed",
                    "progress_pct": 100.0,
                    "message": f"Export completed: {final_path.name}",
                    "progress": dict(progress),
                    "output_json": {
                        "output_path": str(final_path),
                        "file_name": final_path.name,
                        "file_size_bytes": final_path.stat().st_size,
                        "duration_s": report.duration_s,
                        "width": report.width,
                        "height": report.height,
                        "fps": report.fps,
                        "frame_count": report.frame_count,
                        "container": settings.container,
                        "video_codec": report.video_codec,
                        "audio_codec": report.audio_codec,
                        "audio_sample_rate": report.audio_sample_rate,
                        "audio_enabled": bool(export_wav),
                        "audio_peak_db": peak_db,
                        "audio_loudness_lufs": loudness,
                        "audio_normalized": bool(export_wav and settings.audio.normalize_loudness),
                        "renderer": renderer,
                        "video_encoder": encoder.encoder,
                        "encoder_description": encoder.description,
                        "quality": settings.quality,
                        "scope": settings.scope.kind,
                        "scope_label": job.input_json.get("scope_label"),
                        "subtitle_mode": settings.subtitles.mode,
                        "subtitle_soft_muxed": bool(soft_srt_path),
                        "subtitle_sidecar_path": str(sidecar) if sidecar else None,
                        "subtitle_cue_count": len(cues),
                        "validation": report.model_dump(),
                        "needs_review": bool(warnings),
                        "warnings": warnings,
                        "post_qc_issues": warnings,
                        "render_time_s": active_s,
                        "completed_at": completed_at,
                    },
                    "ended_at": completed_at,
                }
            )
            self.project_repo.save_job(job)
            await self._broadcast_job(job)
            log(f"Export completed -> {final_path}")
            self._write_log(project_id, job_id, log_lines)
            self._cleanup_temp(project_id, renders_dir)
            return job

        except _StopRequested:
            reason = control.reason or "cancel"
            return await self._stop_job(job, reason, progress, base_active, run_started, log_lines, temp_output)
        except asyncio.CancelledError:
            await self._stop_job(job, "shutdown", progress, base_active, run_started, log_lines, temp_output)
            raise
        except Exception as exc:
            if control.stopped:
                return await self._stop_job(job, control.reason or "cancel", progress, base_active, run_started, log_lines, temp_output)
            logger.exception("Export job %s failed", job_id)
            log(f"FAILED: {exc}")
            if temp_output is not None:
                temp_output.unlink(missing_ok=True)
            progress.update({"stage": "failed", "eta_seconds": None, "active_seconds": round(base_active + (time.monotonic() - run_started), 2)})
            job = job.model_copy(update={"progress": dict(progress)})
            job = self._fail_job(job, str(exc))
            self._write_log(project_id, job_id, log_lines)
            await self._broadcast_job(job)
            return job
        finally:
            if compositor is not None:
                compositor.close()

    # ------------------------------------------------------------------

    def _load_snapshot(self, job: RenderJob, project_id: str) -> ProjectState:
        snap = job.input_json.get("snapshot_path")
        if snap and Path(snap).is_file():
            return ProjectState.model_validate_json(Path(snap).read_text(encoding="utf-8"))
        # Legacy jobs (v0.1) or missing snapshot → current project state
        return self.project_repo.get_project_state(project_id)

    def _reset_chunks(self, job: RenderJob) -> None:
        for c in job.chunks:
            Path(c.output_path).unlink(missing_ok=True)
            c.status = "pending"
            self.project_repo.update_chunk_status(job.project_id, c.chunk_id, "pending")

    def _finalize_output(self, temp: Path, planned: Path, settings: ExportSettings, want_srt: bool) -> Path:
        """Move the validated temp file into place without silently overwriting anything."""
        final = planned

        def taken(p: Path) -> bool:
            return p.exists() or (want_srt and p.with_suffix(".srt").exists())

        if taken(final):
            if settings.collision_policy == "overwrite":
                pass  # explicit user choice; os.replace is atomic
            elif settings.collision_policy == "fail":
                raise RuntimeError(f"Output file already exists: {final.name}")
            else:
                stem, ext = planned.stem, planned.suffix
                for i in range(1, 10000):
                    cand = planned.parent / f"{stem} ({i}){ext}"
                    if not taken(cand):
                        final = cand
                        break
                else:  # pragma: no cover
                    final = next_free_path(planned.parent, stem, ext)
        os.replace(temp, final)
        return final

    def _cleanup_temp(self, project_id: str, renders_dir: Path) -> None:
        """Delete a job's temp folder. Refuses anything outside <project>/renders/."""
        try:
            root = (self.config.project_dir(project_id) / "renders").resolve()
            target = renders_dir.resolve()
            if target == root or root not in target.parents:
                logger.warning("Refusing to clean unexpected path %s", target)
                return
            shutil.rmtree(target, ignore_errors=True)
        except Exception as exc:  # cleanup must never fail a completed export
            logger.warning("Temp cleanup failed for %s: %s", renders_dir, exc)

    def cleanup_job_temp(self, job: RenderJob) -> None:
        if job.chunks:
            self._cleanup_temp(job.project_id, Path(job.chunks[0].output_path).parent)
        else:
            self._cleanup_temp(job.project_id, self.config.project_dir(job.project_id) / "renders" / job.job_id)

    def _write_log(self, project_id: str, job_id: str, lines: list[str]) -> None:
        try:
            logs_dir = self.config.project_dir(project_id) / "renders" / "_logs"
            logs_dir.mkdir(parents=True, exist_ok=True)
            with (logs_dir / f"{job_id}.log").open("a", encoding="utf-8") as fh:
                fh.write("\n".join(lines) + "\n")
        except Exception:
            pass

    def job_log_path(self, project_id: str, job_id: str) -> Path:
        return self.config.project_dir(project_id) / "renders" / "_logs" / f"{job_id}.log"

    async def _stop_job(self, job, reason, progress, base_active, run_started, log_lines, temp_output) -> RenderJob:
        if temp_output is not None:
            Path(temp_output).unlink(missing_ok=True)
        progress.update({"eta_seconds": None, "active_seconds": round(base_active + (time.monotonic() - run_started), 2)})
        if reason == "pause":
            status, msg = "paused", "Paused — completed chunks are kept; Resume continues from the last completed chunk."
        elif reason == "shutdown":
            status, msg = "failed", "Interrupted by application shutdown. Retry resumes from the last completed chunk."
        else:
            status, msg = "cancelled", "Export cancelled by user."
        progress["stage"] = status
        updated = job.model_copy(update={"status": status, "message": msg, "progress": dict(progress), "ended_at": utc_now_iso() if status != "paused" else None, "error_log": msg if status == "failed" else None})
        self.project_repo.save_job(updated)
        log_lines.append(f"[{utc_now_iso()}] {msg}")
        self._write_log(job.project_id, job.job_id, log_lines)
        try:
            await self._broadcast_job(updated)
        except Exception:
            pass
        return updated

    # ------------------------------------------------------------------
    # Chunk renderers
    # ------------------------------------------------------------------

    def _build_chunk_ffmpeg_cmd(self, ffmpeg_path: str, settings: ExportSettings, encoder: ResolvedEncoder, output_path: Path) -> list[str]:
        return [
            ffmpeg_path, "-y", "-hide_banner", "-nostats", "-loglevel", "error",
            "-f", "rawvideo", "-pixel_format", "rgba",
            "-video_size", f"{settings.width}x{settings.height}",
            "-framerate", str(settings.fps),
            "-i", "pipe:0",
            *encoder.args,
            str(output_path),
        ]

    async def _spawn_encoder(self, cmd: list[str]) -> tuple[asyncio.subprocess.Process, asyncio.Task, list[bytes]]:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        buf: list[bytes] = []

        async def _drain() -> None:  # never let a full stderr pipe deadlock the encoder
            assert proc.stderr is not None
            while True:
                block = await proc.stderr.read(4096)
                if not block:
                    return
                buf.append(block)
                if len(buf) > 32:
                    del buf[:16]

        return proc, asyncio.create_task(_drain()), buf

    async def _finish_encoder(self, proc, drain_task, buf) -> tuple[int, str]:
        try:
            if proc.stdin and not proc.stdin.is_closing():
                proc.stdin.close()
                try:
                    await proc.stdin.wait_closed()
                except (BrokenPipeError, ConnectionResetError):
                    pass
            await proc.wait()
        finally:
            await drain_task
        return proc.returncode, b"".join(buf).decode("utf-8", errors="replace")[-1500:]

    async def _abort_encoder(self, proc, drain_task) -> None:
        await _terminate_process(proc)
        try:
            await asyncio.wait_for(drain_task, timeout=3.0)
        except Exception:
            drain_task.cancel()

    async def _render_chunk_software(self, *, chunk, settings, compositor, ffmpeg_path, encoder, control, frame_times, on_frame) -> None:
        cmd = self._build_chunk_ffmpeg_cmd(ffmpeg_path, settings, encoder, Path(chunk.output_path))
        proc, drain, buf = await self._spawn_encoder(cmd)
        assert proc.stdin is not None
        try:
            for i, t_ms in enumerate(frame_times):
                if control.stopped:
                    raise _StopRequested()
                rgba = await asyncio.to_thread(compositor.render_time_rgba, t_ms)
                try:
                    proc.stdin.write(rgba)
                    await proc.stdin.drain()
                except (BrokenPipeError, ConnectionResetError):
                    rc, err = await self._finish_encoder(proc, drain, buf)
                    raise RuntimeError(f"Encoder {encoder.encoder} exited early (code {rc}): {err.strip()}")
                await on_frame(i + 1)
        except BaseException:
            await self._abort_encoder(proc, drain)
            raise
        rc, err = await self._finish_encoder(proc, drain, buf)
        if rc != 0:
            raise RuntimeError(f"Chunk {chunk.chunk_index + 1} encoding failed with {encoder.encoder} (code {rc}): {err.strip()}")

    async def _render_chunk_pixi(self, *, job, chunk, settings, state, ffmpeg_path, encoder, control, frame_times, on_frame) -> None:
        expected_frames = len(frame_times)
        session = self.ws_hub.open_chunk_session(job.job_id, chunk.chunk_id, expected_frames)
        proc = drain = None
        buf: list[bytes] = []
        try:
            characters = [c.model_dump() for c in self.library_repo.list_characters()]
            assets = [a.model_dump() for a in self.library_repo.list_assets()]
            dispatched = await self.ws_hub.dispatch_render_chunk(
                {
                    "job_id": job.job_id,
                    "chunk_id": chunk.chunk_id,
                    "start_frame": chunk.start_frame,
                    "end_frame": chunk.end_frame,
                    "frame_times_ms": frame_times,
                    "width": settings.width,
                    "height": settings.height,
                    "fps": settings.fps,
                    "burn_in_subtitles": settings.subtitles.mode == "burn_in",
                    "project_state": state.model_dump(),
                    "characters": characters,
                    "assets": assets,
                }
            )
            if not dispatched:
                raise RuntimeError("Failed to dispatch chunk to PixiJS offscreen worker")
            await asyncio.wait_for(session.connected.wait(), timeout=20.0)
            proc, drain, buf = await self._spawn_encoder(self._build_chunk_ffmpeg_cmd(ffmpeg_path, settings, encoder, Path(chunk.output_path)))
            assert proc.stdin is not None
            received = 0
            while True:
                if control.stopped:
                    await self.ws_hub.send_cancel_render(job.job_id)
                    raise _StopRequested()
                frame_bytes = await asyncio.wait_for(session.frame_queue.get(), timeout=30.0)
                if frame_bytes is None:
                    break
                proc.stdin.write(frame_bytes)
                await proc.stdin.drain()
                received += 1
                await on_frame(received)
            if session.failed_error:
                raise RuntimeError(session.failed_error)
            if received < expected_frames:
                raise RuntimeError(f"Incomplete PixiJS chunk stream: got {received}/{expected_frames} frames")
            rc, err = await self._finish_encoder(proc, drain, buf)
            proc = None
            if rc != 0:
                raise RuntimeError(f"FFmpeg chunk encoding failed: {err.strip()}")
        except BaseException:
            if proc is not None and drain is not None:
                await self._abort_encoder(proc, drain)
            raise
        finally:
            self.ws_hub.close_chunk_session(job.job_id, chunk.chunk_id)

    # ------------------------------------------------------------------

    def _fail_job(self, job: RenderJob, error_msg: str) -> RenderJob:
        progress = dict(job.progress or {})
        progress["stage"] = "failed"
        progress["eta_seconds"] = None
        updated = job.model_copy(
            update={
                "status": "failed",
                "message": "Export failed",
                "error_log": error_msg,
                "progress": progress,
                "ended_at": utc_now_iso(),
            }
        )
        self.project_repo.save_job(updated)
        return updated

    async def _broadcast_job(self, job: RenderJob) -> None:
        await self.ws_hub.broadcast_event("job_updated", job.model_dump())


def _scope_label(settings: ExportSettings, segments: list[ExportSegment]) -> str:
    k = settings.scope.kind
    if k == "project":
        return "Entire project"
    if k == "range":
        s = segments[0] if segments else None
        return f"Range {s.source_start_ms / 1000:.2f}s–{(s.source_start_ms + s.duration_ms) / 1000:.2f}s" if s else "Range"
    if k in ("scene", "shot") and segments:
        return segments[0].label
    if k == "scenes":
        return f"{len(segments)} scenes"
    if k == "shots":
        return f"{len(segments)} shots"
    return k


def plan_to_json(plan: ExportPlan) -> dict:
    return json.loads(plan.model_dump_json())
