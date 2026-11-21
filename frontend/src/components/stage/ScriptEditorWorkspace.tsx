import React, { useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  BookOpen,
  CheckCircle2,
  Clapperboard,
  Clock,
  Film,
  GripVertical,
  Loader2,
  MessageSquare,
  Mic,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Save,
  Sparkles,
  Square,
  Trash2,
} from 'lucide-react';
import { EmptyState, formatTimecode, WaveformCanvas } from '@/components/common/CommonUI';
import { WorkflowPipelineStepper } from '@/components/common/WorkflowPipelineStepper';
import { ProviderKindBadge } from '@/components/sidebar/VoicePanel';
import { NumericInput } from '@/components/ui/PropertyControls';
import { frameToMs } from '@/engine/evaluator';
import { findScriptSceneById, getScriptTotalDurationMs } from '@/engine/scriptEngine';
import { useI18n } from '@/i18n/useLocaleStore';
import { apiClient } from '@/services/apiClient';
import { useJobStore } from '@/stores/useJobStore';
import { useLibraryStore } from '@/stores/useLibraryStore';
import { usePlaybackStore } from '@/stores/usePlaybackStore';
import { useProjectStore } from '@/stores/useProjectStore';
import { useVoiceStore } from '@/stores/useVoiceStore';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';
import type { ScriptEntry, ScriptEntryType } from '@/types/models';

const EMOTION_SUGGESTIONS = [
  'neutral',
  'happy',
  'excited',
  'angry',
  'sad',
  'surprised',
  'whisper',
  'nervous',
];

const DELIVERY_SUGGESTIONS = ['normal', 'calm', 'energetic', 'whisper', 'shout', 'dramatic'];

