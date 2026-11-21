import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, RefreshCw, Save, Wrench } from 'lucide-react';
import { useI18n } from '@/i18n/useLocaleStore';
import { apiClient } from '@/services/apiClient';
import { useJobStore } from '@/stores/useJobStore';
import type { FFmpegEnvironment, FFmpegTestResult } from '@/types/models';

/** Phase 08 Batch 3 — detect / configure / test FFmpeg + FFprobe (never downloads binaries). */
export function FFmpegSettingsSection() {
  const { t } = useI18n();
  const pushToast = useJobStore((s) => s.pushToast);
  const refreshHealth = useJobStore((s) => s.refreshHealth);
  const [env, setEnv] = useState<FFmpegEnvironment | null>(null);
  const [loading, setLoading] = useState(false);
  const [ffmpegPath, setFfmpegPath] = useState('');
  const [ffprobePath, setFfprobePath] = useState('');
  const [test, setTest] = useState<FFmpegTestResult | null>(null);
  const [testing, setTesting] = useState(false);

  const load = async (refresh = false) => {
    setLoading(true);
    try {
      const e = await apiClient.getRenderEnvironment(refresh);
      setEnv(e);
      setFfmpegPath(e.configured_ffmpeg_path ?? '');
      setFfprobePath(e.configured_ffprobe_path ?? '');
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const save = async () => {
    try {
      const e = await apiClient.updateFFmpegConfig({ ffmpeg_path: ffmpegPath.trim() || null, ffprobe_path: ffprobePath.trim() || null });
      setEnv(e);
      setTest(null);
      await refreshHealth();
      pushToast(e.available ? 'success' : 'warning', e.available ? t('ffmpeg.saved') : t('ffmpeg.savedButMissing'));
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : String(err));
    }
  };

  const runTest = async () => {
    setTesting(true);
    try {
      setTest(await apiClient.testFFmpeg());
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="inspector-section" data-testid="ffmpeg-settings">
      <div className="inspector-section-title">
        <span>{t('ffmpeg.title')}</span>
        <button className="btn-xs" disabled={loading} onClick={() => void load(true)}>
          <RefreshCw size={11} /> {t('ffmpeg.detect')}
        </button>
      </div>
      {env && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {env.available ? <CheckCircle2 size={13} color="var(--success)" /> : <AlertCircle size={13} color="var(--danger)" />}
            <strong>{env.available ? t('ffmpeg.ready') : t('ffmpeg.notReady')}</strong>
          </div>
          <div className="mono" style={{ fontSize: 10, wordBreak: 'break-all' }}>
            ffmpeg: {env.ffmpeg_path ?? '—'} {env.ffmpeg_version ? `(${env.ffmpeg_version})` : ''}
          </div>
          <div className="mono" style={{ fontSize: 10, wordBreak: 'break-all' }}>
            ffprobe: {env.ffprobe_path ?? '—'} {env.ffprobe_version ? `(${env.ffprobe_version})` : ''}
          </div>
          {env.codecs.length > 0 && (
            <div className="mono" style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
              {env.codecs
                .map((c) => `${c.label}: ${c.available ? [c.software_encoder, ...c.hardware_encoders].filter(Boolean).join(', ') + ` → ${c.containers.join('/')}` : t('export.unavailable')}`)
                .join(' · ')}
            </div>
          )}
          {env.hwaccels.length > 0 && (
            <div className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
              hwaccel: {env.hwaccels.join(', ')}
            </div>
          )}
          {env.problems.map((p, i) => (
            <div key={i} style={{ color: 'var(--danger-text)', fontSize: 10 }}>
              {p}
            </div>
          ))}
          {!env.available && <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{t('ffmpeg.installHelp')}</div>}
        </div>
      )}
      <div className="field-grid">
        <div className="field-row">
          <label className="field-label">{t('ffmpeg.customFfmpeg')}</label>
          <input className="mono" value={ffmpegPath} placeholder={t('ffmpeg.autoDetect')} onChange={(e) => setFfmpegPath(e.target.value)} />
        </div>
        <div className="field-row">
          <label className="field-label">{t('ffmpeg.customFfprobe')}</label>
          <input className="mono" value={ffprobePath} placeholder={t('ffmpeg.autoDetect')} onChange={(e) => setFfprobePath(e.target.value)} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="btn-xs" onClick={() => void save()}>
          <Save size={11} /> {t('ffmpeg.savePaths')}
        </button>
        <button className="btn-xs" disabled={testing} onClick={() => void runTest()} data-testid="ffmpeg-test">
          <Wrench size={11} /> {testing ? t('ffmpeg.testing') : t('ffmpeg.test')}
        </button>
      </div>
      {test && (
        <div style={{ fontSize: 10, display: 'flex', flexDirection: 'column', gap: 2 }} data-testid="ffmpeg-test-result">
          <div>
            FFmpeg {test.ffmpeg_ok ? '✓' : '✗'} · FFprobe {test.ffprobe_ok ? '✓' : '✗'}
          </div>
          <div className="mono">
            {Object.entries(test.encoder_results)
              .map(([enc, ok]) => `${enc} ${ok ? '✓' : '✗'}`)
              .join(' · ') || t('ffmpeg.noEncoders')}
          </div>
          {test.messages.slice(1).map((m, i) => (
            <div key={i} className="mono" style={{ color: 'var(--warning-text)' }}>
              {m}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
