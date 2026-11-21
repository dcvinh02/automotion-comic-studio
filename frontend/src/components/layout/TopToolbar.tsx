import {
  Brain,
  CheckCircle2,
  CircleDot,
  ClipboardCheck,
  Download,
  FileText,
  Film,
  FolderOpen,
  Globe,
  Image as ImageIcon,
  Keyboard,
  LayoutGrid,
  Loader2,
  Redo2,
  Save,
  Settings,
  Sliders,
  Undo2,
  Volume2,
} from 'lucide-react';
import { useI18n, type TranslationKey } from '@/i18n/useLocaleStore';
import { useJobStore } from '@/stores/useJobStore';
import { useProjectStore } from '@/stores/useProjectStore';
import { useWorkspaceStore, type WorkspaceId } from '@/stores/useWorkspaceStore';
import { BrandLogo } from '@/components/ui/BrandLogo';

const WORKSPACES: Array<{
  id: WorkspaceId;
  labelKey: TranslationKey;
  titleKey: TranslationKey;
  icon: typeof Sliders;
  badge?: string;
}> = [
  { id: 'animation', labelKey: 'workspace.animation', titleKey: 'workspace.animationTitle', icon: Sliders },
  { id: 'scene', labelKey: 'workspace.scene', titleKey: 'workspace.sceneTitle', icon: Film },
  { id: 'audio', labelKey: 'workspace.audio', titleKey: 'workspace.audioTitle', icon: Volume2 },
  { id: 'assets', labelKey: 'workspace.assets', titleKey: 'workspace.assetsTitle', icon: ImageIcon },
  { id: 'script', labelKey: 'workspace.script', titleKey: 'workspace.scriptTitle', icon: FileText },
  { id: 'director', labelKey: 'workspace.director', titleKey: 'workspace.directorTitle', icon: Brain },
  { id: 'storyboard', labelKey: 'workspace.storyboard', titleKey: 'workspace.storyboardTitle', icon: LayoutGrid },
  { id: 'production', labelKey: 'workspace.production', titleKey: 'workspace.productionTitle', icon: ClipboardCheck },
];

