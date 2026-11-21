"""SRT Import/Export, Validation, and ASS Export Engine (UTF-8 / Vietnamese safe)."""

from __future__ import annotations

import re
import uuid

from schemas.subtitle import (
    SrtImportResponse,
    SrtValidationIssue,
    SubtitleSegment,
    SubtitleStyle,
    default_subtitle_styles,
)

_TIME_RE = re.compile(
    r"^\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})"
)


def _parts_to_ms(h: str, m: str, s: str, ms: str) -> int:
    ms_padded = ms.ljust(3, "0")[:3]
    return ((int(h) * 3600) + (int(m) * 60) + int(s)) * 1000 + int(ms_padded)


def format_srt_timestamp(ms: int) -> str:
    clamped = max(0, int(round(ms)))
    hours = clamped // 3_600_000
    rem = clamped % 3_600_000
    minutes = rem // 60_000
    rem %= 60_000
    seconds = rem // 1000
    millis = rem % 1000
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{millis:03d}"


def format_ass_timestamp(ms: int) -> str:
    clamped = max(0, int(round(ms)))
    hours = clamped // 3_600_000
    rem = clamped % 3_600_000
    minutes = rem // 60_000
    rem %= 60_000
    seconds = rem // 1000
    centis = (rem % 1000) // 10
    return f"{hours:d}:{minutes:02d}:{seconds:02d}.{centis:02d}"


def _hex_to_ass_color(hex_color: str, alpha_0_to_1: float = 1.0) -> str:
    clean = hex_color.strip().lstrip("#")
    if len(clean) == 3:
        clean = "".join(c * 2 for c in clean)
    if len(clean) != 6:
        clean = "ffffff"
    r = int(clean[0:2], 16)
    g = int(clean[2:4], 16)
    b = int(clean[4:6], 16)
    # ASS alpha is inverted: 00 = opaque, FF = transparent
    a = max(0, min(255, int(round((1.0 - max(0.0, min(1.0, alpha_0_to_1))) * 255))))
    return f"&H{a:02X}{b:02X}{g:02X}{r:02X}"


def parse_srt(
    content: str,
    *,
    default_style_id: str = "style_classic_white",
    scene_id: str | None = None,
) -> SrtImportResponse:
    """Parse and validate UTF-8 SRT text preserving Vietnamese & multiline segments."""
    if not content or not content.strip():
        return SrtImportResponse(
            valid=False,
            segments=[],
            issues=[SrtValidationIssue(line=1, severity="error", message="SRT content is empty.")],
        )

    # Strip UTF-8 BOM and normalize line endings
    normalized = content.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
    lines = normalized.split("\n")

    segments: list[SubtitleSegment] = []
    issues: list[SrtValidationIssue] = []

    i = 0
    n = len(lines)
    prev_start = -1
    prev_end = -1

    while i < n:
        while i < n and not lines[i].strip():
            i += 1
        if i >= n:
            break

        block_start_line = i + 1
        first = lines[i].strip()

        # Optional numeric cue index line
        if first.isdigit():
            i += 1
            if i >= n:
                issues.append(
                    SrtValidationIssue(
                        line=block_start_line,
                        severity="error",
                        message="Cue index found without timestamp line.",
                    )
                )
                break
            ts_line_num = i + 1
            ts_line = lines[i]
        else:
            ts_line_num = block_start_line
            ts_line = lines[i]

        match = _TIME_RE.match(ts_line)
        if not match:
            issues.append(
                SrtValidationIssue(
                    line=ts_line_num,
                    severity="error",
                    message=f"Invalid SRT timestamp line: {ts_line.strip()[:80]!r}",
                )
            )
            # Advance to next blank line
            while i < n and lines[i].strip():
                i += 1
            continue

        if "." in ts_line:
            issues.append(
                SrtValidationIssue(
                    line=ts_line_num,
                    severity="warning",
                    message="Timestamp uses '.' instead of ',' for milliseconds (normalized automatically).",
                )
            )

        start_ms = _parts_to_ms(match.group(1), match.group(2), match.group(3), match.group(4))
        end_ms = _parts_to_ms(match.group(5), match.group(6), match.group(7), match.group(8))
        i += 1

        text_lines: list[str] = []
        while i < n and lines[i].strip() != "":
            text_lines.append(lines[i].rstrip())
            i += 1

        text = "\n".join(text_lines).strip()
        if end_ms <= start_ms:
            issues.append(
                SrtValidationIssue(
                    line=ts_line_num,
                    severity="error",
                    message=f"End time ({format_srt_timestamp(end_ms)}) must be after start time ({format_srt_timestamp(start_ms)}).",
                )
            )
            continue

        if not text:
            issues.append(
                SrtValidationIssue(
                    line=ts_line_num,
                    severity="warning",
                    message="Skipping empty subtitle cue.",
                )
            )
            continue

        if start_ms < prev_start:
            issues.append(
                SrtValidationIssue(
                    line=ts_line_num,
                    severity="warning",
                    message="Subtitle cues were out of chronological order (sorted automatically).",
                )
            )
        elif start_ms < prev_end:
            issues.append(
                SrtValidationIssue(
                    line=ts_line_num,
                    severity="warning",
                    message=f"Cue overlaps previous cue at {format_srt_timestamp(start_ms)}.",
                )
            )

        prev_start = max(prev_start, start_ms)
        prev_end = max(prev_end, end_ms)

        segments.append(
            SubtitleSegment(
                subtitle_id=f"sub_{uuid.uuid4().hex[:8]}",
                text=text,
                start_ms=start_ms,
                end_ms=end_ms,
                scene_id=scene_id,
                timing_source="imported_srt",
                style_id=default_style_id,
                enabled=True,
            )
        )

    segments.sort(key=lambda s: (s.start_ms, s.end_ms))
    has_errors = any(iss.severity == "error" for iss in issues)
    if not segments and not has_errors:
        issues.append(
            SrtValidationIssue(
                line=1,
                severity="error",
                message="No valid subtitle segments found in SRT input.",
            )
        )
        has_errors = True

    return SrtImportResponse(valid=not has_errors and len(segments) > 0, segments=segments, issues=issues)


