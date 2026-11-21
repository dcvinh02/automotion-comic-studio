import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SUBTITLE_STYLES,
  createDefaultSubtitleDocument,
  formatSrtTimestamp,
  generateSubtitlesFromScript,
  getActiveSubtitlesAtMs,
  mergeSubtitleSegments,
  parseSrt,
  parseSrtTimestamp,
  serializeAss,
  serializeSrt,
  splitSubtitleSegment,
} from './subtitleEngine';
import type { Character, ScriptDocument, SubtitleSegment } from '@/types/models';

describe('Subtitle Studio Engine (Phase 05 Batch 3)', () => {
  it('parses & serializes UTF-8 Vietnamese multiline SRT with exact millisecond fidelity', () => {
    const sampleSrt = [
      '\ufeff1',
      '00:00:00,500 --> 00:00:03,250',
      'Xin chào Việt Nam!',
      'Hôm nay trời thật đẹp và trong xanh.',
      '',
      '2',
      '00:00:04,000 --> 00:00:06,750',
      'Chúng ta cùng bắt đầu câu chuyện nhé!',
      '',
    ].join('\r\n');

    const parsed = parseSrt(sampleSrt);
    expect(parsed.valid).toBe(true);
    expect(parsed.issues).toHaveLength(0);
    expect(parsed.segments).toHaveLength(2);
    expect(parsed.segments[0].start_ms).toBe(500);
    expect(parsed.segments[0].end_ms).toBe(3250);
    expect(parsed.segments[0].text).toBe('Xin chào Việt Nam!\nHôm nay trời thật đẹp và trong xanh.');
    expect(parsed.segments[1].text).toContain('câu chuyện');

    const exported = serializeSrt(parsed.segments);
    expect(exported).toContain('00:00:00,500 --> 00:00:03,250');
    expect(exported).toContain('Xin chào Việt Nam!\nHôm nay trời thật đẹp và trong xanh.');
    expect(exported).toContain('00:00:04,000 --> 00:00:06,750');
    expect(formatSrtTimestamp(parseSrtTimestamp('01:02:03,045')!)).toBe('01:02:03,045');
  });

  it('reports clear validation errors and warnings for malformed or out-of-order SRT', () => {
    const bad = [
      '1',
      '00:00:05,000 --> 00:00:03,000',
      'Invalid reversed time',
      '',
      '2',
      'not a timestamp',
      'Broken cue',
      '',
      '3',
      '00:00:02.000 --> 00:00:04.000',
      'Dot millis cue',
    ].join('\n');

    const res = parseSrt(bad);
    expect(res.valid).toBe(false);
    expect(res.issues.some((i) => i.severity === 'error')).toBe(true);
    expect(res.issues.some((i) => i.severity === 'warning')).toBe(true);
    expect(res.segments).toHaveLength(1);
    expect(res.segments[0].start_ms).toBe(2000);
  });

  it('splits and merges subtitle segments cleanly while respecting playhead and multiline text', () => {
    const seg: SubtitleSegment = {
      subtitle_id: 'sub_1',
      text: 'Dòng đầu tiên\nDòng thứ hai',
      start_ms: 1000,
      end_ms: 4000,
      scene_id: 'scene_1',
      speaker_character_id: 'char_1',
      speaker_name: 'Linh',
      script_entry_id: null,
      voice_audio_asset_id: null,
      timing_source: 'manual',
      style_id: 'style_classic_white',
      position_override: null,
      enabled: true,
    };

    const split = splitSubtitleSegment(seg, 2400);
    expect(split).not.toBeNull();
    const [a, b] = split!;
    expect(a.start_ms).toBe(1000);
    expect(a.end_ms).toBe(2400);
    expect(a.text).toBe('Dòng đầu tiên');
    expect(b.start_ms).toBe(2400);
    expect(b.end_ms).toBe(4000);
    expect(b.text).toBe('Dòng thứ hai');
    expect(b.subtitle_id).not.toBe(a.subtitle_id);

    const merged = mergeSubtitleSegments([b, a]);
    expect(merged).not.toBeNull();
    expect(merged!.start_ms).toBe(1000);
    expect(merged!.end_ms).toBe(4000);
    expect(merged!.text).toBe('Dòng đầu tiên\nDòng thứ hai');
  });

  it('filters hidden subtitles and hidden tracks during preview lookup and exports styled ASS', () => {
    const doc = createDefaultSubtitleDocument();
    doc.segments = [
      {
        subtitle_id: 'sub_vis',
        text: 'Hiển thị rõ ràng',
        start_ms: 500,
        end_ms: 2500,
        scene_id: null,
        speaker_character_id: null,
        speaker_name: 'An',
        script_entry_id: null,
        voice_audio_asset_id: null,
        timing_source: 'manual',
        style_id: 'style_bold_comic',
        position_override: 'top',
        enabled: true,
      },
      {
        subtitle_id: 'sub_hid',
        text: 'Bị ẩn',
        start_ms: 500,
        end_ms: 2500,
        scene_id: null,
        speaker_character_id: null,
        speaker_name: '',
        script_entry_id: null,
        voice_audio_asset_id: null,
        timing_source: 'manual',
        style_id: 'style_classic_white',
        position_override: null,
        enabled: false,
      },
    ];

    expect(getActiveSubtitlesAtMs(doc, 1000, true).map((s) => s.subtitle_id)).toEqual(['sub_vis']);
    expect(getActiveSubtitlesAtMs(doc, 1000, false)).toHaveLength(0);
    expect(getActiveSubtitlesAtMs(doc, 2500, true)).toHaveLength(0);

    const ass = serializeAss(doc.segments, DEFAULT_SUBTITLE_STYLES, 1920, 1080);
    expect(ass).toContain('[V4+ Styles]');
    expect(ass).toContain('Style: style_bold_comic');
    expect(ass).toContain('{\\an8}Hiển thị rõ ràng');
    expect(ass).not.toContain('Bị ẩn');
  });

  it('generates subtitles from Script & Voice, truthfully separating voice_duration vs estimated timing', () => {
    const characters: Character[] = [
      {
        character_id: 'char_minh',
        name: 'Minh',
        description: '',
        tags: [],
        identity_confirmed: true,
        thumbnail_asset_id: null,
        voice_profile_id: null,
        parts: [],
        expressions: [],
        poses: [],
        version: 1,
        created_at: '',
        updated_at: '',
      },
    ];
    const script: ScriptDocument = {
      episode_title: 'Tập 1',
      raw_source_text: '',
      updated_at: '',
      scenes: [
        {
          script_scene_id: 'sc_1',
          linked_stage_scene_id: 'stage_sc_1',
          order_index: 0,
          title: 'Cảnh 1',
          location: '',
          time_of_day: '',
          description: '',
          background_asset_id: null,
          character_ids: ['char_minh'],
          notes: '',
          estimated_duration_ms: 5000,
          entries: [
            {
              entry_id: 'e1',
              entry_type: 'dialogue',
              order_index: 0,
              character_id: 'char_minh',
              narrator_label: 'Narrator',
              text: 'Chào buổi sáng!',
              voice_profile_id: null,
              emotion: 'happy',
              delivery_style: 'normal',
              pause_before_ms: 200,
              pause_after_ms: 300,
              estimated_duration_ms: 2000,
              audio_asset_id: 'va_123',
              audio_duration_ms: 1450,
              sound_effect_ids: [],
            },
            {
              entry_id: 'e2',
              entry_type: 'narration',
              order_index: 1,
              character_id: null,
              narrator_label: 'Người kể chuyện',
              text: 'Mặt trời vừa mọc trên ngọn đồi.',
              voice_profile_id: null,
              emotion: 'neutral',
              delivery_style: 'normal',
              pause_before_ms: 0,
              pause_after_ms: 200,
              estimated_duration_ms: 2400,
              audio_asset_id: null,
              audio_duration_ms: null,
              sound_effect_ids: [],
            },
            {
              entry_id: 'e3',
              entry_type: 'action',
              order_index: 2,
              character_id: null,
              narrator_label: '',
              text: 'Minh mở cửa sổ',
              voice_profile_id: null,
              emotion: 'neutral',
              delivery_style: 'normal',
              pause_before_ms: 0,
              pause_after_ms: 0,
              estimated_duration_ms: 1000,
              audio_asset_id: null,
              audio_duration_ms: null,
              sound_effect_ids: [],
            },
          ],
        },
      ],
    };

    const res = generateSubtitlesFromScript(script, characters);
    expect(res.segments).toHaveLength(2);
    expect(res.voiceSyncedCount).toBe(1);
    expect(res.estimatedCount).toBe(1);

    expect(res.segments[0].speaker_name).toBe('Minh');
    expect(res.segments[0].scene_id).toBe('stage_sc_1');
    expect(res.segments[0].timing_source).toBe('voice_duration');
    expect(res.segments[0].start_ms).toBe(200);
    expect(res.segments[0].end_ms).toBe(1650);

    expect(res.segments[1].speaker_name).toBe('Người kể chuyện');
    expect(res.segments[1].timing_source).toBe('estimated');
    expect(res.segments[1].start_ms).toBe(1950);
    expect(res.segments[1].end_ms).toBe(4350);
  });
});
