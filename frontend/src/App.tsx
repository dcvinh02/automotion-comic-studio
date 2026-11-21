import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Brain,
  Captions,
  ClipboardCheck,
  FileText,
  Layers,
  LayoutGrid,
  ListChecks,
  PanelLeftClose,
  PanelRightClose,
  Users,
} from 'lucide-react';
import { frameToMs, msToFrame } from '@/engine/evaluator';
import { findScriptSceneById } from '@/engine/scriptEngine';
import { tGlobal, useI18n } from '@/i18n/useLocaleStore';
import { apiClient } from '@/services/apiClient';
import { recoveryClient } from '@/services/recoveryClient';
import { buildRecoveryPayload } from '@/engine/recoveryJournal';
import { wsClient } from '@/services/wsClient';
import { useAnimationExecStore } from '@/stores/useAnimationExecStore';
import { useDirectorStore } from '@/stores/useDirectorStore';
import { useJobStore } from '@/stores/useJobStore';
import { useLibraryStore } from '@/stores/useLibraryStore';
import { usePlaybackStore } from '@/stores/usePlaybackStore';
import { useProductionStore } from '@/stores/useProductionStore';
import { useProductionQueueStore } from '@/stores/useProductionQueueStore';
import { useProjectStore } from '@/stores/useProjectStore';
import { useStoryboardStore } from '@/stores/useStoryboardStore';
import { useVoiceStore } from '@/stores/useVoiceStore';
import { useWorkspaceStore, type SidebarTabId } from '@/stores/useWorkspaceStore';
import type {
  AnalysisProgress,
  ProductionProgress,
  ProductionQueueDocument,
  RenderJob,
  RenderQueueState,
  StoryboardProgress,
} from '@/types/models';
import { formatTimecode, ToastStack } from '@/components/common/CommonUI';
import { RightInspector } from '@/components/inspector/RightInspector';
import { LeftNavRail } from '@/components/layout/LeftNavRail';
import { StatusBar } from '@/components/layout/StatusBar';
import { TopToolbar } from '@/components/layout/TopToolbar';
import { AnimationExecutionModal } from '@/components/modals/AnimationExecutionModal';
import { ExportModal } from '@/components/modals/ExportModal';
import { RecoveryDialog } from '@/components/modals/RecoveryDialog';
import { JobQueueDrawer } from '@/components/modals/JobQueueDrawer';
import { ProjectManagerModal } from '@/components/modals/ProjectManagerModal';
import { SceneExecutionPreviewModal } from '@/components/modals/SceneExecutionPreviewModal';
import { SettingsModal } from '@/components/modals/SettingsModal';
import { ShortcutsModal } from '@/components/modals/ShortcutsModal';
import { TimelineApplyPreviewModal } from '@/components/modals/TimelineApplyPreviewModal';
import { AnimationPanel } from '@/components/sidebar/AnimationPanel';
import { AssetsPanel } from '@/components/sidebar/AssetsPanel';
import { CharactersPanel } from '@/components/sidebar/CharactersPanel';
import { DirectorSidebarPanel } from '@/components/sidebar/DirectorSidebarPanel';
import { ProductionQueueSidebarPanel } from '@/components/sidebar/ProductionQueueSidebarPanel';
import { ProductionSidebarPanel } from '@/components/sidebar/ProductionSidebarPanel';
import { ProjectOverviewPanel } from '@/components/sidebar/ProjectOverviewPanel';
import { RenderQueuePanel } from '@/components/sidebar/RenderQueuePanel';
import { ScenesPanel } from '@/components/sidebar/ScenesPanel';
import { ScriptScenesPanel } from '@/components/sidebar/ScriptScenesPanel';
import { SoundEffectsPanel } from '@/components/sidebar/SoundEffectsPanel';
import { StoryboardSidebarPanel } from '@/components/sidebar/StoryboardSidebarPanel';
import { SubtitlesPanel } from '@/components/sidebar/SubtitlesPanel';
import { VoicePanel } from '@/components/sidebar/VoicePanel';
import { CharacterRigEditor } from '@/components/stage/CharacterRigEditor';
import { DirectorWorkspace } from '@/components/stage/DirectorWorkspace';
import { PreviewCanvas } from '@/components/stage/PreviewCanvas';
import { ProductionQueueWorkspace } from '@/components/stage/ProductionQueueWorkspace';
import { ProductionWorkspace } from '@/components/stage/ProductionWorkspace';
import { ScriptEditorWorkspace } from '@/components/stage/ScriptEditorWorkspace';
import { StoryboardWorkspace } from '@/components/stage/StoryboardWorkspace';
import { SubtitleStudioWorkspace } from '@/components/stage/SubtitleStudioWorkspace';
import { MasterTimeline } from '@/components/timeline/MasterTimeline';
import { ContextMenuOverlay } from '@/components/ui/ContextMenu';

