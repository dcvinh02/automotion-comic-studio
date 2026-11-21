import React, { useState } from 'react';
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  Box,
  Clapperboard,
  Edit3,
  Eye,
  EyeOff,
  Film,
  FolderPlus,
  GripVertical,
  Image as ImageIcon,
  Lock,
  Plus,
  Trash2,
  Unlock,
  Users,
} from 'lucide-react';
import { msToFrame } from '@/engine/evaluator';
import { getOrderedSceneLayers, type UnifiedSceneLayer } from '@/engine/layerSync';
import { useI18n } from '@/i18n/useLocaleStore';
import { useJobStore } from '@/stores/useJobStore';
import { useLibraryStore } from '@/stores/useLibraryStore';
import { usePlaybackStore } from '@/stores/usePlaybackStore';
import { useProjectStore } from '@/stores/useProjectStore';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';
import { EmptyState, formatTimecode } from '@/components/common/CommonUI';
import type { TransitionType } from '@/types/models';

export function ScenesPanel() {
  const { t } = useI18n();
  const project = useProjectStore((s) => s.project);
  const activeSceneId = useProjectStore((s) => s.activeSceneId);
  const activeShotId = useProjectStore((s) => s.activeShotId);
  const setActiveSceneId = useProjectStore((s) => s.setActiveSceneId);
  const setActiveShotId = useProjectStore((s) => s.setActiveShotId);
  const setSelection = useProjectStore((s) => s.setSelection);
  const selection = useProjectStore((s) => s.selection);
  const addScene = useProjectStore((s) => s.addScene);
  const updateScene = useProjectStore((s) => s.updateScene);
  const deleteScene = useProjectStore((s) => s.deleteScene);
  const addEmptyLayer = useProjectStore((s) => s.addEmptyLayer);
  const removeCharacterInstance = useProjectStore((s) => s.removeCharacterInstance);
  const removePropInstance = useProjectStore((s) => s.removePropInstance);
  const renameLayer = useProjectStore((s) => s.renameLayer);
  const setLayerVisibility = useProjectStore((s) => s.setLayerVisibility);
  const setLayerLocked = useProjectStore((s) => s.setLayerLocked);
  const reorderSceneLayer = useProjectStore((s) => s.reorderSceneLayer);
  const moveSceneLayer = useProjectStore((s) => s.moveSceneLayer);
  const groupScenePropsIntoCharacter = useProjectStore((s) => s.groupScenePropsIntoCharacter);

  const assets = useLibraryStore((s) => s.assets);
  const upsertCharacter = useLibraryStore((s) => s.upsertCharacter);
  const pushToast = useJobStore((s) => s.pushToast);
  const setCurrentFrame = usePlaybackStore((s) => s.setCurrentFrame);
  const openContextMenu = useWorkspaceStore((s) => s.openContextMenu);

  const [dragLayerId, setDragLayerId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; position: 'before' | 'after' } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  if (!project) {
    return (
      <EmptyState
        title={t('stage.noProjectTitle')}
        description={t('stage.noProjectDesc')}
      />
    );
  }

  const bgAssets = assets.filter((a) => a.type === 'background' || a.type === 'prop');
  const activeScene =
    project.scenes.find((s) => s.scene_id === activeSceneId) ?? project.scenes[0] ?? null;

  const orderedLayers = activeScene ? getOrderedSceneLayers(activeScene) : [];
  const layerNameById = new Map(orderedLayers.map((l) => [l.id, l.name]));

  const startRename = (layer: UnifiedSceneLayer) => {
    setRenamingId(layer.id);
    setRenameDraft(layer.name);
  };

  const commitRename = (layer: UnifiedSceneLayer) => {
    if (activeScene && renameDraft.trim()) {
      renameLayer(
        activeScene.scene_id,
        layer.kind === 'character' ? 'character' : 'prop',
        layer.id,
        renameDraft.trim(),
      );
    }
    setRenamingId(null);
  };

  const openLayerContextMenu = (layer: UnifiedSceneLayer, e: React.MouseEvent) => {
    if (!activeScene) return;
    e.preventDefault();
    e.stopPropagation();
    const selType = layer.kind === 'character' ? 'character' : 'prop';
    setSelection({ type: selType, id: layer.id });

    openContextMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          id: 'bring-front',
          label: t('layer.bringToFront'),
          icon: <ArrowUpToLine size={12} />,
          onSelect: () => moveSceneLayer(activeScene.scene_id, layer.id, 'front'),
        },
        {
          id: 'move-up',
          label: t('layer.moveUp'),
          icon: <ArrowUp size={12} />,
          onSelect: () => moveSceneLayer(activeScene.scene_id, layer.id, 'up'),
        },
        {
          id: 'move-down',
          label: t('layer.moveDown'),
          icon: <ArrowDown size={12} />,
          onSelect: () => moveSceneLayer(activeScene.scene_id, layer.id, 'down'),
        },
        {
          id: 'send-back',
          label: t('layer.sendToBack'),
          icon: <ArrowDownToLine size={12} />,
          onSelect: () => moveSceneLayer(activeScene.scene_id, layer.id, 'back'),
        },
        { id: 'div-1', divider: true },
        {
          id: 'rename',
          label: t('layer.rename'),
          icon: <Edit3 size={12} />,
          onSelect: () => startRename(layer),
        },
        {
          id: 'toggle-vis',
          label: layer.visible ? t('layer.hideLayer') : t('layer.showLayer'),
          icon: layer.visible ? <EyeOff size={12} /> : <Eye size={12} />,
          onSelect: () =>
            setLayerVisibility(activeScene.scene_id, selType, layer.id, !layer.visible),
        },
        {
          id: 'toggle-lock',
          label: layer.locked ? t('layer.unlockLayer') : t('layer.lockLayer'),
          icon: layer.locked ? <Unlock size={12} /> : <Lock size={12} />,
          onSelect: () =>
            setLayerLocked(activeScene.scene_id, selType, layer.id, !layer.locked),
        },
        { id: 'div-2', divider: true },
        {
          id: 'delete-layer',
          label:
            layer.kind === 'character' ? t('stage.ctxRemoveChar') : t('stage.ctxRemoveProp'),
          icon: <Trash2 size={12} />,
          danger: true,
          onSelect: () => {
            if (layer.kind === 'character') {
              removeCharacterInstance(activeScene.scene_id, layer.id);
            } else {
              removePropInstance(activeScene.scene_id, layer.id);
            }
          },
        },
      ],
    });
  };

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: 600, color: 'var(--text-secondary)', fontSize: 11 }}>
          {t('scenes.header', { count: project.scenes.length })}
        </span>
        <button className="btn-primary" onClick={() => addScene()}>
          <Plus size={13} /> {t('scenes.addScene')}
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {project.scenes.map((scene, idx) => {
          const isSelected = activeScene?.scene_id === scene.scene_id;
          return (
            <div
              key={scene.scene_id}
              className={`list-card ${isSelected ? 'selected' : ''}`}
              style={{ cursor: 'pointer' }}
              onClick={() => {
                setActiveSceneId(scene.scene_id);
                setSelection({ type: 'scene', id: scene.scene_id });
                setCurrentFrame(msToFrame(scene.start_ms, project.timeline.fps));
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontWeight: 600 }}>
                  <Film size={13} color="var(--accent-text)" />
                  <span>
                    #{idx + 1} {scene.name}
                  </span>
                </div>
                {project.scenes.length > 1 && (
                  <button
                    className="btn-ghost btn-icon"
                    title={t('scenes.deleteScene')}
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteScene(scene.scene_id);
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
              <div className="mono" style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                {formatTimecode(scene.start_ms)} → {formatTimecode(scene.start_ms + scene.duration_ms)} ({(scene.duration_ms / 1000).toFixed(1)}s)
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <span className="tag-pill">{scene.characters.length} {t('nav.characters').toLowerCase()}</span>
                <span className="tag-pill">{scene.props.length} {t('app.selectionType.prop').toLowerCase()}</span>
                <span className="tag-pill">{scene.transition_in}</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Executed Editable Shots inside Active Scene (Phase 07 Batch 1) */}
      {activeScene && activeScene.shots && activeScene.shots.length > 0 && (
        <div className="inspector-section" data-testid="scenes-panel-shots">
          <div className="inspector-section-title">
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <Clapperboard size={12} color="var(--accent-text)" />
              {t('sceneExec.executedShotsHeader', { count: activeScene.shots.length })}
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {activeScene.shots.map((sh) => {
              const isShotSelected =
                selection.type === 'shot'
                  ? selection.id === sh.shot_id
                  : activeShotId === sh.shot_id;
              return (
                <div
                  key={sh.shot_id}
                  data-testid={`scenes-panel-shot-${sh.shot_order}`}
                  className={`list-card ${isShotSelected ? 'selected' : ''}`}
                  style={{ padding: '5px 7px', cursor: 'pointer', gap: 3 }}
                  onClick={() => {
                    setActiveSceneId(activeScene.scene_id);
                    setActiveShotId(sh.shot_id);
                    setSelection({ type: 'shot', id: sh.shot_id });
                    setCurrentFrame(
                      msToFrame(activeScene.start_ms + sh.start_ms, project.timeline.fps),
                    );
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 5 }}>
                    <span style={{ fontSize: 11, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <span className="mono" style={{ color: 'var(--accent-text)', marginRight: 4 }}>
                        #{sh.shot_order}
                      </span>
                      {sh.title}
                    </span>
                    <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>
                      {(sh.duration_ms / 1000).toFixed(1)}s
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', fontSize: 9 }}>
                    <span className="tag-pill">{sh.character_states.length} {t('production.charsShort')}</span>
                    <span className="tag-pill">{sh.prop_states.length} {t('app.selectionType.prop').toLowerCase()}</span>
                    <span className={`tag-pill ${sh.execution_status === 'assembled' ? 'verified' : ''}`}>
                      {sh.execution_status}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Unified Front-to-Back Stage Layers Panel with Drag-and-Drop & Z-Order Controls */}
      {activeScene && (
        <div className="inspector-section">
          <div className="inspector-section-title">
            <span>{t('scenes.stageLayers', { count: orderedLayers.length })}</span>
            <button
              className="btn-xs"
              title={t('layer.addEmptyTip')}
              onClick={() => addEmptyLayer(activeScene.scene_id)}
            >
              <Plus size={11} /> {t('layer.addEmpty')}
            </button>
          </div>
          {orderedLayers.length > 0 && (
            <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
              {t('layer.frontHint')}
            </div>
          )}

          {orderedLayers.length === 0 ? (
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {t('scenes.emptyLayers')}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {orderedLayers.map((layer, idx) => {
                const selType = layer.kind === 'character' ? 'character' : 'prop';
                const isSelected = selection.id === layer.id;
                const dropClass =
                  dropTarget?.id === layer.id
                    ? dropTarget.position === 'before'
                      ? 'layer-drop-before'
                      : 'layer-drop-after'
                    : '';

                return (
                  <div
                    key={layer.id}
                    draggable={renamingId !== layer.id}
                    data-layer-id={layer.id}
                    className={`list-card ${isSelected ? 'selected' : ''} ${dropClass}`}
                    style={{
                      padding: '4px 6px',
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 4,
                      cursor: 'pointer',
                      paddingLeft: layer.parentId ? 16 : 6,
                      opacity: dragLayerId === layer.id ? 0.45 : 1,
                    }}
                    onClick={() => setSelection({ type: selType, id: layer.id })}
                    onContextMenu={(e) => openLayerContextMenu(layer, e)}
                    onDragStart={(e) => {
                      setDragLayerId(layer.id);
                      e.dataTransfer.setData('application/x-amcs-layer-id', layer.id);
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragEnd={() => {
                      setDragLayerId(null);
                      setDropTarget(null);
                    }}
                    onDragOver={(e) => {
                      if (!dragLayerId || dragLayerId === layer.id) return;
                      e.preventDefault();
                      const rect = e.currentTarget.getBoundingClientRect();
                      const pos = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
                      setDropTarget({ id: layer.id, position: pos });
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      const srcId = dragLayerId || e.dataTransfer.getData('application/x-amcs-layer-id');
                      const pos = dropTarget?.position ?? 'before';
                      setDragLayerId(null);
                      setDropTarget(null);
                      if (srcId && srcId !== layer.id) {
                        const ok = reorderSceneLayer(activeScene.scene_id, srcId, layer.id, pos);
                        if (!ok) {
                          pushToast('info', t('layer.cannotReorderChild'));
                        }
                      }
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 5,
                        minWidth: 0,
                        flex: 1,
                        opacity: layer.visible ? 1 : 0.45,
                      }}
                    >
                      <GripVertical
                        size={11}
                        style={{ flexShrink: 0, color: 'var(--text-muted)', cursor: 'grab' }}
                      />
                      {layer.kind === 'character' && (
                        <Users size={12} color="var(--track-char-text)" style={{ flexShrink: 0 }} />
                      )}
                      {layer.kind === 'prop' && (
                        <ImageIcon size={12} color="var(--accent-text)" style={{ flexShrink: 0 }} />
                      )}
                      {layer.kind === 'empty' && (
                        <Box size={12} color="var(--text-muted)" style={{ flexShrink: 0 }} />
                      )}

                      {renamingId === layer.id ? (
                        <input
                          autoFocus
                          value={renameDraft}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onBlur={() => commitRename(layer)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitRename(layer);
                            else if (e.key === 'Escape') setRenamingId(null);
                          }}
                          style={{ flex: 1, minWidth: 50, padding: '1px 4px', fontSize: 11 }}
                        />
                      ) : (
                        <span
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            startRename(layer);
                          }}
                          title={
                            layer.parentId
                              ? `${layer.name} (↳ ${layerNameById.get(layer.parentId) ?? ''})`
                              : layer.name
                          }
                          style={{
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            fontSize: 11,
                            fontWeight: 500,
                          }}
                        >
                          {layer.name}
                        </span>
                      )}

                      {layer.kind === 'empty' && (
                        <span className="tag-pill" style={{ fontSize: 9, flexShrink: 0 }}>
                          {t('layer.emptyBadge')}
                        </span>
                      )}
                    </div>

                    <div
                      style={{ display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0 }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        className="btn-ghost btn-icon btn-xs"
                        disabled={idx === 0}
                        title={t('layer.moveUp')}
                        aria-label={t('layer.moveUp')}
                        onClick={() => moveSceneLayer(activeScene.scene_id, layer.id, 'up')}
                      >
                        <ArrowUp size={10} />
                      </button>
                      <button
                        className="btn-ghost btn-icon btn-xs"
                        disabled={idx === orderedLayers.length - 1}
                        title={t('layer.moveDown')}
                        aria-label={t('layer.moveDown')}
                        onClick={() => moveSceneLayer(activeScene.scene_id, layer.id, 'down')}
                      >
                        <ArrowDown size={10} />
                      </button>
                      <button
                        className={`btn-ghost btn-icon btn-xs ${!layer.visible ? 'btn-danger' : ''}`}
                        title={layer.visible ? t('layer.hideLayer') : t('layer.showLayer')}
                        aria-label={layer.visible ? t('layer.hideLayer') : t('layer.showLayer')}
                        onClick={() =>
                          setLayerVisibility(activeScene.scene_id, selType, layer.id, !layer.visible)
                        }
                      >
                        {layer.visible ? <Eye size={11} /> : <EyeOff size={11} />}
                      </button>
                      <button
                        className={`btn-icon btn-xs ${layer.locked ? 'active' : 'btn-ghost'}`}
                        title={layer.locked ? t('layer.unlockLayer') : t('layer.lockLayer')}
                        aria-label={layer.locked ? t('layer.unlockLayer') : t('layer.lockLayer')}
                        onClick={() =>
                          setLayerLocked(activeScene.scene_id, selType, layer.id, !layer.locked)
                        }
                      >
                        {layer.locked ? <Lock size={10} /> : <Unlock size={10} />}
                      </button>
                      <button
                        className="btn-ghost btn-icon btn-xs"
                        title={
                          layer.kind === 'character'
                            ? t('stage.ctxRemoveChar')
                            : t('stage.ctxRemoveProp')
                        }
                        aria-label={t('common.delete')}
                        onClick={() => {
                          if (layer.kind === 'character') {
                            removeCharacterInstance(activeScene.scene_id, layer.id);
                          } else {
                            removePropInstance(activeScene.scene_id, layer.id);
                          }
                        }}
                      >
                        <Trash2 size={10} />
                      </button>
                    </div>
                  </div>
                );
              })}

              {activeScene.props.some((p) => Boolean(p.asset_id)) && (
                <button
                  style={{ marginTop: 4 }}
                  title={t('scenes.groupPropsTip')}
                  onClick={async () => {
                    try {
                      const res = await groupScenePropsIntoCharacter(
                        activeScene.scene_id,
                        `${activeScene.name} Character`,
                      );
                      if (res) {
                        upsertCharacter(res.character);
                        pushToast(
                          'success',
                          t('scenes.groupedToast', {
                            count: res.partCount,
                            name: res.character.name,
                          }),
                        );
                      }
                    } catch (err) {
                      pushToast('error', err instanceof Error ? err.message : 'Group failed');
                    }
                  }}
                >
                  <FolderPlus size={12} /> {t('scenes.groupPropsToChar')}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {activeScene && (
        <div className="inspector-section" style={{ marginTop: 4 }}>
          <div className="inspector-section-title">
            <span>{t('scenes.activeSettings')}</span>
          </div>
          <div className="field-row">
            <label className="field-label">{t('inspector.sceneName')}</label>
            <input
              value={activeScene.name}
              onChange={(e) => updateScene(activeScene.scene_id, { name: e.target.value })}
            />
          </div>
          <div className="field-grid">
            <div className="field-row">
              <label className="field-label">{t('inspector.duration')} (s)</label>
              <input
                type="number"
                min={1}
                max={600}
                step={0.5}
                value={Number((activeScene.duration_ms / 1000).toFixed(2))}
                onChange={(e) => {
                  const sec = Math.max(1, Number(e.target.value) || 1);
                  updateScene(activeScene.scene_id, { duration_ms: Math.round(sec * 1000) });
                }}
              />
            </div>
            <div className="field-row">
              <label className="field-label">{t('inspector.transitionIn')}</label>
              <select
                value={activeScene.transition_in}
                onChange={(e) =>
                  updateScene(activeScene.scene_id, {
                    transition_in: e.target.value as TransitionType,
                  })
                }
              >
                <option value="cut">{t('inspector.transitionCut')}</option>
                <option value="fade">{t('inspector.transitionFade')}</option>
                <option value="cross_dissolve">{t('inspector.transitionCross')}</option>
              </select>
            </div>
          </div>
          <div className="field-grid">
            <div className="field-row">
              <label className="field-label">{t('inspector.bgColor')}</label>
              <input
                type="color"
                value={activeScene.background_color}
                onChange={(e) =>
                  updateScene(activeScene.scene_id, { background_color: e.target.value })
                }
                style={{ height: 28, padding: 2 }}
              />
            </div>
            <div className="field-row">
              <label className="field-label">{t('inspector.transitionDur')} (ms)</label>
              <input
                type="number"
                min={0}
                max={3000}
                step={100}
                value={activeScene.transition_duration_ms}
                onChange={(e) =>
                  updateScene(activeScene.scene_id, {
                    transition_duration_ms: Math.max(0, Number(e.target.value) || 0),
                  })
                }
              />
            </div>
          </div>
          <div className="field-row">
            <label className="field-label">{t('inspector.bgImage')}</label>
            <select
              value={activeScene.background_asset_id ?? ''}
              onChange={(e) =>
                updateScene(activeScene.scene_id, {
                  background_asset_id: e.target.value || null,
                })
              }
            >
              <option value="">{t('inspector.bgNone')}</option>
              {bgAssets.map((a) => (
                <option key={a.asset_id} value={a.asset_id}>
                  {a.name} ({a.width}×{a.height})
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
    </>
  );
}
