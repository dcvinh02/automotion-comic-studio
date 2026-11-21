/**
 * Phase 08 Batch 3 — Export settings defaults & persistence.
 *
 * Persistence is split deliberately:
 *  - GLOBAL defaults (resolution, fps, format, codec, quality, audio, subtitles, advanced,
 *    collision policy) follow the user from project to project.
 *  - PROJECT values (output folder, filename, scope) are stored per project_id so a folder or
 *    scene selection from one project never leaks into another.
 * The backend re-validates everything (`/render/validate`); nothing here is trusted blindly.
 */
import type {
  ExportScopeKind,
  ExportSettings,
  ProjectState,
  ResolutionPresetId,
} from '@/types/models';

export const RESOLUTION_OPTIONS: { id: ResolutionPresetId; w?: number; h?: number }[] = [
  { id: 'project' },
  { id: 'hd', w: 1280, h: 720 },
  { id: 'fhd', w: 1920, h: 1080 },
  { id: 'qhd', w: 2560, h: 1440 },
  { id: 'uhd', w: 3840, h: 2160 },
  { id: 'portrait_hd', w: 720, h: 1280 },
  { id: 'portrait_fhd', w: 1080, h: 1920 },
  { id: 'custom' },
];

export const FPS_OPTIONS = [24, 25, 30, 50, 60];

const GLOBAL_KEY = 'amcs.export.defaults.v1';
const projectKey = (pid: string) => `amcs.export.project.${pid}.v1`;

export function defaultExportSettings(): ExportSettings {
  return {
    scope: { kind: 'project', scene_ids: [], shots: [], range_start_ms: null, range_end_ms: null },
    resolution_preset: 'project',
    width: 1920,
    height: 1080,
    aspect_mode: 'fit',
    fps: 30,
    container: 'mp4',
    video_codec: 'h264',
    encoder: 'auto',
    quality: 'standard',
    advanced: {
      crf: null,
      bitrate_kbps: null,
      encoder_preset: null,
      profile: null,
      pix_fmt: null,
      keyframe_interval: null,
    },
    audio: { enabled: true, bitrate_kbps: 192, sample_rate: 48000, normalize_loudness: false, target_lufs: -16 },
    subtitles: { mode: 'none', export_srt: false },
    output_dir: null,
    filename: null,
    collision_policy: 'auto_number',
    render_mode: 'auto',
    chunk_duration_seconds: 10,
    job_name: null,
  };
}

type GlobalPart = Pick<
  ExportSettings,
  | 'resolution_preset'
  | 'width'
  | 'height'
  | 'aspect_mode'
  | 'fps'
  | 'container'
  | 'video_codec'
  | 'encoder'
  | 'quality'
  | 'advanced'
  | 'audio'
  | 'subtitles'
  | 'collision_policy'
  | 'render_mode'
  | 'chunk_duration_seconds'
>;
type ProjectPart = Pick<ExportSettings, 'output_dir' | 'filename'> & { scope_kind?: ExportScopeKind };

function safeRead<T>(key: string): Partial<T> | null {
  try {
    const raw = window.localStorage?.getItem(key);
    return raw ? (JSON.parse(raw) as Partial<T>) : null;
  } catch {
    return null;
  }
}

function safeWrite(key: string, value: unknown): void {
  try {
    window.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable (private mode) — settings simply won't persist
  }
}

export interface ExportContext {
  activeSceneId: string | null;
  activeShotId: string | null;
}

/** Build the initial dialog settings: defaults ← saved global defaults ← saved project values. */
export function loadExportSettings(project: ProjectState, ctx: ExportContext): ExportSettings {
  const base = defaultExportSettings();
  const g = safeRead<GlobalPart>(GLOBAL_KEY) ?? {};
  const p = safeRead<ProjectPart>(projectKey(project.meta.project_id)) ?? {};
  const merged: ExportSettings = {
    ...base,
    ...g,
    advanced: { ...base.advanced, ...(g.advanced ?? {}) },
    audio: { ...base.audio, ...(g.audio ?? {}) },
    subtitles: { ...base.subtitles, ...(g.subtitles ?? {}) },
    output_dir: p.output_dir ?? null,
    filename: p.filename ?? null,
  };
  if (merged.resolution_preset === 'project') {
    merged.width = project.meta.width;
    merged.height = project.meta.height;
  }
  merged.scope = scopeForKind(p.scope_kind ?? 'project', project, ctx);
  // Subtitles: never default to burn-in for a project without cues
  const cueCount = (project.subtitles?.segments ?? []).filter((s) => s.enabled && s.text.trim()).length;
  if (cueCount === 0) merged.subtitles = { mode: 'none', export_srt: false };
  return merged;
}

export function saveExportSettings(projectId: string, s: ExportSettings): void {
  const g: GlobalPart = {
    resolution_preset: s.resolution_preset,
    width: s.width,
    height: s.height,
    aspect_mode: s.aspect_mode,
    fps: s.fps,
    container: s.container,
    video_codec: s.video_codec,
    encoder: s.encoder,
    quality: s.quality,
    advanced: s.advanced,
    audio: s.audio,
    subtitles: s.subtitles,
    collision_policy: s.collision_policy,
    render_mode: s.render_mode,
    chunk_duration_seconds: s.chunk_duration_seconds,
  };
  safeWrite(GLOBAL_KEY, g);
  safeWrite(projectKey(projectId), {
    output_dir: s.output_dir,
    filename: s.filename,
    scope_kind: s.scope.kind,
  } satisfies ProjectPart);
}

/** Build a scope for a kind using the current editor context (active scene / shot). */
export function scopeForKind(kind: ExportScopeKind, project: ProjectState, ctx: ExportContext): ExportSettings['scope'] {
  const scenes = [...project.scenes].sort((a, b) => a.start_ms - b.start_ms || a.order_index - b.order_index);
  const activeScene = scenes.find((s) => s.scene_id === ctx.activeSceneId) ?? scenes[0];
  const empty = { scene_ids: [], shots: [], range_start_ms: null, range_end_ms: null };
  switch (kind) {
    case 'scene':
      return { kind, ...empty, scene_ids: activeScene ? [activeScene.scene_id] : [] };
    case 'scenes':
      return { kind, ...empty, scene_ids: activeScene ? [activeScene.scene_id] : [] };
    case 'shot':
    case 'shots': {
      const sc = scenes.find((s) => (s.shots ?? []).some((sh) => sh.shot_id === ctx.activeShotId)) ?? activeScene;
      const shot = sc?.shots?.find((sh) => sh.shot_id === ctx.activeShotId) ?? sc?.shots?.[0];
      return { kind, ...empty, shots: sc && shot ? [{ scene_id: sc.scene_id, shot_id: shot.shot_id }] : [] };
    }
    case 'range':
      return {
        kind,
        ...empty,
        range_start_ms: 0,
        range_end_ms: Math.min(project.timeline.total_duration_ms, 5000),
      };
    default:
      return { kind: 'project', ...empty };
  }
}

export function hasShots(project: ProjectState): boolean {
  return project.scenes.some((s) => (s.shots ?? []).length > 0);
}

export function formatBytes(n: number | null | undefined): string {
  if (!n || n <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
