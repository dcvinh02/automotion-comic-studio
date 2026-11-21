import type {
  EasingType,
  Keyframe,
  KeyframeProperty,
  KeyframeTargetType,
  Transform2D,
} from '@/types/models';
import { frameToMs } from './evaluator';

export type AnimationPresetId =
  | 'idle_breathe'
  | 'move_left'
  | 'move_right'
  | 'move_up'
  | 'move_down'
  | 'walk_cycle'
  | 'bounce'
  | 'zoom_in'
  | 'zoom_out';

export interface AnimationPresetDef {
  id: AnimationPresetId;
  labelKey: string;
  durationFrames: number;
  supportsCamera?: boolean;
}

export const ANIMATION_PRESETS: AnimationPresetDef[] = [
  { id: 'idle_breathe', labelKey: 'preset.idle_breathe', durationFrames: 60 },
  { id: 'move_left', labelKey: 'preset.move_left', durationFrames: 60 },
  { id: 'move_right', labelKey: 'preset.move_right', durationFrames: 60 },
  { id: 'move_up', labelKey: 'preset.move_up', durationFrames: 45 },
  { id: 'move_down', labelKey: 'preset.move_down', durationFrames: 45 },
  { id: 'walk_cycle', labelKey: 'preset.walk_cycle', durationFrames: 60 },
  { id: 'bounce', labelKey: 'preset.bounce', durationFrames: 40 },
  { id: 'zoom_in', labelKey: 'preset.zoom_in', durationFrames: 45, supportsCamera: true },
  { id: 'zoom_out', labelKey: 'preset.zoom_out', durationFrames: 45, supportsCamera: true },
];

export interface GeneratedKeyframeSpec {
  track_id: string;
  target_type: KeyframeTargetType;
  target_id: string;
  property: KeyframeProperty;
  time_ms: number;
  value: number;
  easing: EasingType;
}

/**
 * Generates real, fully editable keyframes starting at startFrame.
 * Never locks an object into non-editable procedural behavior.
 */
export function generatePresetKeyframes(params: {
  presetId: AnimationPresetId;
  targetType: KeyframeTargetType;
  targetId: string;
  trackId: string;
  startFrame: number;
  fps: number;
  baseTransform: Transform2D;
  baseCameraZoom?: number;
}): GeneratedKeyframeSpec[] {
  const { presetId, targetType, targetId, trackId, startFrame, fps, baseTransform, baseCameraZoom } =
    params;

  const at = (offsetFrames: number) => Math.round(frameToMs(startFrame + offsetFrames, fps));
  const kf = (
    offsetFrames: number,
    property: KeyframeProperty,
    value: number,
    easing: EasingType = 'ease_in_out',
  ): GeneratedKeyframeSpec => ({
    track_id: trackId,
    target_type: targetType,
    target_id: targetId,
    property,
    time_ms: at(offsetFrames),
    value: Math.round(value * 100) / 100,
    easing,
  });

  const { x, y, rotation_deg, scale_x, scale_y } = baseTransform;

  switch (presetId) {
    case 'idle_breathe':
      return [
        kf(0, 'y', y, 'ease_in_out'),
        kf(30, 'y', y - 8, 'ease_in_out'),
        kf(60, 'y', y, 'ease_in_out'),
        kf(0, 'scale_y', scale_y, 'ease_in_out'),
        kf(30, 'scale_y', scale_y * 1.03, 'ease_in_out'),
        kf(60, 'scale_y', scale_y, 'ease_in_out'),
      ];
    case 'move_left':
      return [
        kf(0, 'x', x, 'ease_in_out'),
        kf(60, 'x', x - 320, 'ease_in_out'),
      ];
    case 'move_right':
      return [
        kf(0, 'x', x, 'ease_in_out'),
        kf(60, 'x', x + 320, 'ease_in_out'),
      ];
    case 'move_up':
      return [
        kf(0, 'y', y, 'ease_out'),
        kf(45, 'y', y - 180, 'ease_out'),
      ];
    case 'move_down':
      return [
        kf(0, 'y', y, 'ease_in_out'),
        kf(45, 'y', y + 180, 'ease_in_out'),
      ];
    case 'walk_cycle':
      return [
        kf(0, 'x', x, 'linear'),
        kf(60, 'x', x + 280, 'linear'),
        kf(0, 'y', y, 'ease_out'),
        kf(10, 'y', y - 16, 'ease_in'),
        kf(20, 'y', y, 'ease_out'),
        kf(30, 'y', y - 16, 'ease_in'),
        kf(40, 'y', y, 'ease_out'),
        kf(50, 'y', y - 16, 'ease_in'),
        kf(60, 'y', y, 'linear'),
        kf(0, 'rotation_deg', rotation_deg, 'ease_in_out'),
        kf(15, 'rotation_deg', rotation_deg + 3, 'ease_in_out'),
        kf(30, 'rotation_deg', rotation_deg - 3, 'ease_in_out'),
        kf(45, 'rotation_deg', rotation_deg + 3, 'ease_in_out'),
        kf(60, 'rotation_deg', rotation_deg, 'ease_in_out'),
      ];
    case 'bounce':
      return [
        kf(0, 'y', y, 'ease_out'),
        kf(14, 'y', y - 95, 'ease_in'),
        kf(28, 'y', y, 'ease_out'),
        kf(34, 'y', y - 28, 'ease_in'),
        kf(40, 'y', y, 'linear'),
        kf(0, 'scale_y', scale_y, 'ease_out'),
        kf(14, 'scale_y', scale_y * 1.06, 'ease_in'),
        kf(28, 'scale_y', scale_y * 0.9, 'ease_out'),
        kf(40, 'scale_y', scale_y, 'linear'),
      ];
    case 'zoom_in':
      if (targetType === 'camera') {
        const z0 = baseCameraZoom ?? 1;
        return [
          kf(0, 'zoom', z0, 'ease_in_out'),
          kf(45, 'zoom', Math.min(4, z0 * 1.35), 'ease_in_out'),
        ];
      }
      return [
        kf(0, 'scale_x', scale_x, 'ease_in_out'),
        kf(45, 'scale_x', scale_x * 1.3, 'ease_in_out'),
        kf(0, 'scale_y', scale_y, 'ease_in_out'),
        kf(45, 'scale_y', scale_y * 1.3, 'ease_in_out'),
      ];
    case 'zoom_out':
      if (targetType === 'camera') {
        const z0 = baseCameraZoom ?? 1.35;
        return [
          kf(0, 'zoom', z0, 'ease_in_out'),
          kf(45, 'zoom', Math.max(0.4, z0 / 1.35), 'ease_in_out'),
        ];
      }
      return [
        kf(0, 'scale_x', scale_x, 'ease_in_out'),
        kf(45, 'scale_x', Math.max(0.2, scale_x * 0.75), 'ease_in_out'),
        kf(0, 'scale_y', scale_y, 'ease_in_out'),
        kf(45, 'scale_y', Math.max(0.2, scale_y * 0.75), 'ease_in_out'),
      ];
    default:
      return [];
  }
}

