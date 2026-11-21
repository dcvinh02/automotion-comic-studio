import React from 'react';
import { NumericInput } from './PropertyControls';

/**
 * Backward-compatible wrapper delegating to the Phase 04 NumericInput control
 * (text-mode exact numeric entry, Enter confirm, Escape cancel, Arrow ±step, horizontal drag-scrub).
 */
export function NumericScrubber({
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
}: {
  label: string;
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
}) {
  return (
    <NumericInput
      label={label}
      shortTag={shortTag ?? label.slice(0, 1).toUpperCase()}
      value={value}
      onChange={onChange}
      onScrubStart={onScrubStart}
      step={step}
      min={min}
      max={max}
      unit={unit}
      precision={precision}
      rightSlot={rightSlot}
      onReset={onReset}
      disabled={disabled}
    />
  );
}
