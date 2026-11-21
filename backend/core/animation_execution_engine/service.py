"""Phase 07 Batch 2 — Animation Execution Engine Service.

Orchestrates:
- Character Rig Capability inspection & Motion Library compatibility checks
- Non-destructive live Motion Preview (returns real temporary keyframes without mutating project.db)
- Validated Motion Apply (character or camera) with deterministic stable IDs & zero duplicates
- Production Plan -> Real Character Motion & Synchronized 2D Camera Motion Execution
- Preservation of user-modified motions, single-shot execution, selective regeneration & atomic rollback
"""

from __future__ import annotations

from typing import Any

from app.logging_config import get_logger
from core.animation_execution_engine.camera_motion import (
    evaluate_camera_execution_support,
    generate_camera_motion_keyframes,
)
from core.animation_execution_engine.capabilities import (
    check_preset_compatibility,
    inspect_character_capabilities,
    resolve_action_to_preset,
)
from core.animation_execution_engine.procedural import (
    generate_character_motion_keyframes,
    stable_anim_id,
    validate_motion_parameters,
)
from database.library_repo import LibraryRepository
from database.project_repo import ProjectRepository, holds_project_lock
from schemas.animation_execution import (
    ActionMappingReport,
    CameraExecutionReport,
    CameraMotionParameters,
    CharacterRigCapabilities,
    GeneratedMotionRecord,
    MotionApplyRequest,
    MotionApplyResponse,
    MotionCompatibilityResult,
    MotionParameters,
    MotionPreset,
    MotionPreviewRequest,
    MotionPreviewResponse,
    ShotAnimationExecuteRequest,
    ShotAnimationExecuteResponse,
    ShotAnimationExecutionOutcome,
)
from schemas.character import Character
from schemas.common import Transform2D, utc_now_iso
from schemas.production import AnimationActionPlan, ProductionShotPlan
from schemas.project import ProjectState
from schemas.scene import Scene, SceneCharacterInstance, SceneShot
from schemas.timeline import CharacterAnimationClip, Keyframe, TimelineTrack

logger = get_logger("animation_execution_engine")


def _ensure_timeline_track(
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
    }
    trk = TimelineTrack(
        track_id=stable_anim_id(f"trk_{track_type}", project.meta.project_id, target_ref_id or name),
        project_id=project.meta.project_id,
        track_type=track_type,  # type: ignore[arg-type]
        name=name,
        target_ref_id=target_ref_id,
        order_index=order_map.get(track_type, 100) + len(project.timeline.tracks),
    )
    project.timeline.tracks.append(trk)
    return trk


def _resolve_scene_and_window(
    project: ProjectState,
    scene_id: str,
    shot_id: str | None,
    explicit_start_ms: int | None,
    duration_ms: int,
) -> tuple[Scene, SceneShot | None, int, int]:
    scene = next((s for s in project.scenes if s.scene_id == scene_id), None)
    if not scene:
        raise FileNotFoundError(f"Scene not found: {scene_id}")

    shot: SceneShot | None = None
    if shot_id:
        shot = next((sh for sh in scene.shots if sh.shot_id == shot_id), None)
        if not shot:
            raise FileNotFoundError(f"Shot not found in scene {scene_id}: {shot_id}")
        start_ms = scene.start_ms + shot.start_ms
        end_ms = start_ms + shot.duration_ms
        return scene, shot, start_ms, end_ms

    # Scene-level motion window (no shot specified)
    start_ms = explicit_start_ms if explicit_start_ms is not None else scene.start_ms
    scene_end = scene.start_ms + scene.duration_ms
    start_ms = max(scene.start_ms, min(start_ms, max(scene.start_ms, scene_end - 250)))
    end_ms = min(scene_end, start_ms + max(250, duration_ms))
    return scene, None, start_ms, end_ms


def _resolve_instance_and_transform(
    scene: Scene,
    shot: SceneShot | None,
    instance_id: str,
) -> tuple[SceneCharacterInstance, Transform2D]:
    inst = next((c for c in scene.characters if c.instance_id == instance_id), None)
    if not inst:
        raise FileNotFoundError(f"Character instance not found in scene: {instance_id}")
    if shot:
        cs = next((c for c in shot.character_states if c.instance_id == instance_id), None)
        if cs:
            return inst, cs.transform.model_copy(deep=True)
    return inst, inst.initial_transform.model_copy(deep=True)


def _strip_motion_owned_items(
    project: ProjectState,
    shot: SceneShot | None,
    motion_id: str,
    old_record: GeneratedMotionRecord | None,
    extra_kf_ids: set[str] | None = None,
) -> None:
    """Remove previously owned keyframes & clips for a motion_id without touching user data."""
    kf_to_remove = set(old_record.keyframe_ids) if old_record else set()
    clip_to_remove = set(old_record.clip_ids) if old_record else set()
    if extra_kf_ids:
        kf_to_remove.update(extra_kf_ids)

    if kf_to_remove:
        project.timeline.keyframes = [
            k for k in project.timeline.keyframes if k.keyframe_id not in kf_to_remove
        ]
    if clip_to_remove:
        project.timeline.animation_clips = [
            c for c in project.timeline.animation_clips if c.clip_id not in clip_to_remove
        ]
    if shot:
        if kf_to_remove:
            shot.animation_refs = [r for r in shot.animation_refs if r not in kf_to_remove]
        shot.applied_motions = [m for m in shot.applied_motions if m.motion_id != motion_id]


