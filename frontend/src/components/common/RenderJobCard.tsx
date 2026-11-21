import { useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Copy,
  FileText,
  FolderOpen,
  Pause,
  Play,
  PlayCircle,
  RefreshCw,
  Repeat,
  SkipForward,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { useI18n } from '@/i18n/useLocaleStore';
import { apiClient } from '@/services/apiClient';
import { useJobStore } from '@/stores/useJobStore';
import { ACTIVE_JOB_STATUSES, WAITING_JOB_STATUSES, type ExportSettings, type RenderJob } from '@/types/models';
import { formatBytes, formatDuration } from '@/engine/exportSettings';

const STAGES = ['queued', 'preparing', 'rendering', 'encoding', 'validating', 'completed'] as const;

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function RenderJobCard({
  job,
  compact = false,
  onReexport,
}: {
  job: RenderJob;
  compact?: boolean;
  onReexport?: (settings: ExportSettings) => void;
}) {
  const { t } = useI18n();
  const upsertJob = useJobStore((s) => s.upsertJob);
  const removeJobLocal = useJobStore((s) => s.removeJobLocal);
  const refreshJobs = useJobStore((s) => s.refreshJobs);
  const pushToast = useJobStore((s) => s.pushToast);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [log, setLog] = useState<string | null>(null);

  const pid = job.project_id;
  const settings = (job.input_json?.settings ?? null) as ExportSettings | null;
  const out = job.output_json ?? {};
  const outputPath = str(out.output_path);
  const progress = job.progress ?? {};
  const isActive = ACTIVE_JOB_STATUSES.includes(job.status);
  const isWaiting = WAITING_JOB_STATUSES.includes(job.status);
  const framesDone = progress.frames_done ?? 0;
  const totalFrames = progress.total_frames ?? num(job.input_json?.total_frames) ?? 0;
  const renderPct = totalFrames > 0 ? Math.min(100, (framesDone / totalFrames) * 100) : 0;
  const needsReview = Boolean(out.needs_review);
  const warnings = Array.isArray(out.warnings) ? (out.warnings as { message: string }[]) : [];

  const act = async (fn: () => Promise<RenderJob | unknown>, okMsg?: string) => {
    setBusy(true);
    try {
      const res = await fn();
      if (res && typeof res === 'object' && 'job_id' in (res as RenderJob)) upsertJob(res as RenderJob);
      if (okMsg) pushToast('info', okMsg);
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const statusLabel = t(`rq.status_${job.status}`);
  const color =
    job.status === 'failed'
      ? 'var(--danger)'
      : job.status === 'completed'
        ? needsReview
          ? 'var(--warning)'
          : 'var(--success)'
        : job.status === 'cancelled' || job.status === 'paused'
          ? 'var(--text-muted)'
          : 'var(--accent)';

  const stageIdx = STAGES.indexOf((progress.stage ?? job.status) as (typeof STAGES)[number]);

  return (
    <div className="list-card" data-testid={`render-job-${job.job_id}`} data-status={job.status}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={job.name || job.job_id}>
            {job.name || job.job_id}
          </div>
          {settings && (
            <div className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
              {str(job.input_json?.scope_label) ?? settings.scope.kind} · {settings.width}×{settings.height} · {settings.fps}fps ·{' '}
              {settings.video_codec.toUpperCase()}/{settings.container.toUpperCase()} · {t(`export.quality_${settings.quality}`)}
            </div>
          )}
        </div>
        <span className="tag-pill mono" style={{ color, borderColor: color, flexShrink: 0 }} data-testid="render-job-status">
          {statusLabel}
          {job.status === 'completed' && needsReview ? ` · ${t('rq.needsReview')}` : ''}
        </span>
      </div>

      {(isActive || job.status === 'paused' || isWaiting || job.status === 'failed') && totalFrames > 0 && (
        <>
          <div style={{ height: 5, borderRadius: 3, background: 'var(--surface-base)', overflow: 'hidden' }} title={t('rq.renderProgress')}>
            <div style={{ width: `${renderPct}%`, height: '100%', background: color, transition: 'width 0.2s ease' }} />
          </div>
          <div className="mono" style={{ fontSize: 10, color: 'var(--text-secondary)', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <span>
              {t('rq.frames')}: {framesDone}/{totalFrames}
            </span>
            {progress.render_fps ? <span>{progress.render_fps.toFixed(1)} fps</span> : null}
            {isActive && progress.eta_seconds !== null && progress.eta_seconds !== undefined ? (
              <span>
                {t('rq.eta')}: {formatDuration(progress.eta_seconds)}
              </span>
            ) : null}
            {progress.active_seconds ? (
              <span>
                {t('rq.elapsed')}: {formatDuration(progress.active_seconds)}
              </span>
            ) : null}
          </div>
          {!compact && (isActive || job.status === 'paused') && (
            <div style={{ display: 'flex', gap: 3 }} aria-label={t('rq.stages')}>
              {STAGES.slice(1, 5).map((st, i) => (
                <span
                  key={st}
                  className="tag-pill mono"
                  style={{
                    fontSize: 9,
                    opacity: stageIdx === i + 1 ? 1 : stageIdx > i + 1 ? 0.75 : 0.35,
                    borderColor: stageIdx === i + 1 ? 'var(--accent)' : undefined,
                  }}
                >
                  {t(`rq.status_${st}`)}
                </span>
              ))}
            </div>
          )}
        </>
      )}

      <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{job.message}</div>

      {job.error_log && job.status !== 'completed' && (
        <div className="error-banner" style={{ fontSize: 10, padding: 6, whiteSpace: 'pre-wrap', maxHeight: 90, overflowY: 'auto' }}>
          {job.error_log}
        </div>
      )}

      {job.status === 'completed' && outputPath && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div className="mono" style={{ fontSize: 10, color: 'var(--success-text)', wordBreak: 'break-all' }}>
            {outputPath}
          </div>
          <div className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
            {formatBytes(num(out.file_size_bytes))} · {formatDuration(num(out.duration_s))} · {num(out.width)}×{num(out.height)} @ {num(out.fps)}fps ·{' '}
            {str(out.video_codec)}
            {str(out.audio_codec) ? `/${str(out.audio_codec)}` : ` · ${t('rq.noAudio')}`}
            {num(out.audio_loudness_lufs) !== null ? ` · ${num(out.audio_loudness_lufs)?.toFixed(1)} LUFS` : ''}
            {num(out.render_time_s) !== null ? ` · ${t('rq.renderTime')} ${formatDuration(num(out.render_time_s))}` : ''}
          </div>
          {warnings.length > 0 && (
            <div style={{ fontSize: 10, color: 'var(--warning-text)' }}>
              {warnings.map((w, i) => (
                <div key={i}>⚠ {w.message}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {preview && outputPath && (
        <div style={{ position: 'relative' }}>
          <video
            src={apiClient.getJobOutputUrl(pid, job.job_id)}
            controls
            autoPlay
            style={{ width: '100%', maxHeight: 260, background: '#000', borderRadius: 4 }}
            data-testid="render-job-preview"
          />
          <button className="btn-ghost btn-icon" style={{ position: 'absolute', top: 4, right: 4 }} onClick={() => setPreview(false)} aria-label={t('common.close')}>
            <X size={12} />
          </button>
        </div>
      )}

      {log !== null && (
        <pre className="mono" style={{ fontSize: 9, maxHeight: 140, overflow: 'auto', background: 'var(--surface-base)', padding: 6, borderRadius: 4, whiteSpace: 'pre-wrap' }}>
          {log || '—'}
        </pre>
      )}

      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {isWaiting && (
          <>
            <button className="btn-xs" disabled={busy} title={t('rq.moveUp')} onClick={() => void act(async () => { await apiClient.moveJob(pid, job.job_id, 'up'); await refreshJobs(pid); })}>
              <ArrowUp size={10} />
            </button>
            <button className="btn-xs" disabled={busy} title={t('rq.moveDown')} onClick={() => void act(async () => { await apiClient.moveJob(pid, job.job_id, 'down'); await refreshJobs(pid); })}>
              <ArrowDown size={10} />
            </button>
          </>
        )}
        {(isActive || isWaiting) && (
          <button className="btn-xs" disabled={busy} onClick={() => void act(() => apiClient.pauseJob(pid, job.job_id))} data-testid="job-pause">
            <Pause size={10} /> {t('rq.pause')}
          </button>
        )}
        {job.status === 'paused' && (
          <button className="btn-primary btn-xs" disabled={busy} onClick={() => void act(() => apiClient.resumeJob(pid, job.job_id))} data-testid="job-resume">
            <Play size={10} /> {t('renderQueue.resume')}
          </button>
        )}
        {isActive && (
          <button className="btn-xs" disabled={busy} title={t('rq.skipHint')} onClick={() => void act(() => apiClient.skipJob(pid, job.job_id))}>
            <SkipForward size={10} /> {t('rq.skip')}
          </button>
        )}
        {(isActive || isWaiting || job.status === 'paused') && (
          <button className="btn-danger btn-xs" disabled={busy} onClick={() => void act(() => apiClient.cancelJob(pid, job.job_id))} data-testid="job-cancel">
            <Square size={10} /> {t('common.cancel')}
          </button>
        )}
        {(job.status === 'failed' || job.status === 'cancelled') && (
          <button className="btn-primary btn-xs" disabled={busy} title={t('rq.retryHint')} onClick={() => void act(() => apiClient.retryJob(pid, job.job_id))} data-testid="job-retry">
            <RefreshCw size={10} /> {t('rq.retry')}
          </button>
        )}
        {job.status === 'completed' && outputPath && (
          <>
            <button className="btn-xs" onClick={() => setPreview((v) => !v)} data-testid="job-preview">
              <PlayCircle size={10} /> {t('rq.preview')}
            </button>
            {window.electronAPI?.openPath && (
              <button
                className="btn-xs"
                onClick={async () => {
                  const err = await window.electronAPI?.openPath?.(outputPath);
                  if (err) pushToast('error', err);
                }}
              >
                <Play size={10} /> {t('rq.openFile')}
              </button>
            )}
            {window.electronAPI && (
              <button className="btn-xs" onClick={() => void window.electronAPI?.revealInFolder(outputPath)}>
                <FolderOpen size={10} /> {t('rq.openFolder')}
              </button>
            )}
            <button
              className="btn-xs"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(outputPath);
                  pushToast('success', t('rq.pathCopied'));
                } catch {
                  pushToast('error', outputPath);
                }
              }}
            >
              <Copy size={10} /> {t('rq.copyPath')}
            </button>
          </>
        )}
        {settings && (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') && (
          <button
            className="btn-xs"
            title={t('rq.reexportHint')}
            onClick={() => {
              if (onReexport) onReexport(settings);
              else void act(() => apiClient.reexportJob(pid, job.job_id, 'queue'), t('rq.reexportQueued'));
            }}
          >
            <Repeat size={10} /> {t('rq.reexport')}
          </button>
        )}
        {!isActive && (
          <button
            className="btn-xs"
            onClick={async () => {
              if (log !== null) {
                setLog(null);
                return;
              }
              try {
                setLog(await apiClient.getJobLog(pid, job.job_id));
              } catch (err) {
                setLog(err instanceof Error ? err.message : String(err));
              }
            }}
          >
            <FileText size={10} /> {t('rq.log')}
          </button>
        )}
        {!isActive &&
          (confirmRemove ? (
            <>
              <span style={{ fontSize: 10, color: 'var(--text-muted)', alignSelf: 'center' }}>{t('rq.removeConfirm')}</span>
              <button
                className="btn-danger btn-xs"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await apiClient.removeJob(pid, job.job_id);
                    removeJobLocal(job.job_id);
                  })
                }
                data-testid="job-remove-confirm"
              >
                {t('rq.remove')}
              </button>
              <button className="btn-xs" onClick={() => setConfirmRemove(false)}>
                {t('common.cancel')}
              </button>
            </>
          ) : (
            <button className="btn-xs" title={t('rq.removeHint')} onClick={() => setConfirmRemove(true)} data-testid="job-remove">
              <Trash2 size={10} />
            </button>
          ))}
      </div>
    </div>
  );
}
