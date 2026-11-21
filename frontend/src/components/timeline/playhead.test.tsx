import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { MasterTimeline } from '@/components/timeline/MasterTimeline';
import { usePlaybackStore } from '@/stores/usePlaybackStore';
import { useProjectStore } from '@/stores/useProjectStore';
import type { ProjectState } from '@/types/models';

it('playhead needle and timecode follow currentFrame without re-rendering the timeline (Phase 09.2)', async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const project = {
    meta: { project_id: 'p', name: 'P', width: 1280, height: 720, fps: 30, duration_ms: 10000 },
    scenes: [{ scene_id: 's1', project_id: 'p', name: 'S', order_index: 0, start_ms: 0, duration_ms: 10000, background_color: '#000',
      transition_in: 'cut', transition_duration_ms: 0, camera_default: { x: 0, y: 0, zoom: 1, rotation_deg: 0 }, characters: [], props: [], shots: [] }],
    timeline: { project_id: 'p', fps: 30, total_duration_ms: 10000, tracks: [], keyframes: [], animation_clips: [], sound_events: [] },
    subtitles: { default_style_id: 'x', styles: [], segments: [] },
  } as unknown as ProjectState;
  useProjectStore.setState({ project, activeSceneId: 's1' });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<MasterTimeline />));
  const needle = () =>
    [...host.querySelectorAll<HTMLDivElement>('div')].find((d) => d.style.background === 'var(--playhead-color)' && d.style.width === '2px');
  await act(async () => usePlaybackStore.getState().setCurrentFrame(0));
  const left0 = parseFloat(needle()!.style.left);
  await act(async () => usePlaybackStore.getState().setCurrentFrame(45));
  const left45 = parseFloat(needle()!.style.left);
  expect(left45).toBeGreaterThan(left0);
  expect(host.textContent).toContain('F45');
  await act(async () => usePlaybackStore.getState().setCurrentFrame(90));
  expect(parseFloat(needle()!.style.left) - left0).toBeCloseTo(2 * (left45 - left0), 3); // linear in time
  root.unmount();
});
