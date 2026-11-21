import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Edit3,
  Pencil,
  Plus,
  ShieldAlert,
  Trash2,
  User,
  UserPlus,
} from 'lucide-react';
import { analyzeCharacterRig } from '@/engine/characterRigEngine';
import { useI18n } from '@/i18n/useLocaleStore';
import { apiClient } from '@/services/apiClient';
import { safeLibraryDelete } from '@/components/common/safeLibraryDelete';
import { useJobStore } from '@/stores/useJobStore';
import { useLibraryStore } from '@/stores/useLibraryStore';
import { useProjectStore } from '@/stores/useProjectStore';
import type { Asset, Character } from '@/types/models';
import { SearchInput } from '@/components/ui/SearchInput';
import { EmptyState } from '@/components/common/CommonUI';

export function createStarterCharacterPayload(name: string): Partial<Character> & { name: string } {
  return {
    name: name.trim(),
    identity_confirmed: true,
    parts: [
      {
        slot_id: 'slot_body',
        name: 'Body',
        part_role: 'body',
        parent_slot_id: null,
        default_asset_id: null,
        variants: {},
        z_index: 15,
        anchor_x: 0.5,
        anchor_y: 0.8,
        default_transform: { x: 0, y: 0, rotation_deg: 0, scale_x: 1, scale_y: 1, opacity: 1 },
        visible: true,
        locked: false,
      },
      {
        slot_id: 'slot_head',
        name: 'Head',
        part_role: 'head',
        parent_slot_id: 'slot_body',
        default_asset_id: null,
        variants: {},
        z_index: 22,
        anchor_x: 0.5,
        anchor_y: 0.88,
        default_transform: { x: 0, y: -130, rotation_deg: 0, scale_x: 1, scale_y: 1, opacity: 1 },
        visible: true,
        locked: false,
      },
      {
        slot_id: 'slot_eyes',
        name: 'Eyes',
        part_role: 'eyes',
        parent_slot_id: 'slot_head',
        default_asset_id: null,
        variants: {},
        z_index: 26,
        anchor_x: 0.5,
        anchor_y: 0.5,
        default_transform: { x: 0, y: -42, rotation_deg: 0, scale_x: 1, scale_y: 1, opacity: 1 },
        visible: true,
        locked: false,
      },
      {
        slot_id: 'slot_mouth',
        name: 'Mouth',
        part_role: 'mouth',
        parent_slot_id: 'slot_head',
        default_asset_id: null,
        variants: {},
        z_index: 27,
        anchor_x: 0.5,
        anchor_y: 0.5,
        default_transform: { x: 0, y: -12, rotation_deg: 0, scale_x: 1, scale_y: 1, opacity: 1 },
        visible: true,
        locked: false,
      },
    ],
    expressions: [
      {
        expression_id: 'expr_neutral',
        name: 'Neutral',
        slot_variant_overrides: { slot_eyes: 'open', slot_mouth: 'closed' },
        slot_transform_overrides: {},
      },
    ],
    poses: [],
  };
}

