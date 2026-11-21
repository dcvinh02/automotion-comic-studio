"""Phase 07 Batch 1 — Scene Execution Engine Service.

Translates approved Phase 06 Production Plans into real, editable, persistent:
- Stage `Scene` objects
- Real Canvas objects (`SceneCharacterInstance`, `ScenePropInstance` for props/environment/foreground)
- Real editable `SceneShot` structures with isolated per-shot state (background, camera,
  character staging/visibility/poses/expressions, prop transforms/visibility, warnings & fallbacks)
- Synchronized Master Timeline tracks & executable 2D camera keyframes (owned-ID safe)

Guarantees:
- Deterministic stable IDs (zero duplicates across repeated execution)
- Strict real-asset resolution by `asset_id` / `character_id` (never fabricating references)
- Existing execution detection with `update_existing` / `reuse_existing` / `skip_existing` policies
- Transactional snapshot & rollback on unexpected execution errors
- Never silently overwrites unrelated user-created scenes, characters, props, or keyframes
"""

from __future__ import annotations

import uuid
from collections import OrderedDict
from typing import Any

from app.logging_config import get_logger
from core.asset_engine.service import AssetService
from core.production_engine.matcher import evaluate_shot_readiness
from core.scene_execution_engine.staging import (
    build_front_to_back_layer_preview,
    compute_shot_character_staging,
    compute_shot_object_staging,
    extract_shot_camera_default,
    stable_id,
)
from core.scene_execution_engine.validator import validate_production_plan_for_execution
from database.library_repo import LibraryRepository
from database.project_repo import ProjectRepository, holds_project_lock
from schemas.common import CameraState, Transform2D, utc_now_iso
from schemas.production import ProductionShotPlan
from schemas.project import ProjectState
from schemas.scene import (
    Scene,
    SceneCharacterInstance,
    SceneExecutionMeta,
    ScenePropInstance,
    SceneShot,
    ShotCharacterState,
    ShotPropState,
)
from schemas.scene_execution import (
    RepairAssetRequest,
    SceneAssemblyPreviewGroup,
    SceneExecutionPreview,
    SceneExecutionPreviewRequest,
    SceneExecutionRequest,
    SceneExecutionResult,
    SceneValidationReport,
    ShotAssemblyPreview,
    ShotExecutionOutcome,
    UpdateSceneShotRequest,
)
from schemas.timeline import Keyframe, TimelineTrack

logger = get_logger("scene_execution_engine")


def _quantize_ms(time_ms: int, fps: int) -> int:
    safe_fps = max(1, int(fps))
    frame = round((time_ms * safe_fps) / 1000.0)
    return int(round((frame * 1000.0) / safe_fps))


def _select_target_shots(
    project: ProjectState,
    scene_ids: list[str] | None,
    production_shot_ids: list[str] | None,
    include_unapproved: bool,
) -> list[ProductionShotPlan]:
    plan = project.production_plan
    if not plan or not plan.shots:
        return []

    shots = list(plan.shots)
    if production_shot_ids is not None:
        id_set = set(production_shot_ids)
        shots = [s for s in shots if s.production_shot_id in id_set]
    elif scene_ids is not None:
        sid_set = set(scene_ids)
        shots = [s for s in shots if s.scene_id in sid_set]

    if not include_unapproved:
        approved = [s for s in shots if s.approval_status == "approved"]
        if approved:
            shots = approved
        else:
            # Never execute rejected shots; if none explicitly approved yet, surface non-rejected for preview/validation
            shots = [s for s in shots if s.approval_status != "rejected"]
    else:
        shots = [s for s in shots if s.approval_status != "rejected"]

    return shots


def _resolve_scene_display_name(project: ProjectState, source_scene_id: str, fallback_idx: int) -> str:
    if project.director:
        for sc in project.director.scenes:
            if sc.scene_breakdown_id == source_scene_id or sc.applied_stage_scene_id == source_scene_id:
                return f"S{sc.scene_number:02d} — {sc.title}"
    for sc in project.scenes:
        if sc.scene_id == source_scene_id:
            return sc.name
    if project.script:
        for sc in project.script.scenes:
            if sc.script_scene_id == source_scene_id:
                return sc.title
    return f"Scene {fallback_idx + 1}"


def _resolve_target_stage_scene(
    project: ProjectState,
    source_scene_id: str,
    shots_in_scene: list[ProductionShotPlan],
) -> tuple[Scene | None, str]:
    """Find an existing Stage Scene linked to source_scene_id, or compute deterministic new scene_id."""
    # 1. Previously executed scene with matching execution_meta.source_scene_id
    for sc in project.scenes:
        if sc.execution_meta and sc.execution_meta.source_scene_id == source_scene_id:
            return sc, sc.scene_id

    # 2. Direct Stage Scene ID match
    for sc in project.scenes:
        if sc.scene_id == source_scene_id:
            return sc, sc.scene_id

    # 3. Director SceneBreakdown applied_stage_scene_id match
    if project.director:
        for dsc in project.director.scenes:
            if dsc.scene_breakdown_id == source_scene_id and dsc.applied_stage_scene_id:
                found = next((s for s in project.scenes if s.scene_id == dsc.applied_stage_scene_id), None)
                if found:
                    return found, found.scene_id

    # 4. Shot timeline_refs.stage_scene_id match
    for sh in shots_in_scene:
        if sh.timeline_refs.stage_scene_id:
            found = next((s for s in project.scenes if s.scene_id == sh.timeline_refs.stage_scene_id), None)
            if found:
                return found, found.scene_id

    # 5. Deterministic new Stage Scene ID
    return None, stable_id("scn_exec", project.meta.project_id, source_scene_id)


