import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Brain,
  CheckCircle2,
  Cpu,
  Eye,
  Globe,
  KeyRound,
  Loader2,
  Palette,
  RefreshCw,
  Search,
  Sliders,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import { useI18n, type LocaleCode, type TranslationKey } from '@/i18n/useLocaleStore';
import { apiClient } from '@/services/apiClient';
import { FFmpegSettingsSection } from './FFmpegSettingsSection';
import { useDirectorStore } from '@/stores/useDirectorStore';
import { useJobStore } from '@/stores/useJobStore';
import { useWorkspaceStore, type StudioTheme } from '@/stores/useWorkspaceStore';
import type {
  AIFeatureKey,
  AIModelInfo,
  AnalysisLanguage,
  FeatureModelOverride,
  LLMProviderId,
} from '@/types/models';

const FEATURE_LABEL_KEYS: Record<AIFeatureKey, TranslationKey> = {
  script_analysis: 'aiModels.feature.script_analysis',
  script_generation: 'aiModels.feature.script_generation',
  character_analysis: 'aiModels.feature.character_analysis',
  storyboard: 'aiModels.feature.storyboard',
  ai_director: 'aiModels.feature.ai_director',
  production_plan: 'aiModels.feature.production_plan',
  animation_planning: 'aiModels.feature.animation_planning',
  asset_prompts: 'aiModels.feature.asset_prompts',
};

