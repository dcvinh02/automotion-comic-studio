/**
 * Phase 09.3 — Recovery journal content (pure logic, shared by the editor and tests).
 *
 * A recovery payload contains only the project sections that differ from the last state synced
 * with the backend (`SyncSnapshot`), plus the server revisions that state was based on. Recovery
 * never edits project.db by itself: it is applied as unsaved edits (after a safety backup) or saved
 * as a brand-new project.
 */
import type { ProjectState } from '@/types/models';
import { dirtySections, type SyncSnapshot } from './projectSync';

export const RECOVERY_FORMAT = 'amcs-recovery';

export interface RecoveryPayload {
  format: typeof RECOVERY_FORMAT;
  version: 1;
  project_id: string;
  project_name: string;
  created_at: string;
  reason: string;
  base_revisions: Record<string, number>;
  dirty_sections: string[];
  sections: Record<string, unknown>;
}

export function buildRecoveryPayload(
  project: ProjectState,
  snapshot: SyncSnapshot | null,
  reason: string,
  now: Date = new Date(),
): RecoveryPayload | null {
  const dirty = dirtySections(project, snapshot);
  if (dirty.length === 0) return null;
  const sections: Record<string, unknown> = {};
  for (const sec of dirty) sections[sec] = (project as unknown as Record<string, unknown>)[sec] ?? null;
  return {
    format: RECOVERY_FORMAT,
    version: 1,
    project_id: project.meta.project_id,
    project_name: project.meta.name,
    created_at: now.toISOString(),
    reason,
    base_revisions: { ...(snapshot?.revisions ?? project.revisions ?? {}) },
    dirty_sections: dirty,
    sections,
  };
}

export interface AppliedRecovery {
  state: ProjectState;
  /** Sections the saved project changed after the recovery point (recovery would replace them). */
  newerOnServer: string[];
}

/** Overlay recovered sections onto the current saved project (pure; nothing is written). */
export function applyRecoveredSections(saved: ProjectState, payload: RecoveryPayload): AppliedRecovery {
  if (payload.project_id !== saved.meta.project_id) {
    throw new Error('Recovery data belongs to a different project.');
  }
  const next = { ...saved } as unknown as Record<string, unknown>;
  const newerOnServer: string[] = [];
  for (const sec of payload.dirty_sections) {
    const serverRev = saved.revisions?.[sec];
    const baseRev = payload.base_revisions[sec];
    if (serverRev !== undefined && baseRev !== undefined && serverRev > baseRev) newerOnServer.push(sec);
    next[sec] = sec === 'meta' ? { ...saved.meta, ...(payload.sections.meta as object), project_id: saved.meta.project_id } : payload.sections[sec];
  }
  return { state: next as unknown as ProjectState, newerOnServer };
}
