import { beforeEach, describe, expect, it, vi } from 'vitest';
import enDict from '@/locales/en.json';
import viDict from '@/locales/vi.json';
import { clampAndRoundNumber, parseValidNumber } from '@/components/ui/PropertyControls';
import { estimateScriptEntryDurationMs } from '@/engine/scriptEngine';
import { apiClient } from '@/services/apiClient';
import { useProjectStore } from '@/stores/useProjectStore';
import { useVoiceStore } from '@/stores/useVoiceStore';
import type { ProjectState, SoundAsset, VoiceAudioAsset } from '@/types/models';

function makeProject(): ProjectState {
  return {
    meta: {
      project_id: 'proj_p4_script',
      name: 'Phase 04 Script & Voice Test',
      description: '',
      schema_version: '0.1.0',
      width: 1920,
      height: 1080,
      fps: 30,
      duration_ms: 10000,
      default_export_preset_id: 'preset_1080p_final',
      auto_save_enabled: true,
      created_at: '',
      updated_at: '',
    },
    scenes: [
      {
        scene_id: 'scene_1',
        project_id: 'proj_p4_script',
        order_index: 0,
        name: 'Scene 1',
        start_ms: 0,
        duration_ms: 10000,
        background_asset_id: null,
        background_color: '#101216',
        transition_in: 'cut',
        transition_duration_ms: 0,
        camera_default: { x: 0, y: 0, zoom: 1, rotation_deg: 0 },
        characters: [],
        props: [],
      },
    ],
    timeline: {
      project_id: 'proj_p4_script',
      fps: 30,
      total_duration_ms: 10000,
      tracks: [
        {
          track_id: 'trk_scene',
          project_id: 'proj_p4_script',
          track_type: 'scene',
          name: 'Scenes',
          target_ref_id: null,
          order_index: 0,
          muted: false,
          locked: false,
          solo: false,
          visible: true,
          volume: 1,
          collapsed: false,
        },
        {
          track_id: 'trk_sfx_1',
          project_id: 'proj_p4_script',
          track_type: 'sfx',
          name: 'SFX Track 1',
          target_ref_id: null,
          order_index: 1000,
          muted: false,
          locked: false,
          solo: false,
          visible: true,
          volume: 1,
          collapsed: false,
        },
      ],
      keyframes: [],
      animation_clips: [],
      sound_events: [],
    },
  };
}

