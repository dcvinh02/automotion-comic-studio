import React, { useEffect, useRef, useState } from 'react';
import { Diamond, Link2, RotateCcw, Unlink2 } from 'lucide-react';
import { useI18n } from '@/i18n/useLocaleStore';

export function clampAndRoundNumber(
  raw: number,
  options: { min?: number; max?: number; precision?: number } = {},
): number {
  const { min, max, precision = 2 } = options;
  let v = raw;
  if (min !== undefined) v = Math.max(min, v);
  if (max !== undefined) v = Math.min(max, v);
  const factor = Math.pow(10, precision);
  const rounded = Math.round(v * factor) / factor;
  // Avoid -0
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function parseValidNumber(
  text: string,
  options: { min?: number; max?: number; precision?: number } = {},
): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const num = Number(trimmed);
  if (!Number.isFinite(num)) return null;
  return clampAndRoundNumber(num, options);
}

export function formatNumericDisplay(value: number, precision = 2): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = clampAndRoundNumber(value, { precision });
  return String(rounded);
}

export function KeyframeDiamondButton({
  atCurrentFrame,
  hasAnyKeyframe,
  onClick,
  disabled = false,
}: {
  atCurrentFrame: boolean;
  hasAnyKeyframe: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const title = atCurrentFrame
    ? t('inspector.kfActiveTip')
    : hasAnyKeyframe
      ? t('inspector.kfAnimatedTip')
      : t('inspector.kfIdleTip');

  return (
    <button
      type="button"
      disabled={disabled}
      className={`kf-diamond ${atCurrentFrame ? 'has-kf' : hasAnyKeyframe ? 'animated-other' : ''}`}
      title={title}
      aria-label={title}
      aria-pressed={atCurrentFrame}
      onClick={onClick}
    >
      <Diamond
        size={10}
        fill={atCurrentFrame ? 'var(--track-keyframe)' : 'none'}
        strokeWidth={atCurrentFrame || hasAnyKeyframe ? 2 : 1.5}
      />
    </button>
  );
}

export function PropertyRow({
  label,
  rightSlot,
  children,
}: {
  label: string;
  rightSlot?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="prop-row">
      <div className="prop-row-head">
        <span>{label}</span>
        {rightSlot && <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>{rightSlot}</div>}
      </div>
      {children}
    </div>
  );
}

export function NumericInput({
  label,
  shortTag,
  value,
  onChange,
  onScrubStart,
  step = 1,
  min,
  max,
  unit,
  precision = 2,
  rightSlot,
  onReset,
  disabled = false,
  compact = false,
  width,
}: {
  label?: string;
  shortTag?: string;
  value: number;
  onChange: (next: number) => void;
  onScrubStart?: () => void;
  step?: number;
  min?: number;
  max?: number;
  unit?: string;
  precision?: number;
  rightSlot?: React.ReactNode;
  onReset?: () => void;
  disabled?: boolean;
  compact?: boolean;
  width?: number | string;
}) {
  const { t } = useI18n();
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState(() => formatNumericDisplay(value, precision));
  const dragRef = useRef<{ startX: number; origVal: number } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!focused) {
      setDraft(formatNumericDisplay(value, precision));
    }
  }, [value, precision, focused]);

  const commitDraft = () => {
    const parsed = parseValidNumber(draft, { min, max, precision });
    if (parsed !== null) {
      setDraft(formatNumericDisplay(parsed, precision));
      if (parsed !== clampAndRoundNumber(value, { min, max, precision })) {
        onChange(parsed);
      }
    } else {
      // Invalid input -> cleanly revert to previous valid value
      setDraft(formatNumericDisplay(value, precision));
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitDraft();
      inputRef.current?.blur();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setDraft(formatNumericDisplay(value, precision));
      setFocused(false);
      inputRef.current?.blur();
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const base = parseValidNumber(draft, { min, max, precision }) ?? value;
      const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
      const delta = (e.key === 'ArrowUp' ? 1 : -1) * step * mult;
      const next = clampAndRoundNumber(base + delta, { min, max, precision });
      setDraft(formatNumericDisplay(next, precision));
      onChange(next);
    }
  };

  const handleScrubDown = (e: React.PointerEvent<HTMLSpanElement>) => {
    if (disabled) return;
    e.preventDefault();
    onScrubStart?.();
    dragRef.current = { startX: e.clientX, origVal: value };

    const onMove = (me: PointerEvent) => {
      if (!dragRef.current) return;
      const dx = me.clientX - dragRef.current.startX;
      const modifier = me.shiftKey ? 5 : me.altKey ? 0.2 : 1;
      const next = clampAndRoundNumber(
        dragRef.current.origVal + dx * step * 0.5 * modifier,
        { min, max, precision },
      );
      onChange(next);
    };

    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const control = (
    <div
      className="scrubber-input-wrap"
      style={{ width, opacity: disabled ? 0.55 : 1 }}
    >
      {shortTag && (
        <span
          className="scrubber-drag-handle"
          title={t('inspector.scrubHint')}
          onPointerDown={handleScrubDown}
        >
          {shortTag}
        </span>
      )}
      <input
        ref={inputRef}
        type="text"
        inputMode="decimal"
        className="scrubber-input"
        value={focused ? draft : formatNumericDisplay(value, precision)}
        disabled={disabled}
        aria-label={label ?? shortTag ?? 'Numeric value'}
        onFocus={(e) => {
          setFocused(true);
          setDraft(formatNumericDisplay(value, precision));
          e.currentTarget.select();
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setFocused(false);
          commitDraft();
        }}
        onKeyDown={handleKeyDown}
        style={compact ? { padding: '3px 5px', fontSize: 11 } : undefined}
      />
      {unit && <span className="scrubber-unit">{unit}</span>}
    </div>
  );

  if (!label) {
    return control;
  }

  return (
    <div className="scrubber-field">
      <div className="field-label">
        <span>{label}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          {onReset && (
            <button
              type="button"
              className="btn-ghost btn-icon btn-xs"
              style={{ width: 16, height: 16 }}
              title={t('inspector.resetProp')}
              aria-label={t('inspector.resetProp')}
              disabled={disabled}
              onClick={onReset}
            >
              <RotateCcw size={9} />
            </button>
          )}
          {rightSlot}
        </div>
      </div>
      {control}
    </div>
  );
}

