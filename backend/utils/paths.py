"""Cross-platform safe path utilities and hashing helpers."""

from __future__ import annotations

import hashlib
import re
from pathlib import Path


_SAFE_FILENAME_RE = re.compile(r"[^A-Za-z0-9._-]+")


def sanitize_filename(name: str, fallback: str = "file") -> str:
    """Return a clean cross-platform filename without directory components."""
    base = Path(name).name.strip()
    cleaned = _SAFE_FILENAME_RE.sub("_", base).strip("._")
    return cleaned or fallback


def to_posix_relative(path: Path, base: Path) -> str:
    """Convert an absolute path under base into a portable POSIX relative string."""
    rel = path.resolve().relative_to(base.resolve())
    return rel.as_posix()


def safe_resolve_under(base: Path, relative_path: str) -> Path:
    """Resolve a relative path under base, raising ValueError on path traversal."""
    base_resolved = base.resolve()
    candidate = (base_resolved / Path(relative_path)).resolve()
    try:
        candidate.relative_to(base_resolved)
    except ValueError as exc:
        raise ValueError(f"Path traversal detected: {relative_path!r}") from exc
    return candidate


def compute_sha256_file(path: Path, chunk_size: int = 65536) -> str:
    """Compute SHA-256 hex digest for a file on disk."""
    digest = hashlib.sha256()
    with path.open("rb") as f:
        while True:
            block = f.read(chunk_size)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def compute_sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()
