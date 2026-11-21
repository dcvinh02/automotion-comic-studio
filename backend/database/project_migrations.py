"""Schema migrations for per-project SQLite database (projects/<id>/project.db)."""

from __future__ import annotations

import sqlite3
import threading
from pathlib import Path

from database.connection import sqlite_transaction

PROJECT_SCHEMA_VERSION = "11"


class ProjectVersionUnsupportedError(RuntimeError):
    """The project was written by a newer app version (never downgrade or rewrite it)."""


class ProjectDatabaseCorruptError(RuntimeError):
    """The project database failed SQLite's integrity check or cannot be read."""


_checked: dict[str, int] = {}  # db path -> mtime_ns at last successful integrity check
_check_lock = threading.Lock()


def _read_version(db_path: Path) -> int | None:
    if not db_path.is_file() or db_path.stat().st_size == 0:
        return None
    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=10.0)
        try:
            tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if "schema_meta" not in tables:
                return None
            row = con.execute("SELECT value FROM schema_meta WHERE key='version'").fetchone()
            return int(row[0]) if row and str(row[0]).isdigit() else None
        finally:
            con.close()
    except sqlite3.DatabaseError as exc:
        raise ProjectDatabaseCorruptError(f"Project database cannot be read: {exc}") from exc


def _quick_check(db_path: Path) -> None:
    try:
        con = sqlite3.connect(str(db_path), timeout=10.0)
        try:
            res = con.execute("PRAGMA quick_check").fetchone()
        finally:
            con.close()
    except sqlite3.DatabaseError as exc:
        raise ProjectDatabaseCorruptError(f"Project database cannot be read: {exc}") from exc
    if not res or res[0] != "ok":
        raise ProjectDatabaseCorruptError(f"Project database failed its integrity check: {res[0] if res else 'no result'}")


def init_project_db(db_path: Path) -> None:
    """Validate, back up when upgrading, then create/migrate tables idempotently (Phase 09.3).

    Once per process per database: SQLite quick_check (corruption → clear error, nothing written),
    refusal of projects from a newer app version (never downgraded), and a validated
    `pre_migration` backup before an older schema is upgraded. The new version is recorded last,
    only after every migration step succeeded.
    """
    version = _read_version(db_path)  # cheap (~1 ms): every open, so external changes are noticed
    if version is not None:
        if version > int(PROJECT_SCHEMA_VERSION):
            raise ProjectVersionUnsupportedError(
                f"This project was saved by a newer version of AutoMotion Comic Studio "
                f"(project format v{version}, this app supports up to v{PROJECT_SCHEMA_VERSION}). "
                "It was not opened or modified."
            )
        key = str(db_path)
        mtime = db_path.stat().st_mtime_ns
        if _checked.get(key) != mtime:
            with _check_lock:
                if _checked.get(key) != mtime:
                    _quick_check(db_path)
                    _checked[key] = mtime
        if version < int(PROJECT_SCHEMA_VERSION):
            from database.backup import create_project_backup  # local import: avoid cycle

            create_project_backup(db_path, db_path.parent / "backups", tag="pre_migration")
    _migrate(db_path)
    if version is not None and version < int(PROJECT_SCHEMA_VERSION):
        _checked[str(db_path)] = db_path.stat().st_mtime_ns


def forget_checked(db_path: Path) -> None:
    """Re-run validation on next open (after a restore replaced the file)."""
    with _check_lock:
        _checked.pop(str(db_path), None)


