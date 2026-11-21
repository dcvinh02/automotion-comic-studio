"""Phase 09.2 — Per-run memoization for QC library lookups.

QC passes look up the same library asset/sound/character once per *reference* (a stress project
made 446 SQLite connections per run for ~180 distinct items). This proxy memoizes lookups for the
duration of a single QC run only, so results can never go stale across runs.
"""

from __future__ import annotations

from typing import Any


class RunScopedLibrary:
    def __init__(self, library_repo: Any) -> None:
        self._repo = library_repo
        self._memo: dict[tuple[str, str], Any] = {}

    def _get(self, kind: str, key: str, fn):
        k = (kind, key)
        if k not in self._memo:
            self._memo[k] = fn(key)
        return self._memo[k]

    def get_asset(self, asset_id: str):
        return self._get("asset", asset_id, self._repo.get_asset)

    def get_sound(self, sound_id: str):
        return self._get("sound", sound_id, self._repo.get_sound)

    def get_character(self, character_id: str):
        return self._get("character", character_id, self._repo.get_character)

    def __getattr__(self, name: str):  # everything else passes through unchanged
        return getattr(self._repo, name)


class RunScopedFiles:
    """Memoizes `resolve_*_file(x).is_file()`-style path resolution per run."""

    def __init__(self, service: Any) -> None:
        self._svc = service
        self._memo: dict[tuple[str, str], Any] = {}

    def __getattr__(self, name: str):
        attr = getattr(self._svc, name)
        if not name.startswith("resolve_") or not callable(attr):
            return attr

        def memo(obj, *a, **kw):
            key = (name, getattr(obj, "asset_id", None) or getattr(obj, "sound_id", None) or repr(obj))
            if a or kw or key[1] is None:
                return attr(obj, *a, **kw)
            if key not in self._memo:
                self._memo[key] = attr(obj)
            return self._memo[key]

        return memo
