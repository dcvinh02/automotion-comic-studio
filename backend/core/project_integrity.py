"""Phase 09.3 — Structural project integrity report and safe missing-asset relinking.

`check_project_integrity` is diagnostic only: it never modifies or deletes data. It complements the
Production QC (which judges production readiness) with structural checks: duplicate IDs, dangling
references, invalid times, and library items / files that no longer exist.
"""

from __future__ import annotations

from collections import Counter

from schemas.project import ProjectState


def _dupes(ids: list[str]) -> list[str]:
    return sorted(i for i, n in Counter(ids).items() if n > 1)


def check_project_integrity(state: ProjectState, library_repo, asset_service, sound_service) -> dict:
    issues: list[dict] = []

    def add(code: str, severity: str, message: str, ref: str | None = None) -> None:
        issues.append({"code": code, "severity": severity, "message": message, "ref": ref})

    sc_ids = [s.scene_id for s in state.scenes]
    inst = [c.instance_id for s in state.scenes for c in s.characters]
    props = [p.prop_instance_id for s in state.scenes for p in s.props]
    shots = [sh.shot_id for s in state.scenes for sh in s.shots]
    tl = state.timeline
    for label, ids in (
        ("scene", sc_ids), ("character instance", inst), ("prop", props), ("shot", shots),
        ("keyframe", [k.keyframe_id for k in tl.keyframes]), ("track", [t.track_id for t in tl.tracks]),
        ("animation clip", [c.clip_id for c in tl.animation_clips]), ("audio clip", [e.event_id for e in tl.sound_events]),
        ("subtitle", [s.subtitle_id for s in state.subtitles.segments]),
    ):
        for d in _dupes(ids):
            add("DUPLICATE_ID", "error", f"Duplicate {label} ID '{d}'.", d)

    targets = set(inst) | set(props) | {"camera"} | set(sc_ids)
    for k in tl.keyframes:
        base = k.target_id.split(":")[0]
        if base not in targets:
            add("ORPHAN_KEYFRAME", "warning", f"Keyframe '{k.keyframe_id}' animates '{k.target_id}', which no longer exists.", k.keyframe_id)
        if k.time_ms < 0:
            add("INVALID_TIME", "error", f"Keyframe '{k.keyframe_id}' has a negative time.", k.keyframe_id)
    inst_set = set(inst)
    for c in tl.animation_clips:
        if c.instance_id not in inst_set:
            add("ORPHAN_CLIP", "warning", f"Animation clip '{c.clip_id}' targets a character that no longer exists.", c.clip_id)
        if c.end_ms <= c.start_ms:
            add("INVALID_DURATION", "error", f"Animation clip '{c.clip_id}' ends before it starts.", c.clip_id)
    track_ids = {t.track_id for t in tl.tracks}
    for e in tl.sound_events:
        if e.end_ms <= e.start_ms:
            add("INVALID_DURATION", "error", f"Audio clip '{e.event_id}' ends before it starts.", e.event_id)
        if e.track_id not in track_ids:
            add("ORPHAN_AUDIO", "warning", f"Audio clip '{e.event_id}' is on a track that no longer exists.", e.event_id)
    for s in state.subtitles.segments:
        if s.end_ms <= s.start_ms:
            add("INVALID_DURATION", "error", f"Subtitle '{s.subtitle_id}' ends before it starts.", s.subtitle_id)
    for s in state.scenes:
        if s.duration_ms <= 0:
            add("INVALID_DURATION", "error", f"Scene '{s.name}' has no duration.", s.scene_id)

    # Library references (shared library: items or files can disappear)
    asset_uses: dict[str, list[str]] = {}
    for s in state.scenes:
        if s.background_asset_id:
            asset_uses.setdefault(s.background_asset_id, []).append(f"{s.name}: background")
        for p in s.props:
            if p.asset_id:
                asset_uses.setdefault(p.asset_id, []).append(f"{s.name}: prop '{p.name}'")
        for sh in s.shots:
            if sh.background_asset_id:
                asset_uses.setdefault(sh.background_asset_id, []).append(f"{s.name} / {sh.title}: background")
            for ps in sh.prop_states:
                if ps.asset_id:
                    asset_uses.setdefault(ps.asset_id, []).append(f"{s.name} / {sh.title}: prop '{ps.name}'")
    missing_assets = []
    for aid, uses in sorted(asset_uses.items()):
        asset = library_repo.get_asset(aid)
        reason = None
        if not asset:
            reason = "removed from the library"
        elif not asset_service.resolve_asset_file(asset).is_file():
            reason = f"file missing on disk ({asset.file_path})"
        if reason:
            missing_assets.append({"asset_id": aid, "name": asset.name if asset else None, "reason": reason, "used_by": uses})
            add("MISSING_ASSET", "error", f"Asset {asset.name if asset else aid} is {reason}; used by {len(uses)} place(s).", aid)
    for cid in sorted({c.character_id for s in state.scenes for c in s.characters}):
        if not library_repo.get_character(cid):
            add("MISSING_CHARACTER", "error", f"Character '{cid}' is no longer in the library.", cid)
    for sid in sorted({e.sound_id for e in tl.sound_events}):
        snd = library_repo.get_sound(sid)
        if not snd:
            add("MISSING_SOUND", "error", f"Sound '{sid}' is no longer in the library.", sid)
        elif not sound_service.resolve_sound_file(snd).is_file():
            add("MISSING_SOUND", "error", f"Sound '{snd.name}' file is missing on disk.", sid)

    errors = sum(1 for i in issues if i["severity"] == "error")
    return {
        "project_id": state.meta.project_id,
        "ok": errors == 0,
        "error_count": errors,
        "warning_count": sum(1 for i in issues if i["severity"] == "warning"),
        "issues": issues,
        "missing_assets": missing_assets,
    }


def relink_asset_references(state: ProjectState, from_id: str, to_id: str) -> tuple[ProjectState, int]:
    """Replace every scene/shot reference to `from_id` with `to_id`. Returns (new_state, count)."""
    st = state.model_copy(deep=True)
    n = 0
    for s in st.scenes:
        if s.background_asset_id == from_id:
            s.background_asset_id, n = to_id, n + 1
        for p in s.props:
            if p.asset_id == from_id:
                p.asset_id, n = to_id, n + 1
        for sh in s.shots:
            if sh.background_asset_id == from_id:
                sh.background_asset_id, n = to_id, n + 1
            for ps in sh.prop_states:
                if ps.asset_id == from_id:
                    ps.asset_id, n = to_id, n + 1
            if from_id in sh.asset_refs:
                sh.asset_refs = [to_id if a == from_id else a for a in sh.asset_refs]
    return st, n
