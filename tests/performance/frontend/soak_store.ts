import { readFileSync } from 'node:fs';
import { useProjectStore } from '@/stores/useProjectStore';
import { evaluateStageAtFrame } from '@/engine/evaluator';
const dir = process.argv[2];
const state = JSON.parse(readFileSync(`${dir}/stress_state.json`, 'utf-8'));
const chars = Object.fromEntries(JSON.parse(readFileSync(`${dir}/stress_characters.json`, 'utf-8')).map((c: { character_id: string }) => [c.character_id, c]));
const gc = (globalThis as unknown as { gc: () => void }).gc;
gc(); const h0 = process.memoryUsage().heapUsed;
useProjectStore.setState({ project: state, undoStack: [], redoStack: [] });
const ids = state.timeline.keyframes.map((k: { keyframe_id: string }) => k.keyframe_id);
const out: string[] = [];
for (let i = 1; i <= 400; i++) {
  useProjectStore.getState().moveKeyframe(ids[i % ids.length], 1 + ((i * 7919) % 390000));
  if (i % 20 === 0) for (let f = 0; f < 300; f++) evaluateStageAtFrame(useProjectStore.getState().project!, chars, f * 40, 30); // scrub across scenes
  if ([80, 160, 240, 320, 400].includes(i)) { gc(); out.push(`edits=${i}: retained ${((process.memoryUsage().heapUsed - h0) / 1e6).toFixed(1)} MB, undo=${useProjectStore.getState().undoStack.length}`); }
}
console.log(out.join('\n'));
