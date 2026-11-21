"""Schema migrations and default seeding for workspace/asset_library/library.db."""

from __future__ import annotations

import json
from pathlib import Path

from core.animation_execution_engine.builtin_presets import get_builtin_motion_presets
from database.connection import sqlite_transaction

LIBRARY_SCHEMA_VERSION = "5"

BUILTIN_EXPORT_PRESETS = (
    (
        "preset_720p_preview",
        "720p Preview (30fps)",
        1280,
        720,
        30,
        "auto",
        4000,
        "aac",
        128,
        48000,
        1,
    ),
    (
        "preset_1080p_final",
        "1080p Final (30fps)",
        1920,
        1080,
        30,
        "auto",
        8000,
        "aac",
        192,
        48000,
        1,
    ),
    (
        "preset_1080p_60fps",
        "1080p Smooth (60fps)",
        1920,
        1080,
        60,
        "auto",
        12000,
        "aac",
        192,
        48000,
        1,
    ),
)


def init_library_db(db_path: Path) -> None:
    """Create tables and seed built-in export presets idempotently."""
    with sqlite_transaction(db_path) as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS schema_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS assets (
                asset_id TEXT PRIMARY KEY,
                scope TEXT NOT NULL,
                project_id TEXT,
                type TEXT NOT NULL,
                part_role TEXT,
                name TEXT NOT NULL,
                folder TEXT NOT NULL,
                tags_json TEXT NOT NULL,
                file_path TEXT NOT NULL,
                sha256 TEXT NOT NULL,
                width INTEGER NOT NULL,
                height INTEGER NOT NULL,
                anchor_x REAL NOT NULL,
                anchor_y REAL NOT NULL,
                version INTEGER NOT NULL DEFAULT 1,
                identity_verified INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(type);
            CREATE INDEX IF NOT EXISTS idx_assets_folder ON assets(folder);
            CREATE INDEX IF NOT EXISTS idx_assets_sha256 ON assets(sha256);

            CREATE TABLE IF NOT EXISTS characters (
                character_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                tags_json TEXT NOT NULL DEFAULT '[]',
                identity_confirmed INTEGER NOT NULL DEFAULT 0,
                thumbnail_asset_id TEXT,
                voice_profile_id TEXT,
                rig_json TEXT NOT NULL,
                version INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sounds (
                sound_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                audio_type TEXT NOT NULL DEFAULT 'sfx',
                category TEXT NOT NULL,
                tags_json TEXT NOT NULL DEFAULT '[]',
                file_path TEXT NOT NULL,
                sha256 TEXT NOT NULL,
                duration_ms INTEGER NOT NULL,
                sample_rate INTEGER NOT NULL,
                channels INTEGER NOT NULL,
                codec TEXT NOT NULL,
                default_volume REAL NOT NULL DEFAULT 0.8,
                loopable INTEGER NOT NULL DEFAULT 0,
                fade_in_ms INTEGER NOT NULL DEFAULT 0,
                fade_out_ms INTEGER NOT NULL DEFAULT 0,
                is_favorite INTEGER NOT NULL DEFAULT 0,
                is_bundled INTEGER NOT NULL DEFAULT 0,
                waveform_json TEXT NOT NULL DEFAULT '[]',
                license_json TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_sounds_category ON sounds(category);
            CREATE INDEX IF NOT EXISTS idx_sounds_favorite ON sounds(is_favorite);

            CREATE TABLE IF NOT EXISTS export_presets (
                preset_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                width INTEGER NOT NULL,
                height INTEGER NOT NULL,
                fps INTEGER NOT NULL,
                video_codec TEXT NOT NULL,
                video_bitrate_kbps INTEGER NOT NULL,
                audio_codec TEXT NOT NULL,
                audio_bitrate_kbps INTEGER NOT NULL,
                sample_rate INTEGER NOT NULL,
                is_builtin INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS voice_profiles (
                voice_profile_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                provider_id TEXT NOT NULL,
                provider_voice_id TEXT NOT NULL,
                language TEXT NOT NULL DEFAULT 'vi-VN',
                settings_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value_json TEXT NOT NULL DEFAULT '{}',
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS motion_presets (
                preset_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                category TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                is_builtin INTEGER NOT NULL DEFAULT 0,
                spec_json TEXT NOT NULL,
                tags_json TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_motion_presets_category ON motion_presets(category);
            """
        )

        # Safe backward-compatible v2 -> v3 column migration on existing sounds tables
        sound_cols = {
            row["name"]
            for row in conn.execute("PRAGMA table_info(sounds)").fetchall()
        }
        if "audio_type" not in sound_cols:
            conn.execute(
                "ALTER TABLE sounds ADD COLUMN audio_type TEXT NOT NULL DEFAULT 'sfx'"
            )
        if "is_bundled" not in sound_cols:
            conn.execute(
                "ALTER TABLE sounds ADD COLUMN is_bundled INTEGER NOT NULL DEFAULT 0"
            )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_sounds_audio_type ON sounds(audio_type)"
        )

        conn.execute(
            "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', ?)",
            (LIBRARY_SCHEMA_VERSION,),
        )

        conn.executemany(
            """
            INSERT OR IGNORE INTO export_presets (
                preset_id, name, width, height, fps, video_codec,
                video_bitrate_kbps, audio_codec, audio_bitrate_kbps,
                sample_rate, is_builtin
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            BUILTIN_EXPORT_PRESETS,
        )

        # Idempotently seed built-in Motion Library presets (Phase 07 Batch 2)
        for mp in get_builtin_motion_presets():
            conn.execute(
                """
                INSERT OR IGNORE INTO motion_presets (
                    preset_id, name, category, description, is_builtin,
                    spec_json, tags_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    mp.preset_id,
                    mp.name,
                    mp.category,
                    mp.description,
                    1 if mp.is_builtin else 0,
                    mp.model_dump_json(),
                    json.dumps(mp.tags),
                    mp.created_at,
                    mp.updated_at,
                ),
            )
