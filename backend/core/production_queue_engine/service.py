"""Phase 07 Batch 3 — Dependency-Aware Automated Scene Production Queue Service.

Orchestrates existing real engines (`SceneExecutionService`, `AnimationExecutionService`,
`QualityControlEngine`, `SoundService`, `ProjectRepository`, `WebSocketHub`) using a
strict 9-state task state machine and explicit DAG dependency graph.

Guarantees:
- Zero duplicate execution engines (reuses Phase 07 Batch 1 & Batch 2 real execution pipelines)
- Strict valid state transitions enforced on every mutation
- Explicit DAG dependency resolution & failure isolation (partial production recovery)
- Idempotent Retry / Resume / Pause / Cancel / Skip with zero duplicate objects/keyframes
- Real SQLite persistence (`project.db` v9) and real-time WebSocket progress updates
"""

from __future__ import annotations

import asyncio
import hashlib
import uuid
from typing import Any

from app.logging_config import get_logger
from core.animation_execution_engine.capabilities import (
    check_preset_compatibility,
    inspect_character_capabilities,
    resolve_action_to_preset,
)
from core.animation_execution_engine.service import AnimationExecutionService
from core.asset_engine.service import AssetService
from core.quality_engine.checker import QualityControlEngine
from core.scene_execution_engine.service import SceneExecutionService, _select_target_shots
from core.scene_execution_engine.staging import stable_id
from database.library_repo import LibraryRepository
from database.project_repo import ProjectRepository, holds_project_lock
from schemas.animation_execution import ShotAnimationExecuteRequest
from schemas.common import utc_now_iso
from schemas.production import ProductionShotPlan
from schemas.production_queue import (
    ProductionQCFixRequest,
    ProductionQCReport,
    ProductionQueueDocument,
    ProductionQueuePlanPreview,
    ProductionQueueStartRequest,
    ProductionQueueTask,
    ProductionTaskStatus,
    assert_valid_task_transition,
)
from schemas.project import ProjectState
from schemas.scene_execution import SceneExecutionRequest
from schemas.subtitle import SubtitleDocument, SubtitleSegment, default_subtitle_styles
from schemas.timeline import SoundEffectEvent, TimelineTrack
from workers.ws_hub import WebSocketHub

logger = get_logger("production_queue_engine")


def _task_id(prefix: str, *parts: str) -> str:
    raw = "|".join(str(p) for p in parts)
    return f"{prefix}_{hashlib.sha1(raw.encode('utf-8')).hexdigest()[:10]}"


