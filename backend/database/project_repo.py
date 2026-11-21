"""Repository for per-project SQLite databases (Project, Scenes, Timeline, Jobs)."""

from __future__ import annotations

import hashlib
import json
import shutil
import threading
import uuid
from typing import Any, Callable
from pathlib import Path

from app.config import AppConfig
from app.logging_config import get_logger
from database.backup import (
    create_project_backup,
    list_project_backups,
    restore_project_backup,
)
from database.connection import connect_sqlite, sqlite_transaction
from database.project_migrations import init_project_db
from schemas.common import utc_now_iso
from schemas.director import DirectorAnalysisDocument
from schemas.job import JobStatus, RenderChunk, RenderJob
from schemas.production import ProductionPlanDocument
from schemas.production_queue import ProductionQCReport, ProductionQueueDocument
from schemas.project import (
    PROJECT_SECTIONS,
    BackupInfo,
    ProjectCreateRequest,
    ProjectMeta,
    ProjectState,
    ProjectSummary,
)
from schemas.scene import Scene
from schemas.script import ScriptDocument
from schemas.storyboard import StoryboardDocument
from schemas.subtitle import SubtitleDocument, default_subtitle_styles
from schemas.timeline import MasterTimeline, TimelineTrack
from schemas.voice import VoiceAudioAsset

logger = get_logger("project_repo")


def holds_project_lock(method):
    """Decorator for service methods `(self, project_id, ...)` that load, modify and save project
    state synchronously: holds the per-project lock so no other writer can interleave and be
    silently reverted by this method's (possibly rollback) save. Requires `self.project_repo`."""
    import functools

    @functools.wraps(method)
    def wrapper(self, project_id, *args, **kwargs):
        with self.project_repo.project_lock(project_id):
            return method(self, project_id, *args, **kwargs)

    return wrapper


