/**
 * Pure Subtitle Studio Engine — SRT/ASS parsing, validation, serialization,
 * segment split/merge/bulk operations, and Script/Voice subtitle generation.
 */

import type {
  Character,
  ScriptDocument,
  SrtImportResponse,
  SrtValidationIssue,
  SubtitleDocument,
  SubtitlePosition,
  SubtitleSegment,
  SubtitleStyle,
} from '@/types/models';

export const DEFAULT_SUBTITLE_STYLES: SubtitleStyle[] = [
  {
    style_id: 'style_classic_white',
    name: 'Classic White',
    is_builtin: true,
    font_family: "Inter, 'Noto Sans', Arial, sans-serif",
    font_size: 44,
    font_weight: 'bold',
    text_color: '#ffffff',
    outline_color: '#000000',
    outline_width: 3,
    shadow_enabled: true,
    shadow_color: '#000000',
    shadow_blur: 6,
    shadow_offset_x: 0,
    shadow_offset_y: 3,
    background_enabled: false,
    background_color: '#090b10',
    background_opacity: 0.65,
    alignment: 'center',
    position: 'bottom',
    margin_x: 80,
    margin_y: 56,
    line_spacing: 1.25,
    max_width_pct: 82,
    word_wrap: true,
  },
  {
    style_id: 'style_cinematic',
    name: 'Cinematic',
    is_builtin: true,
    font_family: "Georgia, 'Noto Serif', serif",
    font_size: 40,
    font_weight: 'semibold',
    text_color: '#f8f5ec',
    outline_color: '#111317',
    outline_width: 1.5,
    shadow_enabled: true,
    shadow_color: '#000000',
    shadow_blur: 10,
    shadow_offset_x: 0,
    shadow_offset_y: 2,
    background_enabled: false,
    background_color: '#000000',
    background_opacity: 0.45,
    alignment: 'center',
    position: 'bottom',
    margin_x: 110,
    margin_y: 48,
    line_spacing: 1.35,
    max_width_pct: 78,
    word_wrap: true,
  },
  {
    style_id: 'style_bold_comic',
    name: 'Bold Comic',
    is_builtin: true,
    font_family: "'Arial Black', Impact, 'Noto Sans', sans-serif",
    font_size: 48,
    font_weight: 'extrabold',
    text_color: '#fde047',
    outline_color: '#111317',
    outline_width: 5,
    shadow_enabled: true,
    shadow_color: '#000000',
    shadow_blur: 4,
    shadow_offset_x: 3,
    shadow_offset_y: 4,
    background_enabled: false,
    background_color: '#111317',
    background_opacity: 0.75,
    alignment: 'center',
    position: 'bottom',
    margin_x: 72,
    margin_y: 60,
    line_spacing: 1.2,
    max_width_pct: 84,
    word_wrap: true,
  },
  {
    style_id: 'style_minimal',
    name: 'Minimal',
    is_builtin: true,
    font_family: "Inter, 'Helvetica Neue', Arial, sans-serif",
    font_size: 36,
    font_weight: 'normal',
    text_color: '#f1f5f9',
    outline_color: '#0f172a',
    outline_width: 1,
    shadow_enabled: true,
    shadow_color: '#000000',
    shadow_blur: 4,
    shadow_offset_x: 0,
    shadow_offset_y: 1,
    background_enabled: false,
    background_color: '#000000',
    background_opacity: 0.4,
    alignment: 'center',
    position: 'bottom',
    margin_x: 96,
    margin_y: 44,
    line_spacing: 1.32,
    max_width_pct: 80,
    word_wrap: true,
  },
  {
    style_id: 'style_high_contrast',
    name: 'High Contrast',
    is_builtin: true,
    font_family: "Inter, 'Noto Sans', Arial, sans-serif",
    font_size: 44,
    font_weight: 'bold',
    text_color: '#ffffff',
    outline_color: '#000000',
    outline_width: 0,
    shadow_enabled: false,
    shadow_color: '#000000',
    shadow_blur: 0,
    shadow_offset_x: 0,
    shadow_offset_y: 0,
    background_enabled: true,
    background_color: '#090b10',
    background_opacity: 0.86,
    alignment: 'center',
    position: 'bottom',
    margin_x: 80,
    margin_y: 54,
    line_spacing: 1.28,
    max_width_pct: 84,
    word_wrap: true,
  },
];

export function createDefaultSubtitleDocument(): SubtitleDocument {
  return {
    default_style_id: 'style_classic_white',
    styles: structuredClone(DEFAULT_SUBTITLE_STYLES),
    segments: [],
  };
}

