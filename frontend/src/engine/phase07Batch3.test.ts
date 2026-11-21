import { describe, expect, it } from 'vitest';
import {
  computeQueueSummary,
  filterQCIssues,
  filterQueueTasks,
  getValidTaskActions,
} from '@/engine/productionQueueHelpers';
import {
  countSubtitleStyleOverrides,
  createDefaultSubtitleDocument,
  resolveEffectiveSubtitleStyle,
} from '@/engine/subtitleEngine';
import type { ProductionQCIssue, ProductionQueueTask, SubtitleSegment } from '@/types/models';

describe('Phase 07 Batch 3 — Timeline Subtitle Inspector & Override Isolation', () => {
  it('merges per-segment style_override cleanly without leaking to sibling subtitles', () => {
    const doc = createDefaultSubtitleDocument();
    const seg1: SubtitleSegment = {
      subtitle_id: 'sub_1',
      text: 'Edited on Timeline',
      start_ms: 0,
      end_ms: 2000,
      scene_id: 'sc_1',
      speaker_character_id: null,
      speaker_name: '',
      script_entry_id: null,
      voice_audio_asset_id: null,
      timing_source: 'manual',
      style_id: 'style_classic_white',
      position_override: null,
      style_override: {
        font_family: "Georgia, 'Noto Serif', serif",
        font_size: 58,
        italic: true,
        underline: true,
        letter_spacing: 2.5,
        text_color: '#38bdf8',
        outline_width: 5,
        shadow_opacity: 0.92,
        alignment: 'left',
        position: 'top',
        offset_x: 35,
        offset_y: -15,
        max_width_pct: 64,
        box_height_px: 110,
      },
      enabled: true,
    };
    const seg2: SubtitleSegment = {
      ...seg1,
      subtitle_id: 'sub_2',
      text: 'Sibling untouched',
      start_ms: 2500,
      end_ms: 4500,
      style_override: null,
    };

    const eff1 = resolveEffectiveSubtitleStyle(doc, seg1);
    const eff2 = resolveEffectiveSubtitleStyle(doc, seg2);

    expect(eff1.font_size).toBe(58);
    expect(eff1.italic).toBe(true);
    expect(eff1.underline).toBe(true);
    expect(eff1.letter_spacing).toBe(2.5);
    expect(eff1.text_color).toBe('#38bdf8');
    expect(eff1.alignment).toBe('left');
    expect(eff1.position).toBe('top');
    expect(eff1.box_height_px).toBe(110);
    expect(countSubtitleStyleOverrides(seg1)).toBe(14);

    // Zero state leakage to sibling subtitle
    expect(eff2.font_size).toBe(44);
    expect(eff2.italic).toBe(false);
    expect(eff2.underline).toBe(false);
    expect(eff2.text_color).toBe('#ffffff');
    expect(eff2.alignment).toBe('center');
    expect(eff2.position).toBe('bottom');
    expect(countSubtitleStyleOverrides(seg2)).toBe(0);
  });
});

describe('Phase 07 Batch 3 — Production Queue Task State Machine Action Guards & QC Filters', () => {
  const mkTask = (status: ProductionQueueTask['status'], extra?: Partial<ProductionQueueTask>): ProductionQueueTask => ({
    task_id: `t_${status}`,
    run_id: 'run_1',
    task_name: `Task ${status}`,
    task_type: 'scene_assembly',
    scene_id: 'sc_1',
    stage_scene_id: 'stg_1',
    scene_number: 1,
    scene_title: 'Scene 1',
    shot_id: 'sh_1',
    production_shot_id: 'psh_1',
    shot_number: 1,
    shot_title: 'Shot 1',
    status,
    progress_pct: status === 'completed' ? 100 : 0,
    depends_on_task_ids: [],
    blocked_by_task_ids: [],
    message: '',
    error_details: status === 'failed' ? 'Disk error' : null,
    warnings: [],
    retry_count: 0,
    result_summary: {},
    timeline_time_ms: 0,
    started_at: null,
    completed_at: null,
    created_at: '2026-11-21T00:00:00Z',
    ...extra,
  });

  it('exposes strictly valid actions per task state', () => {
    expect(getValidTaskActions(mkTask('queued'))).toMatchObject({
      canRetry: false,
      canSkip: true,
      canCancel: true,
    });
    expect(getValidTaskActions(mkTask('processing'))).toMatchObject({
      canRetry: false,
      canSkip: false,
      canCancel: false,
    });
    expect(getValidTaskActions(mkTask('completed'))).toMatchObject({
      canRetry: false,
      canSkip: false,
      canCancel: false,
      canOpenScene: true,
      canOpenShot: true,
    });
    expect(getValidTaskActions(mkTask('failed'))).toMatchObject({
      canRetry: true,
      canSkip: true,
      canCancel: false,
      canInspectError: true,
    });
    expect(getValidTaskActions(mkTask('needs_review', { blocked_by_task_ids: ['t_failed'] }))).toMatchObject({
      canRetry: true,
      canSkip: true,
      canInspectError: true,
    });
  });

  it('filters queue tasks and summarizes completion percentage accurately', () => {
    const tasks = [
      mkTask('completed'),
      mkTask('completed'),
      mkTask('failed'),
      mkTask('queued'),
    ];
    expect(filterQueueTasks(tasks, 'completed')).toHaveLength(2);
    expect(filterQueueTasks(tasks, 'failed')).toHaveLength(1);
    expect(filterQueueTasks(tasks, 'queued')).toHaveLength(1);
    const sum = computeQueueSummary(tasks);
    expect(sum.total).toBe(4);
    expect(sum.settled).toBe(3);
    expect(sum.pct).toBe(75);
  });

  it('filters 8-category QC issues by severity, category, and scene', () => {
    const issues: ProductionQCIssue[] = [
      {
        issue_id: 'i1',
        code: 'MISSING_ASSET',
        category: 'asset',
        severity: 'error',
        title: 'Missing BG',
        description: 'BG missing',
        scene_id: 'sc_1',
        scene_number: 1,
        shot_id: null,
        shot_number: null,
        asset_id: 'a1',
        subtitle_id: null,
        sound_event_id: null,
        task_id: null,
        time_ms: 0,
        root_cause: 'File deleted',
        recommended_action: 'Reassign',
        nav_target: 'assets',
        fix_action: null,
      },
      {
        issue_id: 'i2',
        code: 'SUBTITLE_OUTSIDE_SAFE_AREA',
        category: 'subtitle',
        severity: 'warning',
        title: 'Safe area',
        description: 'Subtitle near edge',
        scene_id: 'sc_2',
        scene_number: 2,
        shot_id: null,
        shot_number: null,
        asset_id: null,
        subtitle_id: 'sub_1',
        sound_event_id: null,
        task_id: null,
        time_ms: 1000,
        root_cause: 'Safe clamp off',
        recommended_action: 'Enable clamp',
        nav_target: 'timeline',
        fix_action: 'enable_subtitle_safe_area',
      },
    ];
    expect(filterQCIssues(issues, { severity: 'error' })).toHaveLength(1);
    expect(filterQCIssues(issues, { category: 'subtitle' })).toHaveLength(1);
    expect(filterQCIssues(issues, { sceneId: 'sc_2' })).toHaveLength(1);
  });
});
