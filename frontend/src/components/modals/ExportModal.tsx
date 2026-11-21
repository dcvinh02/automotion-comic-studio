import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Download,
  FolderOpen,
  Info,
  ListPlus,
  RefreshCw,
  X,
} from 'lucide-react';
import { useI18n } from '@/i18n/useLocaleStore';
import { apiClient } from '@/services/apiClient';
import { useJobStore } from '@/stores/useJobStore';
import { useProjectStore } from '@/stores/useProjectStore';
import type {
  ExportPlan,
  ExportScopeKind,
  ExportSettings,
  FFmpegEnvironment,
  QCReport,
  ResolutionPresetId,
} from '@/types/models';
import { LoadingState } from '@/components/common/CommonUI';
import { CollapsibleSection } from '@/components/ui/CollapsibleSection';
import {
  FPS_OPTIONS,
  RESOLUTION_OPTIONS,
  formatDuration,
  hasShots,
  loadExportSettings,
  saveExportSettings,
  scopeForKind,
} from '@/engine/exportSettings';

const CONTAINER_LABEL: Record<string, string> = { mp4: 'MP4', mov: 'MOV (QuickTime)', webm: 'WebM' };

export function ExportModal({
  onClose,
  initialSettings,
}: {
  onClose: () => void;
  initialSettings?: ExportSettings | null;
}) {
  const { t } = useI18n();
  const project = useProjectStore((s) => s.project);
  const saveProject = useProjectStore((s) => s.saveProject);
  const activeSceneId = useProjectStore((s) => s.activeSceneId);
  const activeShotId = useProjectStore((s) => s.activeShotId);
  const pixiConnected = useJobStore((s) => s.pixiWorkerConnected);
  const upsertJob = useJobStore((s) => s.upsertJob);
  const setDrawerOpen = useJobStore((s) => s.setDrawerOpen);
  const pushToast = useJobStore((s) => s.pushToast);

  const [settings, setSettings] = useState<ExportSettings | null>(() =>
    project
      ? initialSettings
        ? { ...initialSettings, filename: initialSettings.filename }
        : loadExportSettings(project, { activeSceneId, activeShotId })
      : null,
  );
  const [qc, setQc] = useState<QCReport | null>(null);
  const [loadingQc, setLoadingQc] = useState(true);
  const [env, setEnv] = useState<FFmpegEnvironment | null>(null);
  const [plan, setPlan] = useState<ExportPlan | null>(null);
  const [validating, setValidating] = useState(false);
  const [starting, setStarting] = useState<null | 'queue' | 'render_now'>(null);
  const validateSeq = useRef(0);

  const cueCount = (project?.subtitles?.segments ?? []).filter((s) => s.enabled && s.text.trim()).length;
  const sortedScenes = useMemo(
    () => [...(project?.scenes ?? [])].sort((a, b) => a.start_ms - b.start_ms || a.order_index - b.order_index),
    [project?.scenes],
  );

  const runQc = async () => {
    if (!project) return;
    setLoadingQc(true);
    try {
      await saveProject(false);
      setQc(await apiClient.runQC(project.meta.project_id));
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : 'QC error');
    } finally {
      setLoadingQc(false);
    }
  };

  useEffect(() => {
    void runQc();
    apiClient
      .getRenderEnvironment()
      .then(setEnv)
      .catch(() => setEnv(null));
  }, [project?.meta.project_id]);

  // Debounced server-side validation: the backend is the single source of truth for what will render.
  useEffect(() => {
    if (!project || !settings) return;
    const seq = ++validateSeq.current;
    setValidating(true);
    const handle = window.setTimeout(() => {
      apiClient
        .validateExport(project.meta.project_id, settings)
        .then((p) => {
          if (seq === validateSeq.current) setPlan(p);
        })
        .catch((err) => {
          if (seq === validateSeq.current) {
            setPlan(null);
            pushToast('error', err instanceof Error ? err.message : 'Validation error');
          }
        })
        .finally(() => {
          if (seq === validateSeq.current) setValidating(false);
        });
    }, 300);
    return () => window.clearTimeout(handle);
  }, [project?.meta.project_id, JSON.stringify(settings)]);

  if (!project || !settings) return null;

  const update = (patch: Partial<ExportSettings>) => setSettings((s) => (s ? { ...s, ...patch } : s));
  const updateNested = <K extends 'audio' | 'subtitles' | 'advanced'>(key: K, patch: Partial<ExportSettings[K]>) =>
    setSettings((s) => (s ? { ...s, [key]: { ...s[key], ...patch } } : s));

  const codecs = env?.codecs ?? [];
  const currentCodec = codecs.find((c) => c.codec === settings.video_codec);
  const availableContainers = (env?.containers ?? ['mp4']).filter((c) =>
    codecs.some((cd) => cd.available && cd.containers.includes(c)),
  );
  const codecsForContainer = codecs.filter((c) => c.available && c.containers.includes(settings.container));
  const hwAvailable = Boolean(currentCodec && currentCodec.hardware_encoders.length > 0);

  const setContainer = (container: ExportSettings['container']) => {
    const keep = codecs.find((c) => c.codec === settings.video_codec && c.available && c.containers.includes(container));
    const fallback = codecs.find((c) => c.available && c.containers.includes(container));
    const subtitles =
      container === 'webm' && settings.subtitles.mode === 'soft'
        ? { ...settings.subtitles, mode: 'burn_in' as const }
        : settings.subtitles;
    update({ container, video_codec: keep ? settings.video_codec : (fallback?.codec ?? 'h264'), subtitles });
  };

  const setResolution = (id: ResolutionPresetId) => {
    const opt = RESOLUTION_OPTIONS.find((o) => o.id === id);
    if (id === 'project') update({ resolution_preset: id, width: project.meta.width, height: project.meta.height });
    else if (opt?.w && opt.h) update({ resolution_preset: id, width: opt.w, height: opt.h });
    else update({ resolution_preset: id });
  };

  const setScopeKind = (kind: ExportScopeKind) =>
    update({ scope: scopeForKind(kind, project, { activeSceneId, activeShotId }) });

  const toggleScene = (sceneId: string) => {
    const ids = new Set(settings.scope.scene_ids);
    if (settings.scope.kind === 'scene') {
      update({ scope: { ...settings.scope, scene_ids: [sceneId] } });
      return;
    }
    if (ids.has(sceneId)) ids.delete(sceneId);
    else ids.add(sceneId);
    update({ scope: { ...settings.scope, scene_ids: [...ids] } });
  };

  const toggleShot = (sceneId: string, shotId: string) => {
    const exists = settings.scope.shots.some((r) => r.shot_id === shotId && r.scene_id === sceneId);
    if (settings.scope.kind === 'shot') {
      update({ scope: { ...settings.scope, shots: [{ scene_id: sceneId, shot_id: shotId }] } });
      return;
    }
    update({
      scope: {
        ...settings.scope,
        shots: exists
          ? settings.scope.shots.filter((r) => !(r.shot_id === shotId && r.scene_id === sceneId))
          : [...settings.scope.shots, { scene_id: sceneId, shot_id: shotId }],
      },
    });
  };

  const errors = plan?.issues.filter((i) => i.severity === 'error') ?? [];
  const qcBlocked = Boolean(qc && !qc.passed);
  const canStart = Boolean(plan?.valid) && !validating && !loadingQc && !qcBlocked && !starting;

  const handleStart = async (mode: 'queue' | 'render_now') => {
    setStarting(mode);
    try {
      await saveProject(true);
      const job = await apiClient.startExport({
        project_id: project.meta.project_id,
        preset_id: project.meta.default_export_preset_id,
        settings,
        start_mode: mode,
        ignore_warnings: true,
      });
      saveExportSettings(project.meta.project_id, settings);
      upsertJob(job);
      setDrawerOpen(true);
      pushToast('info', mode === 'queue' ? t('export.toastQueued', { name: job.name || job.job_id }) : t('export.toastStarted', { name: job.name || job.job_id }));
      onClose();
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : 'Export error');
    } finally {
      setStarting(null);
    }
  };

  const issueIcon = (sev: string) =>
    sev === 'error' ? (
      <AlertCircle size={13} color="var(--danger-text)" style={{ flexShrink: 0, marginTop: 1 }} />
    ) : sev === 'warning' ? (
      <AlertTriangle size={13} color="var(--warning-text)" style={{ flexShrink: 0, marginTop: 1 }} />
    ) : (
      <Info size={13} color="var(--text-muted)" style={{ flexShrink: 0, marginTop: 1 }} />
    );

  const issueBox = (sev: string): React.CSSProperties => ({
    display: 'flex',
    gap: 6,
    alignItems: 'flex-start',
    fontSize: 11,
    padding: '5px 7px',
    borderRadius: 4,
    background: sev === 'error' || sev === 'critical' ? 'var(--danger-soft)' : sev === 'warning' ? 'var(--warning-soft)' : 'var(--surface-base)',
    border:
      sev === 'error' || sev === 'critical'
        ? '1px solid var(--danger-border)'
        : sev === 'warning'
          ? '1px solid var(--warning-border)'
          : '1px solid var(--border-subtle)',
  });

  const scopeKinds: ExportScopeKind[] = ['project', 'scene', 'scenes', ...(hasShots(project) ? (['shot', 'shots'] as const) : []), 'range'];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-box" style={{ width: 'min(820px, 94vw)' }} onClick={(e) => e.stopPropagation()} data-testid="export-modal">
        <div className="modal-header">
          <span>{t('export.title')}</span>
          <button className="btn-ghost btn-icon" onClick={onClose} aria-label={t('common.close')}>
            <X size={14} />
          </button>
        </div>

        <div className="modal-body" style={{ overflowY: 'auto' }}>
          {env && !env.available && (
            <div className="error-banner" style={{ fontSize: 11 }}>
              <strong>{t('export.ffmpegMissingTitle')}</strong> {t('export.ffmpegMissingDesc')}
              {env.problems.length > 0 && <div className="mono" style={{ marginTop: 4 }}>{env.problems.join(' · ')}</div>}
            </div>
          )}

          {/* ---------------- Scope ---------------- */}
          <div className="inspector-section" style={{ gap: 6 }}>
            <div className="inspector-section-title">
              <span>{t('export.scope')}</span>
            </div>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }} role="radiogroup" aria-label={t('export.scope')}>
              {scopeKinds.map((k) => (
                <button
                  key={k}
                  type="button"
                  className={settings.scope.kind === k ? 'btn-primary btn-xs' : 'btn-xs'}
                  aria-pressed={settings.scope.kind === k}
                  onClick={() => setScopeKind(k)}
                  data-testid={`export-scope-${k}`}
                >
                  {t(`export.scope_${k}`)}
                </button>
              ))}
            </div>

            {(settings.scope.kind === 'scene' || settings.scope.kind === 'scenes') && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 130, overflowY: 'auto' }}>
                {sortedScenes.length === 0 && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t('export.noScenes')}</span>}
                {sortedScenes.map((sc) => (
                  <label key={sc.scene_id} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11 }}>
                    <input
                      type={settings.scope.kind === 'scene' ? 'radio' : 'checkbox'}
                      name="export-scene"
                      checked={settings.scope.scene_ids.includes(sc.scene_id)}
                      onChange={() => toggleScene(sc.scene_id)}
                    />
                    <span>{sc.name}</span>
                    <span className="mono" style={{ color: 'var(--text-muted)' }}>
                      {formatDuration(sc.start_ms / 1000)} · {(sc.duration_ms / 1000).toFixed(2)}s
                    </span>
                  </label>
                ))}
              </div>
            )}

            {(settings.scope.kind === 'shot' || settings.scope.kind === 'shots') && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 150, overflowY: 'auto' }}>
                {sortedScenes
                  .filter((sc) => (sc.shots ?? []).length > 0)
                  .map((sc) => (
                    <div key={sc.scene_id} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600 }}>{sc.name}</span>
                      {[...(sc.shots ?? [])]
                        .sort((a, b) => a.start_ms - b.start_ms || a.shot_order - b.shot_order)
                        .map((sh) => (
                          <label key={sh.shot_id} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11, paddingLeft: 10 }}>
                            <input
                              type={settings.scope.kind === 'shot' ? 'radio' : 'checkbox'}
                              name="export-shot"
                              checked={settings.scope.shots.some((r) => r.shot_id === sh.shot_id && r.scene_id === sc.scene_id)}
                              onChange={() => toggleShot(sc.scene_id, sh.shot_id)}
                            />
                            <span>#{sh.shot_order} {sh.title}</span>
                            <span className="mono" style={{ color: 'var(--text-muted)' }}>{(sh.duration_ms / 1000).toFixed(2)}s</span>
                          </label>
                        ))}
                    </div>
                  ))}
              </div>
            )}

            {settings.scope.kind === 'range' && (
              <div className="field-grid">
                <div className="field-row">
                  <label className="field-label">{t('export.rangeStart')}</label>
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    value={((settings.scope.range_start_ms ?? 0) / 1000).toString()}
                    onChange={(e) => update({ scope: { ...settings.scope, range_start_ms: Math.max(0, Math.round(Number(e.target.value) * 1000)) } })}
                  />
                </div>
                <div className="field-row">
                  <label className="field-label">{t('export.rangeEnd')}</label>
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    value={((settings.scope.range_end_ms ?? 0) / 1000).toString()}
                    onChange={(e) => update({ scope: { ...settings.scope, range_end_ms: Math.max(0, Math.round(Number(e.target.value) * 1000)) } })}
                  />
                </div>
              </div>
            )}
          </div>

          {/* ---------------- Video ---------------- */}
          <div className="inspector-section" style={{ gap: 6 }}>
            <div className="inspector-section-title">
              <span>{t('export.video')}</span>
            </div>
            <div className="field-grid">
              <div className="field-row">
                <label className="field-label">{t('export.resolution')}</label>
                <select value={settings.resolution_preset} onChange={(e) => setResolution(e.target.value as ResolutionPresetId)} data-testid="export-resolution">
                  {RESOLUTION_OPTIONS.map((o) => (
                    <option key={o.id} value={o.id}>
                      {t(`export.res_${o.id}`)}
                      {o.id === 'project' ? ` (${project.meta.width}×${project.meta.height})` : o.w ? ` (${o.w}×${o.h})` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field-row">
                <label className="field-label">{t('export.fps')}</label>
                <select
                  value={FPS_OPTIONS.includes(settings.fps) ? String(settings.fps) : 'custom'}
                  onChange={(e) => update({ fps: e.target.value === 'custom' ? settings.fps : Number(e.target.value) })}
                  data-testid="export-fps"
                >
                  {FPS_OPTIONS.map((f) => (
                    <option key={f} value={f}>
                      {f} fps
                    </option>
                  ))}
                  <option value="custom">{t('export.custom')}</option>
                </select>
              </div>
            </div>
            {(settings.resolution_preset === 'custom' || !FPS_OPTIONS.includes(settings.fps)) && (
              <div className="field-grid">
                {settings.resolution_preset === 'custom' && (
                  <div className="field-row">
                    <label className="field-label">{t('export.customSize')}</label>
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      <input type="number" min={128} max={4096} step={2} value={settings.width} onChange={(e) => update({ width: Math.round(Number(e.target.value) || 0) })} style={{ width: 80 }} />
                      ×
                      <input type="number" min={128} max={4096} step={2} value={settings.height} onChange={(e) => update({ height: Math.round(Number(e.target.value) || 0) })} style={{ width: 80 }} />
                    </div>
                  </div>
                )}
                {!FPS_OPTIONS.includes(settings.fps) || settings.resolution_preset === 'custom' ? (
                  <div className="field-row">
                    <label className="field-label">{t('export.customFps')}</label>
                    <input type="number" min={10} max={120} value={settings.fps} onChange={(e) => update({ fps: Math.round(Number(e.target.value) || 0) })} style={{ width: 80 }} />
                  </div>
                ) : null}
              </div>
            )}
            {Math.abs(settings.width / Math.max(1, settings.height) - project.meta.width / project.meta.height) > 0.01 && (
              <div className="field-row">
                <label className="field-label">{t('export.aspectMode')}</label>
                <select value={settings.aspect_mode} onChange={(e) => update({ aspect_mode: e.target.value as ExportSettings['aspect_mode'] })}>
                  <option value="fit">{t('export.aspect_fit')}</option>
                  <option value="fill">{t('export.aspect_fill')}</option>
                  <option value="stretch">{t('export.aspect_stretch')}</option>
                </select>
              </div>
            )}
            <div className="field-grid">
              <div className="field-row">
                <label className="field-label">{t('export.format')}</label>
                <select value={settings.container} onChange={(e) => setContainer(e.target.value as ExportSettings['container'])} data-testid="export-format">
                  {(availableContainers.length ? availableContainers : ['mp4']).map((c) => (
                    <option key={c} value={c}>
                      {CONTAINER_LABEL[c] ?? c}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field-row">
                <label className="field-label">{t('export.codec')}</label>
                <select value={settings.video_codec} onChange={(e) => update({ video_codec: e.target.value as ExportSettings['video_codec'] })} data-testid="export-codec">
                  {(codecsForContainer.length ? codecsForContainer : [{ codec: 'h264', label: 'H.264 / AVC' }]).map((c) => (
                    <option key={c.codec} value={c.codec}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="field-grid">
              <div className="field-row">
                <label className="field-label">{t('export.quality')}</label>
                <select value={settings.quality} onChange={(e) => update({ quality: e.target.value as ExportSettings['quality'] })} data-testid="export-quality" title={t(`export.qualityHint_${settings.quality}`)}>
                  {(['draft', 'standard', 'high', 'maximum'] as const).map((q) => (
                    <option key={q} value={q}>
                      {t(`export.quality_${q}`)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field-row">
                <label className="field-label">{t('export.encoder')}</label>
                <select value={settings.encoder} onChange={(e) => update({ encoder: e.target.value as ExportSettings['encoder'] })}>
                  <option value="auto">{t('export.encoder_auto')}</option>
                  <option value="software" disabled={!currentCodec?.software_encoder}>
                    {t('export.encoder_software')}
                    {currentCodec?.software_encoder ? ` (${currentCodec.software_encoder})` : ''}
                  </option>
                  <option value="hardware" disabled={!hwAvailable}>
                    {t('export.encoder_hardware')}
                    {hwAvailable ? ` (${currentCodec?.hardware_encoders[0]})` : ` — ${t('export.unavailable')}`}
                  </option>
                </select>
              </div>
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{t(`export.qualityHint_${settings.quality}`)}</div>

            <CollapsibleSection title={t('export.advanced')} defaultOpen={false}>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>{t('export.advancedHint')}</div>
              <div className="field-grid">
                <div className="field-row">
                  <label className="field-label">CRF</label>
                  <input type="number" min={0} max={63} placeholder={t('export.fromPreset')} value={settings.advanced.crf ?? ''} onChange={(e) => updateNested('advanced', { crf: e.target.value === '' ? null : Number(e.target.value) })} />
                </div>
                <div className="field-row">
                  <label className="field-label">{t('export.bitrate')}</label>
                  <input type="number" min={200} max={200000} placeholder={t('export.fromPreset')} value={settings.advanced.bitrate_kbps ?? ''} onChange={(e) => updateNested('advanced', { bitrate_kbps: e.target.value === '' ? null : Number(e.target.value) })} />
                </div>
                <div className="field-row">
                  <label className="field-label">{t('export.encoderPreset')}</label>
                  <input placeholder={t('export.fromPreset')} value={settings.advanced.encoder_preset ?? ''} onChange={(e) => updateNested('advanced', { encoder_preset: e.target.value.trim() || null })} />
                </div>
                <div className="field-row">
                  <label className="field-label">{t('export.profile')}</label>
                  <input placeholder={t('export.fromPreset')} value={settings.advanced.profile ?? ''} onChange={(e) => updateNested('advanced', { profile: e.target.value.trim() || null })} />
                </div>
                <div className="field-row">
                  <label className="field-label">{t('export.pixFmt')}</label>
                  <select value={settings.advanced.pix_fmt ?? ''} onChange={(e) => updateNested('advanced', { pix_fmt: e.target.value || null })}>
                    <option value="">{t('export.fromPreset')}</option>
                    {['yuv420p', 'yuv422p', 'yuv444p', 'yuv422p10le', 'yuv444p10le'].map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field-row">
                  <label className="field-label">{t('export.keyint')}</label>
                  <input type="number" min={1} max={1200} placeholder={`${settings.fps * 2}`} value={settings.advanced.keyframe_interval ?? ''} onChange={(e) => updateNested('advanced', { keyframe_interval: e.target.value === '' ? null : Number(e.target.value) })} />
                </div>
                <div className="field-row">
                  <label className="field-label">{t('modal.renderEngine')}</label>
                  <select value={settings.render_mode} onChange={(e) => update({ render_mode: e.target.value as ExportSettings['render_mode'] })}>
                    <option value="auto">Auto ({pixiConnected ? t('status.webglWorker') : t('status.softwareFallback')})</option>
                    <option value="pixi_stream" disabled={!pixiConnected}>PixiJS WebGL Stream</option>
                    <option value="software_compositor">Software Compositor (Pillow)</option>
                  </select>
                </div>
                <div className="field-row">
                  <label className="field-label">{t('modal.chunkSize')}</label>
                  <select value={settings.chunk_duration_seconds} onChange={(e) => update({ chunk_duration_seconds: Number(e.target.value) })}>
                    {[5, 10, 15, 30].map((c) => (
                      <option key={c} value={c}>
                        {c}s / chunk
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </CollapsibleSection>
          </div>

          {/* ---------------- Audio + Subtitles ---------------- */}
          <div className="field-grid" style={{ alignItems: 'start' }}>
            <div className="inspector-section" style={{ gap: 6 }}>
              <div className="inspector-section-title">
                <span>{t('export.audio')}</span>
              </div>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11 }}>
                <input type="checkbox" checked={settings.audio.enabled} onChange={(e) => updateNested('audio', { enabled: e.target.checked })} data-testid="export-audio-enabled" />
                {t('export.includeAudio')}
              </label>
              {settings.audio.enabled && (
                <>
                  <div className="field-grid">
                    <div className="field-row">
                      <label className="field-label">{t('export.audioBitrate')}</label>
                      <select value={settings.audio.bitrate_kbps} onChange={(e) => updateNested('audio', { bitrate_kbps: Number(e.target.value) })}>
                        {[128, 160, 192, 256, 320].map((b) => (
                          <option key={b} value={b}>
                            {b} kbps
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="field-row">
                      <label className="field-label">{t('export.sampleRate')}</label>
                      <select value={settings.audio.sample_rate} disabled={settings.container === 'webm'} onChange={(e) => updateNested('audio', { sample_rate: Number(e.target.value) as 44100 | 48000 })}>
                        <option value={48000}>48 kHz</option>
                        <option value={44100}>44.1 kHz</option>
                      </select>
                    </div>
                  </div>
                  <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11 }} title={t('export.normalizeHint')}>
                    <input type="checkbox" checked={settings.audio.normalize_loudness} onChange={(e) => updateNested('audio', { normalize_loudness: e.target.checked })} />
                    {t('export.normalize', { lufs: settings.audio.target_lufs })}
                  </label>
                </>
              )}
            </div>

            <div className="inspector-section" style={{ gap: 6 }}>
              <div className="inspector-section-title">
                <span>{t('modal.subtitleExportTitle')}</span>
                <span className="tag-pill">{t('modal.enabledSubsCount', { count: cueCount })}</span>
              </div>
              <div className="field-row">
                <label className="field-label">{t('modal.subtitleMode')}</label>
                <select value={settings.subtitles.mode} disabled={cueCount === 0} onChange={(e) => updateNested('subtitles', { mode: e.target.value as ExportSettings['subtitles']['mode'] })} data-testid="export-subtitle-mode">
                  <option value="none">{t('export.subNone')}</option>
                  <option value="burn_in">{t('modal.subModeBurnIn')}</option>
                  <option value="soft" disabled={settings.container === 'webm'}>
                    {t('export.subSoft')}
                  </option>
                </select>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                <input type="checkbox" disabled={cueCount === 0} checked={settings.subtitles.export_srt} onChange={(e) => updateNested('subtitles', { export_srt: e.target.checked })} data-testid="export-srt-sidecar" />
                {t('modal.exportSrtSidecar')}
              </label>
            </div>
          </div>

          {/* ---------------- Output ---------------- */}
          <div className="inspector-section" style={{ gap: 6 }}>
            <div className="inspector-section-title">
              <span>{t('export.output')}</span>
            </div>
            <div className="field-row">
              <label className="field-label">{t('export.folder')}</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  value={settings.output_dir ?? ''}
                  onChange={(e) => update({ output_dir: e.target.value || null })}
                  placeholder={t('export.folderPlaceholder')}
                  style={{ flex: 1 }}
                  data-testid="export-output-dir"
                />
                {window.electronAPI && (
                  <button
                    type="button"
                    onClick={async () => {
                      const picked = await window.electronAPI?.selectExportDirectory();
                      if (picked) update({ output_dir: picked });
                    }}
                  >
                    <FolderOpen size={12} /> {t('common.browse')}
                  </button>
                )}
              </div>
            </div>
            <div className="field-grid">
              <div className="field-row">
                <label className="field-label">{t('export.filename')}</label>
                <input value={settings.filename ?? ''} placeholder={t('export.filenamePlaceholder')} onChange={(e) => update({ filename: e.target.value || null })} data-testid="export-filename" />
              </div>
              <div className="field-row">
                <label className="field-label">{t('export.collision')}</label>
                <select value={settings.collision_policy} onChange={(e) => update({ collision_policy: e.target.value as ExportSettings['collision_policy'] })}>
                  <option value="auto_number">{t('export.collision_auto_number')}</option>
                  <option value="fail">{t('export.collision_fail')}</option>
                  <option value="overwrite">{t('export.collision_overwrite')}</option>
                </select>
              </div>
            </div>
          </div>

          {/* ---------------- Review ---------------- */}
          <div className="inspector-section" style={{ gap: 6 }} data-testid="export-review">
            <div className="inspector-section-title">
              <span>{t('export.review')}</span>
              <button className="btn-xs" onClick={() => void runQc()}>
                <RefreshCw size={11} /> {t('modal.recheck')}
              </button>
            </div>
            {loadingQc ? (
              <LoadingState label={t('modal.validatingQc')} />
            ) : qc ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
                {qc.passed ? <CheckCircle2 size={14} color="var(--success)" /> : <AlertCircle size={14} color="var(--danger)" />}
                <span style={{ fontWeight: 600 }}>
                  {qc.passed
                    ? t('modal.qcPassed', { warnings: qc.warning_count })
                    : t('modal.qcBlocked', { critical: qc.critical_count, warnings: qc.warning_count })}
                </span>
              </div>
            ) : null}
            {qc && qc.issues.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 110, overflowY: 'auto' }}>
                {qc.issues.map((issue, i) => (
                  <div key={`qc-${i}`} style={issueBox(issue.severity)}>
                    {issueIcon(issue.severity === 'critical' ? 'error' : issue.severity)}
                    <div>
                      <strong className="mono" style={{ fontSize: 10 }}>[{issue.code}]</strong> {issue.message}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {validating && !plan ? (
              <LoadingState label={t('export.validating')} />
            ) : plan ? (
              <>
                <div className="field-grid" style={{ fontSize: 11 }}>
                  <div>
                    <div style={{ color: 'var(--text-muted)' }}>{t('export.summaryOutput')}</div>
                    <div className="mono" style={{ wordBreak: 'break-all' }} data-testid="export-resolved-path">
                      {plan.output_path ?? '—'}
                    </div>
                  </div>
                  <div>
                    <div style={{ color: 'var(--text-muted)' }}>{t('export.summaryRender')}</div>
                    <div className="mono">
                      {plan.settings.width}×{plan.settings.height} · {plan.settings.fps} fps · {plan.total_frames} {t('export.frames')} · {formatDuration(plan.duration_ms / 1000)}
                    </div>
                    <div className="mono" style={{ color: 'var(--text-muted)' }}>
                      {plan.encoder?.description ?? '—'} · {plan.renderer ?? '—'}
                      {plan.segments.length > 1 ? ` · ${plan.segments.length} ${t('export.segments')}` : ''}
                    </div>
                  </div>
                </div>
                {plan.issues.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 140, overflowY: 'auto' }} data-testid="export-plan-issues">
                    {[...plan.issues]
                      .sort((a, b) => ['error', 'warning', 'info'].indexOf(a.severity) - ['error', 'warning', 'info'].indexOf(b.severity))
                      .map((issue, i) => (
                        <div key={`pl-${i}`} style={issueBox(issue.severity)}>
                          {issueIcon(issue.severity)}
                          <div>{issue.message}</div>
                        </div>
                      ))}
                  </div>
                )}
              </>
            ) : null}
          </div>
        </div>

        <div className="modal-footer">
          <span style={{ marginRight: 'auto', fontSize: 11, color: errors.length ? 'var(--danger-text)' : 'var(--text-muted)' }}>
            {errors.length
              ? t('export.blockedBy', { count: errors.length })
              : qcBlocked
                ? t('export.blockedByQc')
                : validating
                  ? t('export.validating')
                  : plan?.valid
                    ? t('export.ready')
                    : ''}
          </span>
          <button onClick={onClose}>{t('common.cancel')}</button>
          <button disabled={!canStart} onClick={() => void handleStart('queue')} data-testid="export-add-queue">
            <ListPlus size={13} /> {starting === 'queue' ? t('modal.queueing') : t('export.addToQueue')}
          </button>
          <button className="btn-primary" disabled={!canStart} onClick={() => void handleStart('render_now')} data-testid="export-render-now">
            <Download size={13} /> {starting === 'render_now' ? t('modal.queueing') : t('export.renderNow')}
          </button>
        </div>
      </div>
    </div>
  );
}
