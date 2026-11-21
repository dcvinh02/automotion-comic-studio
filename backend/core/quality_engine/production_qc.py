"""Phase 07 Batch 3 — Comprehensive 8-Category Production Quality Control Analyzer.

Analyzes real project data across all 8 required domains:
1. Asset Validation
2. Scene Validation
3. Canvas Validation
4. Animation Validation
5. Camera Validation
6. Audio Validation
7. Subtitle Validation
8. Production Validation
"""

from __future__ import annotations

import hashlib
import math
from pathlib import Path

from core.animation_execution_engine.camera_motion import evaluate_camera_execution_support
from core.animation_execution_engine.capabilities import (
    check_preset_compatibility,
    inspect_character_capabilities,
    resolve_action_to_preset,
)
from core.asset_engine.service import AssetService
from core.sound_engine.service import SoundService
from core.quality_engine.lookup_cache import RunScopedFiles, RunScopedLibrary
from database.library_repo import LibraryRepository
from schemas.common import utc_now_iso
from schemas.production_queue import (
    ProductionQCCategory,
    ProductionQCFixRequest,
    ProductionQCIssue,
    ProductionQCReport,
    ProductionQueueDocument,
)
from schemas.project import ProjectState
from schemas.subtitle import default_subtitle_styles, resolve_effective_subtitle_style

SUPPORTED_ASSET_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".svg"}
ALL_QC_CATEGORIES: tuple[ProductionQCCategory, ...] = (
    "asset",
    "scene",
    "canvas",
    "animation",
    "camera",
    "audio",
    "subtitle",
    "production",
)


def _issue_id(*parts: str) -> str:
    raw = "|".join(str(p) for p in parts)
    return "qc_" + hashlib.sha1(raw.encode("utf-8")).hexdigest()[:12]


