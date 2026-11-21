"""Render Queue (Phase 08 Batch 3).

A single serial worker processes queued export jobs in `queue_position` order (one heavy
render at a time keeps CPU/RAM/FFmpeg process count bounded). State machine:

    queued ──start──▶ preparing ─▶ rendering ─▶ encoding ─▶ validating ─▶ completed
      │  ▲                │ pause                                │ fail
      │  └──resume── paused ◀┘                                   ▼
      ├──pause──▶ paused                              failed ──retry──▶ queued
      └──cancel─▶ cancelled ──retry──▶ queued
    (any active state) ──cancel──▶ cancelled ; app shutdown ──▶ failed (interrupted)

All transitions of an *active* job are performed by the orchestrator in response to a
`JobControl` stop request, so the worker and the API never race on the same row.
On startup, jobs left in an active state are marked failed/interrupted (never silently
re-run); queued jobs stay queued but the queue is not auto-started.
"""

from __future__ import annotations

import asyncio
import time

from app.logging_config import get_logger
from core.render_engine.orchestrator import JobControl, RenderOrchestrator
from database.project_repo import ProjectRepository
from schemas.common import utc_now_iso
from schemas.job import (
    ACTIVE_JOB_STATUSES,
    TERMINAL_JOB_STATUSES,
    WAITING_JOB_STATUSES,
    ExportRequest,
    RenderJob,
)

logger = get_logger("job_queue")


class InvalidJobTransition(Exception):
    """Raised when an action is not valid for the job's current state (HTTP 409)."""