function formatCtx(ctx: number | null | undefined): string {
  if (!ctx || ctx <= 0) return '';
  if (ctx >= 1_000_000) return `${(ctx / 1_000_000).toFixed(ctx % 1_000_000 === 0 ? 0 : 1)}M`;
  if (ctx >= 1_000) return `${Math.round(ctx / 1_000)}K`;
  return `${ctx}`;
}

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const { locale, setLocale, t } = useI18n();
  const health = useJobStore((s) => s.health);
  const refreshHealth = useJobStore((s) => s.refreshHealth);
  const pushToast = useJobStore((s) => s.pushToast);
  const theme = useWorkspaceStore((s) => s.theme);
  const setTheme = useWorkspaceStore((s) => s.setTheme);

  const aiConfig = useDirectorStore((s) => s.config);
  const aiProviders = useDirectorStore((s) => s.providers);
  const featureKeys = useDirectorStore((s) => s.featureKeys);
  const modelsByProvider = useDirectorStore((s) => s.modelsByProvider);
  const discoveringProvider = useDirectorStore((s) => s.discoveringProvider);
  const testingProvider = useDirectorStore((s) => s.testingProvider);
  const testResult = useDirectorStore((s) => s.testResult);
  const refreshProviders = useDirectorStore((s) => s.refreshProviders);
  const discoverProviderModels = useDirectorStore((s) => s.discoverProviderModels);
  const saveProviderConfig = useDirectorStore((s) => s.saveProviderConfig);
  const saveFeatureModels = useDirectorStore((s) => s.saveFeatureModels);
  const testProvider = useDirectorStore((s) => s.testProvider);

  const [providerId, setProviderId] = useState<LLMProviderId>('openai');
  const [aiModel, setAiModel] = useState('gpt-4o-mini');
  const [aiBaseUrl, setAiBaseUrl] = useState('');
  const [aiApiKey, setAiApiKey] = useState('');
  const [aiLanguage, setAiLanguage] = useState<AnalysisLanguage>('auto');
  const [aiTimeout, setAiTimeout] = useState(60);
  const [aiRetries, setAiRetries] = useState(2);
  const [aiChunkChars, setAiChunkChars] = useState(6000);
  const [savingAi, setSavingAi] = useState(false);

  const [modelSearch, setModelSearch] = useState('');
  const [showAllCapabilities, setShowAllCapabilities] = useState(false);
  const [featureDraft, setFeatureDraft] = useState<Record<string, FeatureModelOverride>>({});
  const [savingFeatures, setSavingFeatures] = useState(false);


  useEffect(() => {
    void refreshProviders();
  }, [refreshProviders]);

  useEffect(() => {
    if (!aiConfig) return;
    setProviderId(aiConfig.provider_id);
    setAiModel(aiConfig.model);
    setAiBaseUrl(aiConfig.base_url);
    setAiLanguage(aiConfig.analysis_language);
    setAiTimeout(aiConfig.timeout_seconds);
    setAiRetries(aiConfig.max_retries);
    setAiChunkChars(aiConfig.max_chunk_chars);
    setFeatureDraft(aiConfig.feature_models ?? {});
  }, [aiConfig]);

  useEffect(() => {
    if (!providerId) return;
    if (!modelsByProvider[providerId]) {
      void discoverProviderModels(providerId, false);
    }
  }, [providerId, modelsByProvider, discoverProviderModels]);

  const activeProviderMeta = aiProviders.find((p) => p.provider_id === providerId);
  const discovery = modelsByProvider[providerId] ?? null;

  const filteredModels: AIModelInfo[] = useMemo(() => {
    const raw = discovery?.models ?? [];
    const q = modelSearch.trim().toLowerCase();
    return raw.filter((m) => {
      if (!showAllCapabilities && !m.supports_text) return false;
      if (!q) return true;
      return (
        m.model_id.toLowerCase().includes(q) ||
        m.display_name.toLowerCase().includes(q)
      );
    });
  }, [discovery?.models, modelSearch, showAllCapabilities]);

  const selectedModelMeta = useMemo(() => {
    const raw = discovery?.models ?? [];
    return raw.find((m) => m.model_id === aiModel.trim()) ?? null;
  }, [discovery?.models, aiModel]);

  const compatibleAlternatives = useMemo(() => {
    const raw = discovery?.models ?? [];
    return raw
      .filter((m) => m.supports_text && m.supports_structured_json && m.model_id !== aiModel.trim())
      .slice(0, 4);
  }, [discovery?.models, aiModel]);

  const handleProviderSelect = (nextPid: LLMProviderId) => {
    setProviderId(nextPid);
    const meta = aiProviders.find((p) => p.provider_id === nextPid);
    const savedModel = aiConfig?.provider_models?.[nextPid] || meta?.selected_model || meta?.default_model || '';
    const savedUrl = aiConfig?.provider_base_urls?.[nextPid] || meta?.saved_base_url || meta?.default_base_url || '';
    setAiModel(savedModel);
    setAiBaseUrl(savedUrl);
    setAiApiKey('');
    setModelSearch('');
  };

  const handleSaveAiConfig = async () => {
    setSavingAi(true);
    try {
      await saveProviderConfig({
        provider_id: providerId,
        model: aiModel.trim(),
        base_url: aiBaseUrl.trim(),
        api_key: aiApiKey.trim() || undefined,
        analysis_language: aiLanguage,
        timeout_seconds: Math.max(5, Math.min(300, aiTimeout)),
        max_retries: Math.max(0, Math.min(5, aiRetries)),
        max_chunk_chars: Math.max(1500, Math.min(32000, aiChunkChars)),
      });
      setAiApiKey('');
      pushToast('success', t('director.aiConfigSaved'));
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : 'Error');
    } finally {
      setSavingAi(false);
    }
  };

  const handleRefreshModels = async () => {
    // Save pending API key or Base URL edits first so discovery uses them
    if (aiApiKey.trim() || (aiBaseUrl.trim() && aiBaseUrl.trim() !== activeProviderMeta?.saved_base_url)) {
      await handleSaveAiConfig();
    }
    const res = await discoverProviderModels(providerId, true);
    if (res.error) {
      pushToast('warning', res.error);
    } else {
      pushToast(
        'success',
        t('aiModels.discoveredToast', {
          count: res.discovered_count,
          provider: activeProviderMeta?.display_name ?? providerId,
        }),
      );
    }
  };

  const handleClearApiKey = async () => {
    setSavingAi(true);
    try {
      await saveProviderConfig({ provider_id: providerId, clear_api_key: true });
      setAiApiKey('');
      pushToast('info', t('director.apiKeyCleared'));
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : 'Error');
    } finally {
      setSavingAi(false);
    }
  };

  const handleTestAiProvider = async () => {
    await handleSaveAiConfig();
    const res = await testProvider();
    pushToast(res.ok ? 'success' : 'error', res.message);
  };

  const handleSaveFeatureOverrides = async () => {
    setSavingFeatures(true);
    try {
      await saveFeatureModels(featureDraft);
      pushToast('success', t('aiModels.featureOverridesSaved'));
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : 'Error');
    } finally {
      setSavingFeatures(false);
    }
  };



  const getModelsForProviderOption = (pid: LLMProviderId): string[] => {
    const disc = modelsByProvider[pid]?.models ?? [];
    if (disc.length > 0) {
      return disc.filter((m) => m.supports_text).map((m) => m.model_id);
    }
    const meta = aiProviders.find((p) => p.provider_id === pid);
    return meta?.suggested_models ?? [];
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-box" style={{ maxWidth: 680 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>{t('modal.settingsTitle')}</span>
          <button className="btn-ghost btn-icon" onClick={onClose} aria-label={t('common.close')}>
            <X size={14} />
          </button>
        </div>
        <div className="modal-body">
          {/* General -> Language & Theme */}
          <div className="inspector-section">
            <div className="inspector-section-title">
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <Globe size={12} color="var(--accent-text)" /> {t('modal.generalSection')}
              </span>
            </div>
            <div className="field-grid">
              <div className="field-row">
                <label className="field-label" htmlFor="amcs-lang-select">
                  {t('modal.languageLabel')}
                </label>
                <select
                  id="amcs-lang-select"
                  value={locale}
                  onChange={(e) => setLocale(e.target.value as LocaleCode)}
                >
                  <option value="vi">Tiếng Việt</option>
                  <option value="en">English</option>
                </select>
              </div>
              <div className="field-row">
                <label className="field-label" htmlFor="amcs-theme-select">
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <Palette size={11} /> {t('modal.themeLabel')}
                  </span>
                </label>
                <select
                  id="amcs-theme-select"
                  value={theme}
                  onChange={(e) => setTheme(e.target.value as StudioTheme)}
                >
                  <option value="dark-studio">{t('modal.themeDark')}</option>
                  <option value="slate-contrast">{t('modal.themeContrast')}</option>
                </select>
              </div>
            </div>
          </div>

          {/* Dynamic AI Provider & Model Discovery Section */}
          <div className="inspector-section" data-testid="settings-ai-provider-section">
            <div className="inspector-section-title">
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <Cpu size={12} color="var(--accent-text)" /> {t('director.aiProviderSection')}
              </span>
              {activeProviderMeta && (
                <span
                  className={`director-badge ${activeProviderMeta.is_configured ? 'accepted' : 'warning'}`}
                >
                  {activeProviderMeta.is_configured
                    ? t('director.providerReady')
                    : t('director.providerNotConfigured')}
                </span>
              )}
            </div>

            <div className="field-grid">
              <div className="field-row">
                <label className="field-label" htmlFor="amcs-ai-provider">
                  {t('director.providerLabel')}
                </label>
                <select
                  id="amcs-ai-provider"
                  data-testid="ai-provider-select"
                  value={providerId}
                  onChange={(e) => handleProviderSelect(e.target.value as LLMProviderId)}
                >
                  {(aiProviders.length > 0
                    ? aiProviders
                    : ([
                        { provider_id: 'openai', display_name: 'OpenAI' },
                        { provider_id: 'anthropic', display_name: 'Anthropic (Claude)' },
                        { provider_id: 'gemini', display_name: 'Google Gemini' },
                        { provider_id: 'deepseek', display_name: 'DeepSeek' },
                        { provider_id: 'openrouter', display_name: 'OpenRouter' },
                        { provider_id: 'groq', display_name: 'Groq' },
                        { provider_id: 'openai_compatible', display_name: 'OpenAI-Compatible / Local' },
                      ] as Array<{ provider_id: LLMProviderId; display_name: string }>)
                  ).map((p) => (
                    <option key={p.provider_id} value={p.provider_id}>
                      {p.display_name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field-row">
                <label className="field-label" htmlFor="amcs-ai-lang">
                  {t('director.analysisLanguageLabel')}
                </label>
                <select
                  id="amcs-ai-lang"
                  value={aiLanguage}
                  onChange={(e) => setAiLanguage(e.target.value as AnalysisLanguage)}
                >
                  <option value="auto">{t('director.langAuto')}</option>
                  <option value="vi">{t('director.langVi')}</option>
                  <option value="en">{t('director.langEn')}</option>
                </select>
              </div>
            </div>

            <div className="field-row">
              <label className="field-label" htmlFor="amcs-ai-baseurl">
                {t('director.baseUrlLabel')}
              </label>
              <input
                id="amcs-ai-baseurl"
                data-testid="ai-base-url-input"
                value={aiBaseUrl}
                onChange={(e) => setAiBaseUrl(e.target.value)}
                placeholder={activeProviderMeta?.default_base_url || 'https://api.openai.com/v1'}
              />
            </div>

            <div className="field-row">
              <label className="field-label" htmlFor="amcs-ai-key">
                <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <KeyRound size={11} /> {t('director.apiKeyLabel')}
                </span>
              </label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  id="amcs-ai-key"
                  data-testid="ai-api-key-input"
                  type="password"
                  value={aiApiKey}
                  onChange={(e) => setAiApiKey(e.target.value)}
                  placeholder={
                    activeProviderMeta?.api_key_masked
                      ? `${t('director.savedKeyPlaceholder')}: ${activeProviderMeta.api_key_masked} (${activeProviderMeta.api_key_source})`
                      : t('director.enterApiKeyPlaceholder')
                  }
                  style={{ flex: 1 }}
                />
                {activeProviderMeta?.api_key_source === 'settings' && (
                  <button
                    type="button"
                    className="btn-xs"
                    title={t('director.clearKey')}
                    onClick={() => void handleClearApiKey()}
                    disabled={savingAi}
                  >
                    <Trash2 size={11} />
                  </button>
                )}
              </div>
              <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                {activeProviderMeta?.status_message || t('director.apiKeySecurityNote')}
              </span>
            </div>

            {/* Dynamic Model Picker + Live Discovery */}
            <div
              className="card"
              style={{
                padding: 8,
                background: 'var(--surface-base)',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              }}
              data-testid="ai-model-discovery-box"
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <label className="field-label" htmlFor="amcs-ai-model" style={{ margin: 0 }}>
                    {t('director.modelLabel')}
                  </label>
                  {discovery && (
                    <span
                      className={`director-badge ${
                        discovery.source === 'live_api'
                          ? 'accepted'
                          : discovery.source === 'cache'
                            ? 'edited'
                            : 'pending'
                      }`}
                      data-testid="ai-model-source-badge"
                    >
                      {discovery.source === 'live_api'
                        ? t('aiModels.sourceLive', { count: discovery.discovered_count })
                        : discovery.source === 'cache'
                          ? t('aiModels.sourceCache', { count: discovery.discovered_count })
                          : t('aiModels.sourceCatalog')}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="btn-xs"
                  disabled={discoveringProvider === providerId}
                  onClick={() => void handleRefreshModels()}
                  data-testid="refresh-ai-models-btn"
                >
                  {discoveringProvider === providerId ? (
                    <Loader2 size={11} className="spin" />
                  ) : (
                    <RefreshCw size={11} />
                  )}
                  {t('aiModels.refreshModelsBtn')}
                </button>
              </div>

              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  id="amcs-ai-model"
                  data-testid="ai-model-input"
                  value={aiModel}
                  onChange={(e) => setAiModel(e.target.value)}
                  placeholder={activeProviderMeta?.default_model || 'gpt-4o-mini'}
                  style={{ flex: 1 }}
                />
                <div style={{ position: 'relative', flex: 1 }}>
                  <Search
                    size={11}
                    style={{
                      position: 'absolute',
                      left: 7,
                      top: '50%',
                      transform: 'translateY(-50%)',
                      color: 'var(--text-muted)',
                      pointerEvents: 'none',
                    }}
                  />
                  <input
                    type="text"
                    data-testid="ai-model-search"
                    value={modelSearch}
                    onChange={(e) => setModelSearch(e.target.value)}
                    placeholder={t('aiModels.searchModelsPlaceholder')}
                    style={{ width: '100%', paddingLeft: 24 }}
                  />
                </div>
              </div>

              {/* Discovery error / status banner */}
              {discovery?.error && (
                <div
                  className={`director-callout ${
                    discovery.error_code === 'missing_credentials' ? 'warning' : 'error'
                  }`}
                  style={{ fontSize: 10.5, padding: '5px 8px' }}
                  data-testid="ai-model-discovery-error"
                >
                  <AlertTriangle size={12} style={{ flexShrink: 0 }} />
                  <span>{discovery.error}</span>
                </div>
              )}

              {/* Selected model incompatibility warning (never silently switches!) */}
              {selectedModelMeta && !selectedModelMeta.supports_text && (
                <div
                  className="director-callout error"
                  style={{ fontSize: 10.5, padding: '6px 8px', flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}
                  data-testid="ai-model-incompatible-warning"
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <AlertCircle size={12} />
                    <strong>{t('aiModels.incompatibleTitle')}</strong>
                  </div>
                  <span>{selectedModelMeta.notes || t('aiModels.incompatibleDesc')}</span>
                  {compatibleAlternatives.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 2 }}>
                      <span style={{ fontSize: 10, opacity: 0.85 }}>{t('aiModels.recommendedLabel')}:</span>
                      {compatibleAlternatives.map((alt) => (
                        <button
                          key={alt.model_id}
                          type="button"
                          className="btn-xs"
                          onClick={() => setAiModel(alt.model_id)}
                        >
                          {alt.model_id}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {discovery && !discovery.selected_model_valid && discovery.selected_model_warning && (
                <div className="director-callout warning" style={{ fontSize: 10.5, padding: '5px 8px' }}>
                  <AlertTriangle size={12} style={{ flexShrink: 0 }} />
                  <span>{discovery.selected_model_warning}</span>
                </div>
              )}

              {/* Scrollable Model List with real capability pills */}
              {filteredModels.length > 0 ? (
                <div
                  data-testid="ai-model-list"
                  style={{
                    maxHeight: 145,
                    overflowY: 'auto',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 3,
                    paddingRight: 2,
                  }}
                >
                  {filteredModels.map((m) => {
                    const isSelected = m.model_id === aiModel.trim();
                    return (
                      <button
                        key={m.model_id}
                        type="button"
                        data-testid={`ai-model-option-${m.model_id}`}
                        onClick={() => setAiModel(m.model_id)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 6,
                          padding: '5px 8px',
                          borderRadius: 5,
                          border: isSelected
                            ? '1px solid var(--accent)'
                            : '1px solid var(--border-subtle)',
                          background: isSelected ? 'rgba(99,102,241,0.16)' : 'var(--surface-elevated)',
                          textAlign: 'left',
                          cursor: 'pointer',
                        }}
                      >
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div
                            className="mono"
                            style={{
                              fontSize: 11,
                              fontWeight: isSelected ? 700 : 500,
                              color: 'var(--text-primary)',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {m.model_id}
                          </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0 }}>
                          {m.context_length && (
                            <span className="badge mono" style={{ fontSize: 9 }}>
                              {formatCtx(m.context_length)}
                            </span>
                          )}
                          {m.supports_vision && (
                            <span className="badge" title={t('aiModels.capVision')} style={{ fontSize: 9 }}>
                              <Eye size={9} />
                            </span>
                          )}
                          {m.supports_reasoning && (
                            <span className="badge" title={t('aiModels.capReasoning')} style={{ fontSize: 9 }}>
                              <Brain size={9} />
                            </span>
                          )}
                          {m.supports_tools && (
                            <span className="badge" title={t('aiModels.capTools')} style={{ fontSize: 9 }}>
                              <Wrench size={9} />
                            </span>
                          )}
                          {!m.supports_text && (
                            <span className="director-badge rejected" style={{ fontSize: 9 }}>
                              {t('aiModels.nonTextBadge')}
                            </span>
                          )}
                          <span
                            className={`director-badge ${m.source === 'discovered' ? 'accepted' : 'pending'}`}
                            style={{ fontSize: 8.5 }}
                          >
                            {m.source === 'discovered' ? 'API' : t('aiModels.catalogShort')}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div style={{ fontSize: 10.5, color: 'var(--text-muted)', padding: '4px 2px' }}>
                  {t('aiModels.noModelsMatching')}
                </div>
              )}

              <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: 'var(--text-secondary)' }}>
                <input
                  type="checkbox"
                  checked={showAllCapabilities}
                  onChange={(e) => setShowAllCapabilities(e.target.checked)}
                />
                {t('aiModels.showNonTextModels')}
              </label>
            </div>

            <div className="field-grid" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
              <div className="field-row">
                <label className="field-label">{t('director.timeoutLabel')}</label>
                <input
                  type="number"
                  min={5}
                  max={300}
                  value={aiTimeout}
                  onChange={(e) => setAiTimeout(Number(e.target.value) || 60)}
                />
              </div>
              <div className="field-row">
                <label className="field-label">{t('director.retriesLabel')}</label>
                <input
                  type="number"
                  min={0}
                  max={5}
                  value={aiRetries}
                  onChange={(e) => setAiRetries(Number(e.target.value) || 0)}
                />
              </div>
              <div className="field-row">
                <label className="field-label">{t('director.chunkCharsLabel')}</label>
                <input
                  type="number"
                  min={1500}
                  max={32000}
                  step={500}
                  value={aiChunkChars}
                  onChange={(e) => setAiChunkChars(Number(e.target.value) || 6000)}
                />
              </div>
            </div>

            {testResult && (
              <div
                className={`director-callout ${testResult.ok ? 'success' : 'error'}`}
                style={{ fontSize: 11 }}
              >
                {testResult.ok ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
                <span>{testResult.message}</span>
              </div>
            )}

            <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
              <button
                type="button"
                className="btn-primary"
                disabled={savingAi}
                onClick={() => void handleSaveAiConfig()}
                data-testid="save-ai-config-btn"
              >
                {savingAi ? <Loader2 size={12} className="spin" /> : null}
                {t('director.saveAiConfig')}
              </button>
              <button
                type="button"
                disabled={savingAi || testingProvider}
                onClick={() => void handleTestAiProvider()}
                data-testid="test-ai-provider-btn"
              >
                {testingProvider ? <Loader2 size={12} className="spin" /> : null}
                {t('director.testProviderBtn')}
              </button>
            </div>
          </div>

          {/* Per-Feature Model Overrides (Part 6.3) */}
          <div className="inspector-section" data-testid="settings-feature-models-section">
            <div className="inspector-section-title">
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <Sliders size={12} color="var(--accent-text)" /> {t('aiModels.featureOverridesTitle')}
              </span>
              <button
                type="button"
                className="btn-xs btn-primary"
                disabled={savingFeatures}
                onClick={() => void handleSaveFeatureOverrides()}
                data-testid="save-feature-models-btn"
              >
                {savingFeatures ? <Loader2 size={10} className="spin" /> : null}
                {t('aiModels.saveFeatureOverridesBtn')}
              </button>
            </div>
            <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginBottom: 4 }}>
              {t('aiModels.featureOverridesHint')}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {featureKeys.map((fkey) => {
                const ov = featureDraft[fkey] ?? { provider_id: null, model: null };
                const resolvedPid = (ov.provider_id || providerId) as LLMProviderId;
                const modelChoices = getModelsForProviderOption(resolvedPid);
                const listId = `amcs-feat-models-${fkey}`;
                return (
                  <div
                    key={fkey}
                    data-testid={`feature-override-row-${fkey}`}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1.1fr 0.9fr 1.1fr',
                      gap: 5,
                      alignItems: 'center',
                    }}
                  >
                    <span style={{ fontSize: 11, fontWeight: 500 }}>
                      {t(FEATURE_LABEL_KEYS[fkey])}
                    </span>
                    <select
                      data-testid={`feature-provider-${fkey}`}
                      value={ov.provider_id ?? ''}
                      onChange={(e) => {
                        const nextPid = (e.target.value || null) as LLMProviderId | null;
                        if (nextPid && !modelsByProvider[nextPid]) {
                          void discoverProviderModels(nextPid, false);
                        }
                        setFeatureDraft((prev) => ({
                          ...prev,
                          [fkey]: {
                            provider_id: nextPid,
                            model: nextPid ? prev[fkey]?.model ?? null : null,
                          },
                        }));
                      }}
                      style={{ fontSize: 11 }}
                    >
                      <option value="">{t('aiModels.useSharedDefault')}</option>
                      {aiProviders.map((p) => (
                        <option key={p.provider_id} value={p.provider_id}>
                          {p.display_name}
                        </option>
                      ))}
                    </select>
                    <div>
                      <input
                        data-testid={`feature-model-${fkey}`}
                        list={listId}
                        value={ov.model ?? ''}
                        placeholder={
                          ov.provider_id
                            ? aiProviders.find((p) => p.provider_id === ov.provider_id)?.selected_model ||
                              t('aiModels.providerDefaultPlaceholder')
                            : `${aiModel} (${t('aiModels.defaultShort')})`
                        }
                        onChange={(e) => {
                          const val = e.target.value;
                          setFeatureDraft((prev) => ({
                            ...prev,
                            [fkey]: {
                              provider_id: prev[fkey]?.provider_id ?? (val.trim() ? providerId : null),
                              model: val || null,
                            },
                          }));
                        }}
                        style={{ width: '100%', fontSize: 11 }}
                      />
                      <datalist id={listId}>
                        {modelChoices.map((mc) => (
                          <option key={mc} value={mc} />
                        ))}
                      </datalist>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Runtime Diagnostics */}
          <div className="inspector-section">
            <div className="inspector-section-title">
              <span>{t('modal.runtimeSection')}</span>
              <button className="btn-xs" onClick={() => void refreshHealth()}>
                <RefreshCw size={11} /> {t('common.refresh')}
              </button>
            </div>
            {health ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 11 }}>
                <div>
                  <strong>{t('app.fullName')}:</strong> <span className="mono">v{health.app_version}</span> • OS:{' '}
                  <span className="mono">{health.os} ({health.arch})</span>
                </div>
                <div>
                  <strong>Python Backend:</strong> <span className="mono">Python {health.python_version}</span>
                </div>
                <div>
                  <strong>Workspace:</strong>{' '}
                  <span className="mono" style={{ color: 'var(--text-secondary)', wordBreak: 'break-all' }}>
                    {health.workspace_dir}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {health.ffmpeg.available ? (
                    <CheckCircle2 size={13} color="var(--success)" />
                  ) : (
                    <AlertCircle size={13} color="var(--danger)" />
                  )}
                  <span>
                    <strong>FFmpeg:</strong>{' '}
                    {health.ffmpeg.available
                      ? `OK (${health.ffmpeg.recommended_h264_encoder} | ${health.ffmpeg.available_h264_encoders.join(', ')})`
                      : t('status.ffmpegMissing')}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {health.pixi_render_worker_connected ? (
                    <CheckCircle2 size={13} color="var(--success)" />
                  ) : (
                    <AlertCircle size={13} color="var(--warning)" />
                  )}
                  <span>
                    <strong>PixiJS WebGL Worker:</strong>{' '}
                    {health.pixi_render_worker_connected
                      ? t('status.webglWorker')
                      : t('status.softwareFallback')}
                  </span>
                </div>
              </div>
            ) : (
              <div style={{ color: 'var(--danger)' }}>{t('status.apiOffline')}</div>
            )}
          </div>

          {/* FFmpeg / media environment (Phase 08 Batch 3) */}
          <FFmpegSettingsSection />
        </div>
        <div className="modal-footer">
          <button onClick={onClose}>{t('common.close')}</button>
        </div>
      </div>
    </div>
  );
}
