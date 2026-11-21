import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Box,
  Camera,
  CheckCircle2,
  Clapperboard,
  Film,
  Image as ImageIcon,
  Layers,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Users,
  Wrench,
  X,
} from 'lucide-react';
import { msToFrame } from '@/engine/evaluator';
import { tGlobal, useI18n } from '@/i18n/useLocaleStore';
import { apiClient } from '@/services/apiClient';
import { useJobStore } from '@/stores/useJobStore';
import { useLibraryStore } from '@/stores/useLibraryStore';
import { usePlaybackStore } from '@/stores/usePlaybackStore';
import {
  useProductionStore,
  type TimelinePreviewScope,
} from '@/stores/useProductionStore';
import { useProjectStore } from '@/stores/useProjectStore';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';
import type {
  ExecutionValidationStatus,
  ExistingExecutionPolicy,
  SceneExecutionPreview,
  ValidationIssue,
} from '@/types/models';

function valStatusBadgeClass(status: ExecutionValidationStatus): string {
  if (status === 'ready') return 'accepted';
  if (status === 'invalid' || status === 'missing_dependency') return 'rejected';
  return 'warning';
}

export function SceneExecutionPreviewModal({
  initialScope,
  onClose,
}: {
  initialScope: TimelinePreviewScope;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const project = useProjectStore((s) => s.project);
  const isDirty = useProjectStore((s) => s.isDirty);
  const saveProject = useProjectStore((s) => s.saveProject);
  const applyExecutedProjectState = useProjectStore((s) => s.applyExecutedProjectState);

  const characters = useLibraryStore((s) => s.characters);
  const assets = useLibraryStore((s) => s.assets);

  const activeProdSceneId = useProductionStore((s) => s.activeSceneId);
  const selectedProdShotId = useProductionStore((s) => s.selectedProductionShotId);

  const switchWorkspace = useWorkspaceStore((s) => s.switchWorkspace);
  const setTimelineCollapsed = useWorkspaceStore((s) => s.setTimelineCollapsed);
  const setCurrentFrame = usePlaybackStore((s) => s.setCurrentFrame);
  const pushToast = useJobStore((s) => s.pushToast);

  const [scope, setScope] = useState<TimelinePreviewScope>(initialScope);
  const [includeUnapproved, setIncludeUnapproved] = useState<boolean>(true);
  const [policy, setPolicy] = useState<ExistingExecutionPolicy>('update_existing');
  const [syncKeyframes, setSyncKeyframes] = useState<boolean>(true);
  const [openStageAfter, setOpenStageAfter] = useState<boolean>(true);

  const [loading, setLoading] = useState<boolean>(true);
  const [executing, setExecuting] = useState<boolean>(false);
  const [repairingId, setRepairingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<SceneExecutionPreview | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const bgAndPropAssets = useMemo(
    () => assets.filter((a) => a.type === 'background' || a.type === 'prop'),
    [assets],
  );

  const buildScopePayload = useCallback(() => {
    if (scope === 'shot' && selectedProdShotId) {
      return {
        production_shot_ids: [selectedProdShotId],
        scene_ids: null,
        include_unapproved: true,
      };
    }
    if (scope === 'scene' && activeProdSceneId) {
      return {
        scene_ids: [activeProdSceneId],
        production_shot_ids: null,
        include_unapproved: includeUnapproved,
      };
    }
    return {
      scene_ids: null,
      production_shot_ids: null,
      include_unapproved: includeUnapproved,
    };
  }, [scope, selectedProdShotId, activeProdSceneId, includeUnapproved]);

  const loadPreview = useCallback(async () => {
    if (!project) return;
    setLoading(true);
    setError(null);
    try {
      if (useProjectStore.getState().isDirty) {
        await saveProject(false);
      }
      const data = await apiClient.previewSceneExecution(
        project.meta.project_id,
        buildScopePayload(),
      );
      setPreview(data);
      setPolicy(data.recommended_policy);
      const validIds = new Set<string>();
      for (const grp of data.scenes) {
        for (const sh of grp.shots) {
          if (sh.executable) validIds.add(sh.production_shot_id);
        }
      }
      setSelectedIds(validIds);
    } catch (err) {
      setError(err instanceof Error ? err.message : tGlobal('sceneExec.previewFailed'));
    } finally {
      setLoading(false);
    }
  }, [project?.meta.project_id, buildScopePayload, saveProject]);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  if (!project) return null;

  const allPreviewShots = preview?.scenes.flatMap((g) => g.shots) ?? [];
  const validShotIds = allPreviewShots
    .filter((s) => s.executable)
    .map((s) => s.production_shot_id);

  const toggleShotSelected = (prodShotId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(prodShotId)) next.delete(prodShotId);
      else next.add(prodShotId);
      return next;
    });
  };

  const handleRepair = async (
    issue: ValidationIssue,
    replacementId: string,
  ) => {
    if (!issue.production_shot_id || !replacementId) return;
    setRepairingId(issue.issue_id);
    try {
      const targetKind =
        issue.category === 'character'
          ? 'character'
          : issue.category === 'background'
            ? 'background'
            : 'prop';
      const res = await apiClient.repairMissingAsset(project.meta.project_id, {
        production_shot_id: issue.production_shot_id,
        target_kind: targetKind,
        requirement_id: issue.requirement_id,
        staging_id: issue.staging_id,
        asset_id: targetKind !== 'character' ? replacementId : null,
        character_id: targetKind === 'character' ? replacementId : null,
      });
      applyExecutedProjectState(res.project, false);
      pushToast('success', t('sceneExec.repairedAssetToast', { label: issue.label }));
      await loadPreview();
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : t('sceneExec.repairFailed'));
    } finally {
      setRepairingId(null);
    }
  };

  const handleExecute = async (mode: 'all_valid' | 'selected') => {
    if (!preview || executing) return;
    const chosenIds =
      mode === 'all_valid'
        ? validShotIds
        : allPreviewShots
            .filter((s) => selectedIds.has(s.production_shot_id))
            .map((s) => s.production_shot_id);

    if (chosenIds.length === 0) return;
    const skipIds = allPreviewShots
      .map((s) => s.production_shot_id)
      .filter((id) => !chosenIds.includes(id));

    setExecuting(true);
    setError(null);
    try {
      if (isDirty) {
        await saveProject(false);
      }
      const scopePayload = buildScopePayload();
      const res = await apiClient.executeSceneAssembly(project.meta.project_id, {
        scene_ids: scopePayload.scene_ids,
        production_shot_ids: scopePayload.production_shot_ids,
        skip_shot_ids: skipIds,
        include_unapproved: scopePayload.include_unapproved,
        existing_policy: policy,
        allow_partial: true,
        sync_timeline_keyframes: syncKeyframes,
      });

      if (res.updated_project) {
        applyExecutedProjectState(res.updated_project, true);
        // Move playhead cleanly to first assembled shot
        const firstScene =
          res.updated_project.scenes.find((s) => s.shots && s.shots.length > 0) ??
          res.updated_project.scenes[0];
        if (firstScene) {
          const startMs = firstScene.start_ms + (firstScene.shots?.[0]?.start_ms ?? 0);
          setCurrentFrame(msToFrame(startMs, res.updated_project.timeline.fps || 30));
        }
      }

      pushToast(
        res.status === 'rolled_back' ? 'error' : 'success',
        t('sceneExec.executedToast', {
          shots: res.shots_assembled + res.shots_updated,
          reused: res.shots_reused,
          chars: res.characters_created + res.characters_reused,
          props: res.props_created + res.props_reused,
          blocked: res.shots_blocked,
        }),
      );

      if (openStageAfter && res.status !== 'rolled_back') {
        switchWorkspace('scene');
        setTimelineCollapsed(false);
      }
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('sceneExec.executeFailed');
      setError(msg);
      pushToast('error', msg);
    } finally {
      setExecuting(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
      data-testid="scene-execution-preview-modal"
    >
      <div
        className="modal-box"
        style={{ width: 840, maxWidth: '95vw', maxHeight: '90vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <Clapperboard size={15} color="var(--accent-text)" />
            {t('sceneExec.modalTitle')}
          </span>
          <button
            type="button"
            className="btn-ghost btn-icon"
            onClick={onClose}
            aria-label={t('common.close')}
          >
            <X size={14} />
          </button>
        </div>

        <div className="modal-body" style={{ gap: 11 }}>
          {/* Scope & Controls Bar */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button
                type="button"
                className={`btn-xs ${scope === 'shot' ? 'btn-primary' : ''}`}
                disabled={!selectedProdShotId}
                onClick={() => setScope('shot')}
                data-testid="exec-scope-shot"
              >
                {t('production.scopeSelectedShot')}
              </button>
              <button
                type="button"
                className={`btn-xs ${scope === 'scene' ? 'btn-primary' : ''}`}
                disabled={!activeProdSceneId}
                onClick={() => setScope('scene')}
                data-testid="exec-scope-scene"
              >
                {t('production.scopeActiveScene')}
              </button>
              <button
                type="button"
                className={`btn-xs ${scope === 'all_approved' ? 'btn-primary' : ''}`}
                onClick={() => setScope('all_approved')}
                data-testid="exec-scope-all"
              >
                {t('sceneExec.scopeAllScenes')}
              </button>
              <button
                type="button"
                className="btn-xs"
                disabled={loading}
                onClick={() => void loadPreview()}
                title={t('common.refresh')}
              >
                <RefreshCw size={11} className={loading ? 'spin' : ''} />
              </button>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 11 }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={includeUnapproved}
                  onChange={(e) => setIncludeUnapproved(e.target.checked)}
                />
                {t('sceneExec.includeUnapprovedLabel')}
              </label>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={syncKeyframes}
                  onChange={(e) => setSyncKeyframes(e.target.checked)}
                />
                {t('sceneExec.syncKeyframesLabel')}
              </label>
            </div>
          </div>

          {error && (
            <div className="director-callout error" data-testid="scene-exec-error">
              <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>{error}</span>
            </div>
          )}

          {loading && !preview ? (
            <div className="empty-state" style={{ padding: 36 }}>
              <Loader2 size={24} className="spin" color="var(--accent-text)" />
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {t('sceneExec.validatingPreview')}
              </div>
            </div>
          ) : preview ? (
            <>
              {/* Validation KPI Grid */}
              <div className="prod-kpi-grid">
                <div className="prod-kpi-card">
                  <div className="prod-kpi-label">{t('sceneExec.kpiValidation')}</div>
                  <div style={{ marginTop: 3 }}>
                    <span
                      className={`director-badge ${valStatusBadgeClass(preview.validation.overall_status)}`}
                      data-testid="exec-overall-status"
                    >
                      {t(`sceneExec.valStatus.${preview.validation.overall_status}`)}
                    </span>
                  </div>
                </div>
                <div className="prod-kpi-card">
                  <div className="prod-kpi-label">{t('sceneExec.kpiEligibleShots')}</div>
                  <div className="prod-kpi-val mono" style={{ color: 'var(--success)' }} data-testid="exec-kpi-eligible">
                    {preview.total_shots_eligible}
                  </div>
                </div>
                <div className="prod-kpi-card">
                  <div className="prod-kpi-label">{t('sceneExec.kpiBlockedShots')}</div>
                  <div
                    className="prod-kpi-val mono"
                    style={{ color: preview.total_shots_blocked > 0 ? 'var(--danger)' : 'var(--text-primary)' }}
                    data-testid="exec-kpi-blocked"
                  >
                    {preview.total_shots_blocked}
                  </div>
                </div>
                <div className="prod-kpi-card">
                  <div className="prod-kpi-label">{t('sceneExec.kpiAlreadyExecuted')}</div>
                  <div className="prod-kpi-val mono" data-testid="exec-kpi-existing">
                    {preview.validation.already_executed_count}
                  </div>
                </div>
              </div>

              {/* Duplicate Prevention / Existing Execution Policy Selector */}
              {preview.has_existing_execution && (
                <div className="prod-strategy-box" data-testid="exec-existing-policy-box">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600, marginBottom: 6 }}>
                    <ShieldAlert size={13} color="var(--warning)" />
                    {t('sceneExec.existingDetectedTitle')}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 6 }}>
                    {(['update_existing', 'reuse_existing', 'skip_existing'] as ExistingExecutionPolicy[]).map(
                      (p) => (
                        <label
                          key={p}
                          className={`prod-strategy-option ${policy === p ? 'active' : ''}`}
                          data-testid={`exec-policy-${p}`}
                        >
                          <input
                            type="radio"
                            name="existingExecPolicy"
                            checked={policy === p}
                            onChange={() => setPolicy(p)}
                          />
                          <div>
                            <div style={{ fontSize: 11, fontWeight: 600 }}>
                              {t(`sceneExec.policy.${p}`)}
                            </div>
                            <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                              {t(`sceneExec.policyDesc.${p}`)}
                            </div>
                          </div>
                        </label>
                      ),
                    )}
                  </div>
                </div>
              )}

              {/* Scene & Shot Assembly Preview List */}
              <div className="prod-preview-list" style={{ maxHeight: 350 }}>
                {preview.scenes.length === 0 ? (
                  <div className="director-empty-inline">{t('sceneExec.noShotsToAssemble')}</div>
                ) : (
                  preview.scenes.map((scGrp) => (
                    <div key={scGrp.source_scene_id} className="exec-scene-group">
                      <div className="exec-scene-group-header">
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <Film size={13} color="var(--accent-text)" />
                          <strong style={{ fontSize: 12 }}>{scGrp.scene_name}</strong>
                          <span className={`director-badge ${scGrp.will_create_scene ? 'accepted' : 'edited'}`}>
                            {scGrp.will_create_scene
                              ? t('sceneExec.willCreateScene')
                              : t('sceneExec.existingScene')}
                          </span>
                          {scGrp.existing_user_object_count > 0 && (
                            <span className="director-badge pending">
                              {t('sceneExec.preservingUserObjects', {
                                count: scGrp.existing_user_object_count,
                              })}
                            </span>
                          )}
                        </div>
                        <span className="mono" style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                          {(scGrp.total_duration_ms / 1000).toFixed(1)}s • {scGrp.shots.length}{' '}
                          {t('storyboard.shotsShort')}
                        </span>
                      </div>

                      <div style={{ display: 'flex', flexDirection: 'column', gap: 7, padding: 8 }}>
                        {scGrp.shots.map((sh) => {
                          const isChecked = selectedIds.has(sh.production_shot_id);
                          return (
                            <div
                              key={sh.production_shot_id}
                              className={`prod-preview-row ${!isChecked || !sh.executable ? 'skipped' : ''}`}
                              data-testid={`exec-preview-shot-${sh.shot_order}`}
                            >
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 5 }}>
                                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: sh.executable ? 'pointer' : 'not-allowed', minWidth: 0 }}>
                                  <input
                                    type="checkbox"
                                    disabled={!sh.executable}
                                    checked={isChecked && sh.executable}
                                    onChange={() => toggleShotSelected(sh.production_shot_id)}
                                    data-testid={`exec-shot-checkbox-${sh.shot_order}`}
                                  />
                                  <span className="mono" style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent-text)' }}>
                                    #{sh.shot_order}
                                  </span>
                                  <strong style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {sh.title}
                                  </strong>
                                  <span className={`director-badge ${valStatusBadgeClass(sh.validation_status)}`}>
                                    {t(`sceneExec.valStatus.${sh.validation_status}`)}
                                  </span>
                                  {sh.already_executed && (
                                    <span className="director-badge edited">
                                      {t('sceneExec.alreadyAssembledBadge')}
                                    </span>
                                  )}
                                </label>
                                <span className="mono" style={{ fontSize: 10, color: 'var(--text-secondary)', flexShrink: 0 }}>
                                  {(sh.start_ms / 1000).toFixed(1)}s → {(sh.end_ms / 1000).toFixed(1)}s
                                </span>
                              </div>

                              {/* Resolved Background, Characters (with exact coords!), Props & Layer Order */}
                              <div className="director-chip-row" style={{ marginBottom: 5 }}>
                                {sh.background && (
                                  <span
                                    className="director-chip"
                                    style={{
                                      borderColor: sh.background.resolved
                                        ? 'rgba(34,197,94,0.35)'
                                        : 'rgba(239,68,68,0.35)',
                                    }}
                                  >
                                    <ImageIcon size={10} /> BG:{' '}
                                    {sh.background.resolved
                                      ? sh.background.asset_name
                                      : `${sh.background.name} (${t('production.assetClass.missing')})`}
                                  </span>
                                )}
                                {sh.characters.map((ch) => (
                                  <span
                                    key={ch.staging_id}
                                    className="director-chip"
                                    style={{
                                      borderColor: ch.resolved
                                        ? 'rgba(124,108,246,0.4)'
                                        : 'rgba(239,68,68,0.4)',
                                    }}
                                  >
                                    <Users size={10} /> {ch.character_name} ({Math.round(ch.transform.x)},{' '}
                                    {Math.round(ch.transform.y)}) z={ch.z_index}
                                  </span>
                                ))}
                                {sh.objects.map((obj) => (
                                  <span
                                    key={obj.requirement_id}
                                    className="director-chip"
                                    style={{
                                      borderColor: obj.resolved
                                        ? 'rgba(56,189,248,0.4)'
                                        : 'rgba(245,158,11,0.4)',
                                    }}
                                  >
                                    <Box size={10} /> [{obj.role}] {obj.name} z={obj.z_index}
                                  </span>
                                ))}
                                <span className="director-chip">
                                  <Camera size={10} /> z={sh.camera_default.zoom.toFixed(2)} (
                                  {Math.round(sh.camera_default.x)}, {Math.round(sh.camera_default.y)})
                                </span>
                              </div>

                              {/* Front-to-Back Layer Order */}
                              {sh.layer_order.length > 0 && (
                                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>
                                  <Layers size={10} style={{ display: 'inline', marginRight: 4 }} />
                                  {t('sceneExec.layerOrderLabel')}:{' '}
                                  {sh.layer_order
                                    .map((l) => `${l.name} (${l.kind}, z=${l.z_index})`)
                                    .join(' › ')}
                                </div>
                              )}

                              {/* Staging Fallbacks */}
                              {sh.staging_fallbacks.length > 0 && (
                                <div style={{ fontSize: 10, color: 'var(--accent-text)', marginBottom: 4 }}>
                                  {sh.staging_fallbacks.map((fb, idx) => (
                                    <div key={idx}>• {fb}</div>
                                  ))}
                                </div>
                              )}

                              {/* Missing Dependencies with Inline Repair Workflow! */}
                              {sh.missing_dependencies.length > 0 && (
                                <div
                                  style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}
                                  data-testid={`exec-missing-deps-${sh.shot_order}`}
                                >
                                  {sh.missing_dependencies.map((dep) => (
                                    <div
                                      key={dep.issue_id}
                                      className="exec-repair-row"
                                    >
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0, flex: 1 }}>
                                        <Wrench size={11} color="var(--warning)" style={{ flexShrink: 0 }} />
                                        <span style={{ fontSize: 10, color: 'var(--warning)' }}>
                                          <strong>{dep.label}:</strong> {dep.message}
                                        </span>
                                      </div>
                                      {dep.repairable && (
                                        <select
                                          disabled={repairingId === dep.issue_id}
                                          defaultValue=""
                                          style={{ fontSize: 10, maxWidth: 195 }}
                                          data-testid={`exec-repair-select-${dep.category}-${sh.shot_order}`}
                                          onChange={(e) => {
                                            if (e.target.value) {
                                              void handleRepair(dep, e.target.value);
                                            }
                                          }}
                                        >
                                          <option value="">
                                            {t('sceneExec.repairChoosePlaceholder')}
                                          </option>
                                          {dep.category === 'character'
                                            ? characters.map((c) => (
                                                <option key={c.character_id} value={c.character_id}>
                                                  {c.name} ({c.parts.length} parts)
                                                </option>
                                              ))
                                            : bgAndPropAssets.map((a) => (
                                                <option key={a.asset_id} value={a.asset_id}>
                                                  [{a.type}] {a.name}
                                                </option>
                                              ))}
                                        </select>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              )}

                              {/* Unsupported Actions */}
                              {sh.unsupported_actions.length > 0 && (
                                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3 }}>
                                  {sh.unsupported_actions.map((u, i) => (
                                    <div key={i}>⚠ {u}</div>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </>
          ) : null}
        </div>

        <div className="modal-footer" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 11,
              color: 'var(--text-secondary)',
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={openStageAfter}
              onChange={(e) => setOpenStageAfter(e.target.checked)}
              data-testid="exec-open-stage-checkbox"
            />
            {t('sceneExec.openStageAfterLabel')}
          </label>

          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button type="button" onClick={onClose}>
              {t('sceneExec.editPlanBtn')}
            </button>
            <button
              type="button"
              disabled={executing || loading || selectedIds.size === 0}
              onClick={() => void handleExecute('selected')}
              data-testid="scene-exec-apply-selected-btn"
            >
              {executing ? <Loader2 size={12} className="spin" /> : <Layers size={12} />}
              {t('sceneExec.applySelectedBtn', { count: selectedIds.size })}
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={executing || loading || validShotIds.length === 0}
              onClick={() => void handleExecute('all_valid')}
              data-testid="scene-exec-apply-all-valid-btn"
            >
              {executing ? <Loader2 size={12} className="spin" /> : <CheckCircle2 size={13} />}
              {t('sceneExec.applyAllValidBtn', { count: validShotIds.length })}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
