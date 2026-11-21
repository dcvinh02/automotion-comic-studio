"""Master Timeline & Animation integrity validation (Module 06)."""

from __future__ import annotations

from schemas.project import ProjectState
from schemas.quality import QCIssue


def validate_timeline_integrity(state: ProjectState) -> list[QCIssue]:
    issues: list[QCIssue] = []
    timeline = state.timeline

    if timeline.total_duration_ms <= 0:
        issues.append(
            QCIssue(
                code="TIMELINE_ZERO_DURATION",
                severity="critical",
                category="timeline_integrity",
                message="Master Timeline total_duration_ms must be greater than 0.",
            )
        )

    if not state.scenes:
        issues.append(
            QCIssue(
                code="NO_SCENES",
                severity="critical",
                category="timeline_integrity",
                message="Project must have at least one scene before exporting.",
            )
        )

    track_ids = {t.track_id for t in timeline.tracks}

    for scene in state.scenes:
        if scene.duration_ms <= 0:
            issues.append(
                QCIssue(
                    code="SCENE_INVALID_DURATION",
                    severity="critical",
                    category="timeline_integrity",
                    scene_id=scene.scene_id,
                    time_ms=scene.start_ms,
                    message=f"Scene '{scene.name}' has invalid duration ({scene.duration_ms}ms).",
                )
            )
        if scene.start_ms < 0:
            issues.append(
                QCIssue(
                    code="SCENE_NEGATIVE_START",
                    severity="critical",
                    category="timeline_integrity",
                    scene_id=scene.scene_id,
                    message=f"Scene '{scene.name}' has negative start_ms.",
                )
            )

    for kf in timeline.keyframes:
        if kf.track_id not in track_ids:
            issues.append(
                QCIssue(
                    code="KEYFRAME_ORPHAN_TRACK",
                    severity="warning",
                    category="timeline_integrity",
                    time_ms=kf.time_ms,
                    ref_id=kf.keyframe_id,
                    message=f"Keyframe {kf.keyframe_id} references unknown track {kf.track_id}.",
                )
            )
        if kf.time_ms > timeline.total_duration_ms:
            issues.append(
                QCIssue(
                    code="KEYFRAME_OUT_OF_RANGE",
                    severity="warning",
                    category="timeline_integrity",
                    time_ms=kf.time_ms,
                    ref_id=kf.keyframe_id,
                    message=f"Keyframe at {kf.time_ms}ms exceeds timeline duration ({timeline.total_duration_ms}ms).",
                )
            )

    for clip in timeline.animation_clips:
        if clip.end_ms <= clip.start_ms:
            issues.append(
                QCIssue(
                    code="ANIM_CLIP_INVALID_BOUNDS",
                    severity="critical",
                    category="timeline_integrity",
                    time_ms=clip.start_ms,
                    ref_id=clip.clip_id,
                    message=f"Animation clip {clip.clip_id} has end_ms ({clip.end_ms}) <= start_ms ({clip.start_ms}).",
                )
            )

    for ev in timeline.sound_events:
        if ev.end_ms <= ev.start_ms:
            issues.append(
                QCIssue(
                    code="SFX_EVENT_INVALID_BOUNDS",
                    severity="critical",
                    category="timeline_integrity",
                    time_ms=ev.start_ms,
                    ref_id=ev.event_id,
                    message=f"SFX event {ev.event_id} has end_ms ({ev.end_ms}) <= start_ms ({ev.start_ms}).",
                )
            )

    return issues
