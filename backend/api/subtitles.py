"""Subtitle Studio API endpoints (SRT Import/Validate, SRT Export, ASS Export)."""

from __future__ import annotations

from fastapi import APIRouter, Response

from core.subtitle_engine.service import parse_srt, serialize_ass, serialize_srt
from schemas.subtitle import SrtImportRequest, SrtImportResponse, SubtitleExportRequest

router = APIRouter(prefix="/api/v1/subtitles", tags=["subtitles"])


@router.post("/import-srt", response_model=SrtImportResponse)
def import_srt_preview(req: SrtImportRequest) -> SrtImportResponse:
    return parse_srt(
        req.content,
        default_style_id=req.default_style_id,
        scene_id=req.scene_id,
    )


@router.post("/export-srt")
def export_srt_file(req: SubtitleExportRequest) -> Response:
    srt_text = serialize_srt(req.segments, include_disabled=req.include_disabled)
    return Response(
        content=srt_text.encode("utf-8"),
        media_type="application/x-subrip; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="subtitles.srt"'},
    )


@router.post("/export-ass")
def export_ass_file(req: SubtitleExportRequest) -> Response:
    ass_text = serialize_ass(
        req.segments,
        styles=req.styles,
        width=req.width,
        height=req.height,
        include_disabled=req.include_disabled,
    )
    return Response(
        content=ass_text.encode("utf-8"),
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="subtitles.ass"'},
    )
