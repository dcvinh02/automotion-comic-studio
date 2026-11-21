import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '@/services/apiClient';
import { recoveryClient } from '@/services/recoveryClient';
import { takeSnapshot } from '@/engine/projectSync';
import { useProjectStore } from '@/stores/useProjectStore';
import type { ProjectState } from '@/types/models';

function proj(id: string): ProjectState {
  return {
    meta: { project_id: id, name: `Dự án ${id}`, width: 1280, height: 720, fps: 30, duration_ms: 10000, auto_save_enabled: true, updated_at: 't' },
    scenes: [{ scene_id: 's1', project_id: id, name: 'Cảnh', order_index: 0, start_ms: 0, duration_ms: 10000, background_color: '#000',
      transition_in: 'cut', transition_duration_ms: 0, camera_default: { x: 0, y: 0, zoom: 1, rotation_deg: 0 }, characters: [], props: [], shots: [] }],
    timeline: { project_id: id, fps: 30, total_duration_ms: 10000, tracks: [], keyframes: [], animation_clips: [], sound_events: [] },
    subtitles: { default_style_id: 'x', styles: [], segments: [] },
    revisions: { scenes: 1 },
  } as unknown as ProjectState;
}

function installStorage() {
  const m = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: new Proxy({} as Storage, {
      get: (_t, k) => ({ getItem: (x: string) => m.get(x) ?? null, setItem: (x: string, v: string) => void m.set(x, v), removeItem: (x: string) => void m.delete(x), clear: () => m.clear(), key: () => null, length: m.size } as Record<string, unknown>)[k as string],
      ownKeys: () => [...m.keys()],
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    }),
  });
}

describe('Project switching / closing never discards unsaved work (Phase 09.3)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    installStorage();
    const a = proj('proj_a');
    useProjectStore.setState({ project: a, syncSnapshot: takeSnapshot(a), isDirty: false, isSaving: false, saveError: null, undoStack: [], redoStack: [] });
  });

  it('saves the current project before switching', async () => {
    const save = vi.spyOn(apiClient, 'saveProjectSections').mockImplementation(async (state) => ({ state: { ...state, revisions: { scenes: 2 } }, conflicts: [] }));
    vi.spyOn(apiClient, 'getProject').mockResolvedValue(proj('proj_b'));
    vi.spyOn(apiClient, 'listProjects').mockResolvedValue([]);
    useProjectStore.getState().updateScene('s1', { name: 'Đã sửa' });
    await useProjectStore.getState().openProject('proj_b');
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0].scenes[0].name).toBe('Đã sửa');
    expect(useProjectStore.getState().project!.meta.project_id).toBe('proj_b');
  });

  it('keeps the project open and writes recovery data when that save fails', async () => {
    vi.spyOn(apiClient, 'saveProjectSections').mockRejectedValue(new Error('backend unreachable'));
    const get = vi.spyOn(apiClient, 'getProject').mockResolvedValue(proj('proj_b'));
    useProjectStore.getState().updateScene('s1', { name: 'Không được mất' });
    await expect(useProjectStore.getState().openProject('proj_b')).rejects.toThrow(/stays open/);
    expect(get).not.toHaveBeenCalled();
    const st = useProjectStore.getState();
    expect(st.project!.meta.project_id).toBe('proj_a');
    expect(st.project!.scenes[0].name).toBe('Không được mất');
    expect(st.isDirty).toBe(true);
    expect(st.saveError).toMatch(/backend unreachable/);
    expect(st.saveFailureCount).toBeGreaterThan(0);
    const rec = (await recoveryClient.list()).filter((c) => c.valid);
    expect(rec).toHaveLength(1);
    expect((rec[0].payload!.sections.scenes as { name: string }[])[0].name).toBe('Không được mất');
    expect(rec[0].payload!.dirty_sections).toEqual(['scenes']);
  });

  it('flushBeforeClose reports success only after the data is saved, and clears recovery data', async () => {
    vi.spyOn(apiClient, 'saveProjectSections').mockImplementation(async (state) => ({ state, conflicts: [] }));
    vi.spyOn(apiClient, 'listProjects').mockResolvedValue([]);
    await recoveryClient.write({ format: 'amcs-recovery', version: 1, project_id: 'proj_a', project_name: 'x', created_at: new Date().toISOString(), reason: 'unsaved', base_revisions: {}, dirty_sections: ['scenes'], sections: { scenes: [] } });
    useProjectStore.getState().updateScene('s1', { name: 'Lưu khi đóng' });
    expect(await useProjectStore.getState().flushBeforeClose()).toEqual({ ok: true });
    expect(useProjectStore.getState().isDirty).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(await recoveryClient.list()).toHaveLength(0);
    // nothing to save → immediate ok, no request
    expect(await useProjectStore.getState().flushBeforeClose()).toEqual({ ok: true });
  });
});