export function TopToolbar({
  onOpenProjects,
  onOpenSettings,
  onOpenExport,
  onOpenShortcuts,
}: {
  onOpenProjects: () => void;
  onOpenSettings: () => void;
  onOpenExport: () => void;
  onOpenShortcuts: () => void;
}) {
  const { locale, toggleLocale, t } = useI18n();
  const project = useProjectStore((s) => s.project);
  const isDirty = useProjectStore((s) => s.isDirty);
  const isSaving = useProjectStore((s) => s.isSaving);
  const lastSavedAt = useProjectStore((s) => s.lastSavedAt);
  const undoLen = useProjectStore((s) => s.undoStack.length);
  const redoLen = useProjectStore((s) => s.redoStack.length);
  const saveProject = useProjectStore((s) => s.saveProject);
  const undo = useProjectStore((s) => s.undo);
  const redo = useProjectStore((s) => s.redo);

  const workspace = useWorkspaceStore((s) => s.workspace);
  const switchWorkspace = useWorkspaceStore((s) => s.switchWorkspace);
  const pushToast = useJobStore((s) => s.pushToast);

  return (
    <header className="top-toolbar" role="banner">
      {/* Left: Brand, Project Switcher, Truthful Save State, Undo/Redo */}
      <div className="toolbar-group">
        <div className="brand-mark">
          <BrandLogo size={20} />
          <span className="brand-name-text">{t('app.name')}</span>
          <span className="brand-subtitle">{t('app.version')}</span>
        </div>

        <span className="toolbar-divider" />

        <button
          onClick={onOpenProjects}
          className="project-pill"
          title={t('topbar.openProjectManager')}
          aria-label={t('topbar.openProjectManager')}
        >
          <FolderOpen size={13} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {project ? project.meta.name : t('topbar.openOrNewProject')}
          </span>
        </button>

        {project ? (
          <span
            className={`save-status-pill ${isDirty ? 'dirty' : isSaving ? '' : 'saved'}`}
            title={
              isSaving
                ? t('topbar.saveStatusSaving')
                : isDirty
                  ? t('topbar.saveStatusDirty')
                  : lastSavedAt
                    ? t('topbar.saveStatusSaved', {
                        time: new Date(lastSavedAt).toLocaleTimeString(),
                      })
                    : t('topbar.saveStatusNotPersisted')
            }
          >
            {isSaving ? (
              <>
                <Loader2 size={11} className="spin" />
                <span>{t('common.saving')}</span>
              </>
            ) : isDirty ? (
              <>
                <CircleDot size={11} />
                <span>{t('common.unsaved')}</span>
              </>
            ) : (
              <>
                <CheckCircle2 size={11} />
                <span>{t('common.saved')}</span>
                {lastSavedAt && (
                  <span className="save-status-timestamp mono" style={{ opacity: 0.75, fontSize: 10 }}>
                    {new Date(lastSavedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                )}
              </>
            )}
          </span>
        ) : (
          <span className="save-status-pill">{t('common.noProject')}</span>
        )}

        <button
          className="btn-icon"
          disabled={!project || isSaving}
          onClick={() =>
            void saveProject(true).then(() =>
              pushToast('success', t('topbar.saveStatusSaved', { time: new Date().toLocaleTimeString() })),
            )
          }
          title={t('topbar.saveProjectTitle')}
          aria-label={t('common.save')}
        >
          <Save size={13} />
        </button>

        <span className="toolbar-divider" />

        <button
          className="btn-icon"
          disabled={undoLen === 0}
          onClick={undo}
          title={t('topbar.undoSteps', { count: undoLen })}
          aria-label={t('topbar.undo')}
        >
          <Undo2 size={13} />
        </button>
        <button
          className="btn-icon"
          disabled={redoLen === 0}
          onClick={redo}
          title={t('topbar.redoSteps', { count: redoLen })}
          aria-label={t('topbar.redo')}
        >
          <Redo2 size={13} />
        </button>
      </div>

      {/* Center: Modular Workspace Switcher */}
      <nav className="workspace-switcher" aria-label="Workspaces">
        {WORKSPACES.map((ws) => {
          const Icon = ws.icon;
          const isActive = workspace === ws.id;
          return (
            <button
              key={ws.id}
              type="button"
              className={`workspace-pill ${isActive ? 'active' : ''}`}
              title={t(ws.titleKey)}
              aria-pressed={isActive}
              onClick={() => switchWorkspace(ws.id)}
            >
              <Icon size={12} />
              <span>{t(ws.labelKey)}</span>
              {ws.badge && (
                <span className="rail-badge-ver" style={{ position: 'static' }}>
                  {ws.badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Right: Language Quick Switch, Shortcuts, Settings, Export MP4 */}
      <div className="toolbar-group">
        <button
          className="btn-xs mono"
          onClick={toggleLocale}
          title={t('topbar.switchLanguageTitle')}
          aria-label={t('topbar.switchLanguageTitle')}
          style={{ fontWeight: 600 }}
        >
          <Globe size={11} />
          {locale.toUpperCase()}
        </button>
        <button
          className="btn-icon"
          onClick={onOpenShortcuts}
          title={t('topbar.shortcuts')}
          aria-label={t('topbar.shortcuts')}
        >
          <Keyboard size={13} />
        </button>
        <button
          className="btn-icon"
          onClick={onOpenSettings}
          title={t('topbar.settings')}
          aria-label={t('topbar.settings')}
        >
          <Settings size={13} />
        </button>
        <button
          className="btn-primary"
          disabled={!project}
          onClick={onOpenExport}
          title={t('topbar.exportMp4Title')}
        >
          <Download size={13} />
          <span>{t('topbar.exportMp4')}</span>
        </button>
      </div>
    </header>
  );
}
