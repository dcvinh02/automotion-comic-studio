// @vitest-environment node
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildSync } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { RECOVERY_FORMAT, RecoveryStore, type RecoveryPayload } from './recoveryStore';

const payload = (pid: string, at: string, text = 'Chưa lưu'): RecoveryPayload => ({
  format: RECOVERY_FORMAT, version: 1, project_id: pid, project_name: `Dự án ${pid}`, created_at: at, reason: 'save_failed',
  base_revisions: { subtitles: 3 }, dirty_sections: ['subtitles'],
  sections: { subtitles: { default_style_id: 'x', styles: [], segments: [{ subtitle_id: 's', text, start_ms: 0, end_ms: 500 }] } },
});

describe('RecoveryStore (Phase 09.3)', () => {
  it('detects a previous run killed with SIGKILL and recovers the data it wrote', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'amcs-rec-'));
    const bundle = join(dir, 'child.cjs');
    const entry = join(dir, 'child.ts');
    writeFileSync(entry, `
      import { RecoveryStore } from ${JSON.stringify(resolve(__dirname, 'recoveryStore.ts'))};
      const s = new RecoveryStore(process.argv[2]);
      s.beginSession();
      s.write(${JSON.stringify(payload('proj_aaa', '2026-11-21T10:00:00.000Z', 'Lời thoại chưa lưu'))});
      process.stdout.write('ready\\n');
      setInterval(() => {}, 1000); // keep running until killed
    `);
    buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'error' });
    const recDir = join(dir, 'recovery');
    const child = spawn(process.execPath, [bundle, recDir]);
    await new Promise<void>((res) => child.stdout.once('data', () => res()));
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));

    const store = new RecoveryStore(recDir);
    const status = store.beginSession();
    expect(status.previousRunCrashed).toBe(true);
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0].valid).toBe(true);
    expect((list[0].payload!.sections.subtitles as { segments: { text: string }[] }).segments[0].text).toBe('Lời thoại chưa lưu');
    // clean shutdown → next start does not report a crash
    store.endSession();
    expect(new RecoveryStore(recDir).beginSession().previousRunCrashed).toBe(false);
  }, 30_000);

  it('reports corrupt files without throwing, keeps projects separate and bounds retention', () => {
    const dir = mkdtempSync(join(tmpdir(), 'amcs-rec-'));
    const s = new RecoveryStore(dir);
    for (let i = 0; i < 5; i++) s.write(payload('proj_aaa', `2026-11-21T10:0${i}:00.000Z`, `v${i}`));
    s.write(payload('proj_bbb', '2026-11-21T11:00:00.000Z'));
    writeFileSync(join(dir, 'proj_ccc__broken.json'), '{"format":"amcs-recovery", "version": 1, "project_id": "proj_ccc", trunc');
    writeFileSync(join(dir, 'proj_ddd__x.json'), JSON.stringify({ ...payload('proj_eee', '2026-11-21T09:00:00.000Z') }));
    const list = s.list();
    const valid = list.filter((c) => c.valid);
    expect(valid.filter((c) => c.payload!.project_id === 'proj_aaa')).toHaveLength(3); // newest 3 kept
    expect(valid[0].payload!.project_id).toBe('proj_bbb'); // newest first across projects
    expect(valid.find((c) => c.payload!.project_id === 'proj_aaa')!.payload!.created_at).toBe('2026-11-21T10:04:00.000Z');
    const invalid = list.filter((c) => !c.valid);
    expect(invalid.map((c) => c.file).sort()).toEqual(['proj_ccc__broken.json', 'proj_ddd__x.json']);
    expect(invalid.find((c) => c.file === 'proj_ddd__x.json')!.error).toMatch(/does not match/);
    expect(s.clearProject('proj_aaa')).toBe(3);
    expect(s.delete('../../etc/passwd')).toBe(false);
    expect(s.delete('session.json')).toBe(false);
    expect(readdirSync(dir).some((f) => f.startsWith('proj_bbb__'))).toBe(true);
    expect(() => s.write({ ...payload('../evil', '2026-11-21T10:00:00.000Z') })).toThrow();
  });
});