def serialize_srt(
    segments: list[SubtitleSegment],
    *,
    include_disabled: bool = False,
) -> str:
    """Serialize SubtitleSegments to valid UTF-8 SRT string."""
    filtered = [
        s
        for s in segments
        if (include_disabled or s.enabled) and s.text.strip() and s.end_ms > s.start_ms
    ]
    ordered = sorted(filtered, key=lambda s: (s.start_ms, s.end_ms))

    blocks: list[str] = []
    for idx, seg in enumerate(ordered, start=1):
        clean_text = seg.text.replace("\r\n", "\n").replace("\r", "\n").strip()
        blocks.append(
            f"{idx}\n"
            f"{format_srt_timestamp(seg.start_ms)} --> {format_srt_timestamp(seg.end_ms)}\n"
            f"{clean_text}"
        )
    return ("\n\n".join(blocks) + "\n") if blocks else ""


def serialize_ass(
    segments: list[SubtitleSegment],
    *,
    styles: list[SubtitleStyle] | None = None,
    width: int = 1920,
    height: int = 1080,
    include_disabled: bool = False,
) -> str:
    """Serialize SubtitleSegments + SubtitleStyles to valid UTF-8 ASS format."""
    all_styles = styles or default_subtitle_styles()
    styles_by_id = {st.style_id: st for st in all_styles}
    fallback_style = all_styles[0] if all_styles else default_subtitle_styles()[0]

    def ass_alignment(align: str, pos: str) -> int:
        col = {"left": 1, "center": 2, "right": 3}.get(align, 2)
        row_offset = {"bottom": 0, "center": 3, "top": 6}.get(pos, 0)
        return row_offset + col

    lines = [
        "[Script Info]",
        "Title: AutoMotion Comic Studio Subtitles",
        "ScriptType: v4.00+",
        f"PlayResX: {width}",
        f"PlayResY: {height}",
        "WrapStyle: 0",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ]

    scale = height / 1080.0
    for st in all_styles:
        font_name = st.font_family.split(",")[0].strip().strip("'\"") or "Arial"
        bold_flag = -1 if st.font_weight in ("semibold", "bold", "extrabold") else 0
        border_style = 3 if st.background_enabled else 1
        primary = _hex_to_ass_color(st.text_color, 1.0)
        outline = (
            _hex_to_ass_color(st.background_color, st.background_opacity)
            if st.background_enabled
            else _hex_to_ass_color(st.outline_color, 1.0)
        )
        back = _hex_to_ass_color(
            st.background_color if st.background_enabled else st.shadow_color,
            st.background_opacity if st.background_enabled else (0.7 if st.shadow_enabled else 0.0),
        )
        fs = max(12, int(round(st.font_size * scale)))
        outline_px = round((st.outline_width if not st.background_enabled else 6.0) * scale, 1)
        shadow_px = round((2.0 if st.shadow_enabled and not st.background_enabled else 0.0) * scale, 1)
        ml = int(round(st.margin_x * (width / 1920.0)))
        mv = int(round(st.margin_y * scale))
        al = ass_alignment(st.alignment, st.position)
        lines.append(
            f"Style: {st.style_id},{font_name},{fs},{primary},{primary},{outline},{back},"
            f"{bold_flag},0,0,0,100,100,0,0,{border_style},{outline_px},{shadow_px},{al},{ml},{ml},{mv},1"
        )

    lines.extend(
        [
            "",
            "[Events]",
            "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
        ]
    )

    filtered = [
        s
        for s in segments
        if (include_disabled or s.enabled) and s.text.strip() and s.end_ms > s.start_ms
    ]
    for seg in sorted(filtered, key=lambda s: (s.start_ms, s.end_ms)):
        st = styles_by_id.get(seg.style_id, fallback_style)
        pos = seg.position_override or st.position
        override_prefix = ""
        if seg.position_override and seg.position_override != st.position:
            override_prefix = f"{{\\an{ass_alignment(st.alignment, pos)}}}"
        escaped_text = (
            seg.text.replace("\r\n", "\n")
            .replace("\r", "\n")
            .replace("\\", r"\\")
            .replace("{", r"\{")
            .replace("}", r"\}")
            .replace("\n", r"\N")
        )
        speaker = seg.speaker_name.replace(",", " ")
        lines.append(
            f"Dialogue: 0,{format_ass_timestamp(seg.start_ms)},{format_ass_timestamp(seg.end_ms)},"
            f"{st.style_id},{speaker},0,0,0,,{override_prefix}{escaped_text}"
        )

    return "\n".join(lines) + "\n"
