import React, { useRef, useState } from 'react';
import { CheckCircle2, ImagePlus, Plus, ShieldAlert, Trash2, Upload } from 'lucide-react';
import { useI18n } from '@/i18n/useLocaleStore';
import { apiClient } from '@/services/apiClient';
import { safeLibraryDelete } from '@/components/common/safeLibraryDelete';
import { useJobStore } from '@/stores/useJobStore';
import { useLibraryStore } from '@/stores/useLibraryStore';
import { useProjectStore } from '@/stores/useProjectStore';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';
import type { AssetType, PartRole } from '@/types/models';
import { ALL_PART_ROLES } from '@/engine/characterRigEngine';
import { SearchInput } from '@/components/ui/SearchInput';
import { EmptyState } from '@/components/common/CommonUI';

const PART_ROLES: PartRole[] = ALL_PART_ROLES;

export function AssetsPanel() {
  const { t } = useI18n();
  const assets = useLibraryStore((s) => s.assets);
  const upsertAsset = useLibraryStore((s) => s.upsertAsset);
  const removeAsset = useLibraryStore((s) => s.removeAsset);
  const pushToast = useJobStore((s) => s.pushToast);

  const project = useProjectStore((s) => s.project);
  const activeSceneId = useProjectStore((s) => s.activeSceneId);
  const selection = useProjectStore((s) => s.selection);
  const setSelection = useProjectStore((s) => s.setSelection);
  const updateScene = useProjectStore((s) => s.updateScene);
  const addPropToScene = useProjectStore((s) => s.addPropToScene);

  const leftWidth = useWorkspaceStore((s) => s.leftWidth);
  const openContextMenu = useWorkspaceStore((s) => s.openContextMenu);

  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState<string>('all');
  const [showImport, setShowImport] = useState(false);
  const [importType, setImportType] = useState<AssetType>('character_part');
  const [importRole, setImportRole] = useState<PartRole>('body');
  const [importFolder, setImportFolder] = useState('general');
  const [importTags, setImportTags] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const activeScene =
    project?.scenes.find((s) => s.scene_id === activeSceneId) ?? project?.scenes[0] ?? null;

  const filtered = assets.filter((a) => {
    if (filterType !== 'all' && a.type !== filterType) return false;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      return (
        a.name.toLowerCase().includes(q) ||
        a.folder.toLowerCase().includes(q) ||
        a.tags.some((tg) => tg.toLowerCase().includes(q))
      );
    }
    return true;
  });

  const handleFilesSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    setUploading(true);
    let okCount = 0;
    try {
      for (const file of files) {
        const asset = await apiClient.importAsset({
          file,
          type: importType,
          part_role: importType === 'character_part' ? importRole : null,
          folder: importFolder.trim() || 'general',
          tags: importTags
            .split(',')
            .map((tg) => tg.trim())
            .filter(Boolean),
          identity_verified: true,
        });
        upsertAsset(asset);
        okCount += 1;
      }
      pushToast('success', t('assets.importedToast', { count: okCount }));
      setShowImport(false);
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <>
      <div style={{ display: 'flex', gap: 6 }}>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder={t('assets.searchPlaceholder')}
        />
        <button className="btn-primary" onClick={() => setShowImport((v) => !v)}>
          <Upload size={13} /> {t('assets.importPng')}
        </button>
      </div>

      {showImport && (
        <div className="inspector-section">
          <div className="inspector-section-title">{t('assets.importSection')}</div>
          <div className="field-grid">
            <div className="field-row">
              <label className="field-label">{t('assets.assetType')}</label>
              <select
                value={importType}
                onChange={(e) => setImportType(e.target.value as AssetType)}
              >
                <option value="character_part">{t('assets.typePart')}</option>
                <option value="background">{t('assets.typeBackground')}</option>
                <option value="prop">{t('assets.typeProp')}</option>
                <option value="spritesheet">{t('assets.typeSpritesheet')}</option>
              </select>
            </div>
            {importType === 'character_part' && (
              <div className="field-row">
                <label className="field-label">{t('assets.bodyPartRole')}</label>
                <select
                  value={importRole}
                  onChange={(e) => setImportRole(e.target.value as PartRole)}
                >
                  {PART_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
          <div className="field-grid">
            <div className="field-row">
              <label className="field-label">{t('assets.folder')}</label>
              <input
                value={importFolder}
                onChange={(e) => setImportFolder(e.target.value)}
                placeholder="hero"
              />
            </div>
            <div className="field-row">
              <label className="field-label">{t('assets.tagsComma')}</label>
              <input
                value={importTags}
                onChange={(e) => setImportTags(e.target.value)}
                placeholder="hero, front"
              />
            </div>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".png,.webp,image/png,image/webp"
            multiple
            style={{ display: 'none' }}
            onChange={handleFilesSelected}
          />
          <button
            className="btn-primary"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            <ImagePlus size={13} /> {uploading ? t('assets.uploading') : t('assets.selectFiles')}
          </button>
        </div>
      )}

      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {[
          { id: 'all', label: t('assets.filterAll', { count: assets.length }) },
          { id: 'character_part', label: t('assets.filterParts') },
          { id: 'background', label: t('assets.filterBackgrounds') },
          { id: 'prop', label: t('assets.filterProps') },
        ].map((tab) => (
          <button
            key={tab.id}
            className={`btn-xs ${filterType === tab.id ? 'active' : ''}`}
            onClick={() => setFilterType(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title={t('assets.emptyTitle')}
          description={t('assets.emptyDesc')}
          action={
            <button className="btn-primary" onClick={() => setShowImport(true)}>
              <Upload size={13} /> {t('assets.importPng')}
            </button>
          }
        />
      ) : (
        <div className={`asset-grid ${leftWidth >= 380 ? 'wide' : ''}`}>
          {filtered.map((asset) => {
            const isSelected = selection.type === 'asset' && selection.id === asset.asset_id;
            return (
              <div
                key={asset.asset_id}
                className={`asset-card ${isSelected ? 'selected' : ''}`}
                onClick={() => setSelection({ type: 'asset', id: asset.asset_id })}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setSelection({ type: 'asset', id: asset.asset_id });
                  openContextMenu({
                    x: e.clientX,
                    y: e.clientY,
                    items: [
                      ...(activeScene
                        ? [
                            {
                              id: 'set-bg',
                              label: t('inspector.useAsBg'),
                              onSelect: () => {
                                updateScene(activeScene.scene_id, {
                                  background_asset_id: asset.asset_id,
                                });
                              },
                            },
                            {
                              id: 'add-prop',
                              label: t('inspector.addAsProp'),
                              onSelect: () =>
                                addPropToScene(activeScene.scene_id, asset.asset_id, asset.name),
                            },
                            { id: 'div-1', divider: true },
                          ]
                        : []),
                      {
                        id: 'verify',
                        label: t('inspector.identityVerified'),
                        onSelect: async () => {
                          const updated = await apiClient.updateAsset(asset.asset_id, {
                            identity_verified: !asset.identity_verified,
                          });
                          upsertAsset(updated);
                        },
                      },
                      { id: 'div-2', divider: true },
                      {
                        id: 'delete',
                        label: t('common.delete'),
                        danger: true,
                        onSelect: async () => {
                          const ok = await safeLibraryDelete(asset.name, (force) => apiClient.deleteAsset(asset.asset_id, force), (m) => pushToast('error', m));
                          if (!ok) return;
                          removeAsset(asset.asset_id);
                          pushToast('info', t('assets.deletedToast', { name: asset.name }));
                        },
                      },
                    ],
                  });
                }}
              >
                <div className="asset-thumb">
                  <img
                    src={apiClient.getAssetFileUrl(asset.asset_id)}
                    alt={asset.name}
                    loading="lazy"
                  />
                </div>
                <div
                  style={{
                    fontWeight: 600,
                    fontSize: 11,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                  title={asset.name}
                >
                  {asset.name}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                    {asset.width}×{asset.height}
                  </span>
                  {asset.identity_verified ? (
                    <span title={t('inspector.identityVerified')}>
                      <CheckCircle2 size={12} color="var(--success)" />
                    </span>
                  ) : (
                    <ShieldAlert size={12} color="var(--warning)" />
                  )}
                </div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  <span className="tag-pill">{asset.part_role ?? asset.type}</span>
                  <span className="tag-pill">{asset.folder}</span>
                </div>
                <div style={{ display: 'flex', gap: 4, marginTop: 2 }}>
                  {asset.type === 'background' && activeScene && (
                    <button
                      className="btn-xs"
                      style={{ flex: 1 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        updateScene(activeScene.scene_id, { background_asset_id: asset.asset_id });
                      }}
                    >
                      {t('assets.setBg')}
                    </button>
                  )}
                  {asset.type !== 'background' && activeScene && (
                    <button
                      className="btn-xs"
                      style={{ flex: 1 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        addPropToScene(activeScene.scene_id, asset.asset_id, asset.name);
                      }}
                    >
                      <Plus size={10} /> {t('assets.addStage')}
                    </button>
                  )}
                  <button
                    className="btn-ghost btn-icon btn-xs"
                    title={t('common.delete')}
                    onClick={async (e) => {
                      e.stopPropagation();
                      const ok = await safeLibraryDelete(asset.name, (force) => apiClient.deleteAsset(asset.asset_id, force), (m) => pushToast('error', m));
                      if (!ok) return;
                      removeAsset(asset.asset_id);
                      pushToast('info', t('assets.deletedToast', { name: asset.name }));
                    }}
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
