import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Cpu,
  FileAudio,
  Film,
  Loader2,
  Play,
  PlugZap,
  Power,
  RefreshCw,
  Save,
  Square,
  Terminal,
  Trash2,
  Upload,
  Volume2,
} from 'lucide-react';
import { formatTimecode, WaveformCanvas } from '@/components/common/CommonUI';
import { frameToMs } from '@/engine/evaluator';
import { useI18n } from '@/i18n/useLocaleStore';
import { apiClient } from '@/services/apiClient';
import { useJobStore } from '@/stores/useJobStore';
import { useLibraryStore } from '@/stores/useLibraryStore';
import { usePlaybackStore } from '@/stores/usePlaybackStore';
import { useProjectStore } from '@/stores/useProjectStore';
import { useVoiceStore } from '@/stores/useVoiceStore';
import type {
  F5TTSDevicePreference,
  F5TTSReferenceVoice,
  F5TTSServiceMode,
  F5TTSStatus,
  F5TTSTestConnectionResult,
  VoiceAudioAsset,
} from '@/types/models';

export function F5TTSConfigSection() {
  const { t } = useI18n();
  const project = useProjectStore((s) => s.project);
  const addVoiceClipToTimeline = useProjectStore((s) => s.addVoiceClipToTimeline);
  const upsertSound = useLibraryStore((s) => s.upsertSound);
  const currentFrame = usePlaybackStore((s) => s.currentFrame);
  const refreshAllVoice = useVoiceStore((s) => s.refreshAll);
  const playAudioAsset = useVoiceStore((s) => s.playAudioAsset);
  const stopAudio = useVoiceStore((s) => s.stopAudio);
  const playingAudioId = useVoiceStore((s) => s.playingAudioId);
  const pushToast = useJobStore((s) => s.pushToast);

  const [status, setStatus] = useState<F5TTSStatus | null>(null);
  const [references, setReferences] = useState<F5TTSReferenceVoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testingConn, setTestingConn] = useState(false);
  const [connResult, setConnResult] = useState<F5TTSTestConnectionResult | null>(null);
  const [serviceBusy, setServiceBusy] = useState(false);
  const [serviceError, setServiceError] = useState<string | null>(null);

  // Config form state
  const [mode, setMode] = useState<F5TTSServiceMode>('external_http');
  const [serviceUrl, setServiceUrl] = useState('http://127.0.0.1:7860');
  const [pythonExec, setPythonExec] = useState('');
  const [modelName, setModelName] = useState('F5TTS_v1_Base');
  const [devicePref, setDevicePref] = useState<F5TTSDevicePreference>('auto');
  const [nfeStep, setNfeStep] = useState(32);
  const [cfgStrength, setCfgStrength] = useState(2.0);
  const [showLogs, setShowLogs] = useState(false);

  // Reference voice import form
  const [refName, setRefName] = useState('');
  const [refTranscript, setRefTranscript] = useState('');
  const [refLanguage, setRefLanguage] = useState('vi-VN');
  const [refFile, setRefFile] = useState<File | null>(null);
  const [importingRef, setImportingRef] = useState(false);
  const refInputEl = useRef<HTMLInputElement | null>(null);

  // Test Generation state
  const [selectedRefId, setSelectedRefId] = useState<string>('');
  const [testText, setTestText] = useState('');
  const [testSpeed, setTestSpeed] = useState(1.0);
  const [generatingTest, setGeneratingTest] = useState(false);
  const [generatedAsset, setGeneratedAsset] = useState<VoiceAudioAsset | null>(null);
  const [sendingToTimeline, setSendingToTimeline] = useState(false);

  const loadAll = async (probe = false) => {
    setLoading(true);
    try {
      const [st, refs] = await Promise.all([
        apiClient.getF5TTSStatus(probe),
        apiClient.listF5TTSReferences(),
      ]);
      setStatus(st);
      setReferences(refs);
      setMode(st.config.mode);
      setServiceUrl(st.config.service_url);
      setPythonExec(st.config.python_executable);
      setModelName(st.config.model_name);
      setDevicePref(st.config.device_preference);
      setNfeStep(st.config.nfe_step);
      setCfgStrength(st.config.cfg_strength);
      if (!selectedRefId && refs.length > 0) {
        setSelectedRefId(refs[0].ref_id);
      }
    } catch (err) {
      setServiceError(err instanceof Error ? err.message : 'Failed to inspect F5-TTS status');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAll(false);
  }, []);

  const handleSaveConfig = async () => {
    setSaving(true);
    setServiceError(null);
    try {
      await apiClient.updateF5TTSConfig({
        mode,
        service_url: serviceUrl.trim(),
        python_executable: pythonExec.trim(),
        model_name: modelName.trim() || 'F5TTS_v1_Base',
        device_preference: devicePref,
        nfe_step: nfeStep,
        cfg_strength: cfgStrength,
      });
      await loadAll(false);
      await refreshAllVoice();
      pushToast('success', t('f5.configSavedToast'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error';
      setServiceError(msg);
      pushToast('error', msg);
    } finally {
      setSaving(false);
    }
  };

  const handleTestConnection = async () => {
    setTestingConn(true);
    setServiceError(null);
    try {
      await apiClient.updateF5TTSConfig({
        mode,
        service_url: serviceUrl.trim(),
        python_executable: pythonExec.trim(),
      });
      const res = await apiClient.testF5TTSConnection();
      setConnResult(res);
      await loadAll(false);
      await refreshAllVoice();
      pushToast(res.ok ? 'success' : 'warning', res.message);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Connection test failed';
      setServiceError(msg);
      pushToast('error', msg);
    } finally {
      setTestingConn(false);
    }
  };

  const handleStartService = async () => {
    setServiceBusy(true);
    setServiceError(null);
    try {
      await apiClient.updateF5TTSConfig({
        mode,
        service_url: serviceUrl.trim(),
        python_executable: pythonExec.trim(),
      });
      const st = await apiClient.startF5TTSService();
      setStatus(st);
      await refreshAllVoice();
      pushToast('success', st.status_message);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to start F5-TTS service';
      setServiceError(msg);
      setShowLogs(true);
      await loadAll(false);
      pushToast('error', msg);
    } finally {
      setServiceBusy(false);
    }
  };

  const handleStopService = async () => {
    setServiceBusy(true);
    setServiceError(null);
    try {
      const st = await apiClient.stopF5TTSService();
      setStatus(st);
      await refreshAllVoice();
      pushToast('info', t('f5.stoppedToast'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to stop service';
      setServiceError(msg);
      pushToast('error', msg);
    } finally {
      setServiceBusy(false);
    }
  };

  const handleImportReference = async () => {
    if (!refFile || !refName.trim() || !refTranscript.trim()) {
      pushToast('warning', t('f5.refValidationWarn'));
      return;
    }
    setImportingRef(true);
    setServiceError(null);
    try {
      const created = await apiClient.importF5TTSReference({
        file: refFile,
        name: refName.trim(),
        transcript: refTranscript.trim(),
        language: refLanguage,
      });
      setReferences((prev) => [...prev, created]);
      setSelectedRefId(created.ref_id);
      setRefName('');
      setRefTranscript('');
      setRefFile(null);
      if (refInputEl.current) refInputEl.current.value = '';
      await refreshAllVoice();
      pushToast('success', t('f5.refImportedToast', { name: created.name }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Import failed';
      setServiceError(msg);
      pushToast('error', msg);
    } finally {
      setImportingRef(false);
    }
  };

  const handleDeleteReference = async (refId: string) => {
    try {
      await apiClient.deleteF5TTSReference(refId);
      setReferences((prev) => prev.filter((r) => r.ref_id !== refId));
      if (selectedRefId === refId) setSelectedRefId('');
      await refreshAllVoice();
      pushToast('info', t('f5.refDeletedToast'));
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : 'Delete failed');
    }
  };

  const handleTestGenerate = async () => {
    if (!project) {
      pushToast('warning', t('common.noProject'));
      return;
    }
    if (!testText.trim()) {
      pushToast('warning', t('voice.enterTextFirst'));
      return;
    }
    setGeneratingTest(true);
    setServiceError(null);
    try {
      const asset = await apiClient.testF5TTSGenerate({
        project_id: project.meta.project_id,
        text: testText.trim(),
        ref_id: selectedRefId || null,
        language: refLanguage,
        speed: testSpeed,
        nfe_step: nfeStep,
        cfg_strength: cfgStrength,
      });
      setGeneratedAsset(asset);
      pushToast('success', t('f5.generatedToast', { sec: (asset.duration_ms / 1000).toFixed(2) }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'F5-TTS generation failed';
      setServiceError(msg);
      pushToast('error', msg);
    } finally {
      setGeneratingTest(false);
    }
  };

  const handleSendToTimeline = async () => {
    if (!project || !generatedAsset) return;
    setSendingToTimeline(true);
    try {
      const label = `F5-TTS: ${generatedAsset.text.slice(0, 28)}`;
      const sound = await apiClient.registerVoiceAsSound(
        project.meta.project_id,
        generatedAsset.audio_asset_id,
        label,
      );
      upsertSound(sound);
      const startMs = Math.round(frameToMs(currentFrame, project.timeline.fps));
      addVoiceClipToTimeline(sound, startMs, project.scenes[0]?.scene_id ?? null);
      pushToast('success', t('voice.addedToTimelineToast'));
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : 'Failed to add to timeline');
    } finally {
      setSendingToTimeline(false);
    }
  };

  const statusBadgeClass =
    status?.service_status === 'running'
      ? 'accepted'
      : status?.service_status === 'not_installed' || status?.service_status === 'error'
        ? 'rejected'
        : 'warning';

  return (
    <div
      className="card"
      data-testid="f5-tts-config-panel"
      style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 9 }}
    >
      {/* Header + Real Backend Status Badge */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 700 }}>
          <Cpu size={12} color="var(--accent-text)" /> {t('f5.panelTitle')}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {status && (
            <span className={`director-badge ${statusBadgeClass}`} data-testid="f5-service-status-badge">
              {t(`f5.status.${status.service_status}`)}
            </span>
          )}
          <button
            type="button"
            className="btn-ghost btn-icon btn-xs"
            onClick={() => void loadAll(true)}
            disabled={loading}
            title={t('common.refresh')}
            data-testid="f5-refresh-status-btn"
          >
            <RefreshCw size={11} className={loading ? 'spin' : ''} />
          </button>
        </div>
      </div>

      {/* Real Environment Telemetry Grid (zero fake values!) */}
      {status && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 4,
            fontSize: 10,
            padding: 6,
            borderRadius: 5,
            background: 'var(--surface-base)',
            border: '1px solid var(--border-subtle)',
          }}
          data-testid="f5-env-telemetry"
        >
          <div>
            <span style={{ color: 'var(--text-muted)' }}>{t('f5.installStatus')}: </span>
            <strong style={{ color: status.installed ? 'var(--success)' : 'var(--warning)' }}>
              {status.installed ? t('f5.installed') : t('f5.notInstalled')}
            </strong>
          </div>
          <div>
            <span style={{ color: 'var(--text-muted)' }}>{t('f5.connectionLabel')}: </span>
            <strong style={{ color: status.connection_ok ? 'var(--success)' : 'var(--text-secondary)' }}>
              {status.connection_ok ? t('f5.connected') : t('f5.disconnected')}
            </strong>
          </div>
          <div>
            <span style={{ color: 'var(--text-muted)' }}>{t('f5.deviceLabel')}: </span>
            <strong className="mono">{status.gpu_backend.toUpperCase()}</strong>
          </div>
          <div>
            <span style={{ color: 'var(--text-muted)' }}>{t('f5.modelStatusLabel')}: </span>
            <strong>{t(`f5.modelStatus.${status.model_status}`)}</strong>
          </div>
          <div style={{ gridColumn: '1 / -1', color: 'var(--text-secondary)', fontSize: 9.5 }}>
            {status.device_info || status.status_message}
          </div>
        </div>
      )}

      {/* Honest Install Instructions when F5-TTS is not locally installed */}
      {status && !status.installed && mode === 'local_managed' && (
        <div
          className="director-callout warning"
          style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4, fontSize: 10 }}
          data-testid="f5-install-guide"
        >
          <strong>{t('f5.notInstalledTitle')}</strong>
          <ol style={{ margin: 0, paddingLeft: 16, lineHeight: 1.45 }}>
            {status.install_instructions.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
        </div>
      )}

      {/* Service Configuration */}
      <div className="field-row">
        <label className="field-label">{t('f5.serviceMode')}</label>
        <select
          data-testid="f5-mode-select"
          value={mode}
          onChange={(e) => setMode(e.target.value as F5TTSServiceMode)}
        >
          <option value="external_http">{t('f5.modeExternal')}</option>
          <option value="local_managed">{t('f5.modeLocalManaged')}</option>
        </select>
      </div>

      <div className="field-row">
        <label className="field-label">{t('f5.serviceUrl')}</label>
        <input
          data-testid="f5-url-input"
          value={serviceUrl}
          onChange={(e) => setServiceUrl(e.target.value)}
          placeholder="http://127.0.0.1:7860"
        />
      </div>

      {mode === 'local_managed' && (
        <div className="field-row">
          <label className="field-label">{t('f5.pythonExecutable')}</label>
          <input
            data-testid="f5-python-input"
            value={pythonExec}
            onChange={(e) => setPythonExec(e.target.value)}
            placeholder="~/f5tts_venv/bin/python"
          />
        </div>
      )}

      <div className="field-grid">
        <div className="field-row">
          <label className="field-label">{t('f5.modelName')}</label>
          <input
            data-testid="f5-model-input"
            value={modelName}
            onChange={(e) => setModelName(e.target.value)}
          />
        </div>
        <div className="field-row">
          <label className="field-label">{t('f5.devicePreference')}</label>
          <select
            data-testid="f5-device-select"
            value={devicePref}
            onChange={(e) => setDevicePref(e.target.value as F5TTSDevicePreference)}
          >
            <option value="auto">Auto (GPU → CPU)</option>
            <option value="cuda">CUDA (NVIDIA)</option>
            <option value="mps">Apple MPS</option>
            <option value="cpu">CPU Fallback</option>
          </select>
        </div>
      </div>

      <div className="field-grid">
        <div className="field-row">
          <label className="field-label">NFE Steps</label>
          <input
            type="number"
            min={8}
            max={64}
            step={4}
            value={nfeStep}
            onChange={(e) => setNfeStep(Math.max(8, Math.min(64, Number(e.target.value) || 32)))}
          />
        </div>
        <div className="field-row">
          <label className="field-label">CFG Strength</label>
          <input
            type="number"
            min={0.5}
            max={5}
            step={0.1}
            value={cfgStrength}
            onChange={(e) => setCfgStrength(Math.max(0.5, Math.min(5, Number(e.target.value) || 2.0)))}
          />
        </div>
      </div>

      {/* Action Buttons: Save, Start/Stop, Test Connection */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        <button
          type="button"
          className="btn-xs btn-primary"
          disabled={saving}
          onClick={() => void handleSaveConfig()}
          data-testid="f5-save-config-btn"
        >
          {saving ? <Loader2 size={10} className="spin" /> : <Save size={10} />} {t('common.save')}
        </button>
        <button
          type="button"
          className="btn-xs"
          disabled={testingConn}
          onClick={() => void handleTestConnection()}
          data-testid="f5-test-connection-btn"
        >
          {testingConn ? <Loader2 size={10} className="spin" /> : <PlugZap size={10} />}{' '}
          {t('f5.testConnection')}
        </button>
        {mode === 'local_managed' && (
          <>
            {!status?.managed_process_running ? (
              <button
                type="button"
                className="btn-xs"
                disabled={serviceBusy}
                onClick={() => void handleStartService()}
                data-testid="f5-start-service-btn"
              >
                {serviceBusy ? <Loader2 size={10} className="spin" /> : <Power size={10} />}{' '}
                {t('f5.startService')}
              </button>
            ) : (
              <button
                type="button"
                className="btn-xs btn-danger"
                disabled={serviceBusy}
                onClick={() => void handleStopService()}
                data-testid="f5-stop-service-btn"
              >
                <Square size={10} /> {t('f5.stopService')}
              </button>
            )}
          </>
        )}
        <button
          type="button"
          className="btn-xs"
          onClick={() => setShowLogs((v) => !v)}
          data-testid="f5-toggle-logs-btn"
        >
          <Terminal size={10} /> {t('f5.logsBtn')} ({status?.logs.length ?? 0})
        </button>
      </div>

      {connResult && (
        <div
          className={`director-callout ${connResult.ok ? 'success' : 'error'}`}
          style={{ fontSize: 10, padding: '5px 7px' }}
          data-testid="f5-conn-result"
        >
          {connResult.ok ? <CheckCircle2 size={11} /> : <AlertCircle size={11} />}
          <span>{connResult.message}</span>
        </div>
      )}

      {serviceError && (
        <div
          className="director-callout error"
          style={{ fontSize: 10, padding: '5px 7px' }}
          data-testid="f5-service-error"
        >
          <AlertCircle size={11} style={{ flexShrink: 0 }} />
          <span>{serviceError}</span>
        </div>
      )}

      {showLogs && (
        <pre
          data-testid="f5-logs-box"
          style={{
            margin: 0,
            padding: 6,
            maxHeight: 110,
            overflowY: 'auto',
            fontSize: 9.5,
            background: '#090b10',
            borderRadius: 4,
            border: '1px solid var(--border-subtle)',
            whiteSpace: 'pre-wrap',
            color: 'var(--text-secondary)',
          }}
        >
          {status?.logs.length ? status.logs.join('\n') : t('f5.noLogsYet')}
        </pre>
      )}

      {/* Reference Voices Management (Audio + Reference Transcript) */}
      <div
        style={{
          borderTop: '1px solid var(--border-subtle)',
          paddingTop: 7,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-secondary)' }}>
          <FileAudio size={11} style={{ verticalAlign: 'middle', marginRight: 4 }} />
          {t('f5.referenceVoicesTitle', { count: references.length })}
        </div>

        {references.map((r) => (
          <div
            key={r.ref_id}
            data-testid={`f5-ref-item-${r.ref_id}`}
            style={{
              padding: '5px 7px',
              borderRadius: 5,
              border:
                selectedRefId === r.ref_id
                  ? '1px solid var(--accent)'
                  : '1px solid var(--border-subtle)',
              background: 'var(--surface-base)',
              display: 'flex',
              flexDirection: 'column',
              gap: 3,
              cursor: 'pointer',
            }}
            onClick={() => setSelectedRefId(r.ref_id)}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 5 }}>
              <strong style={{ fontSize: 10.5 }}>{r.name}</strong>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span className="mono" style={{ fontSize: 9.5, color: 'var(--text-muted)' }}>
                  {r.language} • {formatTimecode(r.duration_ms)}
                </span>
                <button
                  type="button"
                  className="btn-ghost btn-icon btn-xs"
                  onClick={(e) => {
                    e.stopPropagation();
                    const audio = new Audio(apiClient.getF5TTSReferenceAudioUrl(r.ref_id));
                    void audio.play();
                  }}
                  title={t('common.preview')}
                >
                  <Volume2 size={10} />
                </button>
                <button
                  type="button"
                  className="btn-ghost btn-icon btn-xs"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleDeleteReference(r.ref_id);
                  }}
                  title={t('common.delete')}
                >
                  <Trash2 size={10} />
                </button>
              </div>
            </div>
            <div style={{ fontSize: 9.5, color: 'var(--text-muted)', lineHeight: 1.3 }}>
              “{r.transcript}”
            </div>
          </div>
        ))}

        {/* Import Reference Voice Form */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <div className="field-grid">
            <input
              data-testid="f5-ref-name-input"
              placeholder={t('f5.refNamePlaceholder')}
              value={refName}
              onChange={(e) => setRefName(e.target.value)}
            />
            <select value={refLanguage} onChange={(e) => setRefLanguage(e.target.value)}>
              <option value="vi-VN">vi-VN</option>
              <option value="en-US">en-US</option>
              <option value="zh-CN">zh-CN</option>
              <option value="ja-JP">ja-JP</option>
            </select>
          </div>
          <textarea
            data-testid="f5-ref-transcript-input"
            rows={2}
            placeholder={t('f5.refTranscriptPlaceholder')}
            value={refTranscript}
            onChange={(e) => setRefTranscript(e.target.value)}
            style={{
              width: '100%',
              fontSize: 11,
              padding: '4px 6px',
              background: 'var(--surface-base)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 4,
              color: 'var(--text-primary)',
            }}
          />
          <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
            <input
              ref={refInputEl}
              type="file"
              accept=".wav,.mp3,.flac,.ogg,.m4a"
              data-testid="f5-ref-file-input"
              onChange={(e) => setRefFile(e.target.files?.[0] ?? null)}
              style={{ flex: 1, fontSize: 10 }}
            />
            <button
              type="button"
              className="btn-xs btn-primary"
              disabled={importingRef || !refFile || !refName.trim() || !refTranscript.trim()}
              onClick={() => void handleImportReference()}
              data-testid="f5-import-ref-btn"
            >
              {importingRef ? <Loader2 size={10} className="spin" /> : <Upload size={10} />}{' '}
              {t('f5.importRefBtn')}
            </button>
          </div>
        </div>
      </div>

      {/* Test Generation + Audio Preview + Send to Timeline */}
      <div
        style={{
          borderTop: '1px solid var(--border-subtle)',
          paddingTop: 7,
          display: 'flex',
          flexDirection: 'column',
          gap: 5,
        }}
      >
        <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-secondary)' }}>
          {t('f5.testGenTitle')}
        </div>
        <textarea
          data-testid="f5-test-text-input"
          rows={2}
          placeholder={t('f5.testTextPlaceholder')}
          value={testText}
          onChange={(e) => setTestText(e.target.value)}
          style={{
            width: '100%',
            fontSize: 11,
            padding: '4px 6px',
            background: 'var(--surface-base)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 4,
            color: 'var(--text-primary)',
          }}
        />
        <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
          <label style={{ fontSize: 10, color: 'var(--text-muted)' }}>
            {t('f5.speedLabel')}: {testSpeed.toFixed(2)}x
          </label>
          <input
            type="range"
            min={0.5}
            max={1.8}
            step={0.05}
            value={testSpeed}
            onChange={(e) => setTestSpeed(Number(e.target.value))}
            style={{ flex: 1 }}
          />
          <button
            type="button"
            className="btn-xs btn-primary"
            disabled={generatingTest || !project || !testText.trim()}
            onClick={() => void handleTestGenerate()}
            data-testid="f5-test-generate-btn"
          >
            {generatingTest ? <Loader2 size={10} className="spin" /> : <Play size={10} />}{' '}
            {t('f5.testGenerateBtn')}
          </button>
        </div>

        {generatedAsset && (
          <div
            data-testid="f5-generated-preview"
            style={{
              padding: 6,
              borderRadius: 5,
              background: 'var(--surface-base)',
              border: '1px solid var(--border-subtle)',
              display: 'flex',
              flexDirection: 'column',
              gap: 5,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <button
                  type="button"
                  className="btn-xs"
                  onClick={() => {
                    if (playingAudioId === generatedAsset.audio_asset_id) {
                      stopAudio();
                    } else if (project) {
                      playAudioAsset(project.meta.project_id, generatedAsset.audio_asset_id);
                    }
                  }}
                  data-testid="f5-preview-play-btn"
                >
                  {playingAudioId === generatedAsset.audio_asset_id ? (
                    <Square size={10} />
                  ) : (
                    <Play size={10} />
                  )}
                </button>
                <span className="mono" style={{ fontSize: 10 }}>
                  {formatTimecode(generatedAsset.duration_ms)}
                </span>
              </div>
              <button
                type="button"
                className="btn-xs btn-primary"
                disabled={sendingToTimeline}
                onClick={() => void handleSendToTimeline()}
                data-testid="f5-send-to-timeline-btn"
              >
                {sendingToTimeline ? <Loader2 size={10} className="spin" /> : <Film size={10} />}{' '}
                {t('f5.sendToTimelineBtn')}
              </button>
            </div>
            <WaveformCanvas peaks={generatedAsset.waveform_peaks} height={22} color="#38bdf8" />
          </div>
        )}
      </div>
    </div>
  );
}
