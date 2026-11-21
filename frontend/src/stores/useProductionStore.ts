import { create } from 'zustand';
import { apiClient } from '@/services/apiClient';
import type {
  AnalysisLanguage,
  ProductionPlanDocument,
  ProductionProgress,
  ProductionShotPlan,
} from '@/types/models';

export type TimelinePreviewScope = 'shot' | 'scene' | 'all_approved';

interface ProductionStore {
  generating: boolean;
  generatingSceneId: string | null;
  regeneratingShotId: string | null;
  refreshingReadiness: boolean;
  progress: ProductionProgress | null;
  lastError: string | null;

  activeSceneId: string | null;
  selectedProductionShotId: string | null;
  previewScope: TimelinePreviewScope | null;
  sceneExecutionScope: TimelinePreviewScope | null;

  setActiveSceneId: (sceneId: string | null) => void;
  setSelectedProductionShotId: (productionShotId: string | null) => void;
  openTimelinePreview: (scope: TimelinePreviewScope) => void;
  closeTimelinePreview: () => void;
  openSceneExecutionPreview: (scope: TimelinePreviewScope) => void;
  closeSceneExecutionPreview: () => void;
  setProgress: (progress: ProductionProgress) => void;
  clearError: () => void;

  generateAll: (
    projectId: string,
    payload?: {
      scene_ids?: string[] | null;
      force?: boolean;
      preserve_locked?: boolean;
      analysis_language?: AnalysisLanguage | null;
    },
  ) => Promise<ProductionPlanDocument>;

  generateScene: (
    projectId: string,
    sceneId: string,
    payload?: {
      preserve_locked?: boolean;
      analysis_language?: AnalysisLanguage | null;
    },
  ) => Promise<ProductionPlanDocument>;

  regenerateShot: (
    projectId: string,
    productionShotId: string,
    instructions?: string,
    preserveUserEdits?: boolean,
  ) => Promise<ProductionShotPlan>;

  refreshReadiness: (projectId: string) => Promise<ProductionPlanDocument>;
  cancelGeneration: (projectId: string) => Promise<void>;
}

export const useProductionStore = create<ProductionStore>((set, get) => ({
  generating: false,
  generatingSceneId: null,
  regeneratingShotId: null,
  refreshingReadiness: false,
  progress: null,
  lastError: null,

  activeSceneId: null,
  selectedProductionShotId: null,
  previewScope: null,
  sceneExecutionScope: null,

  setActiveSceneId: (activeSceneId) => set({ activeSceneId }),
  setSelectedProductionShotId: (selectedProductionShotId) => set({ selectedProductionShotId }),
  openTimelinePreview: (previewScope) => set({ previewScope }),
  closeTimelinePreview: () => set({ previewScope: null }),
  openSceneExecutionPreview: (sceneExecutionScope) => set({ sceneExecutionScope }),
  closeSceneExecutionPreview: () => set({ sceneExecutionScope: null }),
  setProgress: (progress) => set({ progress }),
  clearError: () => set({ lastError: null }),

  generateAll: async (projectId, payload) => {
    if (get().generating) {
      throw new Error('Production plan generation is already running.');
    }
    set({
      generating: true,
      generatingSceneId: null,
      lastError: null,
      progress: {
        project_id: projectId,
        status: 'running',
        stage: 'preparing',
        current_scene: 0,
        total_scenes: 1,
        current_scene_title: '',
        progress_pct: 5,
        message: 'Starting AI Production Planner...',
        error: null,
        started_at: new Date().toISOString(),
        ended_at: null,
      },
    });
    try {
      const doc = await apiClient.generateProductionPlan(projectId, payload);
      set((s) => {
        const hasScene =
          s.activeSceneId && doc.shots.some((sh) => sh.scene_id === s.activeSceneId);
        const nextSceneId = hasScene ? s.activeSceneId : doc.shots[0]?.scene_id ?? null;
        const hasShot =
          s.selectedProductionShotId &&
          doc.shots.some((sh) => sh.production_shot_id === s.selectedProductionShotId);
        const nextShotId = hasShot
          ? s.selectedProductionShotId
          : doc.shots.find((sh) => sh.scene_id === nextSceneId)?.production_shot_id ??
            doc.shots[0]?.production_shot_id ??
            null;
        return {
          generating: false,
          lastError: null,
          activeSceneId: nextSceneId,
          selectedProductionShotId: nextShotId,
        };
      });
      return doc;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Production plan generation failed';
      set({ generating: false, lastError: msg });
      throw err;
    }
  },

  generateScene: async (projectId, sceneId, payload) => {
    if (get().generating) {
      throw new Error('Production plan generation is already running.');
    }
    set({ generating: true, generatingSceneId: sceneId, lastError: null });
    try {
      const doc = await apiClient.generateSceneProductionPlan(projectId, sceneId, payload);
      const sceneShots = doc.shots.filter((sh) => sh.scene_id === sceneId);
      set({
        generating: false,
        generatingSceneId: null,
        activeSceneId: sceneId,
        selectedProductionShotId:
          sceneShots[0]?.production_shot_id ?? doc.shots[0]?.production_shot_id ?? null,
      });
      return doc;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Scene production plan generation failed';
      set({ generating: false, generatingSceneId: null, lastError: msg });
      throw err;
    }
  },

  regenerateShot: async (
    projectId,
    productionShotId,
    instructions = '',
    preserveUserEdits = true,
  ) => {
    set({ regeneratingShotId: productionShotId, lastError: null });
    try {
      const updated = await apiClient.regenerateProductionShot(projectId, productionShotId, {
        instructions,
        preserve_user_edits: preserveUserEdits,
      });
      set({ regeneratingShotId: null });
      return updated;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Shot plan regeneration failed';
      set({ regeneratingShotId: null, lastError: msg });
      throw err;
    }
  },

  refreshReadiness: async (projectId) => {
    set({ refreshingReadiness: true, lastError: null });
    try {
      const doc = await apiClient.refreshProductionReadiness(projectId);
      set({ refreshingReadiness: false });
      return doc;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to refresh readiness';
      set({ refreshingReadiness: false, lastError: msg });
      throw err;
    }
  },

  cancelGeneration: async (projectId) => {
    try {
      const prog = await apiClient.cancelProductionGeneration(projectId);
      set({ progress: prog });
    } catch {
      // Ignore network errors when cancelling
    }
  },
}));
