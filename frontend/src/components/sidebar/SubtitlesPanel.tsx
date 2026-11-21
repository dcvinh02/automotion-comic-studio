import React, { useMemo, useRef, useState } from 'react';
import {
  Captions,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileCode2,
  Merge,
  Plus,
  Scissors,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import { frameToMs, msToFrame } from '@/engine/evaluator';
import {
  ensureSubtitleDocument,
  formatSrtTimestamp,
  parseSrt,
  serializeAss,
  serializeSrt,
} from '@/engine/subtitleEngine';
import { useI18n } from '@/i18n/useLocaleStore';
import { useJobStore } from '@/stores/useJobStore';
import { useLibraryStore } from '@/stores/useLibraryStore';
import { usePlaybackStore } from '@/stores/usePlaybackStore';
import { useProjectStore } from '@/stores/useProjectStore';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';
import type { SrtImportResponse } from '@/types/models';
import { EmptyState } from '@/components/common/CommonUI';
import { SearchInput } from '@/components/ui/SearchInput';

function downloadTextFile(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function SubtitlesPanel() {
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
  const importSubtitles = useProjectStore((s) => s.importSubtitles);
  const generateSubtitlesFromProjectScript = useProjectStore(
    (s) => s.generateSubtitlesFromProjectScript,
  );

  const characters = useLibraryStore((s) => s.characters);
  const pushToast = useJobStore((s) => s.pushToast);
  const currentFrame = usePlaybackStore((s) => s.currentFrame);
  const setCurrentFrame = usePlaybackStore((s) => s.setCurrentFrame);
  const setPlaying = usePlaybackStore((s) => s.setPlaying);
  const setCenterMode = useWorkspaceStore((s) => s.setCenterMode);

  const [search, setSearch] = useState('');
  const [importPreview, setImportPreview] = useState<SrtImportResponse | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const subDoc = useMemo(() => ensureSubtitleDocument(project?.subtitles), [project?.subtitles]);
  const selectedSet = useMemo(() => new Set(selectedSubtitleIds), [selectedSubtitleIds]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return subDoc.segments;
    return subDoc.segments.filter(
      (s) =>
        s.text.toLowerCase().includes(q) ||
        s.speaker_name.toLowerCase().includes(q),
    );
  }, [subDoc.segments, search]);

  if (!project) {
    return (
      <EmptyState
        title={t('sub.noProjectTitle')}
        description={t('sub.noProjectDesc')}
      />
    );
  }

  const fps = project.timeline.fps;
  const playheadMs = frameToMs(currentFrame, fps);

  const handleAddSubtitle = () => {
    addSubtitleSegment({
      start_ms: playheadMs,
      end_ms: playheadMs + 2500,
      text: t('sub.newDefaultText'),
    });
  };

  const handlePickSrtFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const content = await file.text();
      const parsed = parseSrt(content, {
        defaultStyleId: subDoc.default_style_id,
        sceneId: project.scenes[0]?.scene_id ?? null,
      });
      setImportPreview(parsed);
      if (!parsed.valid) {
        pushToast('warning', t('sub.importValidationWarn', { count: parsed.issues.length }));
      }
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : 'SRT read error');
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
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

  const handleExportSrt = () => {
    const srt = serializeSrt(subDoc.segments, false);
    if (!srt.trim()) {
      pushToast('warning', t('sub.nothingToExport'));
      return;
    }
    downloadTextFile(`${project.meta.name.replace(/\s+/g, '_')}.srt`, srt);
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
    downloadTextFile(`${project.meta.name.replace(/\s+/g, '_')}.ass`, ass);
    pushToast('success', t('sub.exportedAssToast'));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }} data-testid="subtitles-sidebar-panel">
      {/* Primary Actions */}
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn-primary btn-xs"
          style={{ flex: 1, justifyContent: 'center' }}
          onClick={handleAddSubtitle}
          data-testid="sub-add-btn"
        >
          <Plus size={12} /> {t('sub.addSubtitle')}
        </button>
        <button
          type="button"
          className="btn-xs"
          onClick={() => setCenterMode('subtitles')}
          data-testid="sub-open-studio-btn"
        >
          <Captions size={12} /> {t('sub.openStudio')}
        </button>
      </div>

      {/* Script/Voice Sync + SRT Import/Export */}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn-xs"
          style={{ flex: 1, justifyContent: 'center' }}
          onClick={handleGenerateFromScript}
          title={t('sub.generateFromScriptTip')}
          data-testid="sub-generate-script-btn"
        >
          <Sparkles size={11} /> {t('sub.generateFromScript')}
        </button>
        <button
          type="button"
          className="btn-xs"
          onClick={() => fileRef.current?.click()}
          title={t('sub.importSrt')}
          data-testid="sub-import-srt-btn"
        >
          <Upload size={11} /> SRT
        </button>
        <button
          type="button"
          className="btn-xs"
          onClick={handleExportSrt}
          title={t('sub.exportSrt')}
          data-testid="sub-export-srt-btn"
        >
          <Download size={11} /> SRT
        </button>
        <button
          type="button"
          className="btn-xs"
          onClick={handleExportAss}
          title={t('sub.exportAss')}
          data-testid="sub-export-ass-btn"
        >
          <FileCode2 size={11} /> ASS
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".srt,text/plain"
          style={{ display: 'none' }}
          onChange={handlePickSrtFile}
        />
      </div>

      {/* SRT Import Preview & Validation Card */}
      {importPreview && (
        <div className="inspector-section" style={{ gap: 5 }} data-testid="srt-import-preview">
          <div className="inspector-section-title">
            <span>{t('sub.importPreviewTitle')}</span>
            <span className={`tag-pill ${importPreview.valid ? 'verified' : 'warning'}`}>
              {importPreview.segments.length} {t('sub.cuesLabel')}
            </span>
          </div>
          {importPreview.issues.length > 0 && (
            <div style={{ maxHeight: 72, overflowY: 'auto', fontSize: 10, color: 'var(--warning)' }}>
              {importPreview.issues.slice(0, 6).map((iss, idx) => (
                <div key={idx}>
                  L{iss.line} [{iss.severity}]: {iss.message}
                </div>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              type="button"
              className="btn-primary btn-xs"
              disabled={importPreview.segments.length === 0}
              onClick={() => {
                const n = importSubtitles(importPreview.segments, 'replace');
                setImportPreview(null);
                pushToast('success', t('sub.importedCountToast', { count: n }));
              }}
            >
              {t('sub.importReplace')}
            </button>
            <button
              type="button"
              className="btn-xs"
              disabled={importPreview.segments.length === 0}
              onClick={() => {
                const n = importSubtitles(importPreview.segments, 'append');
                setImportPreview(null);
                pushToast('success', t('sub.importedCountToast', { count: n }));
              }}
            >
              {t('sub.importAppend')}
            </button>
            <button type="button" className="btn-ghost btn-xs" onClick={() => setImportPreview(null)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {/* Multi-Select Bulk Action Strip */}
      {selectedSubtitleIds.length >= 2 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 4,
            padding: '4px 6px',
            borderRadius: 5,
            background: 'rgba(245, 158, 11, 0.12)',
            border: '1px solid rgba(245, 158, 11, 0.3)',
            fontSize: 10,
          }}
        >
          <span>{t('sub.selectedCount', { count: selectedSubtitleIds.length })}</span>
          <div style={{ display: 'flex', gap: 3 }}>
            <button
              type="button"
              className="btn-xs"
              onClick={() => mergeSubtitleSegmentsByIds(selectedSubtitleIds)}
            >
              <Merge size={10} /> {t('sub.merge')}
            </button>
            <button
              type="button"
              className="btn-xs btn-danger"
              onClick={() => deleteSubtitleSegments(selectedSubtitleIds)}
            >
              <Trash2 size={10} />
            </button>
          </div>
        </div>
      )}

      <SearchInput value={search} onChange={setSearch} placeholder={t('sub.searchPlaceholder')} />

      {/* Subtitle Cue List */}
      {filtered.length === 0 ? (
        <EmptyState
          title={t('sub.emptyTitle')}
          description={t('sub.emptyDesc')}
          action={
            <button type="button" className="btn-primary btn-xs" onClick={handleAddSubtitle}>
              <Plus size={12} /> {t('sub.addSubtitle')}
            </button>
          }
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {filtered.map((seg, idx) => {
            const isSel = selectedSet.has(seg.subtitle_id);
            const durSec = ((seg.end_ms - seg.start_ms) / 1000).toFixed(2);
            return (
              <div
                key={seg.subtitle_id}
                className="list-card"
                data-subtitle-card={seg.subtitle_id}
                style={{
                  borderColor: isSel ? '#fbbf24' : undefined,
                  opacity: seg.enabled ? 1 : 0.55,
                  cursor: 'pointer',
                  gap: 4,
                }}
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
                  }
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
                  <span className="mono" style={{ fontSize: 9.5, color: '#fbbf24', fontWeight: 600 }}>
                    #{idx + 1} · {formatSrtTimestamp(seg.start_ms).slice(3, 12)} → {formatSrtTimestamp(seg.end_ms).slice(3, 12)} ({durSec}s)
                  </span>
                  <div style={{ display: 'flex', gap: 1 }} onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className="btn-ghost btn-icon btn-xs"
                      title={t('sub.split')}
                      onClick={() => splitSubtitleSegmentAt(seg.subtitle_id)}
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
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                  {seg.speaker_name && <span className="tag-pill">{seg.speaker_name}</span>}
                  {seg.timing_source === 'estimated' && (
                    <span className="tag-pill warning">{t('sub.timingEstimated')}</span>
                  )}
                  {seg.timing_source === 'voice_duration' && (
                    <span className="tag-pill verified">{t('sub.timingVoice')}</span>
                  )}
                </div>

                <textarea
                  rows={2}
                  value={seg.text}
                  onClick={(e) => e.stopPropagation()}
                  onFocus={() => {
                    if (!isSel) {
                      setSelectedSubtitleIds([seg.subtitle_id], seg.subtitle_id);
                      setPlaying(false);
                      setCurrentFrame(msToFrame(seg.start_ms, fps));
                    }
                  }}
                  onChange={(e) =>
                    updateSubtitleSegment(seg.subtitle_id, { text: e.target.value }, false)
                  }
                  placeholder={t('sub.textPlaceholder')}
                  style={{
                    width: '100%',
                    resize: 'vertical',
                    fontSize: 11.5,
                    lineHeight: 1.35,
                    padding: '4px 6px',
                    background: 'var(--surface-base)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 4,
                    color: 'var(--text-primary)',
                  }}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
