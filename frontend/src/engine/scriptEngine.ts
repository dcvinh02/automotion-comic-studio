/**
 * Pure Script Engine utilities — duration estimation, reordering, and non-destructive document helpers.
 * Mirrors backend/core/script_engine/service.py so frontend estimates match persisted values accurately.
 */
import type { ProjectState, ScriptDocument, ScriptEntry, ScriptScene } from '@/types/models';

export function createEmptyScriptDocument(episodeTitle = ''): ScriptDocument {
  return {
    episode_title: episodeTitle,
    raw_source_text: '',
    scenes: [],
    updated_at: new Date().toISOString(),
  };
}

export function ensureProjectScript(project: ProjectState): ScriptDocument {
  if (!project.script) {
    project.script = createEmptyScriptDocument(project.meta.name || '');
  }
  return project.script;
}

export function estimateScriptEntryDurationMs(entry: ScriptEntry): number {
  const pauseBefore = Math.max(0, Math.round(entry.pause_before_ms || 0));
  const pauseAfter = Math.max(0, Math.round(entry.pause_after_ms || 0));
  if (entry.audio_duration_ms && entry.audio_duration_ms > 0) {
    return pauseBefore + Math.round(entry.audio_duration_ms) + pauseAfter;
  }
  const trimmed = (entry.text || '').trim();
  const words = trimmed ? trimmed.split(/\s+/).length : 0;
  const speechMs =
    entry.entry_type === 'action'
      ? Math.max(1000, words * 220)
      : words > 0
        ? Math.max(1000, Math.round(words * 385))
        : 1000;
  return pauseBefore + speechMs + pauseAfter;
}

export function recalculateScriptDurations(doc: ScriptDocument): ScriptDocument {
  doc.scenes.forEach((scene, sIdx) => {
    scene.order_index = sIdx;
    let sceneTotal = 0;
    const seenChars = new Set<string>();
    scene.entries.forEach((entry, eIdx) => {
      entry.order_index = eIdx;
      entry.estimated_duration_ms = estimateScriptEntryDurationMs(entry);
      sceneTotal += entry.estimated_duration_ms;
      if (entry.character_id) {
        seenChars.add(entry.character_id);
      }
    });
    scene.estimated_duration_ms = sceneTotal;
    // Keep referenced character IDs up to date alongside any manually listed character IDs
    const existing = new Set(scene.character_ids ?? []);
    for (const cid of seenChars) existing.add(cid);
    scene.character_ids = Array.from(existing);
  });
  doc.updated_at = new Date().toISOString();
  return doc;
}

export function getScriptTotalDurationMs(doc: ScriptDocument | undefined): number {
  if (!doc) return 0;
  return doc.scenes.reduce((acc, sc) => acc + (sc.estimated_duration_ms || 0), 0);
}

export function reorderArrayByIds<T>(
  items: T[],
  getId: (item: T) => string,
  sourceId: string,
  targetId: string,
  position: 'before' | 'after',
): T[] | null {
  if (sourceId === targetId) return null;
  const srcIdx = items.findIndex((x) => getId(x) === sourceId);
  const tgtIdx = items.findIndex((x) => getId(x) === targetId);
  if (srcIdx === -1 || tgtIdx === -1) return null;

  const next = [...items];
  const [moved] = next.splice(srcIdx, 1);
  const newTgtIdx = next.findIndex((x) => getId(x) === targetId);
  if (newTgtIdx === -1) return null;
  const insertAt = position === 'before' ? newTgtIdx : newTgtIdx + 1;
  next.splice(insertAt, 0, moved);
  return next;
}

export function moveArrayItemByDelta<T>(items: T[], index: number, delta: -1 | 1): T[] | null {
  const nextIndex = index + delta;
  if (index < 0 || index >= items.length || nextIndex < 0 || nextIndex >= items.length) {
    return null;
  }
  const next = [...items];
  const [moved] = next.splice(index, 1);
  next.splice(nextIndex, 0, moved);
  return next;
}

export function findScriptSceneById(
  doc: ScriptDocument | undefined,
  sceneId: string | null,
): ScriptScene | undefined {
  if (!doc) return undefined;
  return doc.scenes.find((s) => s.script_scene_id === sceneId) ?? doc.scenes[0];
}