def run_production_qc(
    state: ProjectState,
    *,
    library_repo: LibraryRepository,
    asset_service: AssetService,
    sound_service: SoundService,
    scene_ids: list[str] | None = None,
    queue_doc: ProductionQueueDocument | None = None,
) -> ProductionQCReport:
    """Analyze actual project data across all 8 QC categories."""
    # Phase 09.2: per-run memoized lookups (no stale data across runs)
    library_repo = RunScopedLibrary(library_repo)  # type: ignore[assignment]
    asset_service = RunScopedFiles(asset_service)  # type: ignore[assignment]
    sound_service = RunScopedFiles(sound_service)  # type: ignore[assignment]
    issues: list[ProductionQCIssue] = []
    passed_checks = 0
    total_checks = 0

    def record_pass() -> None:
        nonlocal passed_checks, total_checks
        passed_checks += 1
        total_checks += 1

    def record_issue(issue: ProductionQCIssue) -> None:
        nonlocal total_checks
        total_checks += 1
        issues.append(issue)

    scope_set = set(scene_ids) if scene_ids else None
    target_scenes = [
        sc for sc in state.scenes if (scope_set is None or sc.scene_id in scope_set)
    ]
    stage_w = max(320, int(state.meta.width))
    stage_h = max(240, int(state.meta.height))
    timeline_dur = max(1, int(state.timeline.total_duration_ms))

    # Build lookup maps for orphan / relationship checks
    track_ids = {t.track_id for t in state.timeline.tracks}
    known_target_ids: set[str] = {"camera", *(sc.scene_id for sc in state.scenes)}
    for sc in state.scenes:
        for ch in sc.characters:
            known_target_ids.add(ch.instance_id)
        for pr in sc.props:
            known_target_ids.add(pr.prop_instance_id)

    # =========================================================================
    # 1. ASSET VALIDATION + 2. SCENE VALIDATION + 3. CANVAS VALIDATION
    # =========================================================================
    checked_assets: dict[str, tuple[bool, str]] = {}

    def check_asset(
        asset_id: str,
        context: str,
        scene_id: str | None,
        scene_num: int | None,
        shot_id: str | None = None,
        shot_num: int | None = None,
    ) -> None:
        if asset_id in checked_assets:
            ok, reason = checked_assets[asset_id]
            if ok:
                record_pass()
            else:
                record_issue(
                    ProductionQCIssue(
                        issue_id=_issue_id("asset", asset_id, scene_id or "", shot_id or ""),
                        code="MISSING_OR_BROKEN_ASSET",
                        category="asset",
                        severity="error",
                        title="Missing or broken asset reference",
                        description=f"{context}: {reason}",
                        scene_id=scene_id,
                        scene_number=scene_num,
                        shot_id=shot_id,
                        shot_number=shot_num,
                        asset_id=asset_id,
                        root_cause=reason,
                        recommended_action="Re-import or reassign a valid PNG/JPG/WEBP asset from the Asset Library.",
                        nav_target="assets",
                    )
                )
            return

        asset = library_repo.get_asset(asset_id)
        if not asset:
            reason = f"Asset ID '{asset_id}' not found in Asset Library."
            checked_assets[asset_id] = (False, reason)
            record_issue(
                ProductionQCIssue(
                    issue_id=_issue_id("asset_missing", asset_id, scene_id or ""),
                    code="MISSING_ASSET",
                    category="asset",
                    severity="error",
                    title="Missing library asset",
                    description=f"{context} references missing asset '{asset_id}'.",
                    scene_id=scene_id,
                    scene_number=scene_num,
                    shot_id=shot_id,
                    shot_number=shot_num,
                    asset_id=asset_id,
                    root_cause=reason,
                    recommended_action="Assign an existing asset or re-import the missing file.",
                    nav_target="assets",
                )
            )
            return

        try:
            fpath = asset_service.resolve_asset_file(asset)
            exists = fpath.is_file()
        except ValueError:
            fpath = Path(asset.file_path)
            exists = False

        if not exists:
            reason = f"Asset file missing on disk: {asset.file_path}"
            checked_assets[asset_id] = (False, reason)
            record_issue(
                ProductionQCIssue(
                    issue_id=_issue_id("asset_file", asset_id, scene_id or ""),
                    code="BROKEN_ASSET_PATH",
                    category="asset",
                    severity="error",
                    title=f"Broken asset path ({asset.name})",
                    description=f"{context} uses '{asset.name}' whose file does not exist at '{asset.file_path}'.",
                    scene_id=scene_id,
                    scene_number=scene_num,
                    shot_id=shot_id,
                    shot_number=shot_num,
                    asset_id=asset_id,
                    root_cause=reason,
                    recommended_action="Restore the file on disk or replace the asset in the library.",
                    nav_target="assets",
                )
            )
            return

        ext = fpath.suffix.lower()
        if ext and ext not in SUPPORTED_ASSET_EXTS:
            reason = f"Unsupported image format '{ext}' for '{asset.name}'."
            checked_assets[asset_id] = (False, reason)
            record_issue(
                ProductionQCIssue(
                    issue_id=_issue_id("asset_type", asset_id),
                    code="UNSUPPORTED_ASSET_TYPE",
                    category="asset",
                    severity="error",
                    title=f"Unsupported asset format ({ext})",
                    description=reason,
                    scene_id=scene_id,
                    scene_number=scene_num,
                    asset_id=asset_id,
                    root_cause=reason,
                    recommended_action="Convert the image to transparent PNG or JPG/WEBP and re-import.",
                    nav_target="assets",
                )
            )
            return

        checked_assets[asset_id] = (True, "")
        record_pass()

    if not target_scenes:
        record_issue(
            ProductionQCIssue(
                issue_id=_issue_id("scene_none", state.meta.project_id),
                code="NO_SCENES",
                category="scene",
                severity="error",
                title="Project has no scenes",
                description="No stage scenes exist in the selected scope.",
                root_cause="Scene list is empty.",
                recommended_action="Create a scene or execute an approved Production Plan.",
                nav_target="stage",
            )
        )

    for s_idx, sc in enumerate(target_scenes):
        s_num = sc.order_index + 1

        # Scene duration validation
        if sc.duration_ms <= 0:
            record_issue(
                ProductionQCIssue(
                    issue_id=_issue_id("scene_dur", sc.scene_id),
                    code="INVALID_SCENE_DURATION",
                    category="scene",
                    severity="error",
                    title=f"Invalid scene duration ({sc.name})",
                    description=f"Scene '{sc.name}' has non-positive duration ({sc.duration_ms}ms).",
                    scene_id=sc.scene_id,
                    scene_number=s_num,
                    time_ms=max(0, sc.start_ms),
                    root_cause="duration_ms <= 0",
                    recommended_action="Set scene duration to at least 500ms.",
                    nav_target="timeline",
                    fix_action="fix_scene_duration",
                )
            )
        else:
            record_pass()

        # Scene transition check (info recommendation between consecutive scenes)
        if s_idx > 0 and sc.transition_in == "cut":
            record_issue(
                ProductionQCIssue(
                    issue_id=_issue_id("scene_trans", sc.scene_id),
                    code="DEFAULT_CUT_TRANSITION",
                    category="scene",
                    severity="info",
                    title=f"Hard cut into {sc.name}",
                    description=f"Scene '{sc.name}' uses a hard cut transition; consider a fade/dissolve if pacing calls for it.",
                    scene_id=sc.scene_id,
                    scene_number=s_num,
                    time_ms=sc.start_ms,
                    root_cause="transition_in == 'cut'",
                    recommended_action="Optional: adjust transition in Scene Inspector.",
                    nav_target="stage",
                )
            )

        # Empty scene check
        if not sc.background_asset_id and not sc.characters and not sc.props and not sc.shots:
            record_issue(
                ProductionQCIssue(
                    issue_id=_issue_id("scene_empty", sc.scene_id),
                    code="EMPTY_SCENE",
                    category="scene",
                    severity="warning",
                    title=f"Empty scene ({sc.name})",
                    description=f"Scene '{sc.name}' contains no background, characters, props, or shots.",
                    scene_id=sc.scene_id,
                    scene_number=s_num,
                    time_ms=sc.start_ms,
                    root_cause="No visual layers or shots staged in this scene.",
                    recommended_action="Add a background/characters or assemble from Production Plan.",
                    nav_target="stage",
                )
            )
        else:
            record_pass()

        # Background asset check
        if sc.background_asset_id:
            check_asset(sc.background_asset_id, f"Background of '{sc.name}'", sc.scene_id, s_num)
        elif sc.characters or sc.props:
            record_issue(
                ProductionQCIssue(
                    issue_id=_issue_id("scene_no_bg", sc.scene_id),
                    code="MISSING_SCENE_BACKGROUND",
                    category="asset",
                    severity="warning",
                    title=f"Scene missing background ({sc.name})",
                    description=f"Scene '{sc.name}' has staged characters/props without a background image.",
                    scene_id=sc.scene_id,
                    scene_number=s_num,
                    time_ms=sc.start_ms,
                    root_cause="background_asset_id is null.",
                    recommended_action="Assign a background asset in the Scene Inspector.",
                    nav_target="assets",
                )
            )

        # Props validation (Asset + Canvas bounds/scale)
        for pr in sc.props:
            if pr.asset_id:
                check_asset(pr.asset_id, f"Prop '{pr.name}' in '{sc.name}'", sc.scene_id, s_num)
            px, py = pr.transform.x, pr.transform.y
            sx, sy = abs(pr.transform.scale_x), abs(pr.transform.scale_y)
            if px < -stage_w * 0.25 or px > stage_w * 1.25 or py < -stage_h * 0.25 or py > stage_h * 1.25:
                record_issue(
                    ProductionQCIssue(
                        issue_id=_issue_id("canvas_prop_oob", sc.scene_id, pr.prop_instance_id),
                        code="OBJECT_OUTSIDE_CANVAS",
                        category="canvas",
                        severity="warning",
                        title=f"Prop '{pr.name}' outside canvas",
                        description=f"Prop '{pr.name}' in '{sc.name}' is at ({px:.0f}, {py:.0f}), outside {stage_w}x{stage_h} canvas.",
                        scene_id=sc.scene_id,
                        scene_number=s_num,
                        asset_id=pr.asset_id,
                        time_ms=sc.start_ms,
                        root_cause="Prop position lies outside visible viewport bounds.",
                        recommended_action="Reposition the prop inside the canvas or reset its transform.",
                        nav_target="stage",
                    )
                )
            else:
                record_pass()
            if sx < 0.05 or sy < 0.05 or sx > 5.0 or sy > 5.0:
                record_issue(
                    ProductionQCIssue(
                        issue_id=_issue_id("canvas_prop_scale", sc.scene_id, pr.prop_instance_id),
                        code="EXTREME_OBJECT_SCALE",
                        category="canvas",
                        severity="warning",
                        title=f"Extreme scale on prop '{pr.name}'",
                        description=f"Prop '{pr.name}' has scale ({sx:.2f}, {sy:.2f}), which may cause severe cropping or invisibility.",
                        scene_id=sc.scene_id,
                        scene_number=s_num,
                        asset_id=pr.asset_id,
                        time_ms=sc.start_ms,
                        root_cause="Scale outside normal range [0.05, 5.0].",
                        recommended_action="Normalize prop scale in the Inspector.",
                        nav_target="stage",
                    )
                )

        # Characters validation (Asset + Rig parts + Canvas bounds/scale/overlap)
        visible_char_positions: list[tuple[str, str, float, float]] = []
        for ch in sc.characters:
            lib_char = library_repo.get_character(ch.character_id)
            if not lib_char:
                record_issue(
                    ProductionQCIssue(
                        issue_id=_issue_id("missing_char", sc.scene_id, ch.instance_id),
                        code="MISSING_CHARACTER",
                        category="asset",
                        severity="error",
                        title=f"Missing character ({ch.display_name})",
                        description=f"Character '{ch.display_name}' ({ch.character_id}) in '{sc.name}' no longer exists in Character Library.",
                        scene_id=sc.scene_id,
                        scene_number=s_num,
                        asset_id=ch.character_id,
                        time_ms=sc.start_ms,
                        root_cause="Library character ID not found.",
                        recommended_action="Remove the broken instance or reassign a valid library character.",
                        nav_target="characters",
                    )
                )
            else:
                record_pass()
                # Check character parts & missing components
                if not lib_char.parts:
                    record_issue(
                        ProductionQCIssue(
                            issue_id=_issue_id("char_no_parts", lib_char.character_id, sc.scene_id),
                            code="MISSING_CHARACTER_COMPONENTS",
                            category="asset",
                            severity="error",
                            title=f"Character '{lib_char.name}' has no visual parts",
                            description=f"Character '{lib_char.name}' in '{sc.name}' has zero rig/body parts attached.",
                            scene_id=sc.scene_id,
                            scene_number=s_num,
                            asset_id=lib_char.character_id,
                            root_cause="Character parts list is empty.",
                            recommended_action="Open Character Builder and assemble body/head PNG parts.",
                            nav_target="characters",
                        )
                    )
                else:
                    for part in lib_char.parts:
                        if part.default_asset_id:
                            check_asset(
                                part.default_asset_id,
                                f"Part '{part.name}' of character '{lib_char.name}'",
                                sc.scene_id,
                                s_num,
                            )

            # Canvas bounds & extreme scale checks
            cx, cy = ch.initial_transform.x, ch.initial_transform.y
            sx, sy = abs(ch.initial_transform.scale_x), abs(ch.initial_transform.scale_y)
            if cx < -120 or cx > stage_w + 120 or cy < -120 or cy > stage_h + 120:
                record_issue(
                    ProductionQCIssue(
                        issue_id=_issue_id("canvas_char_oob", sc.scene_id, ch.instance_id),
                        code="CHARACTER_OUTSIDE_CANVAS",
                        category="canvas",
                        severity="warning",
                        title=f"Character '{ch.display_name}' outside canvas",
                        description=f"Character '{ch.display_name}' in '{sc.name}' is placed at ({cx:.0f}, {cy:.0f}), outside the {stage_w}x{stage_h} canvas.",
                        scene_id=sc.scene_id,
                        scene_number=s_num,
                        asset_id=ch.character_id,
                        time_ms=sc.start_ms,
                        root_cause="Character transform (x, y) exceeds stage viewport boundaries.",
                        recommended_action="Center or reposition the character within the visible frame.",
                        nav_target="stage",
                        fix_action="recenter_character",
                    )
                )
            else:
                record_pass()

            if sx < 0.08 or sy < 0.08 or sx > 4.5 or sy > 4.5:
                record_issue(
                    ProductionQCIssue(
                        issue_id=_issue_id("canvas_char_scale", sc.scene_id, ch.instance_id),
                        code="EXTREME_CHARACTER_SCALE",
                        category="canvas",
                        severity="warning",
                        title=f"Extreme scale on '{ch.display_name}'",
                        description=f"Character '{ch.display_name}' scale ({sx:.2f}, {sy:.2f}) may cause unintended cropping or tiny silhouette.",
                        scene_id=sc.scene_id,
                        scene_number=s_num,
                        asset_id=ch.character_id,
                        time_ms=sc.start_ms,
                        root_cause="Character scale outside practical range [0.08, 4.5].",
                        recommended_action="Reset character scale to ~1.0 in the Inspector.",
                        nav_target="stage",
                        fix_action="reset_character_scale",
                    )
                )

            if ch.visible:
                visible_char_positions.append((ch.instance_id, ch.display_name, cx, cy))

        # Check overlapping characters at identical coordinates
        for i in range(len(visible_char_positions)):
            for j in range(i + 1, len(visible_char_positions)):
                id1, n1, x1, y1 = visible_char_positions[i]
                id2, n2, x2, y2 = visible_char_positions[j]
                if math.hypot(x2 - x1, y2 - y1) < 35.0:
                    record_issue(
                        ProductionQCIssue(
                            issue_id=_issue_id("canvas_overlap", sc.scene_id, id1, id2),
                            code="OVERLAPPING_CHARACTERS",
                            category="canvas",
                            severity="warning",
                            title=f"Overlapping characters in {sc.name}",
                            description=f"'{n1}' and '{n2}' are placed within 35px of each other ({x1:.0f},{y1:.0f}) and may obscure each other.",
                            scene_id=sc.scene_id,
                            scene_number=s_num,
                            time_ms=sc.start_ms,
                            root_cause="Two visible character instances share almost identical screen coordinates.",
                            recommended_action="Offset character horizontal positions for clearer staging.",
                            nav_target="stage",
                        )
                    )

        # Camera configuration validation (scene default camera)
        cam = sc.camera_default
        if not all(math.isfinite(v) for v in (cam.x, cam.y, cam.zoom, cam.rotation_deg)):
            record_issue(
                ProductionQCIssue(
                    issue_id=_issue_id("cam_nan", sc.scene_id),
                    code="INVALID_CAMERA_TRANSFORM",
                    category="camera",
                    severity="error",
                    title=f"Non-finite camera transform ({sc.name})",
                    description=f"Scene '{sc.name}' camera contains NaN/infinite values.",
                    scene_id=sc.scene_id,
                    scene_number=s_num,
                    time_ms=sc.start_ms,
                    root_cause="Camera x/y/zoom/rotation is non-finite.",
                    recommended_action="Reset scene camera to defaults.",
                    nav_target="stage",
                    fix_action="reset_scene_camera",
                )
            )
        elif cam.zoom <= 0.1 or cam.zoom > 5.0 or abs(cam.rotation_deg) > 45.0:
            record_issue(
                ProductionQCIssue(
                    issue_id=_issue_id("cam_limits", sc.scene_id),
                    code="CAMERA_OUTSIDE_LIMITS",
                    category="camera",
                    severity="warning",
                    title=f"Camera outside recommended limits ({sc.name})",
                    description=f"Scene '{sc.name}' camera zoom={cam.zoom:.2f}, rotation={cam.rotation_deg:.1f}° exceeds safe framing limits (zoom 0.1–5.0, rot ±45°).",
                    scene_id=sc.scene_id,
                    scene_number=s_num,
                    time_ms=sc.start_ms,
                    root_cause="Camera zoom or rotation outside supported motion-comic envelope.",
                    recommended_action="Adjust camera zoom/rotation in Camera Inspector.",
                    nav_target="stage",
                    fix_action="reset_scene_camera",
                )
            )
        else:
            record_pass()

        # Shot-level Scene, Asset, Canvas, Animation & Camera checks
        for sh in sc.shots:
            sh_time = sc.start_ms + sh.start_ms
            if sh.duration_ms <= 0:
                record_issue(
                    ProductionQCIssue(
                        issue_id=_issue_id("shot_dur", sc.scene_id, sh.shot_id),
                        code="INVALID_SHOT_DURATION",
                        category="scene",
                        severity="error",
                        title=f"Invalid shot duration (Shot #{sh.shot_order})",
                        description=f"Shot #{sh.shot_order} ('{sh.title}') in '{sc.name}' has invalid duration {sh.duration_ms}ms.",
                        scene_id=sc.scene_id,
                        scene_number=s_num,
                        shot_id=sh.shot_id,
                        shot_number=sh.shot_order,
                        time_ms=sh_time,
                        root_cause="Shot duration_ms <= 0.",
                        recommended_action="Set shot duration to at least 300ms.",
                        nav_target="timeline",
                        fix_action="fix_shot_duration",
                    )
                )
            elif sh.start_ms + sh.duration_ms > sc.duration_ms + 500:
                record_issue(
                    ProductionQCIssue(
                        issue_id=_issue_id("shot_overflow", sc.scene_id, sh.shot_id),
                        code="SHOT_EXCEEDS_SCENE_DURATION",
                        category="scene",
                        severity="warning",
                        title=f"Shot #{sh.shot_order} overflows scene duration",
                        description=f"Shot #{sh.shot_order} ends at {sh.start_ms + sh.duration_ms}ms, beyond scene duration {sc.duration_ms}ms.",
                        scene_id=sc.scene_id,
                        scene_number=s_num,
                        shot_id=sh.shot_id,
                        shot_number=sh.shot_order,
                        time_ms=sh_time,
                        root_cause="Shot timing exceeds parent scene boundary.",
                        recommended_action="Extend scene duration or trim shot length.",
                        nav_target="timeline",
                    )
                )
            else:
                record_pass()

            # Empty shot check (verify background actually resolves to a valid asset)
            effective_bg_id = sh.background_asset_id or sc.background_asset_id
            has_bg = bool(effective_bg_id and checked_assets.get(effective_bg_id, (False, ""))[0])
            has_chars = any(cs.visible for cs in sh.character_states)
            has_props = any(ps.visible for ps in sh.prop_states)
            if not has_bg and not has_chars and not has_props:
                record_issue(
                    ProductionQCIssue(
                        issue_id=_issue_id("shot_empty", sc.scene_id, sh.shot_id),
                        code="EMPTY_SHOT",
                        category="scene",
                        severity="error",
                        title=f"Empty shot (Shot #{sh.shot_order})",
                        description=f"Shot #{sh.shot_order} ('{sh.title}') in '{sc.name}' has no background, visible characters, or props.",
                        scene_id=sc.scene_id,
                        scene_number=s_num,
                        shot_id=sh.shot_id,
                        shot_number=sh.shot_order,
                        time_ms=sh_time,
                        root_cause="Shot contains zero visual elements.",
                        recommended_action="Assign a background or stage characters in this shot.",
                        nav_target="stage",
                    )
                )
            else:
                record_pass()

            if sh.background_asset_id:
                check_asset(
                    sh.background_asset_id,
                    f"Background of Shot #{sh.shot_order} ('{sh.title}')",
                    sc.scene_id,
                    s_num,
                    sh.shot_id,
                    sh.shot_order,
                )
            elif not sc.background_asset_id:
                record_issue(
                    ProductionQCIssue(
                        issue_id=_issue_id("shot_no_bg", sc.scene_id, sh.shot_id),
                        code="SHOT_MISSING_BACKGROUND",
                        category="scene",
                        severity="warning",
                        title=f"Shot #{sh.shot_order} missing background",
                        description=f"Shot #{sh.shot_order} ('{sh.title}') has no shot or scene background.",
                        scene_id=sc.scene_id,
                        scene_number=s_num,
                        shot_id=sh.shot_id,
                        shot_number=sh.shot_order,
                        time_ms=sh_time,
                        root_cause="Both shot.background_asset_id and scene.background_asset_id are null.",
                        recommended_action="Assign a background in Production Plan or Scene Inspector.",
                        nav_target="production",
                    )
                )

            # Shot character bounds & rig motion check
            for cs in sh.character_states:
                if cs.visible:
                    if cs.transform.x < -120 or cs.transform.x > stage_w + 120 or cs.transform.y < -120 or cs.transform.y > stage_h + 120:
                        record_issue(
                            ProductionQCIssue(
                                issue_id=_issue_id("shot_char_oob", sc.scene_id, sh.shot_id, cs.instance_id),
                                code="CHARACTER_OUTSIDE_CANVAS",
                                category="canvas",
                                severity="warning",
                                title=f"Character outside canvas in Shot #{sh.shot_order}",
                                description=f"Character '{cs.display_name}' in Shot #{sh.shot_order} is at ({cs.transform.x:.0f}, {cs.transform.y:.0f}).",
                                scene_id=sc.scene_id,
                                scene_number=s_num,
                                shot_id=sh.shot_id,
                                shot_number=sh.shot_order,
                                asset_id=cs.character_id,
                                time_ms=sh_time,
                                root_cause="Shot-specific character transform lies outside visible frame.",
                                recommended_action="Reposition character for this shot.",
                                nav_target="stage",
                            )
                        )

            # Shot camera validation
            scam = sh.camera_default
            if not all(math.isfinite(v) for v in (scam.x, scam.y, scam.zoom, scam.rotation_deg)) or scam.zoom <= 0.1 or scam.zoom > 5.0:
                record_issue(
                    ProductionQCIssue(
                        issue_id=_issue_id("shot_cam_invalid", sc.scene_id, sh.shot_id),
                        code="INVALID_SHOT_CAMERA",
                        category="camera",
                        severity="error",
                        title=f"Invalid camera transform in Shot #{sh.shot_order}",
                        description=f"Shot #{sh.shot_order} camera zoom ({scam.zoom}) or coordinates are invalid.",
                        scene_id=sc.scene_id,
                        scene_number=s_num,
                        shot_id=sh.shot_id,
                        shot_number=sh.shot_order,
                        time_ms=sh_time,
                        root_cause="Shot camera transform violates finite/zoom bounds.",
                        recommended_action="Reset shot camera framing.",
                        nav_target="stage",
                    )
                )

            # Unsupported generated motion records on shot
            for mot in sh.applied_motions:
                if mot.support_level == "unsupported":
                    record_issue(
                        ProductionQCIssue(
                            issue_id=_issue_id("anim_unsup_rec", sc.scene_id, sh.shot_id, mot.motion_id),
                            code="UNSUPPORTED_CHARACTER_MOTION",
                            category="animation" if mot.target_kind == "character" else "camera",
                            severity="warning",
                            title=f"Unsupported motion '{mot.preset_name}' in Shot #{sh.shot_order}",
                            description=f"Motion '{mot.preset_name}' ({mot.category}) cannot be executed on the assigned rig/shot.",
                            scene_id=sc.scene_id,
                            scene_number=s_num,
                            shot_id=sh.shot_id,
                            shot_number=sh.shot_order,
                            time_ms=sh_time,
                            root_cause=", ".join(mot.warnings) or "Character rig lacks required parts for this motion.",
                            recommended_action="Replace with a compatible Motion Preset or add missing rig parts in Character Builder.",
                            nav_target="characters",
                        )
                    )

    # =========================================================================
    # 4. ANIMATION VALIDATION (Keyframes + Rig Compatibility in Production Plan)
    # =========================================================================
    seen_kf_slots: set[tuple[str, str, int]] = set()
    for kf in state.timeline.keyframes:
        if kf.time_ms < 0:
            record_issue(
                ProductionQCIssue(
                    issue_id=_issue_id("kf_neg", kf.keyframe_id),
                    code="INVALID_KEYFRAME_TIME",
                    category="animation",
                    severity="error",
                    title="Negative keyframe timestamp",
                    description=f"Keyframe '{kf.keyframe_id}' ({kf.property}) has negative time ({kf.time_ms}ms).",
                    time_ms=0,
                    root_cause="time_ms < 0",
                    recommended_action="Clamp or delete the invalid keyframe on the Timeline.",
                    nav_target="timeline",
                    fix_action="clamp_negative_keyframes",
                )
            )
            continue
        if isinstance(kf.value, (int, float)) and not math.isfinite(float(kf.value)):
            record_issue(
                ProductionQCIssue(
                    issue_id=_issue_id("kf_nan", kf.keyframe_id),
                    code="INVALID_KEYFRAME_VALUE",
                    category="animation",
                    severity="error",
                    title="Non-finite keyframe value",
                    description=f"Keyframe '{kf.keyframe_id}' ({kf.property}) has NaN/infinite value.",
                    time_ms=kf.time_ms,
                    root_cause="Non-finite numeric value in keyframe.",
                    recommended_action="Remove or re-key this property on the Timeline.",
                    nav_target="timeline",
                )
            )
            continue
        if kf.track_id not in track_ids:
            record_issue(
                ProductionQCIssue(
                    issue_id=_issue_id("kf_orphan_trk", kf.keyframe_id),
                    code="ORPHAN_KEYFRAME_TRACK",
                    category="animation",
                    severity="error",
                    title="Keyframe references missing track",
                    description=f"Keyframe '{kf.keyframe_id}' points to unknown track '{kf.track_id}'.",
                    time_ms=kf.time_ms,
                    root_cause="Track was removed without cleaning up keyframes.",
                    recommended_action="Remove orphaned keyframes.",
                    nav_target="timeline",
                    fix_action="clean_orphan_keyframes",
                )
            )
            continue
        if kf.target_type != "camera" and kf.target_id not in known_target_ids:
            record_issue(
                ProductionQCIssue(
                    issue_id=_issue_id("kf_orphan_tgt", kf.keyframe_id),
                    code="ORPHAN_KEYFRAME_TARGET",
                    category="animation",
                    severity="warning",
                    title="Keyframe references missing object",
                    description=f"Keyframe '{kf.keyframe_id}' ({kf.property}) targets '{kf.target_id}' which is not present in any scene.",
                    time_ms=kf.time_ms,
                    root_cause="Character/prop instance no longer exists.",
                    recommended_action="Clean up orphaned keyframes on the Timeline.",
                    nav_target="timeline",
                    fix_action="clean_orphan_keyframes",
                )
            )
            continue
        slot = (kf.target_id, kf.property, kf.time_ms)
        if slot in seen_kf_slots:
            record_issue(
                ProductionQCIssue(
                    issue_id=_issue_id("kf_dup", kf.keyframe_id),
                    code="DUPLICATE_KEYFRAME_SLOT",
                    category="animation",
                    severity="warning",
                    title="Duplicate keyframe at identical timestamp",
                    description=f"Multiple keyframes for '{kf.target_id}.{kf.property}' exist at {kf.time_ms}ms.",
                    time_ms=kf.time_ms,
                    root_cause="Two keyframes occupy the exact same target, property, and timestamp.",
                    recommended_action="Deduplicate keyframes on the Timeline.",
                    nav_target="timeline",
                )
            )
        else:
            seen_kf_slots.add(slot)
            record_pass()

        # Check camera keyframe bounds
        if kf.target_type == "camera" and isinstance(kf.value, (int, float)):
            val = float(kf.value)
            if kf.property == "zoom" and (val <= 0.1 or val > 5.0):
                record_issue(
                    ProductionQCIssue(
                        issue_id=_issue_id("cam_kf_zoom", kf.keyframe_id),
                        code="CAMERA_KEYFRAME_OUT_OF_RANGE",
                        category="camera",
                        severity="warning",
                        title="Camera zoom keyframe out of limits",
                        description=f"Camera zoom keyframe at {kf.time_ms}ms has zoom={val:.2f} (recommended 0.1–5.0).",
                        time_ms=kf.time_ms,
                        root_cause="Camera zoom keyframe exceeds supported limits.",
                        recommended_action="Adjust camera zoom keyframe on Timeline.",
                        nav_target="timeline",
                    )
                )

    # Check Production Plan planned actions & cameras against real Rig & Camera capabilities
    if state.production_plan and state.production_plan.shots:
        all_presets = library_repo.list_motion_presets()
        presets_by_id = {p.preset_id: p for p in all_presets}
        for pshot in state.production_plan.shots:
            if scope_set is not None and pshot.scene_id not in scope_set:
                continue
            if pshot.approval_status == "rejected":
                continue

            # Camera movement compatibility check
            cam_support, _, cam_reason = evaluate_camera_execution_support(
                pshot.camera_plan.camera_movement
            )
            if cam_support == "unsupported":
                record_issue(
                    ProductionQCIssue(
                        issue_id=_issue_id("cam_plan_unsup", pshot.production_shot_id),
                        code="UNSUPPORTED_CAMERA_MOTION",
                        category="camera",
                        severity="warning",
                        title=f"Unsupported camera movement ({pshot.camera_plan.camera_movement})",
                        description=f"Planned Shot #{pshot.shot_order} ('{pshot.title}') requests '{pshot.camera_plan.camera_movement}': {cam_reason}",
                        scene_id=pshot.scene_id,
                        shot_id=pshot.shot_id,
                        shot_number=pshot.shot_order,
                        root_cause=cam_reason,
                        recommended_action="Switch to a supported 2D camera motion (pan, zoom, dolly, shake, follow).",
                        nav_target="production",
                    )
                )
            else:
                record_pass()

            # Character animation compatibility check against real assigned rig
            for act in pshot.animation_plans:
                if act.library_character_id:
                    lib_char = library_repo.get_character(act.library_character_id)
                    if lib_char:
                        caps = inspect_character_capabilities(lib_char)
                        preset, unsup_reason, _ = resolve_action_to_preset(
                            act.category,
                            presets_by_id,
                            all_presets,
                            preferred_preset_id=act.mapped_preset_id,
                            character=lib_char,
                        )
                        if preset is None:
                            record_issue(
                                ProductionQCIssue(
                                    issue_id=_issue_id("anim_rig_incompat", pshot.production_shot_id, act.action_plan_id),
                                    code="ANIMATION_RIG_INCOMPATIBLE",
                                    category="animation",
                                    severity="warning",
                                    title=f"Animation '{act.category}' incompatible with '{lib_char.name}'",
                                    description=unsup_reason or f"No supported preset for '{act.category}' on '{lib_char.name}'.",
                                    scene_id=pshot.scene_id,
                                    shot_id=pshot.shot_id,
                                    shot_number=pshot.shot_order,
                                    asset_id=lib_char.character_id,
                                    root_cause=unsup_reason or "Unsupported animation category.",
                                    recommended_action="Replace with a supported Motion Preset in Production Planner.",
                                    nav_target="characters",
                                )
                            )
                        else:
                            compat = check_preset_compatibility(preset, caps)
                            if not compat.compatible or compat.support_level == "unsupported":
                                record_issue(
                                    ProductionQCIssue(
                                        issue_id=_issue_id("anim_rig_incompat", pshot.production_shot_id, act.action_plan_id),
                                        code="ANIMATION_RIG_INCOMPATIBLE",
                                        category="animation",
                                        severity="warning",
                                        title=f"Animation '{act.category}' incompatible with '{lib_char.name}'",
                                        description=(
                                            f"Shot #{pshot.shot_order} plans '{act.category}' for '{lib_char.name}', "
                                            f"but rig is missing: {', '.join(compat.missing_capabilities) or 'required parts'}."
                                        ),
                                        scene_id=pshot.scene_id,
                                        shot_id=pshot.shot_id,
                                        shot_number=pshot.shot_order,
                                        asset_id=lib_char.character_id,
                                        root_cause="Assigned character rig does not have the required movable parts.",
                                        recommended_action="Add the required body parts in Character Builder or switch to a supported preset (e.g. idle/react).",
                                        nav_target="characters",
                                    )
                                )
                            else:
                                record_pass()

    # =========================================================================
    # 6. AUDIO VALIDATION
    # =========================================================================
    voice_track_ids = {t.track_id for t in state.timeline.tracks if t.track_type == "voice"}
    voice_intervals: list[tuple[str, int, int, str]] = []

    for ev in state.timeline.sound_events:
        if ev.start_ms < 0:
            record_issue(
                ProductionQCIssue(
                    issue_id=_issue_id("audio_neg", ev.event_id),
                    code="INVALID_AUDIO_TIMING",
                    category="audio",
                    severity="error",
                    title="Negative audio clip start time",
                    description=f"Audio clip '{ev.event_id}' starts at {ev.start_ms}ms.",
                    sound_event_id=ev.event_id,
                    time_ms=0,
                    root_cause="start_ms < 0",
                    recommended_action="Move audio clip to >= 0ms on the Timeline.",
                    nav_target="timeline",
                )
            )
            continue

        sound = library_repo.get_sound(ev.sound_id)
        if not sound:
            record_issue(
                ProductionQCIssue(
                    issue_id=_issue_id("audio_missing", ev.event_id),
                    code="BROKEN_AUDIO_REFERENCE",
                    category="audio",
                    severity="error",
                    title="Missing audio asset on timeline",
                    description=f"Timeline audio event '{ev.event_id}' references missing sound '{ev.sound_id}'.",
                    sound_event_id=ev.event_id,
                    asset_id=ev.sound_id,
                    time_ms=ev.start_ms,
                    root_cause="Sound asset no longer exists in library.db.",
                    recommended_action="Remove the broken audio clip or replace it from Audio Library.",
                    nav_target="audio",
                    fix_action="remove_broken_audio",
                )
            )
            continue

        try:
            spath = sound_service.resolve_sound_file(sound)
            exists = spath.is_file()
        except ValueError:
            exists = False

        if not exists:
            record_issue(
                ProductionQCIssue(
                    issue_id=_issue_id("audio_file_missing", ev.event_id),
                    code="MISSING_AUDIO_FILE",
                    category="audio",
                    severity="error",
                    title=f"Missing audio file ({sound.name})",
                    description=f"Sound '{sound.name}' file is missing on disk ({sound.file_path}).",
                    sound_event_id=ev.event_id,
                    asset_id=sound.sound_id,
                    time_ms=ev.start_ms,
                    root_cause="Audio file does not exist on disk.",
                    recommended_action="Re-import the audio file or remove the clip.",
                    nav_target="audio",
                    fix_action="remove_broken_audio",
                )
            )
            continue

        record_pass()
        clip_dur = ev.end_ms - ev.start_ms
        if clip_dur <= 0:
            record_issue(
                ProductionQCIssue(
                    issue_id=_issue_id("audio_zero_dur", ev.event_id),
                    code="INVALID_AUDIO_DURATION",
                    category="audio",
                    severity="error",
                    title=f"Zero-duration audio clip ({sound.name})",
                    description=f"Audio clip '{sound.name}' has non-positive duration ({clip_dur}ms).",
                    sound_event_id=ev.event_id,
                    asset_id=sound.sound_id,
                    time_ms=ev.start_ms,
                    root_cause="end_ms <= start_ms",
                    recommended_action="Check or re-import the audio file.",
                    nav_target="timeline",
                )
            )
        else:
            clip_end = ev.end_ms
            if clip_end > timeline_dur + 250:
                record_issue(
                    ProductionQCIssue(
                        issue_id=_issue_id("audio_overflow", ev.event_id),
                        code="AUDIO_EXTENDS_BEYOND_DURATION",
                        category="audio",
                        severity="warning",
                        title=f"Audio clip exceeds timeline ({sound.name})",
                        description=f"Audio clip '{sound.name}' ends at {clip_end}ms, beyond timeline duration ({timeline_dur}ms).",
                        sound_event_id=ev.event_id,
                        asset_id=sound.sound_id,
                        time_ms=ev.start_ms,
                        root_cause="Audio clip extends past project duration.",
                        recommended_action="Trim the audio clip or extend the scene/timeline duration.",
                        nav_target="timeline",
                    )
                )
            if ev.track_id in voice_track_ids:
                voice_intervals.append((ev.event_id, ev.start_ms, clip_end, sound.name))

    # Detect overlapping dialogue voice clips on Voice track
    voice_intervals.sort(key=lambda x: x[1])
    for i in range(len(voice_intervals) - 1):
        id1, _, end1, n1 = voice_intervals[i]
        id2, start2, _, n2 = voice_intervals[i + 1]
        if start2 < end1 - 50:
            record_issue(
                ProductionQCIssue(
                    issue_id=_issue_id("audio_voice_overlap", id1, id2),
                    code="OVERLAPPING_VOICE_AUDIO",
                    category="audio",
                    severity="warning",
                    title="Overlapping voice audio clips",
                    description=f"Voice clip '{n1}' overlaps '{n2}' at {start2}ms.",
                    sound_event_id=id2,
                    time_ms=start2,
                    root_cause="Two dialogue voice clips play simultaneously on the Voice track.",
                    recommended_action="Stagger the voice clips on the Timeline so dialogue lines don't collide.",
                    nav_target="timeline",
                )
            )

    # Check script dialogue lines missing generated voice audio
    if state.script and state.script.scenes:
        missing_voice_entries = 0
        for ssc in state.script.scenes:
            for entry in ssc.entries:
                if entry.entry_type == "dialogue" and entry.text.strip() and not entry.audio_asset_id:
                    missing_voice_entries += 1
        if missing_voice_entries > 0:
            record_issue(
                ProductionQCIssue(
                    issue_id=_issue_id("script_missing_voice", state.meta.project_id),
                    code="MISSING_DIALOGUE_VOICE",
                    category="audio",
                    severity="info",
                    title=f"{missing_voice_entries} dialogue line(s) without voice audio",
                    description=f"Script contains {missing_voice_entries} dialogue line(s) with no generated voice audio attached yet.",
                    root_cause="Voice synthesis has not been run for these dialogue entries.",
                    recommended_action="Open Script Editor or Voice Studio (F5-TTS / Local OS) to generate dialogue voices.",
                    nav_target="audio",
                )
            )

    # =========================================================================
    # 7. SUBTITLE VALIDATION
    # =========================================================================
    sub_doc = state.subtitles
    # Phase 09.1: subtitle cues generated from script dialogue keep `script_entry_id`; detect cues
    # that no longer match the (edited) script line or whose line was deleted.
    script_entries = {
        e.entry_id: " ".join(e.text.split()).casefold()
        for sc in (state.script.scenes if state.script else [])
        for e in sc.entries
    }
    if sub_doc and sub_doc.segments:
        styles = sub_doc.styles or default_subtitle_styles()
        style_ids = {s.style_id for s in styles}
        for seg in sub_doc.segments:
            if not seg.enabled:
                continue
            if scope_set is not None and seg.scene_id and seg.scene_id not in scope_set:
                continue
            if seg.script_entry_id and seg.text.strip():
                src = script_entries.get(seg.script_entry_id)
                cue = " ".join(seg.text.split()).casefold()
                if src is None or cue not in src:
                    record_issue(
                        ProductionQCIssue(
                            issue_id=_issue_id("sub_outdated", seg.subtitle_id),
                            code="OUTDATED_SUBTITLE",
                            category="subtitle",
                            severity="warning",
                            title="Subtitle no longer matches the script",
                            description=(
                                f"Subtitle '{seg.text[:60]}' was generated from a script line that was "
                                + ("deleted." if src is None else "edited afterwards.")
                            ),
                            scene_id=seg.scene_id,
                            subtitle_id=seg.subtitle_id,
                            time_ms=seg.start_ms,
                            root_cause="The script changed after subtitles (and possibly voice) were generated.",
                            recommended_action="Regenerate the subtitle (and voice line) from the script, or edit the cue to match.",
                            nav_target="subtitles",
                        )
                    )
                else:
                    record_pass()

            if not seg.text.strip():
                record_issue(
                    ProductionQCIssue(
                        issue_id=_issue_id("sub_empty", seg.subtitle_id),
                        code="MISSING_SUBTITLE_TEXT",
                        category="subtitle",
                        severity="error",
                        title="Empty subtitle segment",
                        description=f"Subtitle '{seg.subtitle_id}' at {seg.start_ms}ms has empty text.",
                        scene_id=seg.scene_id,
                        subtitle_id=seg.subtitle_id,
                        time_ms=seg.start_ms,
                        root_cause="Subtitle text is blank.",
                        recommended_action="Enter subtitle text in the Timeline Subtitle Inspector or delete the empty cue.",
                        nav_target="subtitles",
                    )
                )
            else:
                record_pass()

            if seg.end_ms <= seg.start_ms or seg.start_ms < 0:
                record_issue(
                    ProductionQCIssue(
                        issue_id=_issue_id("sub_timing", seg.subtitle_id),
                        code="INVALID_SUBTITLE_TIMING",
                        category="subtitle",
                        severity="error",
                        title="Invalid subtitle timing",
                        description=f"Subtitle '{seg.text[:28]}' has invalid range ({seg.start_ms}ms -> {seg.end_ms}ms).",
                        scene_id=seg.scene_id,
                        subtitle_id=seg.subtitle_id,
                        time_ms=max(0, seg.start_ms),
                        root_cause="end_ms <= start_ms or negative start_ms.",
                        recommended_action="Fix subtitle start/end times in Timeline Inspector.",
                        nav_target="timeline",
                        fix_action="fix_subtitle_timing",
                    )
                )
            elif seg.end_ms > timeline_dur + 250:
                record_issue(
                    ProductionQCIssue(
                        issue_id=_issue_id("sub_overflow", seg.subtitle_id),
                        code="SUBTITLE_EXCEEDS_DURATION",
                        category="subtitle",
                        severity="warning",
                        title="Subtitle exceeds timeline duration",
                        description=f"Subtitle '{seg.text[:28]}' ends at {seg.end_ms}ms, beyond timeline ({timeline_dur}ms).",
                        scene_id=seg.scene_id,
                        subtitle_id=seg.subtitle_id,
                        time_ms=seg.start_ms,
                        root_cause="Subtitle extends past video end.",
                        recommended_action="Trim subtitle end time or extend scene duration.",
                        nav_target="timeline",
                        fix_action="fix_subtitle_timing",
                    )
                )
            else:
                record_pass()

            if seg.style_id not in style_ids:
                record_issue(
                    ProductionQCIssue(
                        issue_id=_issue_id("sub_style_missing", seg.subtitle_id),
                        code="INVALID_SUBTITLE_STYLE_REF",
                        category="subtitle",
                        severity="warning",
                        title="Missing subtitle style preset",
                        description=f"Subtitle '{seg.text[:24]}' references unknown style '{seg.style_id}'.",
                        scene_id=seg.scene_id,
                        subtitle_id=seg.subtitle_id,
                        time_ms=seg.start_ms,
                        root_cause="Referenced style_id does not exist in SubtitleDocument.styles.",
                        recommended_action="Select a valid subtitle style in the Inspector.",
                        nav_target="subtitles",
                    )
                )

            eff = resolve_effective_subtitle_style(styles, seg, sub_doc.default_style_id)
            if not (eff.font_family or "").strip():
                record_issue(
                    ProductionQCIssue(
                        issue_id=_issue_id("sub_font", seg.subtitle_id),
                        code="INVALID_FONT_REFERENCE",
                        category="subtitle",
                        severity="error",
                        title="Missing font family on subtitle",
                        description=f"Subtitle '{seg.text[:24]}' resolves to an empty font family.",
                        scene_id=seg.scene_id,
                        subtitle_id=seg.subtitle_id,
                        time_ms=seg.start_ms,
                        root_cause="font_family is blank.",
                        recommended_action="Choose a valid font family in the Subtitle Inspector.",
                        nav_target="timeline",
                    )
                )
            if not eff.safe_area_clamp and (
                abs(eff.offset_x) > stage_w * 0.45
                or abs(eff.offset_y) > stage_h * 0.45
                or eff.margin_y < 16
            ):
                record_issue(
                    ProductionQCIssue(
                        issue_id=_issue_id("sub_safe_area", seg.subtitle_id),
                        code="SUBTITLE_OUTSIDE_SAFE_AREA",
                        category="subtitle",
                        severity="warning",
                        title="Subtitle outside safe display area",
                        description=f"Subtitle '{seg.text[:24]}' has Safe-Area Clamp disabled with offset ({eff.offset_x:.0f}, {eff.offset_y:.0f}) / margin_y={eff.margin_y}.",
                        scene_id=seg.scene_id,
                        subtitle_id=seg.subtitle_id,
                        time_ms=seg.start_ms,
                        root_cause="Subtitle may clip near screen edges.",
                        recommended_action="Enable Safe-Area Clamp or reduce X/Y offset in Timeline Subtitle Inspector.",
                        nav_target="timeline",
                        fix_action="enable_subtitle_safe_area",
                    )
                )

    # =========================================================================
    # 8. PRODUCTION VALIDATION (Plan Completeness + Queue Tasks)
    # =========================================================================
    if state.production_plan and state.production_plan.shots:
        planned = [
            ps
            for ps in state.production_plan.shots
            if (scope_set is None or ps.scene_id in scope_set) and ps.approval_status != "rejected"
        ]
        unapplied_count = 0
        for ps in planned:
            if not ps.timeline_refs.applied:
                unapplied_count += 1
            req_items = ([ps.background] if ps.background else []) + list(ps.assets)
            missing_reqs = [r for r in req_items if r.required and not r.matched_asset_id]
            if missing_reqs:
                record_issue(
                    ProductionQCIssue(
                        issue_id=_issue_id("prod_missing_deps", ps.production_shot_id),
                        code="MISSING_PRODUCTION_DEPENDENCIES",
                        category="production",
                        severity="warning",
                        title=f"Unresolved asset dependencies in Shot #{ps.shot_order}",
                        description=(
                            f"Production Shot #{ps.shot_order} ('{ps.title}') has {len(missing_reqs)} unmatched required asset(s): "
                            + ", ".join(r.label for r in missing_reqs[:3])
                        ),
                        scene_id=ps.scene_id,
                        shot_id=ps.shot_id,
                        shot_number=ps.shot_order,
                        root_cause="Required background/character/prop in Production Plan is not matched to a library asset.",
                        recommended_action="Assign matching assets in Production Planner before running full production.",
                        nav_target="production",
                    )
                )
            else:
                record_pass()

        if unapplied_count > 0:
            record_issue(
                ProductionQCIssue(
                    issue_id=_issue_id("prod_unexecuted", state.meta.project_id, str(unapplied_count)),
                    code="UNEXECUTED_PLANNED_SHOTS",
                    category="production",
                    severity="info",
                    title=f"{unapplied_count} planned shot(s) not yet executed",
                    description=f"{unapplied_count} of {len(planned)} Production Plan shot(s) have not been assembled into stage scenes yet.",
                    root_cause="Production Queue or Scene Execution has not executed all planned shots.",
                    recommended_action="Run the Production Queue to assemble and animate planned shots.",
                    nav_target="queue",
                )
            )

    active_queue = queue_doc or state.production_queue
    if active_queue and active_queue.tasks:
        for task in active_queue.tasks:
            if scope_set is not None and task.scene_id and task.scene_id not in scope_set and task.stage_scene_id not in scope_set:
                continue
            if task.status == "failed":
                record_issue(
                    ProductionQCIssue(
                        issue_id=_issue_id("prod_task_failed", task.task_id),
                        code="FAILED_PRODUCTION_TASK",
                        category="production",
                        severity="error",
                        title=f"Failed production task: {task.task_name}",
                        description=task.error_details or task.message or f"Task '{task.task_name}' failed.",
                        scene_id=task.stage_scene_id or task.scene_id,
                        scene_number=task.scene_number,
                        shot_id=task.shot_id,
                        shot_number=task.shot_number or None,
                        task_id=task.task_id,
                        time_ms=task.timeline_time_ms,
                        root_cause=task.error_details or "Execution error during production queue run.",
                        recommended_action="Inspect the error in Production Queue, fix the underlying issue, and Retry.",
                        nav_target="queue",
                    )
                )
            elif task.status == "needs_review":
                record_issue(
                    ProductionQCIssue(
                        issue_id=_issue_id("prod_task_review", task.task_id),
                        code="TASK_NEEDS_REVIEW",
                        category="production",
                        severity="warning",
                        title=f"Production task needs review: {task.task_name}",
                        description=task.message or f"Task '{task.task_name}' completed with warnings or blocked dependencies.",
                        scene_id=task.stage_scene_id or task.scene_id,
                        scene_number=task.scene_number,
                        shot_id=task.shot_id,
                        shot_number=task.shot_number or None,
                        task_id=task.task_id,
                        time_ms=task.timeline_time_ms,
                        root_cause="; ".join(task.warnings) or "Blocked dependency or partial fallback.",
                        recommended_action="Review the shot on Stage/Timeline or Retry after resolving upstream tasks.",
                        nav_target="queue",
                    )
                )
            elif task.status == "completed":
                record_pass()

    # Build summary statistics
    error_count = sum(1 for i in issues if i.severity == "error")
    warning_count = sum(1 for i in issues if i.severity == "warning")
    info_count = sum(1 for i in issues if i.severity == "info")

    cat_summary: dict[str, dict[str, int]] = {
        cat: {"error": 0, "warning": 0, "info": 0} for cat in ALL_QC_CATEGORIES
    }
    for iss in issues:
        cat_summary[iss.category][iss.severity] += 1

    # Readiness score: errors weigh heavily, warnings lightly, info never penalizes readiness
    penalty = error_count * 18 + warning_count * 4
    readiness_score = max(0, min(100, 100 - penalty))

    return ProductionQCReport(
        project_id=state.meta.project_id,
        scope="scenes" if scope_set else "project",
        scene_ids=list(scene_ids or []),
        error_count=error_count,
        warning_count=warning_count,
        info_count=info_count,
        passed_checks=passed_checks,
        total_checks=total_checks,
        readiness_score=readiness_score,
        production_ready=error_count == 0,
        category_summary=cat_summary,
        issues=issues,
        checked_at=utc_now_iso(),
    )


