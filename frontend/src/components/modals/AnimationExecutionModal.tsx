import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  Clapperboard,
  Film,
  Loader2,
  RefreshCw,
  RotateCcw,
  Sparkles,
  X,
} from 'lucide-react';
import { msToFrame } from '@/engine/evaluator';
import { tGlobal, useI18n } from '@/i18n/useLocaleStore';
import { apiClient } from '@/services/apiClient';
import {
  useAnimationExecStore,
  type AnimationExecModalScope,
} from '@/stores/useAnimationExecStore';
import { useJobStore } from '@/stores/useJobStore';
import { usePlaybackStore } from '@/stores/usePlaybackStore';
import { useProjectStore } from '@/stores/useProjectStore';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';
import type { MotionSupportLevel, ShotAnimationExecuteResponse } from '@/types/models';

function supportBadgeClass(level: MotionSupportLevel): string {
  if (level === 'full') return 'accepted';
  if (level === 'partial') return 'warning';
  return 'rejected';
}

export function AnimationExecutionModal({
  scope,
  onClose,
}: {
  scope: AnimationExecModalScope;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const project = useProjectStore((s) => s.project);
  const saveProject = useProjectStore((s) => s.saveProject);
  const applyExecutedProjectState = useProjectStore((s) => s.applyExecutedProjectState);
  const clearPreview = useAnimationExecStore((s) => s.clearPreview);
  const switchWorkspace = useWorkspaceStore((s) => s.switchWorkspace);
  const setTimelineCollapsed = useWorkspaceStore((s) => s.setTimelineCollapsed);
  const setCurrentFrame = usePlaybackStore((s) => s.setCurrentFrame);
  const pushToast = useJobStore((s) => s.pushToast);

  const [includeChar, setIncludeChar] = useState(true);
  const [includeCam, setIncludeCam] = useState(true);
  const [syncCamChar, setSyncCamChar] = useState(true);
  const [preserveUser, setPreserveUser] = useState(true);
  const [allowPartial, setAllowPartial] = useState(true);
  const [openStageAfter, setOpenStageAfter] = useState(true);

  const [loading, setLoading] = useState(true);
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ShotAnimationExecuteResponse | null>(null);
  const [selectedShotIds, setSelectedShotIds] = useState<Set<string>>(new Set());
  const [regenMotionIds, setRegenMotionIds] = useState<Set<string>>(
    new Set(scope.regenerateMotionIds ?? []),
  );

  const loadDryRun = useCallback(async () => {
    if (!project) return;
    setLoading(true);
    setError(null);
    try {
      if (useProjectStore.getState().isDirty) {
        await saveProject(false);
      }
      const res = await apiClient.executeShotAnimations(project.meta.project_id, {
        scene_ids: scope.sceneIds ?? null,
        shot_ids: scope.shotIds ?? null,
        production_shot_ids: scope.productionShotIds ?? null,
        include_character_motion: includeChar,
        include_camera_motion: includeCam,
        sync_camera_with_character: syncCamChar,
        preserve_user_modified: preserveUser,
        regenerate_motion_ids: [...regenMotionIds],
        allow_partial: allowPartial,
        dry_run: true,
      });
      setPreview(res);
      setSelectedShotIds(new Set(res.outcomes.map((o) => o.shot_id)));
    } catch (err) {
      setError(err instanceof Error ? err.message : tGlobal('motionExec.previewFailed'));
    } finally {
      setLoading(false);
    }
  }, [
    project?.meta.project_id,
    scope.sceneIds,
    scope.shotIds,
    scope.productionShotIds,
    includeChar,
    includeCam,
    syncCamChar,
    preserveUser,
    allowPartial,
    regenMotionIds,
    saveProject,
  ]);

  useEffect(() => {
    void loadDryRun();
  }, [loadDryRun]);

  if (!project) return null;

  const toggleShot = (shotId: string) => {
    setSelectedShotIds((prev) => {
      const next = new Set(prev);
      if (next.has(shotId)) next.delete(shotId);
      else next.add(shotId);
      return next;
    });
  };

  const handleExecute = async () => {
    if (executing || selectedShotIds.size === 0) return;
    setExecuting(true);
    setError(null);
    try {
      if (useProjectStore.getState().isDirty) {
        await saveProject(false);
      }
      const res = await apiClient.executeShotAnimations(project.meta.project_id, {
        shot_ids: [...selectedShotIds],
        include_character_motion: includeChar,
        include_camera_motion: includeCam,
        sync_camera_with_character: syncCamChar,
        preserve_user_modified: preserveUser,
        regenerate_motion_ids: [...regenMotionIds],
        allow_partial: allowPartial,
        dry_run: false,
      });

      if (res.status === 'rolled_back') {
        setError(res.errors.join(' ') || t('motionExec.executeFailed'));
        pushToast('error', res.errors[0] || t('motionExec.executeFailed'));
        return;
      }

      if (res.updated_project) {
        clearPreview();
        applyExecutedProjectState(res.updated_project, true);
        const firstOutcome = res.outcomes[0];
        if (firstOutcome) {
          setCurrentFrame(msToFrame(firstOutcome.start_ms, res.updated_project.timeline.fps || 30));
        }
      }

      pushToast(
        'success',
        t('motionExec.executedToast', {
          shots: res.shots_processed,
          kfs: res.total_keyframes_written,
          actions: res.actions_executed,
          cams: res.cameras_executed,
        }),
      );

      if (openStageAfter) {
        switchWorkspace('animation');
        setTimelineCollapsed(false);
      }
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('motionExec.executeFailed');
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
      data-testid="animation-execution-modal"
    >
      <div
        className="modal-box"
        style={{ width: 840, maxWidth: '95vw', maxHeight: '90vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <Sparkles size={15} color="var(--accent-text)" />
            {t('motionExec.modalTitle')}
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

        <div className="modal-body" style={{ gap: 10 }}>
          {/* Execution Options */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 11 }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={includeChar}
                  onChange={(e) => setIncludeChar(e.target.checked)}
                />
                {t('motionExec.optIncludeChar')}
              </label>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={includeCam}
                  onChange={(e) => setIncludeCam(e.target.checked)}
                />
                {t('motionExec.optIncludeCam')}
              </label>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={syncCamChar}
                  onChange={(e) => setSyncCamChar(e.target.checked)}
                />
                {t('motionExec.optSyncCam')}
              </label>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={preserveUser}
                  onChange={(e) => setPreserveUser(e.target.checked)}
                  data-testid="anim-exec-preserve-user"
                />
                {t('motionExec.optPreserveUser')}
              </label>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={allowPartial}
                  onChange={(e) => setAllowPartial(e.target.checked)}
                />
                {t('motionExec.optAllowPartial')}
              </label>
            </div>
            <button
              type="button"
              className="btn-xs"
              disabled={loading}
              onClick={() => void loadDryRun()}
              title={t('common.refresh')}
            >
              <RefreshCw size={11} className={loading ? 'spin' : ''} />
            </button>
          </div>

          {error && (
            <div className="director-callout error" data-testid="anim-exec-error">
              <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>{error}</span>
            </div>
          )}

          {loading && !preview ? (
            <div className="empty-state" style={{ padding: 36 }}>
              <Loader2 size={24} className="spin" color="var(--accent-text)" />
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {t('motionExec.analyzingPlan')}
              </div>
            </div>
          ) : preview ? (
            <>
              {/* KPI Summary */}
              <div className="prod-kpi-grid">
                <div className="prod-kpi-card">
                  <div className="prod-kpi-label">{t('motionExec.kpiShots')}</div>
                  <div className="prod-kpi-val mono" data-testid="anim-exec-kpi-shots">
                    {preview.shots_processed}
                  </div>
                </div>
                <div className="prod-kpi-card">
                  <div className="prod-kpi-label">{t('motionExec.kpiExecutableActions')}</div>
                  <div className="prod-kpi-val mono" style={{ color: 'var(--success)' }} data-testid="anim-exec-kpi-actions">
                    {preview.actions_executed}
                  </div>
                </div>
                <div className="prod-kpi-card">
                  <div className="prod-kpi-label">{t('motionExec.kpiUnsupported')}</div>
                  <div
                    className="prod-kpi-val mono"
                    style={{
                      color:
                        preview.actions_unsupported + preview.cameras_unsupported > 0
                          ? 'var(--warning)'
                          : 'var(--text-primary)',
                    }}
                    data-testid="anim-exec-kpi-unsupported"
                  >
                    {preview.actions_unsupported + preview.cameras_unsupported}
                  </div>
                </div>
                <div className="prod-kpi-card">
                  <div className="prod-kpi-label">{t('motionExec.kpiKeyframes')}</div>
                  <div className="prod-kpi-val mono" style={{ color: 'var(--accent-text)' }} data-testid="anim-exec-kpi-kfs">
                    {preview.total_keyframes_written}
                  </div>
                </div>
              </div>

              {preview.warnings.length > 0 && (
                <div className="director-callout warning">
                  <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                  <div style={{ fontSize: 11 }}>{preview.warnings.join(' ')}</div>
                </div>
              )}

              {/* Shot Execution Plan Breakdown */}
              <div className="prod-preview-list" style={{ maxHeight: 360 }}>
                {preview.outcomes.length === 0 ? (
                  <div className="director-empty-inline">{t('motionExec.noAssembledShots')}</div>
                ) : (
                  preview.outcomes.map((o) => {
                    const checked = selectedShotIds.has(o.shot_id);
                    return (
                      <div
                        key={o.shot_id}
                        className={`prod-preview-row ${!checked ? 'skipped' : ''}`}
                        data-testid={`anim-exec-shot-${o.shot_order}`}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
                          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', minWidth: 0 }}>
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleShot(o.shot_id)}
                              data-testid={`anim-exec-shot-cb-${o.shot_order}`}
                            />
                            <Clapperboard size={12} color="var(--accent-text)" />
                            <span className="mono" style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent-text)' }}>
                              #{o.shot_order}
                            </span>
                            <strong style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {o.title}
                            </strong>
                          </label>
                          <span className="mono" style={{ fontSize: 10, color: 'var(--text-secondary)', flexShrink: 0 }}>
                            {(o.start_ms / 1000).toFixed(1)}s → {(o.end_ms / 1000).toFixed(1)}s • {o.keyframes_generated} kf
                          </span>
                        </div>

                        {/* Character Actions */}
                        {o.actions.length > 0 && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 6 }}>
                            {o.actions.map((act) => (
                              <div
                                key={act.action_plan_id}
                                className="exec-repair-row"
                                style={{
                                  borderColor: act.executable
                                    ? 'rgba(34,197,94,0.28)'
                                    : 'rgba(239,68,68,0.35)',
                                }}
                                data-testid={`anim-exec-action-${act.category}`}
                              >
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                    <Film size={11} color="var(--accent-text)" />
                                    <strong style={{ fontSize: 11 }}>{act.character_name}</strong>
                                    <span className="tag-pill mono">{act.category}</span>
                                    {act.mapped_preset_name && (
                                      <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                                        → {act.mapped_preset_name}
                                      </span>
                                    )}
                                    <span className={`director-badge ${supportBadgeClass(act.support_level)}`}>
                                      {t(`motionExec.support.${act.support_level}`)}
                                    </span>
                                    {act.skipped_user_modified && (
                                      <span className="director-badge edited">
                                        {t('motionExec.userEditedBadge')}
                                      </span>
                                    )}
                                  </div>
                                  {act.unsupported_reason && (
                                    <div style={{ fontSize: 10, color: 'var(--warning)' }}>
                                      ⚠ {act.unsupported_reason}
                                      {act.manual_alternative ? ` — ${act.manual_alternative}` : ''}
                                    </div>
                                  )}
                                  {act.warnings.length > 0 && !act.unsupported_reason && (
                                    <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                                      • {act.warnings.join(' ')}
                                    </div>
                                  )}
                                </div>
                                <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>
                                  {act.executable ? `${act.keyframes_count} kf` : t('motionExec.skippedShort')}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Camera Motion Report */}
                        {o.camera && (
                          <div
                            className="exec-repair-row"
                            style={{
                              borderColor: o.camera.executable
                                ? 'rgba(56,189,248,0.32)'
                                : 'rgba(239,68,68,0.4)',
                            }}
                            data-testid={`anim-exec-camera-${o.shot_order}`}
                          >
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                <Camera size={11} color="var(--track-camera-accent)" />
                                <strong style={{ fontSize: 11 }}>{t('motionExec.cameraLabel')}:</strong>
                                <span className="tag-pill mono">{o.camera.movement}</span>
                                <span className={`director-badge ${supportBadgeClass(o.camera.support_level)}`}>
                                  {t(`motionExec.support.${o.camera.support_level}`)}
                                </span>
                                {o.camera.synchronized_with_instance_id && (
                                  <span className="director-badge accepted">
                                    {t('motionExec.cameraSyncedBadge')}
                                  </span>
                                )}
                              </div>
                              {o.camera.unsupported_reason && (
                                <div style={{ fontSize: 10, color: 'var(--danger)' }}>
                                  ⚠ {o.camera.unsupported_reason}
                                </div>
                              )}
                              {o.camera.warnings.length > 0 && (
                                <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                                  • {o.camera.warnings.join(' ')}
                                </div>
                              )}
                            </div>
                            <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>
                              {o.camera.executable ? `${o.camera.keyframes_count} kf` : t('motionExec.notReplacedShort')}
                            </span>
                          </div>
                        )}

                        {/* Synchronization Notes */}
                        {o.sync_notes.length > 0 && (
                          <div style={{ fontSize: 10, color: 'var(--accent-text)', marginTop: 4 }}>
                            {o.sync_notes.map((n, idx) => (
                              <div key={idx}>⇄ {n}</div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </>
          ) : null}
        </div>

        <div className="modal-footer" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-secondary)', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={openStageAfter}
                onChange={(e) => setOpenStageAfter(e.target.checked)}
              />
              {t('motionExec.openAnimationAfter')}
            </label>
            {regenMotionIds.size > 0 && (
              <button
                type="button"
                className="btn-xs"
                onClick={() => setRegenMotionIds(new Set())}
              >
                <RotateCcw size={10} /> {t('motionExec.clearRegen', { count: regenMotionIds.size })}
              </button>
            )}
          </div>

          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={executing || loading || selectedShotIds.size === 0}
              onClick={() => void handleExecute()}
              data-testid="anim-exec-apply-btn"
            >
              {executing ? <Loader2 size={12} className="spin" /> : <CheckCircle2 size={13} />}
              {t('motionExec.applyBtn', { count: selectedShotIds.size })}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
