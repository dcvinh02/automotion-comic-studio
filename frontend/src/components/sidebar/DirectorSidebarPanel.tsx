import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  Cpu,
  FileText,
  Loader2,
  Play,
  RefreshCw,
  Settings,
  Square,
  Wand2,
} from 'lucide-react';
import { useI18n } from '@/i18n/useLocaleStore';
import { useDirectorStore } from '@/stores/useDirectorStore';
import { useJobStore } from '@/stores/useJobStore';
import { useProjectStore } from '@/stores/useProjectStore';
import type { AnalysisLanguage, ScriptSourceMode } from '@/types/models';

export function DirectorSidebarPanel({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useI18n();
  const project = useProjectStore((s) => s.project);
  const isDirty = useProjectStore((s) => s.isDirty);
  const saveProject = useProjectStore((s) => s.saveProject);
  const updateScriptMeta = useProjectStore((s) => s.updateScriptMeta);
  const setDirectorAnalysis = useProjectStore((s) => s.setDirectorAnalysis);
  const applyAcceptedDirectorScenes = useProjectStore((s) => s.applyAcceptedDirectorScenes);

  const aiConfig = useDirectorStore((s) => s.config);
  const providers = useDirectorStore((s) => s.providers);
  const analyzing = useDirectorStore((s) => s.analyzing);
  const progress = useDirectorStore((s) => s.progress);
  const lastError = useDirectorStore((s) => s.lastError);
  const refreshProviders = useDirectorStore((s) => s.refreshProviders);
  const runAnalysis = useDirectorStore((s) => s.runAnalysis);
  const cancelAnalysis = useDirectorStore((s) => s.cancelAnalysis);
  const setActiveTab = useDirectorStore((s) => s.setActiveTab);

  const pushToast = useJobStore((s) => s.pushToast);

  const [sourceMode, setSourceMode] = useState<ScriptSourceMode>('auto');
  const [customScript, setCustomScript] = useState('');
  const [analysisLang, setAnalysisLang] = useState<AnalysisLanguage>('auto');
  const [createStageScenes, setCreateStageScenes] = useState(true);

  useEffect(() => {
    void refreshProviders();
  }, [refreshProviders]);

  useEffect(() => {
    if (aiConfig?.analysis_language) {
      setAnalysisLang(aiConfig.analysis_language);
    }
  }, [aiConfig?.analysis_language]);

  const activeProviderMeta = useMemo(
    () => providers.find((p) => p.provider_id === aiConfig?.provider_id),
    [providers, aiConfig?.provider_id],
  );

  const rawText = project?.script?.raw_source_text ?? '';
  const structuredCount = project?.script?.scenes?.length ?? 0;
  const director = project?.director ?? null;

  const activeTextForCount = sourceMode === 'custom_text' ? customScript : rawText;
  const charCount = activeTextForCount.trim().length;
  const paraCount = activeTextForCount
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean).length;

  const acceptedCount = useMemo(
    () => director?.scenes.filter((s) => s.review_status === 'accepted').length ?? 0,
    [director],
  );
  const pendingCount = useMemo(
    () =>
      director?.scenes.filter((s) => s.review_status === 'pending' || s.review_status === 'edited')
        .length ?? 0,
    [director],
  );

  if (!project) {
    return (
      <div className="empty-state" style={{ padding: 16 }}>
        <Brain size={24} color="var(--text-muted)" />
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t('common.noProject')}</div>
      </div>
    );
  }

  const handleAnalyze = async (force: boolean) => {
    if (analyzing) return;
    try {
      // Persist any unsaved raw/structured script edits before running backend analysis
      if (isDirty) {
        await saveProject(false);
      }
      const doc = await runAnalysis(project.meta.project_id, {
        script_source_mode: sourceMode,
        custom_script_text: sourceMode === 'custom_text' ? customScript : null,
        analysis_language: analysisLang,
        force,
      });
      setDirectorAnalysis(doc);
      pushToast(
        'success',
        t('director.analysisCompleteToast', {
          chars: doc.characters.length,
          scenes: doc.scenes.length,
        }),
      );
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : t('director.analysisFailed'));
    }
  };

  const handleApplyAccepted = () => {
    const res = applyAcceptedDirectorScenes({ createStageScenes });
    if (res.appliedCount === 0) {
      pushToast('info', t('director.noAcceptedScenesHint'));
      return;
    }
    pushToast(
      'success',
      t('director.appliedScenesToast', {
        applied: res.appliedCount,
        created: res.createdScriptScenes,
        updated: res.updatedScriptScenes,
      }),
    );
  };

  return (
    <div className="director-sidebar" data-testid="director-sidebar-panel">
      {/* AI Provider Status Card */}
      <div className="inspector-section" style={{ paddingBottom: 8 }}>
        <div className="inspector-section-title">
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <Cpu size={12} color="var(--accent-text)" /> {t('director.providerStatusTitle')}
          </span>
          <button
            type="button"
            className="btn-xs"
            onClick={onOpenSettings}
            data-testid="director-open-settings-btn"
          >
            <Settings size={11} /> {t('director.configureAi')}
          </button>
        </div>

        <div className="director-provider-pill">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
            <strong style={{ fontSize: 11 }}>{aiConfig?.provider_id ?? 'openai'}</strong>
            <span
              className={`director-badge ${activeProviderMeta?.is_configured ? 'accepted' : 'warning'}`}
            >
              {activeProviderMeta?.is_configured
                ? t('director.providerReady')
                : t('director.providerNotConfigured')}
            </span>
          </div>
          <div className="mono" style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 2 }}>
            {aiConfig?.model || '—'}
          </div>
          {activeProviderMeta && !activeProviderMeta.is_configured && (
            <div style={{ fontSize: 10, color: 'var(--warning)', marginTop: 4, lineHeight: 1.35 }}>
              {activeProviderMeta.status_message}
            </div>
          )}
        </div>
      </div>

      {/* Script Source Selection & Input */}
      <div className="inspector-section">
        <div className="inspector-section-title">
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <FileText size={12} /> {t('director.scriptSourceTitle')}
          </span>
          <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
            {paraCount}P • {charCount}c
          </span>
        </div>

        <div className="field-row">
          <label className="field-label" htmlFor="amcs-dir-source-mode">
            {t('director.sourceModeLabel')}
          </label>
          <select
            id="amcs-dir-source-mode"
            value={sourceMode}
            onChange={(e) => setSourceMode(e.target.value as ScriptSourceMode)}
          >
            <option value="auto">{t('director.sourceModeAuto')}</option>
            <option value="raw_text">{t('director.sourceModeRaw')}</option>
            <option value="structured_scenes">
              {t('director.sourceModeStructured', { count: structuredCount })}
            </option>
            <option value="custom_text">{t('director.sourceModeCustom')}</option>
          </select>
        </div>

        {sourceMode !== 'structured_scenes' && (
          <div className="field-row">
            <label className="field-label" htmlFor="amcs-dir-script-text">
              {sourceMode === 'custom_text'
                ? t('director.customScriptLabel')
                : t('director.projectRawScriptLabel')}
            </label>
            <textarea
              id="amcs-dir-script-text"
              data-testid="director-script-textarea"
              rows={7}
              value={sourceMode === 'custom_text' ? customScript : rawText}
              onChange={(e) => {
                if (sourceMode === 'custom_text') {
                  setCustomScript(e.target.value);
                } else {
                  updateScriptMeta({ raw_source_text: e.target.value });
                }
              }}
              placeholder={t('director.scriptPlaceholder')}
              style={{ resize: 'vertical', fontSize: 11, lineHeight: 1.45 }}
            />
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
              {t('director.originalScriptPreservedHint')}
            </span>
          </div>
        )}

        <div className="field-row">
          <label className="field-label" htmlFor="amcs-dir-lang">
            {t('director.analysisLanguageLabel')}
          </label>
          <select
            id="amcs-dir-lang"
            value={analysisLang}
            onChange={(e) => setAnalysisLang(e.target.value as AnalysisLanguage)}
          >
            <option value="auto">{t('director.langAuto')}</option>
            <option value="vi">{t('director.langVi')}</option>
            <option value="en">{t('director.langEn')}</option>
          </select>
        </div>

        <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
          {!analyzing ? (
            <>
              <button
                type="button"
                className="btn-primary"
                style={{ flex: 1 }}
                onClick={() => void handleAnalyze(false)}
                data-testid="director-analyze-btn"
              >
                <Play size={12} /> {t('director.analyzeBtn')}
              </button>
              {director && (
                <button
                  type="button"
                  title={t('director.reanalyzeForceTip')}
                  onClick={() => void handleAnalyze(true)}
                  data-testid="director-reanalyze-btn"
                >
                  <RefreshCw size={12} />
                </button>
              )}
            </>
          ) : (
            <button
              type="button"
              className="btn-danger"
              style={{ flex: 1 }}
              onClick={() => void cancelAnalysis(project.meta.project_id)}
              data-testid="director-cancel-btn"
            >
              <Square size={11} /> {t('director.cancelAnalysisBtn')}
            </button>
          )}
        </div>

        {/* Live Progress */}
        {analyzing && progress && (
          <div className="director-progress-box" data-testid="director-progress-box">
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <Loader2 size={11} className="spin" /> {progress.stage || 'running'}
              </span>
              <span className="mono">
                {progress.total_chunks > 1
                  ? `${progress.current_chunk}/${progress.total_chunks} • `
                  : ''}
                {Math.round(progress.progress_pct)}%
              </span>
            </div>
            <div className="director-progress-bar">
              <div
                className="director-progress-fill"
                style={{ width: `${Math.max(4, Math.min(100, progress.progress_pct))}%` }}
              />
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{progress.message}</div>
          </div>
        )}

        {lastError && (
          <div className="director-callout error" data-testid="director-error-banner">
            <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: 1 }} />
            <span style={{ fontSize: 11, lineHeight: 1.35 }}>{lastError}</span>
          </div>
        )}
      </div>

      {/* Analysis Summary & Explicit Apply to Project */}
      {director && (
        <div className="inspector-section">
          <div className="inspector-section-title">
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <Wand2 size={12} color="var(--accent-text)" /> {t('director.reviewSummaryTitle')}
            </span>
            <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
              v{director.version}
            </span>
          </div>

          <div className="director-kpi-grid">
            <button
              type="button"
              className="director-kpi-card"
              onClick={() => setActiveTab('characters')}
            >
              <span className="director-kpi-num">{director.characters.length}</span>
              <span className="director-kpi-label">{t('director.kpiCharacters')}</span>
            </button>
            <button
              type="button"
              className="director-kpi-card"
              onClick={() => setActiveTab('dialogue')}
            >
              <span className="director-kpi-num">{director.extracted_items.length}</span>
              <span className="director-kpi-label">{t('director.kpiItems')}</span>
            </button>
            <button
              type="button"
              className="director-kpi-card"
              onClick={() => setActiveTab('scenes')}
            >
              <span className="director-kpi-num">{director.scenes.length}</span>
              <span className="director-kpi-label">{t('director.kpiScenes')}</span>
            </button>
            <button
              type="button"
              className="director-kpi-card"
              onClick={() => setActiveTab('scenes')}
            >
              <span
                className="director-kpi-num"
                style={{ color: acceptedCount > 0 ? 'var(--success)' : 'var(--text-primary)' }}
              >
                {acceptedCount}/{director.scenes.length}
              </span>
              <span className="director-kpi-label">{t('director.kpiAccepted')}</span>
            </button>
          </div>

          {pendingCount > 0 && (
            <div style={{ fontSize: 10, color: 'var(--text-secondary)', lineHeight: 1.35 }}>
              {t('director.pendingReviewHint', { count: pendingCount })}
            </div>
          )}

          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 11,
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              marginTop: 4,
            }}
          >
            <input
              type="checkbox"
              checked={createStageScenes}
              onChange={(e) => setCreateStageScenes(e.target.checked)}
            />
            <span>{t('director.alsoCreateStageScenes')}</span>
          </label>

          <button
            type="button"
            className="btn-primary"
            disabled={acceptedCount === 0}
            onClick={handleApplyAccepted}
            data-testid="director-apply-accepted-btn"
          >
            <CheckCircle2 size={12} />
            {t('director.applyAcceptedBtn', { count: acceptedCount })}
          </button>
        </div>
      )}
    </div>
  );
}
