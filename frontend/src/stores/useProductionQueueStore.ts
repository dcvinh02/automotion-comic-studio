import { create } from 'zustand';
import { apiClient } from '@/services/apiClient';
import { useProjectStore } from '@/stores/useProjectStore';
import type {
  ProductionExecutionMode,
  ProductionQCIssue,
  ProductionQCReport,
  ProductionQueueDocument,
  ProductionQueuePlanPreview,
  ProductionQueueStartRequest,
} from '@/types/models';

export type QueueWorkspaceTab = 'queue' | 'qc';

interface ProductionQueueStore {
  activeSubTab: QueueWorkspaceTab;
  queue: ProductionQueueDocument | null;
  planPreview: ProductionQueuePlanPreview | null;
  qcReport: ProductionQCReport | null;
  selectedMode: ProductionExecutionMode;
  selectedSceneIds: string[];
  selectedShotIds: string[];
  loadingQueue: boolean;
  planning: boolean;
  starting: boolean;
  runningQC: boolean;
  fixingIssueId: string | null;
  lastError: string | null;

  setActiveSubTab: (tab: QueueWorkspaceTab) => void;
  setSelectedMode: (mode: ProductionExecutionMode) => void;
  setSelectedSceneIds: (ids: string[]) => void;
  setSelectedShotIds: (ids: string[]) => void;
  applyQueueUpdate: (projectId: string, doc: ProductionQueueDocument) => void;

  refreshQueueAndQC: (projectId: string) => Promise<void>;
  buildPlanPreview: (
    projectId: string,
    req: ProductionQueueStartRequest,
  ) => Promise<ProductionQueuePlanPreview>;
  startProduction: (
    projectId: string,
    req: ProductionQueueStartRequest,
  ) => Promise<ProductionQueueDocument>;
  pauseProduction: (projectId: string) => Promise<void>;
  resumeProduction: (projectId: string) => Promise<void>;
  cancelProduction: (projectId: string) => Promise<void>;
  retryTask: (projectId: string, taskId: string) => Promise<void>;
  skipTask: (projectId: string, taskId: string) => Promise<void>;
  cancelTask: (projectId: string, taskId: string) => Promise<void>;

  runQC: (projectId: string, sceneIds?: string[] | null) => Promise<ProductionQCReport>;
  fixQCIssue: (projectId: string, issue: ProductionQCIssue) => Promise<string>;
}

export const useProductionQueueStore = create<ProductionQueueStore>((set) => ({
  activeSubTab: 'queue',
  queue: null,
  planPreview: null,
  qcReport: null,
  selectedMode: 'production_plan',
  selectedSceneIds: [],
  selectedShotIds: [],
  loadingQueue: false,
  planning: false,
  starting: false,
  runningQC: false,
  fixingIssueId: null,
  lastError: null,

  setActiveSubTab: (activeSubTab) => set({ activeSubTab }),
  setSelectedMode: (selectedMode) => set({ selectedMode, planPreview: null }),
  setSelectedSceneIds: (selectedSceneIds) => set({ selectedSceneIds, planPreview: null }),
  setSelectedShotIds: (selectedShotIds) => set({ selectedShotIds, planPreview: null }),

  applyQueueUpdate: (projectId, doc) => {
    const curProj = useProjectStore.getState().project;
    if (!curProj || curProj.meta.project_id !== projectId) return;
    set({ queue: doc });
    // When queue reaches a settled state or completes assembly/animation, re-hydrate project state from SQLite
    if (
      doc.status === 'completed' ||
      doc.status === 'partial' ||
      doc.status === 'failed' ||
      doc.status === 'cancelled' ||
      doc.status === 'paused'
    ) {
      void apiClient
        .getProject(projectId)
        .then((fresh) => {
          // Background re-hydrate: merge (never discard unsaved edits, never move the user's view)
          useProjectStore.getState().syncFromServer(fresh);
          if (fresh.qc_report) {
            set({ qcReport: fresh.qc_report });
          }
        })
        .catch(() => {});
    }
  },

  refreshQueueAndQC: async (projectId) => {
    set({ loadingQueue: true, lastError: null });
    try {
      const [queue, qcReport] = await Promise.all([
        apiClient.getProductionQueue(projectId),
        apiClient.getLatestProjectQC(projectId),
      ]);
      set({ queue, qcReport, loadingQueue: false });
    } catch (err) {
      set({
        loadingQueue: false,
        lastError: err instanceof Error ? err.message : 'Failed to load queue/QC',
      });
    }
  },

  buildPlanPreview: async (projectId, req) => {
    set({ planning: true, lastError: null });
    try {
      const preview = await apiClient.planProductionQueue(projectId, req);
      set({ planPreview: preview, planning: false });
      return preview;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to build execution plan';
      set({ planning: false, lastError: msg });
      throw err;
    }
  },

  startProduction: async (projectId, req) => {
    set({ starting: true, lastError: null });
    try {
      const doc = await apiClient.startProductionQueue(projectId, req);
      set({ queue: doc, planPreview: null, starting: false });
      return doc;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to start production queue';
      set({ starting: false, lastError: msg });
      throw err;
    }
  },

  pauseProduction: async (projectId) => {
    const doc = await apiClient.pauseProductionQueue(projectId);
    set({ queue: doc });
  },

  resumeProduction: async (projectId) => {
    const doc = await apiClient.resumeProductionQueue(projectId);
    set({ queue: doc });
  },

  cancelProduction: async (projectId) => {
    const doc = await apiClient.cancelProductionQueue(projectId);
    set({ queue: doc });
  },

  retryTask: async (projectId, taskId) => {
    const doc = await apiClient.retryProductionTask(projectId, taskId);
    set({ queue: doc, lastError: null });
  },

  skipTask: async (projectId, taskId) => {
    const doc = await apiClient.skipProductionTask(projectId, taskId);
    set({ queue: doc });
  },

  cancelTask: async (projectId, taskId) => {
    const doc = await apiClient.cancelProductionTask(projectId, taskId);
    set({ queue: doc });
  },

  runQC: async (projectId, sceneIds = null) => {
    set({ runningQC: true, lastError: null });
    try {
      const report = await apiClient.runProjectQC(projectId, sceneIds);
      set({ qcReport: report, runningQC: false });
      return report;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Quality Control check failed';
      set({ runningQC: false, lastError: msg });
      throw err;
    }
  },

  fixQCIssue: async (projectId, issue) => {
    if (!issue.fix_action) throw new Error('No inline fix action available for this issue.');
    set({ fixingIssueId: issue.issue_id });
    try {
      const res = await apiClient.fixProjectQCIssue(projectId, {
        issue_id: issue.issue_id,
        fix_action: issue.fix_action,
        scene_id: issue.scene_id,
        shot_id: issue.shot_id,
        subtitle_id: issue.subtitle_id,
        sound_event_id: issue.sound_event_id,
      });
      useProjectStore.getState().applyExecutedProjectState(res.updated_project, false);
      set({ qcReport: res.report, fixingIssueId: null });
      return res.message;
    } catch (err) {
      set({ fixingIssueId: null });
      throw err;
    }
  },
}));