export function ensureSubtitleDocument(doc?: SubtitleDocument | null): SubtitleDocument {
  if (!doc) return createDefaultSubtitleDocument();
  const styles = doc.styles && doc.styles.length > 0 ? doc.styles : structuredClone(DEFAULT_SUBTITLE_STYLES);
  return {
    default_style_id: doc.default_style_id || styles[0].style_id,
    styles,
    segments: Array.isArray(doc.segments) ? doc.segments : [],
  };
}

export function normalizeSubtitleStyle(style: SubtitleStyle): Required<SubtitleStyle> {
  return {
    ...style,
    italic: style.italic ?? false,
    underline: style.underline ?? false,
    letter_spacing: style.letter_spacing ?? 0,
    shadow_opacity: style.shadow_opacity ?? 0.78,
    background_padding_x: style.background_padding_x ?? 18,
    background_padding_y: style.background_padding_y ?? 10,
    offset_x: style.offset_x ?? 0,
    offset_y: style.offset_y ?? 0,
    box_height_px: style.box_height_px ?? 0,
    safe_area_clamp: style.safe_area_clamp ?? true,
  };
}

export function resolveSubtitleStyle(doc: SubtitleDocument, styleId: string): Required<SubtitleStyle> {
  const base =
    doc.styles.find((st) => st.style_id === styleId) ??
    doc.styles.find((st) => st.style_id === doc.default_style_id) ??
    doc.styles[0] ??
    DEFAULT_SUBTITLE_STYLES[0];
  return normalizeSubtitleStyle(base);
}

/**
 * Resolve the effective rendering style for a single SubtitleSegment by merging
 * its base SubtitleStyle with per-segment style_override and legacy position_override.
 * Single source of truth used by PixiJS preview, Timeline Inspector, Subtitle Studio, and ASS export.
 */
export function resolveEffectiveSubtitleStyle(
  doc: SubtitleDocument,
  seg: SubtitleSegment,
): Required<SubtitleStyle> {
  const base = resolveSubtitleStyle(doc, seg.style_id);
  const ov = seg.style_override;
  const cleaned: Record<string, unknown> = {};
  if (ov) {
    for (const [k, v] of Object.entries(ov)) {
      if (v !== undefined && v !== null) {
        cleaned[k] = v;
      }
    }
  }
  if (seg.position_override && cleaned.position === undefined) {
    cleaned.position = seg.position_override;
  }
  return normalizeSubtitleStyle({ ...base, ...cleaned } as SubtitleStyle);
}

export function countSubtitleStyleOverrides(seg: SubtitleSegment): number {
  let n = 0;
  if (seg.style_override) {
    for (const v of Object.values(seg.style_override)) {
      if (v !== undefined && v !== null) n += 1;
    }
  }
  if (seg.position_override && (!seg.style_override || seg.style_override.position == null)) {
    n += 1;
  }
  return n;
}

