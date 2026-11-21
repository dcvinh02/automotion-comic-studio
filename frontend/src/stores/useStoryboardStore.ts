import { create } from 'zustand';
import { apiClient } from '@/services/apiClient';
import type {
  AnalysisLanguage,
  ApprovedSceneSummary,
  RegenerateStrategy,
  StoryboardDocument,
  StoryboardProgress,
  StoryboardShot,
} from '@/types/models';

interface StoryboardStore {
  approvedScenes: ApprovedSceneSummary[];
  loadingApprovedScenes: boolean;

  generating: boolean;
  generatingSceneId: string | null;
  regeneratingShotId: string | null;
  progress: StoryboardProgress | null;
  lastError: string | null;

  activeSceneId: string | null;
  selectedShotId: string | null;
  showContinuityDrawer: boolean;

  refreshApprovedScenes: (projectId: string) => Promise<ApprovedSceneSummary[]>;
  setActiveSceneId: (sceneId: string | null) => void;
  setSelectedShotId: (shotId: string | null) => void;
  setShowContinuityDrawer: (open: boolean) => void;
  setProgress: (prog: StoryboardProgress) => void;
  clearError: () => void;

  generateAll: (
    projectId: string,
    payload?: {
      scene_ids?: string[] | null;
      force?: boolean;
      strategy?: RegenerateStrategy;
      confirm_replace_all?: boolean;
      analysis_language?: AnalysisLanguage | null;
    },
  ) => Promise<StoryboardDocument>;

  generateScene: (
    projectId: string,
    sceneId: string,
    payload?: {
      force?: boolean;
      strategy?: RegenerateStrategy;
      confirm_replace_all?: boolean;
      instructions?: string;
      analysis_language?: AnalysisLanguage | null;
    },
  ) => Promise<StoryboardDocument>;

  regenerateShot: (
    projectId: string,
    shotId: string,
    instructions?: string,
    preserveUserEdits?: boolean,
  ) => Promise<StoryboardShot>;

  cancelGeneration: (projectId: string) => Promise<void>;
}

export const useStoryboardStore = create<StoryboardStore>((set, get) => ({
  approvedScenes: [],
  loadingApprovedScenes: false,

  generating: false,
  generatingSceneId: null,
  regeneratingShotId: null,
  progress: null,
  lastError: null,

  activeSceneId: null,
  selectedShotId: null,
  showContinuityDrawer: false,

  refreshApprovedScenes: async (projectId) => {
    set({ loadingApprovedScenes: true });
    try {
      const list = await apiClient.listStoryboardApprovedScenes(projectId);
      set((s) => ({
        approvedScenes: list,
        loadingApprovedScenes: false,
        activeSceneId:
          s.activeSceneId && list.some((sc) => sc.scene_id === s.activeSceneId)
            ? s.activeSceneId
            : list[0]?.scene_id ?? null,
      }));
      return list;
    } catch {
      set({ loadingApprovedScenes: false });
      return [];
    }
  },

  setActiveSceneId: (activeSceneId) => set({ activeSceneId }),
  setSelectedShotId: (selectedShotId) => set({ selectedShotId }),
  setShowContinuityDrawer: (showContinuityDrawer) => set({ showContinuityDrawer }),
  setProgress: (progress) => set({ progress }),
  clearError: () => set({ lastError: null }),

  generateAll: async (projectId, payload) => {
    if (get().generating) {
      throw new Error('Storyboard generation is already running.');
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
        total_scenes: get().approvedScenes.length || 1,
        current_scene_title: '',
        progress_pct: 5,
        message: 'Starting AI Storyboard generation...',
        error: null,
        started_at: new Date().toISOString(),
        ended_at: null,
      },
    });
    try {
      const doc = await apiClient.generateStoryboard(projectId, payload);
      await get().refreshApprovedScenes(projectId);
      set((s) => ({
        generating: false,
        lastError: null,
        selectedShotId:
          s.selectedShotId && doc.shots.some((sh) => sh.shot_id === s.selectedShotId)
            ? s.selectedShotId
            : doc.shots[0]?.shot_id ?? null,
      }));
      return doc;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Storyboard generation failed';
      set({ generating: false, lastError: msg });
      throw err;
    }
  },

  generateScene: async (projectId, sceneId, payload) => {
    if (get().generating) {
      throw new Error('Storyboard generation is already running.');
    }
    set({ generating: true, generatingSceneId: sceneId, lastError: null });
    try {
      const doc = await apiClient.generateSceneStoryboard(projectId, sceneId, payload);
      await get().refreshApprovedScenes(projectId);
      const sceneShots = doc.shots.filter((sh) => sh.scene_id === sceneId);
      set({
        generating: false,
        generatingSceneId: null,
        activeSceneId: sceneId,
        selectedShotId: sceneShots[0]?.shot_id ?? doc.shots[0]?.shot_id ?? null,
      });
      return doc;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Scene storyboard generation failed';
      set({ generating: false, generatingSceneId: null, lastError: msg });
      throw err;
    }
  },

  regenerateShot: async (projectId, shotId, instructions = '', preserveUserEdits = true) => {
    set({ regeneratingShotId: shotId, lastError: null });
    try {
      const updated = await apiClient.regenerateStoryboardShot(projectId, shotId, {
        instructions,
        preserve_user_edits: preserveUserEdits,
      });
      set({ regeneratingShotId: null });
      return updated;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Shot regeneration failed';
      set({ regeneratingShotId: null, lastError: msg });
      throw err;
    }
  },

  cancelGeneration: async (projectId) => {
    try {
      const prog = await apiClient.cancelStoryboardGeneration(projectId);
      set({ progress: prog });
    } catch {
      // Ignore network cancellation errors
    }
  },
}));
