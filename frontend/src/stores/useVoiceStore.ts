import { create } from 'zustand';
import type {
  VoiceAudioAsset,
  VoiceGenerateRequest,
  VoiceProfile,
  VoiceProfileUpsertRequest,
  VoiceProviderInfo,
} from '@/types/models';
import { apiClient } from '@/services/apiClient';
import { useLibraryStore } from '@/stores/useLibraryStore';

export type VoiceJobStatus = 'idle' | 'processing' | 'completed' | 'failed';

let activeAudioEl: HTMLAudioElement | null = null;

function disposeActiveAudio() {
  if (activeAudioEl) {
    try {
      activeAudioEl.pause();
      activeAudioEl.src = '';
    } catch {
      // Ignore cleanup issues in headless environments
    }
    activeAudioEl = null;
  }
}

interface VoiceStore {
  providers: VoiceProviderInfo[];
  profiles: VoiceProfile[];
  projectAudioAssets: VoiceAudioAsset[];
  loading: boolean;
  error: string | null;

  // Per-target generation state keyed by entry_id or 'preview:<characterId>'
  generatingKeys: Record<string, boolean>;
  entryStatus: Record<string, VoiceJobStatus>;
  entryErrors: Record<string, string | null>;

  // Real HTML5 Audio preview player state
  playingAudioId: string | null;
  isAudioPaused: boolean;
  audioCurrentTime: number;
  audioDuration: number;

  refreshAll: () => Promise<void>;
  refreshProviders: () => Promise<void>;
  refreshProfiles: () => Promise<void>;
  refreshProjectAudio: (projectId: string) => Promise<void>;
  clearProjectAudio: () => void;

  createProfile: (payload: VoiceProfileUpsertRequest) => Promise<VoiceProfile>;
  updateProfile: (
    voiceProfileId: string,
    payload: VoiceProfileUpsertRequest,
  ) => Promise<VoiceProfile>;
  deleteProfile: (voiceProfileId: string) => Promise<void>;
  assignCharacterVoice: (characterId: string, voiceProfileId: string | null) => Promise<void>;

  generateVoice: (
    requestKey: string,
    payload: VoiceGenerateRequest,
  ) => Promise<VoiceAudioAsset | null>;

  playAudioAsset: (projectId: string, audioAssetId: string) => void;
  pauseAudio: () => void;
  stopAudio: () => void;
  seekAudio: (seconds: number) => void;
}

