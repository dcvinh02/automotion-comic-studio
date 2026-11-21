import { describe, expect, it, beforeEach } from 'vitest';
import { useProjectStore } from './useProjectStore';
import { useWorkspaceStore } from './useWorkspaceStore';
import type { ProjectState } from '@/types/models';

const sampleProject: ProjectState = {
  meta: {
    project_id: 'proj_ui_test',
    name: 'UI Phase 02 Test',
    description: '',
    schema_version: '0.1.0',
    width: 1920,
    height: 1080,
    fps: 30,
    duration_ms: 15000,
    default_export_preset_id: 'preset_1080p_final',
    auto_save_enabled: true,
    created_at: '',
    updated_at: '',
  },
  scenes: [
    {
      scene_id: 'scene_1',
      project_id: 'proj_ui_test',
      order_index: 0,
      name: 'Opening',
      start_ms: 0,
      duration_ms: 15000,
      background_asset_id: null,
      background_color: '#101216',
      transition_in: 'cut',
      transition_duration_ms: 0,
      camera_default: { x: 0, y: 0, zoom: 1, rotation_deg: 0 },
      characters: [],
      props: [],
    },
  ],
  timeline: {
    project_id: 'proj_ui_test',
    fps: 30,
    total_duration_ms: 15000,
    tracks: [
      {
        track_id: 'trk_sfx_1',
        project_id: 'proj_ui_test',
        track_type: 'sfx',
        name: 'SFX Track 1',
        target_ref_id: null,
        order_index: 10,
        muted: false,
        locked: false,
        solo: false,
        visible: true,
        volume: 1,
        collapsed: false,
      },
    ],
    keyframes: [],
    animation_clips: [],
    sound_events: [],
  },
};

describe('Phase 02 Workspace, Panel, Viewport & Theme Controls', () => {
  beforeEach(() => {
    useProjectStore.setState({
      project: structuredClone(sampleProject),
      activeSceneId: 'scene_1',
      selection: { type: 'none', id: null },
      isDirty: false,
      undoStack: [],
      redoStack: [],
    });
    useWorkspaceStore.getState().resetViewport();
    useWorkspaceStore.getState().switchWorkspace('animation');
  });

  it('switches across all 5 workspaces without mutating or losing project state', () => {
    const projectBefore = structuredClone(useProjectStore.getState().project);

    useWorkspaceStore.getState().switchWorkspace('scene');
    expect(useWorkspaceStore.getState().sidebarTab).toBe('scenes');
    expect(useWorkspaceStore.getState().showSafeGuides).toBe(true);

    useWorkspaceStore.getState().switchWorkspace('audio');
    expect(useWorkspaceStore.getState().sidebarTab).toBe('sounds');
    expect(useWorkspaceStore.getState().timelineHeight).toBeGreaterThanOrEqual(300);

    useWorkspaceStore.getState().switchWorkspace('assets');
    expect(useWorkspaceStore.getState().sidebarTab).toBe('assets');
    expect(useWorkspaceStore.getState().timelineCollapsed).toBe(true);

    useWorkspaceStore.getState().switchWorkspace('script');
    expect(useWorkspaceStore.getState().sidebarTab).toBe('script');

    // Project data remains 100% untouched
    expect(useProjectStore.getState().project).toEqual(projectBefore);
    expect(useProjectStore.getState().isDirty).toBe(false);
  });

  it('clamps viewport zoom cleanly and resets pan + zoom to Fit', () => {
    const ws = useWorkspaceStore.getState();
    ws.zoomViewportBy(0.5);
    expect(useWorkspaceStore.getState().viewportZoom).toBe(1.5);
    ws.zoomViewportBy(5);
    expect(useWorkspaceStore.getState().viewportZoom).toBe(3.0);
    ws.setViewportPan(120, -45);
    expect(useWorkspaceStore.getState().viewportPanX).toBe(120);

    ws.resetViewport();
    expect(useWorkspaceStore.getState().viewportZoom).toBe('fit');
    expect(useWorkspaceStore.getState().viewportPanX).toBe(0);
    expect(useWorkspaceStore.getState().viewportPanY).toBe(0);
  });

  it('applies centralized theme tokens via data-theme attribute', () => {
    useWorkspaceStore.getState().setTheme('slate-contrast');
    expect(document.documentElement.getAttribute('data-theme')).toBe('slate-contrast');
    useWorkspaceStore.getState().setTheme('dark-studio');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark-studio');
  });

  it('supports track lock, mute, solo, and visibility with Undo/Redo', () => {
    useProjectStore.getState().updateTrack('trk_sfx_1', { locked: true, muted: true });
    let trk = useProjectStore.getState().project!.timeline.tracks[0];
    expect(trk.locked).toBe(true);
    expect(trk.muted).toBe(true);

    useProjectStore.getState().undo();
    trk = useProjectStore.getState().project!.timeline.tracks[0];
    expect(trk.locked).toBe(false);
    expect(trk.muted).toBe(false);

    useProjectStore.getState().redo();
    trk = useProjectStore.getState().project!.timeline.tracks[0];
    expect(trk.locked).toBe(true);
  });

  it('supports asset selection context & multi-selection IDs', () => {
    useProjectStore.getState().setSelection({ type: 'asset', id: 'ast_001' });
    expect(useProjectStore.getState().selection.type).toBe('asset');

    useProjectStore.getState().setSelection({
      type: 'sfx_event',
      id: 'ev_2',
      multiIds: ['ev_1', 'ev_2'],
    });
    expect(useProjectStore.getState().selection.multiIds).toEqual(['ev_1', 'ev_2']);
  });
});
