/**
 * Phase 09.2 frontend engine benchmark (real app code, run in Node via esbuild):
 *   esbuild bench_engine.ts --bundle --platform=node --alias:@=frontend/src --outfile=x.cjs && node x.cjs <out_dir>
 * Uses stress_state.json / stress_characters.json written by bench_backend.py.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { evaluateStageAtFrame } from '@/engine/evaluator';
import { reconcileProjectLayersAndTimeline } from '@/engine/layerSync';
import { dirtySections, takeSnapshot } from '@/engine/projectSync';
import type { Character, ProjectState } from '@/types/models';
import { useProjectStore } from '@/stores/useProjectStore';

const dir = process.argv[2];
const state = JSON.parse(readFileSync(`${dir}/stress_state.json`, 'utf-8')) as ProjectState;
const chars = JSON.parse(readFileSync(`${dir}/stress_characters.json`, 'utf-8')) as Character[];
const byId = Object.fromEntries(chars.map((c) => [c.character_id, c]));

function med(fn: () => void, n = 7): number {
  const xs: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    fn();
    xs.push(performance.now() - t);
  }
  xs.sort((a, b) => a - b);
  return Math.round(xs[Math.floor(n / 2)] * 100) / 100;
}

const frames = Array.from({ length: 30 }, (_, i) => 3700 + i);
const res: Record<string, number> = {};
res.evaluate_stage_per_frame_ms = Math.round((med(() => frames.forEach((f) => evaluateStageAtFrame(state, byId, f, 30)), 5) / frames.length) * 1000) / 1000;
res.structuredClone_project_ms = med(() => structuredClone(state));
res.mutateProject_equivalent_ms = med(() => {
  // what mutateProject() does on every single edit: snapshot clone + draft clone + reconcile
  structuredClone(state);
  const d = structuredClone(state);
  reconcileProjectLayersAndTimeline(d);
});
const snap = takeSnapshot(state);
res.takeSnapshot_ms = med(() => takeSnapshot(state));
res.dirtySections_ms = med(() => dirtySections(state, snap));
const heap0 = process.memoryUsage().heapUsed;
const undo: ProjectState[] = [];
for (let i = 0; i < 80; i++) undo.push(structuredClone(state));
res.undo_stack_80_heap_mb = Math.round((process.memoryUsage().heapUsed - heap0) / 1e6);
res.json_bytes = JSON.stringify(state).length;
// Real store: 80 keyframe edits through mutateProject (history recorded), retained heap after GC
const gc = (globalThis as unknown as { gc?: () => void }).gc;
undo.length = 0;
gc?.();
const h0 = process.memoryUsage().heapUsed;
useProjectStore.setState({ project: structuredClone(state), undoStack: [], redoStack: [] });
const kfIds = state.timeline.keyframes.slice(0, 80).map((k) => k.keyframe_id);
const editTimes: number[] = [];
for (const id of kfIds) {
  const t = performance.now();
  useProjectStore.getState().moveKeyframe(id, 1 + Math.floor(Math.random() * 300000));
  editTimes.push(performance.now() - t);
}
gc?.();
res.store_80_edits_retained_heap_mb = Math.round((process.memoryUsage().heapUsed - h0) / 1e6);
res.store_undo_depth = useProjectStore.getState().undoStack.length;
editTimes.sort((a, b) => a - b);
res.store_edit_median_ms = Math.round(editTimes[40] * 100) / 100;
console.log(JSON.stringify(res, null, 2));
writeFileSync(`${dir}/bench_frontend.json`, JSON.stringify(res, null, 2));
