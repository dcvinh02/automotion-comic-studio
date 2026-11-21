import { beforeEach, describe, expect, it } from 'vitest';
import { useProjectStore } from '@/stores/useProjectStore';
import type { ProjectState } from '@/types/models';
import { shareUnchanged } from './structuralShare';

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

function project(): ProjectState {
  const kfs = Array.from({ length: 300 }, (_, i) => ({
    keyframe_id: `kf${i}`, track_id: 'trk_char_inst1', target_type: 'character_instance', target_id: 'inst1',
    property: 'x', time_ms: i * 100, value: i, easing: 'linear',
  }));
  return {
    meta: { project_id: 'p', name: 'P', width: 1280, height: 720, fps: 30, duration_ms: 30000, updated_at: 't' },
    scenes: [
      { scene_id: 's1', project_id: 'p', name: 'Một', order_index: 0, start_ms: 0, duration_ms: 15000, background_color: '#000',
        transition_in: 'cut', transition_duration_ms: 0, camera_default: { x: 0, y: 0, zoom: 1, rotation_deg: 0 },
        characters: [{ instance_id: 'inst1', scene_id: 's1', character_id: 'c1', display_name: 'A', z_index: 10, visible: true, locked: false,
          initial_transform: { x: 1, y: 2, rotation_deg: 0, scale_x: 1, scale_y: 1, opacity: 1 }, default_eye_state: 'open', default_mouth_state: 'closed' }],
        props: [], shots: [] },
      { scene_id: 's2', project_id: 'p', name: 'Hai', order_index: 1, start_ms: 15000, duration_ms: 15000, background_color: '#111',
        transition_in: 'cut', transition_duration_ms: 0, camera_default: { x: 0, y: 0, zoom: 1, rotation_deg: 0 }, characters: [], props: [], shots: [] },
    ],
    timeline: { project_id: 'p', fps: 30, total_duration_ms: 30000, tracks: [], keyframes: kfs, animation_clips: [], sound_events: [] },
    subtitles: { default_style_id: 'x', styles: [], segments: [] },
    script: { episode_title: 'T', raw_source_text: '', scenes: [] },
  } as unknown as ProjectState;
}

describe('Structural sharing & immutable history (Phase 09.2)', () => {
  beforeEach(() => {
    useProjectStore.setState({ project: null, undoStack: [], redoStack: [], syncSnapshot: null });
  });

  it('shareUnchanged reuses untouched sub-trees and keeps changed ones', () => {
    const a = project();
    const b = structuredClone(a);
    b.timeline.keyframes[5] = { ...b.timeline.keyframes[5], value: 999 };
    const out = shareUnchanged(a, b);
    expect(out).not.toBe(a);
    expect(out.scenes).toBe(a.scenes);
    expect(out.subtitles).toBe(a.subtitles);
    expect(out.timeline.keyframes[4]).toBe(a.timeline.keyframes[4]);
    expect(out.timeline.keyframes[5]).not.toBe(a.timeline.keyframes[5]);
    expect(out.timeline.keyframes[5].value).toBe(999);
    // deletion keeps the remaining elements shared by ID
    const c = structuredClone(a);
    c.timeline.keyframes.splice(10, 1);
    const out2 = shareUnchanged(a, c);
    expect(out2.timeline.keyframes[10]).toBe(a.timeline.keyframes[11]);
    expect(shareUnchanged(a, structuredClone(a))).toBe(a);
  });

  it('store actions never mutate committed (frozen) states and undo/redo restore exact content', () => {
    const p = deepFreeze(project());
    useProjectStore.setState({ project: p });
    const st = () => useProjectStore.getState();
    const history: string[] = [JSON.stringify(st().project)];
    const act = (fn: () => void) => {
      deepFreeze(st().project); // any in-place mutation of a committed state would throw
      fn();
      history.push(JSON.stringify(st().project));
    };
    act(() => st().updateCharacterInstance('s1', 'inst1', { initial_transform: { x: 50, y: 60, rotation_deg: 5, scale_x: 1, scale_y: 1, opacity: 1 } }));
    act(() => st().upsertKeyframe({ track_id: 'trk_char_inst1', target_type: 'character_instance', target_id: 'inst1', property: 'y', time_ms: 500, value: 42 }));
    act(() => st().moveKeyframe('kf3', 333));
    act(() => st().deleteKeyframes(['kf7', 'kf8']));
    act(() => st().updateScene('s1', { duration_ms: 12000 }));
    act(() => { st().addSubtitleSegment({ text: 'Xin chào', start_ms: 0, end_ms: 800 }); });
    act(() => st().addScene('Ba', 5000));
    act(() => st().deleteScene('s2'));
    // history snapshots are shared, not copied: an unrelated section is the very same object
    expect(st().undoStack.length).toBe(8);
    expect(st().undoStack[1].script).toBe(st().undoStack[0].script);
    for (let i = history.length - 2; i >= 0; i--) {
      deepFreeze(st().project);
      st().undo();
      expect(JSON.stringify(st().project)).toBe(history[i]);
    }
    for (let i = 1; i < history.length; i++) {
      st().redo();
      expect(JSON.stringify(st().project)).toBe(history[i]);
    }
  });
});
