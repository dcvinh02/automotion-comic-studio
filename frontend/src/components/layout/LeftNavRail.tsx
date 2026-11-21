import {
  Activity,
  Brain,
  Captions,
  ClipboardCheck,
  FileText,
  Film,
  FolderKanban,
  Image as ImageIcon,
  LayoutGrid,
  ListChecks,
  Mic,
  PanelLeftClose,
  PanelLeftOpen,
  Sparkles,
  Users,
  Volume2,
} from 'lucide-react';
import { useI18n, type TranslationKey } from '@/i18n/useLocaleStore';
import { useWorkspaceStore, type SidebarTabId } from '@/stores/useWorkspaceStore';

interface NavEntry {
  id: SidebarTabId;
  labelKey: TranslationKey;
  tipKey: TranslationKey;
  icon: typeof Film;
  roadmapVersion?: string;
}

const CORE_MODULES: NavEntry[] = [
  { id: 'project', labelKey: 'nav.project', tipKey: 'nav.projectTip', icon: FolderKanban },
  { id: 'scenes', labelKey: 'nav.scenes', tipKey: 'nav.scenesTip', icon: Film },
  { id: 'script', labelKey: 'nav.script', tipKey: 'nav.scriptTip', icon: FileText },
  { id: 'director', labelKey: 'nav.director', tipKey: 'nav.directorTip', icon: Brain },
  { id: 'storyboard', labelKey: 'nav.storyboard', tipKey: 'nav.storyboardTip', icon: LayoutGrid },
  { id: 'production', labelKey: 'nav.productionPlan', tipKey: 'nav.productionPlanTip', icon: ClipboardCheck },
  { id: 'production_queue', labelKey: 'nav.productionQueue', tipKey: 'nav.productionQueueTip', icon: ListChecks },
  { id: 'voice', labelKey: 'nav.voice', tipKey: 'nav.voiceTip', icon: Mic },
  { id: 'characters', labelKey: 'nav.characters', tipKey: 'nav.charactersTip', icon: Users },
  { id: 'assets', labelKey: 'nav.assets', tipKey: 'nav.assetsTip', icon: ImageIcon },
  { id: 'animation', labelKey: 'nav.animation', tipKey: 'nav.animationTip', icon: Sparkles },
  { id: 'sounds', labelKey: 'nav.sounds', tipKey: 'nav.soundsTip', icon: Volume2 },
  { id: 'subtitles', labelKey: 'nav.subtitles', tipKey: 'nav.subtitlesTip', icon: Captions },
  { id: 'render_queue', labelKey: 'nav.renderQueue', tipKey: 'nav.renderQueueTip', icon: Activity },
];

const ROADMAP_MODULES: NavEntry[] = [];

export function LeftNavRail() {
  const { t } = useI18n();
  const sidebarTab = useWorkspaceStore((s) => s.sidebarTab);
  const leftCollapsed = useWorkspaceStore((s) => s.leftCollapsed);
  const railExpanded = useWorkspaceStore((s) => s.railExpanded);
  const setSidebarTab = useWorkspaceStore((s) => s.setSidebarTab);
  const toggleRailExpanded = useWorkspaceStore((s) => s.toggleRailExpanded);

  const renderItem = (item: NavEntry) => {
    const Icon = item.icon;
    const active = !leftCollapsed && sidebarTab === item.id;
    const label = t(item.labelKey);
    return (
      <button
        key={item.id}
        type="button"
        data-rail-tab={item.id}
        className={`rail-btn ${active ? 'active' : ''}`}
        title={t(item.tipKey)}
        aria-label={label}
        aria-pressed={active}
        onClick={() => setSidebarTab(item.id)}
        style={{ opacity: item.roadmapVersion ? 0.62 : 1 }}
      >
        <Icon size={15} style={{ flexShrink: 0 }} />
        {railExpanded && <span className="rail-btn-label">{label}</span>}
        {item.roadmapVersion && <span className="rail-badge-ver">{item.roadmapVersion}</span>}
      </button>
    );
  };

  return (
    <nav
      className={`sidebar-rail ${railExpanded ? 'expanded' : ''}`}
      aria-label={t('nav.production')}
    >
      {railExpanded && <div className="rail-section-label">{t('nav.production')}</div>}
      {CORE_MODULES.map(renderItem)}

      {ROADMAP_MODULES.length > 0 && (
        <>
          <div
            style={{
              height: 1,
              background: 'var(--border-subtle)',
              margin: '5px 4px',
              flexShrink: 0,
            }}
          />

          {railExpanded && <div className="rail-section-label">{t('nav.roadmap')}</div>}
          {ROADMAP_MODULES.map(renderItem)}
        </>
      )}

      <div style={{ flex: 1 }} />

      <button
        type="button"
        className="rail-btn"
        title={railExpanded ? t('nav.collapseRail') : t('nav.expandRail')}
        aria-label={railExpanded ? t('nav.collapseRail') : t('nav.expandRail')}
        onClick={toggleRailExpanded}
      >
        {railExpanded ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
        {railExpanded && <span className="rail-btn-label">{t('nav.collapseRail')}</span>}
      </button>
    </nav>
  );
}
