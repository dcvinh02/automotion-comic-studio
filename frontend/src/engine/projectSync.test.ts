import { describe, expect, it } from 'vitest';
import type { ProjectState } from '@/types/models';
import { applySaveResponse, dirtySections, mergeServerState, takeSnapshot } from './projectSync';

function base(): ProjectState {
  return {
    meta: { project_id: 'p1', name: 'Hẻm mưa', width: 1920, height: 1080, fps: 30, duration_ms: 8000, updated_at: 't0' },
    scenes: [{ scene_id: 's1', name: 'Cảnh 1', start_ms: 0, duration_ms: 4000 }],
    timeline: { project_id: 'p1', fps: 30, total_duration_ms: 8000, tracks: [], keyframes: [], animation_clips: [], sound_events: [] },
    script: { episode_title: 'Tập 1', raw_source_text: 'Mưa đêm.', scenes: [] },
    subtitles: { default_style_id: 'x', styles: [], segments: [] },
    director: null,
    storyboard: null,
    production_plan: null,
    production_queue: null,
    qc_report: null,
    revisions: { meta: 1, scenes: 1, timeline: 1, script: 1, subtitles: 1, director: 1, storyboard: 1, production_plan: 1, production_queue: 1, qc_report: 1 },
  } as unknown as ProjectState;
}
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

describe('Project section sync (Phase 09.1)', () => {
  it('detects only content changes, ignoring deep-cloned identical sections and updated_at', () => {
    const p = base();
    const snap = takeSnapshot(p);
    const c = clone(p);
    c.meta.updated_at = 't9';
    expect(dirtySections(c, snap)).toEqual([]);
    c.subtitles!.segments.push({ subtitle_id: 'a', text: 'Xin chào', start_ms: 0, end_ms: 500 } as never);
    expect(dirtySections(c, snap)).toEqual(['subtitles']);
  });

  it('adopts backend-written AI sections without discarding unsaved user edits', () => {
    const local = base();
    const snap = takeSnapshot(local);
    const edited = clone(local);
    edited.scenes[0].name = 'Cảnh mở đầu (đã sửa)';
    const server = clone(local);
    server.director = { status: 'analyzed' } as never;
    server.revisions = { ...server.revisions!, director: 2 };
    const res = mergeServerState(edited, server, snap);
    expect(res.project.director).toEqual({ status: 'analyzed' });
    expect(res.project.scenes[0].name).toBe('Cảnh mở đầu (đã sửa)');
    expect(res.adopted).toEqual(['director']);
    expect(res.keptLocal).toEqual([]);
    expect(dirtySections(res.project, res.snapshot)).toEqual(['scenes']);
    expect(res.snapshot.revisions.director).toBe(2);
  });

  it('keeps the local edit and the old base revision on a true concurrent change', () => {
    const local = base();
    const snap = takeSnapshot(local);
    const edited = clone(local);
    edited.scenes[0].duration_ms = 5000;
    const server = clone(local);
    server.scenes[0].duration_ms = 3000;
    server.revisions = { ...server.revisions!, scenes: 5 };
    const res = mergeServerState(edited, server, snap);
    expect(res.project.scenes[0].duration_ms).toBe(5000);
    expect(res.keptLocal).toEqual(['scenes']);
    expect(res.snapshot.revisions.scenes).toBe(1); // server will flag the conflict & back up its copy
    // An explicit server operation (preferServer) wins only for the sections it changed
    const explicit = mergeServerState(edited, server, snap, true);
    expect(explicit.project.scenes[0].duration_ms).toBe(3000);
  });

  it('explicit execution results never wipe unrelated unsaved edits', () => {
    const local = base();
    const snap = takeSnapshot(local);
    const edited = clone(local);
    edited.subtitles!.segments.push({ subtitle_id: 'u', text: 'Của tôi', start_ms: 0, end_ms: 400 } as never);
    const server = clone(local);
    server.scenes.push({ scene_id: 's2', name: 'Executed', start_ms: 4000, duration_ms: 4000 } as never);
    const res = mergeServerState(edited, server, snap, true);
    expect(res.project.scenes).toHaveLength(2);
    expect(res.project.subtitles!.segments).toHaveLength(1);
  });

  it('save response keeps edits made while the request was in flight', () => {
    const local = base();
    const snap = takeSnapshot(local);
    const sent = clone(local);
    sent.script!.raw_source_text = 'Mưa đêm. Gió lạnh.';
    const current = clone(sent);
    current.subtitles!.segments.push({ subtitle_id: 'late', text: 'Muộn', start_ms: 0, end_ms: 300 } as never);
    const saved = clone(sent);
    saved.meta.updated_at = 't1';
    saved.revisions = { ...saved.revisions!, script: 2 };
    const res = applySaveResponse(current, sent, saved, ['script'], snap);
    expect(res.project.script!.raw_source_text).toBe('Mưa đêm. Gió lạnh.');
    expect(res.project.subtitles!.segments.map((s) => s.subtitle_id)).toEqual(['late']);
    expect(res.stillDirty).toBe(true);
    expect(dirtySections(res.project, res.snapshot)).toEqual(['subtitles']);
    expect(res.project.meta.updated_at).toBe('t1');
    expect(res.snapshot.revisions.script).toBe(2);
  });

  it('switching projects never merges across projects', () => {
    const a = base();
    const b = clone(a);
    b.meta.project_id = 'p2';
    const res = mergeServerState(a, b, takeSnapshot(a));
    expect(res.project.meta.project_id).toBe('p2');
    expect(dirtySections(res.project, res.snapshot)).toEqual([]);
  });
});