export function PropertySlider({
  value,
  min,
  max,
  step = 1,
  onChange,
  onScrubStart,
  disabled = false,
  ariaLabel,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (next: number) => void;
  onScrubStart?: () => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const clamped = Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
  const pct = max > min ? ((clamped - min) / (max - min)) * 100 : 0;

  return (
    <input
      type="range"
      className="prop-slider"
      aria-label={ariaLabel}
      min={min}
      max={max}
      step={step}
      value={clamped}
      disabled={disabled}
      onPointerDown={() => onScrubStart?.()}
      onChange={(e) => {
        const parsed = Number(e.target.value);
        if (Number.isFinite(parsed)) {
          onChange(parsed);
        }
      }}
      style={{
        background: `linear-gradient(to right, var(--accent) 0%, var(--accent) ${pct}%, var(--surface-control) ${pct}%, var(--surface-control) 100%)`,
      }}
    />
  );
}

export function SliderWithInput({
  label,
  value,
  onChange,
  onScrubStart,
  min,
  max,
  step = 1,
  displayScale = 1,
  unit,
  precision = 0,
  rightSlot,
  onReset,
  disabled = false,
}: {
  label: string;
  value: number;
  onChange: (next: number) => void;
  onScrubStart?: () => void;
  min: number;
  max: number;
  step?: number;
  /** Multiply internal value by displayScale in UI (e.g., 100 for 0..1 opacity -> 0..100%) */
  displayScale?: number;
  unit?: string;
  precision?: number;
  rightSlot?: React.ReactNode;
  onReset?: () => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const uiMin = min * displayScale;
  const uiMax = max * displayScale;
  const uiStep = step * displayScale;
  const uiVal = clampAndRoundNumber(value * displayScale, {
    min: uiMin,
    max: uiMax,
    precision,
  });

  const handleUiChange = (nextUi: number) => {
    const internal = clampAndRoundNumber(nextUi / displayScale, {
      min,
      max,
      precision: precision + (displayScale >= 100 ? 2 : 0),
    });
    onChange(internal);
  };

  return (
    <PropertyRow
      label={label}
      rightSlot={
        <>
          {onReset && (
            <button
              type="button"
              className="btn-ghost btn-icon btn-xs"
              style={{ width: 16, height: 16 }}
              title={t('inspector.resetProp')}
              aria-label={t('inspector.resetProp')}
              disabled={disabled}
              onClick={onReset}
            >
              <RotateCcw size={9} />
            </button>
          )}
          {rightSlot}
        </>
      }
    >
      <div className="prop-slider-combo">
        <PropertySlider
          ariaLabel={label}
          min={uiMin}
          max={uiMax}
          step={uiStep}
          value={uiVal}
          disabled={disabled}
          onScrubStart={onScrubStart}
          onChange={handleUiChange}
        />
        <NumericInput
          value={uiVal}
          min={uiMin}
          max={uiMax}
          step={uiStep}
          unit={unit}
          precision={precision}
          disabled={disabled}
          compact
          width={72}
          onScrubStart={onScrubStart}
          onChange={handleUiChange}
        />
      </div>
    </PropertyRow>
  );
}

export function Vector2Control({
  label,
  x,
  y,
  onChangeX,
  onChangeY,
  onScrubStart,
  step = 1,
  min,
  max,
  unit,
  precision = 2,
  xTag = 'X',
  yTag = 'Y',
  xRightSlot,
  yRightSlot,
  aspectLocked,
  onToggleAspectLock,
  onReset,
  disabled = false,
}: {
  label: string;
  x: number;
  y: number;
  onChangeX: (nextX: number) => void;
  onChangeY: (nextY: number) => void;
  onScrubStart?: () => void;
  step?: number;
  min?: number;
  max?: number;
  unit?: string;
  precision?: number;
  xTag?: string;
  yTag?: string;
  xRightSlot?: React.ReactNode;
  yRightSlot?: React.ReactNode;
  aspectLocked?: boolean;
  onToggleAspectLock?: () => void;
  onReset?: () => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();

  return (
    <PropertyRow
      label={label}
      rightSlot={
        <>
          {onReset && (
            <button
              type="button"
              className="btn-ghost btn-icon btn-xs"
              style={{ width: 16, height: 16 }}
              title={t('inspector.resetProp')}
              aria-label={t('inspector.resetProp')}
              disabled={disabled}
              onClick={onReset}
            >
              <RotateCcw size={9} />
            </button>
          )}
          {xRightSlot}
          {yRightSlot}
        </>
      }
    >
      <div className={`vec2-row ${onToggleAspectLock ? '' : 'no-mid'}`}>
        <NumericInput
          shortTag={xTag}
          value={x}
          step={step}
          min={min}
          max={max}
          unit={unit}
          precision={precision}
          disabled={disabled}
          compact
          onScrubStart={onScrubStart}
          onChange={onChangeX}
        />
        {onToggleAspectLock && (
          <button
            type="button"
            className={`btn-icon btn-xs ${aspectLocked ? 'active' : 'btn-ghost'}`}
            style={{ width: 22, height: 24 }}
            title={aspectLocked ? t('inspector.unlockAspect') : t('inspector.lockAspect')}
            aria-label={aspectLocked ? t('inspector.unlockAspect') : t('inspector.lockAspect')}
            aria-pressed={Boolean(aspectLocked)}
            disabled={disabled}
            onClick={onToggleAspectLock}
          >
            {aspectLocked ? <Link2 size={11} /> : <Unlink2 size={11} />}
          </button>
        )}
        <NumericInput
          shortTag={yTag}
          value={y}
          step={step}
          min={min}
          max={max}
          unit={unit}
          precision={precision}
          disabled={disabled}
          compact
          onScrubStart={onScrubStart}
          onChange={onChangeY}
        />
      </div>
    </PropertyRow>
  );
}
