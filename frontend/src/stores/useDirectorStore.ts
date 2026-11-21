import { create } from 'zustand';
import { apiClient } from '@/services/apiClient';
import type {
  AIFeatureKey,
  AIModelDiscoveryResult,
  AIProviderConfig,
  AIProviderConfigUpdate,
  AIProviderInfo,
  AnalysisLanguage,
  AnalysisProgress,
  DirectorAnalysisDocument,
  FeatureModelOverride,
  LLMProviderId,
  SceneBreakdownItem,
  ScriptSourceMode,
} from '@/types/models';

export type DirectorTabId = 'overview' | 'characters' | 'dialogue' | 'scenes';

interface DirectorStore {
  config: AIProviderConfig | null;
  providers: AIProviderInfo[];
  featureKeys: AIFeatureKey[];
  modelsByProvider: Partial<Record<LLMProviderId, AIModelDiscoveryResult>>;
  discoveringProvider: LLMProviderId | null;
  loadingProviders: boolean;
  testingProvider: boolean;
  testResult: { ok: boolean; message: string } | null;

  analyzing: boolean;
  regeneratingSceneId: string | null;
  progress: AnalysisProgress | null;
  lastError: string | null;

  activeTab: DirectorTabId;
  selectedSceneBreakdownId: string | null;
  selectedCharacterAnalysisId: string | null;

  refreshProviders: () => Promise<void>;
  discoverProviderModels: (
    providerId: LLMProviderId,
    forceRefresh?: boolean,
  ) => Promise<AIModelDiscoveryResult>;
  saveProviderConfig: (patch: AIProviderConfigUpdate) => Promise<AIProviderConfig>;
  saveFeatureModels: (
    featureModels: Record<string, FeatureModelOverride>,
  ) => Promise<AIProviderConfig>;
  testProvider: () => Promise<{ ok: boolean; message: string }>;

  setActiveTab: (tab: DirectorTabId) => void;
  setSelectedSceneBreakdownId: (id: string | null) => void;
  setSelectedCharacterAnalysisId: (id: string | null) => void;
  setProgress: (prog: AnalysisProgress) => void;
  clearError: () => void;

  runAnalysis: (
    projectId: string,
    payload: {
      script_source_mode?: ScriptSourceMode;
      custom_script_text?: string | null;
      analysis_language?: AnalysisLanguage | null;
      force?: boolean;
      max_chunk_chars?: number | null;
    },
  ) => Promise<DirectorAnalysisDocument>;
  cancelAnalysis: (projectId: string) => Promise<void>;
  regenerateScene: (
    projectId: string,
    sceneBreakdownId: string,
    instructions?: string,
    preserveUserEdits?: boolean,
  ) => Promise<SceneBreakdownItem>;
}

