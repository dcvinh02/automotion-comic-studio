import { FolderOpen, History, Layers, Save } from 'lucide-react';
import { useI18n } from '@/i18n/useLocaleStore';
import { apiClient } from '@/services/apiClient';
import { useJobStore } from '@/stores/useJobStore';
import { useProjectStore } from '@/stores/useProjectStore';
import { CollapsibleSection } from '@/components/ui/CollapsibleSection';
import { NumericScrubber } from '@/components/ui/NumericScrubber';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { EmptyState } from '@/components/common/CommonUI';

export function ProjectOverviewPanel({
  onOpenProjectManager,
}: {
  onOpenProjectManager: () => void;
}) {
  const { t } = useI18n();
  const project = useProjectStore((s) => s.project);
  const mutateProject = useProjectStore((s) => s.mutateProject);
  const setStageDimensions = useProjectStore((s) => s.setStageDimensions);
  const setTotalDurationMs = useProjectStore((s) => s.setTotalDurationMs);
  const saveProject = useProjectStore((s) => s.saveProject);
  const pushToast = useJobStore((s) => s.pushToast);

  if (!project) {
    return (
      <EmptyState
        title={t('project.noActiveTitle')}
        description={t('project.noActiveDesc')}
        action={
          <button className="btn-primary" onClick={onOpenProjectManager}>
            <FolderOpen size={13} /> {t('project.openManager')}
          </button>
        }
      />
    );
  }

  return (
    <>
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="btn-primary" style={{ flex: 1 }} onClick={onOpenProjectManager}>
          <FolderOpen size={12} /> {t('project.switchManage')}
        </button>
        <button
          onClick={async () => {
            await saveProject(true);
            const b = await apiClient.createBackup(project.meta.project_id);
            pushToast('success', b.filename);
          }}
          title={t('modal.createBackupNow')}
        >
          <History size={12} /> {t('project.backup')}
        </button>
      </div>

      <CollapsibleSection title={t('project.metadata')} icon={<Layers size={12} />} defaultOpen>
        <div className="field-row">
          <label className="field-label">{t('project.name')}</label>
          <input
            value={project.meta.name}
            onChange={(e) =>
              mutateProject((draft) => {
                draft.meta.name = e.target.value;
              })
            }
          />
        </div>
        <div className="field-row">
          <label className="field-label">{t('project.description')}</label>
          <textarea
            rows={2}
            value={project.meta.description}
            placeholder={t('project.descPlaceholder')}
            onChange={(e) =>
              mutateProject((draft) => {
                draft.meta.description = e.target.value;
              })
            }
          />
        </div>
        <div className="field-grid">
          <NumericScrubber
            label={t('project.stageWidth')}
            shortTag="W"
            unit="px"
            step={16}
            min={320}
            max={3840}
            precision={0}
            value={project.meta.width}
            onChange={(w) => setStageDimensions(w, project.meta.height)}
          />
          <NumericScrubber
            label={t('project.stageHeight')}
            shortTag="H"
            unit="px"
            step={16}
            min={240}
            max={2160}
            precision={0}
            value={project.meta.height}
            onChange={(h) => setStageDimensions(project.meta.width, h)}
          />
        </div>
        <div className="field-row">
          <label className="field-label">{t('project.frameRate')}</label>
          <select
            value={project.timeline.fps}
            onChange={(e) => {
              const fps = Number(e.target.value) || 30;
              mutateProject((draft) => {
                draft.timeline.fps = fps;
                draft.meta.fps = fps;
              });
            }}
          >
            <option value={24}>24 fps</option>
            <option value={25}>25 fps</option>
            <option value={30}>30 fps</option>
            <option value={60}>60 fps</option>
          </select>
        </div>
        <NumericScrubber
          label={t('project.timelineDuration')}
          shortTag="D"
          unit="s"
          step={1}
          min={3}
          max={1800}
          precision={1}
          value={project.timeline.total_duration_ms / 1000}
          onChange={(sec) => setTotalDurationMs(sec * 1000)}
        />
        <ToggleSwitch
          label={t('project.autoSave')}
          description={t('project.autoSaveDesc')}
          checked={project.meta.auto_save_enabled}
          onChange={(checked) =>
            mutateProject((draft) => {
              draft.meta.auto_save_enabled = checked;
            })
          }
        />
      </CollapsibleSection>

      <CollapsibleSection title={t('project.summary')} defaultOpen>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, fontSize: 11 }}>
          <div className="list-card" style={{ padding: 6 }}>
            <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>{t('nav.scenes').toUpperCase()}</span>
            <strong className="mono" style={{ fontSize: 14 }}>{project.scenes.length}</strong>
          </div>
          <div className="list-card" style={{ padding: 6 }}>
            <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>KEYFRAMES</span>
            <strong className="mono" style={{ fontSize: 14 }}>{project.timeline.keyframes.length}</strong>
          </div>
          <div className="list-card" style={{ padding: 6 }}>
            <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>{t('nav.animation').toUpperCase()}</span>
            <strong className="mono" style={{ fontSize: 14 }}>{project.timeline.animation_clips.length}</strong>
          </div>
          <div className="list-card" style={{ padding: 6 }}>
            <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>SFX</span>
            <strong className="mono" style={{ fontSize: 14 }}>{project.timeline.sound_events.length}</strong>
          </div>
        </div>
        <button
          className="btn-primary"
          onClick={() =>
            void saveProject(true).then(() =>
              pushToast('success', t('topbar.saveStatusSaved', { time: new Date().toLocaleTimeString() })),
            )
          }
        >
          <Save size={12} /> {t('project.saveWithBackup')}
        </button>
      </CollapsibleSection>
    </>
  );
}
