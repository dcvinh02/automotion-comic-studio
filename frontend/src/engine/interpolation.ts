import type { EasingType, Keyframe } from '@/types/models';

export function applyEasing(
  t: number,
  easing: EasingType,
  bezier?: [number, number, number, number] | null,
): number {
  const clamped = Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0;
  switch (easing) {
    case 'hold':
    case 'step':
      return clamped < 1 ? 0 : 1;
    case 'linear':
      return clamped;
    case 'ease_in':
      return clamped * clamped * clamped;
    case 'ease_out': {
      const inv = 1 - clamped;
      return 1 - inv * inv * inv;
    }
    case 'ease_in_out':
      return clamped < 0.5
        ? 4 * clamped * clamped * clamped
        : 1 - Math.pow(-2 * clamped + 2, 3) / 2;
    case 'cubic_bezier': {
      if (!bezier) return clamped;
      const [, y1, , y2] = bezier;
      const u = 1 - clamped;
      return 3 * u * u * clamped * y1 + 3 * u * clamped * clamped * y2 + clamped * clamped * clamped;
    }
    default:
      return clamped;
  }
}

/**
 * Deterministically deduplicate keyframes sharing the exact same time_ms
 * (last keyframe in insertion order wins) and sort ascending by time_ms.
 */
function normalizeSortedKeyframes(keyframes: Keyframe[]): Keyframe[] {
  if (keyframes.length <= 1) return keyframes;
  const byTime = new Map<number, Keyframe>();
  for (const kf of keyframes) {
    byTime.set(Math.round(kf.time_ms), kf);
  }
  return [...byTime.values()].sort((a, b) => a.time_ms - b.time_ms);
}

export function evaluateNumericKeyframes(
  keyframes: Keyframe[],
  timeMs: number,
  defaultValue: number,
): number {
  const safeDefault = Number.isFinite(defaultValue) ? defaultValue : 0;
  if (keyframes.length === 0) return safeDefault;
  const sorted = normalizeSortedKeyframes(keyframes);

  const firstVal = Number(sorted[0].value);
  if (timeMs <= sorted[0].time_ms) return Number.isFinite(firstVal) ? firstVal : safeDefault;
  const lastVal = Number(sorted[sorted.length - 1].value);
  if (timeMs >= sorted[sorted.length - 1].time_ms) return Number.isFinite(lastVal) ? lastVal : safeDefault;

  for (let i = 0; i < sorted.length - 1; i++) {
    const k0 = sorted[i];
    const k1 = sorted[i + 1];
    if (timeMs >= k0.time_ms && timeMs <= k1.time_ms) {
      const v0 = Number(k0.value);
      const v1 = Number(k1.value);
      if (!Number.isFinite(v0) || !Number.isFinite(v1)) return safeDefault;
      if (k0.easing === 'step' || k0.easing === 'hold' || k1.time_ms === k0.time_ms) {
        return timeMs >= k1.time_ms ? v1 : v0;
      }
      const ratio = (timeMs - k0.time_ms) / (k1.time_ms - k0.time_ms);
      const eased = applyEasing(ratio, k0.easing, k0.bezier_handles);
      return v0 + (v1 - v0) * eased;
    }
  }
  return safeDefault;
}

export function evaluateStringKeyframes(
  keyframes: Keyframe[],
  timeMs: number,
  defaultValue: string | null,
): string | null {
  if (keyframes.length === 0) return defaultValue;
  const sorted = normalizeSortedKeyframes(keyframes);
  let result = defaultValue;
  for (const kf of sorted) {
    if (kf.time_ms <= timeMs) {
      result = String(kf.value);
    } else {
      break;
    }
  }
  return result;
}
