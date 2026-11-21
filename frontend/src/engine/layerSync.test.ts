import { beforeEach, describe, expect, it } from 'vitest';
import {
  getOrderedSceneLayers,
  reconcileProjectLayersAndTimeline,
} from './layerSync';
import { clampAndRoundNumber, parseValidNumber } from '@/components/ui/PropertyControls';
import { useProjectStore } from '@/stores/useProjectStore';
import type { ProjectState } from '@/types/models';

function makeEmptyProject(): ProjectState {
  return {
    meta: {
      project_id: 'proj_layer_sync',
      name: 'Layer Sync Test',
      description: '',
      schema_version: '0.1.0',
      width: 1920,
      height: 1080,
      fps: 30,
      duration_ms: 10000,
      default_export_preset_id: 'preset_1080p_final',
      auto_save_enabled: false,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
    scenes: [
      {
        scene_id: 'sc_1',
        project_id: 'proj_layer_sync',
        order_index: 0,
        name: 'Scene 1',
        start_ms: 0,
        duration_ms: 10000,
        background_asset_id: null,
        background_color: '#14161A',
        transition_in: 'cut',
        transition_duration_ms: 0,
        camera_default: { x: 0, y: 0, zoom: 1, rotation_deg: 0 },
        characters: [],
        props: [],
      },
    ],
    timeline: {
      project_id: 'proj_layer_sync',
      fps: 30,
      total_duration_ms: 10000,
      tracks: [
        {
          track_id: 'trk_scene',
          project_id: 'proj_layer_sync',
          track_type: 'scene',
          name: 'Scene / Background',
          target_ref_id: null,
          order_index: 0,
          muted: false,
          locked: false,
          solo: false,
          visible: true,
          volume: 1,
          collapsed: false,
        },
        {
          track_id: 'trk_cam',
          project_id: 'proj_layer_sync',
          track_type: 'camera',
          name: 'Camera',
          target_ref_id: 'camera',
          order_index: 1,
          muted: false,
          locked: false,
          solo: false,
          visible: true,
          volume: 1,
          collapsed: false,
        },
        {
          track_id: 'trk_sfx_1',
          project_id: 'proj_layer_sync',
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
}

describe('Phase 04 Priority Zero — Layer & Timeline Sync + Z-Order', () => {
  beforeEach(() => {
    const project = makeEmptyProject();
    reconcileProjectLayersAndTimeline(project);
    useProjectStore.setState({
      project,
      activeSceneId: 'sc_1',
      selection: { type: 'none', id: null },
      selectedKeyframeId: null,
      copiedKeyframe: null,
      undoStack: [],
      redoStack: [],
      isDirty: false,
    });
  });

  it('syncs new props, characters, and empty layers immediately into Timeline with non-colliding order_index', () => {
    const store = useProjectStore.getState();
    store.addPropToScene('sc_1', 'ast_bg_tree', 'Tree');
    store.addCharacterToScene('sc_1', 'char_1', 'Hero Minh');
    const emptyId = store.addEmptyLayer('sc_1', 'FX Empty Layer');

    const proj = useProjectStore.getState().project!;
    const layers = getOrderedSceneLayers(proj.scenes[0]);
    expect(layers).toHaveLength(3);
    // Most recently added layer starts at top (frontmost)
    expect(layers[0].id).toBe(emptyId);
    expect(layers[0].kind).toBe('empty');

    const visualTracks = proj.timeline.tracks.filter(
      (t) => t.track_type === 'character' || t.track_type === 'prop',
    );
    expect(visualTracks).toHaveLength(3);
    // Timeline visual track order matches Layer Panel front-to-back order 1:1
    expect(visualTracks.map((t) => t.target_ref_id)).toEqual(layers.map((l) => l.id));
    // SFX track remains cleanly below all visual layers (no order_index=10 collision!)
    const sfxTrack = proj.timeline.tracks.find((t) => t.track_type === 'sfx')!;
    expect(sfxTrack.order_index).toBeGreaterThan(visualTracks[visualTracks.length - 1].order_index);
  });

  it('synchronizes rename, visibility, and lock bidirectionally across Layer Panel and Timeline', () => {
    const store = useProjectStore.getState();
    store.addPropToScene('sc_1', 'ast_1', 'Lamp');
    const propId = useProjectStore.getState().project!.scenes[0].props[0].prop_instance_id;

    // Rename from Layer Panel -> updates Timeline track name
    useProjectStore.getState().renameLayer('sc_1', 'prop', propId, 'Vintage Lamp');
    let proj = useProjectStore.getState().project!;
    let trk = proj.timeline.tracks.find((t) => t.target_ref_id === propId)!;
    expect(trk.name).toBe('Vintage Lamp');

    // Hide & Lock from Timeline -> updates Scene Prop instance
    useProjectStore.getState().updateTrack(trk.track_id, { visible: false, locked: true });
    proj = useProjectStore.getState().project!;
    const prop = proj.scenes[0].props.find((p) => p.prop_instance_id === propId)!;
    expect(prop.visible).toBe(false);
    expect(prop.locked).toBe(true);

    // Unhide & Unlock via Layer action -> updates Timeline track
    useProjectStore.getState().setLayerVisibility('sc_1', 'prop', propId, true);
    useProjectStore.getState().setLayerLocked('sc_1', 'prop', propId, false);
    proj = useProjectStore.getState().project!;
    trk = proj.timeline.tracks.find((t) => t.target_ref_id === propId)!;
    expect(trk.visible).toBe(true);
    expect(trk.locked).toBe(false);
  });

  it('reorders layers via drag-and-drop and step commands while preserving keyframes & animation clips', () => {
    const store = useProjectStore.getState();
    store.addPropToScene('sc_1', 'ast_a', 'Layer A');
    store.addCharacterToScene('sc_1', 'char_1', 'Hero');
    store.addPropToScene('sc_1', 'ast_b', 'Layer B');

    let proj = useProjectStore.getState().project!;
    const charInst = proj.scenes[0].characters[0];
    const propA = proj.scenes[0].props[0];
    const propB = proj.scenes[0].props[1];
    const charTrack = proj.timeline.tracks.find((t) => t.target_ref_id === charInst.instance_id)!;

    // Add keyframes on Hero
    useProjectStore.getState().upsertKeyframe({
      track_id: charTrack.track_id,
      target_type: 'character_instance',
      target_id: charInst.instance_id,
      property: 'x',
      time_ms: 0,
      value: 300,
    });
    useProjectStore.getState().upsertKeyframe({
      track_id: charTrack.track_id,
      target_type: 'character_instance',
      target_id: charInst.instance_id,
      property: 'x',
      time_ms: 2000,
      value: 900,
    });

    // Initial front-to-back order: Layer B (front), Hero (middle), Layer A (back)
    let ordered = getOrderedSceneLayers(useProjectStore.getState().project!.scenes[0]);
    expect(ordered.map((l) => l.id)).toEqual([
      propB.prop_instance_id,
      charInst.instance_id,
      propA.prop_instance_id,
    ]);

    // Drag Layer A before Layer B (to front!)
    expect(
      useProjectStore.getState().reorderSceneLayer('sc_1', propA.prop_instance_id, propB.prop_instance_id, 'before'),
    ).toBe(true);
    proj = useProjectStore.getState().project!;
    ordered = getOrderedSceneLayers(proj.scenes[0]);
    expect(ordered.map((l) => l.id)).toEqual([
      propA.prop_instance_id,
      propB.prop_instance_id,
      charInst.instance_id,
    ]);
    // Verify Canvas z_index reflects new order (A > B > Hero)
    const zA = proj.scenes[0].props.find((p) => p.prop_instance_id === propA.prop_instance_id)!.z_index;
    const zB = proj.scenes[0].props.find((p) => p.prop_instance_id === propB.prop_instance_id)!.z_index;
    const zH = proj.scenes[0].characters[0].z_index;
    expect(zA).toBeGreaterThan(zB);
    expect(zB).toBeGreaterThan(zH);

    // Send Layer A to back, bring Hero to front
    expect(useProjectStore.getState().moveSceneLayer('sc_1', charInst.instance_id, 'front')).toBe(true);
    proj = useProjectStore.getState().project!;
    expect(getOrderedSceneLayers(proj.scenes[0])[0].id).toBe(charInst.instance_id);

    // Verify Hero's keyframes & animation clips survived reordering intact!
    expect(proj.timeline.keyframes).toHaveLength(2);
    expect(proj.timeline.keyframes[0].target_id).toBe(charInst.instance_id);
    expect(proj.timeline.animation_clips).toHaveLength(1);
    expect(proj.timeline.animation_clips[0].instance_id).toBe(charInst.instance_id);

    // Undo restores previous stacking order cleanly
    useProjectStore.getState().undo();
    expect(getOrderedSceneLayers(useProjectStore.getState().project!.scenes[0])[0].id).toBe(
      propA.prop_instance_id,
    );
  });

  it('validates numeric inspector inputs safely without NaN or Infinity', () => {
    expect(parseValidNumber('420')).toBe(420);
    expect(parseValidNumber('-720.5', { precision: 1 })).toBe(-720.5); // unbounded continuous rotation
    expect(parseValidNumber('150', { min: 0, max: 100, precision: 0 })).toBe(100);
    expect(parseValidNumber('abc')).toBeNull();
    expect(parseValidNumber('')).toBeNull();
    expect(parseValidNumber('Infinity')).toBeNull();
    expect(parseValidNumber('NaN')).toBeNull();
    expect(clampAndRoundNumber(-0, { precision: 2 })).toBe(0);
  });
});