class ProjectRepository:
    def __init__(self, config: AppConfig) -> None:
        self.config = config
        # Phase 09.1: one re-entrant lock per project serializes read-modify-write cycles from
        # the API thread, background workers (asyncio.to_thread) and services.
        self._locks: dict[str, threading.RLock] = {}
        self._locks_guard = threading.Lock()
        self._listeners: list[Callable[[dict[str, Any]], None]] = []

    def project_lock(self, project_id: str) -> threading.RLock:
        with self._locks_guard:
            lock = self._locks.get(project_id)
            if lock is None:
                lock = threading.RLock()
                self._locks[project_id] = lock
            return lock

    def add_state_listener(self, fn: Callable[[dict[str, Any]], None]) -> None:
        """Called after every successful project save with {project_id, revisions, changed_sections, origin}."""
        self._listeners.append(fn)

    def create_project(self, req: ProjectCreateRequest) -> ProjectState:
        project_id = f"proj_{uuid.uuid4().hex[:12]}"
        now = utc_now_iso()
        pdir = self.config.ensure_project_layout(project_id)
        db_path = pdir / "project.db"
        init_project_db(db_path)

        meta = ProjectMeta(
            project_id=project_id,
            name=req.name.strip(),
            description=req.description.strip(),
            width=req.width,
            height=req.height,
            fps=req.fps,
            duration_ms=req.duration_ms,
            created_at=now,
            updated_at=now,
        )

        default_scene = Scene(
            scene_id=f"scene_{uuid.uuid4().hex[:8]}",
            project_id=project_id,
            order_index=0,
            name="Scene 1",
            start_ms=0,
            duration_ms=req.duration_ms,
        )

        default_tracks = [
            TimelineTrack(
                track_id=f"trk_scene_{uuid.uuid4().hex[:6]}",
                project_id=project_id,
                track_type="scene",
                name="Scene / Background",
                order_index=0,
            ),
            TimelineTrack(
                track_id=f"trk_cam_{uuid.uuid4().hex[:6]}",
                project_id=project_id,
                track_type="camera",
                name="Camera",
                order_index=1,
            ),
            TimelineTrack(
                track_id=f"trk_sub_{uuid.uuid4().hex[:6]}",
                project_id=project_id,
                track_type="subtitle",
                name="Subtitles",
                order_index=8,
            ),
            TimelineTrack(
                track_id=f"trk_voice_{uuid.uuid4().hex[:6]}",
                project_id=project_id,
                track_type="voice",
                name="Voice Track 1",
                order_index=9,
                volume=1.0,
            ),
            TimelineTrack(
                track_id=f"trk_sfx_{uuid.uuid4().hex[:6]}",
                project_id=project_id,
                track_type="sfx",
                name="SFX Track 1",
                order_index=10,
                volume=1.0,
            ),
            TimelineTrack(
                track_id=f"trk_bgm_{uuid.uuid4().hex[:6]}",
                project_id=project_id,
                track_type="bgm",
                name="BGM Track 1",
                order_index=11,
                volume=0.65,
            ),
            TimelineTrack(
                track_id=f"trk_amb_{uuid.uuid4().hex[:6]}",
                project_id=project_id,
                track_type="ambient",
                name="Ambient Track 1",
                order_index=12,
                volume=0.75,
            ),
        ]

        timeline = MasterTimeline(
            project_id=project_id,
            fps=req.fps,
            total_duration_ms=req.duration_ms,
            tracks=default_tracks,
        )

        state = ProjectState(meta=meta, scenes=[default_scene], timeline=timeline)
        saved = self.save_project_state(state, create_backup=True, backup_tag="init")
        logger.info("Created project %s (%s)", project_id, meta.name)
        return saved  # includes server timestamps and the initial section revisions

    def list_projects(self) -> list[ProjectSummary]:
        summaries: list[ProjectSummary] = []
        projects_root = self.config.projects_dir
        if not projects_root.is_dir():
            return summaries

        for child in sorted(projects_root.iterdir()):
            db_path = child / "project.db"
            if not child.is_dir() or not db_path.is_file():
                continue
            try:
                conn = connect_sqlite(db_path)
                try:
                    row = conn.execute("SELECT * FROM project_meta LIMIT 1").fetchone()
                    state_row = conn.execute(
                        "SELECT scenes_json FROM project_state WHERE id = 1"
                    ).fetchone()
                finally:
                    conn.close()
                if not row:
                    continue
                scene_count = len(json.loads(state_row["scenes_json"])) if state_row else 0
                summaries.append(
                    ProjectSummary(
                        project_id=row["project_id"],
                        name=row["name"],
                        description=row["description"],
                        width=row["width"],
                        height=row["height"],
                        fps=row["fps"],
                        duration_ms=row["duration_ms"],
                        scene_count=scene_count,
                        created_at=row["created_at"],
                        updated_at=row["updated_at"],
                    )
                )
            except Exception as exc:
                logger.warning("Skipping unreadable project dir %s: %s", child.name, exc)

        summaries.sort(key=lambda s: s.updated_at, reverse=True)
        return summaries

    def get_project_state(self, project_id: str) -> ProjectState:
        db_path = self.config.project_db_path(project_id)
        if not db_path.is_file():
            raise FileNotFoundError(f"Project not found: {project_id}")

        # Ensure safe backward-compatible schema migration before reading
        init_project_db(db_path)

        conn = connect_sqlite(db_path)
        try:
            meta_row = conn.execute("SELECT * FROM project_meta LIMIT 1").fetchone()
            state_row = conn.execute(
                "SELECT scenes_json, timeline_json, script_json, subtitles_json, director_json, storyboard_json, production_plan_json, production_queue_json, qc_report_json FROM project_state WHERE id = 1"
            ).fetchone()
            rev_rows = conn.execute("SELECT section, revision FROM section_revisions").fetchall()
        finally:
            conn.close()
        revisions = {sec: 0 for sec in PROJECT_SECTIONS}
        revisions.update({r["section"]: int(r["revision"]) for r in rev_rows})

        if not meta_row or not state_row:
            raise RuntimeError(f"Corrupted project database: {project_id}")

        meta = ProjectMeta(
            project_id=meta_row["project_id"],
            name=meta_row["name"],
            description=meta_row["description"],
            schema_version=meta_row["schema_version"],
            width=meta_row["width"],
            height=meta_row["height"],
            fps=meta_row["fps"],
            duration_ms=meta_row["duration_ms"],
            default_export_preset_id=meta_row["default_export_preset_id"],
            auto_save_enabled=bool(meta_row["auto_save_enabled"]),
            created_at=meta_row["created_at"],
            updated_at=meta_row["updated_at"],
        )
        scenes = [Scene.model_validate(item) for item in json.loads(state_row["scenes_json"])]
        timeline = MasterTimeline.model_validate(json.loads(state_row["timeline_json"]))
        raw_script = state_row["script_json"] if "script_json" in state_row.keys() else "{}"
        parsed_script = json.loads(raw_script) if raw_script else {}
        script = (
            ScriptDocument.model_validate(parsed_script)
            if isinstance(parsed_script, dict) and parsed_script
            else ScriptDocument(episode_title=meta.name)
        )
        raw_subs = state_row["subtitles_json"] if "subtitles_json" in state_row.keys() else "{}"
        parsed_subs = json.loads(raw_subs) if raw_subs else {}
        subtitles = (
            SubtitleDocument.model_validate(parsed_subs)
            if isinstance(parsed_subs, dict) and parsed_subs
            else SubtitleDocument()
        )
        if not subtitles.styles:
            subtitles = subtitles.model_copy(update={"styles": default_subtitle_styles()})
        raw_director = state_row["director_json"] if "director_json" in state_row.keys() else "{}"
        parsed_director = json.loads(raw_director) if raw_director else {}
        director = (
            DirectorAnalysisDocument.model_validate(parsed_director)
            if isinstance(parsed_director, dict) and parsed_director
            else None
        )
        raw_storyboard = (
            state_row["storyboard_json"] if "storyboard_json" in state_row.keys() else "{}"
        )
        parsed_storyboard = json.loads(raw_storyboard) if raw_storyboard else {}
        storyboard = (
            StoryboardDocument.model_validate(parsed_storyboard)
            if isinstance(parsed_storyboard, dict) and parsed_storyboard
            else None
        )
        raw_prod = (
            state_row["production_plan_json"]
            if "production_plan_json" in state_row.keys()
            else "{}"
        )
        parsed_prod = json.loads(raw_prod) if raw_prod else {}
        production_plan = (
            ProductionPlanDocument.model_validate(parsed_prod)
            if isinstance(parsed_prod, dict) and parsed_prod
            else None
        )
        raw_queue = (
            state_row["production_queue_json"]
            if "production_queue_json" in state_row.keys()
            else "{}"
        )
        parsed_queue = json.loads(raw_queue) if raw_queue else {}
        production_queue = (
            ProductionQueueDocument.model_validate(parsed_queue)
            if isinstance(parsed_queue, dict) and parsed_queue
            else None
        )
        raw_qc = (
            state_row["qc_report_json"]
            if "qc_report_json" in state_row.keys()
            else "{}"
        )
        parsed_qc = json.loads(raw_qc) if raw_qc else {}
        qc_report = (
            ProductionQCReport.model_validate(parsed_qc)
            if isinstance(parsed_qc, dict) and parsed_qc
            else None
        )
        return ProjectState(
            meta=meta,
            scenes=scenes,
            timeline=timeline,
            script=script,
            subtitles=subtitles,
            director=director,
            storyboard=storyboard,
            production_plan=production_plan,
            production_queue=production_queue,
            qc_report=qc_report,
            revisions=revisions,
        )

    def save_project_state(
        self,
        state: ProjectState,
        create_backup: bool = False,
        backup_tag: str = "auto",
        origin: str = "service",
    ) -> ProjectState:
        with self.project_lock(state.meta.project_id):
            return self._save_project_state_locked(state, create_backup, backup_tag, origin)

    def patch_project_sections(self, project_id: str, **sections: Any) -> ProjectState:
        """Atomically re-read the latest state and replace only the given sections.

        Backend services must use this after any await (LLM calls etc.) instead of saving a
        copy they loaded earlier — that copy is stale and would revert concurrent user edits.
        """
        unknown = set(sections) - set(PROJECT_SECTIONS)
        if unknown:
            raise ValueError(f"Unknown project sections: {sorted(unknown)}")
        with self.project_lock(project_id):
            latest = self.get_project_state(project_id)
            return self._save_project_state_locked(latest.model_copy(update=sections), False, "auto", "service")

    def save_client_state(
        self, state: ProjectState, dirty_sections: list[str] | None, create_backup: bool = False
    ) -> tuple[ProjectState, list[str]]:
        """Save a client (frontend) copy. Only `dirty_sections` are taken from the client; all other
        sections keep the stored (possibly newer, server-written) version. `state.revisions` are the
        revisions the client copy is based on: if a dirty section was changed by another writer since,
        it is reported as a conflict and the overwritten version is preserved in a 'conflict' backup.
        `dirty_sections=None` keeps the legacy full-overwrite behaviour."""
        project_id = state.meta.project_id
        with self.project_lock(project_id):
            if dirty_sections is None:
                return self._save_project_state_locked(state, create_backup, "manual" if create_backup else "auto", "client"), []
            latest = self.get_project_state(project_id)
            conflicts = [
                sec
                for sec in dirty_sections
                if sec in state.revisions and latest.revisions.get(sec, 0) > state.revisions[sec]
            ]
            if conflicts:
                self.create_backup(project_id, tag="conflict")
                logger.warning("Concurrent edit conflict on %s in %s; client copy kept, previous saved in backup", conflicts, project_id)
            merged = latest.model_copy(update={sec: getattr(state, sec) for sec in dirty_sections})
            saved = self._save_project_state_locked(merged, create_backup, "manual" if create_backup else "auto", "client")
            return saved, conflicts

    @staticmethod
    def _section_payloads(st: ProjectState) -> dict[str, str]:
        def dump(v) -> str:
            return json.dumps(v.model_dump(), sort_keys=True) if v is not None else "null"

        meta_cmp = st.meta.model_dump(exclude={"updated_at"})
        out = {
            "meta": json.dumps(meta_cmp, sort_keys=True),
            "scenes": json.dumps([sc.model_dump() for sc in st.scenes], sort_keys=True),
        }
        for sec in PROJECT_SECTIONS[2:]:
            out[sec] = dump(getattr(st, sec))
        return out

    def _save_project_state_locked(
        self,
        state: ProjectState,
        create_backup: bool,
        backup_tag: str,
        origin: str,
    ) -> ProjectState:
        project_id = state.meta.project_id
        pdir = self.config.ensure_project_layout(project_id)
        db_path = pdir / "project.db"
        init_project_db(db_path)

        now = utc_now_iso()
        updated_meta = state.meta.model_copy(
            update={
                "updated_at": now,
                "fps": state.timeline.fps,
                "duration_ms": state.timeline.total_duration_ms,
            }
        )
        updated_script = state.script.model_copy(update={"updated_at": now})
        updated_state = state.model_copy(
            update={"meta": updated_meta, "script": updated_script}
        )

        scenes_json = json.dumps([s.model_dump() for s in updated_state.scenes])
        timeline_json = json.dumps(updated_state.timeline.model_dump())
        script_json = json.dumps(updated_state.script.model_dump())
        subtitles_json = json.dumps(updated_state.subtitles.model_dump())
        director_json = (
            json.dumps(updated_state.director.model_dump())
            if updated_state.director is not None
            else "{}"
        )
        storyboard_json = (
            json.dumps(updated_state.storyboard.model_dump())
            if updated_state.storyboard is not None
            else "{}"
        )
        production_plan_json = (
            json.dumps(updated_state.production_plan.model_dump())
            if updated_state.production_plan is not None
            else "{}"
        )
        production_queue_json = (
            json.dumps(updated_state.production_queue.model_dump())
            if updated_state.production_queue is not None
            else "{}"
        )
        qc_report_json = (
            json.dumps(updated_state.qc_report.model_dump())
            if updated_state.qc_report is not None
            else "{}"
        )

        # Phase 09.2: hash the column JSON already produced above instead of serializing the whole
        # project a second time (pydantic field order is deterministic, so hashes are stable).
        section_payloads = {
            "meta": json.dumps(updated_meta.model_dump(exclude={"updated_at"}), sort_keys=True),
            "scenes": scenes_json,
            "timeline": timeline_json,
            "script": json.dumps(updated_state.script.model_dump(exclude={"updated_at"})),
            "subtitles": subtitles_json,
            "director": director_json if updated_state.director is not None else "null",
            "storyboard": storyboard_json if updated_state.storyboard is not None else "null",
            "production_plan": production_plan_json if updated_state.production_plan is not None else "null",
            "production_queue": production_queue_json if updated_state.production_queue is not None else "null",
            "qc_report": qc_report_json if updated_state.qc_report is not None else "null",
        }
        section_hashes = {sec: hashlib.sha256(payload.encode("utf-8")).hexdigest() for sec, payload in section_payloads.items()}
        changed: list[str] = []
        revisions: dict[str, int] = {}

        with sqlite_transaction(db_path) as conn:
            stored = {
                r["section"]: (int(r["revision"]), r["content_hash"])
                for r in conn.execute("SELECT section, revision, content_hash FROM section_revisions").fetchall()
            }
            for sec, h in section_hashes.items():
                rev, old_hash = stored.get(sec, (0, ""))
                if h != old_hash:
                    rev += 1
                    changed.append(sec)
                    conn.execute(
                        "INSERT OR REPLACE INTO section_revisions (section, revision, content_hash) VALUES (?, ?, ?)",
                        (sec, rev, h),
                    )
                revisions[sec] = rev
            conn.execute(
                """
                INSERT OR REPLACE INTO project_meta (
                    project_id, name, description, schema_version, width, height,
                    fps, duration_ms, default_export_preset_id, auto_save_enabled,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    updated_meta.project_id,
                    updated_meta.name,
                    updated_meta.description,
                    updated_meta.schema_version,
                    updated_meta.width,
                    updated_meta.height,
                    updated_meta.fps,
                    updated_meta.duration_ms,
                    updated_meta.default_export_preset_id,
                    int(updated_meta.auto_save_enabled),
                    updated_meta.created_at,
                    updated_meta.updated_at,
                ),
            )
            conn.execute(
                """
                INSERT OR REPLACE INTO project_state (
                    id, scenes_json, timeline_json, script_json, subtitles_json,
                    director_json, storyboard_json, production_plan_json,
                    production_queue_json, qc_report_json, updated_at
                )
                VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    scenes_json,
                    timeline_json,
                    script_json,
                    subtitles_json,
                    director_json,
                    storyboard_json,
                    production_plan_json,
                    production_queue_json,
                    qc_report_json,
                    now,
                ),
            )

        if create_backup:
            create_project_backup(
                db_path,
                pdir / "backups",
                max_backups=self.config.max_backups_per_project,
                tag=backup_tag,
            )

        updated_state = updated_state.model_copy(update={"revisions": revisions})
        if changed:
            event = {
                "project_id": project_id,
                "revisions": revisions,
                "changed_sections": changed,
                "origin": origin,
                "updated_at": now,
            }
            for fn in list(self._listeners):
                try:
                    fn(event)
                except Exception as exc:  # a listener must never break a save
                    logger.warning("Project state listener failed: %s", exc)
        return updated_state

    def delete_project(self, project_id: str) -> None:
        pdir = self.config.project_dir(project_id)
        if not pdir.is_dir():
            raise FileNotFoundError(f"Project not found: {project_id}")
        shutil.rmtree(pdir)
        logger.info("Deleted project %s", project_id)

    def create_backup(self, project_id: str, tag: str = "manual") -> BackupInfo:
        pdir = self.config.project_dir(project_id)
        return create_project_backup(
            pdir / "project.db",
            pdir / "backups",
            max_backups=self.config.max_backups_per_project,
            tag=tag,
        )

    def list_backups(self, project_id: str) -> list[BackupInfo]:
        pdir = self.config.project_dir(project_id)
        if not pdir.is_dir():
            raise FileNotFoundError(f"Project not found: {project_id}")
        return list_project_backups(pdir / "backups")

    def restore_backup(self, project_id: str, backup_filename: str) -> ProjectState:
        pdir = self.config.project_dir(project_id)
        with self.project_lock(project_id):
            # Render/export history is not project *content*: keep jobs created after the backup.
            current_jobs = self.list_jobs(project_id)
            before = self.get_project_state(project_id).revisions
            restore_project_backup(
                pdir / "project.db",
                pdir / "backups",
                backup_filename=backup_filename,
                max_backups=self.config.max_backups_per_project,
            )
            restored = self.get_project_state(project_id)
            db_path = pdir / "project.db"
            # Revisions must move forward so every client treats the restored content as newest.
            with sqlite_transaction(db_path) as conn:
                for sec in PROJECT_SECTIONS:
                    rev = max(before.get(sec, 0), restored.revisions.get(sec, 0)) + 1
                    conn.execute(
                        "INSERT OR REPLACE INTO section_revisions (section, revision, content_hash) VALUES (?, ?, '')",
                        (sec, rev),
                    )
            self._jobs_schema_ready = getattr(self, "_jobs_schema_ready", set()) - {str(db_path)}
            for job in current_jobs:
                self.save_job(job)
            state = self.get_project_state(project_id)
        event = {"project_id": project_id, "revisions": state.revisions, "changed_sections": list(PROJECT_SECTIONS), "origin": "restore", "updated_at": state.meta.updated_at}
        for fn in list(self._listeners):
            try:
                fn(event)
            except Exception as exc:
                logger.warning("Project state listener failed: %s", exc)
        return state

    # --- Job Queue Persistence ---

    def save_job(self, job: RenderJob) -> RenderJob:
        db_path = self.config.project_db_path(job.project_id)
        if not db_path.is_file():
            raise FileNotFoundError(f"Project not found: {job.project_id}")
        self._ensure_jobs_schema(db_path)

        with sqlite_transaction(db_path) as conn:
            # Upsert (never INSERT OR REPLACE): REPLACE deletes the row first, which would
            # cascade-delete render_chunks and silently lose chunk progress.
            conn.execute(
                """
                INSERT INTO jobs (
                    job_id, project_id, job_type, status, progress_pct, message,
                    input_json, output_json, error_log, retry_count,
                    depends_on_job_id, started_at, ended_at, created_at,
                    name, queue_position, progress_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(job_id) DO UPDATE SET
                    job_type = excluded.job_type,
                    status = excluded.status,
                    progress_pct = excluded.progress_pct,
                    message = excluded.message,
                    input_json = excluded.input_json,
                    output_json = excluded.output_json,
                    error_log = excluded.error_log,
                    retry_count = excluded.retry_count,
                    depends_on_job_id = excluded.depends_on_job_id,
                    started_at = excluded.started_at,
                    ended_at = excluded.ended_at,
                    name = excluded.name,
                    queue_position = excluded.queue_position,
                    progress_json = excluded.progress_json
                """,
                (
                    job.job_id,
                    job.project_id,
                    job.job_type,
                    job.status,
                    job.progress_pct,
                    job.message,
                    json.dumps(job.input_json),
                    json.dumps(job.output_json) if job.output_json is not None else None,
                    job.error_log,
                    job.retry_count,
                    job.depends_on_job_id,
                    job.started_at,
                    job.ended_at,
                    job.created_at,
                    job.name,
                    job.queue_position,
                    json.dumps(job.progress or {}),
                ),
            )
            for chunk in job.chunks:
                conn.execute(
                    """
                    INSERT OR REPLACE INTO render_chunks (
                        chunk_id, job_id, chunk_index, start_frame, end_frame,
                        output_path, status, retry_count, error_message
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        chunk.chunk_id,
                        chunk.job_id,
                        chunk.chunk_index,
                        chunk.start_frame,
                        chunk.end_frame,
                        chunk.output_path,
                        chunk.status,
                        chunk.retry_count,
                        chunk.error_message,
                    ),
                )
        return job

    def update_chunk_status(
        self,
        project_id: str,
        chunk_id: str,
        status: JobStatus,
        error_message: str | None = None,
        retry_count: int | None = None,
    ) -> None:
        db_path = self.config.project_db_path(project_id)
        with sqlite_transaction(db_path) as conn:
            if retry_count is not None:
                conn.execute(
                    "UPDATE render_chunks SET status = ?, error_message = ?, retry_count = ? WHERE chunk_id = ?",
                    (status, error_message, retry_count, chunk_id),
                )
            else:
                conn.execute(
                    "UPDATE render_chunks SET status = ?, error_message = ? WHERE chunk_id = ?",
                    (status, error_message, chunk_id),
                )

    def delete_job(self, project_id: str, job_id: str) -> bool:
        """Delete a job record and its chunk rows. Never touches exported output files."""
        db_path = self.config.project_db_path(project_id)
        if not db_path.is_file():
            return False
        with sqlite_transaction(db_path) as conn:
            conn.execute("DELETE FROM render_chunks WHERE job_id = ?", (job_id,))
            cur = conn.execute("DELETE FROM jobs WHERE job_id = ?", (job_id,))
            return cur.rowcount > 0

    def _ensure_jobs_schema(self, db_path: Path) -> None:
        """Run the idempotent project.db migration once per process before touching jobs."""
        key = str(db_path)
        migrated = getattr(self, "_jobs_schema_ready", None)
        if migrated is None:
            migrated = set()
            self._jobs_schema_ready = migrated
        if key in migrated:
            return
        init_project_db(db_path)
        migrated.add(key)

    def get_job(self, project_id: str, job_id: str) -> RenderJob | None:
        db_path = self.config.project_db_path(project_id)
        if not db_path.is_file():
            return None
        self._ensure_jobs_schema(db_path)
        conn = connect_sqlite(db_path)
        try:
            row = conn.execute("SELECT * FROM jobs WHERE job_id = ?", (job_id,)).fetchone()
            if not row:
                return None
            chunk_rows = conn.execute(
                "SELECT * FROM render_chunks WHERE job_id = ? ORDER BY chunk_index ASC",
                (job_id,),
            ).fetchall()
        finally:
            conn.close()
        return self._row_to_job(row, chunk_rows)

    def list_jobs(self, project_id: str) -> list[RenderJob]:
        db_path = self.config.project_db_path(project_id)
        if not db_path.is_file():
            return []
        self._ensure_jobs_schema(db_path)
        conn = connect_sqlite(db_path)
        try:
            rows = conn.execute(
                "SELECT * FROM jobs ORDER BY created_at DESC LIMIT 200"
            ).fetchall()
            jobs: list[RenderJob] = []
            for row in rows:
                chunk_rows = conn.execute(
                    "SELECT * FROM render_chunks WHERE job_id = ? ORDER BY chunk_index ASC",
                    (row["job_id"],),
                ).fetchall()
                jobs.append(self._row_to_job(row, chunk_rows))
            return jobs
        finally:
            conn.close()

    @staticmethod
    def _row_to_job(row, chunk_rows) -> RenderJob:
        chunks = [
            RenderChunk(
                chunk_id=c["chunk_id"],
                job_id=c["job_id"],
                chunk_index=c["chunk_index"],
                start_frame=c["start_frame"],
                end_frame=c["end_frame"],
                output_path=c["output_path"],
                status=c["status"],
                retry_count=c["retry_count"],
                error_message=c["error_message"],
            )
            for c in chunk_rows
        ]
        return RenderJob(
            job_id=row["job_id"],
            project_id=row["project_id"],
            job_type=row["job_type"],
            status=row["status"],
            progress_pct=row["progress_pct"],
            message=row["message"],
            input_json=json.loads(row["input_json"]),
            output_json=json.loads(row["output_json"]) if row["output_json"] else None,
            error_log=row["error_log"],
            retry_count=row["retry_count"],
            depends_on_job_id=row["depends_on_job_id"],
            chunks=chunks,
            name=_row_get(row, "name", "") or "",
            queue_position=int(_row_get(row, "queue_position", 0) or 0),
            progress=_safe_json_dict(_row_get(row, "progress_json", "{}")),
            started_at=row["started_at"],
            ended_at=row["ended_at"],
            created_at=row["created_at"],
        )

    # --- Voice Audio Assets (Per-Project Managed Media) ---

    def save_voice_audio_asset(self, asset: VoiceAudioAsset) -> VoiceAudioAsset:
        db_path = self.config.project_db_path(asset.project_id)
        if not db_path.is_file():
            raise FileNotFoundError(f"Project not found: {asset.project_id}")
        init_project_db(db_path)
        with sqlite_transaction(db_path) as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO voice_audio_assets (
                    audio_asset_id, project_id, entry_id, character_id, voice_profile_id,
                    provider_id, provider_voice_id, provider_kind, is_mock, text,
                    file_path, duration_ms, sample_rate, channels, codec, waveform_json,
                    created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    asset.audio_asset_id,
                    asset.project_id,
                    asset.entry_id,
                    asset.character_id,
                    asset.voice_profile_id,
                    asset.provider_id,
                    asset.provider_voice_id,
                    asset.provider_kind,
                    int(asset.is_mock),
                    asset.text,
                    asset.file_path,
                    asset.duration_ms,
                    asset.sample_rate,
                    asset.channels,
                    asset.codec,
                    json.dumps(asset.waveform_peaks),
                    asset.created_at,
                ),
            )
        return asset

    def get_voice_audio_asset(self, project_id: str, audio_asset_id: str) -> VoiceAudioAsset | None:
        db_path = self.config.project_db_path(project_id)
        if not db_path.is_file():
            return None
        init_project_db(db_path)
        conn = connect_sqlite(db_path)
        try:
            row = conn.execute(
                "SELECT * FROM voice_audio_assets WHERE audio_asset_id = ?",
                (audio_asset_id,),
            ).fetchone()
        finally:
            conn.close()
        return self._row_to_voice_audio(row) if row else None

    def list_voice_audio_assets(self, project_id: str) -> list[VoiceAudioAsset]:
        db_path = self.config.project_db_path(project_id)
        if not db_path.is_file():
            return []
        init_project_db(db_path)
        conn = connect_sqlite(db_path)
        try:
            rows = conn.execute(
                "SELECT * FROM voice_audio_assets ORDER BY created_at DESC"
            ).fetchall()
        finally:
            conn.close()
        return [self._row_to_voice_audio(r) for r in rows]

    @staticmethod
    def _row_to_voice_audio(row) -> VoiceAudioAsset:
        return VoiceAudioAsset(
            audio_asset_id=row["audio_asset_id"],
            project_id=row["project_id"],
            entry_id=row["entry_id"],
            character_id=row["character_id"],
            voice_profile_id=row["voice_profile_id"],
            provider_id=row["provider_id"],
            provider_voice_id=row["provider_voice_id"],
            provider_kind=row["provider_kind"],
            is_mock=bool(row["is_mock"]),
            text=row["text"],
            file_path=row["file_path"],
            duration_ms=row["duration_ms"],
            sample_rate=row["sample_rate"],
            channels=row["channels"],
            codec=row["codec"],
            waveform_peaks=json.loads(row["waveform_json"]),
            created_at=row["created_at"],
        )


def _row_get(row, key: str, default=None):
    try:
        return row[key]
    except (IndexError, KeyError):
        return default


def _safe_json_dict(raw) -> dict:
    if not raw:
        return {}
    try:
        val = json.loads(raw)
        return val if isinstance(val, dict) else {}
    except Exception:
        return {}
