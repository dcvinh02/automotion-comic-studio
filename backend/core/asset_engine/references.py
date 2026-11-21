"""Phase 09.1 — Cross-project reference lookup for shared library assets and characters.

The asset library (`library.db`) is shared by every project. Deleting an asset or character that
is still referenced used to succeed silently (and delete the image file), leaving broken
backgrounds / props / rigs in other projects that the preview and render then skipped without
any error. These helpers find real usages so deletion can be refused or explicitly confirmed.
"""

from __future__ import annotations

from database.library_repo import LibraryRepository
from database.project_repo import ProjectRepository


def find_asset_references(asset_id: str, library_repo: LibraryRepository, project_repo: ProjectRepository) -> list[dict]:
    refs: list[dict] = []
    for ch in library_repo.list_characters():
        slots = [p.name for p in ch.parts if p.default_asset_id == asset_id or asset_id in p.variants.values()]
        if slots or ch.thumbnail_asset_id == asset_id:
            refs.append({"kind": "character", "id": ch.character_id, "name": ch.name, "where": ", ".join(slots) or "thumbnail"})
    for summary in project_repo.list_projects():
        try:
            st = project_repo.get_project_state(summary.project_id)
        except Exception:
            continue
        where: list[str] = []
        for sc in st.scenes:
            if sc.background_asset_id == asset_id:
                where.append(f"{sc.name}: background")
            where.extend(f"{sc.name}: prop '{p.name}'" for p in sc.props if p.asset_id == asset_id)
            for sh in sc.shots:
                if sh.background_asset_id == asset_id:
                    where.append(f"{sc.name} / {sh.title}: background")
                where.extend(f"{sc.name} / {sh.title}: prop '{ps.name}'" for ps in sh.prop_states if ps.asset_id == asset_id)
        if where:
            refs.append({"kind": "project", "id": st.meta.project_id, "name": st.meta.name, "where": "; ".join(where[:6])})
    return refs


def find_character_references(character_id: str, project_repo: ProjectRepository) -> list[dict]:
    refs: list[dict] = []
    for summary in project_repo.list_projects():
        try:
            st = project_repo.get_project_state(summary.project_id)
        except Exception:
            continue
        scenes = [sc.name for sc in st.scenes if any(c.character_id == character_id for c in sc.characters)]
        if scenes:
            refs.append({"kind": "project", "id": st.meta.project_id, "name": st.meta.name, "where": ", ".join(scenes[:6])})
    return refs
