import { describe, expect, it } from 'vitest';
import type { ProjectState } from '@/types/models';
import { repackScenesPreservingContent } from './sceneTimeline';

const kf = (id: string, target_type: string, target_id: string, time_ms: number) =>
  ({ keyframe_id: id, track_id: 't', target_type, target_id, property: 'x', time_ms, value: 1, easing: 'linear' }) as never;

function project(): ProjectState {
  return {
    meta: { project_id: 'p' },
    scenes: [
      { scene_id: 's1', start_ms: 0, duration_ms: 4000, order_index: 0, characters: [{ instance_id: 'i1' }], props: [{ prop_instance_id: 'pr1' }] },
      { scene_id: 's2', start_ms: 4000, duration_ms: 3000, order_index: 1, characters: [{ instance_id: 'i2' }], props: [] },
      { scene_id: 's3', start_ms: 7000, duration_ms: 2000, order_index: 2, characters: [], props: [] },
    ],
    timeline: {
      total_duration_ms: 9000,
      keyframes: [
        kf('a', 'character_instance', 'i1', 1000),
        kf('b', 'character_part', 'i2:arm', 4500),
        kf('c', 'camera', 'camera', 5000),
        kf('d', 'camera', 'camera', 7500),
        kf('e', 'prop', 'pr1', 3000),
      ],
      animation_clips: [
        { clip_id: 'c1', instance_id: 'i1', start_ms: 0, end_ms: 4000 },
        { clip_id: 'c2', instance_id: 'i2', start_ms: 4000, end_ms: 7000 },
      ],
      sound_events: [
        { event_id: 'dlg2', source_scene_id: 's2', start_ms: 4200, end_ms: 5000 },
        { event_id: 'bgm', source_scene_id: null, start_ms: 7100, end_ms: 8000 },
        { event_id: 'sfx1', source_scene_id: null, start_ms: 500, end_ms: 900 },
      ],
    },
    subtitles: {
      segments: [
        { subtitle_id: 'sub1', scene_id: 's1', start_ms: 100, end_ms: 900 },
        { subtitle_id: 'sub2', scene_id: null, start_ms: 4300, end_ms: 5000 },
      ],
    },
  } as unknown as ProjectState;
}

const repack = (d: ProjectState) => {
  let cursor = 0;
  d.scenes.forEach((sc, i) => {
    sc.order_index = i;
    sc.start_ms = cursor;
    cursor += sc.duration_ms;
  });
};

describe('Scene re-pack keeps timeline content attached to its scene (Phase 09.1)', () => {
  it('deleting a scene removes its content and shifts later scenes content', () => {
    const p = project();
    repackScenesPreservingContent(p, (d) => {
      d.scenes = d.scenes.filter((s) => s.scene_id !== 's1');
      repack(d);
    });
    const times = Object.fromEntries(p.timeline.keyframes.map((k) => [k.keyframe_id, k.time_ms]));
    expect(times).toEqual({ b: 500, c: 1000, d: 3500 }); // a & e (scene 1 instances) removed
    expect(p.timeline.animation_clips.map((c) => [c.clip_id, c.start_ms, c.end_ms])).toEqual([['c2', 0, 3000]]);
    expect(p.timeline.sound_events.map((e) => [e.event_id, e.start_ms])).toEqual([['dlg2', 200], ['bgm', 3100]]);
    expect(p.subtitles!.segments.map((s) => [s.subtitle_id, s.start_ms])).toEqual([['sub2', 300]]);
  });

  it('lengthening a scene shifts only the later scenes content', () => {
    const p = project();
    repackScenesPreservingContent(p, (d) => {
      d.scenes[0].duration_ms = 5000;
      repack(d);
    });
    const times = Object.fromEntries(p.timeline.keyframes.map((k) => [k.keyframe_id, k.time_ms]));
    expect(times).toEqual({ a: 1000, b: 5500, c: 6000, d: 8500, e: 3000 });
    expect(p.timeline.sound_events.find((e) => e.event_id === 'sfx1')!.start_ms).toBe(500);
    expect(p.subtitles!.segments.find((s) => s.subtitle_id === 'sub2')!.end_ms).toBe(6000);
    expect(new Set(p.timeline.keyframes.map((k) => k.keyframe_id)).size).toBe(5); // stable IDs, no duplicates
  });
});
