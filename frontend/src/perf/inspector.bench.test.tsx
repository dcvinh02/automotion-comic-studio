import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { RightInspector } from '@/components/inspector/RightInspector';
import { usePlaybackStore } from '@/stores/usePlaybackStore';
import { useProjectStore } from '@/stores/useProjectStore';
import { useLibraryStore } from '@/stores/useLibraryStore';
import type { ProjectState } from '@/types/models';

const dir = process.env.AMCS_STRESS_DIR;
describe.skipIf(!dir)('RightInspector per-frame cost (stress project)', () => {
  it('measures playback re-render with a character selected', async () => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const state = JSON.parse(readFileSync(`${dir}/stress_state.json`, 'utf-8')) as ProjectState;
    useLibraryStore.setState({ characters: JSON.parse(readFileSync(`${dir}/stress_characters.json`, 'utf-8')) });
    const sc = state.scenes[0];
    useProjectStore.setState({ project: state, activeSceneId: sc.scene_id, selection: { type: 'character', id: sc.characters[0].instance_id } });
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => root.render(<RightInspector />));
    const xs: number[] = [];
    for (let f = 1; f <= 15; f++) {
      const t = performance.now();
      await act(async () => usePlaybackStore.getState().setCurrentFrame(f));
      xs.push(performance.now() - t);
    }
    xs.sort((a, b) => a - b);
    console.log('INSPECTOR_BENCH', JSON.stringify({ dom_nodes: host.querySelectorAll('*').length, playback_frame_rerender_ms: Math.round(xs[7] * 10) / 10 }));
    expect(host.childElementCount).toBeGreaterThan(0);
    root.unmount();
  }, 60_000);
});