export function quantizeMsToFrameMs(ms: number, fps: number): number {
  const safeFps = Math.max(1, fps);
  const frame = Math.max(0, Math.round((ms * safeFps) / 1000));
  return Math.round((frame * 1000) / safeFps);
}

export interface PropertyTrackGroup {
  key: string;
  targetType: KeyframeTargetType;
  targetId: string;
  property: KeyframeProperty;
  partSlotId: string | null;
  keyframes: Keyframe[];
}

const PROPERTY_SORT_ORDER: Record<KeyframeProperty, number> = {
  x: 0,
  y: 1,
  rotation_deg: 2,
  scale_x: 3,
  scale_y: 4,
  opacity: 5,
  zoom: 6,
  expression_id: 7,
  pose_id: 8,
  eye_state: 9,
  mouth_state: 10,
  animation_state: 11,
};

export function groupKeyframesForTrack(
  keyframes: Keyframe[],
  matcher: (k: Keyframe) => boolean,
): PropertyTrackGroup[] {
  const map = new Map<string, PropertyTrackGroup>();
  for (const kf of keyframes) {
    if (!matcher(kf)) continue;
    const partSlotId =
      kf.target_type === 'character_part' && kf.target_id.includes(':')
        ? kf.target_id.split(':')[1]
        : null;
    const key = `${kf.target_type}:${kf.target_id}:${kf.property}`;
    let group = map.get(key);
    if (!group) {
      group = {
        key,
        targetType: kf.target_type,
        targetId: kf.target_id,
        property: kf.property,
        partSlotId,
        keyframes: [],
      };
      map.set(key, group);
    }
    group.keyframes.push(kf);
  }
  for (const g of map.values()) {
    g.keyframes.sort((a, b) => a.time_ms - b.time_ms || a.keyframe_id.localeCompare(b.keyframe_id));
  }
  return [...map.values()].sort((a, b) => {
    const partCmp = (a.partSlotId ?? '').localeCompare(b.partSlotId ?? '');
    if (partCmp !== 0) return partCmp;
    const propCmp = (PROPERTY_SORT_ORDER[a.property] ?? 99) - (PROPERTY_SORT_ORDER[b.property] ?? 99);
    if (propCmp !== 0) return propCmp;
    return a.key.localeCompare(b.key);
  });
}
