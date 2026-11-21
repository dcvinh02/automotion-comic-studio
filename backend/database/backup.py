"""Atomic, validated SQLite backup and restore for projects.

Phase 09.3 hardening:
- Backups are written to a hidden `.partial` file with SQLite's online backup API, validated
  (`PRAGMA integrity_check` + required tables/rows), and only then atomically renamed into place.
  An interrupted or invalid backup can therefore never appear as a usable backup.
- Retention is per tag: automatic backups (exports, sync conflicts, autosave…) can never push out
  manual backups, the initial snapshot or pre-restore / pre-migration safety copies.
- Restore validates the chosen backup before touching the live database and snapshots the
  current state first (`pre_restore`).
"""

from __future__ import annotations

import os
import re
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path

from app.logging_config import get_logger
from schemas.project import BackupInfo

logger = get_logger("backup")

_NAME_RE = re.compile(r"^project_(?P<tag>[a-z_]+?)_(?P<stamp>\d{8}_\d{6}_\d{6})\.db$")

# How many backups of each tag are kept (newest first). Tags not listed use `max_backups`.
RETENTION_BY_TAG: dict[str, int] = {
    "init": 1,
    "manual": 30,
    "pre_restore": 5,
    "pre_migration": 5,
    "pre_recovery": 5,
    "conflict": 10,
    "pre_export": 5,
    "auto": 10,
}


# Safety copies the user relies on; their retention is independent of the automatic-backup limit.
PROTECTED_TAGS = frozenset({"init", "manual", "pre_restore", "pre_migration", "pre_recovery"})


class InvalidBackupError(Exception):
    pass


def parse_backup_tag(filename: str) -> str:
    m = _NAME_RE.match(filename)
    return m.group("tag") if m else "unknown"


def validate_backup_file(path: Path) -> tuple[bool, str]:
    """Open read-only and check integrity + required project content. Never raises."""
    try:
        if not path.is_file() or path.stat().st_size < 1024:
            return False, "file missing or truncated"
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5.0)
        try:
            res = con.execute("PRAGMA integrity_check").fetchone()
            if not res or res[0] != "ok":
                return False, f"integrity check failed: {res[0] if res else 'no result'}"
            tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            for required in ("project_meta", "project_state", "schema_meta"):
                if required not in tables:
                    return False, f"missing table {required}"
            if con.execute("SELECT COUNT(*) FROM project_state").fetchone()[0] < 1:
                return False, "no project state row"
            if con.execute("SELECT COUNT(*) FROM project_meta").fetchone()[0] < 1:
                return False, "no project metadata row"
        finally:
            con.close()
        return True, "ok"
    except sqlite3.DatabaseError as exc:
        return False, f"not a valid database ({exc})"
    except OSError as exc:
        return False, f"unreadable ({exc})"


def create_project_backup(
    project_db_path: Path,
    backups_dir: Path,
    max_backups: int = 10,
    tag: str = "auto",
) -> BackupInfo:
    """Create a consistent, validated backup; returns only after it is safely in place."""
    if not project_db_path.is_file():
        raise FileNotFoundError(f"Project DB does not exist: {project_db_path}")
    if not re.fullmatch(r"[a-z_]+", tag):
        raise ValueError(f"Invalid backup tag: {tag!r}")

    backups_dir.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc)
    stamp = now.strftime("%Y%m%d_%H%M%S_%f")
    filename = f"project_{tag}_{stamp}.db"
    dest_path = backups_dir / filename
    partial = backups_dir / f".{filename}.partial"

    src_conn = sqlite3.connect(str(project_db_path), timeout=10.0)
    dst_conn = sqlite3.connect(str(partial), timeout=10.0)
    try:
        src_conn.backup(dst_conn)
    except Exception:
        dst_conn.close()
        src_conn.close()
        partial.unlink(missing_ok=True)
        raise
    finally:
        try:
            dst_conn.close()
        finally:
            src_conn.close()

    ok, reason = validate_backup_file(partial)
    if not ok:
        partial.unlink(missing_ok=True)
        raise InvalidBackupError(f"Backup failed validation ({reason}); the previous backups are untouched.")
    with partial.open("rb") as fh:  # make sure the bytes are on disk before publishing the name
        os.fsync(fh.fileno())
    os.replace(partial, dest_path)

    _prune_old_backups(backups_dir, max_backups)
    size_bytes = dest_path.stat().st_size
    logger.info("Created project backup %s (%d bytes)", filename, size_bytes)
    return _info(dest_path, valid=True, reason="ok")


