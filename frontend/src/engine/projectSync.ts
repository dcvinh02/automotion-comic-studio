/**
 * Phase 09.1 — Section-level project synchronisation between the editor and the backend.
 *
 * The backend is the source of truth for persisted project state; several backend services
 * (AI Director, Storyboard, Production Planner, Production Queue, QC, Scene/Animation execution)
 * write to it while the editor holds its own working copy. To avoid either side silently
 * overwriting the other:
 *   - the editor remembers the exact content of every section as last synced with the server
 *     (`SyncSnapshot.json`) plus the server revision it is based on (`SyncSnapshot.revisions`);
 *   - a save sends only the sections whose content differs from that snapshot (`dirtySections`);
 *   - server state (save responses, background changes) is merged per section: sections the
 *     user has not touched adopt the server version, locally edited sections are kept.
 * Content comparison (not object identity) is used because `mutateProject` deep-clones the whole
 * project on every edit; it can only over-report a section as dirty, never miss an edit.
 */
import type { ProjectState } from '@/types/models';

export const PROJECT_SECTIONS = [
  'meta',
  'scenes',
  'timeline',
  'script',
  'subtitles',
  'director',
  'storyboard',
  'production_plan',
  'production_queue',
  'qc_report',
] as const;
export type ProjectSection = (typeof PROJECT_SECTIONS)[number];

export interface SyncSnapshot {
  projectId: string;
  json: Record<ProjectSection, string>;
  revisions: Record<string, number>;
}

function sectionValue(state: ProjectState, sec: ProjectSection): unknown {
  if (sec === 'meta') {
    // updated_at is server-stamped on every save; it is not user content
    const { updated_at: _ignored, ...rest } = state.meta;
    return rest;
  }
  return (state as unknown as Record<string, unknown>)[sec] ?? null;
}

export function sectionJson(state: ProjectState, sec: ProjectSection): string {
  return JSON.stringify(sectionValue(state, sec));
}

export function takeSnapshot(state: ProjectState): SyncSnapshot {
  const json = {} as Record<ProjectSection, string>;
  for (const sec of PROJECT_SECTIONS) json[sec] = sectionJson(state, sec);
  return { projectId: state.meta.project_id, json, revisions: { ...(state.revisions ?? {}) } };
}

export function dirtySections(state: ProjectState, snap: SyncSnapshot | null): ProjectSection[] {
  if (!snap || snap.projectId !== state.meta.project_id) return [...PROJECT_SECTIONS];
  return PROJECT_SECTIONS.filter((sec) => sectionJson(state, sec) !== snap.json[sec]);
}

export interface MergeResult {
  project: ProjectState;
  snapshot: SyncSnapshot;
  /** Sections where the user's unsaved local edit was kept over a newer server version. */
  keptLocal: ProjectSection[];
  /** Sections whose server version was adopted into the editor. */
  adopted: ProjectSection[];
}

/**
 * Merge a server copy into the editor's working copy.
 * - Unedited sections (local == snapshot) adopt the server version when the server is newer.
 * - Locally edited sections are kept (they remain dirty and are saved next), unless
 *   `preferServer` is set (explicit server operations such as "Execute scene" whose result the
 *   user asked for), in which case the server version wins.
 */
export function mergeServerState(
  local: ProjectState,
  server: ProjectState,
  snap: SyncSnapshot | null,
  preferServer = false,
): MergeResult {
  const sameProject = snap && snap.projectId === server.meta.project_id && local.meta.project_id === server.meta.project_id;
  if (!sameProject) {
    return { project: server, snapshot: takeSnapshot(server), keptLocal: [], adopted: [...PROJECT_SECTIONS] };
  }
  const next = { ...local } as unknown as Record<string, unknown>;
  const json = { ...snap.json };
  const revisions = { ...snap.revisions };
  const keptLocal: ProjectSection[] = [];
  const adopted: ProjectSection[] = [];
  const serverRec = server as unknown as Record<string, unknown>;
  for (const sec of PROJECT_SECTIONS) {
    const localJson = sectionJson(local, sec);
    const serverJson = sectionJson(server, sec);
    const localEdited = localJson !== snap.json[sec];
    const serverRev = server.revisions?.[sec];
    const serverChanged = serverJson !== snap.json[sec];
    if (localEdited && serverJson !== localJson && (!serverChanged || !preferServer)) {
      // Keep the user's unsaved edit (and the old base revision, so a true concurrent change is
      // detected and backed up by the server on the next save).
      if (serverChanged) keptLocal.push(sec);
      continue;
    }
    if (sec === 'meta') next.meta = server.meta;
    else next[sec] = serverRec[sec] ?? null;
    json[sec] = serverJson;
    if (serverRev !== undefined) revisions[sec] = serverRev;
    if (serverJson !== localJson) adopted.push(sec);
  }
  next.revisions = { ...revisions };
  return {
    project: next as unknown as ProjectState,
    snapshot: { projectId: snap.projectId, json, revisions },
    keptLocal,
    adopted,
  };
}

/**
 * After a successful save of `sent` (with `dirty` sections), fold the server response into the
 * current working copy, preserving any edits made while the request was in flight.
 */
export function applySaveResponse(
  current: ProjectState,
  sent: ProjectState,
  saved: ProjectState,
  dirty: ProjectSection[],
  snap: SyncSnapshot | null,
): { project: ProjectState; snapshot: SyncSnapshot; stillDirty: boolean } {
  // What the server now holds for each section we sent is exactly what we sent.
  const base: SyncSnapshot = snap && snap.projectId === sent.meta.project_id ? { ...snap, json: { ...snap.json } } : takeSnapshot(sent);
  for (const sec of dirty) base.json[sec] = sectionJson(sent, sec);
  const merged = mergeServerState(current, saved, base, false);
  const stillDirty = dirtySections(merged.project, merged.snapshot).length > 0;
  return { project: merged.project, snapshot: merged.snapshot, stillDirty };
}
