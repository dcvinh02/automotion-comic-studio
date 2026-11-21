/**
 * Pure helpers for Production Queue task state machine action guards & QC filtering.
 * Mirrors backend VALID_TASK_TRANSITIONS so the UI NEVER exposes invalid task actions.
 */

import type {
  ProductionQCCategory,
  ProductionQCIssue,
  ProductionQCSeverity,
  ProductionQueueTask,
  ProductionTaskStatus,
} from '@/types/models';

export interface ValidTaskActions {
  canRetry: boolean;
  canSkip: boolean;
  canCancel: boolean;
  canInspectError: boolean;
  canOpenScene: boolean;
  canOpenShot: boolean;
}

export function getValidTaskActions(task: ProductionQueueTask): ValidTaskActions {
  const st = task.status;
  return {
    canRetry: st === 'failed' || st === 'needs_review' || st === 'cancelled' || st === 'skipped',
    canSkip: st === 'pending' || st === 'queued' || st === 'failed' || st === 'needs_review',
    canCancel: st === 'pending' || st === 'queued',
    canInspectError: Boolean(task.error_details) || task.warnings.length > 0 || task.blocked_by_task_ids.length > 0,
    canOpenScene: Boolean(task.stage_scene_id || task.scene_id),
    canOpenShot: Boolean(task.shot_id || task.production_shot_id),
  };
}

export type QueueFilterTab = 'all' | 'queued' | 'processing' | 'completed' | 'failed' | 'needs_review';

export function filterQueueTasks(
  tasks: ProductionQueueTask[],
  filter: QueueFilterTab,
): ProductionQueueTask[] {
  if (filter === 'all') return tasks;
  if (filter === 'queued') {
    return tasks.filter((t) => t.status === 'queued' || t.status === 'pending');
  }
  if (filter === 'processing') {
    return tasks.filter((t) => t.status === 'processing' || t.status === 'validating');
  }
  return tasks.filter((t) => t.status === filter);
}

export function computeQueueSummary(tasks: ProductionQueueTask[]) {
  const counts: Record<ProductionTaskStatus, number> = {
    pending: 0,
    queued: 0,
    validating: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    needs_review: 0,
    skipped: 0,
    cancelled: 0,
  };
  for (const t of tasks) {
    counts[t.status] = (counts[t.status] ?? 0) + 1;
  }
  const total = tasks.length;
  const settled = counts.completed + counts.failed + counts.needs_review + counts.skipped + counts.cancelled;
  const pct = total > 0 ? Math.round((settled / total) * 100) : 0;
  return { counts, total, settled, pct };
}

export function filterQCIssues(
  issues: ProductionQCIssue[],
  filters: {
    severity?: 'all' | ProductionQCSeverity;
    category?: 'all' | ProductionQCCategory;
    sceneId?: string;
    shotId?: string;
  },
): ProductionQCIssue[] {
  return issues.filter((iss) => {
    if (filters.severity && filters.severity !== 'all' && iss.severity !== filters.severity) {
      return false;
    }
    if (filters.category && filters.category !== 'all' && iss.category !== filters.category) {
      return false;
    }
    if (filters.sceneId && iss.scene_id !== filters.sceneId) {
      return false;
    }
    if (filters.shotId && iss.shot_id !== filters.shotId) {
      return false;
    }
    return true;
  });
}
