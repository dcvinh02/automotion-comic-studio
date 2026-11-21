/**
 * Phase 09.2 — React render benchmark of the real MasterTimeline (jsdom).
 * Runs only when AMCS_STRESS_DIR points at a folder produced by tests/performance/bench_backend.py:
 *   AMCS_STRESS_DIR=/path npx vitest run src/perf
 */
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { MasterTimeline } from '@/components/timeline/MasterTimeline';
import { useProjectStore } from '@/stores/useProjectStore';
import { usePlaybackStore } from '@/stores/usePlaybackStore';
import type { ProjectState } from '@/types/models';

const dir = process.env.AMCS_STRESS_DIR;

describe.skipIf(!dir)('MasterTimeline render cost on the stress project', () => {
  it('measures mount, DOM size and per-frame playback re-render', async () => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    const state = JSON.parse(readFileSync(`${dir}/stress_state.json`, 'utf-8')) as ProjectState;
    useProjectStore.setState({ project: state, activeSceneId: state.scenes[0].scene_id });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    let t = performance.now();
    await act(async () => root.render(<MasterTimeline />));
    const mountMs = performance.now() - t;
    const nodes = host.querySelectorAll('*').length;
    const byClass: Record<string, number> = {};
    host.querySelectorAll('*').forEach((el) => {
      const c = (el.getAttribute('class') || el.tagName).split(' ')[0];
      byClass[c] = (byClass[c] ?? 0) + 1;
    });
    console.log('TIMELINE_CLASSES', JSON.stringify(Object.entries(byClass).sort((a, b) => b[1] - a[1]).slice(0, 12)));
    const times: number[] = [];
    for (let f = 1; f <= 15; f++) {
      t = performance.now();
      await act(async () => usePlaybackStore.getState().setCurrentFrame(f));
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    const frameMs = times[Math.floor(times.length / 2)];
    const out = { mount_ms: Math.round(mountMs), dom_nodes: nodes, playback_frame_rerender_ms: Math.round(frameMs * 10) / 10 };
    console.log('TIMELINE_BENCH', JSON.stringify(out));
    expect(nodes).toBeGreaterThan(0);
    root.unmount();
  }, 120_000);
});
