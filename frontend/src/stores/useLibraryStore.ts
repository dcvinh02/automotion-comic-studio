import { create } from 'zustand';
import type {
  Asset,
  AudioStarterManifest,
  Character,
  ExportPreset,
  MotionPreset,
  SoundAsset,
  SoundCategoryMeta,
} from '@/types/models';
import { apiClient } from '@/services/apiClient';

interface LibraryStore {
  assets: Asset[];
  characters: Character[];
  sounds: SoundAsset[];
  soundCategories: SoundCategoryMeta[];
  sfxCategories: SoundCategoryMeta[];
  bgmCategories: SoundCategoryMeta[];
  starterManifest: AudioStarterManifest | null;
  exportPresets: ExportPreset[];
  motionPresets: MotionPreset[];
  loading: boolean;
  error: string | null;

  refreshAll: () => Promise<void>;
  refreshAssets: () => Promise<void>;
  refreshCharacters: () => Promise<void>;
  refreshSounds: () => Promise<void>;
  refreshPresets: () => Promise<void>;
  refreshMotionPresets: () => Promise<void>;

  upsertAsset: (asset: Asset) => void;
  removeAsset: (assetId: string) => void;
  upsertCharacter: (char: Character) => void;
  removeCharacter: (characterId: string) => void;
  upsertSound: (sound: SoundAsset) => void;
  removeSound: (soundId: string) => void;
  upsertMotionPreset: (preset: MotionPreset) => void;
  removeMotionPreset: (presetId: string) => void;
}

export const useLibraryStore = create<LibraryStore>((set) => ({
  assets: [],
  characters: [],
  sounds: [],
  soundCategories: [],
  sfxCategories: [],
  bgmCategories: [],
  starterManifest: null,
  exportPresets: [],
  motionPresets: [],
  loading: false,
  error: null,

  refreshAll: async () => {
    set({ loading: true, error: null });
    try {
      const [
        assets,
        characters,
        sounds,
        sfxCategories,
        bgmCategories,
        starterManifest,
        exportPresets,
        motionPresets,
      ] = await Promise.all([
        apiClient.listAssets(),
        apiClient.listCharacters(),
        apiClient.listSounds(),
        apiClient.listSoundCategories('sfx'),
        apiClient.listSoundCategories('bgm'),
        apiClient.getSoundManifest().catch(() => null),
        apiClient.listExportPresets(),
        apiClient.listMotionPresets().catch(() => []),
      ]);
      set({
        assets,
        characters,
        sounds,
        soundCategories: sfxCategories,
        sfxCategories,
        bgmCategories,
        starterManifest,
        exportPresets,
        motionPresets,
        loading: false,
      });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to load library',
      });
    }
  },

  refreshAssets: async () => {
    const assets = await apiClient.listAssets();
    set({ assets });
  },

  refreshCharacters: async () => {
    const characters = await apiClient.listCharacters();
    set({ characters });
  },

  refreshSounds: async () => {
    const sounds = await apiClient.listSounds();
    set({ sounds });
  },

  refreshPresets: async () => {
    const exportPresets = await apiClient.listExportPresets();
    set({ exportPresets });
  },

  refreshMotionPresets: async () => {
    const motionPresets = await apiClient.listMotionPresets();
    set({ motionPresets });
  },

  upsertAsset: (asset) =>
    set((s) => ({
      assets: [asset, ...s.assets.filter((a) => a.asset_id !== asset.asset_id)],
    })),

  removeAsset: (assetId) =>
    set((s) => ({ assets: s.assets.filter((a) => a.asset_id !== assetId) })),

  upsertCharacter: (char) =>
    set((s) => ({
      characters: [char, ...s.characters.filter((c) => c.character_id !== char.character_id)],
    })),

  removeCharacter: (characterId) =>
    set((s) => ({ characters: s.characters.filter((c) => c.character_id !== characterId) })),

  upsertSound: (sound) =>
    set((s) => ({
      sounds: [sound, ...s.sounds.filter((x) => x.sound_id !== sound.sound_id)],
    })),

  removeSound: (soundId) =>
    set((s) => ({ sounds: s.sounds.filter((x) => x.sound_id !== soundId) })),

  upsertMotionPreset: (preset) =>
    set((s) => ({
      motionPresets: [
        preset,
        ...s.motionPresets.filter((p) => p.preset_id !== preset.preset_id),
      ],
    })),

  removeMotionPreset: (presetId) =>
    set((s) => ({
      motionPresets: s.motionPresets.filter((p) => p.preset_id !== presetId),
    })),
}));
