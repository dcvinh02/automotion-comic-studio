/**
 * Phase 09.2 — always-on performance guards with a synthetic large project. Thresholds are ~30×
 * above measured values; they catch re-introduced O(keyframes) per-lookup scans or a timeline that
 * re-renders entirely on every playback frame, not ordinary timing noise.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { MasterTimeline } from '@/components/timeline/MasterTimeline';
import { evaluateStageAtFrame } from '@/engine/evaluator';
import { usePlaybackStore } from '@/stores/usePlaybackStore';
import { useProjectStore } from '@/stores/useProjectStore';
import type { ProjectState } from '@/types/models';

function bigProject(scenes = 30): ProjectState {
  const sc = [];
  const kfs = [];
  for (let s = 0; s < scenes; s++) {
    const chars = [0, 1, 2].map((c) => ({
      instance_id: `s${s}c${c}`, scene_id: `s${s}`, character_id: 'none', display_name: `C${c}`, z_index: 10 + c, visible: true, locked: false,
      initial_transform: { x: 100 * c, y: 500, rotation_deg: 0, scale_x: 1, scale_y: 1, opacity: 1 }, default_eye_state: 'open', default_mouth_state: 'closed',
    }));
    sc.push({ scene_id: `s${s}`, project_id: 'p', name: `S${s}`, order_index: s, start_ms: s * 10000, duration_ms: 10000, background_color: '#000',
      transition_in: 'cut', transition_duration_ms: 0, camera_default: { x: 0, y: 0, zoom: 1, rotation_deg: 0 }, characters: chars, props: [], shots: [] });
    for (const ch of chars)
      for (const prop of ['x', 'y', 'rotation_deg', 'scale_x'])
        for (let k = 0; k < 15; k++)
          kfs.push({ keyframe_id: `${ch.instance_id}${prop}${k}`, track_id: 't', target_type: 'character_instance', target_id: ch.instance_id,
            property: prop, time_ms: s * 10000 + k * 600, value: k, easing: 'ease_in_out' });
  }
  return {
    meta: { project_id: 'p', name: 'Big', width: 1920, height: 1080, fps: 30, duration_ms: scenes * 10000 },
    scenes: sc,
    timeline: { project_id: 'p', fps: 30, total_duration_ms: scenes * 10000, tracks: [], keyframes: kfs, animation_clips: [], sound_events: [] },
    subtitles: { default_style_id: 'x', styles: [], segments: [] },
  } as unknown as ProjectState;
}

describe('Phase 09.2 performance guards', () => {
  it('stage evaluation is independent of total keyframe count (indexed lookups)', () => {
    const p = bigProject();
    expect(p.timeline.keyframes.length).toBe(5400);
    evaluateStageAtFrame(p, {}, 10, 30);
    const t = performance.now();
    for (let f = 0; f < 300; f++) evaluateStageAtFrame(p, {}, f * 30, 30);
    const perFrame = (performance.now() - t) / 300;
    expect(perFrame).toBeLessThan(1.5); // measured ~0.05 ms; the old full scan was ~12 ms here
  });

  it('a playback frame change does not re-render the whole timeline', async () => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useProjectStore.setState({ project: bigProject(), activeSceneId: 's0' });
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => root.render(<MasterTimeline />));
    const xs: number[] = [];
    for (let f = 1; f <= 9; f++) {
      const t = performance.now();
      await act(async () => usePlaybackStore.getState().setCurrentFrame(f));
      xs.push(performance.now() - t);
    }
    xs.sort((a, b) => a - b);
    expect(xs[4]).toBeLessThan(6); // measured ~0.2 ms; full timeline re-render was ~20 ms
    root.unmount();
  });
});