def apply_qc_fix(state: ProjectState, req: ProductionQCFixRequest) -> tuple[ProjectState, str]:
    """Apply a safe, deterministic inline fix for a fixable QC issue without corrupting unrelated state."""
    action = req.fix_action
    updated = state.model_copy(deep=True)
    stage_w = max(320, int(updated.meta.width))
    stage_h = max(240, int(updated.meta.height))
    tl_dur = max(1000, int(updated.timeline.total_duration_ms))

    if action == "fix_scene_duration" and req.scene_id:
        for sc in updated.scenes:
            if sc.scene_id == req.scene_id and sc.duration_ms <= 0:
                sc.duration_ms = 5000
                return updated, f"Reset scene '{sc.name}' duration to 5000ms."

    if action == "fix_shot_duration" and req.scene_id and req.shot_id:
        for sc in updated.scenes:
            if sc.scene_id == req.scene_id:
                for sh in sc.shots:
                    if sh.shot_id == req.shot_id and sh.duration_ms <= 0:
                        sh.duration_ms = 2500
                        return updated, f"Reset Shot #{sh.shot_order} duration to 2500ms."

    if action == "recenter_character" and req.scene_id:
        for sc in updated.scenes:
            if sc.scene_id == req.scene_id:
                fixed = 0
                for ch in sc.characters:
                    if ch.initial_transform.x < -120 or ch.initial_transform.x > stage_w + 120 or ch.initial_transform.y < -120 or ch.initial_transform.y > stage_h + 120:
                        ch.initial_transform.x = round(stage_w * 0.5, 1)
                        ch.initial_transform.y = round(stage_h * 0.62, 1)
                        fixed += 1
                if fixed:
                    return updated, f"Recentered {fixed} out-of-bounds character(s) inside canvas."

    if action == "reset_character_scale" and req.scene_id:
        for sc in updated.scenes:
            if sc.scene_id == req.scene_id:
                fixed = 0
                for ch in sc.characters:
                    if abs(ch.initial_transform.scale_x) < 0.08 or abs(ch.initial_transform.scale_x) > 4.5 or abs(ch.initial_transform.scale_y) < 0.08 or abs(ch.initial_transform.scale_y) > 4.5:
                        ch.initial_transform.scale_x = 1.0
                        ch.initial_transform.scale_y = 1.0
                        fixed += 1
                if fixed:
                    return updated, f"Normalized scale on {fixed} character(s) to 1.0."

    if action == "reset_scene_camera" and req.scene_id:
        for sc in updated.scenes:
            if sc.scene_id == req.scene_id:
                sc.camera_default.x = 0.0
                sc.camera_default.y = 0.0
                sc.camera_default.zoom = 1.0
                sc.camera_default.rotation_deg = 0.0
                return updated, f"Reset camera transform on '{sc.name}'."

    if action == "clamp_negative_keyframes":
        fixed = 0
        for kf in updated.timeline.keyframes:
            if kf.time_ms < 0:
                kf.time_ms = 0
                fixed += 1
        return updated, f"Clamped {fixed} negative keyframe(s) to 0ms."

    if action == "clean_orphan_keyframes":
        track_ids = {t.track_id for t in updated.timeline.tracks}
        known_targets = {"camera", *(sc.scene_id for sc in updated.scenes)}
        for sc in updated.scenes:
            known_targets.update(ch.instance_id for ch in sc.characters)
            known_targets.update(pr.prop_instance_id for pr in sc.props)
        before = len(updated.timeline.keyframes)
        updated.timeline.keyframes = [
            kf
            for kf in updated.timeline.keyframes
            if kf.track_id in track_ids and (kf.target_type == "camera" or kf.target_id in known_targets)
        ]
        removed = before - len(updated.timeline.keyframes)
        return updated, f"Removed {removed} orphaned keyframe(s)."

    if action == "remove_broken_audio" and req.sound_event_id:
        before = len(updated.timeline.sound_events)
        updated.timeline.sound_events = [
            ev for ev in updated.timeline.sound_events if ev.event_id != req.sound_event_id
        ]
        if len(updated.timeline.sound_events) < before:
            return updated, f"Removed broken audio event '{req.sound_event_id}'."

    if action == "fix_subtitle_timing" and req.subtitle_id and updated.subtitles:
        for seg in updated.subtitles.segments:
            if seg.subtitle_id == req.subtitle_id:
                seg.start_ms = max(0, min(seg.start_ms, tl_dur - 200))
                seg.end_ms = max(seg.start_ms + 300, min(seg.end_ms, tl_dur))
                return updated, f"Normalized subtitle '{seg.subtitle_id}' timing to {seg.start_ms}–{seg.end_ms}ms."

    if action == "enable_subtitle_safe_area" and req.subtitle_id and updated.subtitles:
        for seg in updated.subtitles.segments:
            if seg.subtitle_id == req.subtitle_id:
                from schemas.subtitle import SubtitleStyleOverride

                ov = seg.style_override or SubtitleStyleOverride()
                seg.style_override = ov.model_copy(
                    update={"safe_area_clamp": True, "offset_x": 0.0, "offset_y": 0.0}
                )
                return updated, f"Enabled Safe-Area Clamp on subtitle '{seg.subtitle_id}'."

    raise ValueError(f"Fix action '{action}' is not applicable to the current project state.")
