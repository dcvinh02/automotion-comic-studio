import { create } from 'zustand';
import type { ContextMenuState } from '@/components/ui/ContextMenu';

export type WorkspaceId =
  | 'animation'
  | 'scene'
  | 'audio'
  | 'assets'
  | 'script'
  | 'director'
  | 'storyboard'
  | 'production'
  | 'production_queue';

export type SidebarTabId =
  | 'project'
  | 'scenes'
  | 'characters'
  | 'assets'
  | 'animation'
  | 'sounds'
  | 'subtitles'
  | 'render_queue'
  | 'script'
  | 'director'
  | 'storyboard'
  | 'production'
  | 'production_queue'
  | 'voice';

export type CenterModeId =
  | 'stage'
  | 'rig'
  | 'script'
  | 'subtitles'
  | 'director'
  | 'storyboard'
  | 'production'
  | 'production_queue';
export type PreviewResolution = 'full' | 'half' | 'quarter';
export type StudioTheme = 'dark-studio' | 'slate-contrast';
export type TransformToolId = 'select' | 'move' | 'rotate' | 'scale' | 'pivot';

interface WorkspaceStore {
  workspace: WorkspaceId;
  sidebarTab: SidebarTabId;
  centerMode: CenterModeId;
  editingCharacterId: string | null;

  railExpanded: boolean;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  timelineCollapsed: boolean;

  leftWidth: number;
  rightWidth: number;
  timelineHeight: number;

  // Viewport (Canvas navigation — independent of Scene Camera!)
  viewportZoom: 'fit' | number;
  viewportPanX: number;
  viewportPanY: number;
  showGrid: boolean;
  showSafeGuides: boolean;
  showGizmos: boolean;
  previewResolution: PreviewResolution;
  activeTool: TransformToolId;

  theme: StudioTheme;
  contextMenu: ContextMenuState | null;

  switchWorkspace: (ws: WorkspaceId) => void;
  setSidebarTab: (tab: SidebarTabId) => void;
  setCenterMode: (mode: CenterModeId) => void;
  openRigEditor: (characterId: string) => void;

  toggleRailExpanded: () => void;
  setLeftCollapsed: (v: boolean) => void;
  setRightCollapsed: (v: boolean) => void;
  setTimelineCollapsed: (v: boolean) => void;

  setLeftWidth: (w: number) => void;
  setRightWidth: (w: number) => void;
  setTimelineHeight: (h: number) => void;

  setViewportZoom: (z: 'fit' | number) => void;
  zoomViewportBy: (delta: number) => void;
  setViewportPan: (x: number, y: number) => void;
  resetViewport: () => void;
  toggleGrid: () => void;
  toggleSafeGuides: () => void;
  toggleGizmos: () => void;
  setPreviewResolution: (res: PreviewResolution) => void;
  setActiveTool: (tool: TransformToolId) => void;

  setTheme: (theme: StudioTheme) => void;
  openContextMenu: (menu: ContextMenuState) => void;
  closeContextMenu: () => void;
}