def _upsert_keyframes_dedup(project: ProjectState, new_kfs: list[Keyframe]) -> None:
    """Insert keyframes with deterministic ID & same-frame property deduplication."""
    new_ids = {k.keyframe_id for k in new_kfs}
    # Remove matching IDs first
    project.timeline.keyframes = [
        k for k in project.timeline.keyframes if k.keyframe_id not in new_ids
    ]
    project.timeline.keyframes.extend(new_kfs)
    project.timeline.keyframes.sort(
        key=lambda k: (k.time_ms, k.target_type, k.target_id, k.property, k.keyframe_id)
    )


def _upsert_clips_dedup(project: ProjectState, new_clips: list[CharacterAnimationClip]) -> None:
    new_ids = {c.clip_id for c in new_clips}
    project.timeline.animation_clips = [
        c for c in project.timeline.animation_clips if c.clip_id not in new_ids
    ]
    project.timeline.animation_clips.extend(new_clips)
    project.timeline.animation_clips.sort(key=lambda c: (c.start_ms, c.clip_id))


def _action_to_motion_params(
    action: AnimationActionPlan,
    preset: MotionPreset,
    shot_duration_ms: int,
    staging_facing: str = "right",
) -> MotionParameters:
    """Translate AI AnimationActionPlan parameters safely into validated MotionParameters."""
    base = preset.default_parameters.model_copy(deep=True)
    raw = action.parameters or {}

    dur = int(action.estimated_duration_ms or base.duration_ms)
    dur = max(preset.min_duration_ms, min(preset.max_duration_ms, min(shot_duration_ms, max(300, dur))))
    if shot_duration_ms < preset.min_duration_ms:
        dur = max(250, shot_duration_ms)

    direction = str(raw.get("direction") or "").lower()
    if direction not in ("left", "right", "up", "down", "forward", "backward", "in_place"):
        if preset.category in ("walk", "run", "look", "turn"):
            direction = "left" if staging_facing == "left" else "right"
        elif preset.category == "jump":
            direction = "up"
        elif preset.category == "fall":
            direction = "down"
        else:
            direction = base.direction

    speed = float(raw.get("speed", base.speed))
    speed = max(0.25, min(3.0, speed))
    intensity = float(raw.get("intensity", base.intensity))
    intensity = max(0.1, min(2.5, intensity))
    distance = float(raw.get("distance_px", base.distance_px))
    distance = max(-2400.0, min(2400.0, distance))

    start_pose = raw.get("pose_id") or raw.get("start_pose_id") or base.start_pose_id
    end_pose = raw.get("end_pose_id") or base.end_pose_id
    easing = raw.get("easing") or base.easing
    if easing not in ("hold", "linear", "ease_in", "ease_out", "ease_in_out", "step", "cubic_bezier"):
        easing = base.easing

    return MotionParameters(
        duration_ms=dur,
        speed=speed,
        intensity=intensity,
        distance_px=distance,
        direction=direction,  # type: ignore[arg-type]
        start_pose_id=str(start_pose) if start_pose else None,
        end_pose_id=str(end_pose) if end_pose else None,
        easing=easing,  # type: ignore[arg-type]
        loop=bool(raw.get("loop", base.loop)),
        delay_ms=max(0, min(shot_duration_ms - 250, int(raw.get("delay_ms", 0))))
        if shot_duration_ms > 250
        else 0,
    )