const SIDEBAR_TITLE_KEYS: Record<SidebarTabId, string> = {
  project: 'panel.project',
  scenes: 'panel.scenes',
  characters: 'panel.characters',
  assets: 'panel.assets',
  animation: 'panel.animation',
  sounds: 'panel.sounds',
  subtitles: 'panel.subtitles',
  render_queue: 'panel.renderQueue',
  script: 'panel.script',
  director: 'panel.director',
  storyboard: 'panel.storyboard',
  production: 'panel.production',
  production_queue: 'panel.productionQueue',
  voice: 'panel.voice',
};

export function App() {
  const { t } = useI18n();
  const project = useProjectStore((s) => s.project);
  const activeScriptSceneId = useProjectStore((s) => s.activeScriptSceneId);
  const selectedScriptEntryId = useProjectStore((s) => s.selectedScriptEntryId);
  const isDirty = useProjectStore((s) => s.isDirty);
  const selection = useProjectStore((s) => s.selection);
  const selectedKeyframeIds = useProjectStore((s) => s.selectedKeyframeIds);
  const copiedKeyframes = useProjectStore((s) => s.copiedKeyframes);
  const loadProjectList = useProjectStore((s) => s.loadProjectList);
  const openProject = useProjectStore((s) => s.openProject);
  const saveProject = useProjectStore((s) => s.saveProject);
  const copySelectedKeyframes = useProjectStore((s) => s.copySelectedKeyframes);
  const pasteKeyframesAtTime = useProjectStore((s) => s.pasteKeyframesAtTime);
  const duplicateKeyframes = useProjectStore((s) => s.duplicateKeyframes);
  const moveKeyframesByDeltaFrames = useProjectStore((s) => s.moveKeyframesByDeltaFrames);
  const setSelectedKeyframeIds = useProjectStore((s) => s.setSelectedKeyframeIds);
  const clearKeyframeSelection = useProjectStore((s) => s.clearKeyframeSelection);
  const deleteKeyframes = useProjectStore((s) => s.deleteKeyframes);
  const deleteSoundEvent = useProjectStore((s) => s.deleteSoundEvent);
  const selectedSubtitleIds = useProjectStore((s) => s.selectedSubtitleIds);
  const deleteSubtitleSegments = useProjectStore((s) => s.deleteSubtitleSegments);
  const undo = useProjectStore((s) => s.undo);
  const redo = useProjectStore((s) => s.redo);

  const refreshLibrary = useLibraryStore((s) => s.refreshAll);
  const refreshVoice = useVoiceStore((s) => s.refreshAll);
  const refreshProjectAudio = useVoiceStore((s) => s.refreshProjectAudio);
  const clearProjectAudio = useVoiceStore((s) => s.clearProjectAudio);

  const isPlaying = usePlaybackStore((s) => s.isPlaying);
  // Phase 09.2: App must not subscribe to currentFrame (it changes every playback frame and would
  // re-render the whole application tree); handlers read it from the store when they run.
  const setPlaying = usePlaybackStore((s) => s.setPlaying);
  const setCurrentFrame = usePlaybackStore((s) => s.setCurrentFrame);
  const stepFrames = usePlaybackStore((s) => s.stepFrames);

  const refreshHealth = useJobStore((s) => s.refreshHealth);
  const refreshJobs = useJobStore((s) => s.refreshJobs);
  const upsertJob = useJobStore((s) => s.upsertJob);
  const updateJobProgress = useJobStore((s) => s.updateJobProgress);
  const setPixiWorkerConnected = useJobStore((s) => s.setPixiWorkerConnected);
  const pushToast = useJobStore((s) => s.pushToast);

  const sidebarTab = useWorkspaceStore((s) => s.sidebarTab);
  const centerMode = useWorkspaceStore((s) => s.centerMode);
  const editingCharacterId = useWorkspaceStore((s) => s.editingCharacterId);
  const leftCollapsed = useWorkspaceStore((s) => s.leftCollapsed);
  const rightCollapsed = useWorkspaceStore((s) => s.rightCollapsed);
  const timelineCollapsed = useWorkspaceStore((s) => s.timelineCollapsed);
  const leftWidth = useWorkspaceStore((s) => s.leftWidth);
  const rightWidth = useWorkspaceStore((s) => s.rightWidth);
  const timelineHeight = useWorkspaceStore((s) => s.timelineHeight);
  const contextMenu = useWorkspaceStore((s) => s.contextMenu);

  const setCenterMode = useWorkspaceStore((s) => s.setCenterMode);
  const setActiveTool = useWorkspaceStore((s) => s.setActiveTool);
  const openRigEditor = useWorkspaceStore((s) => s.openRigEditor);
  const setLeftCollapsed = useWorkspaceStore((s) => s.setLeftCollapsed);
  const setRightCollapsed = useWorkspaceStore((s) => s.setRightCollapsed);
  const setTimelineCollapsed = useWorkspaceStore((s) => s.setTimelineCollapsed);
  const setLeftWidth = useWorkspaceStore((s) => s.setLeftWidth);
  const setRightWidth = useWorkspaceStore((s) => s.setRightWidth);
  const setTimelineHeight = useWorkspaceStore((s) => s.setTimelineHeight);
  const toggleGrid = useWorkspaceStore((s) => s.toggleGrid);
  const toggleSafeGuides = useWorkspaceStore((s) => s.toggleSafeGuides);
  const resetViewport = useWorkspaceStore((s) => s.resetViewport);
  const closeContextMenu = useWorkspaceStore((s) => s.closeContextMenu);

  const [showProjectModal, setShowProjectModal] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [showRecovery, setShowRecovery] = useState(false);
  const exportModalRequest = useJobStore((s) => s.exportModalRequest);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showShortcutsModal, setShowShortcutsModal] = useState(false);

  const productionPreviewScope = useProductionStore((s) => s.previewScope);
  const closeTimelinePreview = useProductionStore((s) => s.closeTimelinePreview);
  const sceneExecutionScope = useProductionStore((s) => s.sceneExecutionScope);
  const closeSceneExecutionPreview = useProductionStore((s) => s.closeSceneExecutionPreview);
  const animExecModalScope = useAnimationExecStore((s) => s.execModalScope);
  const closeAnimationExecModal = useAnimationExecStore((s) => s.closeAnimationExecModal);

  // Bootstrap backend connection, library, projects, and WebSocket events
  useEffect(() => {
    let mounted = true;
    async function boot() {
      await apiClient.init();
      await refreshHealth();
      await Promise.all([refreshLibrary(), refreshVoice(), loadProjectList()]);
      if (!mounted) return;
      const list = useProjectStore.getState().projects;
      if (list.length > 0 && !useProjectStore.getState().project) {
        await openProject(list[0].project_id);
      } else if (list.length === 0) {
        setShowProjectModal(true);
      }
      await wsClient.connect();
      // Phase 09.3: offer crash-recovery data left by a previous session (never applied automatically)
      try {
        if ((await recoveryClient.list()).length > 0) setShowRecovery(true);
      } catch {
        // recovery storage unavailable — editing still works
      }
    }
    void boot();

    const unsub = wsClient.subscribe((ev) => {
      if (ev.type === 'job_updated') {
        const job = ev.payload as unknown as RenderJob;
        upsertJob(job);
        if (job.status === 'completed') {
          pushToast('success', job.message || tGlobal('app.exportCompleteToast'));
        } else if (job.status === 'failed') {
          pushToast(
            'error',
            tGlobal('app.exportFailedToast', { reason: job.error_log || job.message }),
          );
        }
      } else if (ev.type === 'job_progress') {
        updateJobProgress(
          String(ev.payload.job_id ?? ''),
          Number(ev.payload.progress_pct ?? 0),
          String(ev.payload.message ?? ''),
          {
            status: (ev.payload.status as RenderJob['status'] | undefined) ?? undefined,
            progress: (ev.payload.progress as RenderJob['progress']) ?? undefined,
          },
        );
      } else if (ev.type === 'project_state_changed') {
        // Phase 09.1: a backend service (or another window) wrote project sections. Pull and
        // merge them so the editor never works on — and later autosaves — a stale copy.
        const pid = String(ev.payload.project_id ?? '');
        const st = useProjectStore.getState();
        const revs = (ev.payload.revisions ?? {}) as Record<string, number>;
        const base = st.syncSnapshot?.revisions ?? {};
        const newer = Object.entries(revs).some(([sec, r]) => r > (base[sec] ?? -1));
        if (st.project?.meta.project_id === pid && newer && !st.isSaving) {
          void apiClient
            .getProject(pid)
            .then((fresh) => {
              const { keptLocal } = useProjectStore.getState().syncFromServer(fresh);
              if (keptLocal.length > 0) {
                pushToast('warning', tGlobal('app.syncKeptLocal', { sections: keptLocal.join(', ') }));
              }
            })
            .catch((err) => pushToast('error', err instanceof Error ? err.message : String(err)));
        }
      } else if (ev.type === 'job_removed') {
        useJobStore.getState().removeJobLocal(String(ev.payload.job_id ?? ''));
      } else if (ev.type === 'render_queue_state') {
        useJobStore.getState().setQueueState(ev.payload as unknown as RenderQueueState);
      } else if (ev.type === 'render_worker_status') {
        setPixiWorkerConnected(Boolean(ev.payload.connected));
      } else if (ev.type === 'connected') {
        setPixiWorkerConnected(Boolean(ev.payload.pixi_render_worker_connected));
      } else if (ev.type === 'director_progress') {
        useDirectorStore.getState().setProgress(ev.payload as unknown as AnalysisProgress);
      } else if (ev.type === 'storyboard_progress') {
        useStoryboardStore.getState().setProgress(ev.payload as unknown as StoryboardProgress);
      } else if (ev.type === 'production_progress') {
        useProductionStore.getState().setProgress(ev.payload as unknown as ProductionProgress);
      } else if (ev.type === 'production_queue_update') {
        const pid = String(ev.payload.project_id ?? '');
        const q = ev.payload.queue as unknown as ProductionQueueDocument | undefined;
        if (pid && q) {
          useProductionQueueStore.getState().applyQueueUpdate(pid, q);
        }
      }
    });

    const healthInterval = window.setInterval(() => {
      void refreshHealth();
    }, 15000);

    return () => {
      mounted = false;
      unsub();
      wsClient.disconnect();
      clearInterval(healthInterval);
    };
  }, []);

  useEffect(() => {
    if (project) {
      void refreshJobs(project.meta.project_id);
      void useJobStore.getState().refreshQueueState();
      void refreshProjectAudio(project.meta.project_id);
    } else {
      clearProjectAudio();
    }
  }, [project?.meta.project_id]);

  // Phase 09.1: project save/sync errors were stored but never shown (autosave swallowed them).
  const projectError = useProjectStore((s) => s.error);
  useEffect(() => {
    if (!projectError) return;
    pushToast('error', projectError);
    useProjectStore.setState({ error: null });
  }, [projectError]);

  // Debounced Auto-Save to SQLite
  useEffect(() => {
    if (!project || !isDirty || !project.meta.auto_save_enabled) return;
    const timer = window.setTimeout(() => {
      void saveProject(false).catch(() => {});
    }, 2200);
    return () => clearTimeout(timer);
  }, [project, isDirty]);

  // Phase 09.3: a failed autosave used to wait for the next edit; retry with backoff instead.
  const saveFailureCount = useProjectStore((s) => s.saveFailureCount);
  const saveError = useProjectStore((s) => s.saveError);
  const retryAttemptRef = useRef(0);
  useEffect(() => {
    if (!saveError) {
      retryAttemptRef.current = 0;
      return;
    }
    const st = useProjectStore.getState();
    if (!st.project || !st.isDirty || !st.project.meta.auto_save_enabled) return;
    const delay = Math.min(60_000, 5_000 * 2 ** retryAttemptRef.current);
    const timer = window.setTimeout(() => {
      retryAttemptRef.current += 1;
      void useProjectStore.getState().saveProject(false).catch(() => {});
    }, delay);
    return () => clearTimeout(timer);
  }, [saveFailureCount, saveError]);

  // Phase 09.3: changes that stay unsaved for a while are copied to crash-recovery storage.
  const dirtySinceRef = useRef<number | null>(null);
  useEffect(() => {
    dirtySinceRef.current = isDirty ? (dirtySinceRef.current ?? Date.now()) : null;
  }, [isDirty]);
  useEffect(() => {
    let lastJournal = 0;
    const iv = window.setInterval(() => {
      const st = useProjectStore.getState();
      const since = dirtySinceRef.current;
      if (!st.isDirty || since === null || st.isSaving) return;
      const now = Date.now();
      if (now - since >= 8_000 && now - lastJournal >= 15_000) {
        lastJournal = now;
        void st.writeRecoveryJournal(st.saveError ? 'save_failed' : 'unsaved');
      }
    }, 4_000);
    return () => clearInterval(iv);
  }, []);

  // Phase 09.3: save before the window closes (desktop) / keep recovery data (browser fallback).
  useEffect(() => {
    if (window.electronAPI?.onCloseRequested) {
      return window.electronAPI.onCloseRequested(async () => {
        const st = useProjectStore.getState();
        const dirty = Boolean(st.project) && st.isDirty;
        if (dirty && st.project && !st.project.meta.auto_save_enabled) {
          if (!window.confirm(tGlobal('app.closeSavePrompt', { name: st.project.meta.name }))) {
            if (window.confirm(tGlobal('app.closeDiscardPrompt'))) {
              await st.writeRecoveryJournal('closed_without_saving');
              return { ok: true };
            }
            return { ok: false, cancelled: true } as { ok: boolean; error?: string };
          }
        }
        return st.flushBeforeClose();
      });
    }
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const st = useProjectStore.getState();
      if (!st.project || !st.isDirty) return;
      const payload = buildRecoveryPayload(st.project, st.syncSnapshot, 'page_unload');
      if (payload) recoveryClient.writeSyncFallback(payload);
      e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  // NLE Studio Keyboard Shortcuts (strictly guarded against interfering with text inputs!)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inInput = Boolean(
        target &&
          (target.tagName === 'INPUT' ||
            target.tagName === 'TEXTAREA' ||
            target.tagName === 'SELECT' ||
            target.isContentEditable),
      );

      // Save works everywhere
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (project) {
          void saveProject(true).then(() => pushToast('success', tGlobal('app.savedToast')));
        }
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault();
        setTimelineCollapsed(!useWorkspaceStore.getState().timelineCollapsed);
        return;
      }

      // All remaining shortcuts must NOT fire when typing in an input
      if (inInput) return;

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }

      // Copy / Paste / Duplicate / Select All Keyframes
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c' && selectedKeyframeIds.length > 0 && project) {
        e.preventDefault();
        const count = copySelectedKeyframes(selectedKeyframeIds);
        if (count > 0) {
          pushToast('info', tGlobal('timeline.kfCopiedCountToast', { count }));
        }
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v' && copiedKeyframes.length > 0 && project) {
        e.preventDefault();
        const pasteMs = Math.round(frameToMs(usePlaybackStore.getState().currentFrame, project.timeline.fps));
        const res = pasteKeyframesAtTime(pasteMs);
        if (res.pastedIds.length > 0) {
          pushToast(
            'info',
            tGlobal('timeline.kfPastedCountToast', {
              count: res.pastedIds.length,
              time: formatTimecode(pasteMs),
            }),
          );
        }
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd' && selectedKeyframeIds.length > 0 && project) {
        e.preventDefault();
        const res = duplicateKeyframes(selectedKeyframeIds, 10);
        if (res.createdIds.length > 0) {
          pushToast('info', tGlobal('timeline.kfDuplicatedToast', { count: res.createdIds.length }));
        }
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a' && centerMode === 'stage' && project) {
        e.preventDefault();
        const lockedTrackIds = new Set(
          project.timeline.tracks.filter((tr) => tr.locked).map((tr) => tr.track_id),
        );
        const activeTargetId =
          selection.type === 'character' || selection.type === 'prop'
            ? selection.id
            : selection.type === 'camera'
              ? 'camera'
              : null;
        const matching = project.timeline.keyframes.filter((kf) => {
          if (lockedTrackIds.has(kf.track_id)) return false;
          if (!activeTargetId) return true;
          if (activeTargetId === 'camera') return kf.target_type === 'camera';
          return kf.target_id === activeTargetId || kf.target_id.startsWith(`${activeTargetId}:`);
        });
        const ids = matching.map((k) => k.keyframe_id);
        setSelectedKeyframeIds(ids, ids[0] ?? null);
        return;
      }

      if (e.key === 'Escape' && selectedKeyframeIds.length > 0) {
        clearKeyframeSelection();
        return;
      }

      const fps = project?.timeline.fps ?? 30;
      const maxFrame = project
        ? Math.max(0, msToFrame(project.timeline.total_duration_ms, fps) - 1)
        : 0;

      // Alt+Arrow nudges selected keyframes cleanly by ±1 (or Shift+Alt = ±10) frames
      if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && selectedKeyframeIds.length > 0 && project) {
        e.preventDefault();
        const step = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowLeft' ? -1 : 1);
        const res = moveKeyframesByDeltaFrames(selectedKeyframeIds, step, true);
        if (res.replacedCount > 0) {
          pushToast('info', tGlobal('timeline.kfCollisionReplacedToast', { count: res.replacedCount }));
        }
        return;
      }

      // Transform tool shortcuts (when no modifier key is pressed)
      if (!e.metaKey && !e.ctrlKey && !e.altKey && centerMode === 'stage') {
        const lower = e.key.toLowerCase();
        if (lower === 'v') {
          setActiveTool('select');
          return;
        }
        if (lower === 'w') {
          setActiveTool('move');
          return;
        }
        if (lower === 'r') {
          setActiveTool('rotate');
          return;
        }
        if (lower === 's') {
          setActiveTool('scale');
          return;
        }
        if (lower === 'p') {
          setActiveTool('pivot');
          return;
        }
      }

      if (e.code === 'Space' && centerMode === 'stage') {
        e.preventDefault();
        setPlaying(!isPlaying);
        return;
      }
      if (e.key.toLowerCase() === 'k' && centerMode === 'stage') {
        setPlaying(false);
        return;
      }
      if (e.key.toLowerCase() === 'l' && centerMode === 'stage') {
        setPlaying(true);
        return;
      }
      if (e.key.toLowerCase() === 'j' && centerMode === 'stage') {
        stepFrames(-5, maxFrame);
        return;
      }
      if (e.key === 'ArrowLeft' && centerMode === 'stage') {
        e.preventDefault();
        stepFrames(e.shiftKey ? -10 : -1, maxFrame);
        return;
      }
      if (e.key === 'ArrowRight' && centerMode === 'stage') {
        e.preventDefault();
        stepFrames(e.shiftKey ? 10 : 1, maxFrame);
        return;
      }
      if (e.key === 'Home') {
        setPlaying(false);
        setCurrentFrame(0);
        return;
      }
      if (e.key === 'End') {
        setPlaying(false);
        setCurrentFrame(maxFrame);
        return;
      }
      if (e.key.toLowerCase() === 'g' && centerMode === 'stage') {
        toggleGrid();
        return;
      }
      if (e.key === "'" && centerMode === 'stage') {
        toggleSafeGuides();
        return;
      }
      if (e.key === '0' && centerMode === 'stage') {
        resetViewport();
        return;
      }
      if (e.key === '[') {
        setLeftCollapsed(!useWorkspaceStore.getState().leftCollapsed);
        return;
      }
      if (e.key === ']') {
        setRightCollapsed(!useWorkspaceStore.getState().rightCollapsed);
        return;
      }
      if (e.key === '?') {
        setShowShortcutsModal((v) => !v);
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedKeyframeIds.length > 0) {
          e.preventDefault();
          deleteKeyframes(selectedKeyframeIds);
          return;
        }
        if (selection.type === 'sfx_event') {
          const ids = selection.multiIds ?? (selection.id ? [selection.id] : []);
          for (const id of ids) {
            deleteSoundEvent(id);
          }
          return;
        }
        if (selection.type === 'subtitle' && selectedSubtitleIds.length > 0) {
          e.preventDefault();
          deleteSubtitleSegments(selectedSubtitleIds);
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    isPlaying,
    centerMode,
    project,
    selection,
    selectedKeyframeIds,
    selectedSubtitleIds,
    copiedKeyframes,
    saveProject,
    undo,
    redo,
  ]);

  const startResize = (
    axis: 'left' | 'right' | 'bottom',
    e: React.PointerEvent<HTMLDivElement>,
  ) => {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const origLeft = leftWidth;
    const origRight = rightWidth;
    const origBottom = timelineHeight;

    const onMove = (me: PointerEvent) => {
      if (axis === 'left') {
        setLeftWidth(origLeft + (me.clientX - startX));
      } else if (axis === 'right') {
        setRightWidth(origRight - (me.clientX - startX));
      } else {
        setTimelineHeight(origBottom - (me.clientY - startY));
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const selectionLabel =
    selection.type !== 'none' ? t(`app.selectionType.${selection.type}`) : null;

  const selectedScriptCharacterId = useMemo(() => {
    if (!project?.script || !selectedScriptEntryId) return null;
    const sc = findScriptSceneById(project.script, activeScriptSceneId);
    const entry = sc?.entries.find((e) => e.entry_id === selectedScriptEntryId);
    return entry?.character_id ?? null;
  }, [project?.script, activeScriptSceneId, selectedScriptEntryId]);

  return (
    <div className="studio-shell">
      {/* A. TOP TOOLBAR */}
      <TopToolbar
        onOpenProjects={() => setShowProjectModal(true)}
        onOpenSettings={() => setShowSettingsModal(true)}
        onOpenExport={() => setShowExportModal(true)}
        onOpenShortcuts={() => setShowShortcutsModal(true)}
      />

      {/* MIDDLE WORKSPACE ROW */}
      <div className="workspace-middle">
        {/* B. LEFT NAVIGATION RAIL */}
        <LeftNavRail />

        {/* LEFT RESOURCE / MODULE PANEL */}
        {!leftCollapsed && (
          <>
            <aside className="sidebar-panel" style={{ width: leftWidth }} aria-label={t(SIDEBAR_TITLE_KEYS[sidebarTab])}>
              <div className="panel-header">
                <span className="panel-header-title">{t(SIDEBAR_TITLE_KEYS[sidebarTab])}</span>
                <button
                  className="btn-ghost btn-icon btn-xs"
                  title={t('panel.collapseLeft')}
                  aria-label={t('panel.collapseLeft')}
                  onClick={() => setLeftCollapsed(true)}
                >
                  <PanelLeftClose size={13} />
                </button>
              </div>
              <div className="panel-body">
                {sidebarTab === 'project' && (
                  <ProjectOverviewPanel onOpenProjectManager={() => setShowProjectModal(true)} />
                )}
                {sidebarTab === 'scenes' && <ScenesPanel />}
                {sidebarTab === 'characters' && (
                  <CharactersPanel onEditCharacter={(charId) => openRigEditor(charId)} />
                )}
                {sidebarTab === 'assets' && <AssetsPanel />}
                {sidebarTab === 'animation' && <AnimationPanel />}
                {sidebarTab === 'sounds' && <SoundEffectsPanel />}
                {sidebarTab === 'subtitles' && <SubtitlesPanel />}
                {sidebarTab === 'render_queue' && (
                  <RenderQueuePanel onOpenExport={() => setShowExportModal(true)} />
                )}
                {sidebarTab === 'script' && <ScriptScenesPanel />}
                {sidebarTab === 'director' && (
                  <DirectorSidebarPanel onOpenSettings={() => setShowSettingsModal(true)} />
                )}
                {sidebarTab === 'storyboard' && (
                  <StoryboardSidebarPanel onOpenSettings={() => setShowSettingsModal(true)} />
                )}
                {sidebarTab === 'production' && (
                  <ProductionSidebarPanel onOpenSettings={() => setShowSettingsModal(true)} />
                )}
                {sidebarTab === 'production_queue' && <ProductionQueueSidebarPanel />}
                {sidebarTab === 'voice' && <VoicePanel />}
              </div>
            </aside>
            <div className="resizer-v" onPointerDown={(e) => startResize('left', e)} />
          </>
        )}

        {/* C. CENTER WORKSPACE — PREVIEW CANVAS, CUTOUT RIG EDITOR & SCRIPT EDITOR */}
        <main className="center-stage-wrap">
          <div className="center-tabs">
            <div className="toolbar-group">
              <button
                className={`tab-btn ${centerMode === 'stage' ? 'active' : ''}`}
                onClick={() => setCenterMode('stage')}
              >
                <Layers size={12} /> {t('stage.tabPreview')}
              </button>
              <button
                className={`tab-btn ${centerMode === 'rig' ? 'active' : ''}`}
                onClick={() => setCenterMode('rig')}
              >
                <Users size={12} /> {t('stage.tabRigEditor')}
              </button>
              <button
                className={`tab-btn ${centerMode === 'script' ? 'active' : ''}`}
                onClick={() => setCenterMode('script')}
              >
                <FileText size={12} /> {t('stage.tabScriptEditor')}
              </button>
              <button
                className={`tab-btn ${centerMode === 'subtitles' ? 'active' : ''}`}
                onClick={() => setCenterMode('subtitles')}
                data-testid="tab-subtitle-studio"
              >
                <Captions size={12} /> {t('stage.tabSubtitleStudio')}
              </button>
              <button
                className={`tab-btn ${centerMode === 'director' ? 'active' : ''}`}
                onClick={() => {
                  setCenterMode('director');
                  const ws = useWorkspaceStore.getState();
                  if (ws.sidebarTab !== 'director' || ws.leftCollapsed) {
                    ws.setSidebarTab('director');
                  }
                }}
                data-testid="tab-ai-director"
              >
                <Brain size={12} /> {t('stage.tabAiDirector')}
              </button>
              <button
                className={`tab-btn ${centerMode === 'storyboard' ? 'active' : ''}`}
                onClick={() => {
                  setCenterMode('storyboard');
                  const ws = useWorkspaceStore.getState();
                  if (ws.sidebarTab !== 'storyboard' || ws.leftCollapsed) {
                    ws.setSidebarTab('storyboard');
                  }
                }}
                data-testid="tab-ai-storyboard"
              >
                <LayoutGrid size={12} /> {t('stage.tabStoryboard')}
              </button>
              <button
                className={`tab-btn ${centerMode === 'production' ? 'active' : ''}`}
                onClick={() => {
                  setCenterMode('production');
                  const ws = useWorkspaceStore.getState();
                  if (ws.sidebarTab !== 'production' || ws.leftCollapsed) {
                    ws.setSidebarTab('production');
                  }
                }}
                data-testid="tab-ai-production"
              >
                <ClipboardCheck size={12} /> {t('stage.tabProduction')}
              </button>
              <button
                className={`tab-btn ${centerMode === 'production_queue' ? 'active' : ''}`}
                onClick={() => {
                  setCenterMode('production_queue');
                  const ws = useWorkspaceStore.getState();
                  if (ws.sidebarTab !== 'production_queue' || ws.leftCollapsed) {
                    ws.setSidebarTab('production_queue');
                  }
                }}
                data-testid="tab-production-queue"
              >
                <ListChecks size={12} /> {t('stage.tabProductionQueue')}
              </button>
            </div>
            <span className="center-stage-hint">
              {centerMode === 'stage'
                ? t('stage.hintStage')
                : centerMode === 'rig'
                  ? t('stage.hintRig')
                  : centerMode === 'subtitles'
                    ? t('stage.hintSubtitles')
                    : centerMode === 'director'
                      ? t('stage.hintDirector')
                      : centerMode === 'storyboard'
                        ? t('stage.hintStoryboard')
                        : centerMode === 'production'
                          ? t('stage.hintProduction')
                          : centerMode === 'production_queue'
                            ? t('stage.hintProductionQueue')
                            : t('stage.hintScript')}
            </span>
          </div>

          {centerMode === 'stage' ? (
            <PreviewCanvas onOpenProjects={() => setShowProjectModal(true)} />
          ) : centerMode === 'rig' ? (
            <CharacterRigEditor
              characterId={editingCharacterId}
              onSelectCharacter={(id) => openRigEditor(id)}
              onClose={() => setCenterMode('stage')}
            />
          ) : centerMode === 'subtitles' ? (
            <SubtitleStudioWorkspace onOpenProjects={() => setShowProjectModal(true)} />
          ) : centerMode === 'director' ? (
            <DirectorWorkspace onOpenSettings={() => setShowSettingsModal(true)} />
          ) : centerMode === 'storyboard' ? (
            <StoryboardWorkspace onOpenSettings={() => setShowSettingsModal(true)} />
          ) : centerMode === 'production' ? (
            <ProductionWorkspace onOpenSettings={() => setShowSettingsModal(true)} />
          ) : centerMode === 'production_queue' ? (
            <ProductionQueueWorkspace />
          ) : (
            <ScriptEditorWorkspace />
          )}
        </main>

        {/* D. RIGHT SIDEBAR — CONTEXTUAL INSPECTOR OR VOICE ASSIGNMENT */}
        {!rightCollapsed &&
          centerMode !== 'rig' &&
          centerMode !== 'subtitles' &&
          centerMode !== 'director' &&
          centerMode !== 'storyboard' &&
          centerMode !== 'production' &&
          centerMode !== 'production_queue' && (
          <>
            <div className="resizer-v" onPointerDown={(e) => startResize('right', e)} />
            <aside
              className="inspector-panel"
              style={{ width: rightWidth }}
              aria-label={centerMode === 'script' ? t('voice.panelTitle') : t('panel.inspector')}
            >
              <div className="panel-header">
                <span className="panel-header-title">
                  {centerMode === 'script'
                    ? t('voice.panelTitle')
                    : `${t('panel.inspector')}${selectionLabel ? ` — ${selectionLabel}` : ''}`}
                </span>
                <button
                  className="btn-ghost btn-icon btn-xs"
                  title={t('panel.collapseRight')}
                  aria-label={t('panel.collapseRight')}
                  onClick={() => setRightCollapsed(true)}
                >
                  <PanelRightClose size={13} />
                </button>
              </div>
              {centerMode === 'script' ? (
                <div className="panel-body">
                  <VoicePanel preselectedCharacterId={selectedScriptCharacterId} />
                </div>
              ) : (
                <RightInspector />
              )}
            </aside>
          </>
        )}
      </div>

      {/* E. BOTTOM MASTER TIMELINE */}
      {!timelineCollapsed && (
        <div className="resizer-h" onPointerDown={(e) => startResize('bottom', e)} />
      )}
      <section
        className="timeline-dock"
        style={{ height: timelineCollapsed ? 32 : timelineHeight }}
        aria-label={t('timeline.title')}
      >
        <MasterTimeline />
      </section>

      {/* F. STATUS BAR */}
      <StatusBar />

      {/* Modals, Context Menus & Notifications */}
      {showProjectModal && <ProjectManagerModal onClose={() => setShowProjectModal(false)} />}
      {showRecovery && <RecoveryDialog onClose={() => setShowRecovery(false)} />}
      {(showExportModal || exportModalRequest) && (
        <ExportModal
          initialSettings={exportModalRequest?.settings ?? null}
          onClose={() => {
            setShowExportModal(false);
            useJobStore.getState().clearExportModalRequest();
          }}
        />
      )}
      {showSettingsModal && <SettingsModal onClose={() => setShowSettingsModal(false)} />}
      {showShortcutsModal && <ShortcutsModal onClose={() => setShowShortcutsModal(false)} />}
      {productionPreviewScope && (
        <TimelineApplyPreviewModal
          initialScope={productionPreviewScope}
          onClose={closeTimelinePreview}
        />
      )}
      {sceneExecutionScope && (
        <SceneExecutionPreviewModal
          initialScope={sceneExecutionScope}
          onClose={closeSceneExecutionPreview}
        />
      )}
      {animExecModalScope && (
        <AnimationExecutionModal
          scope={animExecModalScope}
          onClose={closeAnimationExecModal}
        />
      )}
      <JobQueueDrawer />
      <ContextMenuOverlay menu={contextMenu} onClose={closeContextMenu} />
      <ToastStack />
    </div>
  );
}