export const useWorkspaceStore = create<WorkspaceStore>((set) => ({
  workspace: 'animation',
  sidebarTab: 'scenes',
  centerMode: 'stage',
  editingCharacterId: null,

  railExpanded: false,
  leftCollapsed: false,
  rightCollapsed: false,
  timelineCollapsed: false,

  leftWidth: 300,
  rightWidth: 300,
  timelineHeight: 248,

  viewportZoom: 'fit',
  viewportPanX: 0,
  viewportPanY: 0,
  showGrid: false,
  showSafeGuides: true,
  showGizmos: true,
  previewResolution: 'full',
  activeTool: 'select',

  theme: 'dark-studio',
  contextMenu: null,

  switchWorkspace: (ws) =>
    set((s) => {
      switch (ws) {
        case 'animation':
          return {
            workspace: ws,
            sidebarTab: s.sidebarTab === 'characters' || s.sidebarTab === 'animation' ? s.sidebarTab : 'characters',
            centerMode: 'stage',
            leftCollapsed: false,
            rightCollapsed: false,
            timelineCollapsed: false,
            timelineHeight: Math.max(240, s.timelineHeight),
            leftWidth: 295,
          };
        case 'scene':
          return {
            workspace: ws,
            sidebarTab: 'scenes',
            centerMode: 'stage',
            leftCollapsed: false,
            rightCollapsed: false,
            timelineCollapsed: false,
            showSafeGuides: true,
            leftWidth: 305,
            timelineHeight: 215,
          };
        case 'audio':
          return {
            workspace: ws,
            sidebarTab: 'sounds',
            centerMode: 'stage',
            leftCollapsed: false,
            rightCollapsed: false,
            timelineCollapsed: false,
            leftWidth: 330,
            timelineHeight: 310,
          };
        case 'assets':
          return {
            workspace: ws,
            sidebarTab: 'assets',
            centerMode: 'stage',
            leftCollapsed: false,
            rightCollapsed: false,
            leftWidth: 420,
            timelineCollapsed: true,
          };
        case 'script':
          return {
            workspace: ws,
            sidebarTab: 'script',
            centerMode: 'script',
            leftCollapsed: false,
            rightCollapsed: false,
            leftWidth: 300,
          };
        case 'director':
          return {
            workspace: ws,
            sidebarTab: 'director',
            centerMode: 'director',
            leftCollapsed: false,
            rightCollapsed: true,
            timelineCollapsed: true,
            leftWidth: 330,
          };
        case 'storyboard':
          return {
            workspace: ws,
            sidebarTab: 'storyboard',
            centerMode: 'storyboard',
            leftCollapsed: false,
            rightCollapsed: true,
            timelineCollapsed: true,
            leftWidth: 300,
          };
        case 'production':
          return {
            workspace: ws,
            sidebarTab: 'production',
            centerMode: 'production',
            leftCollapsed: false,
            rightCollapsed: true,
            timelineCollapsed: true,
            leftWidth: 310,
          };
        case 'production_queue':
          return {
            workspace: ws,
            sidebarTab: 'production_queue',
            centerMode: 'production_queue',
            leftCollapsed: false,
            rightCollapsed: true,
            timelineCollapsed: true,
            leftWidth: 300,
          };
        default:
          return { workspace: ws };
      }
    }),

  setSidebarTab: (tab) =>
    set((s) => {
      if (s.sidebarTab === tab && !s.leftCollapsed) {
        return { leftCollapsed: true };
      }
      return {
        sidebarTab: tab,
        leftCollapsed: false,
        workspace:
          tab === 'director'
            ? 'director'
            : tab === 'storyboard'
              ? 'storyboard'
              : tab === 'production'
                ? 'production'
                : tab === 'production_queue'
                  ? 'production_queue'
                  : s.workspace === 'director' ||
                      s.workspace === 'storyboard' ||
                      s.workspace === 'production' ||
                      s.workspace === 'production_queue'
                    ? 'animation'
                    : s.workspace,
        centerMode:
          tab === 'script'
            ? 'script'
            : tab === 'subtitles'
              ? 'subtitles'
              : tab === 'director'
                ? 'director'
                : tab === 'storyboard'
                  ? 'storyboard'
                  : tab === 'production'
                    ? 'production'
                    : tab === 'production_queue'
                      ? 'production_queue'
                      : (s.centerMode === 'script' ||
                            s.centerMode === 'subtitles' ||
                            s.centerMode === 'director' ||
                            s.centerMode === 'storyboard' ||
                            s.centerMode === 'production' ||
                            s.centerMode === 'production_queue') &&
                          tab !== 'voice'
                        ? 'stage'
                        : s.centerMode,
      };
    }),

  setCenterMode: (centerMode) => set({ centerMode }),
  openRigEditor: (characterId) =>
    set({ editingCharacterId: characterId, centerMode: 'rig' }),

  toggleRailExpanded: () => set((s) => ({ railExpanded: !s.railExpanded })),
  setLeftCollapsed: (leftCollapsed) => set({ leftCollapsed }),
  setRightCollapsed: (rightCollapsed) => set({ rightCollapsed }),
  setTimelineCollapsed: (timelineCollapsed) => set({ timelineCollapsed }),

  setLeftWidth: (w) => set({ leftWidth: Math.max(220, Math.min(520, w)) }),
  setRightWidth: (w) => set({ rightWidth: Math.max(240, Math.min(460, w)) }),
  setTimelineHeight: (h) => set({ timelineHeight: Math.max(150, Math.min(500, h)) }),

  setViewportZoom: (viewportZoom) => set({ viewportZoom }),
  zoomViewportBy: (delta) =>
    set((s) => {
      const current = s.viewportZoom === 'fit' ? 1.0 : s.viewportZoom;
      const next = Math.max(0.25, Math.min(3.0, Math.round((current + delta) * 100) / 100));
      return { viewportZoom: next };
    }),
  setViewportPan: (viewportPanX, viewportPanY) => set({ viewportPanX, viewportPanY }),
  resetViewport: () => set({ viewportZoom: 'fit', viewportPanX: 0, viewportPanY: 0 }),
  toggleGrid: () => set((s) => ({ showGrid: !s.showGrid })),
  toggleSafeGuides: () => set((s) => ({ showSafeGuides: !s.showSafeGuides })),
  toggleGizmos: () => set((s) => ({ showGizmos: !s.showGizmos })),
  setPreviewResolution: (previewResolution) => set({ previewResolution }),
  setActiveTool: (activeTool) => set({ activeTool }),

  setTheme: (theme) => {
    document.documentElement.setAttribute('data-theme', theme);
    set({ theme });
  },

  openContextMenu: (contextMenu) => set({ contextMenu }),
  closeContextMenu: () => set({ contextMenu: null }),
}));
