import { useRef, useState } from 'react';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Captions,
  Clock,
  Copy,
  ExternalLink,
  Italic,
  LayoutTemplate,
  Palette,
  Play,
  RotateCcw,
  Scissors,
  Trash2,
  Type,
  Underline,
} from 'lucide-react';
import { CollapsibleSection } from '@/components/ui/CollapsibleSection';
import { NumericInput } from '@/components/ui/PropertyControls';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { msToFrame } from '@/engine/evaluator';
import {
  countSubtitleStyleOverrides,
  ensureSubtitleDocument,
  resolveEffectiveSubtitleStyle,
  resolveSubtitleStyle,
} from '@/engine/subtitleEngine';
import { useI18n } from '@/i18n/useLocaleStore';
import { useJobStore } from '@/stores/useJobStore';
import { useLibraryStore } from '@/stores/useLibraryStore';
import { usePlaybackStore } from '@/stores/usePlaybackStore';
import { useProjectStore } from '@/stores/useProjectStore';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';
import type {
  SubtitleAlignment,
  SubtitleFontWeight,
  SubtitlePosition,
  SubtitleSegment,
  SubtitleStyle,
  SubtitleStyleOverride,
} from '@/types/models';

export const SUBTITLE_FONT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "Inter, 'Noto Sans', Arial, sans-serif", label: 'Inter / Noto Sans' },
  { value: "Georgia, 'Noto Serif', serif", label: 'Georgia / Noto Serif' },
  { value: "'Arial Black', Impact, 'Noto Sans', sans-serif", label: 'Bold Comic / Impact' },
  { value: "'Helvetica Neue', Arial, sans-serif", label: 'Helvetica Neue / Arial' },
  { value: "'Courier New', Menlo, monospace", label: 'Courier / Monospace' },
  { value: "'Trebuchet MS', Verdana, sans-serif", label: 'Trebuchet / Verdana' },
];

interface SubtitleInspectorPanelProps {
  seg: SubtitleSegment;
}

