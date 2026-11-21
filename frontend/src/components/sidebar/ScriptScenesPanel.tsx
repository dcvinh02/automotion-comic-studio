import React, { useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Clapperboard,
  Clock,
  GripVertical,
  Plus,
  Trash2,
} from 'lucide-react';
import { EmptyState, formatTimecode } from '@/components/common/CommonUI';
import { getScriptTotalDurationMs } from '@/engine/scriptEngine';
import { useI18n } from '@/i18n/useLocaleStore';
import { useJobStore } from '@/stores/useJobStore';
import { useProjectStore } from '@/stores/useProjectStore';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';

export function ScriptScenesPanel() {
  const { t } = useI18n();
  const project = useProjectStore((s) => s.project);
  const activeScriptSceneId = useProjectStore((s) => s.activeScriptSceneId);
  const setActiveScriptSceneId = useProjectStore((s) => s.setActiveScriptSceneId);
  const updateScriptMeta = useProjectStore((s) => s.updateScriptMeta);
  const addScriptScene = useProjectStore((s) => s.addScriptScene);
  const deleteScriptScene = useProjectStore((s) => s.deleteScriptScene);
  const reorderScriptScenes = useProjectStore((s) => s.reorderScriptScenes);
  const moveScriptScene = useProjectStore((s) => s.moveScriptScene);
  const syncScriptScenesToStage = useProjectStore((s) => s.syncScriptScenesToStage);
  const setCenterMode = useWorkspaceStore((s) => s.setCenterMode);
  const pushToast = useJobStore((s) => s.pushToast);

  const [dragSceneId, setDragSceneId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; pos: 'before' | 'after' } | null>(null);

  if (!project) {
    return (
      <EmptyState
        title={t('common.noProject')}
        description={t('script.emptyDesc')}
      />
    );
  }

  const scriptDoc = project.script;
  const scenes = scriptDoc?.scenes ?? [];
  const resolvedActiveId = activeScriptSceneId ?? scenes[0]?.script_scene_id ?? null;
  const totalDurationMs = getScriptTotalDurationMs(scriptDoc);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Episode Title + Summary */}
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div className="field-row">
          <label className="field-label" htmlFor="script-episode-title">
            {t('script.episodeTitle')}
          </label>
          <input
            id="script-episode-title"
            type="text"
            value={scriptDoc?.episode_title ?? ''}
            placeholder={project.meta.name}
            onChange={(e) => updateScriptMeta({ episode_title: e.target.value })}
          />
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: 11,
            color: 'var(--text-secondary)',
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Clock size={12} /> {t('script.totalDuration')}
          </span>
          <span className="mono" style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
            {formatTimecode(totalDurationMs)}
          </span>
        </div>
      </div>

      {/* Script Scenes Header */}
      <div className="section-title" style={{ marginTop: 2 }}>
        <span>{t('script.scenesHeader', { count: scenes.length })}</span>
        <button
          type="button"
          className="btn-xs btn-primary"
          onClick={() => {
            addScriptScene();
            setCenterMode('script');
          }}
        >
          <Plus size={11} /> {t('script.addScene')}
        </button>
      </div>

      {scenes.length === 0 ? (
        <EmptyState
          title={t('script.emptyTitle')}
          description={t('script.emptyDesc')}
          action={
            <button
              type="button"
              className="btn-primary btn-xs"
              onClick={() => {
                addScriptScene();
                setCenterMode('script');
              }}
            >
              <Plus size={11} /> {t('script.addScene')}
            </button>
          }
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {scenes.map((sc, idx) => {
            const isSelected = sc.script_scene_id === resolvedActiveId;
            const dropClass =
              dropTarget?.id === sc.script_scene_id
                ? dropTarget.pos === 'before'
                  ? 'layer-drop-before'
                  : 'layer-drop-after'
                : '';

            return (
              <div
                key={sc.script_scene_id}
                draggable
                onDragStart={(e) => {
                  setDragSceneId(sc.script_scene_id);
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', sc.script_scene_id);
                }}
                onDragOver={(e) => {
                  if (!dragSceneId || dragSceneId === sc.script_scene_id) return;
                  e.preventDefault();
                  const rect = e.currentTarget.getBoundingClientRect();
                  const pos = e.clientY - rect.top < rect.height / 2 ? 'before' : 'after';
                  setDropTarget({ id: sc.script_scene_id, pos });
                }}
                onDragLeave={() => {
                  if (dropTarget?.id === sc.script_scene_id) setDropTarget(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragSceneId && dragSceneId !== sc.script_scene_id && dropTarget) {
                    reorderScriptScenes(dragSceneId, sc.script_scene_id, dropTarget.pos);
                  }
                  setDragSceneId(null);
                  setDropTarget(null);
                }}
                onDragEnd={() => {
                  setDragSceneId(null);
                  setDropTarget(null);
                }}
                className={`script-scene-item ${isSelected ? 'selected' : ''} ${dropClass}`}
                onClick={() => {
                  setActiveScriptSceneId(sc.script_scene_id);
                  setCenterMode('script');
                }}
              >
                <GripVertical
                  size={12}
                  style={{ color: 'var(--text-muted)', flexShrink: 0, cursor: 'grab' }}
                />
                <span className="badge mono" style={{ flexShrink: 0 }}>
                  #{idx + 1}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {sc.title || `Scene ${idx + 1}`}
                  </div>
                  <div
                    style={{
                      fontSize: 10,
                      color: 'var(--text-muted)',
                      display: 'flex',
                      gap: 6,
                      alignItems: 'center',
                    }}
                  >
                    <span>{t('script.linesCount', { count: sc.entries.length })}</span>
                    <span className="mono">{formatTimecode(sc.estimated_duration_ms)}</span>
                  </div>
                </div>
                <div
                  style={{ display: 'flex', gap: 2, flexShrink: 0 }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    className="btn-ghost btn-icon btn-xs"
                    disabled={idx === 0}
                    title={t('layer.moveUp')}
                    aria-label={t('layer.moveUp')}
                    onClick={() => moveScriptScene(sc.script_scene_id, -1)}
                  >
                    <ArrowUp size={11} />
                  </button>
                  <button
                    type="button"
                    className="btn-ghost btn-icon btn-xs"
                    disabled={idx === scenes.length - 1}
                    title={t('layer.moveDown')}
                    aria-label={t('layer.moveDown')}
                    onClick={() => moveScriptScene(sc.script_scene_id, 1)}
                  >
                    <ArrowDown size={11} />
                  </button>
                  <button
                    type="button"
                    className="btn-ghost btn-icon btn-xs"
                    title={t('script.deleteScene')}
                    aria-label={t('script.deleteScene')}
                    onClick={() => deleteScriptScene(sc.script_scene_id)}
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
