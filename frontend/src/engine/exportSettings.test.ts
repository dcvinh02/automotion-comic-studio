import { beforeEach, describe, expect, it } from 'vitest';
import type { ProjectState } from '@/types/models';
import {
  defaultExportSettings,
  formatBytes,
  formatDuration,
  loadExportSettings,
  saveExportSettings,
  scopeForKind,
} from './exportSettings';

function installMemoryStorage() {
  const map = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
      setItem: (k: string, v: string) => void map.set(k, String(v)),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
      key: (i: number) => [...map.keys()][i] ?? null,
      get length() {
        return map.size;
      },
    },
  });
}

function project(id: string, cues = 0): ProjectState {
  return {
    meta: { project_id: id, name: `P ${id}`, width: 1280, height: 720, fps: 30 },
    scenes: [
      { scene_id: 's2', name: 'Two', start_ms: 4000, duration_ms: 3000, order_index: 1, shots: [] },
      {
        scene_id: 's1',
        name: 'One',
        start_ms: 0,
        duration_ms: 4000,
        order_index: 0,
        shots: [
          { shot_id: 'sh1', scene_id: 's1', shot_order: 1, title: 'A', start_ms: 0, duration_ms: 2000 },
          { shot_id: 'sh2', scene_id: 's1', shot_order: 2, title: 'B', start_ms: 2000, duration_ms: 2000 },
        ],
      },
    ],
    timeline: { total_duration_ms: 7000, fps: 30, tracks: [], keyframes: [], sound_events: [], animation_clips: [] },
    subtitles: {
      segments: Array.from({ length: cues }, (_, i) => ({ subtitle_id: `c${i}`, text: 'Xin chào', start_ms: 0, end_ms: 500, enabled: true })),
    },
  } as unknown as ProjectState;
}

describe('Export settings persistence (Phase 08 Batch 3)', () => {
  beforeEach(() => installMemoryStorage());

  it('uses project stage resolution and no subtitles by default', () => {
    const s = loadExportSettings(project('a'), { activeSceneId: null, activeShotId: null });
    expect(s.resolution_preset).toBe('project');
    expect([s.width, s.height]).toEqual([1280, 720]);
    expect(s.subtitles.mode).toBe('none');
    expect(s.scope.kind).toBe('project');
    expect(s.collision_policy).toBe('auto_number');
  });

  it('keeps global defaults across projects but output folder / filename / scope per project', () => {
    const a = project('a', 2);
    const s = { ...defaultExportSettings(), fps: 60, quality: 'high' as const, container: 'mov' as const, output_dir: '/Users/me/Phim', filename: 'Tập 1', subtitles: { mode: 'burn_in' as const, export_srt: true } };
    s.scope = scopeForKind('scene', a, { activeSceneId: 's2', activeShotId: null });
    saveExportSettings('a', s);

    const again = loadExportSettings(a, { activeSceneId: 's2', activeShotId: null });
    expect(again.fps).toBe(60);
    expect(again.output_dir).toBe('/Users/me/Phim');
    expect(again.filename).toBe('Tập 1');
    expect(again.scope).toMatchObject({ kind: 'scene', scene_ids: ['s2'] });
    expect(again.subtitles.mode).toBe('burn_in');

    const other = loadExportSettings(project('b'), { activeSceneId: null, activeShotId: null });
    expect(other.fps).toBe(60); // global default carried over
    expect(other.quality).toBe('high');
    expect(other.output_dir).toBeNull(); // project-specific value NOT leaked
    expect(other.filename).toBeNull();
    expect(other.scope.kind).toBe('project');
    expect(other.subtitles.mode).toBe('none'); // project b has no cues
  });

  it('builds scopes from the active scene / shot', () => {
    const p = project('a');
    expect(scopeForKind('scene', p, { activeSceneId: null, activeShotId: null }).scene_ids).toEqual(['s1']);
    expect(scopeForKind('shot', p, { activeSceneId: 's1', activeShotId: 'sh2' }).shots).toEqual([{ scene_id: 's1', shot_id: 'sh2' }]);
    const r = scopeForKind('range', p, { activeSceneId: null, activeShotId: null });
    expect([r.range_start_ms, r.range_end_ms]).toEqual([0, 5000]);
  });

  it('survives unavailable storage', () => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('blocked');
      },
    });
    expect(() => saveExportSettings('a', defaultExportSettings())).not.toThrow();
    expect(loadExportSettings(project('a'), { activeSceneId: null, activeShotId: null }).fps).toBe(30);
  });

  it('formats sizes and durations', () => {
    expect(formatBytes(0)).toBe('—');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(25 * 1024 * 1024)).toBe('25 MB');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(formatDuration(null)).toBe('—');
  });
});