export const useDirectorStore = create<DirectorStore>((set, get) => ({
  config: null,
  providers: [],
  featureKeys: [
    'script_analysis',
    'script_generation',
    'character_analysis',
    'storyboard',
    'ai_director',
    'production_plan',
    'animation_planning',
    'asset_prompts',
  ],
  modelsByProvider: {},
  discoveringProvider: null,
  loadingProviders: false,
  testingProvider: false,
  testResult: null,

  analyzing: false,
  regeneratingSceneId: null,
  progress: null,
  lastError: null,

  activeTab: 'overview',
  selectedSceneBreakdownId: null,
  selectedCharacterAnalysisId: null,

  refreshProviders: async () => {
    set({ loadingProviders: true });
    try {
      const res = await apiClient.getDirectorProviders();
      set({
        config: res.config,
        providers: res.providers,
        featureKeys: res.feature_keys?.length ? res.feature_keys : get().featureKeys,
        loadingProviders: false,
      });
    } catch {
      set({ loadingProviders: false });
    }
  },

  discoverProviderModels: async (providerId, forceRefresh = false) => {
    set({ discoveringProvider: providerId });
    try {
      const result = forceRefresh
        ? await apiClient.refreshProviderModels(providerId)
        : await apiClient.getProviderModels(providerId, false);
      set((s) => ({
        discoveringProvider: null,
        modelsByProvider: { ...s.modelsByProvider, [providerId]: result },
      }));
      return result;
    } catch (err) {
      const fallback: AIModelDiscoveryResult = {
        provider_id: providerId,
        models: [],
        source: 'catalog_fallback',
        discovered_count: 0,
        fetched_at: null,
        error: err instanceof Error ? err.message : 'Model discovery failed',
        error_code: 'network_error',
        selected_model_valid: true,
        selected_model_warning: '',
      };
      set((s) => ({
        discoveringProvider: null,
        modelsByProvider: { ...s.modelsByProvider, [providerId]: fallback },
      }));
      return fallback;
    }
  },

  saveProviderConfig: async (patch) => {
    const updated = await apiClient.updateDirectorConfig(patch);
    const res = await apiClient.getDirectorProviders();
    set({ config: res.config, providers: res.providers, testResult: null });
    return updated;
  },

  saveFeatureModels: async (featureModels) => {
    const updated = await apiClient.updateFeatureModels(featureModels);
    const res = await apiClient.getDirectorProviders();
    set({ config: res.config, providers: res.providers });
    return updated;
  },

  testProvider: async () => {
    set({ testingProvider: true, testResult: null });
    try {
      const res = await apiClient.testDirectorProvider();
      const out = {
        ok: res.ok,
        message: `${res.provider_id} / ${res.model} — OK`,
      };
      set({ testingProvider: false, testResult: out });
      return out;
    } catch (err) {
      const out = {
        ok: false,
        message: err instanceof Error ? err.message : 'Provider test failed',
      };
      set({ testingProvider: false, testResult: out });
      return out;
    }
  },

  setActiveTab: (activeTab) => set({ activeTab }),
  setSelectedSceneBreakdownId: (selectedSceneBreakdownId) => set({ selectedSceneBreakdownId }),
  setSelectedCharacterAnalysisId: (selectedCharacterAnalysisId) =>
    set({ selectedCharacterAnalysisId }),
  setProgress: (progress) => set({ progress }),
  clearError: () => set({ lastError: null }),

  runAnalysis: async (projectId, payload) => {
    if (get().analyzing) {
      throw new Error('Analysis is already running for this project.');
    }
    set({
      analyzing: true,
      lastError: null,
      progress: {
        project_id: projectId,
        status: 'running',
        stage: 'preparing',
        current_chunk: 0,
        total_chunks: 1,
        progress_pct: 5,
        message: 'Starting AI script analysis...',
        context_limit_warning: '',
        error: null,
        started_at: new Date().toISOString(),
        ended_at: null,
      },
    });
    try {
      const doc = await apiClient.analyzeProjectScript(projectId, payload);
      set({
        analyzing: false,
        lastError: null,
        selectedSceneBreakdownId: doc.scenes[0]?.scene_breakdown_id ?? null,
        selectedCharacterAnalysisId: doc.characters[0]?.character_analysis_id ?? null,
      });
      return doc;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'AI analysis failed';
      set({ analyzing: false, lastError: msg });
      throw err;
    }
  },

  cancelAnalysis: async (projectId) => {
    try {
      const prog = await apiClient.cancelDirectorAnalysis(projectId);
      set({ progress: prog });
    } catch {
      // Ignore network cancellation errors
    }
  },

  regenerateScene: async (projectId, sceneBreakdownId, instructions = '', preserveUserEdits = true) => {
    set({ regeneratingSceneId: sceneBreakdownId, lastError: null });
    try {
      const updated = await apiClient.regenerateDirectorScene(projectId, sceneBreakdownId, {
        instructions,
        preserve_user_edits: preserveUserEdits,
      });
      set({ regeneratingSceneId: null });
      return updated;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Scene regeneration failed';
      set({ regeneratingSceneId: null, lastError: msg });
      throw err;
    }
  },
}));
