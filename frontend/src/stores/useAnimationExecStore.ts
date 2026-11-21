import { create } from 'zustand';
import type { MotionPreviewOverlay } from '@/engine/animationExecutionEngine';
import type {
  CameraMotionParameters,
  MotionParameters,
  MotionPreviewResponse,
} from '@/types/models';

export interface AnimationExecModalScope {
  sceneIds?: string[] | null;
  shotIds?: string[] | null;
  productionShotIds?: string[] | null;
  regenerateMotionIds?: string[];
}

interface AnimationExecStore {
  // Non-destructive real-rig Stage Motion Preview state (NEVER mutates permanent keyframes!)
  previewOverlay: MotionPreviewOverlay | null;
  previewResponse: MotionPreviewResponse | null;
  previewTargetKind: 'character' | 'camera';
  previewPresetId: string | null;
  previewInstanceId: string | null;
  previewParams: MotionParameters;
  previewCameraParams: CameraMotionParameters;
  syncCameraFollow: boolean;
  previewReturnFrame: number | null;
  previewLoading: boolean;
  previewError: string | null;

  // Production Plan -> Animation & Camera Execution Modal state
  execModalScope: AnimationExecModalScope | null;

  setPreviewOverlay: (
    overlay: MotionPreviewOverlay | null,
    response: MotionPreviewResponse | null,
    returnFrame?: number | null,
  ) => void;
  setPreviewTarget: (
    targetKind: 'character' | 'camera',
    presetId: string | null,
    instanceId: string | null,
    params?: MotionParameters,
    camParams?: CameraMotionParameters,
  ) => void;
  updatePreviewParams: (patch: Partial<MotionParameters>) => void;
  updatePreviewCameraParams: (patch: Partial<CameraMotionParameters>) => void;
  setSyncCameraFollow: (v: boolean) => void;
  setPreviewLoading: (v: boolean) => void;
  setPreviewError: (err: string | null) => void;
  clearPreview: () => void;

  openAnimationExecModal: (scope?: AnimationExecModalScope) => void;
  closeAnimationExecModal: () => void;
}

export const DEFAULT_MOTION_PARAMS: MotionParameters = {
  duration_ms: 2000,
  speed: 1.0,
  intensity: 1.0,
  distance_px: 240,
  direction: 'right',
  start_pose_id: null,
  end_pose_id: null,
  easing: 'ease_in_out',
  loop: false,
  delay_ms: 0,
};

export const DEFAULT_CAMERA_MOTION_PARAMS: CameraMotionParameters = {
  movement: 'pan_right',
  start_x: -60,
  start_y: 0,
  start_zoom: 1.0,
  start_rotation_deg: 0,
  end_x: 60,
  end_y: 0,
  end_zoom: 1.0,
  end_rotation_deg: 0,
  duration_ms: 2500,
  easing: 'ease_in_out',
  shake_intensity_px: 12,
  shake_frequency_hz: 8,
  follow_instance_id: null,
  follow_strength: 0.85,
  focus_target_id: null,
  delay_ms: 0,
};

export const useAnimationExecStore = create<AnimationExecStore>((set) => ({
  previewOverlay: null,
  previewResponse: null,
  previewTargetKind: 'character',
  previewPresetId: null,
  previewInstanceId: null,
  previewParams: { ...DEFAULT_MOTION_PARAMS },
  previewCameraParams: { ...DEFAULT_CAMERA_MOTION_PARAMS },
  syncCameraFollow: false,
  previewReturnFrame: null,
  previewLoading: false,
  previewError: null,

  execModalScope: null,

  setPreviewOverlay: (previewOverlay, previewResponse, returnFrame) =>
    set((s) => ({
      previewOverlay,
      previewResponse,
      previewReturnFrame: returnFrame !== undefined ? returnFrame : s.previewReturnFrame,
      previewError: null,
    })),

  setPreviewTarget: (targetKind, presetId, instanceId, params, camParams) =>
    set((s) => ({
      previewTargetKind: targetKind,
      previewPresetId: presetId,
      previewInstanceId: instanceId,
      previewParams: params ? { ...params } : s.previewParams,
      previewCameraParams: camParams ? { ...camParams } : s.previewCameraParams,
      previewError: null,
    })),

  updatePreviewParams: (patch) =>
    set((s) => ({ previewParams: { ...s.previewParams, ...patch } })),

  updatePreviewCameraParams: (patch) =>
    set((s) => ({ previewCameraParams: { ...s.previewCameraParams, ...patch } })),

  setSyncCameraFollow: (syncCameraFollow) => set({ syncCameraFollow }),
  setPreviewLoading: (previewLoading) => set({ previewLoading }),
  setPreviewError: (previewError) => set({ previewError }),

  clearPreview: () =>
    set({
      previewOverlay: null,
      previewResponse: null,
      previewReturnFrame: null,
      previewError: null,
      previewLoading: false,
    }),

  openAnimationExecModal: (scope = {}) => set({ execModalScope: scope }),
  closeAnimationExecModal: () => set({ execModalScope: null }),
}));
