import { create } from 'zustand';

interface PlaybackStore {
  isPlaying: boolean;
  currentFrame: number;
  loop: boolean;
  timelineZoomPxPerSec: number; // Default 60 px/sec
  snapEnabled: boolean;

  setPlaying: (playing: boolean) => void;
  setCurrentFrame: (frame: number) => void;
  stepFrames: (delta: number, maxFrame: number) => void;
  setLoop: (loop: boolean) => void;
  setTimelineZoom: (pxPerSec: number) => void;
  setSnapEnabled: (snap: boolean) => void;
}

export const usePlaybackStore = create<PlaybackStore>((set) => ({
  isPlaying: false,
  currentFrame: 0,
  loop: false,
  timelineZoomPxPerSec: 60,
  snapEnabled: true,

  setPlaying: (isPlaying) => set({ isPlaying }),
  setCurrentFrame: (currentFrame) => set({ currentFrame: Math.max(0, Math.round(currentFrame)) }),
  stepFrames: (delta, maxFrame) =>
    set((s) => ({
      isPlaying: false,
      currentFrame: Math.max(0, Math.min(maxFrame, s.currentFrame + delta)),
    })),
  setLoop: (loop) => set({ loop }),
  setTimelineZoom: (px) => set({ timelineZoomPxPerSec: Math.max(15, Math.min(240, px)) }),
  setSnapEnabled: (snapEnabled) => set({ snapEnabled }),
}));