export function formatSrtTimestamp(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const hours = Math.floor(clamped / 3_600_000);
  const rem1 = clamped % 3_600_000;
  const minutes = Math.floor(rem1 / 60_000);
  const rem2 = rem1 % 60_000;
  const seconds = Math.floor(rem2 / 1000);
  const millis = rem2 % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

export function formatAssTimestamp(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const hours = Math.floor(clamped / 3_600_000);
  const rem1 = clamped % 3_600_000;
  const minutes = Math.floor(rem1 / 60_000);
  const rem2 = rem1 % 60_000;
  const seconds = Math.floor(rem2 / 1000);
  const centis = Math.floor((rem2 % 1000) / 10);
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centis).padStart(2, '0')}`;
}

export function parseSrtTimestamp(raw: string): number | null {
  const m = /^\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*$/.exec(raw);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const sec = Number(m[3]);
  const ms = Number(m[4].padEnd(3, '0').slice(0, 3));
  if (min >= 60 || sec >= 60) return null;
  return ((h * 3600) + (min * 60) + sec) * 1000 + ms;
}

const SRT_RANGE_RE =
  /^\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

function makeSubId(): string {
  return `sub_${Math.random().toString(36).slice(2, 10)}`;
}

export function parseSrt(
  content: string,
  options?: { defaultStyleId?: string; sceneId?: string | null },
): SrtImportResponse {
  const defaultStyleId = options?.defaultStyleId ?? 'style_classic_white';
  const sceneId = options?.sceneId ?? null;

  if (!content || !content.trim()) {
    return {
      valid: false,
      segments: [],
      issues: [{ line: 1, severity: 'error', message: 'SRT content is empty.' }],
    };
  }

  const normalized = content.replace(/^\ufeff/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  const segments: SubtitleSegment[] = [];
  const issues: SrtValidationIssue[] = [];

  let i = 0;
  let prevStart = -1;
  let prevEnd = -1;

  while (i < lines.length) {
    while (i < lines.length && lines[i].trim() === '') i++;
    if (i >= lines.length) break;

    const blockLine = i + 1;
    let tsLineNum = blockLine;
    let tsLine = lines[i];

    if (/^\d+$/.test(lines[i].trim())) {
      i++;
      if (i >= lines.length) {
        issues.push({
          line: blockLine,
          severity: 'error',
          message: 'Cue index found without timestamp line.',
        });
        break;
      }
      tsLineNum = i + 1;
      tsLine = lines[i];
    }

    const match = SRT_RANGE_RE.exec(tsLine);
    if (!match) {
      issues.push({
        line: tsLineNum,
        severity: 'error',
        message: `Invalid SRT timestamp: "${tsLine.trim().slice(0, 80)}"`,
      });
      while (i < lines.length && lines[i].trim() !== '') i++;
      continue;
    }

    if (tsLine.includes('.')) {
      issues.push({
        line: tsLineNum,
        severity: 'warning',
        message: 'Timestamp uses "." instead of "," for milliseconds (normalized).',
      });
    }

    const startMs =
      ((Number(match[1]) * 3600) + (Number(match[2]) * 60) + Number(match[3])) * 1000 +
      Number(match[4].padEnd(3, '0').slice(0, 3));
    const endMs =
      ((Number(match[5]) * 3600) + (Number(match[6]) * 60) + Number(match[7])) * 1000 +
      Number(match[8].padEnd(3, '0').slice(0, 3));
    i++;

    const textLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== '') {
      textLines.push(lines[i].replace(/\s+$/, ''));
      i++;
    }
    const text = textLines.join('\n').trim();

    if (endMs <= startMs) {
      issues.push({
        line: tsLineNum,
        severity: 'error',
        message: `End time (${formatSrtTimestamp(endMs)}) must be after start time (${formatSrtTimestamp(startMs)}).`,
      });
      continue;
    }

    if (!text) {
      issues.push({
        line: tsLineNum,
        severity: 'warning',
        message: 'Skipping empty subtitle cue.',
      });
      continue;
    }

    if (startMs < prevStart) {
      issues.push({
        line: tsLineNum,
        severity: 'warning',
        message: 'Out-of-order subtitle cue (sorted chronologically).',
      });
    } else if (startMs < prevEnd) {
      issues.push({
        line: tsLineNum,
        severity: 'warning',
        message: `Cue overlaps previous cue at ${formatSrtTimestamp(startMs)}.`,
      });
    }

    prevStart = Math.max(prevStart, startMs);
    prevEnd = Math.max(prevEnd, endMs);

    segments.push({
      subtitle_id: makeSubId(),
      text,
      start_ms: startMs,
      end_ms: endMs,
      scene_id: sceneId,
      speaker_character_id: null,
      speaker_name: '',
      script_entry_id: null,
      voice_audio_asset_id: null,
      timing_source: 'imported_srt',
      style_id: defaultStyleId,
      position_override: null,
      enabled: true,
    });
  }

  segments.sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
  const hasErrors = issues.some((x) => x.severity === 'error');
  if (segments.length === 0 && !hasErrors) {
    issues.push({ line: 1, severity: 'error', message: 'No valid subtitle cues found.' });
    return { valid: false, segments: [], issues };
  }
  return { valid: !hasErrors && segments.length > 0, segments, issues };
}

export function serializeSrt(segments: SubtitleSegment[], includeDisabled = false): string {
  const ordered = segments
    .filter((s) => (includeDisabled || s.enabled) && s.text.trim() && s.end_ms > s.start_ms)
    .sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);

  if (ordered.length === 0) return '';
  return (
    ordered
      .map((seg, idx) => {
        const clean = seg.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
        return `${idx + 1}\n${formatSrtTimestamp(seg.start_ms)} --> ${formatSrtTimestamp(seg.end_ms)}\n${clean}`;
      })
      .join('\n\n') + '\n'
  );
}

function hexToAssColor(hex: string, alpha01 = 1): string {
  let clean = hex.trim().replace(/^#/, '');
  if (clean.length === 3) clean = clean.split('').map((c) => c + c).join('');
  if (clean.length !== 6) clean = 'ffffff';
  const r = clean.slice(0, 2).toUpperCase();
  const g = clean.slice(2, 4).toUpperCase();
  const b = clean.slice(4, 6).toUpperCase();
  const a = Math.max(0, Math.min(255, Math.round((1 - Math.max(0, Math.min(1, alpha01))) * 255)))
    .toString(16)
    .toUpperCase()
    .padStart(2, '0');
  return `&H${a}${b}${g}${r}`;
}

function assAlignmentCode(alignment: string, position: SubtitlePosition): number {
  const col = alignment === 'left' ? 1 : alignment === 'right' ? 3 : 2;
  const row = position === 'top' ? 6 : position === 'center' ? 3 : 0;
  return row + col;
}

export function serializeAss(
  segments: SubtitleSegment[],
  styles: SubtitleStyle[] = DEFAULT_SUBTITLE_STYLES,
  width = 1920,
  height = 1080,
  includeDisabled = false,
): string {
  const styleList = styles.length > 0 ? styles : DEFAULT_SUBTITLE_STYLES;
  const byId = new Map(styleList.map((s) => [s.style_id, s]));
  const fallback = styleList[0];
  const scaleY = height / 1080;
  const scaleX = width / 1920;

  const lines: string[] = [
    '[Script Info]',
    'Title: AutoMotion Comic Studio Subtitles',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  ];

  for (const st of styleList) {
    const fontName = st.font_family.split(',')[0].trim().replace(/^['"]|['"]$/g, '') || 'Arial';
    const bold = st.font_weight === 'normal' ? 0 : -1;
    const italic = st.italic ? -1 : 0;
    const underline = st.underline ? -1 : 0;
    const spacing = Number(((st.letter_spacing ?? 0) * scaleX).toFixed(1));
    const borderStyle = st.background_enabled ? 3 : 1;
    const primary = hexToAssColor(st.text_color, 1);
    const outline = st.background_enabled
      ? hexToAssColor(st.background_color, st.background_opacity)
      : hexToAssColor(st.outline_color, 1);
    const back = hexToAssColor(
      st.background_enabled ? st.background_color : st.shadow_color,
      st.background_enabled ? st.background_opacity : st.shadow_enabled ? (st.shadow_opacity ?? 0.78) : 0,
    );
    const fs = Math.max(12, Math.round(st.font_size * scaleY));
    const outlinePx = Number(((st.background_enabled ? 6 : st.outline_width) * scaleY).toFixed(1));
    const shadowPx = Number((st.shadow_enabled && !st.background_enabled ? 2 * scaleY : 0).toFixed(1));
    const ml = Math.round(st.margin_x * scaleX);
    const mv = Math.round(st.margin_y * scaleY);
    const al = assAlignmentCode(st.alignment, st.position);
    lines.push(
      `Style: ${st.style_id},${fontName},${fs},${primary},${primary},${outline},${back},${bold},${italic},${underline},0,100,100,${spacing},0,${borderStyle},${outlinePx},${shadowPx},${al},${ml},${ml},${mv},1`,
    );
  }

  lines.push(
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  );

  const ordered = segments
    .filter((s) => (includeDisabled || s.enabled) && s.text.trim() && s.end_ms > s.start_ms)
    .sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);

  for (const seg of ordered) {
    const st = byId.get(seg.style_id) ?? fallback;
    const pos = seg.position_override ?? st.position;
    const prefix =
      seg.position_override && seg.position_override !== st.position
        ? `{\\an${assAlignmentCode(st.alignment, pos)}}`
        : '';
    const escaped = seg.text
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\\/g, '\\\\')
      .replace(/\{/g, '\\{')
      .replace(/\}/g, '\\}')
      .replace(/\n/g, '\\N');
    const speaker = seg.speaker_name.replace(/,/g, ' ');
    lines.push(
      `Dialogue: 0,${formatAssTimestamp(seg.start_ms)},${formatAssTimestamp(seg.end_ms)},${st.style_id},${speaker},0,0,0,,${prefix}${escaped}`,
    );
  }

  return lines.join('\n') + '\n';
}

export function getActiveSubtitlesAtMs(
  doc: SubtitleDocument | undefined | null,
  timeMs: number,
  trackVisible = true,
): SubtitleSegment[] {
  if (!doc || !trackVisible) return [];
  return doc.segments
    .filter((s) => s.enabled && s.text.trim().length > 0 && timeMs >= s.start_ms && timeMs < s.end_ms)
    .sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
}

export function splitSubtitleSegment(
  seg: SubtitleSegment,
  splitAtMs?: number,
): [SubtitleSegment, SubtitleSegment] | null {
  const dur = seg.end_ms - seg.start_ms;
  if (dur < 200) return null;

  const targetMs =
    splitAtMs !== undefined && splitAtMs > seg.start_ms + 80 && splitAtMs < seg.end_ms - 80
      ? Math.round(splitAtMs)
      : Math.round(seg.start_ms + dur / 2);

  // Split text intelligently: by newline if multiline, else near midpoint word boundary
  const clean = seg.text.replace(/\r\n/g, '\n').trim();
  const lines = clean.split('\n');
  let textA = clean;
  let textB = clean;

  if (lines.length >= 2) {
    const mid = Math.ceil(lines.length / 2);
    textA = lines.slice(0, mid).join('\n').trim();
    textB = lines.slice(mid).join('\n').trim();
  } else {
    const words = clean.split(/\s+/).filter(Boolean);
    if (words.length >= 2) {
      const mid = Math.ceil(words.length / 2);
      textA = words.slice(0, mid).join(' ');
      textB = words.slice(mid).join(' ');
    }
  }

  const first: SubtitleSegment = {
    ...seg,
    end_ms: targetMs,
    text: textA,
    timing_source: 'manual',
  };
  const second: SubtitleSegment = {
    ...seg,
    subtitle_id: makeSubId(),
    start_ms: targetMs,
    end_ms: seg.end_ms,
    text: textB,
    timing_source: 'manual',
  };
  return [first, second];
}

export function mergeSubtitleSegments(segmentsToMerge: SubtitleSegment[]): SubtitleSegment | null {
  if (segmentsToMerge.length < 2) return null;
  const ordered = [...segmentsToMerge].sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const mergedText = ordered
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join('\n');

  return {
    ...first,
    start_ms: first.start_ms,
    end_ms: Math.max(first.start_ms + 200, last.end_ms),
    text: mergedText,
    timing_source: 'manual',
  };
}

export function generateSubtitlesFromScript(
  script: ScriptDocument | undefined | null,
  characters: Character[],
  options?: {
    defaultStyleId?: string;
    includeDialogue?: boolean;
    includeNarration?: boolean;
    startOffsetMs?: number;
  },
): { segments: SubtitleSegment[]; voiceSyncedCount: number; estimatedCount: number } {
  if (!script || script.scenes.length === 0) {
    return { segments: [], voiceSyncedCount: 0, estimatedCount: 0 };
  }

  const defaultStyleId = options?.defaultStyleId ?? 'style_classic_white';
  const includeDialogue = options?.includeDialogue ?? true;
  const includeNarration = options?.includeNarration ?? true;
  const charsById = new Map(characters.map((c) => [c.character_id, c]));

  let cursorMs = Math.max(0, Math.round(options?.startOffsetMs ?? 0));
  const segments: SubtitleSegment[] = [];
  let voiceSyncedCount = 0;
  let estimatedCount = 0;

  const sortedScenes = [...script.scenes].sort((a, b) => a.order_index - b.order_index);
  for (const sc of sortedScenes) {
    const entries = [...sc.entries].sort((a, b) => a.order_index - b.order_index);
    for (const entry of entries) {
      if (entry.entry_type === 'dialogue' && !includeDialogue) continue;
      if (entry.entry_type === 'narration' && !includeNarration) continue;
      if (entry.entry_type === 'action') continue;

      const text = entry.text.trim();
      if (!text) continue;

      cursorMs += Math.max(0, Math.round(entry.pause_before_ms || 0));

      const hasVoiceDuration = Boolean(entry.audio_asset_id && entry.audio_duration_ms && entry.audio_duration_ms > 0);
      const rawDur = hasVoiceDuration
        ? Math.round(entry.audio_duration_ms!)
        : Math.max(800, Math.round(entry.estimated_duration_ms || Math.max(1200, text.length * 70)));

      if (hasVoiceDuration) voiceSyncedCount += 1;
      else estimatedCount += 1;

      const char = entry.character_id ? charsById.get(entry.character_id) : null;
      const speakerName =
        entry.entry_type === 'narration'
          ? entry.narrator_label || 'Narrator'
          : char?.name ?? '';

      segments.push({
        subtitle_id: makeSubId(),
        text,
        start_ms: cursorMs,
        end_ms: cursorMs + rawDur,
        scene_id: sc.linked_stage_scene_id ?? null,
        speaker_character_id: entry.character_id ?? null,
        speaker_name: speakerName,
        script_entry_id: entry.entry_id,
        voice_audio_asset_id: entry.audio_asset_id ?? null,
        timing_source: hasVoiceDuration ? 'voice_duration' : 'estimated',
        style_id: defaultStyleId,
        position_override: null,
        enabled: true,
      });

      cursorMs += rawDur + Math.max(0, Math.round(entry.pause_after_ms || 250));
    }
  }

  return { segments, voiceSyncedCount, estimatedCount };
}