def _ensure_track(
    project: ProjectState,
    track_type: str,
    name: str,
    target_ref_id: str | None = None,
) -> TimelineTrack:
    for trk in project.timeline.tracks:
        if trk.track_type == track_type and (
            target_ref_id is None or trk.target_ref_id == target_ref_id
        ):
            return trk

    order_map = {
        "scene": 0,
        "camera": 1,
        "character": 10,
        "prop": 50,
        "subtitle": 800,
        "voice": 900,
        "sfx": 1000,
        "bgm": 1100,
        "ambient": 1200,
    }
    trk = TimelineTrack(
        track_id=stable_id(f"trk_{track_type}", project.meta.project_id, target_ref_id or name),
        project_id=project.meta.project_id,
        track_type=track_type,  # type: ignore[arg-type]
        name=name,
        target_ref_id=target_ref_id,
        order_index=order_map.get(track_type, 100) + len(project.timeline.tracks),
    )
    project.timeline.tracks.append(trk)
    return trk


class SceneExecutionService:
    """Orchestrates validated, previewable, idempotent, transactional Scene Assembly."""

    def __init__(
        self,
        project_repo: ProjectRepository,
        library_repo: LibraryRepository,
        asset_service: AssetService,
    ) -> None:
        self.project_repo = project_repo
        self.library_repo = library_repo
        self.asset_service = asset_service

    def validate(
        self,
        project_id: str,
        *,
        scene_ids: list[str] | None = None,
        production_shot_ids: list[str] | None = None,
        include_unapproved: bool = True,
    ) -> SceneValidationReport:
        project = self.project_repo.get_project_state(project_id)
        target_shots = _select_target_shots(project, scene_ids, production_shot_ids, include_unapproved)
        report, _, _ = validate_production_plan_for_execution(
            project, self.library_repo, self.asset_service, target_shots
        )
        return report

    def preview(
        self,
        project_id: str,
        req: SceneExecutionPreviewRequest,
    ) -> SceneExecutionPreview:
        project = self.project_repo.get_project_state(project_id)
        target_shots = _select_target_shots(
            project, req.scene_ids, req.production_shot_ids, req.include_unapproved
        )
        validation, chars_by_id, assets_by_id = validate_production_plan_for_execution(
            project, self.library_repo, self.asset_service, target_shots
        )
        val_by_prod_id = {v.production_shot_id: v for v in validation.shots}

        # Group target shots by source scene_id preserving order
        grouped: OrderedDict[str, list[ProductionShotPlan]] = OrderedDict()
        for sh in target_shots:
            grouped.setdefault(sh.scene_id, []).append(sh)

        running_end_ms = max(
            (s.start_ms + s.duration_ms for s in project.scenes),
            default=0,
        )

        scene_groups: list[SceneAssemblyPreviewGroup] = []
        total_eligible = 0
        total_blocked = 0
        has_existing = False
        timeline_summary: list[str] = []

        for g_idx, (src_scene_id, sc_shots) in enumerate(grouped.items()):
            existing_scene, target_stage_scene_id = _resolve_target_stage_scene(
                project, src_scene_id, sc_shots
            )
            scene_name = _resolve_scene_display_name(project, src_scene_id, g_idx)
            will_create = existing_scene is None
            scene_start_ms = existing_scene.start_ms if existing_scene else running_end_ms

            existing_user_objects = 0
            scene_already_exec = False
            if existing_scene:
                owned_chars = set(
                    existing_scene.execution_meta.owned_character_instance_ids
                    if existing_scene.execution_meta
                    else []
                )
                owned_props = set(
                    existing_scene.execution_meta.owned_prop_instance_ids
                    if existing_scene.execution_meta
                    else []
                )
                existing_user_objects = sum(
                    1 for c in existing_scene.characters if c.instance_id not in owned_chars
                ) + sum(
                    1 for p in existing_scene.props if p.prop_instance_id not in owned_props
                )
                scene_already_exec = bool(
                    existing_scene.execution_meta and existing_scene.execution_meta.executed
                )

            shot_previews: list[ShotAssemblyPreview] = []
            cursor_local_ms = 0

            for sh in sorted(sc_shots, key=lambda x: (x.shot_order, x.start_time_ms)):
                v = val_by_prod_id[sh.production_shot_id]
                stable_shot_id = v.existing_shot_id or stable_id(
                    "exec_shot", target_stage_scene_id, sh.production_shot_id
                )
                if v.already_executed:
                    has_existing = True
                if v.executable:
                    total_eligible += 1
                else:
                    total_blocked += 1

                staged_chars, staging_fallbacks = compute_shot_character_staging(
                    sh,
                    target_stage_scene_id,
                    project.meta.width,
                    project.meta.height,
                    chars_by_id,
                )
                bg_obj, prop_objs = compute_shot_object_staging(
                    sh,
                    target_stage_scene_id,
                    project.meta.width,
                    project.meta.height,
                    assets_by_id,
                )
                layer_order = build_front_to_back_layer_preview(bg_obj, staged_chars, prop_objs)
                cam_default = extract_shot_camera_default(sh)
                cam_exec = (
                    sh.camera_plan.executable_on_timeline
                    and sh.camera_plan.support_status == "supported"
                )

                shot_dur = max(1, sh.duration_ms)
                abs_start = scene_start_ms + cursor_local_ms
                abs_end = abs_start + shot_dur
                cursor_local_ms += shot_dur

                tl_changes: list[str] = []
                resolved_chars = [c for c in staged_chars if c.resolved]
                resolved_objs = [o for o in prop_objs if o.resolved]
                if bg_obj and bg_obj.resolved:
                    tl_changes.append(f"Background: {bg_obj.asset_name}")
                if resolved_chars:
                    tl_changes.append(f"Stage {len(resolved_chars)} character(s) on Canvas & Timeline")
                if resolved_objs:
                    tl_changes.append(f"Place {len(resolved_objs)} prop/environment/foreground object(s)")
                if cam_exec:
                    tl_changes.append(
                        f"Camera '{sh.camera_plan.camera_movement}' keyframes ({abs_start/1000:.1f}s–{abs_end/1000:.1f}s)"
                    )
                else:
                    tl_changes.append(f"Camera '{sh.camera_plan.camera_movement}' skipped (not directly executable)")

                shot_previews.append(
                    ShotAssemblyPreview(
                        production_shot_id=sh.production_shot_id,
                        stable_shot_id=stable_shot_id,
                        scene_id=sh.scene_id,
                        target_stage_scene_id=target_stage_scene_id,
                        shot_order=sh.shot_order,
                        title=sh.title,
                        start_ms=abs_start,
                        end_ms=abs_end,
                        duration_ms=shot_dur,
                        validation_status=v.status,
                        executable=v.executable,
                        already_executed=v.already_executed,
                        background=bg_obj,
                        characters=staged_chars,
                        objects=prop_objs,
                        layer_order=layer_order,
                        camera_default=cam_default,
                        camera_executable=cam_exec,
                        missing_dependencies=v.missing_dependencies,
                        unsupported_actions=v.unsupported_actions,
                        warnings=v.warnings,
                        staging_fallbacks=staging_fallbacks,
                        expected_timeline_changes=tl_changes,
                    )
                )

            if will_create:
                running_end_ms = scene_start_ms + max(1000, cursor_local_ms)
                timeline_summary.append(
                    f"Create Scene '{scene_name}' ({len(shot_previews)} shot(s), {cursor_local_ms/1000:.1f}s)"
                )
            else:
                timeline_summary.append(
                    f"Assemble into Scene '{scene_name}' ({len(shot_previews)} shot(s), preserving {existing_user_objects} user object(s))"
                )

            scene_groups.append(
                SceneAssemblyPreviewGroup(
                    source_scene_id=src_scene_id,
                    target_stage_scene_id=target_stage_scene_id,
                    scene_name=scene_name,
                    will_create_scene=will_create,
                    already_executed=scene_already_exec,
                    start_ms=scene_start_ms,
                    total_duration_ms=cursor_local_ms,
                    existing_user_object_count=existing_user_objects,
                    shots=shot_previews,
                )
            )

        return SceneExecutionPreview(
            project_id=project_id,
            plan_id=project.production_plan.plan_id if project.production_plan else None,
            validation=validation,
            scenes=scene_groups,
            total_shots_eligible=total_eligible,
            total_shots_blocked=total_blocked,
            has_existing_execution=has_existing,
            recommended_policy="update_existing",
            expected_timeline_summary=timeline_summary,
        )

    @holds_project_lock
    def execute(
        self,
        project_id: str,
        req: SceneExecutionRequest,
        *,
        _inject_failure_after_shot: int | None = None,
    ) -> SceneExecutionResult:
        """Execute validated scene assembly transactionally with rollback on unexpected error."""
        original = self.project_repo.get_project_state(project_id)
        # Pre-execution deep snapshot for guaranteed atomic rollback!
        draft = original.model_copy(deep=True)
        plan_doc = draft.production_plan
        if not plan_doc:
            raise ValueError("No Production Plan exists in this project.")

        target_shots = _select_target_shots(
            draft, req.scene_ids, req.production_shot_ids, req.include_unapproved
        )
        skip_set = set(req.skip_shot_ids)

        validation, chars_by_id, assets_by_id = validate_production_plan_for_execution(
            draft, self.library_repo, self.asset_service, target_shots
        )
        val_by_prod_id = {v.production_shot_id: v for v in validation.shots}

        result = SceneExecutionResult(
            project_id=project_id,
            status="no_changes",
        )

        # Group target shots by source scene_id preserving order
        grouped: OrderedDict[str, list[ProductionShotPlan]] = OrderedDict()
        for sh in target_shots:
            grouped.setdefault(sh.scene_id, []).append(sh)

        fps = draft.timeline.fps or 30
        now_iso = utc_now_iso()
        processed_shots_counter = 0

        try:
            for g_idx, (src_scene_id, sc_shots) in enumerate(grouped.items()):
                existing_scene, target_stage_scene_id = _resolve_target_stage_scene(
                    draft, src_scene_id, sc_shots
                )
                scene_name = _resolve_scene_display_name(draft, src_scene_id, g_idx)

                # Determine whether any shot in this scene will actually execute before creating a brand-new Scene
                sorted_shots = sorted(sc_shots, key=lambda x: (x.shot_order, x.start_time_ms))
                will_run_any = False
                for sh in sorted_shots:
                    if sh.production_shot_id in skip_set:
                        continue
                    v = val_by_prod_id[sh.production_shot_id]
                    if not v.executable:
                        continue
                    if v.status == "missing_dependency" and not req.allow_partial:
                        continue
                    if v.already_executed and req.existing_policy == "skip_existing":
                        continue
                    will_run_any = True
                    break

                if not will_run_any:
                    for sh in sorted_shots:
                        v = val_by_prod_id[sh.production_shot_id]
                        stable_sid = v.existing_shot_id or stable_id(
                            "exec_shot", target_stage_scene_id, sh.production_shot_id
                        )
                        if sh.production_shot_id in skip_set:
                            result.shots_skipped += 1
                            result.outcomes.append(
                                ShotExecutionOutcome(
                                    production_shot_id=sh.production_shot_id,
                                    stable_shot_id=stable_sid,
                                    target_stage_scene_id=target_stage_scene_id,
                                    shot_order=sh.shot_order,
                                    title=sh.title,
                                    outcome="skipped",
                                    reason="Skipped by user.",
                                )
                            )
                        elif v.already_executed and req.existing_policy == "skip_existing":
                            result.shots_skipped += 1
                            result.outcomes.append(
                                ShotExecutionOutcome(
                                    production_shot_id=sh.production_shot_id,
                                    stable_shot_id=stable_sid,
                                    target_stage_scene_id=target_stage_scene_id,
                                    shot_order=sh.shot_order,
                                    title=sh.title,
                                    outcome="skipped",
                                    reason="Already executed (policy: skip_existing).",
                                )
                            )
                        else:
                            result.shots_blocked += 1
                            reason = "; ".join(i.message for i in v.issues if i.severity == "error") or (
                                "; ".join(d.message for d in v.missing_dependencies)
                                or "Validation blocked shot execution."
                            )
                            result.outcomes.append(
                                ShotExecutionOutcome(
                                    production_shot_id=sh.production_shot_id,
                                    stable_shot_id=stable_sid,
                                    target_stage_scene_id=target_stage_scene_id,
                                    shot_order=sh.shot_order,
                                    title=sh.title,
                                    outcome="blocked",
                                    reason=reason,
                                )
                            )
                    continue

                # Ensure or create the real Stage Scene
                if existing_scene is None:
                    start_ms = max(
                        (s.start_ms + s.duration_ms for s in draft.scenes),
                        default=0,
                    )
                    total_scene_dur = max(1000, sum(max(1, s.duration_ms) for s in sorted_shots))
                    stage_scene = Scene(
                        scene_id=target_stage_scene_id,
                        project_id=draft.meta.project_id,
                        order_index=len(draft.scenes),
                        name=scene_name,
                        start_ms=start_ms,
                        duration_ms=total_scene_dur,
                        background_asset_id=None,
                        background_color="#14161A",
                        transition_in="cut",
                        transition_duration_ms=400,
                        camera_default=CameraState(),
                        characters=[],
                        props=[],
                        shots=[],
                        execution_meta=SceneExecutionMeta(
                            executed=True,
                            production_plan_id=plan_doc.plan_id,
                            source_scene_id=src_scene_id,
                            executed_at=now_iso,
                        ),
                    )
                    draft.scenes.append(stage_scene)
                    result.scenes_created += 1
                else:
                    stage_scene = existing_scene
                    if stage_scene.execution_meta is None:
                        stage_scene.execution_meta = SceneExecutionMeta(
                            executed=True,
                            production_plan_id=plan_doc.plan_id,
                            source_scene_id=src_scene_id,
                            executed_at=now_iso,
                        )
                    else:
                        stage_scene.execution_meta.executed = True
                        stage_scene.execution_meta.production_plan_id = plan_doc.plan_id
                        stage_scene.execution_meta.source_scene_id = src_scene_id
                        stage_scene.execution_meta.executed_at = now_iso
                    result.scenes_updated += 1

                # Ensure Scene & Camera Master Timeline tracks exist
                _ensure_track(draft, "scene", "Scene / Background")
                cam_track = _ensure_track(draft, "camera", "Camera")

                cursor_local_ms = 0
                for sh in sorted_shots:
                    v = val_by_prod_id[sh.production_shot_id]
                    stable_shot_id = v.existing_shot_id or stable_id(
                        "exec_shot", stage_scene.scene_id, sh.production_shot_id
                    )

                    # Skip or Block checks
                    if sh.production_shot_id in skip_set:
                        result.shots_skipped += 1
                        result.outcomes.append(
                            ShotExecutionOutcome(
                                production_shot_id=sh.production_shot_id,
                                stable_shot_id=stable_shot_id,
                                target_stage_scene_id=stage_scene.scene_id,
                                shot_order=sh.shot_order,
                                title=sh.title,
                                outcome="skipped",
                                reason="Skipped by user.",
                            )
                        )
                        continue

                    if not v.executable or (v.status == "missing_dependency" and not req.allow_partial):
                        result.shots_blocked += 1
                        reason = "; ".join(i.message for i in v.issues if i.severity == "error") or (
                            "; ".join(d.message for d in v.missing_dependencies)
                            or "Validation blocked shot execution."
                        )
                        result.outcomes.append(
                            ShotExecutionOutcome(
                                production_shot_id=sh.production_shot_id,
                                stable_shot_id=stable_shot_id,
                                target_stage_scene_id=stage_scene.scene_id,
                                shot_order=sh.shot_order,
                                title=sh.title,
                                outcome="blocked",
                                reason=reason,
                            )
                        )
                        continue

                    existing_shot = next(
                        (
                            es
                            for es in stage_scene.shots
                            if es.shot_id == stable_shot_id
                            or es.production_shot_id == sh.production_shot_id
                        ),
                        None,
                    )

                    if existing_shot is not None:
                        if req.existing_policy == "skip_existing":
                            cursor_local_ms += existing_shot.duration_ms
                            result.shots_skipped += 1
                            result.outcomes.append(
                                ShotExecutionOutcome(
                                    production_shot_id=sh.production_shot_id,
                                    stable_shot_id=existing_shot.shot_id,
                                    target_stage_scene_id=stage_scene.scene_id,
                                    shot_order=sh.shot_order,
                                    title=sh.title,
                                    outcome="skipped",
                                    reason="Already executed (policy: skip_existing).",
                                )
                            )
                            continue
                        if req.existing_policy == "reuse_existing":
                            cursor_local_ms += existing_shot.duration_ms
                            result.shots_reused += 1
                            result.outcomes.append(
                                ShotExecutionOutcome(
                                    production_shot_id=sh.production_shot_id,
                                    stable_shot_id=existing_shot.shot_id,
                                    target_stage_scene_id=stage_scene.scene_id,
                                    shot_order=sh.shot_order,
                                    title=sh.title,
                                    outcome="reused",
                                    reason="Reused existing executed shot without modification.",
                                    characters_assembled=len(existing_shot.character_states),
                                    objects_assembled=len(existing_shot.prop_states),
                                )
                            )
                            continue

                    # Fault-injection hook for automated transactional rollback unit testing
                    processed_shots_counter += 1
                    if (
                        _inject_failure_after_shot is not None
                        and processed_shots_counter >= _inject_failure_after_shot
                    ):
                        raise RuntimeError("Injected mid-execution failure for rollback verification.")

                    # Compute normalized character staging & prop/background resolution
                    staged_chars, staging_fallbacks = compute_shot_character_staging(
                        sh,
                        stage_scene.scene_id,
                        draft.meta.width,
                        draft.meta.height,
                        chars_by_id,
                    )
                    bg_obj, prop_objs = compute_shot_object_staging(
                        sh,
                        stage_scene.scene_id,
                        draft.meta.width,
                        draft.meta.height,
                        assets_by_id,
                    )

                    shot_warnings: list[str] = list(v.warnings)
                    for dep in v.missing_dependencies:
                        shot_warnings.append(dep.message)
                    for unsup in v.unsupported_actions:
                        shot_warnings.append(unsup)

                    # 1. Background resolution (never overwrite existing non-empty scene default if user set one,
                    #    but always store exact per-shot `background_asset_id` on `SceneShot`!)
                    shot_bg_asset_id: str | None = (
                        bg_obj.asset_id if bg_obj and bg_obj.resolved else None
                    )
                    if shot_bg_asset_id and not stage_scene.background_asset_id:
                        stage_scene.background_asset_id = shot_bg_asset_id

                    shot_asset_refs: list[str] = []
                    if shot_bg_asset_id:
                        shot_asset_refs.append(shot_bg_asset_id)

                    # 2. Place / reuse real SceneCharacterInstances on Stage Scene (ZERO duplicates!)
                    char_states: list[ShotCharacterState] = []
                    placed_instance_ids: list[str] = []
                    for sc_place in staged_chars:
                        if not sc_place.resolved or not sc_place.library_character_id:
                            continue

                        # Reuse existing instance for same library character on this scene (never duplicate!)
                        inst = next(
                            (
                                c
                                for c in stage_scene.characters
                                if c.instance_id == sc_place.stable_instance_id
                                or c.character_id == sc_place.library_character_id
                            ),
                            None,
                        )
                        if inst is None:
                            inst = SceneCharacterInstance(
                                instance_id=sc_place.stable_instance_id,
                                scene_id=stage_scene.scene_id,
                                character_id=sc_place.library_character_id,
                                display_name=sc_place.character_name,
                                z_index=sc_place.z_index,
                                visible=sc_place.visible,
                                locked=False,
                                initial_transform=sc_place.transform.model_copy(deep=True),
                                default_expression_id=sc_place.expression_id,
                                default_pose_id=sc_place.pose_id,
                            )
                            stage_scene.characters.append(inst)
                            result.characters_created += 1
                            if (
                                stage_scene.execution_meta
                                and inst.instance_id
                                not in stage_scene.execution_meta.owned_character_instance_ids
                            ):
                                stage_scene.execution_meta.owned_character_instance_ids.append(
                                    inst.instance_id
                                )
                        else:
                            result.characters_reused += 1

                        _ensure_track(draft, "character", inst.display_name, inst.instance_id)
                        placed_instance_ids.append(inst.instance_id)

                        # Determine primary supported animation state for this character in this shot
                        anim_state: str | None = None
                        for ap in sh.animation_plans:
                            if (
                                ap.supported
                                and ap.library_character_id == sc_place.library_character_id
                                and ap.mapped_animation_state
                            ):
                                anim_state = ap.mapped_animation_state
                                break

                        char_states.append(
                            ShotCharacterState(
                                instance_id=inst.instance_id,
                                character_id=inst.character_id,
                                display_name=inst.display_name,
                                visible=sc_place.visible,
                                z_index=sc_place.z_index,
                                transform=sc_place.transform.model_copy(deep=True),
                                facing_direction=sc_place.facing_direction,
                                screen_position=sc_place.screen_position,
                                depth_layer=sc_place.depth_layer,
                                pose_id=sc_place.pose_id,
                                expression_id=sc_place.expression_id,
                                animation_state=anim_state,
                                staging_fallback_used=sc_place.fallback_used,
                                staging_fallback_reason=sc_place.fallback_reason,
                            )
                        )

                    # 3. Place / reuse real ScenePropInstances for props, environment & foreground objects!
                    prop_states: list[ShotPropState] = []
                    for obj in prop_objs:
                        if not obj.resolved or not obj.asset_id:
                            continue
                        shot_asset_refs.append(obj.asset_id)

                        prop_inst = next(
                            (
                                p
                                for p in stage_scene.props
                                if p.prop_instance_id == obj.stable_prop_instance_id
                                or (p.asset_id == obj.asset_id and p.name == obj.name)
                            ),
                            None,
                        )
                        if prop_inst is None:
                            prop_inst = ScenePropInstance(
                                prop_instance_id=obj.stable_prop_instance_id,
                                asset_id=obj.asset_id,
                                layer_kind="prop",
                                name=obj.name,
                                z_index=obj.z_index,
                                anchor_x=0.5,
                                anchor_y=0.5,
                                visible=obj.visible,
                                locked=False,
                                transform=obj.transform.model_copy(deep=True),
                            )
                            stage_scene.props.append(prop_inst)
                            result.props_created += 1
                            if (
                                stage_scene.execution_meta
                                and prop_inst.prop_instance_id
                                not in stage_scene.execution_meta.owned_prop_instance_ids
                            ):
                                stage_scene.execution_meta.owned_prop_instance_ids.append(
                                    prop_inst.prop_instance_id
                                )
                        else:
                            result.props_reused += 1

                        _ensure_track(draft, "prop", prop_inst.name, prop_inst.prop_instance_id)

                        prop_states.append(
                            ShotPropState(
                                prop_instance_id=prop_inst.prop_instance_id,
                                asset_id=prop_inst.asset_id,
                                name=prop_inst.name,
                                role=obj.role if obj.role != "background" else "prop",
                                visible=obj.visible,
                                z_index=obj.z_index,
                                transform=obj.transform.model_copy(deep=True),
                            )
                        )

                    # 4. Build / Update real editable SceneShot structure
                    shot_dur = max(1, sh.duration_ms)
                    cam_default = extract_shot_camera_default(sh)
                    anim_refs = [
                        ap.action_plan_id for ap in sh.animation_plans if ap.supported
                    ]
                    preserved_motions = []
                    if existing_shot is not None:
                        anim_refs = list(dict.fromkeys([*anim_refs, *existing_shot.animation_refs]))
                        preserved_motions = [m.model_copy(deep=True) for m in existing_shot.applied_motions]
                    exec_status = (
                        "partial"
                        if (v.missing_dependencies or v.unsupported_actions)
                        else "warning"
                        if (shot_warnings or staging_fallbacks)
                        else "assembled"
                    )

                    new_shot = SceneShot(
                        shot_id=stable_shot_id,
                        scene_id=stage_scene.scene_id,
                        production_shot_id=sh.production_shot_id,
                        storyboard_shot_id=sh.shot_id,
                        shot_order=sh.shot_order,
                        title=sh.title,
                        start_ms=cursor_local_ms,
                        duration_ms=shot_dur,
                        background_asset_id=shot_bg_asset_id,
                        camera_default=cam_default,
                        character_states=char_states,
                        prop_states=prop_states,
                        asset_refs=list(dict.fromkeys(shot_asset_refs)),
                        animation_refs=anim_refs,
                        applied_motions=preserved_motions,
                        execution_status=exec_status,  # type: ignore[arg-type]
                        warnings=shot_warnings,
                        staging_fallbacks=staging_fallbacks,
                        updated_at=now_iso,
                    )

                    if existing_shot is not None:
                        idx_existing = stage_scene.shots.index(existing_shot)
                        stage_scene.shots[idx_existing] = new_shot
                        result.shots_updated += 1
                        outcome_kind = "updated"
                    else:
                        stage_scene.shots.append(new_shot)
                        result.shots_assembled += 1
                        outcome_kind = "assembled"

                    if (
                        stage_scene.execution_meta
                        and new_shot.shot_id not in stage_scene.execution_meta.owned_shot_ids
                    ):
                        stage_scene.execution_meta.owned_shot_ids.append(new_shot.shot_id)

                    # 5. Safely sync owned 2D Camera Keyframes on Master Timeline (strictly idempotent:
                    # strips ONLY prior kf_exec_* owned by this shot so animation_execution keyframes
                    # and user keyframes are untouched and duplicate IDs can never accumulate).
                    abs_start_ms = stage_scene.start_ms + cursor_local_ms
                    abs_end_ms = abs_start_ms + shot_dur
                    owned_kf_ids: list[str] = []
                    if req.sync_timeline_keyframes:
                        deterministic_exec_ids = {
                            stable_id("kf_exec", new_shot.shot_id, pname, endp)
                            for pname in ("x", "y", "zoom", "rotation_deg")
                            for endp in ("start", "end")
                        }
                        prev_exec_kfs = {
                            kid
                            for kid in sh.timeline_refs.keyframe_ids
                            if kid.startswith("kf_exec_")
                        } | deterministic_exec_ids
                        draft.timeline.keyframes = [
                            k for k in draft.timeline.keyframes if k.keyframe_id not in prev_exec_kfs
                        ]
                        if (
                            sh.camera_plan.executable_on_timeline
                            and sh.camera_plan.support_status == "supported"
                        ):
                            cp = sh.camera_plan.camera_plan
                            q_start = _quantize_ms(abs_start_ms, fps)
                            q_end = _quantize_ms(max(abs_start_ms + 200, abs_end_ms - 100), fps)
                            cam_pairs = [
                                ("x", cp.start_x, cp.end_x),
                                ("y", cp.start_y, cp.end_y),
                                ("zoom", cp.start_zoom, cp.end_zoom),
                                ("rotation_deg", cp.start_rotation_deg, cp.end_rotation_deg),
                            ]
                            for prop_name, v0, v1 in cam_pairs:
                                k1_id = stable_id("kf_exec", new_shot.shot_id, prop_name, "start")
                                draft.timeline.keyframes.append(
                                    Keyframe(
                                        keyframe_id=k1_id,
                                        track_id=cam_track.track_id,
                                        target_type="camera",
                                        target_id="camera",
                                        property=prop_name,  # type: ignore[arg-type]
                                        time_ms=q_start,
                                        value=v0,
                                        easing=cp.easing,
                                    )
                                )
                                owned_kf_ids.append(k1_id)
                                result.keyframes_synced += 1

                                if v1 != v0:
                                    k2_id = stable_id("kf_exec", new_shot.shot_id, prop_name, "end")
                                    draft.timeline.keyframes.append(
                                        Keyframe(
                                            keyframe_id=k2_id,
                                            track_id=cam_track.track_id,
                                            target_type="camera",
                                            target_id="camera",
                                            property=prop_name,  # type: ignore[arg-type]
                                            time_ms=q_end,
                                            value=v1,
                                            easing=cp.easing,
                                        )
                                    )
                                    owned_kf_ids.append(k2_id)
                                    result.keyframes_synced += 1

                    # Update ProductionShotPlan timeline_refs cleanly so Phase 06 & Phase 07 stay 100% synced!
                    sh.timeline_refs.applied = True
                    sh.timeline_refs.applied_at = now_iso
                    sh.timeline_refs.stage_scene_id = stage_scene.scene_id
                    sh.timeline_refs.applied_start_ms = abs_start_ms
                    sh.timeline_refs.applied_end_ms = abs_end_ms
                    sh.timeline_refs.character_instance_ids = placed_instance_ids
                    if req.sync_timeline_keyframes:
                        non_exec_kfs = [
                            kid for kid in sh.timeline_refs.keyframe_ids if not kid.startswith("kf_exec_")
                        ]
                        sh.timeline_refs.keyframe_ids = list(dict.fromkeys([*non_exec_kfs, *owned_kf_ids]))
                    sh.timeline_refs.skipped_operations = list(v.unsupported_actions)

                    cursor_local_ms += shot_dur
                    result.warnings.extend(shot_warnings)
                    result.outcomes.append(
                        ShotExecutionOutcome(
                            production_shot_id=sh.production_shot_id,
                            stable_shot_id=new_shot.shot_id,
                            target_stage_scene_id=stage_scene.scene_id,
                            shot_order=sh.shot_order,
                            title=sh.title,
                            outcome=outcome_kind,  # type: ignore[arg-type]
                            characters_assembled=len(char_states),
                            objects_assembled=len(prop_states),
                            warnings=shot_warnings,
                            staging_fallbacks=staging_fallbacks,
                        )
                    )

                # Re-sort shots chronologically & recalculate scene-relative start_ms + scene duration cleanly
                stage_scene.shots.sort(key=lambda s: (s.shot_order, s.start_ms, s.shot_id))
                running_local = 0
                for s_item in stage_scene.shots:
                    s_item.start_ms = running_local
                    running_local += max(1, s_item.duration_ms)
                if running_local > stage_scene.duration_ms:
                    stage_scene.duration_ms = running_local
                if stage_scene.execution_meta:
                    stage_scene.execution_meta.execution_warnings = list(
                        dict.fromkeys(w for s in stage_scene.shots for w in s.warnings)
                    )

                scene_end = stage_scene.start_ms + stage_scene.duration_ms
                if scene_end > draft.timeline.total_duration_ms:
                    draft.timeline.total_duration_ms = scene_end
                    draft.meta.duration_ms = scene_end

            # Finalize status & persist atomically
            any_mutated = (
                result.shots_assembled > 0
                or result.shots_updated > 0
                or result.scenes_created > 0
            )
            if any_mutated:
                plan_doc.status = "applied"
                plan_doc.updated_at = now_iso
                saved = self.project_repo.save_project_state(draft)
                result.status = (
                    "partial"
                    if (result.shots_blocked > 0 or any(o.warnings for o in result.outcomes))
                    else "completed"
                )
                result.updated_project = saved.model_dump(mode="json")
            elif result.shots_reused > 0:
                result.status = "completed"
                result.updated_project = original.model_dump(mode="json")
            else:
                result.status = "partial" if result.shots_blocked > 0 else "no_changes"
                result.updated_project = original.model_dump(mode="json")

            result.warnings = list(dict.fromkeys(result.warnings))
            return result

        except Exception as exc:
            logger.exception("Scene execution failed for %s — rolling back cleanly: %s", project_id, exc)
            # Ensure original persisted state remains untouched!
            self.project_repo.save_project_state(original)
            return SceneExecutionResult(
                project_id=project_id,
                status="rolled_back",
                warnings=[f"Execution rolled back safely due to error: {exc}"],
                outcomes=result.outcomes,
                updated_project=original.model_dump(mode="json"),
            )

    @holds_project_lock
    def repair_missing_asset(
        self,
        project_id: str,
        req: RepairAssetRequest,
    ) -> dict[str, Any]:
        """Explicit user-driven missing asset / character repair workflow (never silent!)."""
        project = self.project_repo.get_project_state(project_id)
        plan = project.production_plan
        if not plan:
            raise ValueError("No Production Plan exists in this project.")

        shot = next((s for s in plan.shots if s.production_shot_id == req.production_shot_id), None)
        if not shot:
            raise FileNotFoundError(f"Production shot not found: {req.production_shot_id}")

        characters = self.library_repo.list_characters()
        assets = self.library_repo.list_assets()
        sounds = self.library_repo.list_sounds()

        if req.target_kind == "character":
            if not req.staging_id:
                raise ValueError("staging_id is required when repairing a character.")
            ch_plan = next((c for c in shot.characters if c.staging_id == req.staging_id), None)
            if not ch_plan:
                raise FileNotFoundError(f"Character staging not found: {req.staging_id}")
            if req.character_id:
                lib_char = self.library_repo.get_character(req.character_id)
                if not lib_char:
                    raise FileNotFoundError(f"Character not found in library: {req.character_id}")
                ch_plan.library_character_id = lib_char.character_id
                ch_plan.character_missing = False
                ch_plan.rig_missing = len(lib_char.parts) == 0
                for ap in shot.animation_plans:
                    if ap.character_name.lower() == ch_plan.character_name.lower():
                        ap.library_character_id = lib_char.character_id
            else:
                ch_plan.library_character_id = None
                ch_plan.character_missing = True
                ch_plan.rig_missing = True
            if "characters" not in shot.user_edited_fields:
                shot.user_edited_fields.append("characters")

        elif req.target_kind == "background":
            if not shot.background:
                raise ValueError("Shot has no background requirement.")
            if req.asset_id:
                asset = self.library_repo.get_asset(req.asset_id)
                if not asset:
                    raise FileNotFoundError(f"Asset not found in library: {req.asset_id}")
                shot.background.matched_asset_id = asset.asset_id
                shot.background.matched_asset_name = asset.name
                shot.background.classification = "existing_compatible"
                shot.background.notes = f"Repaired by user -> '{asset.name}'."
            else:
                shot.background.matched_asset_id = None
                shot.background.matched_asset_name = ""
                shot.background.classification = "missing"
            if "background" not in shot.user_edited_fields:
                shot.user_edited_fields.append("background")

        elif req.target_kind == "prop":
            if not req.requirement_id:
                raise ValueError("requirement_id is required when repairing a prop asset.")
            item = next((a for a in shot.assets if a.requirement_id == req.requirement_id), None)
            if not item:
                raise FileNotFoundError(f"Asset requirement not found: {req.requirement_id}")
            if req.asset_id:
                asset = self.library_repo.get_asset(req.asset_id)
                if not asset:
                    raise FileNotFoundError(f"Asset not found in library: {req.asset_id}")
                item.matched_asset_id = asset.asset_id
                item.matched_asset_name = asset.name
                item.classification = "existing_compatible"
                item.notes = f"Repaired by user -> '{asset.name}'."
            else:
                item.matched_asset_id = None
                item.matched_asset_name = ""
                item.classification = "missing"
            if "assets" not in shot.user_edited_fields:
                shot.user_edited_fields.append("assets")

        # Re-evaluate readiness cleanly & persist
        idx = plan.shots.index(shot)
        plan.shots[idx] = evaluate_shot_readiness(
            shot,
            characters_by_id={c.character_id: c for c in characters},
            assets_by_id={a.asset_id: a for a in assets},
            sounds_by_id={s.sound_id: s for s in sounds},
        )
        plan.updated_at = utc_now_iso()
        saved = self.project_repo.save_project_state(project)
        val_report, _, _ = validate_production_plan_for_execution(
            saved, self.library_repo, self.asset_service, [plan.shots[idx]]
        )
        return {
            "project": saved.model_dump(mode="json"),
            "validation": val_report.model_dump(mode="json"),
        }

    @holds_project_lock
    def update_shot(
        self,
        project_id: str,
        shot_id: str,
        req: UpdateSceneShotRequest,
    ) -> dict[str, Any]:
        """Edit an executed SceneShot without leaking changes to sibling shots."""
        project = self.project_repo.get_project_state(project_id)
        target_scene: Scene | None = None
        target_shot: SceneShot | None = None
        for sc in project.scenes:
            found = next((s for s in sc.shots if s.shot_id == shot_id), None)
            if found:
                target_scene = sc
                target_shot = found
                break

        if not target_scene or not target_shot:
            raise FileNotFoundError(f"Executed shot not found: {shot_id}")

        if req.title is not None:
            target_shot.title = req.title.strip() or target_shot.title
        if req.duration_ms is not None:
            target_shot.duration_ms = max(100, int(req.duration_ms))
        if req.clear_background:
            target_shot.background_asset_id = None
        elif req.background_asset_id is not None:
            if not self.library_repo.get_asset(req.background_asset_id):
                raise FileNotFoundError(f"Asset not found in library: {req.background_asset_id}")
            target_shot.background_asset_id = req.background_asset_id
        if req.camera_default is not None:
            target_shot.camera_default = req.camera_default
        if req.character_states is not None:
            target_shot.character_states = [
                ShotCharacterState.model_validate(c) for c in req.character_states
            ]
        if req.prop_states is not None:
            target_shot.prop_states = [
                ShotPropState.model_validate(p) for p in req.prop_states
            ]

        target_shot.execution_status = "edited"
        target_shot.updated_at = utc_now_iso()

        # Recompute sequential scene-relative timings cleanly
        running_local = 0
        for sh in target_scene.shots:
            sh.start_ms = running_local
            running_local += max(1, sh.duration_ms)
        if running_local > target_scene.duration_ms:
            target_scene.duration_ms = running_local
        scene_end = target_scene.start_ms + target_scene.duration_ms
        if scene_end > project.timeline.total_duration_ms:
            project.timeline.total_duration_ms = scene_end
            project.meta.duration_ms = scene_end

        saved = self.project_repo.save_project_state(project)
        return {
            "shot": target_shot.model_dump(mode="json"),
            "project": saved.model_dump(mode="json"),
        }