def _info(p: Path, valid: bool | None = None, reason: str = "") -> BackupInfo:
    stat = p.stat()
    m = _NAME_RE.match(p.name)
    created = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc)
    if m:
        try:
            created = datetime.strptime(m.group("stamp"), "%Y%m%d_%H%M%S_%f").replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    return BackupInfo(
        backup_id=p.stem,
        filename=p.name,
        created_at=created.isoformat(),
        size_bytes=stat.st_size,
        tag=parse_backup_tag(p.name),
        valid=valid,
        validation_message=reason,
    )


def list_project_backups(backups_dir: Path, validate: bool = True) -> list[BackupInfo]:
    if not backups_dir.is_dir():
        return []
    files = [p for p in backups_dir.glob("project_*.db") if p.is_file()]
    results = []
    for p in files:
        ok, reason = validate_backup_file(p) if validate else (None, "")
        results.append(_info(p, valid=ok, reason=reason))
    results.sort(key=lambda b: b.created_at, reverse=True)
    return results


def restore_project_backup(
    project_db_path: Path,
    backups_dir: Path,
    backup_filename: str,
    max_backups: int = 10,
) -> BackupInfo:
    """Restore a project database from a validated backup (current state is snapshotted first)."""
    if "/" in backup_filename or "\\" in backup_filename or ".." in backup_filename:
        raise ValueError("Invalid backup filename")
    src_backup = (backups_dir / backup_filename).resolve()
    if not src_backup.is_file() or src_backup.parent != backups_dir.resolve():
        raise FileNotFoundError(f"Backup not found: {backup_filename}")
    ok, reason = validate_backup_file(src_backup)
    if not ok:
        raise InvalidBackupError(f"This backup cannot be restored: {reason}. The project was not changed.")

    # Safety snapshot before overwrite (skipped only if the current DB is itself unreadable)
    if project_db_path.is_file():
        try:
            create_project_backup(project_db_path, backups_dir, max_backups=max_backups, tag="pre_restore")
        except Exception as exc:
            cur_ok, _ = validate_backup_file(project_db_path)
            if cur_ok:
                raise RuntimeError(f"Could not snapshot the current project before restoring: {exc}") from exc
            logger.warning("Current project DB is damaged; restoring without pre-restore snapshot: %s", exc)

    cur_ok, _ = validate_backup_file(project_db_path) if project_db_path.is_file() else (True, "")
    if not cur_ok:
        # Keep the damaged file for diagnosis (never deleted) and restore into a fresh database.
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        os.replace(project_db_path, project_db_path.with_name(f"project.db.damaged-{stamp}"))
        for suffix in ("-wal", "-shm"):
            side = Path(str(project_db_path) + suffix)
            if side.exists():
                os.replace(side, side.with_name(f"{side.name}.damaged-{stamp}"))
    src_conn = sqlite3.connect(f"file:{src_backup}?mode=ro", uri=True, timeout=10.0)
    dst_conn = sqlite3.connect(str(project_db_path), timeout=10.0)
    try:
        src_conn.backup(dst_conn)  # transactional page copy
    finally:
        dst_conn.close()
        src_conn.close()

    logger.info("Restored project DB from backup %s", backup_filename)
    return _info(src_backup, valid=True, reason="ok")


def cleanup_stale_partials(backups_dir: Path, older_than_s: float = 3600.0) -> int:
    """Remove `.partial` files left by an interrupted backup (never touches real backups)."""
    if not backups_dir.is_dir():
        return 0
    removed = 0
    for p in backups_dir.glob(".project_*.db.partial"):
        try:
            if time.time() - p.stat().st_mtime > older_than_s:
                p.unlink()
                removed += 1
        except OSError:
            pass
    return removed


def _prune_old_backups(backups_dir: Path, max_backups: int) -> None:
    by_tag: dict[str, list[Path]] = {}
    for p in backups_dir.glob("project_*.db"):
        if p.is_file():
            by_tag.setdefault(parse_backup_tag(p.name), []).append(p)
    for tag, files in by_tag.items():
        keep = RETENTION_BY_TAG.get(tag, max_backups)
        if tag not in PROTECTED_TAGS:
            keep = max(1, min(keep, max_backups))
        files.sort(key=lambda p: p.name, reverse=True)  # names embed a sortable UTC timestamp
        for stale in files[keep:]:
            try:
                stale.unlink()
            except OSError:
                pass
