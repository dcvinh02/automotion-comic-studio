import React, { useMemo, useRef, useState } from 'react';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Captions,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileCode2,
  Merge,
  Palette,
  Play,
  Plus,
  Scissors,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import { frameToMs, msToFrame } from '@/engine/evaluator';
import {
  countSubtitleStyleOverrides,
  ensureSubtitleDocument,
  formatSrtTimestamp,
  parseSrt,
  resolveSubtitleStyle,
  serializeAss,
  serializeSrt,
} from '@/engine/subtitleEngine';
import { SUBTITLE_FONT_OPTIONS } from '@/components/inspector/SubtitleInspectorPanel';
import { useI18n } from '@/i18n/useLocaleStore';
import { useJobStore } from '@/stores/useJobStore';
import { useLibraryStore } from '@/stores/useLibraryStore';
import { usePlaybackStore } from '@/stores/usePlaybackStore';
import { useProjectStore } from '@/stores/useProjectStore';
import type {
  SrtImportResponse,
  SubtitleAlignment,
  SubtitleFontWeight,
  SubtitlePosition,
  SubtitleStyle,
} from '@/types/models';
import { PreviewCanvas } from '@/components/stage/PreviewCanvas';
import { EmptyState } from '@/components/common/CommonUI';

function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function SubtitleStudioWorkspace({ onOpenProjects }: { onOpenProjects?: () => void }) {
  const { t } = useI18n();
  const project = useProjectStore((s) => s.project);
  const selectedSubtitleIds = useProjectStore((s) => s.selectedSubtitleIds);
  const setSelectedSubtitleIds = useProjectStore((s) => s.setSelectedSubtitleIds);
  const addSubtitleSegment = useProjectStore((s) => s.addSubtitleSegment);
  const updateSubtitleSegment = useProjectStore((s) => s.updateSubtitleSegment);
  const deleteSubtitleSegments = useProjectStore((s) => s.deleteSubtitleSegments);
  const duplicateSubtitleSegment = useProjectStore((s) => s.duplicateSubtitleSegment);
  const splitSubtitleSegmentAt = useProjectStore((s) => s.splitSubtitleSegmentAt);
  const mergeSubtitleSegmentsByIds = useProjectStore((s) => s.mergeSubtitleSegmentsByIds);
  const upsertSubtitleStyle = useProjectStore((s) => s.upsertSubtitleStyle);
  const deleteSubtitleStyle = useProjectStore((s) => s.deleteSubtitleStyle);
  const setDefaultSubtitleStyle = useProjectStore((s) => s.setDefaultSubtitleStyle);
  const importSubtitles = useProjectStore((s) => s.importSubtitles);
  const generateSubtitlesFromProjectScript = useProjectStore(
    (s) => s.generateSubtitlesFromProjectScript,
  );

  const characters = useLibraryStore((s) => s.characters);
  const pushToast = useJobStore((s) => s.pushToast);
  const currentFrame = usePlaybackStore((s) => s.currentFrame);
  const setCurrentFrame = usePlaybackStore((s) => s.setCurrentFrame);
  const setPlaying = usePlaybackStore((s) => s.setPlaying);

  const [rightTab, setRightTab] = useState<'styles' | 'import'>('styles');
  const [editingStyleId, setEditingStyleId] = useState<string>('style_classic_white');
  const [srtPaste, setSrtPaste] = useState('');
  const [srtPreview, setSrtPreview] = useState<SrtImportResponse | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const subDoc = useMemo(() => ensureSubtitleDocument(project?.subtitles), [project?.subtitles]);
  const selectedSet = useMemo(() => new Set(selectedSubtitleIds), [selectedSubtitleIds]);

  const activeStyle: SubtitleStyle = useMemo(
    () => resolveSubtitleStyle(subDoc, editingStyleId),
    [subDoc, editingStyleId],
  );

  if (!project) {
    return (
      <div className="canvas-viewport">
        <EmptyState
          title={t('sub.noProjectTitle')}
          description={t('sub.noProjectDesc')}
          action={
            onOpenProjects ? (
              <button type="button" className="btn-primary" onClick={onOpenProjects}>
                {t('project.openOrCreate')}
              </button>
            ) : undefined
          }
        />
      </div>
    );
  }

  const fps = project.timeline.fps;
  const playheadMs = frameToMs(currentFrame, fps);

  const patchActiveStyle = (patch: Partial<SubtitleStyle>) => {
    upsertSubtitleStyle({ ...activeStyle, ...patch });
  };

  const handleCreateCustomStyle = () => {
    const id = `style_custom_${Math.random().toString(36).slice(2, 7)}`;
    const next: SubtitleStyle = {
      ...structuredClone(activeStyle),
      style_id: id,
      name: `${activeStyle.name} Custom`,
      is_builtin: false,
    };
    upsertSubtitleStyle(next);
    setEditingStyleId(id);
    pushToast('success', t('sub.styleCreatedToast', { name: next.name }));
  };

  const handleValidateSrt = (raw: string) => {
    setSrtPaste(raw);
    if (!raw.trim()) {
      setSrtPreview(null);
      return;
    }
    const parsed = parseSrt(raw, {
      defaultStyleId: subDoc.default_style_id,
      sceneId: project.scenes[0]?.scene_id ?? null,
    });
    setSrtPreview(parsed);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    handleValidateSrt(text);
    setRightTab('import');
    if (fileRef.current) fileRef.current.value = '';
  };

  const handleExportSrt = () => {
    const srt = serializeSrt(subDoc.segments, false);
    if (!srt.trim()) {
      pushToast('warning', t('sub.nothingToExport'));
      return;
    }
    downloadText(`${project.meta.name.replace(/\s+/g, '_')}.srt`, srt);
    pushToast('success', t('sub.exportedSrtToast'));
  };

  const handleExportAss = () => {
    const ass = serializeAss(
      subDoc.segments,
      subDoc.styles,
      project.meta.width,
      project.meta.height,
      false,
    );
    if (!ass.trim()) {
      pushToast('warning', t('sub.nothingToExport'));
      return;
    }
    downloadText(`${project.meta.name.replace(/\s+/g, '_')}.ass`, ass);
    pushToast('success', t('sub.exportedAssToast'));
  };

  const handleGenerateFromScript = () => {
    const res = generateSubtitlesFromProjectScript(characters, {
      mode: subDoc.segments.length === 0 ? 'replace' : 'append',
    });
    if (res.total === 0) {
      pushToast('warning', t('sub.noScriptEntriesWarn'));
      return;
    }
    pushToast(
      'success',
      t('sub.generatedFromScriptToast', {
        total: res.total,
        voice: res.voiceSyncedCount,
        estimated: res.estimatedCount,
      }),
    );
  };

  return (
    <div className="subtitle-studio-shell" data-testid="subtitle-studio-workspace">
      {/* LEFT HALF: Multi-Column Subtitle Editor Table + Live Preview Split */}
      <div className="subtitle-studio-main">
        {/* Live Stage Preview Strip (exact same PixiJS renderer as Final Export!) */}
        <div className="subtitle-studio-preview-pane">
          <PreviewCanvas onOpenProjects={onOpenProjects} />
        </div>

        {/* Subtitle Editor Toolbar */}
        <div className="subtitle-studio-toolbar">
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn-primary btn-xs"
              onClick={() =>
                addSubtitleSegment({
                  start_ms: playheadMs,
                  end_ms: playheadMs + 2500,
                  text: t('sub.newDefaultText'),
                })
              }
              data-testid="studio-add-sub-btn"
            >
              <Plus size={12} /> {t('sub.addSubtitle')}
            </button>
            <button
              type="button"
              className="btn-xs"
              onClick={handleGenerateFromScript}
              title={t('sub.generateFromScriptTip')}
              data-testid="studio-gen-script-btn"
            >
              <Sparkles size={11} /> {t('sub.generateFromScript')}
            </button>
            {selectedSubtitleIds.length >= 2 && (
              <button
                type="button"
                className="btn-xs"
                onClick={() => mergeSubtitleSegmentsByIds(selectedSubtitleIds)}
                data-testid="studio-merge-btn"
              >
                <Merge size={11} /> {t('sub.mergeSelected', { count: selectedSubtitleIds.length })}
              </button>
            )}
            {selectedSubtitleIds.length >= 1 && (
              <button
                type="button"
                className="btn-xs btn-danger"
                onClick={() => deleteSubtitleSegments(selectedSubtitleIds)}
              >
                <Trash2 size={11} /> {t('common.delete')} ({selectedSubtitleIds.length})
              </button>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <button
              type="button"
              className="btn-xs"
              onClick={() => {
                setRightTab('import');
                fileRef.current?.click();
              }}
            >
              <Upload size={11} /> {t('sub.importSrt')}
            </button>
            <button type="button" className="btn-xs" onClick={handleExportSrt}>
              <Download size={11} /> SRT
            </button>
            <button type="button" className="btn-xs" onClick={handleExportAss}>
              <FileCode2 size={11} /> ASS
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".srt,text/plain"
              style={{ display: 'none' }}
              onChange={handleFileUpload}
            />
          </div>
        </div>

        {/* Multi-Column Subtitle Table: # | Start | End | Duration | Speaker | Style | Text | Actions */}
        <div className="subtitle-studio-table-wrap">
          {subDoc.segments.length === 0 ? (
            <EmptyState
              title={t('sub.emptyTitle')}
              description={t('sub.emptyDesc')}
            />
          ) : (
            <table className="subtitle-table">
              <thead>
                <tr>
                  <th style={{ width: 32 }}>#</th>
                  <th style={{ width: 88 }}>{t('sub.colStart')}</th>
                  <th style={{ width: 88 }}>{t('sub.colEnd')}</th>
                  <th style={{ width: 64 }}>{t('sub.colDuration')}</th>
                  <th style={{ width: 112 }}>{t('sub.colSpeaker')}</th>
                  <th style={{ width: 118 }}>{t('sub.colStyle')}</th>
                  <th>{t('sub.colText')}</th>
                  <th style={{ width: 108 }}>{t('sub.colActions')}</th>
                </tr>
              </thead>
              <tbody>
                {subDoc.segments.map((seg, idx) => {
                  const isSel = selectedSet.has(seg.subtitle_id);
                  const durMs = Math.max(100, seg.end_ms - seg.start_ms);
                  return (
                    <tr
                      key={seg.subtitle_id}
                      className={`${isSel ? 'selected' : ''} ${!seg.enabled ? 'disabled-row' : ''}`}
                      data-studio-sub-row={seg.subtitle_id}
                      onClick={(e) => {
                        if (e.shiftKey || e.metaKey || e.ctrlKey) {
                          const next = new Set(selectedSubtitleIds);
                          if (next.has(seg.subtitle_id)) next.delete(seg.subtitle_id);
                          else next.add(seg.subtitle_id);
                          setSelectedSubtitleIds([...next], seg.subtitle_id);
                        } else {
                          setSelectedSubtitleIds([seg.subtitle_id], seg.subtitle_id);
                          setPlaying(false);
                          setCurrentFrame(msToFrame(seg.start_ms, fps));
                          setEditingStyleId(seg.style_id);
                        }
                      }}
                    >
                      <td className="mono" style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                        {idx + 1}
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <input
                          type="number"
                          className="mono"
                          step={0.1}
                          min={0}
                          value={Number((seg.start_ms / 1000).toFixed(2))}
                          onChange={(e) => {
                            const nextStart = Math.max(0, Math.round(Number(e.target.value) * 1000));
                            updateSubtitleSegment(seg.subtitle_id, {
                              start_ms: nextStart,
                              end_ms: Math.max(nextStart + 150, seg.end_ms),
                              timing_source: 'manual',
                            });
                          }}
                          style={{ width: '100%', fontSize: 11, padding: '2px 4px' }}
                        />
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <input
                          type="number"
                          className="mono"
                          step={0.1}
                          min={0.1}
                          value={Number((seg.end_ms / 1000).toFixed(2))}
                          onChange={(e) => {
                            const nextEnd = Math.max(
                              seg.start_ms + 150,
                              Math.round(Number(e.target.value) * 1000),
                            );
                            updateSubtitleSegment(seg.subtitle_id, {
                              end_ms: nextEnd,
                              timing_source: 'manual',
                            });
                          }}
                          style={{ width: '100%', fontSize: 11, padding: '2px 4px' }}
                        />
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <input
                          type="number"
                          className="mono"
                          step={0.1}
                          min={0.15}
                          value={Number((durMs / 1000).toFixed(2))}
                          onChange={(e) => {
                            const nextDur = Math.max(150, Math.round(Number(e.target.value) * 1000));
                            updateSubtitleSegment(seg.subtitle_id, {
                              end_ms: seg.start_ms + nextDur,
                              timing_source: 'manual',
                            });
                          }}
                          style={{ width: '100%', fontSize: 11, padding: '2px 4px' }}
                        />
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <select
                          value={seg.speaker_character_id ?? ''}
                          onChange={(e) => {
                            const cid = e.target.value || null;
                            const char = cid ? characters.find((c) => c.character_id === cid) : null;
                            updateSubtitleSegment(seg.subtitle_id, {
                              speaker_character_id: cid,
                              speaker_name: char ? char.name : '',
                            });
                          }}
                          style={{ width: '100%', fontSize: 11, padding: '2px 4px' }}
                        >
                          <option value="">{t('sub.speakerNone')}</option>
                          {characters.map((ch) => (
                            <option key={ch.character_id} value={ch.character_id}>
                              {ch.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <select
                          value={seg.style_id}
                          onChange={(e) => {
                            updateSubtitleSegment(seg.subtitle_id, { style_id: e.target.value });
                            setEditingStyleId(e.target.value);
                          }}
                          style={{ width: '100%', fontSize: 11, padding: '2px 4px' }}
                        >
                          {subDoc.styles.map((st) => (
                            <option key={st.style_id} value={st.style_id}>
                              {st.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <textarea
                          rows={2}
                          value={seg.text}
                          onFocus={() => {
                            setSelectedSubtitleIds([seg.subtitle_id], seg.subtitle_id);
                            setPlaying(false);
                            setCurrentFrame(msToFrame(seg.start_ms, fps));
                          }}
                          onChange={(e) =>
                            updateSubtitleSegment(seg.subtitle_id, { text: e.target.value }, false)
                          }
                          style={{
                            width: '100%',
                            fontSize: 11.5,
                            padding: '3px 5px',
                            resize: 'vertical',
                            background: 'var(--surface-base)',
                            border: '1px solid var(--border-subtle)',
                            borderRadius: 4,
                            color: 'var(--text-primary)',
                          }}
                        />
                        {seg.timing_source !== 'manual' && (
                          <span
                            className={`tag-pill ${seg.timing_source === 'voice_duration' ? 'verified' : 'warning'}`}
                            style={{ fontSize: 9, marginTop: 2, marginRight: 4 }}
                          >
                            {seg.timing_source === 'voice_duration'
                              ? t('sub.timingVoice')
                              : seg.timing_source === 'imported_srt'
                                ? 'SRT'
                                : t('sub.timingEstimated')}
                          </span>
                        )}
                        {countSubtitleStyleOverrides(seg) > 0 && (
                          <span
                            className="tag-pill warning mono"
                            data-testid={`studio-sub-override-badge-${seg.subtitle_id}`}
                            style={{ fontSize: 9, marginTop: 2 }}
                          >
                            {t('sub.overrideCountBadge', { count: countSubtitleStyleOverrides(seg) })}
                          </span>
                        )}
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <div style={{ display: 'flex', gap: 2, justifyContent: 'flex-end' }}>
                          <button
                            type="button"
                            className="btn-ghost btn-icon btn-xs"
                            title={t('sub.jumpToStart')}
                            onClick={() => {
                              setPlaying(false);
                              setCurrentFrame(msToFrame(seg.start_ms, fps));
                            }}
                          >
                            <Play size={10} />
                          </button>
                          <button
                            type="button"
                            className="btn-ghost btn-icon btn-xs"
                            title={t('sub.split')}
                            onClick={() =>
                              splitSubtitleSegmentAt(
                                seg.subtitle_id,
                                playheadMs > seg.start_ms + 80 && playheadMs < seg.end_ms - 80
                                  ? playheadMs
                                  : undefined,
                              )
                            }
                          >
                            <Scissors size={10} />
                          </button>
                          <button
                            type="button"
                            className="btn-ghost btn-icon btn-xs"
                            title={t('sub.duplicate')}
                            onClick={() => duplicateSubtitleSegment(seg.subtitle_id)}
                          >
                            <Copy size={10} />
                          </button>
                          <button
                            type="button"
                            className="btn-ghost btn-icon btn-xs"
                            title={seg.enabled ? t('sub.hideSegment') : t('sub.showSegment')}
                            onClick={() => updateSubtitleSegment(seg.subtitle_id, { enabled: !seg.enabled })}
                          >
                            {seg.enabled ? <Eye size={10} /> : <EyeOff size={10} />}
                          </button>
                          <button
                            type="button"
                            className="btn-ghost btn-icon btn-xs"
                            title={t('common.delete')}
                            onClick={() => deleteSubtitleSegments([seg.subtitle_id])}
                          >
                            <Trash2 size={10} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* RIGHT SIDEBAR: Reusable Subtitle Style Designer & SRT Import/Export Validator */}
      <div className="subtitle-studio-side">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 4,
            padding: 6,
            borderBottom: '1px solid var(--border-subtle)',
          }}
        >
          <button
            type="button"
            className={`btn-xs ${rightTab === 'styles' ? 'btn-primary' : 'btn-ghost'}`}
            style={{ justifyContent: 'center' }}
            onClick={() => setRightTab('styles')}
            data-testid="sub-tab-styles"
          >
            <Palette size={11} /> {t('sub.stylePresets')}
          </button>
          <button
            type="button"
            className={`btn-xs ${rightTab === 'import' ? 'btn-primary' : 'btn-ghost'}`}
            style={{ justifyContent: 'center' }}
            onClick={() => setRightTab('import')}
            data-testid="sub-tab-import"
          >
            <Captions size={11} /> SRT / ASS
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {rightTab === 'styles' ? (
            <>
              {/* Editable Preset Chips */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {subDoc.styles.map((st) => (
                  <button
                    key={st.style_id}
                    type="button"
                    className={`btn-xs ${activeStyle.style_id === st.style_id ? 'btn-primary' : ''}`}
                    onClick={() => setEditingStyleId(st.style_id)}
                    data-style-preset={st.style_id}
                  >
                    {st.name}
                    {subDoc.default_style_id === st.style_id ? ' ★' : ''}
                  </button>
                ))}
                <button
                  type="button"
                  className="btn-xs"
                  onClick={handleCreateCustomStyle}
                  title={t('sub.newStyle')}
                >
                  <Plus size={10} /> {t('sub.newStyle')}
                </button>
              </div>

              <div style={{ display: 'flex', gap: 5 }}>
                <button
                  type="button"
                  className="btn-xs"
                  style={{ flex: 1, justifyContent: 'center' }}
                  onClick={() => setDefaultSubtitleStyle(activeStyle.style_id)}
                >
                  {t('sub.setDefaultStyle')}
                </button>
                {selectedSubtitleIds.length > 0 && (
                  <button
                    type="button"
                    className="btn-primary btn-xs"
                    style={{ flex: 1, justifyContent: 'center' }}
                    onClick={() => {
                      for (const sid of selectedSubtitleIds) {
                        updateSubtitleSegment(sid, { style_id: activeStyle.style_id });
                      }
                      pushToast('info', t('sub.appliedStyleToast', { name: activeStyle.name }));
                    }}
                  >
                    {t('sub.applyToSelected')}
                  </button>
                )}
                {!activeStyle.is_builtin && (
                  <button
                    type="button"
                    className="btn-ghost btn-icon btn-xs"
                    title={t('common.delete')}
                    onClick={() => {
                      deleteSubtitleStyle(activeStyle.style_id);
                      setEditingStyleId(subDoc.styles[0]?.style_id ?? 'style_classic_white');
                    }}
                  >
                    <Trash2 size={11} />
                  </button>
                )}
              </div>

              {/* Editable Style Parameters */}
              <div className="inspector-section" style={{ gap: 7 }}>
                <div className="field-row">
                  <label className="field-label">{t('sub.styleName')}</label>
                  <input
                    value={activeStyle.name}
                    onChange={(e) => patchActiveStyle({ name: e.target.value })}
                  />
                </div>
                <div className="field-row">
                  <label className="field-label">{t('sub.fontFamily')}</label>
                  <select
                    value={activeStyle.font_family}
                    onChange={(e) => patchActiveStyle({ font_family: e.target.value })}
                  >
                    {SUBTITLE_FONT_OPTIONS.map((f) => (
                      <option key={f.value} value={f.value}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}>
                    <input
                      type="checkbox"
                      checked={Boolean(activeStyle.italic)}
                      onChange={(e) => patchActiveStyle({ italic: e.target.checked })}
                    />
                    {t('sub.italic')}
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}>
                    <input
                      type="checkbox"
                      checked={Boolean(activeStyle.underline)}
                      onChange={(e) => patchActiveStyle({ underline: e.target.checked })}
                    />
                    {t('sub.underline')}
                  </label>
                </div>
                <div className="field-grid">
                  <div className="field-row">
                    <label className="field-label">{t('sub.fontSize')} (px)</label>
                    <input
                      type="number"
                      min={14}
                      max={120}
                      value={activeStyle.font_size}
                      onChange={(e) => patchActiveStyle({ font_size: Number(e.target.value) || 40 })}
                    />
                  </div>
                  <div className="field-row">
                    <label className="field-label">{t('sub.fontWeight')}</label>
                    <select
                      value={activeStyle.font_weight}
                      onChange={(e) =>
                        patchActiveStyle({ font_weight: e.target.value as SubtitleFontWeight })
                      }
                    >
                      <option value="normal">Normal</option>
                      <option value="semibold">Semibold</option>
                      <option value="bold">Bold</option>
                      <option value="extrabold">Extra Bold</option>
                    </select>
                  </div>
                </div>

                <div className="field-grid">
                  <div className="field-row">
                    <label className="field-label">{t('sub.textColor')}</label>
                    <input
                      type="color"
                      value={activeStyle.text_color}
                      onChange={(e) => patchActiveStyle({ text_color: e.target.value })}
                    />
                  </div>
                  <div className="field-row">
                    <label className="field-label">{t('sub.outlineColor')}</label>
                    <input
                      type="color"
                      value={activeStyle.outline_color}
                      onChange={(e) => patchActiveStyle({ outline_color: e.target.value })}
                    />
                  </div>
                </div>

                <div className="field-grid">
                  <div className="field-row">
                    <label className="field-label">{t('sub.outlineWidth')}</label>
                    <input
                      type="number"
                      min={0}
                      max={12}
                      step={0.5}
                      value={activeStyle.outline_width}
                      onChange={(e) =>
                        patchActiveStyle({ outline_width: Math.max(0, Number(e.target.value) || 0) })
                      }
                    />
                  </div>
                  <div className="field-row">
                    <label className="field-label">{t('sub.lineSpacing')}</label>
                    <input
                      type="number"
                      min={1}
                      max={2.4}
                      step={0.05}
                      value={activeStyle.line_spacing}
                      onChange={(e) =>
                        patchActiveStyle({ line_spacing: Math.max(1, Number(e.target.value) || 1.25) })
                      }
                    />
                  </div>
                </div>

                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                  <input
                    type="checkbox"
                    checked={activeStyle.shadow_enabled}
                    onChange={(e) => patchActiveStyle({ shadow_enabled: e.target.checked })}
                  />
                  {t('sub.shadowEnabled')}
                </label>

                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                  <input
                    type="checkbox"
                    checked={activeStyle.background_enabled}
                    onChange={(e) => patchActiveStyle({ background_enabled: e.target.checked })}
                  />
                  {t('sub.backgroundBox')}
                </label>

                {activeStyle.background_enabled && (
                  <div className="field-grid">
                    <div className="field-row">
                      <label className="field-label">{t('sub.bgColor')}</label>
                      <input
                        type="color"
                        value={activeStyle.background_color}
                        onChange={(e) => patchActiveStyle({ background_color: e.target.value })}
                      />
                    </div>
                    <div className="field-row">
                      <label className="field-label">
                        {t('sub.bgOpacity')} ({Math.round(activeStyle.background_opacity * 100)}%)
                      </label>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={activeStyle.background_opacity}
                        onChange={(e) =>
                          patchActiveStyle({ background_opacity: Number(e.target.value) })
                        }
                      />
                    </div>
                  </div>
                )}

                <div className="field-grid">
                  <div className="field-row">
                    <label className="field-label">{t('sub.position')}</label>
                    <select
                      value={activeStyle.position}
                      onChange={(e) =>
                        patchActiveStyle({ position: e.target.value as SubtitlePosition })
                      }
                    >
                      <option value="bottom">{t('sub.posBottom')}</option>
                      <option value="center">{t('sub.posCenter')}</option>
                      <option value="top">{t('sub.posTop')}</option>
                    </select>
                  </div>
                  <div className="field-row">
                    <label className="field-label">{t('sub.alignment')}</label>
                    <div style={{ display: 'flex', gap: 3 }}>
                      {(['left', 'center', 'right'] as SubtitleAlignment[]).map((al) => (
                        <button
                          key={al}
                          type="button"
                          className={`btn-icon btn-xs ${activeStyle.alignment === al ? 'btn-primary' : ''}`}
                          onClick={() => patchActiveStyle({ alignment: al })}
                          aria-label={al}
                        >
                          {al === 'left' ? (
                            <AlignLeft size={11} />
                          ) : al === 'right' ? (
                            <AlignRight size={11} />
                          ) : (
                            <AlignCenter size={11} />
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="field-grid">
                  <div className="field-row">
                    <label className="field-label">{t('sub.marginX')} (px)</label>
                    <input
                      type="number"
                      min={0}
                      max={400}
                      value={activeStyle.margin_x}
                      onChange={(e) => patchActiveStyle({ margin_x: Math.max(0, Number(e.target.value) || 0) })}
                    />
                  </div>
                  <div className="field-row">
                    <label className="field-label">{t('sub.marginY')} (px)</label>
                    <input
                      type="number"
                      min={0}
                      max={400}
                      value={activeStyle.margin_y}
                      onChange={(e) => patchActiveStyle({ margin_y: Math.max(0, Number(e.target.value) || 0) })}
                    />
                  </div>
                </div>

                <div className="field-grid">
                  <div className="field-row">
                    <label className="field-label">{t('sub.maxWidth')} (%)</label>
                    <input
                      type="number"
                      min={30}
                      max={98}
                      value={activeStyle.max_width_pct}
                      onChange={(e) =>
                        patchActiveStyle({
                          max_width_pct: Math.max(30, Math.min(98, Number(e.target.value) || 82)),
                        })
                      }
                    />
                  </div>
                  <div className="field-row" style={{ justifyContent: 'flex-end' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                      <input
                        type="checkbox"
                        checked={activeStyle.word_wrap}
                        onChange={(e) => patchActiveStyle({ word_wrap: e.target.checked })}
                      />
                      {t('sub.wordWrap')}
                    </label>
                  </div>
                </div>
              </div>
            </>
          ) : (
            /* SRT Import Validation & Preview + ASS/SRT Export */
            <div className="inspector-section" style={{ gap: 8 }}>
              <div className="inspector-section-title">
                <span>{t('sub.srtImportBoxTitle')}</span>
                <button
                  type="button"
                  className="btn-xs"
                  onClick={() => fileRef.current?.click()}
                >
                  <Upload size={11} /> {t('common.browse')}
                </button>
              </div>
              <textarea
                rows={8}
                value={srtPaste}
                onChange={(e) => handleValidateSrt(e.target.value)}
                placeholder={'1\n00:00:00,500 --> 00:00:03,000\nXin chào thế giới!\nDòng thứ hai có dấu tiếng Việt.'}
                className="mono"
                style={{
                  width: '100%',
                  fontSize: 11,
                  padding: 6,
                  background: 'var(--surface-base)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 4,
                  color: 'var(--text-primary)',
                }}
                data-testid="srt-paste-textarea"
              />
              {srtPreview && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                    <span className={`tag-pill ${srtPreview.valid ? 'verified' : 'warning'}`}>
                      {srtPreview.valid ? t('sub.validSrt') : t('sub.invalidSrt')}
                    </span>
                    <span>
                      {srtPreview.segments.length} {t('sub.cuesLabel')}
                    </span>
                  </div>
                  {srtPreview.issues.length > 0 && (
                    <div
                      style={{
                        maxHeight: 90,
                        overflowY: 'auto',
                        fontSize: 10,
                        color: 'var(--warning)',
                        background: 'rgba(245, 158, 11, 0.08)',
                        padding: 6,
                        borderRadius: 4,
                      }}
                    >
                      {srtPreview.issues.map((iss, idx) => (
                        <div key={idx}>
                          L{iss.line} [{iss.severity}]: {iss.message}
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 5 }}>
                    <button
                      type="button"
                      className="btn-primary btn-xs"
                      disabled={srtPreview.segments.length === 0}
                      onClick={() => {
                        const n = importSubtitles(srtPreview.segments, 'replace');
                        pushToast('success', t('sub.importedCountToast', { count: n }));
                      }}
                      data-testid="srt-apply-replace-btn"
                    >
                      {t('sub.importReplace')}
                    </button>
                    <button
                      type="button"
                      className="btn-xs"
                      disabled={srtPreview.segments.length === 0}
                      onClick={() => {
                        const n = importSubtitles(srtPreview.segments, 'append');
                        pushToast('success', t('sub.importedCountToast', { count: n }));
                      }}
                      data-testid="srt-apply-append-btn"
                    >
                      {t('sub.importAppend')}
                    </button>
                  </div>
                </div>
              )}

              <div
                style={{
                  borderTop: '1px solid var(--border-subtle)',
                  paddingTop: 8,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                <div className="field-label">{t('sub.exportFilesTitle')}</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button type="button" className="btn-primary btn-xs" style={{ flex: 1, justifyContent: 'center' }} onClick={handleExportSrt}>
                    <Download size={11} /> {t('sub.exportSrt')}
                  </button>
                  <button type="button" className="btn-xs" style={{ flex: 1, justifyContent: 'center' }} onClick={handleExportAss}>
                    <FileCode2 size={11} /> {t('sub.exportAss')}
                  </button>
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.4 }}>
                  {t('sub.assNote')}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