export function CharactersPanel({
  onEditCharacter,
}: {
  onEditCharacter: (characterId: string) => void;
}) {
  const { t } = useI18n();
  const characters = useLibraryStore((s) => s.characters);
  const assets = useLibraryStore((s) => s.assets);
  const upsertCharacter = useLibraryStore((s) => s.upsertCharacter);
  const removeCharacter = useLibraryStore((s) => s.removeCharacter);
  const pushToast = useJobStore((s) => s.pushToast);

  const project = useProjectStore((s) => s.project);
  const activeSceneId = useProjectStore((s) => s.activeSceneId);
  const addCharacterToScene = useProjectStore((s) => s.addCharacterToScene);

  const [search, setSearch] = useState('');
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  const activeScene =
    project?.scenes.find((s) => s.scene_id === activeSceneId) ?? project?.scenes[0] ?? null;

  const assetsById = useMemo(() => {
    const map: Record<string, Asset> = {};
    for (const a of assets) map[a.asset_id] = a;
    return map;
  }, [assets]);

  const filtered = characters.filter((c) => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return c.name.toLowerCase().includes(q) || c.tags.some((tg) => tg.toLowerCase().includes(q));
  });

  const handleCreate = async () => {
    const resolvedName = newName.trim() || `Character ${characters.length + 1}`;
    setCreating(true);
    try {
      const char = await apiClient.createCharacter(createStarterCharacterPayload(resolvedName));
      upsertCharacter(char);
      setNewName('');
      pushToast('success', t('chars.createdToast', { name: char.name }));
      onEditCharacter(char.character_id);
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : 'Error');
    } finally {
      setCreating(false);
    }
  };

  const handleDuplicate = async (char: Character) => {
    try {
      const dup = await apiClient.createCharacter({
        name: `${char.name} (Copy)`,
        description: char.description,
        tags: [...char.tags],
        identity_confirmed: char.identity_confirmed,
        thumbnail_asset_id: char.thumbnail_asset_id,
        voice_profile_id: char.voice_profile_id,
        parts: structuredClone(char.parts),
        expressions: structuredClone(char.expressions),
        poses: structuredClone(char.poses),
      });
      upsertCharacter(dup);
      pushToast('success', t('chars.duplicatedToast', { name: dup.name }));
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : 'Error');
    }
  };

  const commitRename = async (char: Character) => {
    const next = renameDraft.trim();
    setRenamingId(null);
    if (!next || next === char.name) return;
    try {
      const updated = await apiClient.updateCharacter(char.character_id, { name: next });
      upsertCharacter(updated);
      pushToast('success', t('chars.renamedToast', { name: updated.name }));
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : 'Error');
    }
  };

  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            aria-label={t('chars.newPlaceholder')}
            placeholder={t('chars.newPlaceholder')}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleCreate();
            }}
            style={{ flex: 1, minWidth: 0 }}
          />
          <button
            type="button"
            className="btn-primary"
            disabled={creating}
            onClick={() => void handleCreate()}
            title={t('chars.createHint')}
            data-testid="create-character-btn"
          >
            <UserPlus size={13} /> {t('chars.createCharacter')}
          </button>
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{t('chars.createHint')}</div>
      </div>

      <SearchInput
        value={search}
        onChange={setSearch}
        placeholder={t('chars.searchPlaceholder')}
      />

      {filtered.length === 0 ? (
        <EmptyState
          title={t('chars.emptyTitle')}
          description={t('chars.emptyDesc')}
          action={
            <button
              type="button"
              className="btn-primary btn-xs"
              disabled={creating}
              onClick={() => void handleCreate()}
            >
              <UserPlus size={12} /> {t('chars.createCharacter')}
            </button>
          }
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {filtered.map((char) => {
            const analysis = analyzeCharacterRig(char, assetsById);
            const statusColor =
              analysis.rigStatus === 'ready'
                ? 'var(--success)'
                : analysis.rigStatus === 'basic'
                  ? 'var(--accent-text)'
                  : 'var(--warning)';
            const createdDate = char.created_at
              ? new Date(char.created_at).toLocaleDateString()
              : null;

            return (
              <div key={char.character_id} className="list-card" data-character-id={char.character_id}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  {/* Character Thumbnail */}
                  <div
                    onClick={() => onEditCharacter(char.character_id)}
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: 6,
                      background: 'var(--surface-canvas)',
                      border: '1px solid var(--border-subtle)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      overflow: 'hidden',
                      flexShrink: 0,
                      cursor: 'pointer',
                    }}
                    title={t('chars.openBuilder')}
                  >
                    {analysis.thumbnailAssetId ? (
                      <img
                        src={apiClient.getAssetFileUrl(analysis.thumbnailAssetId)}
                        alt={char.name}
                        style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                      />
                    ) : (
                      <User size={18} color="var(--text-muted)" />
                    )}
                  </div>

                  {/* Character Header + Rig Status */}
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
                      {renamingId === char.character_id ? (
                        <input
                          autoFocus
                          value={renameDraft}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onBlur={() => void commitRename(char)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void commitRename(char);
                            if (e.key === 'Escape') setRenamingId(null);
                          }}
                          style={{ flex: 1, fontSize: 12, padding: '1px 5px' }}
                        />
                      ) : (
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 4,
                            fontWeight: 600,
                            minWidth: 0,
                            cursor: 'pointer',
                          }}
                          onDoubleClick={() => {
                            setRenamingId(char.character_id);
                            setRenameDraft(char.name);
                          }}
                        >
                          {char.identity_confirmed ? (
                            <CheckCircle2 size={12} color="var(--success)" style={{ flexShrink: 0 }} />
                          ) : (
                            <ShieldAlert size={12} color="var(--warning)" style={{ flexShrink: 0 }} />
                          )}
                          <span
                            style={{
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {char.name}
                          </span>
                        </div>
                      )}
                      <span className="mono" style={{ fontSize: 9, color: 'var(--text-muted)', flexShrink: 0 }}>
                        v{char.version}
                      </span>
                    </div>

                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                      <span
                        className="tag-pill"
                        style={{ color: statusColor, borderColor: `${statusColor}44`, fontWeight: 600 }}
                      >
                        {t(`chars.rigStatus.${analysis.rigStatus}`)}
                      </span>
                      <span className="tag-pill">
                        {t('chars.assignedRatio', {
                          assigned: analysis.assignedParts,
                          total: analysis.totalParts,
                        })}
                      </span>
                      {createdDate && (
                        <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>
                          {t('chars.createdAt', { date: createdDate })}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Truthful Missing-Part Warnings */}
                {(analysis.missingCoreRoles.length > 0 || analysis.missingAssetSlotNames.length > 0) && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 5,
                      fontSize: 10,
                      color: 'var(--warning)',
                      background: 'rgba(245, 158, 11, 0.08)',
                      border: '1px solid rgba(245, 158, 11, 0.22)',
                      borderRadius: 4,
                      padding: '3px 6px',
                    }}
                  >
                    <AlertTriangle size={11} style={{ flexShrink: 0 }} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {analysis.missingCoreRoles.length > 0
                        ? t('chars.missingCoreWarn', {
                            roles: analysis.missingCoreRoles
                              .map((r) => t(`partRole.${r}`))
                              .join(', '),
                          })
                        : t('chars.missingAssetsWarn', {
                            count: analysis.missingAssetSlotNames.length,
                          })}
                    </span>
                  </div>
                )}

                {/* Actions: Edit / Build + Add to Scene on primary row, utility icons neatly aligned */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 2 }}>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button
                      type="button"
                      className="btn-xs"
                      style={{ flex: 1, minWidth: 0, justifyContent: 'center' }}
                      onClick={() => onEditCharacter(char.character_id)}
                    >
                      <Edit3 size={11} style={{ flexShrink: 0 }} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {t('chars.openBuilder')}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="btn-primary btn-xs"
                      style={{ flex: 1, minWidth: 0, justifyContent: 'center' }}
                      disabled={!activeScene}
                      title={!activeScene ? t('chars.noProjectHint') : t('chars.toStage')}
                      onClick={() => {
                        if (!activeScene) return;
                        addCharacterToScene(activeScene.scene_id, char.character_id, char.name);
                        pushToast(
                          'success',
                          t('chars.addedToStageToast', { name: char.name, scene: activeScene.name }),
                        );
                      }}
                    >
                      <Plus size={11} style={{ flexShrink: 0 }} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {t('chars.toStage')}
                      </span>
                    </button>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'flex-end',
                      gap: 2,
                      borderTop: '1px solid var(--border-subtle)',
                      paddingTop: 3,
                    }}
                  >
                    <button
                      type="button"
                      className="btn-ghost btn-xs"
                      title={t('chars.duplicate')}
                      aria-label={t('chars.duplicate')}
                      onClick={() => void handleDuplicate(char)}
                    >
                      <Copy size={11} /> {t('chars.duplicate')}
                    </button>
                    <button
                      type="button"
                      className="btn-ghost btn-xs"
                      title={t('chars.rename')}
                      aria-label={t('chars.rename')}
                      onClick={() => {
                        setRenamingId(char.character_id);
                        setRenameDraft(char.name);
                      }}
                    >
                      <Pencil size={11} /> {t('chars.rename')}
                    </button>
                    <button
                      type="button"
                      className="btn-ghost btn-icon btn-xs"
                      title={`${t('common.delete')} — ${t('chars.deleteConfirmNote')}`}
                      aria-label={t('common.delete')}
                      onClick={async () => {
                        const ok = await safeLibraryDelete(char.name, (force) => apiClient.deleteCharacter(char.character_id, force), (m) => pushToast('error', m));
                        if (!ok) return;
                        removeCharacter(char.character_id);
                        pushToast('info', `${t('chars.deletedToast', { name: char.name })} ${t('chars.deleteConfirmNote')}`);
                      }}
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