class ProductionQueueService:
    """Dependency-aware automated scene production orchestrator."""

    def __init__(
        self,
        *,
        project_repo: ProjectRepository,
        library_repo: LibraryRepository,
        asset_service: AssetService,
        scene_execution_service: SceneExecutionService,
        animation_execution_service: AnimationExecutionService,
        qc_engine: QualityControlEngine,
        ws_hub: WebSocketHub,
    ) -> None:
        self.project_repo = project_repo
        self.library_repo = library_repo
        self.asset_service = asset_service
        self.scene_execution_service = scene_execution_service
        self.animation_execution_service = animation_execution_service
        self.qc_engine = qc_engine
        self.ws_hub = ws_hub

        # Per-project runtime worker controls (reused by JobQueueManager shutdown)
        self._workers: dict[str, asyncio.Task[None]] = {}
        self._cancel_events: dict[str, asyncio.Event] = {}
        self._pause_events: dict[str, asyncio.Event] = {}
        self._inject_fail_types: dict[str, set[str]] = {}
        self._run_options: dict[str, ProductionQueueStartRequest] = {}

    def _scene_label_map(self, state: ProjectState) -> dict[str, tuple[int, str]]:
        out: dict[str, tuple[int, str]] = {}
        if state.director:
            for sc in state.director.scenes:
                out[sc.scene_breakdown_id] = (sc.scene_number, sc.title)
                if sc.applied_stage_scene_id:
                    out[sc.applied_stage_scene_id] = (sc.scene_number, sc.title)
        for sc in state.scenes:
            if sc.scene_id not in out:
                out[sc.scene_id] = (sc.order_index + 1, sc.name)
        return out

    def _resolve_target_shots(
        self,
        state: ProjectState,
        req: ProductionQueueStartRequest,
    ) -> tuple[list[ProductionShotPlan], list[str], list[str]]:
        """Resolve exact target shots according to Modes A-E, returning (shots, warnings, blocking_errors)."""
        warnings: list[str] = []
        blocking_errors: list[str] = []
        plan = state.production_plan

        if not plan or not plan.shots:
            blocking_errors.append(
                "No Production Plan shots found. Generate a Production Plan from Storyboard before running automated production."
            )
            return [], warnings, blocking_errors

        scene_ids: list[str] | None = None
        shot_ids: list[str] | None = None
        include_unapproved = req.include_unapproved

        if req.mode == "single_shot":
            if len(req.production_shot_ids) != 1:
                blocking_errors.append("Single Shot mode requires selecting exactly one shot.")
                return [], warnings, blocking_errors
            shot_ids = req.production_shot_ids
            include_unapproved = True
        elif req.mode == "selected_shots":
            if not req.production_shot_ids:
                blocking_errors.append("Selected Shots mode requires selecting at least one shot.")
                return [], warnings, blocking_errors
            shot_ids = req.production_shot_ids
            include_unapproved = True
        elif req.mode == "scene":
            if not req.scene_ids:
                blocking_errors.append("Entire Scene mode requires selecting at least one scene.")
                return [], warnings, blocking_errors
            scene_ids = req.scene_ids
            include_unapproved = True
        elif req.mode == "project":
            include_unapproved = True
        elif req.mode == "production_plan":
            approved = [s for s in plan.shots if s.approval_status == "approved"]
            if not approved and not include_unapproved:
                warnings.append(
                    "No shots were explicitly marked 'approved'; including all non-rejected planned shots."
                )

        shots = _select_target_shots(
            state,
            scene_ids=scene_ids,
            production_shot_ids=shot_ids,
            include_unapproved=include_unapproved,
        )
        if not shots:
            blocking_errors.append("No eligible non-rejected shots matched the selected execution scope.")
        return shots, warnings, blocking_errors

    def build_plan_preview(
        self,
        project_id: str,
        req: ProductionQueueStartRequest,
        *,
        run_id: str | None = None,
    ) -> ProductionQueuePlanPreview:
        """Build explicit DAG task list & pre-execution validation without mutating the project."""
        state = self.project_repo.get_project_state(project_id)
        shots, warnings, blocking_errors = self._resolve_target_shots(state, req)
        rid = run_id or f"pq_{uuid.uuid4().hex[:10]}"
        scene_map = self._scene_label_map(state)
        tasks: list[ProductionQueueTask] = []
        terminal_ids: list[str] = []

        distinct_scenes: list[str] = []
        for sh in shots:
            if sh.scene_id not in distinct_scenes:
                distinct_scenes.append(sh.scene_id)
            s_num, s_title = scene_map.get(sh.scene_id, (len(distinct_scenes), f"Scene {len(distinct_scenes)}"))
            stage_scene_id = sh.timeline_refs.stage_scene_id or stable_id("scene", sh.scene_id)
            stable_shot_id = stable_id("shot", sh.production_shot_id)

            t_asset = _task_id("t_asset", sh.production_shot_id)
            t_char = _task_id("t_char", sh.production_shot_id)
            t_asm = _task_id("t_asm", sh.production_shot_id)
            t_anim = _task_id("t_anim", sh.production_shot_id)
            t_cam = _task_id("t_cam", sh.production_shot_id)
            t_audio = _task_id("t_aud", sh.production_shot_id)

            tasks.append(
                ProductionQueueTask(
                    task_id=t_asset,
                    run_id=rid,
                    task_name=f"S{s_num:02d} Shot #{sh.shot_order}: Asset Resolution",
                    task_type="asset_resolution",
                    scene_id=sh.scene_id,
                    stage_scene_id=stage_scene_id,
                    scene_number=s_num,
                    scene_title=s_title,
                    shot_id=stable_shot_id,
                    production_shot_id=sh.production_shot_id,
                    shot_number=sh.shot_order,
                    shot_title=sh.title,
                    status="pending",
                    depends_on_task_ids=[],
                )
            )
            tasks.append(
                ProductionQueueTask(
                    task_id=t_char,
                    run_id=rid,
                    task_name=f"S{s_num:02d} Shot #{sh.shot_order}: Character & Rig Validation",
                    task_type="character_validation",
                    scene_id=sh.scene_id,
                    stage_scene_id=stage_scene_id,
                    scene_number=s_num,
                    scene_title=s_title,
                    shot_id=stable_shot_id,
                    production_shot_id=sh.production_shot_id,
                    shot_number=sh.shot_order,
                    shot_title=sh.title,
                    status="pending",
                    depends_on_task_ids=[],
                )
            )
            tasks.append(
                ProductionQueueTask(
                    task_id=t_asm,
                    run_id=rid,
                    task_name=f"S{s_num:02d} Shot #{sh.shot_order}: Scene Assembly ({sh.title})",
                    task_type="scene_assembly",
                    scene_id=sh.scene_id,
                    stage_scene_id=stage_scene_id,
                    scene_number=s_num,
                    scene_title=s_title,
                    shot_id=stable_shot_id,
                    production_shot_id=sh.production_shot_id,
                    shot_number=sh.shot_order,
                    shot_title=sh.title,
                    status="pending",
                    depends_on_task_ids=[t_asset, t_char],
                )
            )

            shot_terminals = [t_asm]
            if req.include_animation:
                tasks.append(
                    ProductionQueueTask(
                        task_id=t_anim,
                        run_id=rid,
                        task_name=f"S{s_num:02d} Shot #{sh.shot_order}: Character Animation",
                        task_type="shot_animation",
                        scene_id=sh.scene_id,
                        stage_scene_id=stage_scene_id,
                        scene_number=s_num,
                        scene_title=s_title,
                        shot_id=stable_shot_id,
                        production_shot_id=sh.production_shot_id,
                        shot_number=sh.shot_order,
                        shot_title=sh.title,
                        status="pending",
                        depends_on_task_ids=[t_asm, t_char],
                    )
                )
                shot_terminals.append(t_anim)

            if req.include_camera:
                tasks.append(
                    ProductionQueueTask(
                        task_id=t_cam,
                        run_id=rid,
                        task_name=f"S{s_num:02d} Shot #{sh.shot_order}: Camera Setup ({sh.camera_plan.camera_movement})",
                        task_type="camera_setup",
                        scene_id=sh.scene_id,
                        stage_scene_id=stage_scene_id,
                        scene_number=s_num,
                        scene_title=s_title,
                        shot_id=stable_shot_id,
                        production_shot_id=sh.production_shot_id,
                        shot_number=sh.shot_order,
                        shot_title=sh.title,
                        status="pending",
                        depends_on_task_ids=[t_asm],
                    )
                )
                shot_terminals.append(t_cam)

            has_audio_or_subs = bool(
                sh.sfx_plans
                or sh.bgm_plans
                or any(v.text.strip() for v in sh.voice_subtitle_plans)
            )
            if req.include_audio_subtitles and has_audio_or_subs:
                tasks.append(
                    ProductionQueueTask(
                        task_id=t_audio,
                        run_id=rid,
                        task_name=f"S{s_num:02d} Shot #{sh.shot_order}: Audio & Subtitle Sync",
                        task_type="audio_subtitle_sync",
                        scene_id=sh.scene_id,
                        stage_scene_id=stage_scene_id,
                        scene_number=s_num,
                        scene_title=s_title,
                        shot_id=stable_shot_id,
                        production_shot_id=sh.production_shot_id,
                        shot_number=sh.shot_order,
                        shot_title=sh.title,
                        status="pending",
                        depends_on_task_ids=[t_asm],
                    )
                )
                shot_terminals.append(t_audio)

            terminal_ids.extend(shot_terminals)

        if req.run_qc_after and tasks:
            tasks.append(
                ProductionQueueTask(
                    task_id=_task_id("t_qc", rid),
                    run_id=rid,
                    task_name="Project Quality Control Validation",
                    task_type="qc_validation",
                    scene_id=distinct_scenes[0] if len(distinct_scenes) == 1 else None,
                    scene_number=0,
                    scene_title="All Target Scenes" if len(distinct_scenes) != 1 else scene_map.get(distinct_scenes[0], (1, ""))[1],
                    status="pending",
                    depends_on_task_ids=terminal_ids,
                )
            )

        # Pre-check readiness warnings (informational — never blocks starting)
        if shots:
            qc_pre = self.qc_engine.run_production_qc(state)
            if qc_pre.error_count > 0:
                warnings.append(
                    f"Pre-flight QC detected {qc_pre.error_count} error(s) and {qc_pre.warning_count} warning(s) in current project state."
                )

        return ProductionQueuePlanPreview(
            project_id=project_id,
            mode=req.mode,
            total_scenes=len(distinct_scenes),
            total_shots=len(shots),
            total_tasks=len(tasks),
            tasks=tasks,
            warnings=warnings,
            blocking_errors=blocking_errors,
            can_start=len(blocking_errors) == 0 and len(tasks) > 0,
        )

    @holds_project_lock
    def get_queue(self, project_id: str) -> ProductionQueueDocument:
        state = self.project_repo.get_project_state(project_id)
        if state.production_queue is None:
            return ProductionQueueDocument()
        # If process restarted while marked running, reconcile cleanly to paused so user can resume safely
        doc = state.production_queue
        if doc.status == "running" and (
            project_id not in self._workers or self._workers[project_id].done()
        ):
            updated_tasks: list[ProductionQueueTask] = []
            for t in doc.tasks:
                if t.status in ("validating", "processing"):
                    t = t.model_copy(
                        update={
                            "status": "queued",
                            "message": "Interrupted by shutdown — ready to resume.",
                        }
                    )
                updated_tasks.append(t)
            doc = doc.model_copy(update={"status": "paused", "tasks": updated_tasks})
            state = state.model_copy(update={"production_queue": doc})
            self.project_repo.save_project_state(state)
        return doc

    def _is_worker_active(self, project_id: str) -> bool:
        w = self._workers.get(project_id)
        return w is not None and not w.done()

    @holds_project_lock
    def _persist_queue(
        self,
        project_id: str,
        doc: ProductionQueueDocument,
        *,
        qc_report: ProductionQCReport | None = None,
    ) -> ProductionQueueDocument:
        state = self.project_repo.get_project_state(project_id)
        doc_with_ts = doc.model_copy(update={"updated_at": utc_now_iso()})
        updates: dict[str, Any] = {"production_queue": doc_with_ts}
        if qc_report is not None:
            updates["qc_report"] = qc_report
        self.project_repo.save_project_state(state.model_copy(update=updates))
        return doc_with_ts

    async def _broadcast_queue(self, project_id: str, doc: ProductionQueueDocument) -> None:
        try:
            await self.ws_hub.broadcast(
                {
                    "type": "production_queue_update",
                    "project_id": project_id,
                    "queue": doc.model_dump(mode="json"),
                }
            )
        except Exception:
            pass

    async def start_production(
        self,
        project_id: str,
        req: ProductionQueueStartRequest,
    ) -> ProductionQueueDocument:
        if self._is_worker_active(project_id):
            raise RuntimeError(
                "A production queue run is already executing for this project. Pause or cancel it before starting a new run."
            )

        rid = f"pq_{uuid.uuid4().hex[:10]}"
        preview = self.build_plan_preview(project_id, req, run_id=rid)
        if not preview.can_start:
            raise ValueError("; ".join(preview.blocking_errors) or "Cannot start empty production plan.")

        queued_tasks: list[ProductionQueueTask] = []
        for t in preview.tasks:
            assert_valid_task_transition(t.status, "queued")
            queued_tasks.append(t.model_copy(update={"status": "queued", "message": "Queued for execution"}))

        doc = ProductionQueueDocument(
            run_id=rid,
            mode=req.mode,
            status="running",
            selected_scene_ids=list(req.scene_ids),
            selected_shot_ids=list(req.production_shot_ids),
            include_unapproved=req.include_unapproved,
            tasks=queued_tasks,
            started_at=utc_now_iso(),
            completed_at=None,
            updated_at=utc_now_iso(),
        )
        doc = self._persist_queue(project_id, doc)
        await self._broadcast_queue(project_id, doc)

        self._run_options[project_id] = req
        self._inject_fail_types[project_id] = set(req.inject_fail_task_types)
        self._launch_worker(project_id)
        return doc

    def _launch_worker(self, project_id: str) -> None:
        cancel_ev = asyncio.Event()
        pause_ev = asyncio.Event()
        self._cancel_events[project_id] = cancel_ev
        self._pause_events[project_id] = pause_ev

        async def _runner() -> None:
            try:
                await self._execute_queue_loop(project_id, cancel_ev, pause_ev)
            except Exception as exc:
                logger.exception("Unhandled error in production queue worker %s: %s", project_id, exc)
            finally:
                self._workers.pop(project_id, None)
                self._cancel_events.pop(project_id, None)
                self._pause_events.pop(project_id, None)

        self._workers[project_id] = asyncio.create_task(_runner(), name=f"prod-queue-{project_id}")

    async def wait_for_queue(self, project_id: str, timeout: float | None = 30.0) -> ProductionQueueDocument:
        worker = self._workers.get(project_id)
        if worker:
            await asyncio.wait_for(asyncio.shield(worker), timeout=timeout)
        return self.get_queue(project_id)

    async def pause_queue(self, project_id: str) -> ProductionQueueDocument:
        ev = self._pause_events.get(project_id)
        if ev:
            ev.set()
        doc = self.get_queue(project_id)
        if doc.status == "running":
            doc = self._persist_queue(project_id, doc.model_copy(update={"status": "paused"}))
            await self._broadcast_queue(project_id, doc)
        return doc

    async def resume_queue(self, project_id: str) -> ProductionQueueDocument:
        doc = self.get_queue(project_id)
        has_runnable = any(t.status in ("queued", "pending") for t in doc.tasks)
        if not has_runnable:
            return doc

        updated_tasks: list[ProductionQueueTask] = []
        for t in doc.tasks:
            if t.status == "pending":
                assert_valid_task_transition(t.status, "queued")
                t = t.model_copy(update={"status": "queued", "message": "Queued on resume"})
            updated_tasks.append(t)

        doc = self._persist_queue(
            project_id,
            doc.model_copy(update={"status": "running", "tasks": updated_tasks, "completed_at": None}),
        )
        await self._broadcast_queue(project_id, doc)
        if not self._is_worker_active(project_id):
            self._launch_worker(project_id)
        return doc

    async def cancel_queue(self, project_id: str) -> ProductionQueueDocument:
        ev = self._cancel_events.get(project_id)
        if ev:
            ev.set()
        # Wait briefly if worker is shutting down cleanly
        worker = self._workers.get(project_id)
        if worker and not worker.done():
            try:
                await asyncio.wait_for(asyncio.shield(worker), timeout=3.0)
            except Exception:
                pass

        doc = self.get_queue(project_id)
        updated_tasks: list[ProductionQueueTask] = []
        for t in doc.tasks:
            if t.status in ("pending", "queued", "validating", "processing"):
                assert_valid_task_transition(t.status, "cancelled")
                t = t.model_copy(
                    update={
                        "status": "cancelled",
                        "message": "Cancelled by user",
                        "completed_at": utc_now_iso(),
                    }
                )
            updated_tasks.append(t)

        doc = self._persist_queue(
            project_id,
            doc.model_copy(
                update={
                    "status": "cancelled",
                    "tasks": updated_tasks,
                    "completed_at": utc_now_iso(),
                }
            ),
        )
        await self._broadcast_queue(project_id, doc)
        return doc

    async def retry_task(self, project_id: str, task_id: str) -> ProductionQueueDocument:
        """Retry a failed/needs_review/cancelled/skipped/completed task and unblock its downstream dependents cleanly."""
        if self._is_worker_active(project_id):
            raise RuntimeError("Pause or wait for the active queue run before retrying individual tasks.")

        doc = self.get_queue(project_id)
        target = next((t for t in doc.tasks if t.task_id == task_id), None)
        if not target:
            raise FileNotFoundError(f"Production queue task not found: {task_id}")

        assert_valid_task_transition(target.status, "queued")

        # Collect downstream dependents that were blocked by this task so they automatically re-run once this succeeds
        downstream_ids: set[str] = {task_id}
        changed = True
        while changed:
            changed = False
            for t in doc.tasks:
                if t.task_id not in downstream_ids and any(d in downstream_ids for d in t.depends_on_task_ids):
                    if t.status in ("needs_review", "failed", "cancelled", "pending", "queued"):
                        downstream_ids.add(t.task_id)
                        changed = True

        # Clear any test-injected failure for this task type so Retry genuinely succeeds
        self._inject_fail_types.get(project_id, set()).discard(target.task_type)

        updated_tasks: list[ProductionQueueTask] = []
        for t in doc.tasks:
            if t.task_id == task_id:
                updated_tasks.append(
                    t.model_copy(
                        update={
                            "status": "queued",
                            "retry_count": t.retry_count + 1,
                            "progress_pct": 0.0,
                            "error_details": None,
                            "blocked_by_task_ids": [],
                            "message": f"Queued for retry (#{t.retry_count + 1})",
                            "completed_at": None,
                        }
                    )
                )
            elif t.task_id in downstream_ids:
                assert_valid_task_transition(t.status, "queued")
                updated_tasks.append(
                    t.model_copy(
                        update={
                            "status": "queued",
                            "progress_pct": 0.0,
                            "error_details": None,
                            "blocked_by_task_ids": [],
                            "message": "Re-queued after upstream retry",
                            "completed_at": None,
                        }
                    )
                )
            else:
                updated_tasks.append(t)

        doc = self._persist_queue(
            project_id,
            doc.model_copy(update={"status": "running", "tasks": updated_tasks, "completed_at": None}),
        )
        await self._broadcast_queue(project_id, doc)
        self._launch_worker(project_id)
        return doc

    async def skip_task(self, project_id: str, task_id: str) -> ProductionQueueDocument:
        doc = self.get_queue(project_id)
        target = next((t for t in doc.tasks if t.task_id == task_id), None)
        if not target:
            raise FileNotFoundError(f"Production queue task not found: {task_id}")
        assert_valid_task_transition(target.status, "skipped")

        updated_tasks = [
            t.model_copy(
                update={
                    "status": "skipped",
                    "message": "Skipped by user",
                    "completed_at": utc_now_iso(),
                }
            )
            if t.task_id == task_id
            else t
            for t in doc.tasks
        ]
        doc = self._persist_queue(project_id, doc.model_copy(update={"tasks": updated_tasks}))
        await self._broadcast_queue(project_id, doc)
        return doc

    async def cancel_task(self, project_id: str, task_id: str) -> ProductionQueueDocument:
        doc = self.get_queue(project_id)
        target = next((t for t in doc.tasks if t.task_id == task_id), None)
        if not target:
            raise FileNotFoundError(f"Production queue task not found: {task_id}")
        assert_valid_task_transition(target.status, "cancelled")

        updated_tasks = [
            t.model_copy(
                update={
                    "status": "cancelled",
                    "message": "Cancelled by user",
                    "completed_at": utc_now_iso(),
                }
            )
            if t.task_id == task_id
            else t
            for t in doc.tasks
        ]
        doc = self._persist_queue(project_id, doc.model_copy(update={"tasks": updated_tasks}))
        await self._broadcast_queue(project_id, doc)
        return doc

    def _update_task_in_doc(
        self,
        doc: ProductionQueueDocument,
        task_id: str,
        *,
        new_status: ProductionTaskStatus | None = None,
        **fields: Any,
    ) -> ProductionQueueDocument:
        out: list[ProductionQueueTask] = []
        for t in doc.tasks:
            if t.task_id == task_id:
                upd = dict(fields)
                if new_status is not None and new_status != t.status:
                    assert_valid_task_transition(t.status, new_status)
                    upd["status"] = new_status
                out.append(t.model_copy(update=upd))
            else:
                out.append(t)
        return doc.model_copy(update={"tasks": out})

    async def _execute_queue_loop(
        self,
        project_id: str,
        cancel_ev: asyncio.Event,
        pause_ev: asyncio.Event,
    ) -> None:
        opts = self._run_options.get(project_id) or ProductionQueueStartRequest()
        doc = self.get_queue(project_id)

        while True:
            if cancel_ev.is_set():
                for t in list(doc.tasks):
                    if t.status in ("pending", "queued"):
                        doc = self._update_task_in_doc(
                            doc,
                            t.task_id,
                            new_status="cancelled",
                            message="Cancelled before execution",
                            completed_at=utc_now_iso(),
                        )
                doc = self._persist_queue(
                    project_id,
                    doc.model_copy(update={"status": "cancelled", "completed_at": utc_now_iso()}),
                )
                await self._broadcast_queue(project_id, doc)
                return

            if pause_ev.is_set():
                doc = self._persist_queue(project_id, doc.model_copy(update={"status": "paused"}))
                await self._broadcast_queue(project_id, doc)
                return

            task_by_id = {t.task_id: t for t in doc.tasks}
            # Find next queued task whose dependencies are all settled
            next_task: ProductionQueueTask | None = None
            blocked_to_mark: list[tuple[ProductionQueueTask, list[str]]] = []

            for t in doc.tasks:
                if t.status != "queued":
                    continue
                deps = [task_by_id[d] for d in t.depends_on_task_ids if d in task_by_id]
                # QC validation runs after ALL upstream tasks are settled (even if some failed/needs_review!)
                if t.task_type == "qc_validation":
                    unsettled = [d for d in deps if d.status in ("pending", "queued", "validating", "processing")]
                    if not unsettled:
                        next_task = t
                        break
                    continue

                # Non-QC tasks require upstream deps to be completed or skipped
                bad_deps = [d for d in deps if d.status in ("failed", "cancelled", "needs_review")]
                if bad_deps:
                    blocked_to_mark.append((t, [d.task_id for d in bad_deps]))
                    continue
                unsettled = [d for d in deps if d.status not in ("completed", "skipped")]
                if not unsettled:
                    next_task = t
                    break

            if blocked_to_mark:
                for bt, blockers in blocked_to_mark:
                    blocker_names = ", ".join(task_by_id[b].task_name for b in blockers if b in task_by_id)
                    doc = self._update_task_in_doc(
                        doc,
                        bt.task_id,
                        new_status="validating",
                        started_at=utc_now_iso(),
                    )
                    doc = self._update_task_in_doc(
                        doc,
                        bt.task_id,
                        new_status="needs_review",
                        blocked_by_task_ids=blockers,
                        message=f"Blocked by upstream failure/review: {blocker_names}",
                        warnings=[f"Dependency blocked: {blocker_names}"],
                        completed_at=utc_now_iso(),
                    )
                doc = self._persist_queue(project_id, doc)
                await self._broadcast_queue(project_id, doc)
                continue

            if next_task is None:
                break

            # Execute next_task through valid state transitions: queued -> validating -> processing -> completed/failed/needs_review
            doc = self._update_task_in_doc(
                doc,
                next_task.task_id,
                new_status="validating",
                started_at=utc_now_iso(),
                progress_pct=15.0,
                message="Validating dependencies and inputs...",
            )
            doc = self._persist_queue(project_id, doc)
            await self._broadcast_queue(project_id, doc)
            await asyncio.sleep(0)  # Yield to event loop so UI/WS stay responsive

            if cancel_ev.is_set():
                doc = self._update_task_in_doc(
                    doc,
                    next_task.task_id,
                    new_status="cancelled",
                    message="Cancelled during validation",
                    completed_at=utc_now_iso(),
                )
                continue

            doc = self._update_task_in_doc(
                doc,
                next_task.task_id,
                new_status="processing",
                progress_pct=45.0,
                message=f"Executing {next_task.task_type.replace('_', ' ')}...",
            )
            doc = self._persist_queue(project_id, doc)
            await self._broadcast_queue(project_id, doc)
            await asyncio.sleep(0)

            qc_res_to_save: ProductionQCReport | None = None
            try:
                # Deterministic test hook for failure/dependency/recovery testing
                if next_task.task_type in self._inject_fail_types.get(project_id, set()):
                    raise RuntimeError(
                        f"Injected failure in '{next_task.task_type}' for dependency recovery testing."
                    )

                outcome_status, msg, warns, summary, tl_ms, qc_res_to_save = await asyncio.to_thread(
                    self._run_single_task_sync,
                    project_id,
                    next_task,
                    opts,
                )
                doc = self._update_task_in_doc(
                    doc,
                    next_task.task_id,
                    new_status=outcome_status,
                    progress_pct=100.0 if outcome_status == "completed" else 80.0,
                    message=msg,
                    warnings=warns,
                    error_details=None,
                    result_summary=summary,
                    timeline_time_ms=tl_ms,
                    completed_at=utc_now_iso(),
                )
            except Exception as exc:
                logger.warning("Production queue task %s failed: %s", next_task.task_id, exc)
                doc = self._update_task_in_doc(
                    doc,
                    next_task.task_id,
                    new_status="failed",
                    progress_pct=0.0,
                    message=f"Failed: {str(exc)[:140]}",
                    error_details=str(exc),
                    completed_at=utc_now_iso(),
                )

            doc = self._persist_queue(project_id, doc, qc_report=qc_res_to_save)
            await self._broadcast_queue(project_id, doc)

        # Compute final run status honestly from real task outcomes
        statuses = {t.status for t in doc.tasks}
        if "failed" in statuses and "completed" not in statuses:
            final_status = "failed"
        elif "failed" in statuses or "needs_review" in statuses:
            final_status = "partial"
        elif statuses == {"cancelled"}:
            final_status = "cancelled"
        else:
            final_status = "completed"

        doc = self._persist_queue(
            project_id,
            doc.model_copy(update={"status": final_status, "completed_at": utc_now_iso()}),
        )
        await self._broadcast_queue(project_id, doc)

    def _run_single_task_sync(
        self,
        project_id: str,
        task: ProductionQueueTask,
        opts: ProductionQueueStartRequest,
    ) -> tuple[ProductionTaskStatus, str, list[str], dict[str, Any], int | None, ProductionQCReport | None]:
        """Execute one real DAG node against live project data."""
        state = self.project_repo.get_project_state(project_id)
        plan = state.production_plan
        pshot = (
            next((s for s in plan.shots if s.production_shot_id == task.production_shot_id), None)
            if plan and task.production_shot_id
            else None
        )

        # 1. ASSET RESOLUTION
        if task.task_type == "asset_resolution":
            if not pshot:
                raise RuntimeError(f"Production shot plan '{task.production_shot_id}' not found.")
            warns: list[str] = []
            resolved_assets = 0
            missing_req_errors: list[str] = []

            req_items = ([pshot.background] if pshot.background else []) + list(pshot.assets)
            for req_item in req_items:
                if req_item.matched_asset_id:
                    asset = self.library_repo.get_asset(req_item.matched_asset_id)
                    if not asset or not self.asset_service.resolve_asset_file(asset).is_file():
                        missing_req_errors.append(
                            f"Matched asset '{req_item.label}' ({req_item.matched_asset_id}) file is missing."
                        )
                    else:
                        resolved_assets += 1
                elif req_item.required:
                    warns.append(f"Unmatched {req_item.kind} '{req_item.label}' — will assemble with fallback.")

            if missing_req_errors:
                raise RuntimeError(" ".join(missing_req_errors))

            return (
                "completed",
                f"Resolved {resolved_assets} asset(s)" + (f" ({len(warns)} warning(s))" if warns else ""),
                warns,
                {"resolved_assets": resolved_assets, "warnings_count": len(warns)},
                None,
                None,
            )

        # 2. CHARACTER & RIG VALIDATION
        if task.task_type == "character_validation":
            if not pshot:
                raise RuntimeError(f"Production shot plan '{task.production_shot_id}' not found.")
            warns = []
            checked_chars = 0
            missing_chars: list[str] = []
            all_presets = self.library_repo.list_motion_presets()
            presets_by_id = {p.preset_id: p for p in all_presets}

            for stg in pshot.characters:
                if stg.library_character_id:
                    ch = self.library_repo.get_character(stg.library_character_id)
                    if not ch:
                        missing_chars.append(
                            f"Character '{stg.character_name}' ({stg.library_character_id}) not found in library."
                        )
                        continue
                    checked_chars += 1
                    caps = inspect_character_capabilities(ch)
                    for act in pshot.animation_plans:
                        if act.library_character_id == ch.character_id:
                            preset, unsup_reason, _ = resolve_action_to_preset(
                                act.category,
                                presets_by_id,
                                all_presets,
                                preferred_preset_id=act.mapped_preset_id,
                                character=ch,
                            )
                            if preset is None:
                                warns.append(unsup_reason or f"No preset for '{act.category}' on '{ch.name}'.")
                            else:
                                compat = check_preset_compatibility(preset, caps)
                                if not compat.compatible:
                                    warns.append(
                                        f"'{ch.name}' rig lacks parts for '{act.category}' ({', '.join(compat.missing_capabilities)})."
                                    )
                else:
                    warns.append(f"Character '{stg.character_name}' is not linked to a Character Library asset.")

            if missing_chars:
                raise RuntimeError(" ".join(missing_chars))

            return (
                "completed",
                f"Validated {checked_chars} character rig(s)" + (f" ({len(warns)} note(s))" if warns else ""),
                warns,
                {"validated_characters": checked_chars},
                None,
                None,
            )

        # 3. SCENE ASSEMBLY (reuses real Phase 07 Batch 1 SceneExecutionService!)
        if task.task_type == "scene_assembly":
            if not pshot:
                raise RuntimeError(f"Production shot plan '{task.production_shot_id}' not found.")
            res = self.scene_execution_service.execute(
                project_id,
                SceneExecutionRequest(
                    production_shot_ids=[pshot.production_shot_id],
                    include_unapproved=True,
                    existing_policy="update_existing",
                    allow_partial=True,
                    sync_timeline_keyframes=True,
                ),
            )
            if res.status == "rolled_back":
                raise RuntimeError("; ".join(res.warnings) or "Scene assembly rolled back.")

            # Resolve timeline start_ms of assembled shot for 1-click navigation
            tl_ms = self._find_shot_timeline_ms(project_id, pshot.production_shot_id)
            outcome = res.outcomes[0] if res.outcomes else None
            if outcome and outcome.outcome in ("blocked", "failed"):
                raise RuntimeError(outcome.reason or "Shot assembly blocked.")
            warns = list(res.warnings) + (list(outcome.warnings) if outcome else [])
            return (
                "completed",
                f"Assembled shot ({res.characters_created + res.characters_reused} char, {res.props_created + res.props_reused} prop)",
                warns,
                {
                    "shots_assembled": res.shots_assembled,
                    "shots_updated": res.shots_updated,
                    "characters_total": res.characters_created + res.characters_reused,
                },
                tl_ms,
                None,
            )

        # 4. SHOT ANIMATION (reuses real Phase 07 Batch 2 AnimationExecutionService!)
        if task.task_type == "shot_animation":
            if not pshot:
                raise RuntimeError(f"Production shot plan '{task.production_shot_id}' not found.")
            res = self.animation_execution_service.execute_shots(
                project_id,
                ShotAnimationExecuteRequest(
                    production_shot_ids=[pshot.production_shot_id],
                    include_character_motion=True,
                    include_camera_motion=False,
                    preserve_user_modified=opts.preserve_user_modified,
                    allow_partial=True,
                ),
            )
            if res.status == "rolled_back" or res.errors:
                raise RuntimeError("; ".join(res.errors) or "Animation execution failed.")
            tl_ms = self._find_shot_timeline_ms(project_id, pshot.production_shot_id)
            status: ProductionTaskStatus = (
                "needs_review" if res.actions_unsupported > 0 and res.actions_executed == 0 else "completed"
            )
            return (
                status,
                f"Applied {res.actions_executed} action(s), {res.total_keyframes_written} keyframe(s)"
                + (f" ({res.actions_unsupported} unsupported)" if res.actions_unsupported else ""),
                list(res.warnings),
                {
                    "actions_executed": res.actions_executed,
                    "actions_unsupported": res.actions_unsupported,
                    "keyframes_written": res.total_keyframes_written,
                },
                tl_ms,
                None,
            )

        # 5. CAMERA SETUP (reuses real Phase 07 Batch 2 Camera Motion Execution!)
        if task.task_type == "camera_setup":
            if not pshot:
                raise RuntimeError(f"Production shot plan '{task.production_shot_id}' not found.")
            res = self.animation_execution_service.execute_shots(
                project_id,
                ShotAnimationExecuteRequest(
                    production_shot_ids=[pshot.production_shot_id],
                    include_character_motion=False,
                    include_camera_motion=True,
                    sync_camera_with_character=True,
                    preserve_user_modified=opts.preserve_user_modified,
                    allow_partial=True,
                ),
            )
            if res.status == "rolled_back" or res.errors:
                raise RuntimeError("; ".join(res.errors) or "Camera execution failed.")
            tl_ms = self._find_shot_timeline_ms(project_id, pshot.production_shot_id)
            status = "needs_review" if res.cameras_unsupported > 0 else "completed"
            return (
                status,
                f"Configured camera ({pshot.camera_plan.camera_movement}, {res.total_keyframes_written} keyframe(s))",
                list(res.warnings),
                {
                    "cameras_executed": res.cameras_executed,
                    "cameras_unsupported": res.cameras_unsupported,
                    "keyframes_written": res.total_keyframes_written,
                },
                tl_ms,
                None,
            )

        # 6. AUDIO & SUBTITLE SYNC (idempotent stable IDs on Master Timeline — zero duplicates!)
        if task.task_type == "audio_subtitle_sync":
            if not pshot:
                raise RuntimeError(f"Production shot plan '{task.production_shot_id}' not found.")
            return self._sync_shot_audio_and_subtitles(project_id, pshot)

        # 7. PROJECT QUALITY CONTROL VALIDATION
        if task.task_type == "qc_validation":
            fresh_state = self.project_repo.get_project_state(project_id)
            report = self.qc_engine.run_production_qc(fresh_state)
            msg = (
                f"QC Ready ({report.readiness_score}%): {report.passed_checks} passed, "
                f"{report.warning_count} warning(s), {report.error_count} error(s)"
            )
            status = "needs_review" if report.error_count > 0 else "completed"
            return (
                status,
                msg,
                [i.title for i in report.issues if i.severity == "error"][:5],
                {
                    "error_count": report.error_count,
                    "warning_count": report.warning_count,
                    "info_count": report.info_count,
                    "readiness_score": report.readiness_score,
                },
                0,
                report,
            )

        raise RuntimeError(f"Unknown task type: {task.task_type}")

    def _find_shot_timeline_ms(self, project_id: str, production_shot_id: str) -> int | None:
        state = self.project_repo.get_project_state(project_id)
        for sc in state.scenes:
            for sh in sc.shots:
                if sh.production_shot_id == production_shot_id:
                    return sc.start_ms + sh.start_ms
        return None

    @holds_project_lock
    def _sync_shot_audio_and_subtitles(
        self,
        project_id: str,
        pshot: ProductionShotPlan,
    ) -> tuple[ProductionTaskStatus, str, list[str], dict[str, Any], int | None, ProductionQCReport | None]:
        """Idempotently place planned shot audio cues & dialogue subtitle on Master Timeline."""
        state = self.project_repo.get_project_state(project_id)
        target_scene = None
        target_shot = None
        for sc in state.scenes:
            for sh in sc.shots:
                if sh.production_shot_id == pshot.production_shot_id:
                    target_scene = sc
                    target_shot = sh
                    break
            if target_shot:
                break

        if not target_scene or not target_shot:
            raise RuntimeError("Shot must be assembled before syncing audio & subtitles.")

        shot_start = target_scene.start_ms + target_shot.start_ms
        shot_end = shot_start + max(300, target_shot.duration_ms)
        warns: list[str] = []
        audio_placed = 0
        sub_placed = 0

        def ensure_track(ttype: str, default_name: str, order: int) -> TimelineTrack:
            existing = next((t for t in state.timeline.tracks if t.track_type == ttype), None)
            if existing:
                return existing
            trk = TimelineTrack(
                track_id=stable_id(f"trk_{ttype}", project_id),
                project_id=project_id,
                track_type=ttype,  # type: ignore[arg-type]
                name=default_name,
                order_index=order,
            )
            state.timeline.tracks.append(trk)
            return trk

        # Idempotent audio placement by deterministic event_id
        for cue in list(pshot.sfx_plans) + list(pshot.bgm_plans):
            if not cue.matched_sound_id:
                continue
            snd = self.library_repo.get_sound(cue.matched_sound_id)
            if not snd:
                warns.append(f"Planned sound '{cue.description}' ({cue.matched_sound_id}) missing in library.")
                continue
            track_map = {
                "voice": ("voice", "Voice Track 1", 9),
                "bgm": ("bgm", "BGM Track 1", 11),
                "ambient": ("ambient", "Ambient Track 1", 12),
            }
            ttype, tname, tord = track_map.get(cue.audio_type, ("sfx", "SFX Track 1", 10))
            trk = ensure_track(ttype, tname, tord)
            ev_id = stable_id("snd_ev", pshot.production_shot_id, cue.audio_plan_id)
            ev_start = shot_start + max(0, cue.offset_ms)
            ev_dur = min(snd.duration_ms, target_shot.duration_ms) if snd.duration_ms > 0 else target_shot.duration_ms
            new_ev = SoundEffectEvent(
                event_id=ev_id,
                track_id=trk.track_id,
                sound_id=snd.sound_id,
                source_scene_id=target_scene.scene_id,
                start_ms=ev_start,
                end_ms=max(ev_start + 100, ev_start + ev_dur),
                volume=cue.volume,
            )
            idx = next((i for i, e in enumerate(state.timeline.sound_events) if e.event_id == ev_id), -1)
            if idx >= 0:
                state.timeline.sound_events[idx] = new_ev
            else:
                state.timeline.sound_events.append(new_ev)
            audio_placed += 1

        # Idempotent subtitle placement by deterministic subtitle_id
        for vplan in pshot.voice_subtitle_plans:
            sub_text = (vplan.text or "").strip()
            if not sub_text:
                continue
            ensure_track("subtitle", "Subtitles", 8)
            if state.subtitles is None:
                state.subtitles = SubtitleDocument(styles=default_subtitle_styles())
            sub_id = stable_id("sub_pq", pshot.production_shot_id, vplan.item_plan_id)
            seg_start = shot_start + max(0, vplan.start_offset_ms)
            seg_end = min(shot_end, seg_start + max(400, vplan.duration_ms))
            if seg_end <= seg_start:
                seg_end = seg_start + 400
            existing_idx = next(
                (i for i, seg in enumerate(state.subtitles.segments) if seg.subtitle_id == sub_id),
                -1,
            )
            if existing_idx >= 0:
                prev_seg = state.subtitles.segments[existing_idx]
                state.subtitles.segments[existing_idx] = prev_seg.model_copy(
                    update={"start_ms": seg_start, "end_ms": seg_end, "scene_id": target_scene.scene_id}
                )
            else:
                state.subtitles.segments.append(
                    SubtitleSegment(
                        subtitle_id=sub_id,
                        text=sub_text,
                        start_ms=seg_start,
                        end_ms=seg_end,
                        scene_id=target_scene.scene_id,
                        speaker_character_id=vplan.library_character_id,
                        speaker_name=vplan.speaker_name,
                        timing_source="estimated",
                        style_id=state.subtitles.default_style_id,
                        enabled=True,
                    )
                )
            sub_placed += 1

        if state.subtitles:
            state.subtitles.segments.sort(key=lambda s: (s.start_ms, s.end_ms))

        if shot_end > state.timeline.total_duration_ms:
            state.timeline.total_duration_ms = shot_end
        self.project_repo.save_project_state(state)
        return (
            "completed",
            f"Synced {audio_placed} audio clip(s) and {sub_placed} subtitle(s)",
            warns,
            {"audio_placed": audio_placed, "subtitles_placed": sub_placed},
            shot_start,
            None,
        )

    @holds_project_lock
    def run_qc(self, project_id: str, scene_ids: list[str] | None = None) -> ProductionQCReport:
        state = self.project_repo.get_project_state(project_id)
        report = self.qc_engine.run_production_qc(state, scene_ids=scene_ids)
        self.project_repo.save_project_state(state.model_copy(update={"qc_report": report}))
        return report

    @holds_project_lock
    def apply_qc_fix(self, project_id: str, req: ProductionQCFixRequest) -> tuple[ProductionQCReport, str, ProjectState]:
        state = self.project_repo.get_project_state(project_id)
        fixed_state, msg = self.qc_engine.apply_qc_fix(state, req)
        report = self.qc_engine.run_production_qc(fixed_state)
        saved = self.project_repo.save_project_state(fixed_state.model_copy(update={"qc_report": report}))
        return report, msg, saved

    async def shutdown(self) -> None:
        for ev in self._cancel_events.values():
            ev.set()
        workers = list(self._workers.values())
        if workers:
            await asyncio.gather(*workers, return_exceptions=True)
