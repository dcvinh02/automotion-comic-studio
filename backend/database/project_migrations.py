"""Schema migrations for per-project SQLite database (projects/<id>/project.db)."""

from __future__ import annotations

from pathlib import Path

from database.connection import sqlite_transaction

PROJECT_SCHEMA_VERSION = "11"


def init_project_db(db_path: Path) -> None:
    """Create tables inside a project's SQLite database idempotently and migrate v1 -> v2 safely."""
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