describe('Phase 04 — Script Engine, Voice Store, Pro Inspector Math & Bilingual Parity', () => {
  beforeEach(() => {
    useProjectStore.setState({
      project: makeProject(),
      activeSceneId: 'scene_1',
      activeScriptSceneId: null,
      selectedScriptEntryId: null,
      selection: { type: 'none', id: null },
      isDirty: false,
      undoStack: [],
      redoStack: [],
    });
    useVoiceStore.setState({
      providers: [],
      profiles: [],
      projectAudioAssets: [],
      generatingKeys: {},
      entryStatus: {},
      entryErrors: {},
      playingAudioId: null,
      isAudioPaused: false,
    });
    vi.restoreAllMocks();
  });

  it('creates, reorders, updates script scenes & dialogue/narration/action entries with Undo/Redo', () => {
    const store = useProjectStore.getState();
    store.updateScriptMeta({ episode_title: 'Tập 1: Khởi Đầu' });

    const s1 = store.addScriptScene('Cảnh 1: Sân Trường');
    const s2 = store.addScriptScene('Cảnh 2: Thư Viện');
    expect(useProjectStore.getState().project!.script!.scenes.map((s) => s.script_scene_id)).toEqual([
      s1,
      s2,
    ]);

    // Drag-reorder Scene 2 before Scene 1
    expect(store.reorderScriptScenes(s2, s1, 'before')).toBe(true);
    expect(useProjectStore.getState().project!.script!.scenes.map((s) => s.script_scene_id)).toEqual([
      s2,
      s1,
    ]);

    // Add Dialogue, Narration, Action to Scene 1
    const e1 = store.addScriptEntry(s1, 'dialogue', 'char_minh');
    const e2 = store.addScriptEntry(s1, 'narration', null);
    const e3 = store.addScriptEntry(s1, 'action', null);

    store.updateScriptEntry(s1, e1, {
      text: 'Chào buổi sáng! Hôm nay trời đẹp quá.',
      emotion: 'happy',
      pause_before_ms: 150,
      pause_after_ms: 350,
    });
    store.updateScriptEntry(s1, e2, {
      narrator_label: 'Người dẫn chuyện',
      text: 'Ánh nắng chiếu rọi khắp sân trường.',
    });
    store.updateScriptEntry(s1, e3, {
      text: 'Minh vẫy tay mỉm cười.',
    });

    // Move e3 up before e2
    expect(store.moveScriptEntry(s1, e3, -1)).toBe(true);
    let sc1 = useProjectStore.getState().project!.script!.scenes.find((s) => s.script_scene_id === s1)!;
    expect(sc1.entries.map((e) => e.entry_id)).toEqual([e1, e3, e2]);
    // Verbatim user text is never modified
    expect(sc1.entries[0].text).toBe('Chào buổi sáng! Hôm nay trời đẹp quá.');
    expect(sc1.entries[0].character_id).toBe('char_minh');
    expect(sc1.estimated_duration_ms).toBeGreaterThan(3000);

    // Real audio duration overrides text estimation cleanly
    store.updateScriptEntry(s1, e1, { audio_asset_id: 'vaud_1', audio_duration_ms: 2450 });
    sc1 = useProjectStore.getState().project!.script!.scenes.find((s) => s.script_scene_id === s1)!;
    expect(estimateScriptEntryDurationMs(sc1.entries[0])).toBe(150 + 2450 + 350);

    // Undo restores previous state cleanly
    useProjectStore.getState().undo();
    sc1 = useProjectStore.getState().project!.script!.scenes.find((s) => s.script_scene_id === s1)!;
    expect(sc1.entries[0].audio_asset_id).toBeNull();
  });

  it('syncs script scenes to Stage scenes and places generated voice audio onto dedicated Voice Track', () => {
    const store = useProjectStore.getState();
    const s1 = store.addScriptScene('Opening');
    const s2 = store.addScriptScene('Climax');
    store.addScriptEntry(s1, 'dialogue', 'char_1');
    store.addScriptEntry(s2, 'narration', null);

    const synced = store.syncScriptScenesToStage();
    expect(synced).toBe(2);
    const proj = useProjectStore.getState().project!;
    expect(proj.scenes.length).toBe(2);
    expect(proj.scenes[0].name).toBe('Opening');
    expect(proj.scenes[1].name).toBe('Climax');

    // Add voice clip to Master Timeline -> auto-creates dedicated voice track in order_index band 500
    const mockSound: SoundAsset = {
      sound_id: 'snd_voice_1',
      name: 'Minh: Xin chào',
      category: 'crowd',
      tags: ['voice'],
      file_path: 'audio/voice/vaud_1.wav',
      sha256: 'abc',
      duration_ms: 3200,
      sample_rate: 48000,
      channels: 1,
      codec: 'pcm_s16le',
      default_volume: 1.0,
      loopable: false,
      fade_in_ms: 0,
      fade_out_ms: 0,
      is_favorite: false,
      waveform_peaks: [0.2, 0.7, 0.4],
      license: { source: 'user_imported', usage: 'verified', attribution: '', notes: '' },
      created_at: '',
    };

    const evId = store.addVoiceClipToTimeline(mockSound, 1000, proj.scenes[0].scene_id);
    const after = useProjectStore.getState().project!;
    const voiceTrack = after.timeline.tracks.find((t) => t.track_type === 'voice');
    const sfxTrack = after.timeline.tracks.find((t) => t.track_type === 'sfx');
    expect(voiceTrack).toBeDefined();
    expect(sfxTrack).toBeDefined();
    expect(voiceTrack!.order_index).toBeLessThan(sfxTrack!.order_index);
    const clip = after.timeline.sound_events.find((e) => e.event_id === evId);
    expect(clip).toBeDefined();
    expect(clip!.track_id).toBe(voiceTrack!.track_id);
    expect(clip!.start_ms).toBe(1000);
    expect(clip!.end_ms).toBe(4200);
  });

  it('prevents duplicate concurrent voice generation requests and surfaces real backend errors', async () => {
    let resolveFirst!: (val: VoiceAudioAsset) => void;
    const deferred = new Promise<VoiceAudioAsset>((res) => {
      resolveFirst = res;
    });
    const spy = vi.spyOn(apiClient, 'generateVoiceAudio').mockReturnValueOnce(deferred);

    const p1 = useVoiceStore.getState().generateVoice('entry_1', {
      project_id: 'proj_p4_script',
      text: 'Hello',
      entry_id: 'entry_1',
    });
    // Second concurrent call with the same requestKey must be blocked immediately
    const p2 = useVoiceStore.getState().generateVoice('entry_1', {
      project_id: 'proj_p4_script',
      text: 'Hello',
      entry_id: 'entry_1',
    });
    expect(await p2).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(useVoiceStore.getState().entryStatus['entry_1']).toBe('processing');

    resolveFirst({
      audio_asset_id: 'vaud_ok',
      project_id: 'proj_p4_script',
      entry_id: 'entry_1',
      character_id: null,
      voice_profile_id: null,
      provider_id: 'local_os_tts',
      provider_voice_id: 'Linh',
      provider_kind: 'local_os_tts',
      is_mock: false,
      text: 'Hello',
      file_path: 'audio/voice/vaud_ok.wav',
      duration_ms: 1400,
      sample_rate: 48000,
      channels: 1,
      codec: 'pcm_s16le',
      waveform_peaks: [0.3, 0.8],
      created_at: '',
    });
    const out = await p1;
    expect(out?.audio_asset_id).toBe('vaud_ok');
    expect(useVoiceStore.getState().entryStatus['entry_1']).toBe('completed');

    // Error handling test (e.g. unconfigured F5-TTS provider)
    vi.spyOn(apiClient, 'generateVoiceAudio').mockRejectedValueOnce(
      new Error('F5-TTS is not configured. Set AMCS_F5_TTS_URL.'),
    );
    await expect(
      useVoiceStore.getState().generateVoice('entry_err', {
        project_id: 'proj_p4_script',
        text: 'Test fail',
        provider_id: 'f5_tts',
      }),
    ).rejects.toThrow(/AMCS_F5_TTS_URL/);
    expect(useVoiceStore.getState().entryStatus['entry_err']).toBe('failed');
    expect(useVoiceStore.getState().entryErrors['entry_err']).toContain('AMCS_F5_TTS_URL');
  });

  it('validates Pro Inspector NumericInput parsing & clamping cleanly (rejecting NaN/Infinity/invalid text)', () => {
    expect(parseValidNumber('125.5')).toBe(125.5);
    expect(parseValidNumber(' -42.25 ')).toBe(-42.25);
    expect(parseValidNumber('abc')).toBeNull();
    expect(parseValidNumber('')).toBeNull();
    expect(parseValidNumber('Infinity')).toBeNull();
    expect(parseValidNumber('NaN')).toBeNull();

    expect(clampAndRoundNumber(150, { min: 0, max: 100, precision: 0 })).toBe(100);
    expect(clampAndRoundNumber(-0.0001, { precision: 2 })).toBe(0);
    expect(clampAndRoundNumber(1.236, { min: 0.05, max: 10, precision: 2 })).toBe(1.24);
  });

  it('maintains 100% key parity between en.json and vi.json with zero empty translations', () => {
    const enKeys = Object.keys(enDict).sort();
    const viKeys = Object.keys(viDict).sort();
    expect(viKeys).toEqual(enKeys);

    for (const key of enKeys) {
      expect((enDict as Record<string, string>)[key].trim().length).toBeGreaterThan(0);
      expect((viDict as Record<string, string>)[key].trim().length).toBeGreaterThan(0);
    }
  });
});