class JobQueueManager:
    def __init__(self, project_repo: ProjectRepository, orchestrator: RenderOrchestrator) -> None:
        self.project_repo = project_repo
        self.orchestrator = orchestrator
        self._queued: dict[str, str] = {}  # job_id -> project_id for waiting jobs
        self._controls: dict[str, JobControl] = {}
        self._active: tuple[str, str] | None = None  # (project_id, job_id)
        self._runner: asyncio.Task | None = None
        self._queue_running = False
        self._lock = asyncio.Lock()
        self._done_events: dict[str, asyncio.Event] = {}
        self._recovered = False

    # ------------------------------------------------------------------ state
    @property
    def queue_running(self) -> bool:
        return self._queue_running

    def queue_state(self) -> dict:
        return {
            "running": self._queue_running,
            "active_job_id": self._active[1] if self._active else None,
            "active_project_id": self._active[0] if self._active else None,
            "queued_count": len(self._queued),
        }

    def is_active(self, job_id: str) -> bool:
        return bool(self._active and self._active[1] == job_id)

    def reserved_output_paths(self) -> set[str]:
        paths: set[str] = set()
        refs = list(self._queued.items()) + ([(self._active[1], self._active[0])] if self._active else [])
        for job_id, project_id in refs:
            job = self.project_repo.get_job(project_id, job_id)
            if job and job.input_json.get("output_path"):
                paths.add(str(job.input_json["output_path"]))
        return paths

    def _next_position(self) -> int:
        return int(time.time() * 1000)

    # ------------------------------------------------------------------ recovery
    def recover_on_startup(self) -> dict:
        """Detect jobs interrupted by a previous shutdown/crash. Never auto-reruns anything."""
        interrupted = 0
        waiting = 0
        try:
            projects = self.project_repo.list_projects()
        except Exception as exc:
            logger.warning("Render queue recovery skipped: %s", exc)
            return {"interrupted": 0, "waiting": 0}
        for summary in projects:
            try:
                jobs = self.project_repo.list_jobs(summary.project_id)
            except Exception as exc:
                logger.warning("Could not read jobs for %s: %s", summary.project_id, exc)
                continue
            for job in jobs:
                if job.status in ACTIVE_JOB_STATUSES:
                    progress = dict(job.progress or {})
                    progress["stage"] = "failed"
                    progress["interrupted"] = True
                    progress["eta_seconds"] = None
                    for c in job.chunks:
                        if c.status not in ("completed", "pending"):
                            self.project_repo.update_chunk_status(job.project_id, c.chunk_id, "pending")
                            c.status = "pending"
                    self.project_repo.save_job(
                        job.model_copy(
                            update={
                                "status": "failed",
                                "message": "Interrupted (the application closed while this job was running).",
                                "error_log": "Interrupted: the app was closed or crashed during rendering. Completed chunks were kept — Retry resumes from the last completed chunk.",
                                "progress": progress,
                                "ended_at": utc_now_iso(),
                            }
                        )
                    )
                    interrupted += 1
                elif job.status in WAITING_JOB_STATUSES:
                    if job.status == "pending":
                        self.project_repo.save_job(job.model_copy(update={"status": "queued"}))
                    self._queued[job.job_id] = job.project_id
                    waiting += 1
        self._recovered = True
        if interrupted or waiting:
            logger.info("Render queue recovery: %d interrupted job(s) marked failed, %d waiting (queue paused)", interrupted, waiting)
        return {"interrupted": interrupted, "waiting": waiting}

    # ------------------------------------------------------------------ actions
    async def enqueue_export(self, req: ExportRequest) -> RenderJob:
        async with self._lock:
            job, _plan = self.orchestrator.prepare_export_job(
                req, reserved_paths=self.reserved_output_paths(), queue_position=self._next_position()
            )
            self._queued[job.job_id] = job.project_id
            self._done_events[job.job_id] = asyncio.Event()
        if req.start_mode == "render_now":
            await self.start_queue()
        await self._broadcast_queue()
        return self.project_repo.get_job(job.project_id, job.job_id) or job

    async def start_queue(self) -> dict:
        self._queue_running = True
        self._ensure_runner()
        await self._broadcast_queue()
        return self.queue_state()

    async def stop_queue(self) -> dict:
        """Stop picking new jobs after the current one finishes (does not interrupt it)."""
        self._queue_running = False
        await self._broadcast_queue()
        return self.queue_state()

    def _require(self, project_id: str, job_id: str) -> RenderJob:
        job = self.project_repo.get_job(project_id, job_id)
        if not job:
            raise FileNotFoundError(f"Job not found: {job_id}")
        return job

    async def pause_job(self, project_id: str, job_id: str) -> RenderJob:
        job = self._require(project_id, job_id)
        if self.is_active(job_id):
            # Pausing the rendering job also pauses the queue, so the machine actually goes idle.
            self._queue_running = False
            self._controls[job_id].request("pause")
            await self.wait_for_job_stop(job_id)
            return self._require(project_id, job_id)
        if job.status in WAITING_JOB_STATUSES:
            self._queued.pop(job_id, None)
            job = job.model_copy(update={"status": "paused", "message": "Paused in queue (not started)."})
            self.project_repo.save_job(job)
            await self._broadcast_job(job)
            return job
        raise InvalidJobTransition(f"Cannot pause a job that is {job.status}.")

    async def resume_job(self, project_id: str, job_id: str) -> RenderJob:
        """Resume a paused job, or (legacy) retry a failed/cancelled one."""
        job = self._require(project_id, job_id)
        if self.is_active(job_id):
            return job
        if job.status == "paused":
            return await self._requeue(job, message="Resumed — continuing from the last completed chunk.", bump_retry=False)
        if job.status in ("failed", "cancelled"):
            return await self.retry_job(project_id, job_id)
        if job.status in WAITING_JOB_STATUSES:
            await self.start_queue()
            return job
        raise InvalidJobTransition(f"Cannot resume a job that is {job.status}.")

    async def retry_job(self, project_id: str, job_id: str) -> RenderJob:
        job = self._require(project_id, job_id)
        if job.status not in ("failed", "cancelled"):
            raise InvalidJobTransition(f"Only failed or cancelled jobs can be retried (job is {job.status}).")
        return await self._requeue(job, message="Retrying — completed chunks are reused.", bump_retry=True)

    async def _requeue(self, job: RenderJob, *, message: str, bump_retry: bool) -> RenderJob:
        async with self._lock:
            progress = dict(job.progress or {})
            progress.update({"stage": "queued", "eta_seconds": None})
            progress.pop("interrupted", None)
            out = dict(job.output_json or {}) if job.output_json else None
            if out and "output_path" not in out:
                out = None  # discard stale failed-validation info
            updated = job.model_copy(
                update={
                    "status": "queued",
                    "message": message,
                    "error_log": None,
                    "ended_at": None,
                    "retry_count": job.retry_count + (1 if bump_retry else 0),
                    "progress": progress,
                    "output_json": out,
                }
            )
            self.project_repo.save_job(updated)
            self._queued[job.job_id] = job.project_id
            self._done_events.setdefault(job.job_id, asyncio.Event()).clear()
        await self._broadcast_job(updated)
        await self.start_queue()
        return self.project_repo.get_job(job.project_id, job.job_id) or updated

    async def cancel_job(self, project_id: str, job_id: str) -> RenderJob | None:
        job = self.project_repo.get_job(project_id, job_id)
        if not job:
            return None
        if self.is_active(job_id):
            self._controls[job_id].request("cancel")
            await self.wait_for_job_stop(job_id)
            return self.project_repo.get_job(project_id, job_id)
        if job.status in WAITING_JOB_STATUSES or job.status == "paused":
            self._queued.pop(job_id, None)
            job = job.model_copy(update={"status": "cancelled", "message": "Cancelled before rendering finished.", "ended_at": utc_now_iso()})
            self.project_repo.save_job(job)
            self._signal_done(job_id)
            await self._broadcast_job(job)
            await self._broadcast_queue()
            return job
        return job  # terminal: cancelling is a no-op

    async def skip_job(self, project_id: str, job_id: str) -> RenderJob:
        """Skip the running job (cancel it) and let the queue continue with the next job."""
        job = self._require(project_id, job_id)
        if not self.is_active(job_id):
            raise InvalidJobTransition("Only the currently rendering job can be skipped.")
        self._controls[job_id].request("cancel")
        await self.wait_for_job_stop(job_id)
        job = self._require(project_id, job_id)
        if job.status == "cancelled":
            job = job.model_copy(update={"message": "Skipped — the queue continued with the next job."})
            self.project_repo.save_job(job)
            await self._broadcast_job(job)
        return job

    async def remove_job(self, project_id: str, job_id: str) -> bool:
        """Remove a job / history entry. Deletes temp chunks only; never the exported file."""
        job = self._require(project_id, job_id)
        if self.is_active(job_id):
            raise InvalidJobTransition("Cancel the job before removing it.")
        if job.status not in TERMINAL_JOB_STATUSES and job.status not in WAITING_JOB_STATUSES and job.status != "paused":
            raise InvalidJobTransition(f"Cannot remove a job that is {job.status}.")
        self._queued.pop(job_id, None)
        self.orchestrator.cleanup_job_temp(job)
        ok = self.project_repo.delete_job(project_id, job_id)
        self._signal_done(job_id)
        await self.orchestrator.ws_hub.broadcast_event("job_removed", {"job_id": job_id, "project_id": project_id})
        await self._broadcast_queue()
        return ok

    async def move_job(self, project_id: str, job_id: str, direction: str) -> list[RenderJob]:
        job = self._require(project_id, job_id)
        if job.status not in WAITING_JOB_STATUSES and job.status != "paused":
            raise InvalidJobTransition("Only queued or paused jobs can be reordered.")
        async with self._lock:
            waiting = [
                j for j in self.project_repo.list_jobs(project_id)
                if j.status in WAITING_JOB_STATUSES or j.status == "paused"
            ]
            waiting.sort(key=lambda j: (j.queue_position, j.created_at))
            idx = next(i for i, j in enumerate(waiting) if j.job_id == job_id)
            swap = idx - 1 if direction == "up" else idx + 1
            if 0 <= swap < len(waiting):
                a, b = waiting[idx], waiting[swap]
                pa, pb = a.queue_position, b.queue_position
                if pa == pb:
                    pb = pa + (1 if direction == "down" else -1)
                self.project_repo.save_job(a.model_copy(update={"queue_position": pb}))
                self.project_repo.save_job(b.model_copy(update={"queue_position": pa}))
        await self._broadcast_queue()
        return self.project_repo.list_jobs(project_id)

    # ------------------------------------------------------------------ worker
    def _ensure_runner(self) -> None:
        if self._runner is None or self._runner.done():
            self._runner = asyncio.create_task(self._run_loop(), name="render-queue-worker")

    def _pick_next(self) -> tuple[str, str] | None:
        candidates: list[RenderJob] = []
        for job_id, project_id in list(self._queued.items()):
            job = self.project_repo.get_job(project_id, job_id)
            if not job or job.status not in WAITING_JOB_STATUSES:
                self._queued.pop(job_id, None)
                continue
            candidates.append(job)
        if not candidates:
            return None
        candidates.sort(key=lambda j: (j.queue_position, j.created_at))
        nxt = candidates[0]
        return nxt.project_id, nxt.job_id

    async def _run_loop(self) -> None:
        try:
            while self._queue_running:
                async with self._lock:
                    nxt = self._pick_next()
                    if not nxt:
                        break
                    project_id, job_id = nxt
                    self._queued.pop(job_id, None)
                    control = JobControl()
                    self._controls[job_id] = control
                    self._active = (project_id, job_id)
                await self._broadcast_queue()
                try:
                    await self.orchestrator.execute_job(job_id, project_id, control)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    logger.exception("Unhandled error in render job %s: %s", job_id, exc)
                    job = self.project_repo.get_job(project_id, job_id)
                    if job and job.status not in TERMINAL_JOB_STATUSES and job.status != "paused":
                        failed = self.orchestrator._fail_job(job, f"Unhandled error: {exc}")
                        await self._broadcast_job(failed)
                finally:
                    self._controls.pop(job_id, None)
                    self._active = None
                    self._signal_done(job_id)
                    await self._broadcast_queue()
        finally:
            self._runner = None

    def _signal_done(self, job_id: str) -> None:
        ev = self._done_events.get(job_id)
        if ev:
            ev.set()

    async def wait_for_job_stop(self, job_id: str, timeout: float = 30.0) -> None:
        """Wait until the active job has acknowledged a stop request."""
        deadline = time.monotonic() + timeout
        while self.is_active(job_id) and time.monotonic() < deadline:
            await asyncio.sleep(0.05)

    async def wait_for_job(self, job_id: str, timeout: float | None = None) -> None:
        """Wait until the job reaches a terminal or paused state."""
        ev = self._done_events.setdefault(job_id, asyncio.Event())
        if not self.is_active(job_id) and job_id not in self._queued:
            return
        await asyncio.wait_for(ev.wait(), timeout=timeout)

    async def shutdown(self) -> None:
        self._queue_running = False
        for control in self._controls.values():
            control.request("shutdown")
        runner = self._runner
        if runner is not None:
            try:
                await asyncio.wait_for(asyncio.shield(runner), timeout=15.0)
            except (asyncio.TimeoutError, Exception):
                runner.cancel()
                try:
                    await runner
                except BaseException:
                    pass

    # ------------------------------------------------------------------ events
    async def _broadcast_job(self, job: RenderJob) -> None:
        await self.orchestrator.ws_hub.broadcast_event("job_updated", job.model_dump())

    async def _broadcast_queue(self) -> None:
        try:
            await self.orchestrator.ws_hub.broadcast_event("render_queue_state", self.queue_state())
        except Exception:
            pass