export function ScriptEditorWorkspace() {
  const { t } = useI18n();
  const project = useProjectStore((s) => s.project);
  const activeScriptSceneId = useProjectStore((s) => s.activeScriptSceneId);
  const selectedScriptEntryId = useProjectStore((s) => s.selectedScriptEntryId);
  const setSelectedScriptEntryId = useProjectStore((s) => s.setSelectedScriptEntryId);
  const addScriptScene = useProjectStore((s) => s.addScriptScene);
  const updateScriptScene = useProjectStore((s) => s.updateScriptScene);
  const addScriptEntry = useProjectStore((s) => s.addScriptEntry);
  const updateScriptEntry = useProjectStore((s) => s.updateScriptEntry);
  const deleteScriptEntry = useProjectStore((s) => s.deleteScriptEntry);
  const reorderScriptEntries = useProjectStore((s) => s.reorderScriptEntries);
  const moveScriptEntry = useProjectStore((s) => s.moveScriptEntry);
  const syncScriptScenesToStage = useProjectStore((s) => s.syncScriptScenesToStage);
  const addVoiceClipToTimeline = useProjectStore((s) => s.addVoiceClipToTimeline);
  const saveProject = useProjectStore((s) => s.saveProject);
  const isSaving = useProjectStore((s) => s.isSaving);

  const characters = useLibraryStore((s) => s.characters);
  const upsertSound = useLibraryStore((s) => s.upsertSound);
  const currentFrame = usePlaybackStore((s) => s.currentFrame);
  const pushToast = useJobStore((s) => s.pushToast);
  const switchWorkspace = useWorkspaceStore((s) => s.switchWorkspace);

  const providers = useVoiceStore((s) => s.providers);
  const profiles = useVoiceStore((s) => s.profiles);
  const projectAudioAssets = useVoiceStore((s) => s.projectAudioAssets);
  const generatingKeys = useVoiceStore((s) => s.generatingKeys);
  const entryStatus = useVoiceStore((s) => s.entryStatus);
  const entryErrors = useVoiceStore((s) => s.entryErrors);
  const playingAudioId = useVoiceStore((s) => s.playingAudioId);
  const isAudioPaused = useVoiceStore((s) => s.isAudioPaused);
  const audioCurrentTime = useVoiceStore((s) => s.audioCurrentTime);
  const audioDuration = useVoiceStore((s) => s.audioDuration);
  const generateVoice = useVoiceStore((s) => s.generateVoice);
  const playAudioAsset = useVoiceStore((s) => s.playAudioAsset);
  const pauseAudio = useVoiceStore((s) => s.pauseAudio);
  const stopAudio = useVoiceStore((s) => s.stopAudio);
  const seekAudio = useVoiceStore((s) => s.seekAudio);

  const [dragEntryId, setDragEntryId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; pos: 'before' | 'after' } | null>(null);
  const [addingToTimelineId, setAddingToTimelineId] = useState<string | null>(null);

  const audioById = useMemo(() => {
    const map = new Map(projectAudioAssets.map((a) => [a.audio_asset_id, a]));
    return map;
  }, [projectAudioAssets]);

  const defaultProvider = useMemo(
    () =>
      providers.find((p) => p.is_configured && !p.is_mock) ??
      providers.find((p) => p.is_configured) ??
      providers[0] ??
      null,
    [providers],
  );

  if (!project) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <EmptyState title={t('stage.noProjectTitle')} description={t('script.emptyDesc')} />
      </div>
    );
  }

  const activeScene = findScriptSceneById(project.script, activeScriptSceneId);
  const totalScriptMs = getScriptTotalDurationMs(project.script);

  const handleGenerateEntryVoice = async (entry: ScriptEntry) => {
    if (!activeScene) return;
    if (!entry.text.trim()) {
      pushToast('warning', t('voice.enterTextFirst'));
      return;
    }

    const character = entry.character_id
      ? characters.find((c) => c.character_id === entry.character_id) ?? null
      : null;
    const resolvedProfileId = entry.voice_profile_id || character?.voice_profile_id || null;

    try {
      const audio = await generateVoice(entry.entry_id, {
        project_id: project.meta.project_id,
        text: entry.text,
        entry_id: entry.entry_id,
        character_id: entry.character_id,
        voice_profile_id: resolvedProfileId,
        provider_id: resolvedProfileId ? undefined : defaultProvider?.provider_id,
        provider_voice_id: resolvedProfileId ? undefined : defaultProvider?.voices[0]?.voice_id,
      });
      if (audio) {
        updateScriptEntry(activeScene.script_scene_id, entry.entry_id, {
          audio_asset_id: audio.audio_asset_id,
          audio_duration_ms: audio.duration_ms,
        });
        pushToast(
          'success',
          t('voice.generatedToast', {
            sec: (audio.duration_ms / 1000).toFixed(2),
            provider: audio.provider_id,
          }),
        );
      }
    } catch (err) {
      pushToast(
        'error',
        t('voice.generateFailedToast', {
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  };

  const handleAddAudioToTimeline = async (entry: ScriptEntry) => {
    if (!activeScene || !entry.audio_asset_id) return;
    setAddingToTimelineId(entry.entry_id);
    try {
      const character = entry.character_id
        ? characters.find((c) => c.character_id === entry.character_id)
        : null;
      const speaker =
        entry.entry_type === 'dialogue'
          ? character?.name || t('script.dialogue')
          : entry.narrator_label || t('script.narration');
      const snippet = entry.text.trim().slice(0, 28);
      const label = `${speaker}: ${snippet}${entry.text.trim().length > 28 ? '…' : ''}`;

      const sound = await apiClient.registerVoiceAsSound(
        project.meta.project_id,
        entry.audio_asset_id,
        label,
      );
      upsertSound(sound);
      const startMs = Math.round(frameToMs(currentFrame, project.timeline.fps));
      addVoiceClipToTimeline(sound, startMs, activeScene.linked_stage_scene_id ?? null);
      pushToast('success', t('voice.addedToTimelineToast'));
    } catch (err) {
      pushToast(
        'error',
        t('voice.generateFailedToast', {
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      setAddingToTimelineId(null);
    }
  };

  const entryBadgeStyle = (type: ScriptEntryType) => {
    if (type === 'dialogue') {
      return { color: '#38bdf8', borderColor: 'rgba(56,189,248,0.35)', background: 'rgba(56,189,248,0.1)' };
    }
    if (type === 'narration') {
      return { color: '#c084fc', borderColor: 'rgba(192,132,252,0.35)', background: 'rgba(192,132,252,0.1)' };
    }
    return { color: '#fbbf24', borderColor: 'rgba(251,191,36,0.35)', background: 'rgba(251,191,36,0.1)' };
  };

  return (
    <div className="script-workspace">
      <WorkflowPipelineStepper activeStage="script" />
      {/* Top Action Bar (single Sync to Stage + clear Next Pipeline Step — no duplicate Save button) */}
      <div className="script-topbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <BookOpen size={14} style={{ color: 'var(--accent)', flexShrink: 0 }} />
          <span style={{ fontWeight: 600, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {project.script?.episode_title || project.meta.name}
          </span>
          <span className="badge mono" style={{ flexShrink: 0 }}>
            <Clock size={10} style={{ marginRight: 3 }} />
            {formatTimecode(totalScriptMs)}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <button
            type="button"
            className="btn-xs"
            disabled={!project.script?.scenes.length}
            onClick={() => {
              const count = syncScriptScenesToStage();
              if (count > 0) {
                pushToast('success', t('script.syncedToast', { count }));
              }
            }}
            data-testid="script-sync-stage-btn"
          >
            <Clapperboard size={11} /> {t('script.openInStage')}
          </button>
          <button
            type="button"
            className="btn-xs btn-primary"
            onClick={() => switchWorkspace('director')}
            data-testid="script-next-director-btn"
          >
            <Sparkles size={11} /> {t('pipeline.nextAnalyzeScript')}
          </button>
        </div>
      </div>

      {/* Scrollable Editor Canvas */}
      <div className="script-body">
        {!activeScene ? (
          <div style={{ maxWidth: 420, margin: '48px auto' }}>
            <EmptyState
              title={t('script.emptyTitle')}
              description={t('script.emptyDesc')}
              action={
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => addScriptScene()}
                >
                  <Plus size={13} /> {t('script.addScene')}
                </button>
              }
            />
          </div>
        ) : (
          <div style={{ maxWidth: 920, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* Scene Metadata Card */}
            <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1.2fr 1fr', gap: 8 }}>
                <div className="field-row">
                  <label className="field-label" htmlFor="script-scene-title">
                    {t('script.sceneTitle')}
                  </label>
                  <input
                    id="script-scene-title"
                    type="text"
                    value={activeScene.title}
                    onChange={(e) =>
                      updateScriptScene(activeScene.script_scene_id, { title: e.target.value })
                    }
                  />
                </div>
                <div className="field-row">
                  <label className="field-label" htmlFor="script-scene-location">
                    {t('script.location')}
                  </label>
                  <input
                    id="script-scene-location"
                    type="text"
                    value={activeScene.location}
                    onChange={(e) =>
                      updateScriptScene(activeScene.script_scene_id, { location: e.target.value })
                    }
                  />
                </div>
                <div className="field-row">
                  <label className="field-label" htmlFor="script-scene-tod">
                    {t('script.timeOfDay')}
                  </label>
                  <input
                    id="script-scene-tod"
                    type="text"
                    value={activeScene.time_of_day}
                    onChange={(e) =>
                      updateScriptScene(activeScene.script_scene_id, { time_of_day: e.target.value })
                    }
                  />
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <div className="field-row">
                  <label className="field-label" htmlFor="script-scene-desc">
                    {t('script.description')}
                  </label>
                  <textarea
                    id="script-scene-desc"
                    rows={2}
                    value={activeScene.description}
                    onChange={(e) =>
                      updateScriptScene(activeScene.script_scene_id, { description: e.target.value })
                    }
                  />
                </div>
                <div className="field-row">
                  <label className="field-label" htmlFor="script-scene-notes">
                    {t('script.notes')}
                  </label>
                  <textarea
                    id="script-scene-notes"
                    rows={2}
                    value={activeScene.notes}
                    onChange={(e) =>
                      updateScriptScene(activeScene.script_scene_id, { notes: e.target.value })
                    }
                  />
                </div>
              </div>
            </div>

            {/* Entries Toolbar */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: 8,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="section-title" style={{ margin: 0 }}>
                  {t('script.entriesHeader', { count: activeScene.entries.length })}
                </span>
                <span className="badge mono">{formatTimecode(activeScene.estimated_duration_ms)}</span>
              </div>

              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  className="btn-xs btn-primary"
                  onClick={() =>
                    addScriptEntry(
                      activeScene.script_scene_id,
                      'dialogue',
                      characters[0]?.character_id ?? null,
                    )
                  }
                >
                  <MessageSquare size={11} /> + {t('script.addDialogue')}
                </button>
                <button
                  type="button"
                  className="btn-xs"
                  onClick={() => addScriptEntry(activeScene.script_scene_id, 'narration', null)}
                >
                  <BookOpen size={11} /> + {t('script.addNarration')}
                </button>
                <button
                  type="button"
                  className="btn-xs"
                  onClick={() => addScriptEntry(activeScene.script_scene_id, 'action', null)}
                >
                  <Sparkles size={11} /> + {t('script.addAction')}
                </button>
              </div>
            </div>

            {/* Ordered Entries List */}
            {activeScene.entries.length === 0 ? (
              <EmptyState
                title={t('script.entriesHeader', { count: 0 })}
                description={t('script.emptyEntries')}
              />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {activeScene.entries.map((entry, idx) => {
                  const isSelected = selectedScriptEntryId === entry.entry_id;
                  const character = entry.character_id
                    ? characters.find((c) => c.character_id === entry.character_id) ?? null
                    : null;
                  const effectiveProfileId = entry.voice_profile_id || character?.voice_profile_id || null;
                  const effectiveProfile = effectiveProfileId
                    ? profiles.find((p) => p.voice_profile_id === effectiveProfileId) ?? null
                    : null;
                  const audioAsset = entry.audio_asset_id
                    ? audioById.get(entry.audio_asset_id) ?? null
                    : null;
                  const isGenerating = Boolean(generatingKeys[entry.entry_id]);
                  const status = entryStatus[entry.entry_id] ?? (audioAsset ? 'completed' : 'idle');
                  const errMsg = entryErrors[entry.entry_id];
                  const isThisPlaying =
                    audioAsset && playingAudioId === audioAsset.audio_asset_id && !isAudioPaused;
                  const isThisActive = audioAsset && playingAudioId === audioAsset.audio_asset_id;
                  const progressPct =
                    isThisActive && audioDuration > 0
                      ? Math.max(0, Math.min(100, (audioCurrentTime / audioDuration) * 100))
                      : 0;
                  const dropClass =
                    dropTarget?.id === entry.entry_id
                      ? dropTarget.pos === 'before'
                        ? 'layer-drop-before'
                        : 'layer-drop-after'
                      : '';

                  return (
                    <div
                      key={entry.entry_id}
                      draggable
                      onDragStart={(e) => {
                        setDragEntryId(entry.entry_id);
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/plain', entry.entry_id);
                      }}
                      onDragOver={(e) => {
                        if (!dragEntryId || dragEntryId === entry.entry_id) return;
                        e.preventDefault();
                        const rect = e.currentTarget.getBoundingClientRect();
                        const pos = e.clientY - rect.top < rect.height / 2 ? 'before' : 'after';
                        setDropTarget({ id: entry.entry_id, pos });
                      }}
                      onDragLeave={() => {
                        if (dropTarget?.id === entry.entry_id) setDropTarget(null);
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (dragEntryId && dragEntryId !== entry.entry_id && dropTarget) {
                          reorderScriptEntries(
                            activeScene.script_scene_id,
                            dragEntryId,
                            entry.entry_id,
                            dropTarget.pos,
                          );
                        }
                        setDragEntryId(null);
                        setDropTarget(null);
                      }}
                      onDragEnd={() => {
                        setDragEntryId(null);
                        setDropTarget(null);
                      }}
                      className={`script-entry-card ${isSelected ? 'selected' : ''} ${dropClass}`}
                      onClick={() => setSelectedScriptEntryId(entry.entry_id)}
                    >
                      {/* Entry Header Row */}
                      <div className="script-entry-header">
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
                          <GripVertical size={13} style={{ color: 'var(--text-muted)', cursor: 'grab', flexShrink: 0 }} />
                          <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>
                            #{idx + 1}
                          </span>
                          <span
                            className="badge"
                            style={{ ...entryBadgeStyle(entry.entry_type), fontSize: 10, flexShrink: 0 }}
                          >
                            {t(`script.${entry.entry_type}`)}
                          </span>

                          {entry.entry_type === 'dialogue' && (
                            <select
                              aria-label={t('script.character')}
                              value={entry.character_id ?? ''}
                              style={{ maxWidth: 200, padding: '3px 6px', fontSize: 11 }}
                              onChange={(e) =>
                                updateScriptEntry(activeScene.script_scene_id, entry.entry_id, {
                                  character_id: e.target.value || null,
                                })
                              }
                            >
                              <option value="">{t('script.unassignedChar')}</option>
                              {characters.map((ch) => (
                                <option key={ch.character_id} value={ch.character_id}>
                                  {ch.name}
                                </option>
                              ))}
                            </select>
                          )}

                          {entry.entry_type === 'narration' && (
                            <input
                              type="text"
                              aria-label={t('script.narratorLabel')}
                              value={entry.narrator_label}
                              style={{ maxWidth: 160, padding: '3px 6px', fontSize: 11 }}
                              onChange={(e) =>
                                updateScriptEntry(activeScene.script_scene_id, entry.entry_id, {
                                  narrator_label: e.target.value,
                                })
                              }
                            />
                          )}

                          {entry.entry_type !== 'action' && effectiveProfile && (
                            <span
                              className="badge"
                              style={{
                                fontSize: 10,
                                maxWidth: 180,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                              title={effectiveProfile.name}
                            >
                              <Mic size={9} style={{ marginRight: 3 }} />
                              {effectiveProfile.name}
                            </span>
                          )}
                        </div>

                        {/* Entry Order & Delete Controls */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0 }}>
                          <span className="mono" style={{ fontSize: 10, color: 'var(--text-secondary)', marginRight: 4 }}>
                            {formatTimecode(entry.estimated_duration_ms)}
                          </span>
                          <button
                            type="button"
                            className="btn-ghost btn-icon btn-xs"
                            disabled={idx === 0}
                            title={t('script.moveEntryUp')}
                            aria-label={t('script.moveEntryUp')}
                            onClick={(e) => {
                              e.stopPropagation();
                              moveScriptEntry(activeScene.script_scene_id, entry.entry_id, -1);
                            }}
                          >
                            <ArrowUp size={11} />
                          </button>
                          <button
                            type="button"
                            className="btn-ghost btn-icon btn-xs"
                            disabled={idx === activeScene.entries.length - 1}
                            title={t('script.moveEntryDown')}
                            aria-label={t('script.moveEntryDown')}
                            onClick={(e) => {
                              e.stopPropagation();
                              moveScriptEntry(activeScene.script_scene_id, entry.entry_id, 1);
                            }}
                          >
                            <ArrowDown size={11} />
                          </button>
                          <button
                            type="button"
                            className="btn-ghost btn-icon btn-xs"
                            title={t('common.delete')}
                            aria-label={t('common.delete')}
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteScriptEntry(activeScene.script_scene_id, entry.entry_id);
                            }}
                          >
                            <Trash2 size={11} />
                          </button>
                        </div>
                      </div>

                      {/* Verbatim Text Area (never auto-rewrites user text) */}
                      <textarea
                        rows={entry.entry_type === 'action' ? 2 : 2}
                        value={entry.text}
                        placeholder={
                          entry.entry_type === 'dialogue'
                            ? t('script.textPlaceholderDialogue')
                            : entry.entry_type === 'narration'
                              ? t('script.textPlaceholderNarration')
                              : t('script.textPlaceholderAction')
                        }
                        onChange={(e) =>
                          updateScriptEntry(activeScene.script_scene_id, entry.entry_id, {
                            text: e.target.value,
                          })
                        }
                        style={{ width: '100%', fontSize: 12, lineHeight: 1.5 }}
                      />

                      {/* Entry Metadata Controls */}
                      <div className="script-entry-meta">
                        <div className="script-meta-field">
                          <label>{t('script.emotion')}</label>
                          <input
                            type="text"
                            list="amcs-emotion-list"
                            value={entry.emotion}
                            onChange={(e) =>
                              updateScriptEntry(activeScene.script_scene_id, entry.entry_id, {
                                emotion: e.target.value,
                              })
                            }
                          />
                        </div>
                        <div className="script-meta-field">
                          <label>{t('script.delivery')}</label>
                          <input
                            type="text"
                            list="amcs-delivery-list"
                            value={entry.delivery_style}
                            onChange={(e) =>
                              updateScriptEntry(activeScene.script_scene_id, entry.entry_id, {
                                delivery_style: e.target.value,
                              })
                            }
                          />
                        </div>
                        <div className="script-meta-field">
                          <label>{t('script.pauseBefore')}</label>
                          <NumericInput
                            value={entry.pause_before_ms}
                            min={0}
                            max={30000}
                            step={50}
                            precision={0}
                            unit="ms"
                            compact
                            onChange={(v) =>
                              updateScriptEntry(activeScene.script_scene_id, entry.entry_id, {
                                pause_before_ms: Math.round(v),
                              })
                            }
                          />
                        </div>
                        <div className="script-meta-field">
                          <label>{t('script.pauseAfter')}</label>
                          <NumericInput
                            value={entry.pause_after_ms}
                            min={0}
                            max={30000}
                            step={50}
                            precision={0}
                            unit="ms"
                            compact
                            onChange={(v) =>
                              updateScriptEntry(activeScene.script_scene_id, entry.entry_id, {
                                pause_after_ms: Math.round(v),
                              })
                            }
                          />
                        </div>
                      </div>

                      {/* Voice Generation & Real Audio Preview Strip (Dialogue & Narration) */}
                      {entry.entry_type !== 'action' && (
                        <div className="script-voice-strip">
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            <button
                              type="button"
                              className={`btn-xs ${audioAsset ? '' : 'btn-primary'}`}
                              disabled={isGenerating || !entry.text.trim()}
                              onClick={() => void handleGenerateEntryVoice(entry)}
                            >
                              {isGenerating ? (
                                <Loader2 size={11} className="spin" />
                              ) : audioAsset ? (
                                <RefreshCw size={11} />
                              ) : (
                                <Mic size={11} />
                              )}
                              {isGenerating
                                ? t('voice.statusProcessing')
                                : audioAsset
                                  ? t('voice.regenerate')
                                  : t('voice.generate')}
                            </button>

                            {/* Profile Override Picker */}
                            {profiles.length > 0 && (
                              <select
                                aria-label={t('voice.selectProfileForLine')}
                                value={entry.voice_profile_id ?? ''}
                                style={{ maxWidth: 190, padding: '2px 6px', fontSize: 10 }}
                                onChange={(e) =>
                                  updateScriptEntry(activeScene.script_scene_id, entry.entry_id, {
                                    voice_profile_id: e.target.value || null,
                                  })
                                }
                              >
                                <option value="">
                                  {character?.voice_profile_id
                                    ? t('voice.usingCharacterVoice', { name: character.name })
                                    : t('voice.assignProfileNone')}
                                </option>
                                {profiles.map((prof) => (
                                  <option key={prof.voice_profile_id} value={prof.voice_profile_id}>
                                    {prof.name}
                                  </option>
                                ))}
                              </select>
                            )}

                            {/* Honest Status Pill */}
                            {status === 'processing' && (
                              <span className="badge accent" style={{ fontSize: 10 }}>
                                <Loader2 size={10} className="spin" style={{ marginRight: 3 }} />
                                {t('voice.statusProcessing')}
                              </span>
                            )}
                            {status === 'completed' && audioAsset && (
                              <span className="badge success" style={{ fontSize: 10 }}>
                                <CheckCircle2 size={10} style={{ marginRight: 3 }} />
                                {t('voice.statusCompleted')}
                              </span>
                            )}
                            {status === 'failed' && (
                              <span className="badge danger" style={{ fontSize: 10 }}>
                                <AlertCircle size={10} style={{ marginRight: 3 }} />
                                {t('voice.statusFailed')}
                              </span>
                            )}

                            {!effectiveProfile && entry.entry_type === 'dialogue' && character && (
                              <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                                {t('script.noCharacterVoiceHint')}
                              </span>
                            )}
                          </div>

                          {errMsg && (
                            <div
                              style={{
                                fontSize: 11,
                                color: '#fca5a5',
                                background: 'rgba(239, 68, 68, 0.1)',
                                border: '1px solid rgba(239, 68, 68, 0.25)',
                                borderRadius: 'var(--radius-sm)',
                                padding: '4px 8px',
                              }}
                            >
                              {errMsg}
                            </div>
                          )}

                          {/* Real Audio Playback Bar + Waveform + Seek + Add to Timeline */}
                          {audioAsset && (
                            <div className="voice-player-bar">
                              <button
                                type="button"
                                className="btn-xs btn-icon"
                                title={isThisPlaying ? t('voice.pauseAudio') : t('voice.playAudio')}
                                aria-label={isThisPlaying ? t('voice.pauseAudio') : t('voice.playAudio')}
                                onClick={() =>
                                  isThisPlaying
                                    ? pauseAudio()
                                    : playAudioAsset(project.meta.project_id, audioAsset.audio_asset_id)
                                }
                              >
                                {isThisPlaying ? <Pause size={11} /> : <Play size={11} />}
                              </button>
                              <button
                                type="button"
                                className="btn-xs btn-icon"
                                title={t('voice.stopAudio')}
                                aria-label={t('voice.stopAudio')}
                                onClick={stopAudio}
                              >
                                <Square size={10} />
                              </button>

                              <div
                                className="voice-waveform-scrub"
                                onClick={(e) => {
                                  const rect = e.currentTarget.getBoundingClientRect();
                                  const ratio = Math.max(
                                    0,
                                    Math.min(1, (e.clientX - rect.left) / rect.width),
                                  );
                                  if (!isThisActive) {
                                    playAudioAsset(project.meta.project_id, audioAsset.audio_asset_id);
                                  }
                                  seekAudio(ratio * (audioAsset.duration_ms / 1000));
                                }}
                              >
                                <WaveformCanvas
                                  peaks={audioAsset.waveform_peaks}
                                  height={22}
                                  color={audioAsset.is_mock ? '#f59e0b' : '#2dd4bf'}
                                />
                                {isThisActive && (
                                  <div
                                    className="voice-waveform-progress"
                                    style={{ left: `${progressPct}%` }}
                                  />
                                )}
                              </div>

                              <span className="mono" style={{ fontSize: 10, color: 'var(--text-secondary)', flexShrink: 0 }}>
                                {formatTimecode(audioAsset.duration_ms)}
                              </span>

                              <ProviderKindBadge
                                provider={{
                                  provider_kind: audioAsset.provider_kind,
                                  is_mock: audioAsset.is_mock,
                                  is_configured: true,
                                }}
                              />

                              <button
                                type="button"
                                className="btn-xs"
                                disabled={addingToTimelineId === entry.entry_id}
                                onClick={() => void handleAddAudioToTimeline(entry)}
                              >
                                {addingToTimelineId === entry.entry_id ? (
                                  <Loader2 size={10} className="spin" />
                                ) : (
                                  <Film size={10} />
                                )}
                                {t('voice.addToTimeline')}
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Native HTML5 Datalists for Emotion & Delivery quick suggestions */}
      <datalist id="amcs-emotion-list">
        {EMOTION_SUGGESTIONS.map((v) => (
          <option key={v} value={v} />
        ))}
      </datalist>
      <datalist id="amcs-delivery-list">
        {DELIVERY_SUGGESTIONS.map((v) => (
          <option key={v} value={v} />
        ))}
      </datalist>
    </div>
  );
}
