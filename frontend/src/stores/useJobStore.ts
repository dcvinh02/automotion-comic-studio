import { create } from 'zustand';
import type { ExportSettings, HealthResponse, RenderJob, RenderJobProgress, RenderQueueState } from '@/types/models';
import { apiClient } from '@/services/apiClient';

export interface ToastItem {
  id: string;
  kind: 'info' | 'success' | 'warning' | 'error';
  message: string;
}

interface JobAndSystemStore {
  health: HealthResponse | null;
  backendConnected: boolean;
  pixiWorkerConnected: boolean;
  jobs: RenderJob[];
  drawerOpen: boolean;
  toasts: ToastItem[];

  refreshHealth: () => Promise<void>;
  refreshJobs: (projectId: string) => Promise<void>;
  upsertJob: (job: RenderJob) => void;
  updateJobProgress: (
    jobId: string,
    progressPct: number,
    message: string,
    extra?: { status?: RenderJob['status']; progress?: RenderJobProgress },
  ) => void;
  removeJobLocal: (jobId: string) => void;
  queueState: RenderQueueState | null;
  setQueueState: (q: RenderQueueState) => void;
  refreshQueueState: () => Promise<void>;
  /** Re-export: undefined = no request; null = open with saved defaults; settings = prefilled. */
  exportModalRequest: { settings: ExportSettings | null } | null;
  requestExportModal: (settings: ExportSettings | null) => void;
  clearExportModalRequest: () => void;
  setPixiWorkerConnected: (connected: boolean) => void;
  setDrawerOpen: (open: boolean) => void;
  pushToast: (kind: ToastItem['kind'], message: string) => void;
  dismissToast: (id: string) => void;
}

export const useJobStore = create<JobAndSystemStore>((set) => ({
  health: null,
  backendConnected: false,
  pixiWorkerConnected: false,
  jobs: [],
  drawerOpen: false,
  toasts: [],
  queueState: null,
  exportModalRequest: null,

  refreshHealth: async () => {
    try {
      const health = await apiClient.getHealth();
      set({
        health,
        backendConnected: health.status === 'ok',
        pixiWorkerConnected: health.pixi_render_worker_connected,
      });
    } catch {
      set({ backendConnected: false });
    }
  },

  refreshJobs: async (projectId) => {
    const jobs = await apiClient.listJobs(projectId);
    set({ jobs });
  },

  // Update in place (stable card order while a job progresses); new jobs go on top.
  upsertJob: (job) =>
    set((s) => {
      const idx = s.jobs.findIndex((j) => j.job_id === job.job_id);
      if (idx === -1) return { jobs: [job, ...s.jobs] };
      const next = s.jobs.slice();
      next[idx] = job;
      return { jobs: next };
    }),

  updateJobProgress: (jobId, progressPct, message, extra) =>
    set((s) => ({
      jobs: s.jobs.map((j) =>
        j.job_id === jobId
          ? {
              ...j,
              progress_pct: progressPct,
              message,
              ...(extra?.status ? { status: extra.status } : {}),
              ...(extra?.progress ? { progress: { ...(j.progress ?? {}), ...extra.progress } } : {}),
            }
          : j,
      ),
    })),

  removeJobLocal: (jobId) => set((s) => ({ jobs: s.jobs.filter((j) => j.job_id !== jobId) })),
  setQueueState: (queueState) => set({ queueState }),
  requestExportModal: (settings) => set({ exportModalRequest: { settings } }),
  clearExportModalRequest: () => set({ exportModalRequest: null }),
  refreshQueueState: async () => {
    try {
      const queueState = await apiClient.getRenderQueueState();
      set({ queueState });
    } catch {
      // backend not reachable yet
    }
  },

  setPixiWorkerConnected: (pixiWorkerConnected) => set({ pixiWorkerConnected }),
  setDrawerOpen: (drawerOpen) => set({ drawerOpen }),

  pushToast: (kind, message) => {
    const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    set((s) => ({ toasts: [...s.toasts.slice(-4), { id, kind, message }] }));
    window.setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, 4500);
  },

  dismissToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
