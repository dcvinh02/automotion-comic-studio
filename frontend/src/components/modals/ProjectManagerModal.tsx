import { useEffect, useState } from 'react';
import { FolderOpen, History, Plus, RotateCcw, Save, Trash2, X } from 'lucide-react';
import { useI18n } from '@/i18n/useLocaleStore';
import { apiClient } from '@/services/apiClient';
import { useJobStore } from '@/stores/useJobStore';
import { useProjectStore } from '@/stores/useProjectStore';
import type { BackupInfo } from '@/types/models';
import { EmptyState } from '@/components/common/CommonUI';

export function ProjectManagerModal({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const projects = useProjectStore((s) => s.projects);
  const currentProject = useProjectStore((s) => s.project);
  const loadProjectList = useProjectStore((s) => s.loadProjectList);
  const createProject = useProjectStore((s) => s.createProject);
  const openProject = useProjectStore((s) => s.openProject);
  const deleteProject = useProjectStore((s) => s.deleteProject);
  const replaceProjectFromRestore = useProjectStore((s) => s.replaceProjectFromRestore);
  const pushToast = useJobStore((s) => s.pushToast);

  const [tab, setTab] = useState<'projects' | 'create' | 'backups'>('projects');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [resolution, setResolution] = useState('1920x1080');
  const [customWidth, setCustomWidth] = useState(1920);
  const [customHeight, setCustomHeight] = useState(1080);
  const [fps, setFps] = useState(30);
  const [durationSec, setDurationSec] = useState(30);
  const [busy, setBusy] = useState(false);

  const [backups, setBackups] = useState<BackupInfo[]>([]);

  useEffect(() => {
    void loadProjectList();
  }, [loadProjectList]);

  useEffect(() => {
    if (tab === 'backups' && currentProject) {
      void apiClient.listBackups(currentProject.meta.project_id).then(setBackups);
    }
  }, [tab, currentProject?.meta.project_id]);

  const handleCreate = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const [w, h] =
        resolution === 'custom'
          ? [customWidth, customHeight]
          : resolution.split('x').map(Number);
      await createProject({
        name: name.trim(),
        description: description.trim(),
        width: Math.max(320, Math.min(3840, w || 1920)),
        height: Math.max(240, Math.min(2160, h || 1080)),
        fps,
        duration_ms: Math.max(3, durationSec) * 1000,
      });
      pushToast('success', `${t('modal.createProject')}: "${name.trim()}"`);
      onClose();
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : 'Error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>{t('modal.projectsTitle')}</span>
          <button className="btn-ghost btn-icon" onClick={onClose} aria-label={t('common.close')}>
            <X size={14} />
          </button>
        </div>

        <div
          style={{
            display: 'flex',
            gap: 6,
            padding: '8px 14px',
            borderBottom: '1px solid var(--border-subtle)',
            background: 'var(--surface-header)',
          }}
        >
          <button className={tab === 'projects' ? 'active' : ''} onClick={() => setTab('projects')}>
            <FolderOpen size={12} /> {t('modal.projectsTab', { count: projects.length })}
          </button>
          <button className={tab === 'create' ? 'active' : ''} onClick={() => setTab('create')}>
            <Plus size={12} /> {t('modal.newProjectTab')}
          </button>
          <button
            className={tab === 'backups' ? 'active' : ''}
            disabled={!currentProject}
            onClick={() => setTab('backups')}
          >
            <History size={12} /> {t('modal.backupsTab')}
          </button>
        </div>

        <div className="modal-body">
          {tab === 'projects' && (
            <>
              {projects.length === 0 ? (
                <EmptyState
                  title={t('modal.noProjectsTitle')}
                  description={t('modal.noProjectsDesc')}
                  action={
                    <button className="btn-primary" onClick={() => setTab('create')}>
                      <Plus size={12} /> {t('modal.createProject')}
                    </button>
                  }
                />
              ) : (
                projects.map((p) => (
                  <div
                    key={p.project_id}
                    className={`list-card ${currentProject?.meta.project_id === p.project_id ? 'selected' : ''}`}
                    style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
                  >
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{p.name}</div>
                      <div className="mono" style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                        {p.width}×{p.height} @ {p.fps}fps • {(p.duration_ms / 1000).toFixed(1)}s • {p.scene_count}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        className="btn-primary"
                        onClick={async () => {
                          await openProject(p.project_id);
                          onClose();
                        }}
                      >
                        {t('common.open')}
                      </button>
                      <button
                        className="btn-danger btn-icon"
                        title={t('common.delete')}
                        onClick={async () => {
                          await deleteProject(p.project_id);
                        }}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </>
          )}

          {tab === 'create' && (
            <>
              <div className="field-row">
                <label className="field-label">{t('project.name')}</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Episode 01"
                  autoFocus
                />
              </div>
              <div className="field-row">
                <label className="field-label">{t('project.description')}</label>
                <input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={t('project.descPlaceholder')}
                />
              </div>
              <div className="field-grid">
                <div className="field-row">
                  <label className="field-label">{t('modal.canvasPreset')}</label>
                  <select value={resolution} onChange={(e) => setResolution(e.target.value)}>
                    <option value="1920x1080">1920 × 1080 (Full HD 16:9)</option>
                    <option value="1280x720">1280 × 720 (HD 16:9)</option>
                    <option value="1080x1920">1080 × 1920 (Vertical 9:16)</option>
                    <option value="custom">{t('modal.customResolution')}</option>
                  </select>
                </div>
                <div className="field-row">
                  <label className="field-label">{t('project.frameRate')}</label>
                  <select value={fps} onChange={(e) => setFps(Number(e.target.value))}>
                    <option value={24}>24 fps</option>
                    <option value={25}>25 fps</option>
                    <option value={30}>30 fps</option>
                    <option value={60}>60 fps</option>
                  </select>
                </div>
              </div>
              {resolution === 'custom' && (
                <div className="field-grid">
                  <div className="field-row">
                    <label className="field-label">{t('project.stageWidth')}</label>
                    <input
                      type="number"
                      min={320}
                      max={3840}
                      value={customWidth}
                      onChange={(e) => setCustomWidth(Number(e.target.value) || 1920)}
                    />
                  </div>
                  <div className="field-row">
                    <label className="field-label">{t('project.stageHeight')}</label>
                    <input
                      type="number"
                      min={240}
                      max={2160}
                      value={customHeight}
                      onChange={(e) => setCustomHeight(Number(e.target.value) || 1080)}
                    />
                  </div>
                </div>
              )}
              <div className="field-row">
                <label className="field-label">{t('modal.initialDuration')}</label>
                <input
                  type="number"
                  min={5}
                  max={1800}
                  value={durationSec}
                  onChange={(e) => setDurationSec(Number(e.target.value) || 30)}
                />
              </div>
              <button
                className="btn-primary"
                disabled={busy || !name.trim()}
                onClick={() => void handleCreate()}
              >
                <Plus size={13} /> {busy ? t('common.creating') : t('modal.createProject')}
              </button>
            </>
          )}

          {tab === 'backups' && currentProject && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ color: 'var(--text-secondary)' }}>
                  {t('modal.backupsFor')} <strong>{currentProject.meta.name}</strong>
                </span>
                <button
                  className="btn-primary"
                  onClick={async () => {
                    const b = await apiClient.createBackup(currentProject.meta.project_id);
                    setBackups((prev) => [b, ...prev]);
                    pushToast('success', b.filename);
                  }}
                >
                  <Save size={12} /> {t('modal.createBackupNow')}
                </button>
              </div>
              {backups.length === 0 ? (
                <EmptyState
                  title={t('modal.noBackupsTitle')}
                  description={t('modal.noBackupsDesc')}
                />
              ) : (
                backups.map((b) => (
                  <div
                    key={b.filename}
                    className="list-card"
                    style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
                  >
                    <div>
                      <div className="mono" style={{ fontSize: 11 }}>{b.filename}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                        {new Date(b.created_at).toLocaleString()} • {(b.size_bytes / 1024).toFixed(1)} KB
                      </div>
                    </div>
                    <button
                      onClick={async () => {
                        const restored = await apiClient.restoreBackup(
                          currentProject.meta.project_id,
                          b.filename,
                        );
                        replaceProjectFromRestore(restored);
                        pushToast('success', `${t('modal.restore')}: ${b.filename}`);
                        onClose();
                      }}
                    >
                      <RotateCcw size={12} /> {t('modal.restore')}
                    </button>
                  </div>
                ))
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
