"""Atomic SQLite backup and recovery service for projects."""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from app.logging_config import get_logger
from schemas.project import BackupInfo

logger = get_logger("backup")


def create_project_backup(
    project_db_path: Path,
    backups_dir: Path,
    max_backups: int = 10,
    tag: str = "auto",
) -> BackupInfo:
    """Create a consistent SQLite backup using SQLite's online backup API."""
    if not project_db_path.is_file():
        raise FileNotFoundError(f"Project DB does not exist: {project_db_path}")

    backups_dir.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc)
    stamp = now.strftime("%Y%m%d_%H%M%S_%f")
    filename = f"project_{tag}_{stamp}.db"
    dest_path = backups_dir / filename

    src_conn = sqlite3.connect(str(project_db_path), timeout=10.0)
    dst_conn = sqlite3.connect(str(dest_path), timeout=10.0)
    try:
        src_conn.backup(dst_conn)
    finally:
        dst_conn.close()
        src_conn.close()

    _prune_old_backups(backups_dir, max_backups)
    size_bytes = dest_path.stat().st_size
    logger.info("Created project backup %s (%d bytes)", filename, size_bytes)
    return BackupInfo(
        backup_id=dest_path.stem,
        filename=filename,
        created_at=now.isoformat(),
        size_bytes=size_bytes,
    )


def list_project_backups(backups_dir: Path) -> list[BackupInfo]:
    if not backups_dir.is_dir():
        return []
    files = sorted(
        (p for p in backups_dir.glob("project_*.db") if p.is_file()),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    results: list[BackupInfo] = []
    for p in files:
        stat = p.stat()
        results.append(
            BackupInfo(
                backup_id=p.stem,
                filename=p.name,
                created_at=datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
                size_bytes=stat.st_size,
            )
        )
    return results


def restore_project_backup(
    project_db_path: Path,
    backups_dir: Path,
    backup_filename: str,
    max_backups: int = 10,
) -> BackupInfo:
    """Restore a project database from a backup file safely (with pre-restore snapshot)."""
    if "/" in backup_filename or "\\" in backup_filename or ".." in backup_filename:
        raise ValueError("Invalid backup filename")
    src_backup = (backups_dir / backup_filename).resolve()
    if not src_backup.is_file() or src_backup.parent != backups_dir.resolve():
        raise FileNotFoundError(f"Backup not found: {backup_filename}")

    # Safety snapshot before overwrite
    if project_db_path.is_file():
        create_project_backup(
            project_db_path,
            backups_dir,
            max_backups=max_backups + 2,
            tag="pre_restore",
        )

    src_conn = sqlite3.connect(str(src_backup), timeout=10.0)
    dst_conn = sqlite3.connect(str(project_db_path), timeout=10.0)
    try:
        src_conn.backup(dst_conn)
    finally:
        dst_conn.close()
        src_conn.close()

    logger.info("Restored project DB from backup %s", backup_filename)
    stat = src_backup.stat()
    return BackupInfo(
        backup_id=src_backup.stem,
        filename=src_backup.name,
        created_at=datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
        size_bytes=stat.st_size,
    )


def _prune_old_backups(backups_dir: Path, max_backups: int) -> None:
    files = sorted(
        (p for p in backups_dir.glob("project_*.db") if p.is_file()),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    for stale in files[max_backups:]:
        try:
            stale.unlink()
        except OSError:
            pass