class AnimationExecutionService:
    """Service layer powering capabilities, Motion Library, Motion Preview, and AI Motion Execution."""

    def __init__(
        self,
        project_repo: ProjectRepository,
        library_repo: LibraryRepository,
    ) -> None:
        self.project_repo = project_repo
        self.library_repo = library_repo

    # --- 1. Capability Inspection & Compatibility ---

    def get_character_capabilities(self, character_id: str) -> CharacterRigCapabilities:
        char = self.library_repo.get_character(character_id)
        if not char:
            raise FileNotFoundError(f"Character not found: {character_id}")
        return inspect_character_capabilities(char)

    def check_preset_for_character(
        self, preset_id: str, character_id: str
    ) -> MotionCompatibilityResult:
        preset = self.library_repo.get_motion_preset(preset_id)
        if not preset:
            raise FileNotFoundError(f"Motion preset not found: {preset_id}")
        char = self.library_repo.get_character(character_id)
        if not char:
            raise FileNotFoundError(f"Character not found: {character_id}")
        caps = inspect_character_capabilities(char)
        return check_preset_compatibility(preset, caps)

    # --- 2. Non-Destructive Motion Preview (ZERO mutation to project.db!) ---

    def preview_motion(
        self,
        project_id: str,
        req: MotionPreviewRequest,
    ) -> MotionPreviewResponse:
        project = self.project_repo.get_project_state(project_id)
        fps = project.timeline.fps or 30
        dur_hint = (
            req.camera_parameters.duration_ms
            if req.target_kind == "camera" and req.camera_parameters
            else req.parameters.duration_ms
        )
        scene, shot, win_start, win_end = _resolve_scene_and_window(
            project, req.scene_id, req.shot_id, req.start_time_ms, dur_hint
        )

        if req.target_kind == "camera":
            cam_params = req.camera_parameters or CameraMotionParameters(
                duration_ms=max(250, win_end - win_start)
            )
            cam_track = _ensure_timeline_track(project, "camera", "Camera")
            follow_kfs: list[Keyframe] | None = None
            follow_bx: float | None = None
            follow_by: float | None = None
            if cam_params.follow_instance_id:
                follow_kfs = [
                    k
                    for k in project.timeline.keyframes
                    if k.target_type == "character_instance"
                    and k.target_id == cam_params.follow_instance_id
                    and win_start <= k.time_ms <= win_end
                ]
                try:
                    _, ftf = _resolve_instance_and_transform(scene, shot, cam_params.follow_instance_id)
                    follow_bx, follow_by = ftf.x, ftf.y
                except FileNotFoundError:
                    pass

            kfs, support, ok, warns, unsup = generate_camera_motion_keyframes(
                motion_id=f"preview_cam_{scene.scene_id}_{shot.shot_id if shot else 'scene'}",
                cam_params=cam_params,
                camera_track_id=cam_track.track_id,
                shot_start_ms=win_start,
                shot_end_ms=win_end,
                fps=fps,
                stage_width=project.meta.width,
                stage_height=project.meta.height,
                follow_character_kfs=follow_kfs,
                follow_base_x=follow_bx,
                follow_base_y=follow_by,
            )
            return MotionPreviewResponse(
                compatible=ok,
                support_level=support,
                start_ms=win_start,
                end_ms=win_end,
                keyframes=kfs,
                animation_clips=[],
                warnings=warns,
                errors=[unsup] if unsup and not ok else [],
                sync_summary=(
                    f"Camera {cam_params.movement} ({len(kfs)} keyframes) synchronized across {win_start}ms..{win_end}ms."
                    if ok
                    else unsup
                ),
            )

        # Character motion preview
        if not req.instance_id:
            return MotionPreviewResponse(
                compatible=False,
                support_level="unsupported",
                errors=["instance_id is required to preview character motion."],
            )
        if not req.preset_id:
            return MotionPreviewResponse(
                compatible=False,
                support_level="unsupported",
                errors=["preset_id is required to preview character motion."],
            )
        preset = self.library_repo.get_motion_preset(req.preset_id)
        if not preset:
            raise FileNotFoundError(f"Motion preset not found: {req.preset_id}")

        inst, base_tf = _resolve_instance_and_transform(scene, shot, req.instance_id)
        char = self.library_repo.get_character(inst.character_id)
        caps = inspect_character_capabilities(char)
        compat = check_preset_compatibility(preset, caps)
        param_errors = validate_motion_parameters(req.parameters, preset)

        if param_errors:
            return MotionPreviewResponse(
                compatible=False,
                support_level="unsupported",
                compatibility=compat,
                start_ms=win_start,
                end_ms=win_end,
                errors=param_errors,
            )

        if not compat.compatible or char is None:
            return MotionPreviewResponse(
                compatible=False,
                support_level="unsupported",
                compatibility=compat,
                start_ms=win_start,
                end_ms=win_end,
                warnings=compat.warnings,
                errors=compat.warnings or ["Character rig does not support this motion preset."],
            )

        char_track = _ensure_timeline_track(project, "character", inst.display_name, inst.instance_id)
        kfs, clips, gen_warns = generate_character_motion_keyframes(
            motion_id=f"preview_{preset.preset_id}_{inst.instance_id}",
            preset=preset,
            character=char,
            caps=caps,
            instance_id=inst.instance_id,
            track_id=char_track.track_id,
            base_transform=base_tf,
            params=req.parameters,
            shot_start_ms=win_start,
            shot_end_ms=win_end,
            fps=fps,
            stage_width=project.meta.width,
            stage_height=project.meta.height,
        )

        all_warnings = [*compat.warnings, *gen_warns]
        sync_note = f"{preset.name} on '{inst.display_name}' ({len(kfs)} keyframes)."

        if req.sync_camera_follow:
            cam_track = _ensure_timeline_track(project, "camera", "Camera")
            cam_base = shot.camera_default if shot else scene.camera_default
            cam_kfs, _, cam_ok, cam_warns, _ = generate_camera_motion_keyframes(
                motion_id=f"preview_follow_{inst.instance_id}",
                cam_params=CameraMotionParameters(
                    movement="camera_follow",
                    start_x=cam_base.x,
                    start_y=cam_base.y,
                    start_zoom=cam_base.zoom,
                    start_rotation_deg=cam_base.rotation_deg,
                    end_x=cam_base.x,
                    end_y=cam_base.y,
                    end_zoom=cam_base.zoom,
                    end_rotation_deg=cam_base.rotation_deg,
                    duration_ms=max(250, win_end - win_start),
                    follow_instance_id=inst.instance_id,
                ),
                camera_track_id=cam_track.track_id,
                shot_start_ms=win_start,
                shot_end_ms=win_end,
                fps=fps,
                stage_width=project.meta.width,
                stage_height=project.meta.height,
                follow_character_kfs=kfs,
                follow_base_x=base_tf.x,
                follow_base_y=base_tf.y,
            )
            if cam_ok:
                kfs.extend(cam_kfs)
                all_warnings.extend(cam_warns)
                sync_note += f" + synchronized camera_follow ({len(cam_kfs)} camera keyframes)."

        return MotionPreviewResponse(
            compatible=True,
            support_level=compat.support_level,
            compatibility=compat,
            start_ms=win_start,
            end_ms=win_end,
            keyframes=kfs,
            animation_clips=clips,
            warnings=all_warnings,
            sync_summary=sync_note,
        )

    # --- 3. Validated Single Motion Apply (Real Persistent Keyframes!) ---

    @holds_project_lock
    def apply_motion(
        self,
        project_id: str,
        req: MotionApplyRequest,
    ) -> MotionApplyResponse:
        original = self.project_repo.get_project_state(project_id)
        draft = original.model_copy(deep=True)
        fps = draft.timeline.fps or 30
        dur_hint = (
            req.camera_parameters.duration_ms
            if req.target_kind == "camera" and req.camera_parameters
            else req.parameters.duration_ms
        )
        scene, shot, win_start, win_end = _resolve_scene_and_window(
            draft, req.scene_id, req.shot_id, req.start_time_ms, dur_hint
        )

        if req.target_kind == "camera":
            cam_params = req.camera_parameters or CameraMotionParameters(
                duration_ms=max(250, win_end - win_start)
            )
            motion_id = req.motion_id or stable_anim_id(
                "mot_cam", scene.scene_id, shot.shot_id if shot else "scene"
            )
            old_rec = (
                next((m for m in shot.applied_motions if m.motion_id == motion_id), None)
                if shot
                else None
            )
            cam_track = _ensure_timeline_track(draft, "camera", "Camera")

            follow_kfs: list[Keyframe] | None = None
            follow_bx: float | None = None
            follow_by: float | None = None
            if cam_params.follow_instance_id:
                follow_kfs = [
                    k
                    for k in draft.timeline.keyframes
                    if k.target_type == "character_instance"
                    and k.target_id == cam_params.follow_instance_id
                    and win_start <= k.time_ms <= win_end
                ]
                try:
                    _, ftf = _resolve_instance_and_transform(scene, shot, cam_params.follow_instance_id)
                    follow_bx, follow_by = ftf.x, ftf.y
                except FileNotFoundError:
                    pass

            kfs, support, ok, warns, unsup = generate_camera_motion_keyframes(
                motion_id=motion_id,
                cam_params=cam_params,
                camera_track_id=cam_track.track_id,
                shot_start_ms=win_start,
                shot_end_ms=win_end,
                fps=fps,
                stage_width=draft.meta.width,
                stage_height=draft.meta.height,
                follow_character_kfs=follow_kfs,
                follow_base_x=follow_bx,
                follow_base_y=follow_by,
            )
            if not ok:
                return MotionApplyResponse(
                    applied=False,
                    support_level="unsupported",
                    errors=[unsup or "Camera movement is not supported."],
                )

            # Also clear prior Phase 07 Batch 1 static camera keyframes for this shot to prevent conflicts
            extra_cam_kfs: set[str] = set()
            if shot:
                shot_ref_set = set(shot.animation_refs)
                extra_cam_kfs = {
                    k.keyframe_id
                    for k in draft.timeline.keyframes
                    if k.keyframe_id in shot_ref_set and k.target_type == "camera"
                }

            _strip_motion_owned_items(draft, shot, motion_id, old_rec, extra_kf_ids=extra_cam_kfs)
            _upsert_keyframes_dedup(draft, kfs)

            rec = GeneratedMotionRecord(
                motion_id=motion_id,
                preset_id=f"camera_{cam_params.movement}",
                preset_name=f"Camera: {cam_params.movement}",
                category="camera",
                target_kind="camera",
                camera_parameters=cam_params,
                start_ms=win_start,
                end_ms=win_end,
                keyframe_ids=[k.keyframe_id for k in kfs],
                clip_ids=[],
                support_level=support,
                warnings=warns,
                user_modified=True,
                applied_at=utc_now_iso(),
            )
            if shot:
                shot.animation_refs = list(dict.fromkeys([*shot.animation_refs, *rec.keyframe_ids]))
                shot.applied_motions.append(rec)
                shot.updated_at = utc_now_iso()

            saved = self.project_repo.save_project_state(draft)
            return MotionApplyResponse(
                applied=True,
                support_level=support,
                camera_motion_record=rec,
                keyframes_written=len(kfs),
                clips_written=0,
                warnings=warns,
                updated_project=saved.model_dump(mode="json"),
            )

        # Character motion apply
        if not req.instance_id or not req.preset_id:
            return MotionApplyResponse(
                applied=False,
                support_level="unsupported",
                errors=["Both instance_id and preset_id are required."],
            )
        preset = self.library_repo.get_motion_preset(req.preset_id)
        if not preset:
            raise FileNotFoundError(f"Motion preset not found: {req.preset_id}")

        inst, base_tf = _resolve_instance_and_transform(scene, shot, req.instance_id)
        char = self.library_repo.get_character(inst.character_id)
        caps = inspect_character_capabilities(char)
        compat = check_preset_compatibility(preset, caps)

        param_errors = validate_motion_parameters(req.parameters, preset)
        if param_errors:
            return MotionApplyResponse(
                applied=False,
                support_level="unsupported",
                errors=param_errors,
            )

        if not compat.compatible or char is None:
            return MotionApplyResponse(
                applied=False,
                support_level="unsupported",
                warnings=compat.warnings,
                errors=compat.warnings or ["Incompatible character rig — refused to apply silently."],
            )

        if compat.support_level == "partial" and not req.allow_partial:
            return MotionApplyResponse(
                applied=False,
                support_level="partial",
                warnings=compat.warnings,
                errors=["Preset is only partially supported by this rig and allow_partial=False."],
            )

        motion_id = req.motion_id or stable_anim_id(
            "mot_char",
            scene.scene_id,
            shot.shot_id if shot else f"t{win_start}",
            inst.instance_id,
            preset.preset_id,
        )
        old_rec = (
            next((m for m in shot.applied_motions if m.motion_id == motion_id), None)
            if shot
            else None
        )

        char_track = _ensure_timeline_track(draft, "character", inst.display_name, inst.instance_id)
        kfs, clips, gen_warns = generate_character_motion_keyframes(
            motion_id=motion_id,
            preset=preset,
            character=char,
            caps=caps,
            instance_id=inst.instance_id,
            track_id=char_track.track_id,
            base_transform=base_tf,
            params=req.parameters,
            shot_start_ms=win_start,
            shot_end_ms=win_end,
            fps=fps,
            stage_width=draft.meta.width,
            stage_height=draft.meta.height,
        )

        _strip_motion_owned_items(draft, shot, motion_id, old_rec)
        _upsert_keyframes_dedup(draft, kfs)
        _upsert_clips_dedup(draft, clips)

        all_warnings = [*compat.warnings, *gen_warns]
        rec = GeneratedMotionRecord(
            motion_id=motion_id,
            preset_id=preset.preset_id,
            preset_name=preset.name,
            category=preset.category,
            target_kind="character",
            instance_id=inst.instance_id,
            character_id=char.character_id,
            parameters=req.parameters,
            start_ms=win_start,
            end_ms=win_end,
            keyframe_ids=[k.keyframe_id for k in kfs],
            clip_ids=[c.clip_id for c in clips],
            support_level=compat.support_level,
            warnings=all_warnings,
            user_modified=True,
            applied_at=utc_now_iso(),
        )
        if shot:
            shot.animation_refs = list(dict.fromkeys([*shot.animation_refs, *rec.keyframe_ids]))
            shot.applied_motions.append(rec)
            shot.updated_at = utc_now_iso()

        cam_rec: GeneratedMotionRecord | None = None
        total_kfs = len(kfs)
        if req.sync_camera_follow:
            cam_motion_id = stable_anim_id(
                "mot_cam", scene.scene_id, shot.shot_id if shot else f"t{win_start}"
            )
            old_cam = (
                next((m for m in shot.applied_motions if m.motion_id == cam_motion_id), None)
                if shot
                else None
            )
            cam_track = _ensure_timeline_track(draft, "camera", "Camera")
            cam_base = shot.camera_default if shot else scene.camera_default
            cam_params = CameraMotionParameters(
                movement="camera_follow",
                start_x=cam_base.x,
                start_y=cam_base.y,
                start_zoom=cam_base.zoom,
                start_rotation_deg=cam_base.rotation_deg,
                end_x=cam_base.x,
                end_y=cam_base.y,
                end_zoom=cam_base.zoom,
                end_rotation_deg=cam_base.rotation_deg,
                duration_ms=max(250, win_end - win_start),
                follow_instance_id=inst.instance_id,
            )
            cam_kfs, cam_sup, cam_ok, cam_warns, _ = generate_camera_motion_keyframes(
                motion_id=cam_motion_id,
                cam_params=cam_params,
                camera_track_id=cam_track.track_id,
                shot_start_ms=win_start,
                shot_end_ms=win_end,
                fps=fps,
                stage_width=draft.meta.width,
                stage_height=draft.meta.height,
                follow_character_kfs=kfs,
                follow_base_x=base_tf.x,
                follow_base_y=base_tf.y,
            )
            if cam_ok:
                extra_cam_kfs: set[str] = set()
                if shot:
                    shot_ref_set = set(shot.animation_refs)
                    extra_cam_kfs = {
                        k.keyframe_id
                        for k in draft.timeline.keyframes
                        if k.keyframe_id in shot_ref_set and k.target_type == "camera"
                    }
                _strip_motion_owned_items(draft, shot, cam_motion_id, old_cam, extra_kf_ids=extra_cam_kfs)
                _upsert_keyframes_dedup(draft, cam_kfs)
                cam_rec = GeneratedMotionRecord(
                    motion_id=cam_motion_id,
                    preset_id="camera_camera_follow",
                    preset_name="Camera: camera_follow",
                    category="camera",
                    target_kind="camera",
                    instance_id=inst.instance_id,
                    camera_parameters=cam_params,
                    start_ms=win_start,
                    end_ms=win_end,
                    keyframe_ids=[k.keyframe_id for k in cam_kfs],
                    clip_ids=[],
                    support_level=cam_sup,
                    warnings=cam_warns,
                    user_modified=False,
                    applied_at=utc_now_iso(),
                )
                if shot:
                    shot.animation_refs = list(dict.fromkeys([*shot.animation_refs, *cam_rec.keyframe_ids]))
                    shot.applied_motions.append(cam_rec)
                total_kfs += len(cam_kfs)
                all_warnings.extend(cam_warns)

        saved = self.project_repo.save_project_state(draft)
        return MotionApplyResponse(
            applied=True,
            support_level=compat.support_level,
            motion_record=rec,
            camera_motion_record=cam_rec,
            keyframes_written=total_kfs,
            clips_written=len(clips),
            warnings=all_warnings,
            updated_project=saved.model_dump(mode="json"),
        )

    # --- 4. Production Plan -> Full Shot Character & Camera Animation Execution ---

    @holds_project_lock
    def execute_shots(
        self,
        project_id: str,
        req: ShotAnimationExecuteRequest,
        *,
        _inject_failure_after_shot: int | None = None,
    ) -> ShotAnimationExecuteResponse:
        original = self.project_repo.get_project_state(project_id)
        draft = original.model_copy(deep=True)
        plan = draft.production_plan
        if not plan or not plan.shots:
            return ShotAnimationExecuteResponse(
                project_id=project_id,
                dry_run=req.dry_run,
                status="no_changes",
                warnings=["No Production Plan shots available for animation execution."],
            )

        all_presets = self.library_repo.list_motion_presets()
        presets_by_id = {p.preset_id: p for p in all_presets}
        chars_by_id: dict[str, Character] = {
            c.character_id: c for c in self.library_repo.list_characters()
        }
        prod_by_id: dict[str, ProductionShotPlan] = {
            s.production_shot_id: s for s in plan.shots
        }

        # Collect targeted assembled (Scene, SceneShot) pairs cleanly without modifying unrelated shots
        targets: list[tuple[Scene, SceneShot, ProductionShotPlan]] = []
        for sc in draft.scenes:
            if req.scene_ids and sc.scene_id not in req.scene_ids and (
                not sc.execution_meta or sc.execution_meta.source_scene_id not in req.scene_ids
            ):
                continue
            for sh in sorted(sc.shots, key=lambda x: (x.shot_order, x.start_ms)):
                if req.shot_ids and sh.shot_id not in req.shot_ids:
                    continue
                if req.production_shot_ids and sh.production_shot_id not in req.production_shot_ids:
                    continue
                pshot = prod_by_id.get(sh.production_shot_id or "")
                if not pshot:
                    continue
                targets.append((sc, sh, pshot))

        if not targets:
            return ShotAnimationExecuteResponse(
                project_id=project_id,
                dry_run=req.dry_run,
                status="no_changes",
                warnings=[
                    "No assembled Scene Shots matched the selected scope. Run Scene Assembly (Batch 1) first."
                ],
            )

        res = ShotAnimationExecuteResponse(
            project_id=project_id,
            dry_run=req.dry_run,
            status="no_changes",
        )
        fps = draft.timeline.fps or 30
        regen_set = set(req.regenerate_motion_ids)
        now_iso = utc_now_iso()

        try:
            for idx_shot, (sc, sh, pshot) in enumerate(targets):
                shot_abs_start = sc.start_ms + sh.start_ms
                shot_abs_end = shot_abs_start + sh.duration_ms
                outcome = ShotAnimationExecutionOutcome(
                    shot_id=sh.shot_id,
                    scene_id=sc.scene_id,
                    production_shot_id=pshot.production_shot_id,
                    shot_order=sh.shot_order,
                    title=sh.title,
                    start_ms=shot_abs_start,
                    end_ms=shot_abs_end,
                    status="preview" if req.dry_run else "executed",
                )

                # Track generated character root trajectories for Camera Follow / Tracking sync!
                generated_char_kfs_by_inst: dict[str, list[Keyframe]] = {}
                primary_moving_inst_id: str | None = None
                primary_moving_tf: Transform2D | None = None

                # --- A. Character Motion Execution ---
                if req.include_character_motion:
                    for ap in pshot.animation_plans:
                        # Resolve staged character instance inside this exact SceneShot
                        staged_char = next(
                            (
                                c
                                for c in sh.character_states
                                if (ap.library_character_id and c.character_id == ap.library_character_id)
                                or (
                                    ap.character_name
                                    and c.display_name.lower() == ap.character_name.lower()
                                )
                            ),
                            None,
                        )
                        if not staged_char:
                            res.actions_unsupported += 1
                            outcome.actions.append(
                                ActionMappingReport(
                                    action_plan_id=ap.action_plan_id,
                                    character_name=ap.character_name,
                                    category=ap.category,
                                    description=ap.description,
                                    support_level="unsupported",
                                    executable=False,
                                    unsupported_reason=f"Character '{ap.character_name}' is not assembled in this shot.",
                                    manual_alternative="Assemble the character into this shot via Scene Execution first.",
                                )
                            )
                            continue

                        char = chars_by_id.get(staged_char.character_id)
                        caps = inspect_character_capabilities(char)
                        preset, unsup_reason, manual_alt = resolve_action_to_preset(
                            ap.category,
                            presets_by_id,
                            all_presets,
                            preferred_preset_id=ap.mapped_preset_id,
                            character=char,
                        )
                        if not preset:
                            res.actions_unsupported += 1
                            outcome.actions.append(
                                ActionMappingReport(
                                    action_plan_id=ap.action_plan_id,
                                    character_name=staged_char.display_name,
                                    instance_id=staged_char.instance_id,
                                    character_id=staged_char.character_id,
                                    category=ap.category,
                                    description=ap.description,
                                    support_level="unsupported",
                                    executable=False,
                                    unsupported_reason=unsup_reason,
                                    manual_alternative=manual_alt,
                                )
                            )
                            continue

                        compat = check_preset_compatibility(preset, caps)
                        if not compat.compatible or char is None or (
                            compat.support_level == "partial" and not req.allow_partial
                        ):
                            res.actions_unsupported += 1
                            outcome.actions.append(
                                ActionMappingReport(
                                    action_plan_id=ap.action_plan_id,
                                    character_name=staged_char.display_name,
                                    instance_id=staged_char.instance_id,
                                    character_id=staged_char.character_id,
                                    category=ap.category,
                                    description=ap.description,
                                    mapped_preset_id=preset.preset_id,
                                    mapped_preset_name=preset.name,
                                    support_level=compat.support_level,
                                    executable=False,
                                    missing_capabilities=compat.missing_capabilities,
                                    warnings=compat.warnings,
                                    unsupported_reason=(
                                        compat.warnings[0]
                                        if compat.warnings
                                        else f"Rig lacks required capabilities for '{preset.name}'."
                                    ),
                                    manual_alternative="Add missing rig parts/variants in Cutout Rig Editor or keyframe manually.",
                                )
                            )
                            continue

                        motion_id = stable_anim_id(
                            "mot_plan", sh.shot_id, ap.action_plan_id, staged_char.instance_id
                        )
                        existing_rec = next(
                            (
                                m
                                for m in sh.applied_motions
                                if m.motion_id == motion_id
                                or (
                                    m.source_action_plan_id == ap.action_plan_id
                                    and m.instance_id == staged_char.instance_id
                                )
                            ),
                            None,
                        )

                        # Preserve user-edited motion unless explicitly selected for regeneration!
                        if (
                            existing_rec
                            and existing_rec.user_modified
                            and req.preserve_user_modified
                            and existing_rec.motion_id not in regen_set
                        ):
                            res.actions_skipped_user_edited += 1
                            existing_kfs = [
                                k
                                for k in draft.timeline.keyframes
                                if k.keyframe_id in set(existing_rec.keyframe_ids)
                            ]
                            generated_char_kfs_by_inst[staged_char.instance_id] = existing_kfs
                            outcome.actions.append(
                                ActionMappingReport(
                                    action_plan_id=ap.action_plan_id,
                                    character_name=staged_char.display_name,
                                    instance_id=staged_char.instance_id,
                                    character_id=staged_char.character_id,
                                    category=ap.category,
                                    description=ap.description,
                                    mapped_preset_id=existing_rec.preset_id,
                                    mapped_preset_name=existing_rec.preset_name,
                                    support_level=existing_rec.support_level,
                                    executable=True,
                                    skipped_user_modified=True,
                                    keyframes_count=len(existing_rec.keyframe_ids),
                                    warnings=["Preserved user-modified motion (select Regenerate to overwrite)."],
                                )
                            )
                            continue

                        params = _action_to_motion_params(
                            ap, preset, sh.duration_ms, staging_facing=staged_char.facing_direction
                        )
                        char_track = _ensure_timeline_track(
                            draft, "character", staged_char.display_name, staged_char.instance_id
                        )
                        kfs, clips, gen_warns = generate_character_motion_keyframes(
                            motion_id=motion_id,
                            preset=preset,
                            character=char,
                            caps=caps,
                            instance_id=staged_char.instance_id,
                            track_id=char_track.track_id,
                            base_transform=staged_char.transform,
                            params=params,
                            shot_start_ms=shot_abs_start,
                            shot_end_ms=shot_abs_end,
                            fps=fps,
                            stage_width=draft.meta.width,
                            stage_height=draft.meta.height,
                        )

                        generated_char_kfs_by_inst[staged_char.instance_id] = kfs
                        if ap.category in ("walk", "run", "jump", "fall") and primary_moving_inst_id is None:
                            primary_moving_inst_id = staged_char.instance_id
                            primary_moving_tf = staged_char.transform
                        elif primary_moving_inst_id is None:
                            primary_moving_inst_id = staged_char.instance_id
                            primary_moving_tf = staged_char.transform

                        if not req.dry_run:
                            _strip_motion_owned_items(draft, sh, motion_id, existing_rec)
                            _upsert_keyframes_dedup(draft, kfs)
                            _upsert_clips_dedup(draft, clips)
                            rec = GeneratedMotionRecord(
                                motion_id=motion_id,
                                source_action_plan_id=ap.action_plan_id,
                                preset_id=preset.preset_id,
                                preset_name=preset.name,
                                category=preset.category,
                                target_kind="character",
                                instance_id=staged_char.instance_id,
                                character_id=char.character_id,
                                parameters=params,
                                start_ms=shot_abs_start,
                                end_ms=shot_abs_end,
                                keyframe_ids=[k.keyframe_id for k in kfs],
                                clip_ids=[c.clip_id for c in clips],
                                support_level=compat.support_level,
                                warnings=[*compat.warnings, *gen_warns],
                                user_modified=False,
                                applied_at=now_iso,
                            )
                            sh.animation_refs = list(
                                dict.fromkeys([*sh.animation_refs, *rec.keyframe_ids])
                            )
                            sh.applied_motions.append(rec)

                        res.actions_executed += 1
                        outcome.keyframes_generated += len(kfs)
                        outcome.clips_generated += len(clips)
                        res.total_keyframes_written += len(kfs)
                        res.total_clips_written += len(clips)
                        outcome.actions.append(
                            ActionMappingReport(
                                action_plan_id=ap.action_plan_id,
                                character_name=staged_char.display_name,
                                instance_id=staged_char.instance_id,
                                character_id=staged_char.character_id,
                                category=ap.category,
                                description=ap.description,
                                mapped_preset_id=preset.preset_id,
                                mapped_preset_name=preset.name,
                                support_level=compat.support_level,
                                executable=True,
                                keyframes_count=len(kfs),
                                warnings=[*compat.warnings, *gen_warns],
                            )
                        )

                # --- B. Camera Motion Execution & Character Synchronization ---
                if req.include_camera_motion:
                    cp = pshot.camera_plan
                    cam_motion_id = stable_anim_id("mot_cam", sc.scene_id, sh.shot_id)
                    existing_cam = next(
                        (m for m in sh.applied_motions if m.motion_id == cam_motion_id),
                        None,
                    )

                    if (
                        existing_cam
                        and existing_cam.user_modified
                        and req.preserve_user_modified
                        and existing_cam.motion_id not in regen_set
                    ):
                        outcome.camera = CameraExecutionReport(
                            movement=cp.camera_movement,
                            support_level=existing_cam.support_level,
                            executable=True,
                            skipped_user_modified=True,
                            keyframes_count=len(existing_cam.keyframe_ids),
                            warnings=["Preserved user-modified camera motion."],
                        )
                    else:
                        support_lvl, cam_exec, unsup_note = evaluate_camera_execution_support(
                            cp.camera_movement
                        )
                        if not cam_exec:
                            res.cameras_unsupported += 1
                            outcome.camera = CameraExecutionReport(
                                movement=cp.camera_movement,
                                support_level="unsupported",
                                executable=False,
                                unsupported_reason=unsup_note,
                            )
                            outcome.warnings.append(unsup_note)
                        else:
                            follow_inst: str | None = None
                            follow_kfs: list[Keyframe] | None = None
                            follow_bx: float | None = None
                            follow_by: float | None = None
                            if (
                                req.sync_camera_with_character
                                and cp.camera_movement in ("tracking", "camera_follow")
                                and primary_moving_inst_id
                            ):
                                follow_inst = primary_moving_inst_id
                                follow_kfs = generated_char_kfs_by_inst.get(primary_moving_inst_id)
                                if primary_moving_tf:
                                    follow_bx = primary_moving_tf.x
                                    follow_by = primary_moving_tf.y
                                outcome.sync_notes.append(
                                    f"Synchronized camera '{cp.camera_movement}' with character instance '{follow_inst}' over {sh.duration_ms}ms."
                                )

                            cam_params = CameraMotionParameters(
                                movement=cp.camera_movement,
                                start_x=cp.camera_plan.start_x,
                                start_y=cp.camera_plan.start_y,
                                start_zoom=cp.camera_plan.start_zoom,
                                start_rotation_deg=cp.camera_plan.start_rotation_deg,
                                end_x=cp.camera_plan.end_x,
                                end_y=cp.camera_plan.end_y,
                                end_zoom=cp.camera_plan.end_zoom,
                                end_rotation_deg=cp.camera_plan.end_rotation_deg,
                                duration_ms=sh.duration_ms,
                                easing=cp.camera_plan.easing,
                                follow_instance_id=follow_inst,
                            )
                            cam_track = _ensure_timeline_track(draft, "camera", "Camera")
                            cam_kfs, cam_sup, cam_ok, cam_warns, cam_unsup = generate_camera_motion_keyframes(
                                motion_id=cam_motion_id,
                                cam_params=cam_params,
                                camera_track_id=cam_track.track_id,
                                shot_start_ms=shot_abs_start,
                                shot_end_ms=shot_abs_end,
                                fps=fps,
                                stage_width=draft.meta.width,
                                stage_height=draft.meta.height,
                                follow_character_kfs=follow_kfs,
                                follow_base_x=follow_bx,
                                follow_base_y=follow_by,
                            )
                            if cam_ok:
                                if not req.dry_run:
                                    shot_ref_set = set(sh.animation_refs)
                                    extra_cam_kfs = {
                                        k.keyframe_id
                                        for k in draft.timeline.keyframes
                                        if k.keyframe_id in shot_ref_set
                                        and k.target_type == "camera"
                                    }
                                    _strip_motion_owned_items(
                                        draft, sh, cam_motion_id, existing_cam, extra_kf_ids=extra_cam_kfs
                                    )
                                    _upsert_keyframes_dedup(draft, cam_kfs)
                                    cam_rec = GeneratedMotionRecord(
                                        motion_id=cam_motion_id,
                                        preset_id=f"camera_{cp.camera_movement}",
                                        preset_name=f"Camera: {cp.camera_movement}",
                                        category="camera",
                                        target_kind="camera",
                                        instance_id=follow_inst,
                                        camera_parameters=cam_params,
                                        start_ms=shot_abs_start,
                                        end_ms=shot_abs_end,
                                        keyframe_ids=[k.keyframe_id for k in cam_kfs],
                                        clip_ids=[],
                                        support_level=cam_sup,
                                        warnings=cam_warns,
                                        user_modified=False,
                                        applied_at=now_iso,
                                    )
                                    sh.animation_refs = list(
                                        dict.fromkeys([*sh.animation_refs, *cam_rec.keyframe_ids])
                                    )
                                    sh.applied_motions.append(cam_rec)

                                res.cameras_executed += 1
                                outcome.keyframes_generated += len(cam_kfs)
                                res.total_keyframes_written += len(cam_kfs)
                                outcome.camera = CameraExecutionReport(
                                    movement=cp.camera_movement,
                                    support_level=cam_sup,
                                    executable=True,
                                    synchronized_with_instance_id=follow_inst,
                                    keyframes_count=len(cam_kfs),
                                    warnings=cam_warns,
                                )
                            else:
                                res.cameras_unsupported += 1
                                outcome.camera = CameraExecutionReport(
                                    movement=cp.camera_movement,
                                    support_level="unsupported",
                                    executable=False,
                                    unsupported_reason=cam_unsup,
                                )

                # Update ProductionShotPlan applied status cleanly
                if not req.dry_run:
                    sh.updated_at = now_iso
                    pshot.timeline_refs.applied = True
                    pshot.timeline_refs.applied_at = now_iso
                    pshot.timeline_refs.stage_scene_id = sc.scene_id
                    pshot.timeline_refs.applied_start_ms = shot_abs_start
                    pshot.timeline_refs.applied_end_ms = shot_abs_end
                    existing_exec_kfs = [
                        kid for kid in pshot.timeline_refs.keyframe_ids if kid.startswith("kf_exec_")
                    ]
                    pshot.timeline_refs.keyframe_ids = list(
                        dict.fromkeys([*existing_exec_kfs, *sh.animation_refs])
                    )
                    pshot.timeline_refs.animation_clip_ids = list(
                        dict.fromkeys([cid for m in sh.applied_motions for cid in m.clip_ids])
                    )

                has_unsup = any(not a.executable for a in outcome.actions) or (
                    outcome.camera is not None and not outcome.camera.executable
                )
                if not req.dry_run:
                    outcome.status = "partial" if has_unsup else "executed"
                res.outcomes.append(outcome)
                res.shots_processed += 1

                if _inject_failure_after_shot is not None and (idx_shot + 1) >= _inject_failure_after_shot:
                    raise RuntimeError("Injected animation execution error for transactional rollback verification.")

            if req.dry_run:
                res.status = "partial" if (res.actions_unsupported > 0 or res.cameras_unsupported > 0) else "completed"
                return res

            plan.updated_at = now_iso
            saved = self.project_repo.save_project_state(draft)
            res.status = (
                "partial"
                if (res.actions_unsupported > 0 or res.cameras_unsupported > 0)
                else ("completed" if res.total_keyframes_written > 0 else "no_changes")
            )
            res.updated_project = saved.model_dump(mode="json")
            return res

        except Exception as exc:
            logger.exception("Animation execution failed; rolling back transaction cleanly.")
            return ShotAnimationExecuteResponse(
                project_id=project_id,
                dry_run=req.dry_run,
                status="rolled_back",
                errors=[f"Animation execution rolled back cleanly: {exc}"],
                updated_project=original.model_dump(mode="json"),
            )