export const useVoiceStore = create<VoiceStore>((set, get) => ({
  providers: [],
  profiles: [],
  projectAudioAssets: [],
  loading: false,
  error: null,

  generatingKeys: {},
  entryStatus: {},
  entryErrors: {},

  playingAudioId: null,
  isAudioPaused: false,
  audioCurrentTime: 0,
  audioDuration: 0,

  refreshAll: async () => {
    set({ loading: true, error: null });
    try {
      const [providers, profiles] = await Promise.all([
        apiClient.listVoiceProviders(),
        apiClient.listVoiceProfiles(),
      ]);
      set({ providers, profiles, loading: false });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to load voice providers',
      });
    }
  },

  refreshProviders: async () => {
    const providers = await apiClient.listVoiceProviders();
    set({ providers });
  },

  refreshProfiles: async () => {
    const profiles = await apiClient.listVoiceProfiles();
    set({ profiles });
  },

  refreshProjectAudio: async (projectId) => {
    try {
      const assets = await apiClient.listProjectVoiceAudio(projectId);
      set({ projectAudioAssets: assets });
    } catch {
      // Keep previous list if backend transiently unavailable
    }
  },

  clearProjectAudio: () => {
    disposeActiveAudio();
    set({
      projectAudioAssets: [],
      playingAudioId: null,
      isAudioPaused: false,
      audioCurrentTime: 0,
      audioDuration: 0,
    });
  },

  createProfile: async (payload) => {
    const created = await apiClient.createVoiceProfile(payload);
    set((s) => ({
      profiles: [created, ...s.profiles.filter((p) => p.voice_profile_id !== created.voice_profile_id)],
    }));
    return created;
  },

  updateProfile: async (voiceProfileId, payload) => {
    const updated = await apiClient.updateVoiceProfile(voiceProfileId, payload);
    set((s) => ({
      profiles: [updated, ...s.profiles.filter((p) => p.voice_profile_id !== updated.voice_profile_id)],
    }));
    return updated;
  },

  deleteProfile: async (voiceProfileId) => {
    await apiClient.deleteVoiceProfile(voiceProfileId);
    set((s) => ({
      profiles: s.profiles.filter((p) => p.voice_profile_id !== voiceProfileId),
    }));
    await useLibraryStore.getState().refreshCharacters();
  },

  assignCharacterVoice: async (characterId, voiceProfileId) => {
    const updatedChar = await apiClient.assignCharacterVoice(characterId, voiceProfileId);
    useLibraryStore.getState().upsertCharacter(updatedChar);
  },

  generateVoice: async (requestKey, payload) => {
    // Prevent duplicate concurrent requests for the same line / preview
    if (get().generatingKeys[requestKey]) {
      return null;
    }
    set((s) => ({
      generatingKeys: { ...s.generatingKeys, [requestKey]: true },
      entryStatus: { ...s.entryStatus, [requestKey]: 'processing' },
      entryErrors: { ...s.entryErrors, [requestKey]: null },
    }));

    try {
      const asset = await apiClient.generateVoiceAudio(payload);
      set((s) => ({
        projectAudioAssets: [
          asset,
          ...s.projectAudioAssets.filter((a) => a.audio_asset_id !== asset.audio_asset_id),
        ],
        generatingKeys: { ...s.generatingKeys, [requestKey]: false },
        entryStatus: { ...s.entryStatus, [requestKey]: 'completed' },
        entryErrors: { ...s.entryErrors, [requestKey]: null },
      }));
      return asset;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Voice generation failed';
      set((s) => ({
        generatingKeys: { ...s.generatingKeys, [requestKey]: false },
        entryStatus: { ...s.entryStatus, [requestKey]: 'failed' },
        entryErrors: { ...s.entryErrors, [requestKey]: msg },
      }));
      throw err;
    }
  },

  playAudioAsset: (projectId, audioAssetId) => {
    const state = get();
    // If same audio is paused, resume it
    if (state.playingAudioId === audioAssetId && activeAudioEl && state.isAudioPaused) {
      activeAudioEl.play().catch(() => {});
      set({ isAudioPaused: false });
      return;
    }
    disposeActiveAudio();
    const url = apiClient.getVoiceAudioFileUrl(projectId, audioAssetId);
    const audio = new Audio(url);
    activeAudioEl = audio;

    const known = state.projectAudioAssets.find((a) => a.audio_asset_id === audioAssetId);
    const knownDuration = known ? known.duration_ms / 1000 : 0;

    set({
      playingAudioId: audioAssetId,
      isAudioPaused: false,
      audioCurrentTime: 0,
      audioDuration: knownDuration,
    });

    audio.addEventListener('loadedmetadata', () => {
      if (activeAudioEl === audio && Number.isFinite(audio.duration) && audio.duration > 0) {
        set({ audioDuration: audio.duration });
      }
    });
    audio.addEventListener('timeupdate', () => {
      if (activeAudioEl === audio) {
        set({ audioCurrentTime: audio.currentTime });
      }
    });
    audio.addEventListener('ended', () => {
      if (activeAudioEl === audio) {
        set({
          playingAudioId: null,
          isAudioPaused: false,
          audioCurrentTime: 0,
        });
        activeAudioEl = null;
      }
    });
    audio.addEventListener('error', () => {
      if (activeAudioEl === audio) {
        set({
          playingAudioId: null,
          isAudioPaused: false,
          audioCurrentTime: 0,
        });
        activeAudioEl = null;
      }
    });

    audio.play().catch(() => {
      if (activeAudioEl === audio) {
        set({ isAudioPaused: true });
      }
    });
  },

  pauseAudio: () => {
    if (activeAudioEl && !activeAudioEl.paused) {
      activeAudioEl.pause();
      set({ isAudioPaused: true });
    }
  },

  stopAudio: () => {
    disposeActiveAudio();
    set({
      playingAudioId: null,
      isAudioPaused: false,
      audioCurrentTime: 0,
    });
  },

  seekAudio: (seconds) => {
    if (!activeAudioEl) return;
    const dur = Number.isFinite(activeAudioEl.duration) ? activeAudioEl.duration : get().audioDuration;
    const clamped = Math.max(0, Math.min(dur || 0, seconds));
    activeAudioEl.currentTime = clamped;
    set({ audioCurrentTime: clamped });
  },
}));
