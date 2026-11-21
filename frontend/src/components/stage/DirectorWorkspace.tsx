import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  BookOpen,
  Brain,
  Check,
  CheckCheck,
  CheckCircle2,
  Clapperboard,
  Combine,
  FileText,
  Film,
  GitMerge,
  Link2,
  Loader2,
  MessageSquareQuote,
  RefreshCw,
  RotateCcw,
  Scissors,
  Settings,
  Sparkles,
  Trash2,
  Unlink,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { useI18n } from '@/i18n/useLocaleStore';
import { useDirectorStore, type DirectorTabId } from '@/stores/useDirectorStore';
import { useJobStore } from '@/stores/useJobStore';
import { useLibraryStore } from '@/stores/useLibraryStore';
import { useProjectStore } from '@/stores/useProjectStore';
import type {
  DirectorReviewStatus,
  ExtractedCharacter,
  ExtractedItemType,
  SceneBreakdownItem,
  SceneImportance,
} from '@/types/models';

const REVIEW_BADGE_CLASS: Record<DirectorReviewStatus, string> = {
  pending: 'pending',
  edited: 'edited',
  accepted: 'accepted',
  rejected: 'rejected',
};

export function DirectorWorkspace({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useI18n();
  const project = useProjectStore((s) => s.project);
  const saveProject = useProjectStore((s) => s.saveProject);
  const isDirty = useProjectStore((s) => s.isDirty);
  const replaceDirectorScene = useProjectStore((s) => s.replaceDirectorScene);
  const editDirectorCharacter = useProjectStore((s) => s.editDirectorCharacter);
  const mergeDirectorCharacters = useProjectStore((s) => s.mergeDirectorCharacters);
  const separateDirectorCharacterAlias = useProjectStore((s) => s.separateDirectorCharacterAlias);
  const resolveDirectorItemSpeaker = useProjectStore((s) => s.resolveDirectorItemSpeaker);
  const editDirectorScene = useProjectStore((s) => s.editDirectorScene);
  const setDirectorSceneStatus = useProjectStore((s) => s.setDirectorSceneStatus);
  const acceptAllDirectorScenes = useProjectStore((s) => s.acceptAllDirectorScenes);
  const splitDirectorScene = useProjectStore((s) => s.splitDirectorScene);
  const mergeDirectorScenes = useProjectStore((s) => s.mergeDirectorScenes);
  const moveDirectorScene = useProjectStore((s) => s.moveDirectorScene);
  const deleteDirectorScene = useProjectStore((s) => s.deleteDirectorScene);
  const restoreDirectorScene = useProjectStore((s) => s.restoreDirectorScene);
  const restoreAllDirectorScenes = useProjectStore((s) => s.restoreAllDirectorScenes);

  const libraryCharacters = useLibraryStore((s) => s.characters);
  const pushToast = useJobStore((s) => s.pushToast);

  const activeTab = useDirectorStore((s) => s.activeTab);
  const setActiveTab = useDirectorStore((s) => s.setActiveTab);
  const selectedSceneId = useDirectorStore((s) => s.selectedSceneBreakdownId);
  const setSelectedSceneId = useDirectorStore((s) => s.setSelectedSceneBreakdownId);
  const selectedCharId = useDirectorStore((s) => s.selectedCharacterAnalysisId);
  const setSelectedCharId = useDirectorStore((s) => s.setSelectedCharacterAnalysisId);
  const regeneratingSceneId = useDirectorStore((s) => s.regeneratingSceneId);
  const regenerateScene = useDirectorStore((s) => s.regenerateScene);

  // Local UI state for multi-select merge, split position, filters, regeneration instructions
  const [mergeSelectedIds, setMergeSelectedIds] = useState<string[]>([]);
  const [splitCutPos, setSplitCutPos] = useState<number>(1);
  const [regenInstructions, setRegenInstructions] = useState('');
  const [preserveEditsOnRegen, setPreserveEditsOnRegen] = useState(true);
  const [mergeTargetCharId, setMergeTargetCharId] = useState('');
  const [itemFilterType, setItemFilterType] = useState<'all' | ExtractedItemType>('all');
  const [unresolvedOnly, setUnresolvedOnly] = useState(false);
  const [itemSearch, setItemSearch] = useState('');

  const director = project?.director ?? null;

  const selectedScene: SceneBreakdownItem | null = useMemo(() => {
    if (!director || director.scenes.length === 0) return null;
    return (
      director.scenes.find((s) => s.scene_breakdown_id === selectedSceneId) ?? director.scenes[0]
    );
  }, [director, selectedSceneId]);

  const selectedChar: ExtractedCharacter | null = useMemo(() => {
    if (!director || director.characters.length === 0) return null;
    return (
      director.characters.find((c) => c.character_analysis_id === selectedCharId) ??
      director.characters[0]
    );
  }, [director, selectedCharId]);

  useEffect(() => {
    if (selectedScene && selectedScene.source_paragraphs.length >= 2) {
      setSplitCutPos(Math.ceil(selectedScene.source_paragraphs.length / 2));
    } else {
      setSplitCutPos(1);
    }
  }, [selectedScene?.scene_breakdown_id, selectedScene?.source_paragraphs.length]);

  const charById = useMemo(
    () => new Map((director?.characters ?? []).map((c) => [c.character_analysis_id, c])),
    [director],
  );
  const sceneById = useMemo(
    () => new Map((director?.scenes ?? []).map((s) => [s.scene_breakdown_id, s])),
    [director],
  );
  const itemById = useMemo(
    () => new Map((director?.extracted_items ?? []).map((it) => [it.item_id, it])),
    [director],
  );

  const filteredItems = useMemo(() => {
    if (!director) return [];
    const q = itemSearch.trim().toLowerCase();
    return director.extracted_items.filter((it) => {
      if (itemFilterType !== 'all' && it.item_type !== itemFilterType) return false;
      if (unresolvedOnly && !it.speaker_unresolved) return false;
      if (q) {
        const hay = `${it.original_text} ${it.speaker_name_raw} ${it.emotion} ${it.notes}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [director, itemFilterType, unresolvedOnly, itemSearch]);

  if (!project) {
    return (
      <div className="director-empty-workspace">
        <Brain size={36} color="var(--accent-text)" />
        <h3>{t('director.workspaceTitle')}</h3>
        <p>{t('common.noProject')}</p>
      </div>
    );
  }

  if (!director || director.status === 'idle') {
    return (
      <div className="director-empty-workspace" data-testid="director-empty-state">
        <div className="director-empty-card">
          <Brain size={34} color="var(--accent-text)" />
          <h3>{t('director.emptyTitle')}</h3>
          <p>{t('director.emptySubtitle')}</p>
          <div className="director-empty-steps">
            <div>1. {t('director.emptyStep1')}</div>
            <div>2. {t('director.emptyStep2')}</div>
            <div>3. {t('director.emptyStep3')}</div>
            <div>4. {t('director.emptyStep4')}</div>
          </div>
          <button type="button" onClick={onOpenSettings}>
            <Settings size={13} /> {t('director.configureAi')}
          </button>
        </div>
      </div>
    );
  }

  const toggleMergeCheck = (sceneId: string) => {
    setMergeSelectedIds((prev) =>
      prev.includes(sceneId) ? prev.filter((id) => id !== sceneId) : [...prev, sceneId],
    );
  };

  const handleMergeSelectedScenes = () => {
    if (mergeSelectedIds.length < 2) return;
    const mergedId = mergeDirectorScenes(mergeSelectedIds);
    if (mergedId) {
      setSelectedSceneId(mergedId);
      setMergeSelectedIds([]);
      pushToast('success', t('director.scenesMergedToast'));
    }
  };

  const handleSplitSelectedScene = () => {
    if (!selectedScene) return;
    const res = splitDirectorScene(
      selectedScene.scene_breakdown_id,
      selectedScene.source_paragraphs.length >= 2 ? splitCutPos : undefined,
    );
    if (res) {
      setSelectedSceneId(res.secondId);
      pushToast('success', t('director.sceneSplitToast'));
    }
  };

  const handleRegenerateSelectedScene = async () => {
    if (!selectedScene) return;
    try {
      // Save local user_edited_fields to SQLite before backend regenerates so edits are preserved!
      if (isDirty) {
        await saveProject(false);
      }
      const updated = await regenerateScene(
        project.meta.project_id,
        selectedScene.scene_breakdown_id,
        regenInstructions,
        preserveEditsOnRegen,
      );
      replaceDirectorScene(updated);
      setRegenInstructions('');
      pushToast('success', t('director.sceneRegeneratedToast', { num: updated.scene_number }));
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : 'Regeneration failed');
    }
  };

  const handleMergeSelectedChar = () => {
    if (!selectedChar || !mergeTargetCharId || mergeTargetCharId === selectedChar.character_analysis_id) {
      return;
    }
    mergeDirectorCharacters(mergeTargetCharId, selectedChar.character_analysis_id);
    setSelectedCharId(mergeTargetCharId);
    setMergeTargetCharId('');
    pushToast('success', t('director.charactersMergedToast'));
  };

  const unresolvedSpeakerCount = director.extracted_items.filter((i) => i.speaker_unresolved).length;
  const ambiguousCharCount = director.characters.filter((c) => c.ambiguous_aliases.length > 0).length;

  const TABS: Array<{ id: DirectorTabId; label: string; icon: typeof BookOpen; badge?: number | string }> = [
    { id: 'overview', label: t('director.tabOverview'), icon: BookOpen },
    {
      id: 'characters',
      label: t('director.tabCharacters'),
      icon: Users,
      badge: director.characters.length,
    },
    {
      id: 'dialogue',
      label: t('director.tabDialogue'),
      icon: MessageSquareQuote,
      badge: director.extracted_items.length,
    },
    {
      id: 'scenes',
      label: t('director.tabScenes'),
      icon: Clapperboard,
      badge: director.scenes.length,
    },
  ];

  return (
    <div className="director-workspace" data-testid="director-workspace">
      {/* Top Banner + Sub-Tabs */}
      <div className="director-header">
        <div className="director-subtabs" role="tablist">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                data-testid={`director-tab-${tab.id}`}
                className={`director-subtab-btn ${active ? 'active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
              >
                <Icon size={13} />
                <span>{tab.label}</span>
                {tab.badge !== undefined && <span className="director-tab-count">{tab.badge}</span>}
              </button>
            );
          })}
        </div>

        <div className="director-header-actions">
          <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
            {director.provider_id} / {director.model}
          </span>
          <button
            type="button"
            className="btn-xs"
            onClick={() => {
              acceptAllDirectorScenes();
              pushToast('success', t('director.acceptedAllToast'));
            }}
            data-testid="director-accept-all-btn"
          >
            <CheckCheck size={12} /> {t('director.acceptAllBtn')}
          </button>
          <button
            type="button"
            className="btn-xs"
            disabled={!director.original_scenes_snapshot?.length}
            onClick={() => {
              restoreAllDirectorScenes();
              pushToast('info', t('director.restoredAllToast'));
            }}
            data-testid="director-restore-all-btn"
          >
            <RotateCcw size={12} /> {t('director.restoreAllBtn')}
          </button>
        </div>
      </div>

      {/* Strategy & Warnings Strip */}
      {(director.warnings.length > 0 || director.context_strategy_note) && (
        <div className="director-meta-strip">
          {director.context_strategy_note && (
            <span className="director-strategy-pill">
              <Sparkles size={11} /> {director.context_strategy_note}
            </span>
          )}
          {unresolvedSpeakerCount > 0 && (
            <button
              type="button"
              className="director-badge warning"
              onClick={() => {
                setActiveTab('dialogue');
                setUnresolvedOnly(true);
              }}
            >
              <AlertTriangle size={10} />{' '}
              {t('director.unresolvedSpeakersCount', { count: unresolvedSpeakerCount })}
            </button>
          )}
          {ambiguousCharCount > 0 && (
            <button
              type="button"
              className="director-badge warning"
              onClick={() => setActiveTab('characters')}
            >
              <AlertTriangle size={10} />{' '}
              {t('director.ambiguousAliasesCount', { count: ambiguousCharCount })}
            </button>
          )}
          {director.warnings.map((w, i) => (
            <span key={i} className="director-warning-inline">
              <AlertTriangle size={11} /> {w}
            </span>
          ))}
        </div>
      )}

      {/* TAB 1: STORY OVERVIEW & PRODUCTION ANALYSIS */}
      {activeTab === 'overview' && (
        <div className="director-scroll-body" data-testid="director-overview-panel">
          <div className="director-two-col">
            {/* Story Overview Card */}
            <section className="director-card">
              <div className="director-card-title">
                <BookOpen size={13} color="var(--accent-text)" />
                <span>{t('director.storyOverviewTitle')}</span>
                {director.story_overview.genre && (
                  <span className="director-badge pending">{director.story_overview.genre}</span>
                )}
              </div>

              <div className="director-story-title">
                {director.story_overview.title || project.meta.name}
              </div>

              {director.story_overview.premise && (
                <div className="director-kv-block">
                  <div className="director-kv-label">{t('director.premiseLabel')}</div>
                  <div className="director-kv-value">{director.story_overview.premise}</div>
                </div>
              )}

              {director.story_overview.synopsis && (
                <div className="director-kv-block">
                  <div className="director-kv-label">{t('director.synopsisLabel')}</div>
                  <div className="director-kv-value">{director.story_overview.synopsis}</div>
                </div>
              )}

              <div className="director-kv-grid">
                <div className="director-kv-block">
                  <div className="director-kv-label">{t('director.narrativeToneLabel')}</div>
                  <div className="director-kv-value">
                    {director.story_overview.narrative_tone || '—'}
                  </div>
                </div>
                <div className="director-kv-block">
                  <div className="director-kv-label">{t('director.storyStructureLabel')}</div>
                  <div className="director-kv-value">
                    {director.story_overview.story_structure || '—'}
                  </div>
                </div>
                <div className="director-kv-block">
                  <div className="director-kv-label">{t('director.conflictLabel')}</div>
                  <div className="director-kv-value">
                    {director.story_overview.conflict || '—'}
                  </div>
                </div>
                <div className="director-kv-block">
                  <div className="director-kv-label">{t('director.climaxLabel')}</div>
                  <div className="director-kv-value">
                    {director.story_overview.climax || '—'}
                  </div>
                </div>
              </div>

              {director.story_overview.ending && (
                <div className="director-kv-block">
                  <div className="director-kv-label">{t('director.endingLabel')}</div>
                  <div className="director-kv-value">{director.story_overview.ending}</div>
                </div>
              )}

              {director.story_overview.themes.length > 0 && (
                <div className="director-kv-block">
                  <div className="director-kv-label">{t('director.themesLabel')}</div>
                  <div className="director-chip-row">
                    {director.story_overview.themes.map((th, i) => (
                      <span key={i} className="director-chip">
                        {th}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {director.story_overview.turning_points.length > 0 && (
                <div className="director-kv-block">
                  <div className="director-kv-label">{t('director.turningPointsLabel')}</div>
                  <ul className="director-bullet-list">
                    {director.story_overview.turning_points.map((tp, i) => (
                      <li key={i}>{tp}</li>
                    ))}
                  </ul>
                </div>
              )}
            </section>

            {/* Narrative Structure & Beats */}
            <section className="director-card">
              <div className="director-card-title">
                <Film size={13} color="var(--accent-text)" />
                <span>{t('director.narrativeBeatsTitle')}</span>
              </div>

              {director.story_overview.structure_uncertainty && (
                <div className="director-callout warning">
                  <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: 1 }} />
                  <div>
                    <strong>{t('director.structureUncertaintyLabel')}:</strong>{' '}
                    {director.story_overview.structure_uncertainty}
                  </div>
                </div>
              )}

              {director.story_overview.narrative_beats.length > 0 ? (
                <div className="director-beat-list">
                  {director.story_overview.narrative_beats.map((b) => (
                    <div key={b.beat_id} className="director-beat-item">
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                        <span className="director-badge edited">{b.stage || 'beat'}</span>
                        <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                          {b.source_paragraphs.length > 0
                            ? `P${b.source_paragraphs.map((p) => p + 1).join(', P')}`
                            : ''}
                          {' • '}
                          {Math.round(b.confidence * 100)}%
                        </span>
                      </div>
                      <div style={{ fontWeight: 600, fontSize: 12, marginTop: 3 }}>
                        {b.label || b.stage}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                        {b.summary}
                      </div>
                      {b.uncertainty_note && (
                        <div style={{ fontSize: 10, color: 'var(--warning)', marginTop: 3 }}>
                          {b.uncertainty_note}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {t('director.noNarrativeBeats')}
                </div>
              )}
            </section>
          </div>

          {/* Production Analysis Grid */}
          <section className="director-card" style={{ marginTop: 12 }}>
            <div className="director-card-title">
              <Sparkles size={13} color="var(--accent-text)" />
              <span>{t('director.productionAnalysisTitle')}</span>
            </div>
            <div className="director-prod-grid">
              {(
                [
                  ['visual_opportunities', t('director.prodVisuals')],
                  ['action_moments', t('director.prodAction')],
                  ['emotional_beats', t('director.prodEmotion')],
                  ['dramatic_pauses', t('director.prodPauses')],
                  ['establishing_shots', t('director.prodEstablishing')],
                  ['environmental_details', t('director.prodEnvironment')],
                  ['transition_ideas', t('director.prodTransitions')],
                  ['vfx_scenes', t('director.prodVfx')],
                ] as const
              ).map(([field, label]) => {
                const list = director.production_analysis[field] ?? [];
                return (
                  <div key={field} className="director-prod-box">
                    <div className="director-kv-label">{label}</div>
                    {list.length > 0 ? (
                      <ul className="director-bullet-list">
                        {list.map((val, idx) => (
                          <li key={idx}>{val}</li>
                        ))}
                      </ul>
                    ) : (
                      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>—</div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      )}

      {/* TAB 2: CHARACTERS & ALIASES REVIEW */}
      {activeTab === 'characters' && (
        <div className="director-split-body" data-testid="director-characters-panel">
          {/* Character List */}
          <div className="director-list-col">
            {director.characters.length === 0 ? (
              <div className="director-empty-inline">{t('director.noCharactersExtracted')}</div>
            ) : (
              director.characters.map((ch) => {
                const isSelected = selectedChar?.character_analysis_id === ch.character_analysis_id;
                const linkedLib = libraryCharacters.find((lc) => lc.character_id === ch.linked_character_id);
                return (
                  <div
                    key={ch.character_analysis_id}
                    className={`director-list-item ${isSelected ? 'active' : ''}`}
                    data-testid={`director-char-item-${ch.character_analysis_id}`}
                    onClick={() => setSelectedCharId(ch.character_analysis_id)}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                      <strong style={{ fontSize: 12 }}>{ch.canonical_name}</strong>
                      <span className={`director-badge ${REVIEW_BADGE_CLASS[ch.review_status]}`}>
                        {ch.narrative_importance}
                      </span>
                    </div>
                    {ch.role && (
                      <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 2 }}>
                        {ch.role}
                      </div>
                    )}
                    <div className="director-chip-row" style={{ marginTop: 4 }}>
                      {!ch.appearance_specified && (
                        <span className="director-badge pending" title={t('director.appearanceUnspecifiedHint')}>
                          {t('director.appearanceUnspecified')}
                        </span>
                      )}
                      {ch.ambiguous_aliases.length > 0 && (
                        <span className="director-badge warning">
                          <AlertTriangle size={9} /> {t('director.ambiguousAliasBadge')}
                        </span>
                      )}
                      {linkedLib && (
                        <span className="director-badge accepted">
                          <Link2 size={9} /> {linkedLib.name}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Character Detail Editor */}
          <div className="director-detail-col">
            {selectedChar ? (
              <div className="director-card">
                <div className="director-card-title" style={{ justifyContent: 'space-between' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Users size={13} color="var(--accent-text)" />
                    <span>{selectedChar.canonical_name}</span>
                    {selectedChar.user_edited_fields.length > 0 && (
                      <span className="director-badge edited">{t('director.userEditedBadge')}</span>
                    )}
                  </span>
                  <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                    {t('director.dialogueCount', { count: selectedChar.dialogue_item_ids.length })} •{' '}
                    {Math.round(selectedChar.confidence * 100)}%
                  </span>
                </div>

                {/* Ambiguous Alias Warning */}
                {selectedChar.ambiguous_aliases.length > 0 && (
                  <div className="director-callout warning" style={{ marginBottom: 10 }}>
                    <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: 1 }} />
                    <div>
                      <strong>{t('director.ambiguousAliasWarningTitle')}:</strong>{' '}
                      {selectedChar.ambiguous_aliases.join(', ')} — {t('director.ambiguousAliasWarningHint')}
                    </div>
                  </div>
                )}

                <div className="field-grid">
                  <div className="field-row">
                    <label className="field-label">{t('director.charCanonicalName')}</label>
                    <input
                      data-testid="director-char-name-input"
                      value={selectedChar.canonical_name}
                      onChange={(e) =>
                        editDirectorCharacter(selectedChar.character_analysis_id, {
                          canonical_name: e.target.value,
                        })
                      }
                    />
                  </div>
                  <div className="field-row">
                    <label className="field-label">{t('director.charImportance')}</label>
                    <select
                      value={selectedChar.narrative_importance}
                      onChange={(e) =>
                        editDirectorCharacter(selectedChar.character_analysis_id, {
                          narrative_importance: e.target.value as ExtractedCharacter['narrative_importance'],
                        })
                      }
                    >
                      <option value="main">{t('director.impMain')}</option>
                      <option value="supporting">{t('director.impSupporting')}</option>
                      <option value="minor">{t('director.impMinor')}</option>
                      <option value="unspecified">{t('director.impUnspecified')}</option>
                    </select>
                  </div>
                </div>

                <div className="field-grid" style={{ marginTop: 8 }}>
                  <div className="field-row">
                    <label className="field-label">{t('director.charRole')}</label>
                    <input
                      value={selectedChar.role}
                      onChange={(e) =>
                        editDirectorCharacter(selectedChar.character_analysis_id, {
                          role: e.target.value,
                        })
                      }
                    />
                  </div>
                  <div className="field-row">
                    <label className="field-label">{t('director.charPersonality')}</label>
                    <input
                      value={selectedChar.personality}
                      onChange={(e) =>
                        editDirectorCharacter(selectedChar.character_analysis_id, {
                          personality: e.target.value,
                        })
                      }
                    />
                  </div>
                </div>

                <div className="field-row" style={{ marginTop: 8 }}>
                  <label className="field-label" style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>{t('director.charAppearance')}</span>
                    {!selectedChar.appearance_specified && (
                      <span style={{ color: 'var(--warning)', fontSize: 10 }}>
                        {t('director.appearanceUnspecifiedHint')}
                      </span>
                    )}
                  </label>
                  <textarea
                    rows={2}
                    value={selectedChar.appearance_description}
                    onChange={(e) =>
                      editDirectorCharacter(selectedChar.character_analysis_id, {
                        appearance_description: e.target.value,
                      })
                    }
                  />
                </div>

                {/* Aliases & Separate Incorrectly Merged Alias */}
                <div className="director-kv-block" style={{ marginTop: 10 }}>
                  <div className="director-kv-label">{t('director.charAliasesLabel')}</div>
                  <div className="director-chip-row" style={{ marginBottom: 6 }}>
                    {selectedChar.aliases.length === 0 ? (
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>—</span>
                    ) : (
                      selectedChar.aliases.map((al) => (
                        <span key={al} className="director-chip">
                          <span>{al}</span>
                          <button
                            type="button"
                            className="director-chip-action"
                            title={t('director.separateAliasTip')}
                            data-testid={`separate-alias-${al}`}
                            onClick={() => {
                              const newId = separateDirectorCharacterAlias(
                                selectedChar.character_analysis_id,
                                al,
                              );
                              if (newId) {
                                pushToast('success', t('director.aliasSeparatedToast', { alias: al }));
                              }
                            }}
                          >
                            <UserPlus size={10} />
                          </button>
                        </span>
                      ))
                    )}
                  </div>
                  <input
                    placeholder={t('director.charAliasesPlaceholder')}
                    value={selectedChar.aliases.join(', ')}
                    onChange={(e) =>
                      editDirectorCharacter(selectedChar.character_analysis_id, {
                        aliases: e.target.value
                          .split(',')
                          .map((x) => x.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                </div>

                {/* Link to Existing Library Character (No Duplicates) */}
                <div className="director-tier-box" style={{ marginTop: 10 }}>
                  <div className="director-tier-title">
                    <Link2 size={12} /> {t('director.linkLibraryCharTitle')}
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <select
                      style={{ flex: 1 }}
                      data-testid="director-link-library-select"
                      value={selectedChar.linked_character_id ?? ''}
                      onChange={(e) =>
                        editDirectorCharacter(selectedChar.character_analysis_id, {
                          linked_character_id: e.target.value || null,
                        })
                      }
                    >
                      <option value="">{t('director.unlinkedOption')}</option>
                      {libraryCharacters.map((lc) => (
                        <option key={lc.character_id} value={lc.character_id}>
                          {lc.name} ({lc.parts.length} parts)
                        </option>
                      ))}
                    </select>
                    {selectedChar.linked_character_id && (
                      <button
                        type="button"
                        className="btn-xs"
                        onClick={() =>
                          editDirectorCharacter(selectedChar.character_analysis_id, {
                            linked_character_id: null,
                          })
                        }
                      >
                        <Unlink size={11} />
                      </button>
                    )}
                  </div>
                </div>

                {/* Merge Duplicate Character */}
                {director.characters.length > 1 && (
                  <div className="director-tier-box" style={{ marginTop: 8 }}>
                    <div className="director-tier-title">
                      <GitMerge size={12} /> {t('director.mergeCharTitle')}
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <select
                        style={{ flex: 1 }}
                        value={mergeTargetCharId}
                        onChange={(e) => setMergeTargetCharId(e.target.value)}
                      >
                        <option value="">{t('director.selectTargetChar')}</option>
                        {director.characters
                          .filter((c) => c.character_analysis_id !== selectedChar.character_analysis_id)
                          .map((c) => (
                            <option key={c.character_analysis_id} value={c.character_analysis_id}>
                              {c.canonical_name}
                            </option>
                          ))}
                      </select>
                      <button
                        type="button"
                        className="btn-xs"
                        disabled={!mergeTargetCharId}
                        onClick={handleMergeSelectedChar}
                        data-testid="director-merge-char-btn"
                      >
                        <GitMerge size={11} /> {t('director.mergeIntoBtn')}
                      </button>
                    </div>
                  </div>
                )}

                {/* Relationships & Emotional Arc */}
                <div className="director-kv-grid" style={{ marginTop: 10 }}>
                  <div className="director-kv-block">
                    <div className="director-kv-label">{t('director.charRelationshipsLabel')}</div>
                    {selectedChar.relationships.length > 0 ? (
                      <ul className="director-bullet-list">
                        {selectedChar.relationships.map((r, i) => (
                          <li key={i}>
                            <strong>{r.target_name}</strong> ({r.relationship_type})
                            {r.description ? ` — ${r.description}` : ''}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>—</span>
                    )}
                  </div>
                  <div className="director-kv-block">
                    <div className="director-kv-label">{t('director.charEmotionsActionsLabel')}</div>
                    <div className="director-chip-row">
                      {selectedChar.emotional_states.map((em, i) => (
                        <span key={`e-${i}`} className="director-chip">
                          {em}
                        </span>
                      ))}
                    </div>
                    {selectedChar.actions.length > 0 && (
                      <ul className="director-bullet-list" style={{ marginTop: 4 }}>
                        {selectedChar.actions.map((ac, i) => (
                          <li key={`a-${i}`}>{ac}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="director-empty-inline">{t('director.noCharactersExtracted')}</div>
            )}
          </div>
        </div>
      )}

      {/* TAB 3: DIALOGUE & NARRATION EXTRACTION (VERBATIM) */}
      {activeTab === 'dialogue' && (
        <div className="director-scroll-body" data-testid="director-dialogue-panel">
          <div className="director-filter-bar">
            <select
              value={itemFilterType}
              onChange={(e) => setItemFilterType(e.target.value as 'all' | ExtractedItemType)}
            >
              <option value="all">{t('director.filterAllTypes')}</option>
              <option value="dialogue">{t('director.typeDialogue')}</option>
              <option value="narration">{t('director.typeNarration')}</option>
              <option value="internal_thought">{t('director.typeThought')}</option>
              <option value="action">{t('director.typeAction')}</option>
              <option value="scene_description">{t('director.typeSceneDesc')}</option>
              <option value="sound_cue">{t('director.typeSoundCue')}</option>
            </select>
            <input
              style={{ flex: 1 }}
              placeholder={t('director.searchItemsPlaceholder')}
              value={itemSearch}
              onChange={(e) => setItemSearch(e.target.value)}
            />
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}>
              <input
                type="checkbox"
                checked={unresolvedOnly}
                onChange={(e) => setUnresolvedOnly(e.target.checked)}
              />
              <span>{t('director.unresolvedOnlyLabel')}</span>
            </label>
          </div>

          <div className="director-items-list">
            {filteredItems.length === 0 ? (
              <div className="director-empty-inline">{t('director.noMatchingItems')}</div>
            ) : (
              filteredItems.map((it) => {
                const speaker = it.speaker_character_analysis_id
                  ? charById.get(it.speaker_character_analysis_id)
                  : null;
                const sc = it.scene_breakdown_id ? sceneById.get(it.scene_breakdown_id) : null;
                return (
                  <div key={it.item_id} className="director-script-item-row">
                    <div className="director-script-item-meta">
                      <span className="director-badge pending">{it.item_type}</span>
                      <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                        P{it.paragraph_index + 1}
                      </span>
                      {sc && (
                        <span className="director-badge edited">
                          S{String(sc.scene_number).padStart(2, '0')}
                        </span>
                      )}
                      {it.language && it.language !== 'unknown' && (
                        <span className="mono" style={{ fontSize: 10, color: 'var(--accent-text)' }}>
                          [{it.language}]
                        </span>
                      )}
                      {it.emotion && <span className="director-chip">{it.emotion}</span>}
                      <div style={{ flex: 1 }} />
                      {(it.item_type === 'dialogue' || it.item_type === 'internal_thought') && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          {it.speaker_unresolved && (
                            <span className="director-badge warning">
                              <AlertTriangle size={9} /> {t('director.unresolvedSpeakerBadge')}
                            </span>
                          )}
                          <select
                            style={{ fontSize: 11, padding: '2px 6px' }}
                            value={it.speaker_character_analysis_id ?? ''}
                            onChange={(e) =>
                              resolveDirectorItemSpeaker(it.item_id, e.target.value || null)
                            }
                          >
                            <option value="">
                              {it.speaker_name_raw
                                ? `${t('director.unassignedSpeaker')} (${it.speaker_name_raw})`
                                : t('director.unassignedSpeaker')}
                            </option>
                            {director.characters.map((c) => (
                              <option key={c.character_analysis_id} value={c.character_analysis_id}>
                                {c.canonical_name}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                    </div>
                    <div className="director-verbatim-text">
                      {speaker ? (
                        <strong style={{ color: 'var(--accent-text)', marginRight: 6 }}>
                          {speaker.canonical_name}:
                        </strong>
                      ) : it.speaker_name_raw ? (
                        <strong style={{ color: 'var(--warning)', marginRight: 6 }}>
                          {it.speaker_name_raw}:
                        </strong>
                      ) : null}
                      <span>{it.original_text}</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* TAB 4: SCENE BREAKDOWN REVIEW & BOUNDARY EDITING */}
      {activeTab === 'scenes' && (
        <div className="director-split-body" data-testid="director-scenes-panel">
          {/* Scene Breakdown List Column */}
          <div className="director-list-col">
            {mergeSelectedIds.length >= 2 && (
              <div className="director-merge-bar">
                <span style={{ fontSize: 11 }}>
                  {t('director.mergeSelectedCount', { count: mergeSelectedIds.length })}
                </span>
                <button
                  type="button"
                  className="btn-primary btn-xs"
                  onClick={handleMergeSelectedScenes}
                  data-testid="director-merge-scenes-btn"
                >
                  <Combine size={11} /> {t('director.mergeScenesBtn')}
                </button>
              </div>
            )}

            {director.scenes.length === 0 ? (
              <div className="director-empty-inline">{t('director.noScenesProposed')}</div>
            ) : (
              director.scenes.map((sc, idx) => {
                const isSelected = selectedScene?.scene_breakdown_id === sc.scene_breakdown_id;
                const isChecked = mergeSelectedIds.includes(sc.scene_breakdown_id);
                return (
                  <div
                    key={sc.scene_breakdown_id}
                    className={`director-list-item ${isSelected ? 'active' : ''}`}
                    data-testid={`director-scene-card-${sc.scene_number}`}
                    onClick={() => setSelectedSceneId(sc.scene_breakdown_id)}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggleMergeCheck(sc.scene_breakdown_id)}
                        title={t('director.selectForMergeTip')}
                        data-testid={`director-scene-check-${sc.scene_number}`}
                      />
                      <span className="mono" style={{ fontSize: 10, color: 'var(--accent-text)', fontWeight: 700 }}>
                        S{String(sc.scene_number).padStart(2, '0')}
                      </span>
                      <strong
                        style={{
                          flex: 1,
                          fontSize: 12,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {sc.title}
                      </strong>
                      <span className={`director-badge ${REVIEW_BADGE_CLASS[sc.review_status]}`}>
                        {t(`director.status.${sc.review_status}`)}
                      </span>
                    </div>

                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        fontSize: 10,
                        color: 'var(--text-secondary)',
                        marginTop: 4,
                      }}
                    >
                      <span>{sc.location || '—'}</span>
                      <span className="mono">
                        {sc.suggested_duration_min_s}–{sc.suggested_duration_max_s}s • {sc.importance}
                      </span>
                    </div>

                    <div
                      style={{ display: 'flex', gap: 4, marginTop: 6, alignItems: 'center' }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        className={`btn-xs ${sc.review_status === 'accepted' ? 'btn-primary' : ''}`}
                        onClick={() =>
                          setDirectorSceneStatus(
                            sc.scene_breakdown_id,
                            sc.review_status === 'accepted' ? 'pending' : 'accepted',
                          )
                        }
                        data-testid={`director-accept-scene-${sc.scene_number}`}
                        title={t('director.acceptSceneBtn')}
                      >
                        <Check size={10} />
                      </button>
                      <button
                        type="button"
                        className="btn-xs"
                        onClick={() =>
                          setDirectorSceneStatus(
                            sc.scene_breakdown_id,
                            sc.review_status === 'rejected' ? 'pending' : 'rejected',
                          )
                        }
                        title={t('director.rejectSceneBtn')}
                      >
                        <X size={10} />
                      </button>
                      <div style={{ flex: 1 }} />
                      <button
                        type="button"
                        className="btn-xs"
                        disabled={idx === 0}
                        onClick={() => moveDirectorScene(sc.scene_breakdown_id, -1)}
                        title={t('director.moveSceneUp')}
                      >
                        <ArrowUp size={10} />
                      </button>
                      <button
                        type="button"
                        className="btn-xs"
                        disabled={idx === director.scenes.length - 1}
                        onClick={() => moveDirectorScene(sc.scene_breakdown_id, 1)}
                        title={t('director.moveSceneDown')}
                      >
                        <ArrowDown size={10} />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Scene Breakdown Detail Inspector (4 Explicit Separation Tiers) */}
          <div className="director-detail-col">
            {selectedScene ? (
              <div className="director-scene-detail">
                {/* Action Header */}
                <div className="director-detail-topbar">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: 'var(--accent-text)' }}>
                      {t('director.sceneNumberLabel', { num: selectedScene.scene_number })}
                    </span>
                    <span className={`director-badge ${REVIEW_BADGE_CLASS[selectedScene.review_status]}`}>
                      {t(`director.status.${selectedScene.review_status}`)}
                    </span>
                    {selectedScene.user_edited_fields.length > 0 && (
                      <span className="director-badge edited" data-testid="director-scene-edited-badge">
                        {t('director.userEditedFieldsCount', {
                          count: selectedScene.user_edited_fields.length,
                        })}
                      </span>
                    )}
                    {selectedScene.applied_script_scene_id && (
                      <span className="director-badge accepted">
                        <CheckCircle2 size={10} /> {t('director.appliedBadge')}
                      </span>
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      type="button"
                      className={`btn-xs ${selectedScene.review_status === 'accepted' ? 'btn-primary' : ''}`}
                      onClick={() => setDirectorSceneStatus(selectedScene.scene_breakdown_id, 'accepted')}
                      data-testid="director-detail-accept-btn"
                    >
                      <Check size={11} /> {t('director.acceptSceneBtn')}
                    </button>
                    <button
                      type="button"
                      className="btn-xs"
                      onClick={() => setDirectorSceneStatus(selectedScene.scene_breakdown_id, 'rejected')}
                    >
                      <X size={11} /> {t('director.rejectSceneBtn')}
                    </button>
                    <button
                      type="button"
                      className="btn-xs"
                      disabled={!selectedScene.original_ai_snapshot}
                      onClick={() => {
                        restoreDirectorScene(selectedScene.scene_breakdown_id);
                        pushToast('info', t('director.sceneRestoredToast'));
                      }}
                      title={t('director.restoreSceneBtn')}
                      data-testid="director-restore-scene-btn"
                    >
                      <RotateCcw size={11} />
                    </button>
                    <button
                      type="button"
                      className="btn-xs btn-danger"
                      onClick={() => {
                        deleteDirectorScene(selectedScene.scene_breakdown_id);
                        pushToast('info', t('director.sceneDeletedToast'));
                      }}
                      title={t('common.delete')}
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                </div>

                {/* TIER 1: ORIGINAL SCRIPT SOURCE (READ-ONLY GROUNDED) */}
                <section className="director-tier-box tier-source">
                  <div className="director-tier-title" style={{ justifyContent: 'space-between' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <FileText size={12} /> {t('director.tierOriginalSource')}
                      <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                        (P{selectedScene.source_paragraphs.map((p) => p + 1).join(', P') || '—'})
                      </span>
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {selectedScene.source_paragraphs.length >= 2 && (
                        <select
                          style={{ fontSize: 10, padding: '2px 5px' }}
                          value={splitCutPos}
                          onChange={(e) => setSplitCutPos(Number(e.target.value))}
                        >
                          {selectedScene.source_paragraphs.slice(1).map((pIdx, idx) => (
                            <option key={pIdx} value={idx + 1}>
                              {t('director.splitBeforePara', { num: pIdx + 1 })}
                            </option>
                          ))}
                        </select>
                      )}
                      <button
                        type="button"
                        className="btn-xs"
                        onClick={handleSplitSelectedScene}
                        data-testid="director-split-scene-btn"
                      >
                        <Scissors size={11} /> {t('director.splitSceneBtn')}
                      </button>
                    </div>
                  </div>
                  <pre className="director-source-pre" data-testid="director-scene-source-text">
                    {selectedScene.source_text || '—'}
                  </pre>
                </section>

                {/* TIER 2: EXTRACTED FACTS */}
                <section className="director-tier-box tier-facts">
                  <div className="director-tier-title">
                    <Users size={12} /> {t('director.tierExtractedFacts')}
                  </div>
                  <div className="director-kv-grid">
                    <div>
                      <div className="director-kv-label">{t('director.charactersPresentLabel')}</div>
                      <div className="director-chip-row">
                        {selectedScene.characters_present.length > 0 ? (
                          selectedScene.characters_present.map((c, i) => (
                            <span key={i} className="director-chip">
                              {c}
                            </span>
                          ))
                        ) : (
                          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>—</span>
                        )}
                      </div>
                    </div>
                    <div>
                      <div className="director-kv-label">{t('director.entrancesExitsLabel')}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                        +{selectedScene.character_entrances.join(', ') || '—'} / −
                        {selectedScene.character_exits.join(', ') || '—'}
                      </div>
                    </div>
                  </div>
                  {(selectedScene.dialogue_item_ids.length > 0 ||
                    selectedScene.narration_item_ids.length > 0) && (
                    <div style={{ marginTop: 8 }}>
                      <div className="director-kv-label">
                        {t('director.sceneExtractedLinesLabel', {
                          dlg: selectedScene.dialogue_item_ids.length,
                          nar: selectedScene.narration_item_ids.length,
                        })}
                      </div>
                      <div className="director-mini-lines">
                        {[...selectedScene.dialogue_item_ids, ...selectedScene.narration_item_ids]
                          .map((id) => itemById.get(id))
                          .filter((x): x is NonNullable<typeof x> => Boolean(x))
                          .sort((a, b) => a.order_index - b.order_index)
                          .map((it) => (
                            <div key={it.item_id} className="director-mini-line">
                              <span className="director-badge pending">{it.item_type}</span>
                              {it.speaker_name_raw && (
                                <strong style={{ color: 'var(--accent-text)' }}>
                                  {it.speaker_name_raw}:
                                </strong>
                              )}
                              <span>{it.original_text}</span>
                            </div>
                          ))}
                      </div>
                    </div>
                  )}
                </section>

                {/* TIER 3: AI DIRECTOR SUGGESTIONS (EDITABLE — TRACKS USER EDITS) */}
                <section className="director-tier-box tier-suggestions">
                  <div className="director-tier-title" style={{ justifyContent: 'space-between' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <Sparkles size={12} color="var(--accent-text)" />{' '}
                      {t('director.tierAiSuggestions')}
                    </span>
                    <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                      {t('director.aiConfidenceLabel')}: {Math.round(selectedScene.ai_confidence * 100)}%
                    </span>
                  </div>

                  {selectedScene.unresolved_questions.length > 0 && (
                    <div className="director-callout warning" style={{ marginBottom: 8 }}>
                      <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: 1 }} />
                      <div>
                        <strong>{t('director.unresolvedQuestionsLabel')}:</strong>{' '}
                        {selectedScene.unresolved_questions.join(' • ')}
                      </div>
                    </div>
                  )}

                  <div className="field-grid">
                    <div className="field-row">
                      <label className="field-label">{t('director.sceneTitleLabel')}</label>
                      <input
                        data-testid="director-scene-title-input"
                        value={selectedScene.title}
                        onChange={(e) =>
                          editDirectorScene(selectedScene.scene_breakdown_id, {
                            title: e.target.value,
                          })
                        }
                      />
                    </div>
                    <div className="field-row">
                      <label className="field-label">{t('director.sceneImportanceLabel')}</label>
                      <select
                        value={selectedScene.importance}
                        onChange={(e) =>
                          editDirectorScene(selectedScene.scene_breakdown_id, {
                            importance: e.target.value as SceneImportance,
                          })
                        }
                      >
                        <option value="low">{t('director.sceneImpLow')}</option>
                        <option value="medium">{t('director.sceneImpMedium')}</option>
                        <option value="high">{t('director.sceneImpHigh')}</option>
                        <option value="climax">{t('director.sceneImpClimax')}</option>
                      </select>
                    </div>
                  </div>

                  <div className="field-grid" style={{ gridTemplateColumns: '1fr 1fr 1fr', marginTop: 8 }}>
                    <div className="field-row">
                      <label className="field-label">{t('director.locationLabel')}</label>
                      <input
                        data-testid="director-scene-location-input"
                        value={selectedScene.location}
                        onChange={(e) =>
                          editDirectorScene(selectedScene.scene_breakdown_id, {
                            location: e.target.value,
                          })
                        }
                      />
                    </div>
                    <div className="field-row">
                      <label className="field-label">{t('director.timeOfDayLabel')}</label>
                      <input
                        value={selectedScene.time_of_day}
                        onChange={(e) =>
                          editDirectorScene(selectedScene.scene_breakdown_id, {
                            time_of_day: e.target.value,
                          })
                        }
                      />
                    </div>
                    <div className="field-row">
                      <label className="field-label">{t('director.environmentLabel')}</label>
                      <input
                        value={selectedScene.environment}
                        onChange={(e) =>
                          editDirectorScene(selectedScene.scene_breakdown_id, {
                            environment: e.target.value,
                          })
                        }
                      />
                    </div>
                  </div>

                  <div className="field-row" style={{ marginTop: 8 }}>
                    <label className="field-label">{t('director.mainActionLabel')}</label>
                    <textarea
                      rows={2}
                      value={selectedScene.main_action}
                      onChange={(e) =>
                        editDirectorScene(selectedScene.scene_breakdown_id, {
                          main_action: e.target.value,
                        })
                      }
                    />
                  </div>

                  <div className="field-grid" style={{ marginTop: 8 }}>
                    <div className="field-row">
                      <label className="field-label">{t('director.emotionalBeatLabel')}</label>
                      <input
                        value={selectedScene.emotional_beat}
                        onChange={(e) =>
                          editDirectorScene(selectedScene.scene_breakdown_id, {
                            emotional_beat: e.target.value,
                          })
                        }
                      />
                    </div>
                    <div className="field-row">
                      <label className="field-label">{t('director.atmosphereLabel')}</label>
                      <input
                        value={selectedScene.atmosphere}
                        onChange={(e) =>
                          editDirectorScene(selectedScene.scene_breakdown_id, {
                            atmosphere: e.target.value,
                          })
                        }
                      />
                    </div>
                  </div>

                  <div className="field-grid" style={{ marginTop: 8 }}>
                    <div className="field-row">
                      <label className="field-label">{t('director.scenePurposeLabel')}</label>
                      <input
                        value={selectedScene.scene_purpose}
                        onChange={(e) =>
                          editDirectorScene(selectedScene.scene_breakdown_id, {
                            scene_purpose: e.target.value,
                          })
                        }
                      />
                    </div>
                    <div className="field-row">
                      <label className="field-label">{t('director.conflictLabel')}</label>
                      <input
                        value={selectedScene.conflict}
                        onChange={(e) =>
                          editDirectorScene(selectedScene.scene_breakdown_id, {
                            conflict: e.target.value,
                          })
                        }
                      />
                    </div>
                  </div>

                  <div className="field-grid" style={{ gridTemplateColumns: '1fr 1fr 2fr', marginTop: 8 }}>
                    <div className="field-row">
                      <label className="field-label">{t('director.durationMinLabel')}</label>
                      <input
                        type="number"
                        min={1}
                        max={600}
                        value={selectedScene.suggested_duration_min_s}
                        onChange={(e) =>
                          editDirectorScene(selectedScene.scene_breakdown_id, {
                            suggested_duration_min_s: Number(e.target.value) || 4,
                          })
                        }
                      />
                    </div>
                    <div className="field-row">
                      <label className="field-label">{t('director.durationMaxLabel')}</label>
                      <input
                        type="number"
                        min={1}
                        max={600}
                        value={selectedScene.suggested_duration_max_s}
                        onChange={(e) =>
                          editDirectorScene(selectedScene.scene_breakdown_id, {
                            suggested_duration_max_s: Number(e.target.value) || 12,
                          })
                        }
                      />
                    </div>
                    <div className="field-row">
                      <label className="field-label">{t('director.transitionSuggestionLabel')}</label>
                      <input
                        value={selectedScene.transition_suggestion}
                        onChange={(e) =>
                          editDirectorScene(selectedScene.scene_breakdown_id, {
                            transition_suggestion: e.target.value,
                          })
                        }
                      />
                    </div>
                  </div>

                  <div className="field-row" style={{ marginTop: 8 }}>
                    <label className="field-label">{t('director.visualOpportunitiesLabel')}</label>
                    <input
                      value={selectedScene.visual_opportunities.join('; ')}
                      onChange={(e) =>
                        editDirectorScene(selectedScene.scene_breakdown_id, {
                          visual_opportunities: e.target.value
                            .split(';')
                            .map((x) => x.trim())
                            .filter(Boolean),
                        })
                      }
                    />
                  </div>
                </section>

                {/* TIER 4: USER EDIT PROTECTION & PER-SCENE REGENERATION */}
                <section className="director-tier-box tier-edits">
                  <div className="director-tier-title">
                    <RefreshCw size={12} /> {t('director.tierUserEditsRegen')}
                  </div>
                  {selectedScene.user_edited_fields.length > 0 && (
                    <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 6 }}>
                      {t('director.protectedFieldsLabel')}:{' '}
                      <span className="mono">{selectedScene.user_edited_fields.join(', ')}</span>
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input
                      style={{ flex: 1, minWidth: 200 }}
                      placeholder={t('director.regenInstructionsPlaceholder')}
                      value={regenInstructions}
                      onChange={(e) => setRegenInstructions(e.target.value)}
                    />
                    <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}>
                      <input
                        type="checkbox"
                        checked={preserveEditsOnRegen}
                        onChange={(e) => setPreserveEditsOnRegen(e.target.checked)}
                      />
                      <span>{t('director.preserveUserEditsLabel')}</span>
                    </label>
                    <button
                      type="button"
                      disabled={regeneratingSceneId === selectedScene.scene_breakdown_id}
                      onClick={() => void handleRegenerateSelectedScene()}
                      data-testid="director-regenerate-scene-btn"
                    >
                      {regeneratingSceneId === selectedScene.scene_breakdown_id ? (
                        <Loader2 size={12} className="spin" />
                      ) : (
                        <RefreshCw size={12} />
                      )}
                      {t('director.regenerateSceneBtn')}
                    </button>
                  </div>
                </section>
              </div>
            ) : (
              <div className="director-empty-inline">{t('director.noScenesProposed')}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
