"""Quality Control Engine (Spec v2.0 Section 7 & Module 08)."""

from __future__ import annotations

import copy

from pathlib import Path

from app.config import AppConfig
from core.animation_engine.validator import validate_timeline_integrity
from core.asset_engine.service import AssetService
from core.quality_engine.lookup_cache import RunScopedFiles, RunScopedLibrary
from core.quality_engine.production_qc import apply_qc_fix, run_production_qc
from core.sound_engine.service import SoundService
from database.library_repo import LibraryRepository
from schemas.production_queue import (
    ProductionQCFixRequest,
    ProductionQCReport,
    ProductionQueueDocument,
)
from schemas.project import ProjectState
from schemas.quality import QCIssue, QCReport
from utils.ffmpeg import FFmpegLocator, ffprobe_json


class QualityControlEngine:
    def __init__(
        self,
        config: AppConfig,
        library_repo: LibraryRepository,
        asset_service: AssetService,
        sound_service: SoundService,
    ) -> None:
        self.config = config
        self.library_repo = library_repo
        self.asset_service = asset_service
        self.sound_service = sound_service

    def run_preflight(self, state: ProjectState) -> QCReport:
        # Phase 09.2: memoize library lookups for this run only (was one SQLite connection per reference)
        # A per-run shallow copy keeps the shared engine untouched (safe under concurrent requests).
        runner = copy.copy(self)
        runner.library_repo = RunScopedLibrary(self.library_repo)  # type: ignore[assignment]
        runner.asset_service = RunScopedFiles(self.asset_service)  # type: ignore[assignment]
        runner.sound_service = RunScopedFiles(self.sound_service)  # type: ignore[assignment]
        return runner._run_preflight(state)

    def _run_preflight(self, state: ProjectState) -> QCReport:
        issues: list[QCIssue] = []

        # 1. Timeline integrity checks
        issues.extend(validate_timeline_integrity(state))

        # 2. Check scenes, backgrounds, props, characters & all referenced assets
        checked_assets: dict[str, bool] = {}

        def _check_asset(asset_id: str, context: str, scene_id: str | None = None) -> None:
            if asset_id in checked_assets:
                if not checked_assets[asset_id]:
                    issues.append(
                        QCIssue(
                            code="MISSING_ASSET",
                            severity="critical",
                            category="missing_asset",
                            scene_id=scene_id,
                            ref_id=asset_id,
                            message=f"Missing asset {asset_id} referenced by {context}.",
                        )
                    )
                return
            asset = self.library_repo.get_asset(asset_id)
            if not asset:
                checked_assets[asset_id] = False
                issues.append(
                    QCIssue(
                        code="MISSING_ASSET",
                        severity="critical",
                        category="missing_asset",
                        scene_id=scene_id,
                        ref_id=asset_id,
                        message=f"Asset {asset_id} not found in library (used by {context}).",
                    )
                )
                return
            try:
                file_path = self.asset_service.resolve_asset_file(asset)
                exists = file_path.is_file()
            except ValueError:
                exists = False
            checked_assets[asset_id] = exists
            if not exists:
                issues.append(
                    QCIssue(
                        code="MISSING_ASSET_FILE",
                        severity="critical",
                        category="missing_asset",
                        scene_id=scene_id,
                        ref_id=asset_id,
                        message=f"Asset file missing on disk for '{asset.name}' ({asset.file_path}).",
                    )
                )

        for scene in state.scenes:
            if scene.background_asset_id:
                _check_asset(
                    scene.background_asset_id,
                    f"background of scene '{scene.name}'",
                    scene.scene_id,
                )

            for prop in scene.props:
                if prop.asset_id:
                    _check_asset(prop.asset_id, f"prop '{prop.name}'", scene.scene_id)

            for inst in scene.characters:
                char = self.library_repo.get_character(inst.character_id)
                if not char:
                    issues.append(
                        QCIssue(
                            code="MISSING_CHARACTER",
                            severity="critical",
                            category="missing_asset",
                            scene_id=scene.scene_id,
                            ref_id=inst.character_id,
                            message=f"Character {inst.character_id} ('{inst.display_name}') not found in library.",
                        )
                    )
                    continue

                if not char.identity_confirmed:
                    issues.append(
                        QCIssue(
                            code="CHARACTER_IDENTITY_UNCONFIRMED",
                            severity="warning",
                            category="character_identity",
                            scene_id=scene.scene_id,
                            ref_id=char.character_id,
                            message=f"Character '{char.name}' identity has not been confirmed yet.",
                        )
                    )

                for part in char.parts:
                    if part.default_asset_id:
                        _check_asset(
                            part.default_asset_id,
                            f"part '{part.name}' of character '{char.name}'",
                            scene.scene_id,
                        )
                    for variant_key, v_asset_id in part.variants.items():
                        _check_asset(
                            v_asset_id,
                            f"variant '{variant_key}' of part '{part.name}' ({char.name})",
                            scene.scene_id,
                        )

        # 3. Check SFX events, files, licenses, and overlaps
        muted_track_ids = {t.track_id for t in state.timeline.tracks if t.muted}
        active_sfx = [
            ev for ev in state.timeline.sound_events if ev.track_id not in muted_track_ids
        ]
        for ev in active_sfx:
            sound = self.library_repo.get_sound(ev.sound_id)
            if not sound:
                issues.append(
                    QCIssue(
                        code="MISSING_SOUND",
                        severity="critical",
                        category="missing_sound",
                        time_ms=ev.start_ms,
                        ref_id=ev.sound_id,
                        message=f"Sound effect {ev.sound_id} referenced on timeline is missing from library.",
                    )
                )
                continue
            try:
                spath = self.sound_service.resolve_sound_file(sound)
                exists = spath.is_file()
            except ValueError:
                exists = False
            if not exists:
                issues.append(
                    QCIssue(
                        code="MISSING_SOUND_FILE",
                        severity="critical",
                        category="missing_sound",
                        time_ms=ev.start_ms,
                        ref_id=sound.sound_id,
                        message=f"Sound file missing on disk for '{sound.name}' ({sound.file_path}).",
                    )
                )
            if sound.license.usage != "verified":
                issues.append(
                    QCIssue(
                        code="UNVERIFIED_SOUND_LICENSE",
                        severity="warning",
                        category="sound_license",
                        time_ms=ev.start_ms,
                        ref_id=sound.sound_id,
                        message=f"Sound '{sound.name}' has unverified license status.",
                    )
                )

        for overlap in SoundService.detect_overlaps(active_sfx):
            issues.append(
                QCIssue(
                    code="SFX_OVERLAP",
                    severity="warning",
                    category="sound_overlap",
                    time_ms=overlap["time_ms"],
                    message=overlap["message"],
                )
            )

        # 4. Check FFmpeg availability
        if not FFmpegLocator.find_ffmpeg(self.config) or not FFmpegLocator.find_ffprobe(
            self.config
        ):
            issues.append(
                QCIssue(
                    code="FFMPEG_NOT_AVAILABLE",
                    severity="critical",
                    category="render_integrity",
                    message="FFmpeg / FFprobe binary was not found. Install FFmpeg before exporting.",
                )
            )

        critical_count = sum(1 for i in issues if i.severity == "critical")
        warning_count = sum(1 for i in issues if i.severity == "warning")
        return QCReport(
            project_id=state.meta.project_id,
            passed=critical_count == 0,
            critical_count=critical_count,
            warning_count=warning_count,
            issues=issues,
        )

    def verify_exported_mp4(
        self,
        output_path: Path,
        expected_duration_ms: int,
        expected_width: int,
        expected_height: int,
    ) -> list[QCIssue]:
        issues: list[QCIssue] = []
        if not output_path.is_file() or output_path.stat().st_size == 0:
            issues.append(
                QCIssue(
                    code="CORRUPTED_OUTPUT",
                    severity="critical",
                    category="render_integrity",
                    message=f"Output MP4 does not exist or is empty: {output_path.name}",
                )
            )
            return issues

        ffprobe = FFmpegLocator.find_ffprobe(self.config)
        if not ffprobe:
            return issues

        try:
            info = ffprobe_json(ffprobe, output_path)
        except Exception as exc:
            issues.append(
                QCIssue(
                    code="INVALID_VIDEO_STREAM",
                    severity="critical",
                    category="render_integrity",
                    message=f"ffprobe could not read output MP4: {exc}",
                )
            )
            return issues

        video_streams = [
            s for s in info.get("streams", []) if s.get("codec_type") == "video"
        ]
        audio_streams = [
            s for s in info.get("streams", []) if s.get("codec_type") == "audio"
        ]
        if not video_streams:
            issues.append(
                QCIssue(
                    code="MISSING_VIDEO_STREAM",
                    severity="critical",
                    category="render_integrity",
                    message="Exported MP4 contains no video stream.",
                )
            )
            return issues

        vs = video_streams[0]
        if int(vs.get("width", 0)) != expected_width or int(vs.get("height", 0)) != expected_height:
            issues.append(
                QCIssue(
                    code="RESOLUTION_MISMATCH",
                    severity="warning",
                    category="render_integrity",
                    message=f"Expected {expected_width}x{expected_height}, got {vs.get('width')}x{vs.get('height')}.",
                )
            )

        actual_dur_s = float(info.get("format", {}).get("duration") or vs.get("duration") or 0.0)
        expected_dur_s = expected_duration_ms / 1000.0
        if abs(actual_dur_s - expected_dur_s) > 0.75:
            issues.append(
                QCIssue(
                    code="DURATION_MISMATCH",
                    severity="warning",
                    category="render_integrity",
                    message=f"Exported duration ({actual_dur_s:.2f}s) differs from timeline ({expected_dur_s:.2f}s).",
                )
            )

        if not audio_streams:
            issues.append(
                QCIssue(
                    code="MISSING_AUDIO_STREAM",
                    severity="warning",
                    category="render_integrity",
                    message="Exported MP4 contains no audio stream.",
                )
            )

        return issues

    def run_production_qc(
        self,
        state: ProjectState,
        scene_ids: list[str] | None = None,
        queue_doc: ProductionQueueDocument | None = None,
    ) -> ProductionQCReport:
        """Run the full 8-category Production Quality Control analyzer (Phase 07 Batch 3)."""
        return run_production_qc(
            state,
            library_repo=self.library_repo,
            asset_service=self.asset_service,
            sound_service=self.sound_service,
            scene_ids=scene_ids,
            queue_doc=queue_doc,
        )

    def apply_qc_fix(self, state: ProjectState, req: ProductionQCFixRequest) -> tuple[ProjectState, str]:
        """Apply a deterministic inline fix for a QC issue."""
        return apply_qc_fix(state, req)