def _migrate(db_path: Path) -> None:
    with sqlite_transaction(db_path) as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS schema_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS project_meta (
                project_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                schema_version TEXT NOT NULL,
                width INTEGER NOT NULL,
                height INTEGER NOT NULL,
                fps INTEGER NOT NULL,
                duration_ms INTEGER NOT NULL,
                default_export_preset_id TEXT NOT NULL,
                auto_save_enabled INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS project_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                scenes_json TEXT NOT NULL,
                timeline_json TEXT NOT NULL,
                script_json TEXT NOT NULL DEFAULT '{}',
                subtitles_json TEXT NOT NULL DEFAULT '{}',
                director_json TEXT NOT NULL DEFAULT '{}',
                storyboard_json TEXT NOT NULL DEFAULT '{}',
                production_plan_json TEXT NOT NULL DEFAULT '{}',
                production_queue_json TEXT NOT NULL DEFAULT '{}',
                qc_report_json TEXT NOT NULL DEFAULT '{}',
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS voice_audio_assets (
                audio_asset_id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                entry_id TEXT,
                character_id TEXT,
                voice_profile_id TEXT,
                provider_id TEXT NOT NULL,
                provider_voice_id TEXT NOT NULL,
                provider_kind TEXT NOT NULL,
                is_mock INTEGER NOT NULL DEFAULT 0,
                text TEXT NOT NULL,
                file_path TEXT NOT NULL,
                duration_ms INTEGER NOT NULL,
                sample_rate INTEGER NOT NULL,
                channels INTEGER NOT NULL,
                codec TEXT NOT NULL,
                waveform_json TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_voice_audio_entry ON voice_audio_assets(entry_id);

            CREATE TABLE IF NOT EXISTS jobs (
                job_id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                job_type TEXT NOT NULL,
                status TEXT NOT NULL,
                progress_pct REAL NOT NULL DEFAULT 0.0,
                message TEXT NOT NULL DEFAULT '',
                input_json TEXT NOT NULL,
                output_json TEXT,
                error_log TEXT,
                retry_count INTEGER NOT NULL DEFAULT 0,
                depends_on_job_id TEXT,
                started_at TEXT,
                ended_at TEXT,
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

            CREATE TABLE IF NOT EXISTS render_chunks (
                chunk_id TEXT PRIMARY KEY,
                job_id TEXT NOT NULL,
                chunk_index INTEGER NOT NULL,
                start_frame INTEGER NOT NULL,
                end_frame INTEGER NOT NULL,
                output_path TEXT NOT NULL,
                status TEXT NOT NULL,
                retry_count INTEGER NOT NULL DEFAULT 0,
                error_message TEXT,
                FOREIGN KEY(job_id) REFERENCES jobs(job_id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_chunks_job ON render_chunks(job_id, chunk_index);
            """
        )

        # Safe backward-compatible v1 -> v2 -> v3 column migrations on existing project_state tables
        cols = {
            row["name"]
            for row in conn.execute("PRAGMA table_info(project_state)").fetchall()
        }
        if "script_json" not in cols:
            conn.execute(
                "ALTER TABLE project_state ADD COLUMN script_json TEXT NOT NULL DEFAULT '{}'"
            )
        if "subtitles_json" not in cols:
            conn.execute(
                "ALTER TABLE project_state ADD COLUMN subtitles_json TEXT NOT NULL DEFAULT '{}'"
            )
        if "director_json" not in cols:
            conn.execute(
                "ALTER TABLE project_state ADD COLUMN director_json TEXT NOT NULL DEFAULT '{}'"
            )
        if "storyboard_json" not in cols:
            conn.execute(
                "ALTER TABLE project_state ADD COLUMN storyboard_json TEXT NOT NULL DEFAULT '{}'"
            )
        if "production_plan_json" not in cols:
            conn.execute(
                "ALTER TABLE project_state ADD COLUMN production_plan_json TEXT NOT NULL DEFAULT '{}'"
            )
        if "production_queue_json" not in cols:
            conn.execute(
                "ALTER TABLE project_state ADD COLUMN production_queue_json TEXT NOT NULL DEFAULT '{}'"
            )
        if "qc_report_json" not in cols:
            conn.execute(
                "ALTER TABLE project_state ADD COLUMN qc_report_json TEXT NOT NULL DEFAULT '{}'"
            )

        # Phase 08 Batch 3 (v9 -> v10): render queue name / ordering / live progress columns
        job_cols = {row["name"] for row in conn.execute("PRAGMA table_info(jobs)").fetchall()}
        if "name" not in job_cols:
            conn.execute("ALTER TABLE jobs ADD COLUMN name TEXT NOT NULL DEFAULT ''")
        if "queue_position" not in job_cols:
            conn.execute("ALTER TABLE jobs ADD COLUMN queue_position INTEGER NOT NULL DEFAULT 0")
        if "progress_json" not in job_cols:
            conn.execute("ALTER TABLE jobs ADD COLUMN progress_json TEXT NOT NULL DEFAULT '{}'")

        # Phase 09.1 (v10 -> v11): per-section revision counters for safe concurrent saves
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS section_revisions (
                section TEXT PRIMARY KEY,
                revision INTEGER NOT NULL DEFAULT 0,
                content_hash TEXT NOT NULL DEFAULT ''
            )
            """
        )

        conn.execute(
            "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', ?)",
            (PROJECT_SCHEMA_VERSION,),
        )
