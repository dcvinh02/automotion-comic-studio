"""Production Plan Pre-Execution Validator (Phase 07 Batch 1).

Strictly validates every Scene/Shot reference, Character ID, Rig part, Asset ID,
on-disk file existence, Camera & Animation capability, Dimensions, Duration, and
existing executed state before automated Scene Assembly.
"""

from __future__ import annotations

import math
import uuid

from core.asset_engine.service import AssetService
from core.scene_execution_engine.staging import stable_id
from core.storyboard_engine.camera_capabilities import evaluate_camera_movement_support
from database.library_repo import LibraryRepository
from schemas.asset import Asset
from schemas.character import Character
from schemas.production import ProductionShotPlan
from schemas.project import ProjectState
from schemas.scene_execution import (
    ExecutionValidationStatus,
    SceneValidationReport,
    ShotValidationResult,
    ValidationIssue,
)


def _uid(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


def _check_asset_file_exists(asset_service: AssetService, asset: Asset) -> bool:
    try:
        return asset_service.resolve_asset_file(asset).is_file()
    except Exception:
        return False


def validate_production_plan_for_execution(
    project: ProjectState,
    library_repo: LibraryRepository,
    asset_service: AssetService,
    target_shots: list[ProductionShotPlan],
) -> tuple[SceneValidationReport, dict[str, Character], dict[str, Asset]]:
    """Run deterministic, real-data pre-execution validation against library.db & project.db."""
    characters = library_repo.list_characters()
    assets = library_repo.list_assets()
    chars_by_id = {c.character_id: c for c in characters}
    assets_by_id = {a.asset_id: a for a in assets}

    project_issues: list[ValidationIssue] = []

    # 1. Project dimensions & FPS validation
    w, h, fps = project.meta.width, project.meta.height, project.meta.fps
    if w < 320 or w > 3840 or h < 240 or h > 2160:
        project_issues.append(
            ValidationIssue(
                issue_id=_uid("val"),
                code="INVALID_DIMENSIONS",
                severity="error",
                category="dimensions",
                label=f"{w}x{h}",
                message=f"Invalid scene dimensions ({w}x{h}); must be between 320x240 and 3840x2160.",
                suggested_action="Fix project width/height in Project Overview.",
            )
        )
    if fps < 12 or fps > 120:
        project_issues.append(
            ValidationIssue(
                issue_id=_uid("val"),
                code="INVALID_FPS",
                severity="error",
                category="dimensions",
                label=f"{fps} fps",
                message=f"Invalid project FPS ({fps}); must be between 12 and 120.",
                suggested_action="Set a valid frame rate (e.g. 24 or 30 FPS).",
            )
        )

    plan_doc = project.production_plan
    if not plan_doc:
        project_issues.append(
            ValidationIssue(
                issue_id=_uid("val"),
                code="NO_PRODUCTION_PLAN",
                severity="error",
                category="scene_ref",
                label="Production Plan",
                message="No Production Plan exists in this project yet.",
                suggested_action="Generate and review a Production Plan in Phase 06 first.",
            )
        )

    # Index existing executed shots across all scenes for duplicate detection
    existing_shots_by_prod_id: dict[str, str] = {}
    for scn in project.scenes:
        for es in scn.shots:
            if es.production_shot_id:
                existing_shots_by_prod_id[es.production_shot_id] = es.shot_id

    shot_results: list[ShotValidationResult] = []

    for shot in target_shots:
        issues: list[ValidationIssue] = []
        missing_deps: list[ValidationIssue] = []
        unsupported_actions: list[str] = []
        warnings: list[str] = []

        has_invalid = False
        has_missing_dep = False
        has_unsupported = False
        has_needs_review = False

        # Shot & Scene reference checks
        if not shot.scene_id or not shot.scene_id.strip():
            has_invalid = True
            issues.append(
                ValidationIssue(
                    issue_id=_uid("val"),
                    code="INVALID_SCENE_REF",
                    severity="error",
                    category="scene_ref",
                    label=shot.title,
                    message="Shot is missing a valid scene_id reference.",
                    production_shot_id=shot.production_shot_id,
                )
            )
        if not shot.shot_id or not shot.shot_id.strip():
            has_invalid = True
            issues.append(
                ValidationIssue(
                    issue_id=_uid("val"),
                    code="INVALID_SHOT_REF",
                    severity="error",
                    category="shot_ref",
                    label=shot.title,
                    message="Shot is missing a valid shot_id reference.",
                    production_shot_id=shot.production_shot_id,
                )
            )

        # Duration validation
        if shot.duration_ms <= 0 or shot.duration_ms > 600_000:
            has_invalid = True
            issues.append(
                ValidationIssue(
                    issue_id=_uid("val"),
                    code="INVALID_DURATION",
                    severity="error",
                    category="duration",
                    label=f"{shot.duration_ms}ms",
                    message=f"Shot duration ({shot.duration_ms}ms) is invalid; must be between 1ms and 600000ms.",
                    production_shot_id=shot.production_shot_id,
                )
            )

        # Camera numeric & capability validation
        cp = shot.camera_plan.camera_plan
        cam_vals = [
            cp.start_x, cp.start_y, cp.start_zoom, cp.start_rotation_deg,
            cp.end_x, cp.end_y, cp.end_zoom, cp.end_rotation_deg,
        ]
        if any(not math.isfinite(v) for v in cam_vals) or cp.start_zoom <= 0 or cp.end_zoom <= 0:
            has_invalid = True
            issues.append(
                ValidationIssue(
                    issue_id=_uid("val"),
                    code="INVALID_CAMERA_VALUES",
                    severity="error",
                    category="camera",
                    label="Camera Parameters",
                    message="Camera plan contains non-finite values or non-positive zoom.",
                    production_shot_id=shot.production_shot_id,
                )
            )
        cam_status, cam_note = evaluate_camera_movement_support(shot.camera_plan.camera_movement)
        if cam_status == "unsupported_suggestion":
            has_unsupported = True
            unsupported_actions.append(f"Camera '{shot.camera_plan.camera_movement}': {cam_note}")
            issues.append(
                ValidationIssue(
                    issue_id=_uid("val"),
                    code="UNSUPPORTED_CAMERA_MOVEMENT",
                    severity="warning",
                    category="camera",
                    label=f"Camera: {shot.camera_plan.camera_movement}",
                    message=cam_note,
                    suggested_action="Switch to an executable 2D camera movement (static/pan/tilt/zoom) or animate manually.",
                    production_shot_id=shot.production_shot_id,
                )
            )
        elif cam_status == "2d_approximation":
            warnings.append(f"Camera '{shot.camera_plan.camera_movement}': {cam_note}")
            issues.append(
                ValidationIssue(
                    issue_id=_uid("val"),
                    code="CAMERA_2D_APPROXIMATION",
                    severity="info",
                    category="camera",
                    label=f"Camera: {shot.camera_plan.camera_movement}",
                    message=cam_note,
                    production_shot_id=shot.production_shot_id,
                )
            )

        # Character & Rig resolution strictly against library.db
        resolved_char_count = 0
        for ch in shot.characters:
            if not ch.library_character_id:
                has_missing_dep = True
                dep = ValidationIssue(
                    issue_id=_uid("val"),
                    code="MISSING_CHARACTER_REF",
                    severity="error",
                    category="character",
                    label=ch.character_name,
                    message=f"Character '{ch.character_name}' is not linked to a Character Library rig.",
                    suggested_action="Link an existing Character or create one in Character Builder.",
                    production_shot_id=shot.production_shot_id,
                    staging_id=ch.staging_id,
                    repairable=True,
                )
                issues.append(dep)
                missing_deps.append(dep)
                continue

            lib_char = chars_by_id.get(ch.library_character_id)
            if not lib_char:
                has_missing_dep = True
                dep = ValidationIssue(
                    issue_id=_uid("val"),
                    code="INVALID_CHARACTER_ID",
                    severity="error",
                    category="character",
                    label=ch.character_name,
                    message=f"Character ID '{ch.library_character_id}' for '{ch.character_name}' does not exist in library.db.",
                    suggested_action="Re-link to a valid Character Library entry.",
                    production_shot_id=shot.production_shot_id,
                    staging_id=ch.staging_id,
                    repairable=True,
                )
                issues.append(dep)
                missing_deps.append(dep)
                continue

            resolved_char_count += 1
            if len(lib_char.parts) == 0:
                has_missing_dep = True
                dep = ValidationIssue(
                    issue_id=_uid("val"),
                    code="EMPTY_CHARACTER_RIG",
                    severity="warning",
                    category="rig",
                    label=lib_char.name,
                    message=f"Character '{lib_char.name}' has 0 PNG rig parts assembled.",
                    suggested_action="Assemble transparent PNG parts in Cutout Rig Editor.",
                    production_shot_id=shot.production_shot_id,
                    staging_id=ch.staging_id,
                    repairable=False,
                )
                issues.append(dep)
                missing_deps.append(dep)

        # Background Asset resolution strictly by asset_id (never guessing by filename!)
        resolved_bg = False
        if shot.background is not None:
            bg_id = shot.background.matched_asset_id
            if bg_id:
                bg_asset = assets_by_id.get(bg_id)
                if not bg_asset:
                    has_missing_dep = True
                    dep = ValidationIssue(
                        issue_id=_uid("val"),
                        code="INVALID_BACKGROUND_ASSET_ID",
                        severity="error",
                        category="background",
                        label=shot.background.label,
                        message=f"Background asset ID '{bg_id}' does not exist in Asset Library.",
                        suggested_action="Select a valid background asset via Repair Asset.",
                        production_shot_id=shot.production_shot_id,
                        requirement_id=shot.background.requirement_id,
                        repairable=True,
                    )
                    issues.append(dep)
                    missing_deps.append(dep)
                elif not _check_asset_file_exists(asset_service, bg_asset):
                    has_missing_dep = True
                    dep = ValidationIssue(
                        issue_id=_uid("val"),
                        code="MISSING_BACKGROUND_FILE",
                        severity="error",
                        category="background",
                        label=bg_asset.name,
                        message=f"Background PNG file for '{bg_asset.name}' is missing on disk.",
                        suggested_action="Re-import or replace the background asset.",
                        production_shot_id=shot.production_shot_id,
                        requirement_id=shot.background.requirement_id,
                        repairable=True,
                    )
                    issues.append(dep)
                    missing_deps.append(dep)
                else:
                    resolved_bg = True
            elif shot.background.classification == "requires_review":
                has_needs_review = True
                dep = ValidationIssue(
                    issue_id=_uid("val"),
                    code="AMBIGUOUS_BACKGROUND_ASSET",
                    severity="warning",
                    category="background",
                    label=shot.background.label,
                    message=f"Multiple candidate backgrounds match '{shot.background.label}' — select one before assembly.",
                    suggested_action="Choose the intended background via Repair Asset.",
                    production_shot_id=shot.production_shot_id,
                    requirement_id=shot.background.requirement_id,
                    repairable=True,
                )
                issues.append(dep)
                missing_deps.append(dep)
            elif shot.background.required:
                has_missing_dep = True
                dep = ValidationIssue(
                    issue_id=_uid("val"),
                    code="MISSING_BACKGROUND_ASSET",
                    severity="warning",
                    category="background",
                    label=shot.background.label,
                    message=f"Background asset '{shot.background.label}' is missing from Asset Library.",
                    suggested_action="Assign an alternative background asset or import a PNG.",
                    production_shot_id=shot.production_shot_id,
                    requirement_id=shot.background.requirement_id,
                    repairable=True,
                )
                issues.append(dep)
                missing_deps.append(dep)

        # Prop / Environment / Foreground Asset resolution strictly by asset_id
        resolved_prop_count = 0
        for item in shot.assets:
            if item.matched_asset_id:
                p_asset = assets_by_id.get(item.matched_asset_id)
                if not p_asset:
                    has_missing_dep = True
                    dep = ValidationIssue(
                        issue_id=_uid("val"),
                        code="INVALID_PROP_ASSET_ID",
                        severity="error",
                        category="asset",
                        label=item.label,
                        message=f"Asset ID '{item.matched_asset_id}' for '{item.label}' does not exist in Asset Library.",
                        suggested_action="Pick a valid Asset Library item via Repair Asset.",
                        production_shot_id=shot.production_shot_id,
                        requirement_id=item.requirement_id,
                        repairable=True,
                    )
                    issues.append(dep)
                    missing_deps.append(dep)
                elif not _check_asset_file_exists(asset_service, p_asset):
                    has_missing_dep = True
                    dep = ValidationIssue(
                        issue_id=_uid("val"),
                        code="MISSING_PROP_FILE",
                        severity="warning",
                        category="asset",
                        label=p_asset.name,
                        message=f"PNG file for prop '{p_asset.name}' is missing on disk.",
                        suggested_action="Re-import or assign a replacement asset.",
                        production_shot_id=shot.production_shot_id,
                        requirement_id=item.requirement_id,
                        repairable=True,
                    )
                    issues.append(dep)
                    missing_deps.append(dep)
                else:
                    resolved_prop_count += 1
            elif item.classification == "requires_review":
                has_needs_review = True
                dep = ValidationIssue(
                    issue_id=_uid("val"),
                    code="AMBIGUOUS_PROP_ASSET",
                    severity="warning",
                    category="asset",
                    label=item.label,
                    message=f"Ambiguous prop match for '{item.label}' — review and choose an asset.",
                    suggested_action="Select a prop asset via Repair Asset.",
                    production_shot_id=shot.production_shot_id,
                    requirement_id=item.requirement_id,
                    repairable=True,
                )
                issues.append(dep)
                missing_deps.append(dep)
            else:
                has_missing_dep = True
                dep = ValidationIssue(
                    issue_id=_uid("val"),
                    code="MISSING_PROP_ASSET",
                    severity="warning",
                    category="asset",
                    label=item.label,
                    message=f"Prop/environment asset '{item.label}' is missing from Asset Library.",
                    suggested_action="Assign an alternative PNG prop or skip this prop.",
                    production_shot_id=shot.production_shot_id,
                    requirement_id=item.requirement_id,
                    repairable=True,
                )
                issues.append(dep)
                missing_deps.append(dep)

        # Animation capability checks
        for ap in shot.animation_plans:
            if not ap.supported:
                has_unsupported = True
                reason = ap.unsupported_reason or f"Animation '{ap.category}' is unsupported."
                unsupported_actions.append(f"{ap.character_name} ({ap.category}): {reason}")
                issues.append(
                    ValidationIssue(
                        issue_id=_uid("val"),
                        code="UNSUPPORTED_ANIMATION",
                        severity="warning",
                        category="animation",
                        label=f"{ap.character_name}: {ap.category}",
                        message=reason,
                        suggested_action=ap.manual_alternative or "Keyframe manually on Timeline.",
                        production_shot_id=shot.production_shot_id,
                    )
                )

        # Existing execution detection
        existing_shot_id = existing_shots_by_prod_id.get(shot.production_shot_id)
        already_executed = existing_shot_id is not None
        if already_executed:
            warnings.append("This shot has already been assembled on a Scene (re-executing will follow Existing Policy).")
            issues.append(
                ValidationIssue(
                    issue_id=_uid("val"),
                    code="ALREADY_EXECUTED",
                    severity="info",
                    category="existing_state",
                    label=shot.title,
                    message=f"Already assembled as shot '{existing_shot_id}'.",
                    production_shot_id=shot.production_shot_id,
                )
            )

        # Determine structured ValidationStatus
        if has_invalid:
            status: ExecutionValidationStatus = "invalid"
        elif has_missing_dep:
            status = "missing_dependency"
        elif has_unsupported:
            status = "unsupported"
        elif has_needs_review:
            status = "needs_review"
        elif warnings:
            status = "warning"
        else:
            status = "ready"

        # A shot is executable if it's not invalid AND (either has no blocking missing deps OR has at least some real content to assemble)
        has_any_real_content = (
            resolved_char_count > 0
            or resolved_bg
            or resolved_prop_count > 0
            or (len(shot.characters) == 0 and shot.background is None and len(shot.assets) == 0)
        )
        executable = (not has_invalid) and (not project_issues) and has_any_real_content

        shot_results.append(
            ShotValidationResult(
                production_shot_id=shot.production_shot_id,
                shot_id=shot.shot_id,
                scene_id=shot.scene_id,
                shot_order=shot.shot_order,
                title=shot.title,
                status=status,
                executable=executable,
                already_executed=already_executed,
                existing_shot_id=existing_shot_id,
                issues=issues,
                missing_dependencies=missing_deps,
                unsupported_actions=unsupported_actions,
                warnings=warnings,
            )
        )

    # Aggregate counts & overall report status
    counts = {
        "ready": sum(1 for s in shot_results if s.status == "ready"),
        "warning": sum(1 for s in shot_results if s.status == "warning"),
        "missing_dependency": sum(1 for s in shot_results if s.status == "missing_dependency"),
        "unsupported": sum(1 for s in shot_results if s.status == "unsupported"),
        "invalid": sum(1 for s in shot_results if s.status == "invalid"),
        "needs_review": sum(1 for s in shot_results if s.status == "needs_review"),
    }

    if any(i.severity == "error" for i in project_issues) or counts["invalid"] > 0:
        overall: ExecutionValidationStatus = "invalid"
    elif counts["missing_dependency"] > 0:
        overall = "missing_dependency"
    elif counts["unsupported"] > 0:
        overall = "unsupported"
    elif counts["needs_review"] > 0:
        overall = "needs_review"
    elif counts["warning"] > 0:
        overall = "warning"
    else:
        overall = "ready"

    report = SceneValidationReport(
        project_id=project.meta.project_id,
        plan_id=plan_doc.plan_id if plan_doc else None,
        overall_status=overall,
        stage_width=w,
        stage_height=h,
        fps=fps,
        total_shots=len(shot_results),
        ready_count=counts["ready"],
        warning_count=counts["warning"],
        missing_dependency_count=counts["missing_dependency"],
        unsupported_count=counts["unsupported"],
        invalid_count=counts["invalid"],
        needs_review_count=counts["needs_review"],
        already_executed_count=sum(1 for s in shot_results if s.already_executed),
        project_issues=project_issues,
        shots=shot_results,
    )
    return report, chars_by_id, assets_by_id
