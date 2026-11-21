import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  Captions,
  CheckCircle2,
  Film,
  Layers,
  Music,
  ShieldAlert,
  Sparkles,
  Users,
  X,
} from 'lucide-react';
import {
  buildTimelineApplyPreview,
  type TimelineApplyResult,
} from '@/engine/productionEngine';
import { useI18n } from '@/i18n/useLocaleStore';
import { useJobStore } from '@/stores/useJobStore';
import { useLibraryStore } from '@/stores/useLibraryStore';
import {
  useProductionStore,
  type TimelinePreviewScope,
} from '@/stores/useProductionStore';
import { useProjectStore } from '@/stores/useProjectStore';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';
import type { ProductionShotPlan, TimelineInsertionStrategy } from '@/types/models';

export function TimelineApplyPreviewModal({
  initialScope,
  onClose,
}: {
  initialScope: TimelinePreviewScope;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const project = useProjectStore((s) => s.project);
  const applyProductionPlanToProjectTimeline = useProjectStore(
    (s) => s.applyProductionPlanToProjectTimeline,
  );
  const setActiveSceneId = useProjectStore((s) => s.setActiveSceneId);

  const characters = useLibraryStore((s) => s.characters);
  const assets = useLibraryStore((s) => s.assets);
  const sounds = useLibraryStore((s) => s.sounds);

  const activeProdSceneId = useProductionStore((s) => s.activeSceneId);
  const selectedProdShotId = useProductionStore((s) => s.selectedProductionShotId);

  const switchWorkspace = useWorkspaceStore((s) => s.switchWorkspace);
  const setTimelineCollapsed = useWorkspaceStore((s) => s.setTimelineCollapsed);
  const pushToast = useJobStore((s) => s.pushToast);

  const [scope, setScope] = useState<TimelinePreviewScope>(initialScope);
  const [openStageAfter, setOpenStageAfter] = useState<boolean>(false);

  const planDoc = project?.production_plan ?? null;
  const allShots = planDoc?.shots ?? [];

  const targetShots: ProductionShotPlan[] = useMemo(() => {
    if (scope === 'shot') {
      const found = allShots.find((s) => s.production_shot_id === selectedProdShotId);
      return found ? [found] : [];
    }
    if (scope === 'scene') {
      const sid = activeProdSceneId ?? allShots[0]?.scene_id ?? null;
      return sid
        ? allShots.filter((s) => s.scene_id === sid && s.approval_status !== 'rejected')
        : [];
    }
    // all_approved
    const approved = allShots.filter((s) => s.approval_status === 'approved');
    return approved.length > 0
      ? approved
      : allShots.filter((s) => s.approval_status !== 'rejected');
  }, [scope, allShots, selectedProdShotId, activeProdSceneId]);

  const approvedCount = useMemo(
    () => allShots.filter((s) => s.approval_status === 'approved').length,
    [allShots],
  );

  const preview = useMemo(() => {
    if (!project) return null;
    return buildTimelineApplyPreview(project, targetShots, { characters, assets, sounds });
  }, [project, targetShots, characters, assets, sounds]);

  const [strategy, setStrategy] = useState<TimelineInsertionStrategy>('update_owned_only');

  useEffect(() => {
    if (preview) {
      setStrategy(preview.suggested_strategy);
    }
  }, [preview?.suggested_strategy, scope]);

  if (!project || !planDoc || !preview) return null;

  const handleConfirmApply = () => {
    if (targetShots.length === 0) return;
    const res: TimelineApplyResult = applyProductionPlanToProjectTimeline({
      targetShotIds: targetShots.map((s) => s.production_shot_id),
      strategy,
      characters,
      assets,
      sounds,
    });

    // Sync active Stage Scene if one was applied
    const updatedProject = useProjectStore.getState().project;
    const firstApplied = updatedProject?.production_plan?.shots.find(
      (s) =>
        targetShots.some((ts) => ts.production_shot_id === s.production_shot_id) &&
        s.timeline_refs.stage_scene_id,
    );
    if (firstApplied?.timeline_refs.stage_scene_id) {
      setActiveSceneId(firstApplied.timeline_refs.stage_scene_id);
    }

    pushToast(
      res.appliedShots > 0 ? 'success' : 'info',
      t('production.appliedTimelineToast', {
        shots: res.appliedShots,
        keyframes: res.keyframesCreated,
        clips: res.animationClipsCreated,
        audio: res.audioClipsCreated,
        subtitles: res.subtitlesCreated,
        skipped: res.skippedUnsupportedCount,
      }),
    );

    if (openStageAfter && res.appliedShots > 0) {
      switchWorkspace('animation');
      setTimelineCollapsed(false);
    }
    onClose();
  };

  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
      data-testid="timeline-apply-preview-modal"
    >
      <div
        className="modal-box"
        style={{ width: 760, maxWidth: '94vw', maxHeight: '88vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <Layers size={15} color="var(--accent-text)" />
            {t('production.previewModalTitle')}
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

        <div className="modal-body" style={{ gap: 12 }}>
          {/* Scope Selector */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                type="button"
                className={`btn-xs ${scope === 'shot' ? 'btn-primary' : ''}`}
                disabled={!selectedProdShotId}
                onClick={() => setScope('shot')}
                data-testid="preview-scope-shot"
              >
                {t('production.scopeSelectedShot')}
              </button>
              <button
                type="button"
                className={`btn-xs ${scope === 'scene' ? 'btn-primary' : ''}`}
                disabled={!activeProdSceneId && allShots.length === 0}
                onClick={() => setScope('scene')}
                data-testid="preview-scope-scene"
              >
                {t('production.scopeActiveScene')}
              </button>
              <button
                type="button"
                className={`btn-xs ${scope === 'all_approved' ? 'btn-primary' : ''}`}
                disabled={allShots.length === 0}
                onClick={() => setScope('all_approved')}
                data-testid="preview-scope-all"
              >
                {t('production.scopeAllApproved', { count: approvedCount })}
              </button>
            </div>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {t('production.idempotentNote')}
            </span>
          </div>

          {/* Summary KPI Strip */}
          <div className="prod-kpi-grid">
            <div className="prod-kpi-card">
              <div className="prod-kpi-label">{t('production.kpiShotsToApply')}</div>
              <div className="prod-kpi-val mono" data-testid="preview-kpi-shots">
                {preview.shots.length}
              </div>
            </div>
            <div className="prod-kpi-card">
              <div className="prod-kpi-label">{t('production.kpiTotalDuration')}</div>
              <div className="prod-kpi-val mono">
                {(preview.total_duration_ms / 1000).toFixed(1)}s
              </div>
            </div>
            <div className="prod-kpi-card">
              <div className="prod-kpi-label">{t('production.kpiConflicts')}</div>
              <div
                className="prod-kpi-val mono"
                style={{ color: preview.total_conflicts > 0 ? 'var(--warning)' : 'var(--success)' }}
                data-testid="preview-kpi-conflicts"
              >
                {preview.total_conflicts}
              </div>
            </div>
            <div className="prod-kpi-card">
              <div className="prod-kpi-label">{t('production.kpiSkippedUnsupported')}</div>
              <div
                className="prod-kpi-val mono"
                style={{
                  color:
                    preview.total_skipped_unsupported > 0
                      ? 'var(--warning)'
                      : 'var(--text-primary)',
                }}
                data-testid="preview-kpi-skipped"
              >
                {preview.total_skipped_unsupported}
              </div>
            </div>
          </div>

          {/* Conflict Warning & Safe Insertion Strategy Selector */}
          {preview.total_conflicts > 0 && (
            <div className="director-callout warning" data-testid="preview-conflict-banner">
              <ShieldAlert size={15} style={{ flexShrink: 0, marginTop: 1 }} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <strong style={{ fontSize: 11 }}>
                  {t('production.conflictBannerTitle', { count: preview.total_conflicts })}
                </strong>
                <span style={{ fontSize: 11 }}>{t('production.conflictBannerDesc')}</span>
              </div>
            </div>
          )}

          <div className="prod-strategy-box">
            <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 6 }}>
              {t('production.insertionStrategyTitle')}
            </div>
            <div className="prod-strategy-grid">
              <label
                className={`prod-strategy-option ${strategy === 'update_owned_only' ? 'active' : ''}`}
                data-testid="strategy-update-owned"
              >
                <input
                  type="radio"
                  name="timelineStrategy"
                  checked={strategy === 'update_owned_only'}
                  onChange={() => setStrategy('update_owned_only')}
                />
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600 }}>
                    {t('production.strategyUpdateOwned')}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                    {t('production.strategyUpdateOwnedDesc')}
                  </div>
                </div>
              </label>

              <label
                className={`prod-strategy-option ${strategy === 'skip_conflicting' ? 'active' : ''}`}
                data-testid="strategy-skip-conflicting"
              >
                <input
                  type="radio"
                  name="timelineStrategy"
                  checked={strategy === 'skip_conflicting'}
                  onChange={() => setStrategy('skip_conflicting')}
                />
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600 }}>
                    {t('production.strategySkipConflicting')}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                    {t('production.strategySkipConflictingDesc')}
                  </div>
                </div>
              </label>

              <label
                className={`prod-strategy-option ${strategy === 'append_after_existing' ? 'active' : ''}`}
                data-testid="strategy-append-after"
              >
                <input
                  type="radio"
                  name="timelineStrategy"
                  checked={strategy === 'append_after_existing'}
                  onChange={() => setStrategy('append_after_existing')}
                />
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600 }}>
                    {t('production.strategyAppendAfter', {
                      offset: (preview.append_offset_ms / 1000).toFixed(1),
                    })}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                    {t('production.strategyAppendAfterDesc')}
                  </div>
                </div>
              </label>
            </div>
          </div>

          {/* Per-Shot Operations Preview List */}
          <div className="prod-preview-list">
            {preview.shots.length === 0 ? (
              <div className="director-empty-inline">{t('production.noTargetShotsInScope')}</div>
            ) : (
              preview.shots.map((item) => {
                const willSkipForConflict =
                  strategy === 'skip_conflicting' && item.conflicts.length > 0;
                return (
                  <div
                    key={item.production_shot_id}
                    className={`prod-preview-row ${willSkipForConflict ? 'skipped' : ''}`}
                    data-testid={`preview-shot-row-${item.shot_order}`}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                        marginBottom: 5,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                        <span className="mono" style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent-text)' }}>
                          #{item.shot_order}
                        </span>
                        <strong style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {item.title}
                        </strong>
                        {item.is_reapply ? (
                          <span className="director-badge edited">{t('production.reapplyBadge')}</span>
                        ) : (
                          <span className="director-badge accepted">{t('production.newBadge')}</span>
                        )}
                        {willSkipForConflict && (
                          <span className="director-badge warning">
                            {t('production.willSkipConflictBadge')}
                          </span>
                        )}
                      </div>
                      <span className="mono" style={{ fontSize: 10, color: 'var(--text-secondary)', flexShrink: 0 }}>
                        {(item.start_ms / 1000).toFixed(1)}s → {(item.end_ms / 1000).toFixed(1)}s (
                        {(item.duration_ms / 1000).toFixed(1)}s)
                      </span>
                    </div>

                    <div className="director-chip-row" style={{ marginBottom: item.conflicts.length || item.skipped_unsupported.length ? 6 : 0 }}>
                      <span className="director-chip">
                        <Users size={10} /> {item.characters_to_place.length}{' '}
                        {t('production.charsShort')}
                      </span>
                      <span className="director-chip">
                        <Sparkles size={10} /> {item.animations_to_apply.length}{' '}
                        {t('production.animsShort')}
                      </span>
                      <span
                        className="director-chip"
                        style={{
                          borderColor: item.camera_executable
                            ? 'rgba(34, 197, 94, 0.35)'
                            : 'rgba(245, 158, 11, 0.35)',
                        }}
                      >
                        <Camera size={10} /> {item.camera_summary}
                      </span>
                      <span className="director-chip">
                        <Music size={10} /> {item.audio_to_place.length}{' '}
                        {t('production.audioShort')}
                      </span>
                      <span className="director-chip">
                        <Captions size={10} /> {item.subtitles_to_place}{' '}
                        {t('production.subsShort')}
                      </span>
                    </div>

                    {item.conflicts.length > 0 && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 4 }}>
                        {item.conflicts.map((c) => (
                          <div
                            key={c.conflict_id}
                            style={{ fontSize: 10, color: 'var(--warning)', display: 'flex', alignItems: 'center', gap: 5 }}
                          >
                            <AlertTriangle size={11} style={{ flexShrink: 0 }} />
                            <span>{c.description}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {item.skipped_unsupported.length > 0 && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 }}>
                        {item.skipped_unsupported.map((sk, idx) => (
                          <div
                            key={idx}
                            style={{ fontSize: 10, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 5 }}
                          >
                            <Film size={10} style={{ flexShrink: 0 }} />
                            <span>{sk}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
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
              data-testid="preview-open-stage-checkbox"
            />
            {t('production.openStageAfterApply')}
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={preview.shots.length === 0}
              onClick={handleConfirmApply}
              data-testid="timeline-preview-confirm-btn"
              style={{ flexShrink: 0 }}
            >
              <CheckCircle2 size={13} />
              {t('production.confirmApplyBtn', { count: preview.shots.length })}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