export function SubtitleInspectorPanel({ seg }: SubtitleInspectorPanelProps) {
  const { t } = useI18n();
  const project = useProjectStore((s) => s.project);
  const updateSubtitleSegment = useProjectStore((s) => s.updateSubtitleSegment);
  const updateSubtitleStyleOverride = useProjectStore((s) => s.updateSubtitleStyleOverride);
  const clearSubtitleStyleOverride = useProjectStore((s) => s.clearSubtitleStyleOverride);
  const applySubtitleOverrideToStyle = useProjectStore((s) => s.applySubtitleOverrideToStyle);
  const upsertSubtitleStyle = useProjectStore((s) => s.upsertSubtitleStyle);
  const splitSubtitleSegmentAt = useProjectStore((s) => s.splitSubtitleSegmentAt);
  const duplicateSubtitleSegment = useProjectStore((s) => s.duplicateSubtitleSegment);
  const deleteSubtitleSegments = useProjectStore((s) => s.deleteSubtitleSegments);
  const pushHistorySnapshot = useProjectStore((s) => s.pushHistorySnapshot);

  const characters = useLibraryStore((s) => s.characters);
  const setCurrentFrame = usePlaybackStore((s) => s.setCurrentFrame);
  const setPlaying = usePlaybackStore((s) => s.setPlaying);
  const setSidebarTab = useWorkspaceStore((s) => s.setSidebarTab);
  const setCenterMode = useWorkspaceStore((s) => s.setCenterMode);
  const pushToast = useJobStore((s) => s.pushToast);

  // Default to per-segment override so edits on one timeline subtitle never leak to sibling subtitles
  const [editScope, setEditScope] = useState<'segment' | 'preset'>('segment');
  const textSnapshotTakenRef = useRef<string | null>(null);

  if (!project) return null;

  const subDoc = ensureSubtitleDocument(project.subtitles);
  const fps = project.timeline.fps;
  const baseStyle = resolveSubtitleStyle(subDoc, seg.style_id);
  const effectiveStyle = resolveEffectiveSubtitleStyle(subDoc, seg);
  const activeStyle = editScope === 'segment' ? effectiveStyle : baseStyle;
  const overrideCount = countSubtitleStyleOverrides(seg);
  const durationMs = Math.max(100, seg.end_ms - seg.start_ms);

  const patchStyle = (patch: SubtitleStyleOverride, recordHistory = true) => {
    if (editScope === 'segment') {
      updateSubtitleStyleOverride(seg.subtitle_id, patch, recordHistory);
    } else {
      const next: SubtitleStyle = { ...baseStyle, ...patch };
      upsertSubtitleStyle(next);
    }
  };

  const isCustomFont = !SUBTITLE_FONT_OPTIONS.some((f) => f.value === activeStyle.font_family);

  return (
    <div className="panel-body" data-testid="timeline-subtitle-inspector" data-subtitle-id={seg.subtitle_id}>
      {/* Scope Switcher: Per-Subtitle Override vs Shared Style Preset */}
      <div
        className="card"
        style={{
          padding: '7px 8px',
          marginBottom: 8,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          background: 'var(--surface-elevated)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
            {t('sub.inspectorEditTarget')}
          </span>
          {overrideCount > 0 && (
            <span className="badge mono" data-testid="sub-insp-override-count" style={{ fontSize: 9 }}>
              {t('sub.overrideCountBadge', { count: overrideCount })}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            type="button"
            className={`btn-xs ${editScope === 'segment' ? 'btn-primary' : ''}`}
            style={{ flex: 1, justifyContent: 'center' }}
            onClick={() => setEditScope('segment')}
            data-testid="sub-insp-scope-segment"
          >
            {t('sub.scopeThisSubtitle')}
          </button>
          <button
            type="button"
            className={`btn-xs ${editScope === 'preset' ? 'btn-primary' : ''}`}
            style={{ flex: 1, justifyContent: 'center' }}
            onClick={() => setEditScope('preset')}
            data-testid="sub-insp-scope-preset"
          >
            {t('sub.scopeSharedStyle')}
          </button>
        </div>
        {overrideCount > 0 && (
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              type="button"
              className="btn-xs"
              style={{ flex: 1, justifyContent: 'center' }}
              onClick={() => {
                clearSubtitleStyleOverride(seg.subtitle_id);
                pushToast('info', t('sub.overridesClearedToast'));
              }}
              data-testid="sub-insp-reset-overrides"
            >
              <RotateCcw size={10} /> {t('sub.resetOverrides')}
            </button>
            <button
              type="button"
              className="btn-xs"
              style={{ flex: 1, justifyContent: 'center' }}
              onClick={() => {
                applySubtitleOverrideToStyle(seg.subtitle_id);
                pushToast('success', t('sub.pushedToPresetToast', { name: baseStyle.name }));
              }}
              data-testid="sub-insp-push-to-preset"
            >
              {t('sub.pushToPreset')}
            </button>
          </div>
        )}
      </div>

      {/* 1. CONTENT */}
      <CollapsibleSection
        title={t('sub.sectionContent')}
        icon={<Captions size={12} color="#fbbf24" />}
        action={
          <div style={{ display: 'flex', gap: 3 }}>
            <button
              type="button"
              className="btn-xs"
              onClick={() => splitSubtitleSegmentAt(seg.subtitle_id)}
              title={t('sub.split')}
              data-testid="sub-insp-split"
            >
              <Scissors size={10} />
            </button>
            <button
              type="button"
              className="btn-xs"
              onClick={() => duplicateSubtitleSegment(seg.subtitle_id)}
              title={t('sub.duplicate')}
              data-testid="sub-insp-duplicate"
            >
              <Copy size={10} />
            </button>
            <button
              type="button"
              className="btn-danger btn-xs"
              onClick={() => deleteSubtitleSegments([seg.subtitle_id])}
              title={t('common.delete')}
              data-testid="sub-insp-delete"
            >
              <Trash2 size={10} />
            </button>
          </div>
        }
        defaultOpen
      >
        <div className="field-row">
          <label className="field-label" htmlFor="sub-insp-text-area">
            {t('sub.colText')}
          </label>
          <textarea
            id="sub-insp-text-area"
            data-testid="sub-insp-text"
            rows={3}
            value={seg.text}
            onFocus={() => {
              textSnapshotTakenRef.current = null;
            }}
            onChange={(e) => {
              const firstEdit = textSnapshotTakenRef.current !== seg.subtitle_id;
              if (firstEdit) {
                pushHistorySnapshot();
                textSnapshotTakenRef.current = seg.subtitle_id;
              }
              updateSubtitleSegment(seg.subtitle_id, { text: e.target.value }, false);
            }}
            onBlur={() => {
              textSnapshotTakenRef.current = null;
            }}
            style={{
              width: '100%',
              fontSize: 12,
              padding: '5px 7px',
              background: 'var(--surface-base)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 4,
              color: 'var(--text-primary)',
              resize: 'vertical',
              fontFamily: 'inherit',
            }}
          />
        </div>

        <div className="field-row">
          <label className="field-label">{t('sub.colSpeaker')}</label>
          <select
            data-testid="sub-insp-speaker"
            value={seg.speaker_character_id ?? ''}
            onChange={(e) => {
              const cid = e.target.value || null;
              const char = cid ? characters.find((c) => c.character_id === cid) : null;
              updateSubtitleSegment(seg.subtitle_id, {
                speaker_character_id: cid,
                speaker_name: char ? char.name : '',
              });
            }}
          >
            <option value="">{t('sub.speakerNone')}</option>
            {characters.map((ch) => (
              <option key={ch.character_id} value={ch.character_id}>
                {ch.name}
              </option>
            ))}
          </select>
        </div>

        <div className="field-grid">
          <NumericInput
            label={t('sub.letterSpacing')}
            shortTag="LS"
            unit="px"
            step={0.5}
            min={-6}
            max={32}
            precision={1}
            value={activeStyle.letter_spacing}
            onScrubStart={pushHistorySnapshot}
            onChange={(val) => patchStyle({ letter_spacing: val }, false)}
          />
          <NumericInput
            label={t('sub.lineSpacing')}
            shortTag="LH"
            step={0.05}
            min={1.0}
            max={2.4}
            precision={2}
            value={activeStyle.line_spacing}
            onScrubStart={pushHistorySnapshot}
            onChange={(val) => patchStyle({ line_spacing: Math.max(1, val) }, false)}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <ToggleSwitch
            label={t('sub.wordWrap')}
            checked={activeStyle.word_wrap}
            onChange={(word_wrap) => patchStyle({ word_wrap })}
          />
          <ToggleSwitch
            label={t('sub.enabledSegment')}
            checked={seg.enabled}
            onChange={(enabled) => updateSubtitleSegment(seg.subtitle_id, { enabled })}
          />
        </div>
      </CollapsibleSection>

      {/* 2. TYPOGRAPHY */}
      <CollapsibleSection
        title={t('sub.sectionTypography')}
        icon={<Type size={12} color="#38bdf8" />}
        defaultOpen
      >
        <div className="field-row">
          <label className="field-label">{t('sub.colStyle')}</label>
          <select
            data-testid="sub-insp-style-preset"
            value={seg.style_id}
            onChange={(e) => updateSubtitleSegment(seg.subtitle_id, { style_id: e.target.value })}
          >
            {subDoc.styles.map((st) => (
              <option key={st.style_id} value={st.style_id}>
                {st.name}
              </option>
            ))}
          </select>
        </div>

        <div className="field-row">
          <label className="field-label">{t('sub.fontFamily')}</label>
          <select
            data-testid="sub-insp-font-family"
            value={isCustomFont ? '__custom__' : activeStyle.font_family}
            onChange={(e) => {
              if (e.target.value !== '__custom__') {
                patchStyle({ font_family: e.target.value });
              }
            }}
          >
            {SUBTITLE_FONT_OPTIONS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
            {isCustomFont && <option value="__custom__">{activeStyle.font_family}</option>}
          </select>
        </div>

        <div className="field-grid">
          <div className="field-row">
            <label className="field-label">{t('sub.fontSize')} (px)</label>
            <input
              type="number"
              data-testid="sub-insp-font-size"
              min={14}
              max={120}
              step={1}
              value={activeStyle.font_size}
              onChange={(e) => {
                const v = Math.max(14, Math.min(120, Math.round(Number(e.target.value) || 44)));
                patchStyle({ font_size: v });
              }}
            />
          </div>
          <div className="field-row">
            <label className="field-label">{t('sub.fontWeight')}</label>
            <select
              data-testid="sub-insp-font-weight"
              value={activeStyle.font_weight}
              onChange={(e) => patchStyle({ font_weight: e.target.value as SubtitleFontWeight })}
            >
              <option value="normal">{t('sub.weightNormal')}</option>
              <option value="semibold">{t('sub.weightSemibold')}</option>
              <option value="bold">{t('sub.weightBold')}</option>
              <option value="extrabold">{t('sub.weightExtrabold')}</option>
            </select>
          </div>
        </div>

        {/* Quick Style Toggles: Bold / Italic / Underline */}
        <div className="field-row">
          <label className="field-label">{t('sub.textStyleLabel')}</label>
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              type="button"
              data-testid="sub-insp-bold"
              className={`btn-xs ${activeStyle.font_weight !== 'normal' ? 'btn-primary' : ''}`}
              style={{ flex: 1, justifyContent: 'center' }}
              title={t('sub.weightBold')}
              onClick={() =>
                patchStyle({
                  font_weight: activeStyle.font_weight === 'normal' ? 'bold' : 'normal',
                })
              }
            >
              <Bold size={11} /> B
            </button>
            <button
              type="button"
              data-testid="sub-insp-italic"
              className={`btn-xs ${activeStyle.italic ? 'btn-primary' : ''}`}
              style={{ flex: 1, justifyContent: 'center' }}
              title={t('sub.italic')}
              onClick={() => patchStyle({ italic: !activeStyle.italic })}
            >
              <Italic size={11} /> I
            </button>
            <button
              type="button"
              data-testid="sub-insp-underline"
              className={`btn-xs ${activeStyle.underline ? 'btn-primary' : ''}`}
              style={{ flex: 1, justifyContent: 'center' }}
              title={t('sub.underline')}
              onClick={() => patchStyle({ underline: !activeStyle.underline })}
            >
              <Underline size={11} /> U
            </button>
          </div>
        </div>
      </CollapsibleSection>

      {/* 3. APPEARANCE */}
      <CollapsibleSection
        title={t('sub.sectionAppearance')}
        icon={<Palette size={12} color="#c084fc" />}
        defaultOpen
      >
        <div className="field-grid">
          <div className="field-row">
            <label className="field-label">{t('sub.textColor')}</label>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <input
                type="color"
                data-testid="sub-insp-text-color"
                value={activeStyle.text_color}
                onChange={(e) => patchStyle({ text_color: e.target.value })}
                style={{ width: 28, height: 24, padding: 1 }}
              />
              <input
                type="text"
                className="mono"
                value={activeStyle.text_color}
                onChange={(e) => {
                  if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) {
                    patchStyle({ text_color: e.target.value });
                  }
                }}
                style={{ flex: 1, fontSize: 10 }}
              />
            </div>
          </div>
          <div className="field-row">
            <label className="field-label">{t('sub.outlineColor')}</label>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <input
                type="color"
                data-testid="sub-insp-outline-color"
                value={activeStyle.outline_color}
                onChange={(e) => patchStyle({ outline_color: e.target.value })}
                style={{ width: 28, height: 24, padding: 1 }}
              />
              <input
                type="number"
                data-testid="sub-insp-outline-width"
                min={0}
                max={12}
                step={0.5}
                value={activeStyle.outline_width}
                onChange={(e) =>
                  patchStyle({
                    outline_width: Math.max(0, Math.min(12, Number(e.target.value) || 0)),
                  })
                }
                style={{ flex: 1, fontSize: 11 }}
                title={t('sub.outlineWidth')}
              />
            </div>
          </div>
        </div>

        {/* Shadow */}
        <ToggleSwitch
          label={t('sub.shadowEnabled')}
          checked={activeStyle.shadow_enabled}
          onChange={(shadow_enabled) => patchStyle({ shadow_enabled })}
        />
        {activeStyle.shadow_enabled && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 6, borderLeft: '2px solid var(--border-subtle)' }}>
            <div className="field-grid">
              <div className="field-row">
                <label className="field-label">{t('sub.shadowColor')}</label>
                <input
                  type="color"
                  data-testid="sub-insp-shadow-color"
                  value={activeStyle.shadow_color}
                  onChange={(e) => patchStyle({ shadow_color: e.target.value })}
                />
              </div>
              <div className="field-row">
                <label className="field-label">
                  {t('sub.shadowOpacity')} ({Math.round(activeStyle.shadow_opacity * 100)}%)
                </label>
                <input
                  type="range"
                  data-testid="sub-insp-shadow-opacity"
                  min={0}
                  max={1}
                  step={0.05}
                  value={activeStyle.shadow_opacity}
                  onChange={(e) => patchStyle({ shadow_opacity: Number(e.target.value) })}
                />
              </div>
            </div>
            <div className="field-grid">
              <div className="field-row">
                <label className="field-label">{t('sub.shadowBlur')}</label>
                <input
                  type="number"
                  data-testid="sub-insp-shadow-blur"
                  min={0}
                  max={24}
                  step={1}
                  value={activeStyle.shadow_blur}
                  onChange={(e) =>
                    patchStyle({ shadow_blur: Math.max(0, Math.min(24, Number(e.target.value) || 0)) })
                  }
                />
              </div>
              <div className="field-row">
                <label className="field-label">{t('sub.shadowOffset')} (X / Y)</label>
                <div style={{ display: 'flex', gap: 4 }}>
                  <input
                    type="number"
                    data-testid="sub-insp-shadow-offset-x"
                    min={-20}
                    max={20}
                    step={1}
                    value={activeStyle.shadow_offset_x}
                    onChange={(e) =>
                      patchStyle({
                        shadow_offset_x: Math.max(-20, Math.min(20, Number(e.target.value) || 0)),
                      })
                    }
                    style={{ width: '50%' }}
                  />
                  <input
                    type="number"
                    data-testid="sub-insp-shadow-offset-y"
                    min={-20}
                    max={20}
                    step={1}
                    value={activeStyle.shadow_offset_y}
                    onChange={(e) =>
                      patchStyle({
                        shadow_offset_y: Math.max(-20, Math.min(20, Number(e.target.value) || 0)),
                      })
                    }
                    style={{ width: '50%' }}
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Background Box */}
        <ToggleSwitch
          label={t('sub.backgroundBox')}
          checked={activeStyle.background_enabled}
          onChange={(background_enabled) => patchStyle({ background_enabled })}
        />
        {activeStyle.background_enabled && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 6, borderLeft: '2px solid var(--border-subtle)' }}>
            <div className="field-grid">
              <div className="field-row">
                <label className="field-label">{t('sub.bgColor')}</label>
                <input
                  type="color"
                  data-testid="sub-insp-bg-color"
                  value={activeStyle.background_color}
                  onChange={(e) => patchStyle({ background_color: e.target.value })}
                />
              </div>
              <div className="field-row">
                <label className="field-label">
                  {t('sub.bgOpacity')} ({Math.round(activeStyle.background_opacity * 100)}%)
                </label>
                <input
                  type="range"
                  data-testid="sub-insp-bg-opacity"
                  min={0}
                  max={1}
                  step={0.05}
                  value={activeStyle.background_opacity}
                  onChange={(e) => patchStyle({ background_opacity: Number(e.target.value) })}
                />
              </div>
            </div>
            <div className="field-grid">
              <div className="field-row">
                <label className="field-label">{t('sub.bgPaddingX')} (px)</label>
                <input
                  type="number"
                  data-testid="sub-insp-bg-pad-x"
                  min={0}
                  max={120}
                  value={activeStyle.background_padding_x}
                  onChange={(e) =>
                    patchStyle({
                      background_padding_x: Math.max(0, Math.min(120, Math.round(Number(e.target.value) || 0))),
                    })
                  }
                />
              </div>
              <div className="field-row">
                <label className="field-label">{t('sub.bgPaddingY')} (px)</label>
                <input
                  type="number"
                  data-testid="sub-insp-bg-pad-y"
                  min={0}
                  max={100}
                  value={activeStyle.background_padding_y}
                  onChange={(e) =>
                    patchStyle({
                      background_padding_y: Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0))),
                    })
                  }
                />
              </div>
            </div>
          </div>
        )}
      </CollapsibleSection>

      {/* 4. LAYOUT & POSITION */}
      <CollapsibleSection
        title={t('sub.sectionLayout')}
        icon={<LayoutTemplate size={12} color="#34d399" />}
        defaultOpen
      >
        <div className="field-grid">
          <div className="field-row">
            <label className="field-label">{t('sub.alignment')}</label>
            <div style={{ display: 'flex', gap: 3 }}>
              {(['left', 'center', 'right'] as SubtitleAlignment[]).map((al) => (
                <button
                  key={al}
                  type="button"
                  data-testid={`sub-insp-align-${al}`}
                  className={`btn-icon btn-xs ${activeStyle.alignment === al ? 'btn-primary' : ''}`}
                  style={{ flex: 1, justifyContent: 'center' }}
                  onClick={() => patchStyle({ alignment: al })}
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
          <div className="field-row">
            <label className="field-label">{t('sub.verticalAnchor')}</label>
            <select
              data-testid="sub-insp-position"
              value={activeStyle.position}
              onChange={(e) => patchStyle({ position: e.target.value as SubtitlePosition })}
            >
              <option value="bottom">{t('sub.posBottom')}</option>
              <option value="center">{t('sub.posCenter')}</option>
              <option value="top">{t('sub.posTop')}</option>
            </select>
          </div>
        </div>

        <div className="field-grid">
          <div className="field-row">
            <label className="field-label">{t('sub.positionX')} (px)</label>
            <input
              type="number"
              data-testid="sub-insp-offset-x"
              min={-960}
              max={960}
              step={5}
              value={activeStyle.offset_x}
              onChange={(e) =>
                patchStyle({ offset_x: Math.max(-960, Math.min(960, Number(e.target.value) || 0)) })
              }
            />
          </div>
          <div className="field-row">
            <label className="field-label">{t('sub.positionY')} (px)</label>
            <input
              type="number"
              data-testid="sub-insp-offset-y"
              min={-540}
              max={540}
              step={5}
              value={activeStyle.offset_y}
              onChange={(e) =>
                patchStyle({ offset_y: Math.max(-540, Math.min(540, Number(e.target.value) || 0)) })
              }
            />
          </div>
        </div>

        <div className="field-grid">
          <div className="field-row">
            <label className="field-label">{t('sub.maxWidth')} (%)</label>
            <input
              type="number"
              data-testid="sub-insp-max-width"
              min={20}
              max={98}
              step={1}
              value={activeStyle.max_width_pct}
              onChange={(e) =>
                patchStyle({
                  max_width_pct: Math.max(20, Math.min(98, Math.round(Number(e.target.value) || 82))),
                })
              }
            />
          </div>
          <div className="field-row">
            <label className="field-label">{t('sub.boxHeight')} (px)</label>
            <input
              type="number"
              data-testid="sub-insp-box-height"
              min={0}
              max={600}
              step={4}
              value={activeStyle.box_height_px}
              placeholder="0 = Auto"
              onChange={(e) =>
                patchStyle({
                  box_height_px: Math.max(0, Math.min(600, Math.round(Number(e.target.value) || 0))),
                })
              }
            />
          </div>
        </div>

        <div className="field-grid">
          <div className="field-row">
            <label className="field-label">{t('sub.marginX')} (px)</label>
            <input
              type="number"
              data-testid="sub-insp-margin-x"
              min={0}
              max={400}
              value={activeStyle.margin_x}
              onChange={(e) =>
                patchStyle({ margin_x: Math.max(0, Math.min(400, Math.round(Number(e.target.value) || 0))) })
              }
            />
          </div>
          <div className="field-row">
            <label className="field-label">{t('sub.marginY')} (px)</label>
            <input
              type="number"
              data-testid="sub-insp-margin-y"
              min={0}
              max={400}
              value={activeStyle.margin_y}
              onChange={(e) =>
                patchStyle({ margin_y: Math.max(0, Math.min(400, Math.round(Number(e.target.value) || 0))) })
              }
            />
          </div>
        </div>

        <ToggleSwitch
          label={t('sub.safeAreaClamp')}
          checked={activeStyle.safe_area_clamp}
          onChange={(safe_area_clamp) => patchStyle({ safe_area_clamp })}
        />
      </CollapsibleSection>

      {/* 5. TIMING */}
      <CollapsibleSection
        title={t('sub.sectionTiming')}
        icon={<Clock size={12} color="#f59e0b" />}
        defaultOpen
      >
        <div className="field-grid">
          <div className="field-row">
            <label className="field-label">{t('inspector.startTime')} (ms)</label>
            <input
              type="number"
              data-testid="sub-insp-start-ms"
              min={0}
              step={50}
              value={seg.start_ms}
              onChange={(e) => {
                const st = Math.max(0, Math.round(Number(e.target.value) || 0));
                updateSubtitleSegment(seg.subtitle_id, {
                  start_ms: st,
                  end_ms: Math.max(st + 150, seg.end_ms),
                  timing_source: 'manual',
                });
              }}
            />
          </div>
          <div className="field-row">
            <label className="field-label">{t('inspector.endTime')} (ms)</label>
            <input
              type="number"
              data-testid="sub-insp-end-ms"
              min={seg.start_ms + 150}
              step={50}
              value={seg.end_ms}
              onChange={(e) => {
                const end = Math.max(seg.start_ms + 150, Math.round(Number(e.target.value) || 0));
                updateSubtitleSegment(seg.subtitle_id, {
                  end_ms: end,
                  timing_source: 'manual',
                });
              }}
            />
          </div>
        </div>

        <div className="field-row">
          <label className="field-label">{t('sub.durationMsLabel')}</label>
          <input
            type="number"
            data-testid="sub-insp-duration-ms"
            min={150}
            step={50}
            value={durationMs}
            onChange={(e) => {
              const dur = Math.max(150, Math.round(Number(e.target.value) || 150));
              updateSubtitleSegment(seg.subtitle_id, {
                end_ms: seg.start_ms + dur,
                timing_source: 'manual',
              });
            }}
          />
        </div>

        <div style={{ display: 'flex', gap: 5, marginTop: 4 }}>
          <button
            type="button"
            className="btn-xs"
            style={{ flex: 1, justifyContent: 'center' }}
            onClick={() => {
              setPlaying(false);
              setCurrentFrame(msToFrame(seg.start_ms, fps));
            }}
            data-testid="sub-insp-jump-playhead"
          >
            <Play size={10} /> {t('sub.jumpToStart')}
          </button>
          <button
            type="button"
            className="btn-xs"
            style={{ flex: 1, justifyContent: 'center' }}
            onClick={() => {
              setSidebarTab('subtitles');
              setCenterMode('subtitles');
            }}
            data-testid="sub-insp-open-studio"
          >
            <ExternalLink size={10} /> {t('sub.openSubtitleStudio')}
          </button>
        </div>
      </CollapsibleSection>
    </div>
  );
}
