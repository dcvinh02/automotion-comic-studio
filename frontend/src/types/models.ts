export interface AnchorPoint {
  x: number;
  y: number;
}

export interface Transform2D {
  x: number;
  y: number;
  rotation_deg: number;
  scale_x: number;
  scale_y: number;
  opacity: number;
}

export interface PartialTransform2D {
  x?: number | null;
  y?: number | null;
  rotation_deg?: number | null;
  scale_x?: number | null;
  scale_y?: number | null;
  opacity?: number | null;
}

export interface CameraState {
  x: number;
  y: number;
  zoom: number;
  rotation_deg: number;
}

export type AssetScope = 'global' | 'project';
export type AssetType = 'character_part' | 'background' | 'prop' | 'spritesheet';
export type PartRole =
  | 'body'
  | 'head'
  | 'hair'
  | 'hair_back'
  | 'hair_front'
  | 'eyes'
  | 'eyebrows'
  | 'mouth'
  | 'left_arm'
  | 'right_arm'
  | 'left_hand'
  | 'right_hand'
  | 'left_leg'
  | 'right_leg'
  | 'left_foot'
  | 'right_foot'
  | 'clothing'
  | 'accessory'
  | 'custom'
  | 'other';

export interface Asset {
  asset_id: string;
  scope: AssetScope;
  project_id: string | null;
  type: AssetType;
  part_role: PartRole | null;
  name: string;
  folder: string;
  tags: string[];
  file_path: string;
  sha256: string;
  width: number;
  height: number;
  default_anchor: AnchorPoint;
  version: number;
  identity_verified: boolean;
  created_at: string;
}

export interface CharacterPartSlot {
  slot_id: string;
  name: string;
  part_role: PartRole;
  parent_slot_id: string | null;
  default_asset_id: string | null;
  variants: Record<string, string>;
  z_index: number;
  anchor_x: number;
  anchor_y: number;
  default_transform: Transform2D;
  visible: boolean;
  locked?: boolean;
}

export interface ExpressionPreset {
  expression_id: string;
  name: string;
  slot_variant_overrides: Record<string, string>;
  slot_transform_overrides: Record<string, PartialTransform2D>;
}

export interface PosePreset {
  pose_id: string;
  name: string;
  slot_transforms: Record<string, PartialTransform2D>;
}

export interface Character {
  character_id: string;
  name: string;
  description: string;
  tags: string[];
  identity_confirmed: boolean;
  thumbnail_asset_id: string | null;
  voice_profile_id: string | null;
  parts: CharacterPartSlot[];
  expressions: ExpressionPreset[];
  poses: PosePreset[];
  version: number;
  created_at: string;
  updated_at: string;
}

export type TransitionType = 'cut' | 'fade' | 'cross_dissolve';

export interface SceneCharacterInstance {
  instance_id: string;
  scene_id: string;
  character_id: string;
  display_name: string;
  z_index: number;
  visible?: boolean;
  locked?: boolean;
  initial_transform: Transform2D;
  default_expression_id: string | null;
  default_pose_id: string | null;
  default_eye_state: string;
  default_mouth_state: string;
}

export interface ScenePropInstance {
  prop_instance_id: string;
  asset_id: string | null;
  layer_kind?: 'prop' | 'empty';
  name: string;
  z_index: number;
  anchor_x?: number;
  anchor_y?: number;
  visible?: boolean;
  locked?: boolean;
  parent_id?: string | null;
  transform: Transform2D;
}

export type ShotExecutionStatus = 'assembled' | 'partial' | 'edited' | 'warning';

export interface ShotCharacterState {
  instance_id: string;
  character_id: string;
  display_name: string;
  visible: boolean;
  z_index: number;
  transform: Transform2D;
  facing_direction: string;
  screen_position: string;
  depth_layer: string;
  pose_id: string | null;
  expression_id: string | null;
  animation_state: string | null;
  staging_fallback_used: boolean;
  staging_fallback_reason: string;
}

export interface ShotPropState {
  prop_instance_id: string;
  asset_id: string | null;
  name: string;
  role: 'prop' | 'environment' | 'foreground';
  visible: boolean;
  z_index: number;
  transform: Transform2D;
}

export interface SceneShot {
  shot_id: string;
  scene_id: string;
  production_shot_id: string | null;
  storyboard_shot_id: string | null;
  shot_order: number;
  title: string;
  start_ms: number;
  duration_ms: number;
  background_asset_id: string | null;
  background_color?: string | null;
  camera_default: CameraState;
  character_states: ShotCharacterState[];
  prop_states: ShotPropState[];
  asset_refs: string[];
  animation_refs: string[];
  applied_motions?: GeneratedMotionRecord[];
  execution_status: ShotExecutionStatus;
  warnings: string[];
  staging_fallbacks: string[];
  updated_at?: string;
}

export interface SceneExecutionMeta {
  executed: boolean;
  production_plan_id: string | null;
  source_scene_id: string | null;
  executed_at: string | null;
  owned_shot_ids: string[];
  owned_character_instance_ids: string[];
  owned_prop_instance_ids: string[];
  execution_warnings: string[];
}

export interface Scene {
  scene_id: string;
  project_id: string;
  order_index: number;
  name: string;
  start_ms: number;
  duration_ms: number;
  background_asset_id: string | null;
  background_color: string;
  transition_in: TransitionType;
  transition_duration_ms: number;
  camera_default: CameraState;
  characters: SceneCharacterInstance[];
  props: ScenePropInstance[];
  shots?: SceneShot[];
  execution_meta?: SceneExecutionMeta | null;
}

export type TrackType =
  | 'scene'
  | 'camera'
  | 'character'
  | 'prop'
  | 'sfx'
  | 'voice'
  | 'lipsync'
  | 'ambient'
  | 'bgm'
  | 'subtitle';

export type EasingType =
  | 'hold'
  | 'linear'
  | 'ease_in'
  | 'ease_out'
  | 'ease_in_out'
  | 'step'
  | 'cubic_bezier';

export type AnimationStateType =
  | 'IDLE'
  | 'WALKING'
  | 'RUNNING'
  | 'SPEAKING'
  | 'LISTENING'
  | 'REACTING'
  | 'SURPRISED'
  | 'ANGRY'
  | 'SAD'
  | 'HAPPY'
  | 'CRYING'
  | 'TRANSITION';

export type KeyframeTargetType =
  | 'character_instance'
  | 'character_part'
  | 'prop'
  | 'camera';

export type KeyframeProperty =
  | 'x'
  | 'y'
  | 'rotation_deg'
  | 'scale_x'
  | 'scale_y'
  | 'opacity'
  | 'zoom'
  | 'expression_id'
  | 'pose_id'
  | 'eye_state'
  | 'mouth_state'
  | 'animation_state';

export interface Keyframe {
  keyframe_id: string;
  track_id: string;
  target_type: KeyframeTargetType;
  target_id: string;
  property: KeyframeProperty;
  time_ms: number;
  value: number | string;
  easing: EasingType;
  bezier_handles?: [number, number, number, number] | null;
}

export interface ProceduralAnimationConfig {
  auto_blink: boolean;
  blink_interval_ms: number;
  blink_duration_ms: number;
  breathing: boolean;
  breathing_amplitude: number;
  breathing_period_ms: number;
  walk_bounce_px: number;
  walk_cycle_ms: number;
}

export interface CharacterAnimationClip {
  clip_id: string;
  track_id: string;
  instance_id: string;
  start_ms: number;
  end_ms: number;
  animation_state: AnimationStateType;
  procedural: ProceduralAnimationConfig;
}

export interface SoundEffectEvent {
  event_id: string;
  track_id: string;
  sound_id: string;
  start_ms: number;
  end_ms: number;
  trim_start_ms: number;
  volume: number;
  speed: number;
  fade_in_ms: number;
  fade_out_ms: number;
  loop: boolean;
  spatial_position: number;
  source_scene_id: string | null;
}

export interface TimelineTrack {
  track_id: string;
  project_id: string;
  track_type: TrackType;
  name: string;
  target_ref_id: string | null;
  order_index: number;
  muted: boolean;
  locked: boolean;
  solo: boolean;
  visible?: boolean;
  volume: number;
  collapsed: boolean;
}

export interface MasterTimeline {
  project_id: string;
  fps: number;
  total_duration_ms: number;
  tracks: TimelineTrack[];
  keyframes: Keyframe[];
  animation_clips: CharacterAnimationClip[];
  sound_events: SoundEffectEvent[];
}

export interface ProjectMeta {
  project_id: string;
  name: string;
  description: string;
  schema_version: string;
  width: number;
  height: number;
  fps: number;
  duration_ms: number;
  default_export_preset_id: string;
  auto_save_enabled: boolean;
  created_at: string;
  updated_at: string;
}

export type ScriptEntryType = 'dialogue' | 'narration' | 'action';

export interface ScriptEntry {
  entry_id: string;
  entry_type: ScriptEntryType;
  order_index: number;
  character_id: string | null;
  narrator_label: string;
  text: string;
  voice_profile_id: string | null;
  emotion: string;
  delivery_style: string;
  pause_before_ms: number;
  pause_after_ms: number;
  estimated_duration_ms: number;
  audio_asset_id: string | null;
  audio_duration_ms: number | null;
  sound_effect_ids: string[];
}

export interface ScriptScene {
  script_scene_id: string;
  linked_stage_scene_id: string | null;
  order_index: number;
  title: string;
  location: string;
  time_of_day: string;
  description: string;
  background_asset_id: string | null;
  character_ids: string[];
  notes: string;
  entries: ScriptEntry[];
  estimated_duration_ms: number;
}

export interface ScriptDocument {
  episode_title: string;
  raw_source_text: string;
  scenes: ScriptScene[];
  updated_at: string;
}

export type VoiceProviderKind = 'local_os_tts' | 'real_local_ai' | 'real_cloud_ai' | 'dev_mock';

export interface VoiceSettingSpec {
  key: string;
  label: string;
  type: 'number' | 'select';
  min?: number | null;
  max?: number | null;
  step?: number | null;
  default: number | string;
  options: string[];
}

export interface VoiceOption {
  voice_id: string;
  name: string;
  language: string;
  gender: string;
  description: string;
}

export interface VoiceProviderInfo {
  provider_id: string;
  display_name: string;
  provider_kind: VoiceProviderKind;
  is_mock: boolean;
  is_configured: boolean;
  status_message: string;
  supported_languages: string[];
  supported_settings: VoiceSettingSpec[];
  voices: VoiceOption[];
}

export interface VoiceProfile {
  voice_profile_id: string;
  name: string;
  provider_id: string;
  provider_voice_id: string;
  language: string;
  settings: Record<string, number | string>;
  created_at: string;
  updated_at: string;
}

export interface VoiceProfileUpsertRequest {
  name: string;
  provider_id: string;
  provider_voice_id: string;
  language: string;
  settings: Record<string, number | string>;
}

export interface VoiceAudioAsset {
  audio_asset_id: string;
  project_id: string;
  entry_id: string | null;
  character_id: string | null;
  voice_profile_id: string | null;
  provider_id: string;
  provider_voice_id: string;
  provider_kind: VoiceProviderKind;
  is_mock: boolean;
  text: string;
  file_path: string;
  duration_ms: number;
  sample_rate: number;
  channels: number;
  codec: string;
  waveform_peaks: number[];
  created_at: string;
}

export interface VoiceGenerateRequest {
  project_id: string;
  text: string;
  entry_id?: string | null;
  character_id?: string | null;
  voice_profile_id?: string | null;
  provider_id?: string | null;
  provider_voice_id?: string | null;
  language?: string | null;
  settings?: Record<string, number | string>;
}

export type F5TTSServiceMode = 'external_http' | 'local_managed';
export type F5TTSDevicePreference = 'auto' | 'cuda' | 'mps' | 'cpu';

export interface F5TTSConfig {
  mode: F5TTSServiceMode;
  service_url: string;
  python_executable: string;
  model_name: string;
  device_preference: F5TTSDevicePreference;
  default_language: string;
  timeout_seconds: number;
  nfe_step: number;
  cfg_strength: number;
  cross_fade_duration: number;
}

export interface F5TTSReferenceVoice {
  ref_id: string;
  name: string;
  language: string;
  transcript: string;
  file_path: string;
  duration_ms: number;
  sample_rate: number;
  channels: number;
  waveform_peaks: number[];
  created_at: string;
}

export interface F5TTSStatus {
  mode: F5TTSServiceMode;
  service_url: string;
  installed: boolean;
  cli_path: string | null;
  gradio_cli_path: string | null;
  torch_installed: boolean;
  gpu_available: boolean;
  gpu_backend: 'cuda' | 'mps' | 'cpu' | 'none';
  device_info: string;
  cpu_fallback_supported: boolean;
  managed_process_running: boolean;
  managed_pid: number | null;
  connection_ok: boolean;
  service_status: 'running' | 'stopped' | 'not_installed' | 'error' | 'unreachable';
  model_status: 'ready' | 'not_loaded' | 'not_installed' | 'unknown';
  status_message: string;
  install_instructions: string[];
  logs: string[];
  reference_count: number;
  config: F5TTSConfig;
}

export interface F5TTSTestConnectionResult {
  ok: boolean;
  status_code: number | null;
  latency_ms: number;
  detected_api_style: 'http_api' | 'gradio' | 'unknown';
  message: string;
}

export type SubtitlePosition = 'bottom' | 'center' | 'top';
export type SubtitleAlignment = 'left' | 'center' | 'right';
export type SubtitleFontWeight = 'normal' | 'semibold' | 'bold' | 'extrabold';
export type SubtitleTimingSource = 'manual' | 'voice_duration' | 'estimated' | 'imported_srt';
export type SubtitleExportMode = 'none' | 'burn_in' | 'soft';

export interface SubtitleStyle {
  style_id: string;
  name: string;
  is_builtin: boolean;
  font_family: string;
  font_size: number;
  font_weight: SubtitleFontWeight;
  italic?: boolean;
  underline?: boolean;
  letter_spacing?: number;
  text_color: string;
  outline_color: string;
  outline_width: number;
  shadow_enabled: boolean;
  shadow_color: string;
  shadow_opacity?: number;
  shadow_blur: number;
  shadow_offset_x: number;
  shadow_offset_y: number;
  background_enabled: boolean;
  background_color: string;
  background_opacity: number;
  background_padding_x?: number;
  background_padding_y?: number;
  alignment: SubtitleAlignment;
  position: SubtitlePosition;
  offset_x?: number;
  offset_y?: number;
  margin_x: number;
  margin_y: number;
  line_spacing: number;
  max_width_pct: number;
  box_height_px?: number;
  word_wrap: boolean;
  safe_area_clamp?: boolean;
}

export type SubtitleStyleOverride = Partial<
  Omit<SubtitleStyle, 'style_id' | 'name' | 'is_builtin'>
>;

export interface SubtitleSegment {
  subtitle_id: string;
  text: string;
  start_ms: number;
  end_ms: number;
  scene_id: string | null;
  speaker_character_id: string | null;
  speaker_name: string;
  script_entry_id: string | null;
  voice_audio_asset_id: string | null;
  timing_source: SubtitleTimingSource;
  style_id: string;
  position_override: SubtitlePosition | null;
  style_override?: SubtitleStyleOverride | null;
  enabled: boolean;
}

export interface SubtitleDocument {
  default_style_id: string;
  styles: SubtitleStyle[];
  segments: SubtitleSegment[];
}

export interface SrtValidationIssue {
  line: number;
  severity: 'warning' | 'error';
  message: string;
}

export interface SrtImportResponse {
  valid: boolean;
  segments: SubtitleSegment[];
  issues: SrtValidationIssue[];
}

export type LLMProviderId =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'deepseek'
  | 'openrouter'
  | 'groq'
  | 'openai_compatible';
export type AIFeatureKey =
  | 'script_analysis'
  | 'script_generation'
  | 'character_analysis'
  | 'storyboard'
  | 'ai_director'
  | 'production_plan'
  | 'animation_planning'
  | 'asset_prompts';
export type AnalysisLanguage = 'auto' | 'vi' | 'en';
export type ScriptSourceMode = 'auto' | 'raw_text' | 'structured_scenes' | 'custom_text';
export type DirectorReviewStatus = 'pending' | 'accepted' | 'rejected' | 'edited';
export type ExtractedItemType =
  | 'dialogue'
  | 'narration'
  | 'internal_thought'
  | 'action'
  | 'scene_description'
  | 'sound_cue';
export type SceneImportance = 'low' | 'medium' | 'high' | 'climax';

export interface AIModelInfo {
  model_id: string;
  display_name: string;
  provider_id: LLMProviderId;
  source: 'discovered' | 'catalog' | 'manual';
  context_length: number | null;
  supports_text: boolean;
  supports_structured_json: boolean;
  supports_vision: boolean;
  supports_reasoning: boolean;
  supports_tools: boolean;
  deprecated: boolean;
  notes: string;
}

export interface AIModelDiscoveryResult {
  provider_id: LLMProviderId;
  models: AIModelInfo[];
  source: 'live_api' | 'cache' | 'catalog_fallback';
  discovered_count: number;
  fetched_at: string | null;
  error: string | null;
  error_code:
    | 'none'
    | 'missing_credentials'
    | 'invalid_credentials'
    | 'rate_limited'
    | 'network_error'
    | 'http_error';
  selected_model_valid: boolean;
  selected_model_warning: string;
}

export interface FeatureModelOverride {
  provider_id?: LLMProviderId | null;
  model?: string | null;
}

export interface ModelCompatibilityResult {
  compatible: boolean;
  feature_key: AIFeatureKey;
  provider_id: LLMProviderId;
  model: string;
  reasons: string[];
  recommended_models: string[];
}

export interface AIProviderConfig {
  provider_id: LLMProviderId;
  model: string;
  base_url: string;
  api_key_configured: boolean;
  api_key_masked: string;
  api_key_source: 'none' | 'env' | 'settings';
  timeout_seconds: number;
  max_retries: number;
  analysis_language: AnalysisLanguage;
  max_chunk_chars: number;
  provider_models: Record<string, string>;
  provider_base_urls: Record<string, string>;
  feature_models: Record<string, FeatureModelOverride>;
}

export interface AIProviderConfigUpdate {
  provider_id?: LLMProviderId;
  model?: string;
  base_url?: string;
  api_key?: string;
  clear_api_key?: boolean;
  timeout_seconds?: number;
  max_retries?: number;
  analysis_language?: AnalysisLanguage;
  max_chunk_chars?: number;
  feature_models?: Record<string, FeatureModelOverride>;
}

export interface AIProviderInfo {
  provider_id: LLMProviderId;
  display_name: string;
  is_configured: boolean;
  api_key_masked: string;
  api_key_source: 'none' | 'env' | 'settings';
  default_model: string;
  selected_model: string;
  suggested_models: string[];
  default_base_url: string;
  saved_base_url: string;
  supports_model_discovery: boolean;
  supports_structured_output: boolean;
  context_limit_chars: number;
  cached_models_count: number;
  last_discovered_at: string | null;
  status_message: string;
}

export interface AIProviderRegistryResponse {
  config: AIProviderConfig;
  providers: AIProviderInfo[];
  feature_keys: AIFeatureKey[];
}

export interface NarrativeBeat {
  beat_id: string;
  stage: string;
  label: string;
  summary: string;
  source_paragraphs: number[];
  uncertainty_note: string;
  confidence: number;
}

export interface StoryOverview {
  title: string;
  genre: string;
  premise: string;
  synopsis: string;
  themes: string[];
  narrative_tone: string;
  story_structure: string;
  structure_uncertainty: string;
  conflict: string;
  turning_points: string[];
  climax: string;
  ending: string;
  narrative_beats: NarrativeBeat[];
}

export interface ProductionAnalysis {
  visual_opportunities: string[];
  action_moments: string[];
  emotional_beats: string[];
  dramatic_pauses: string[];
  establishing_shots: string[];
  environmental_details: string[];
  transition_ideas: string[];
  vfx_scenes: string[];
}

export interface CharacterRelationship {
  target_character_analysis_id: string | null;
  target_name: string;
  relationship_type: string;
  description: string;
}

export interface ExtractedCharacter {
  character_analysis_id: string;
  canonical_name: string;
  aliases: string[];
  ambiguous_aliases: string[];
  role: string;
  personality: string;
  appearance_description: string;
  appearance_specified: boolean;
  relationships: CharacterRelationship[];
  narrative_importance: 'main' | 'supporting' | 'minor' | 'unspecified';
  dialogue_item_ids: string[];
  emotional_states: string[];
  actions: string[];
  first_appearance_paragraph: number | null;
  last_appearance_paragraph: number | null;
  linked_character_id: string | null;
  review_status: DirectorReviewStatus;
  user_edited_fields: string[];
  confidence: number;
  notes: string;
}

export interface ExtractedScriptItem {
  item_id: string;
  item_type: ExtractedItemType;
  original_text: string;
  speaker_character_analysis_id: string | null;
  speaker_name_raw: string;
  speaker_unresolved: boolean;
  scene_breakdown_id: string | null;
  order_index: number;
  paragraph_index: number;
  language: string;
  emotion: string;
  notes: string;
}

export interface SceneBreakdownItem {
  scene_breakdown_id: string;
  scene_number: number;
  title: string;
  source_paragraphs: number[];
  source_text: string;
  location: string;
  time_of_day: string;
  environment: string;
  characters_present: string[];
  character_entrances: string[];
  character_exits: string[];
  main_action: string;
  dialogue_item_ids: string[];
  narration_item_ids: string[];
  emotional_beat: string;
  scene_purpose: string;
  conflict: string;
  visual_opportunities: string[];
  atmosphere: string;
  suggested_duration_min_s: number;
  suggested_duration_max_s: number;
  importance: SceneImportance;
  transition_suggestion: string;
  ai_confidence: number;
  unresolved_questions: string[];
  review_status: DirectorReviewStatus;
  user_edited_fields: string[];
  applied_script_scene_id: string | null;
  applied_stage_scene_id: string | null;
  original_ai_snapshot?: Record<string, unknown> | null;
}

export interface AnalysisProgress {
  project_id: string;
  status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';
  stage: string;
  current_chunk: number;
  total_chunks: number;
  progress_pct: number;
  message: string;
  context_limit_warning: string;
  error: string | null;
  started_at: string | null;
  ended_at: string | null;
}

export interface DirectorAnalysisDocument {
  analysis_id: string;
  version: number;
  script_source_mode: ScriptSourceMode;
  source_script_hash: string;
  source_paragraphs: string[];
  provider_id: string;
  model: string;
  analysis_language: AnalysisLanguage;
  status: 'idle' | 'analyzed' | 'partially_accepted' | 'accepted' | 'error';
  analyzed_at: string | null;
  updated_at: string;
  story_overview: StoryOverview;
  production_analysis: ProductionAnalysis;
  characters: ExtractedCharacter[];
  extracted_items: ExtractedScriptItem[];
  scenes: SceneBreakdownItem[];
  original_scenes_snapshot: Record<string, unknown>[];
  warnings: string[];
  context_strategy_note: string;
}

// Phase 06 Batch 2 — AI Storyboard, Shot Planning, Camera Direction & Continuity
export type ShotSize =
  | 'extreme_wide'
  | 'wide'
  | 'full'
  | 'medium_full'
  | 'medium'
  | 'medium_close_up'
  | 'close_up'
  | 'extreme_close_up'
  | 'over_the_shoulder'
  | 'pov'
  | 'insert';

export type CameraAngle =
  | 'eye_level'
  | 'low_angle'
  | 'high_angle'
  | 'birds_eye'
  | 'worms_eye'
  | 'dutch_angle'
  | 'over_the_shoulder'
  | 'pov';

export type CameraMovement =
  | 'static'
  | 'pan_left'
  | 'pan_right'
  | 'tilt_up'
  | 'tilt_down'
  | 'zoom_in'
  | 'zoom_out'
  | 'dolly_in'
  | 'dolly_out'
  | 'tracking'
  | 'camera_follow'
  | 'shake'
  | 'parallax';

export type CameraSupportStatus = 'supported' | '2d_approximation' | 'unsupported_suggestion';

export type ScreenPosition =
  | 'far_left'
  | 'left'
  | 'center_left'
  | 'center'
  | 'center_right'
  | 'right'
  | 'far_right'
  | 'offscreen';

export type DepthLayer = 'foreground' | 'midground' | 'background';

export type FacingDirection =
  | 'left'
  | 'right'
  | 'front'
  | 'back'
  | 'three_quarter_left'
  | 'three_quarter_right';

export type ShotTransition =
  | 'cut'
  | 'fade'
  | 'cross_dissolve'
  | 'match_cut'
  | 'whip_pan'
  | 'sound_bridge';

export type ContinuityCategory =
  | 'position_jump'
  | 'facing_flip'
  | 'screen_direction'
  | 'entry_exit'
  | 'location_shift'
  | 'character_disappearance'
  | 'reaction_missing_character'
  | 'dialogue_gap'
  | 'action_continuity'
  | 'prop_continuity'
  | 'missing_character_asset';

export type RegenerateStrategy = 'preserve_locked' | 'replace_all';

export interface Camera2DKeyPlan {
  start_x: number;
  start_y: number;
  start_zoom: number;
  start_rotation_deg: number;
  end_x: number;
  end_y: number;
  end_zoom: number;
  end_rotation_deg: number;
  easing: EasingType;
}

export interface ShotCharacterStaging {
  staging_id: string;
  character_analysis_id: string | null;
  library_character_id: string | null;
  character_name: string;
  is_missing_asset: boolean;
  visible: boolean;
  speaking: boolean;
  reacting: boolean;
  screen_position: ScreenPosition;
  depth_layer: DepthLayer;
  facing_direction: FacingDirection;
  action: string;
  expression: string;
  movement: string;
}

export interface ShotScriptRef {
  ref_id: string;
  item_type: 'dialogue' | 'narration' | 'internal_thought' | 'action';
  speaker_name: string;
  text_excerpt: string;
}

export interface StoryboardShot {
  shot_id: string;
  scene_id: string;
  scene_breakdown_id: string | null;
  script_scene_id: string | null;
  shot_order: number;
  title: string;
  purpose: string;
  shot_size: ShotSize;
  camera_angle: CameraAngle;
  camera_movement: CameraMovement;
  camera_support_status: CameraSupportStatus;
  camera_support_note: string;
  camera_angle_note: string;
  camera_plan: Camera2DKeyPlan;
  duration_ms: number;
  start_time_ms: number;
  end_time_ms: number;
  characters: ShotCharacterStaging[];
  dialogue_refs: ShotScriptRef[];
  narration_refs: ShotScriptRef[];
  environment: string;
  visual_focus: string;
  emotional_emphasis: string;
  props_in_shot: string[];
  transition_out: ShotTransition;
  ai_rationale: string;
  confidence: number;
  warnings: string[];
  locked: boolean;
  user_edited_fields: string[];
  original_ai_snapshot?: Record<string, unknown> | null;
}

export interface ContinuityWarning {
  warning_id: string;
  scene_id: string;
  shot_id: string;
  previous_shot_id: string | null;
  category: ContinuityCategory;
  severity: 'info' | 'warning' | 'error';
  title: string;
  description: string;
  reviewed: boolean;
  dismissed: boolean;
}

export interface StoryboardGenerationRecord {
  record_id: string;
  scope: 'storyboard' | 'scene' | 'shot';
  target_id: string;
  strategy: string;
  provider_id: string;
  model: string;
  shots_generated: number;
  preserved_locked_count: number;
  warnings_count: number;
  status: 'completed' | 'partial' | 'failed' | 'cancelled';
  message: string;
  created_at: string;
}

export interface StoryboardProgress {
  project_id: string;
  status: 'idle' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';
  stage: string;
  current_scene: number;
  total_scenes: number;
  current_scene_title: string;
  progress_pct: number;
  message: string;
  error: string | null;
  started_at: string | null;
  ended_at: string | null;
}

export interface StoryboardDocument {
  storyboard_id: string;
  version: number;
  provider_id: string;
  model: string;
  analysis_language: AnalysisLanguage;
  status: 'idle' | 'generated' | 'partial' | 'edited' | 'error';
  shots: StoryboardShot[];
  continuity_warnings: ContinuityWarning[];
  scene_hashes: Record<string, string>;
  generation_history: StoryboardGenerationRecord[];
  updated_at: string;
}

export interface ApprovedSceneSummary {
  scene_id: string;
  scene_number: number;
  title: string;
  location: string;
  time_of_day: string;
  characters_present: string[];
  target_duration_ms: number;
  total_shot_duration_ms: number;
  shot_count: number;
  locked_shot_count: number;
  is_stale: boolean;
  source_kind: 'director_accepted' | 'script_scene' | 'stage_scene';
  scene_breakdown_id: string | null;
  script_scene_id: string | null;
  stage_scene_id: string | null;
}

// Phase 06 Batch 3 — AI Production Planner & Timeline Integration
export type AssetMatchClassification =
  | 'existing_compatible'
  | 'existing_potentially_compatible'
  | 'missing'
  | 'requires_new_asset'
  | 'requires_review';

export type AssetRequirementKind =
  | 'character'
  | 'character_part'
  | 'background'
  | 'prop'
  | 'expression'
  | 'pose'
  | 'effect';

export type AnimationActionCategory =
  | 'idle'
  | 'walk'
  | 'run'
  | 'blink'
  | 'talk'
  | 'wave'
  | 'turn'
  | 'look'
  | 'jump'
  | 'fall'
  | 'attack'
  | 'react'
  | 'sit'
  | 'stand'
  | 'custom';

export type ProductionReadinessStatus =
  | 'ready'
  | 'needs_assets'
  | 'needs_character'
  | 'needs_rig'
  | 'needs_animation'
  | 'needs_camera_setup'
  | 'needs_audio'
  | 'needs_review'
  | 'unsupported';

export type ExecutionCapability = 'full' | 'partial' | 'blocked';
export type ProductionApprovalStatus = 'pending' | 'approved' | 'rejected' | 'edited';
export type AudioSuggestionType = 'sfx' | 'bgm' | 'ambient';
export type TimelineInsertionStrategy =
  | 'update_owned_only'
  | 'skip_conflicting'
  | 'append_after_existing';

export interface AssetMatchCandidate {
  asset_id: string;
  name: string;
  asset_type: string;
  score: number;
  reason: string;
}

export interface AssetMatchItem {
  requirement_id: string;
  kind: AssetRequirementKind;
  label: string;
  query: string;
  classification: AssetMatchClassification;
  matched_asset_id: string | null;
  matched_asset_name: string;
  candidates: AssetMatchCandidate[];
  required: boolean;
  notes: string;
}

export interface CharacterStagingPlan {
  staging_id: string;
  character_name: string;
  character_analysis_id: string | null;
  library_character_id: string | null;
  character_missing: boolean;
  rig_missing: boolean;
  visible: boolean;
  speaking: boolean;
  reacting: boolean;
  screen_position: ScreenPosition;
  relative_position: string;
  depth_layer: DepthLayer;
  facing_direction: FacingDirection;
  initial_pose: string;
  initial_pose_id: string | null;
  final_pose: string;
  final_pose_id: string | null;
  expression: string;
  expression_id: string | null;
  action: string;
  movement: string;
  entrance: string;
  exit: string;
  suggestion_note: string;
}

export interface AnimationActionPlan {
  action_plan_id: string;
  character_name: string;
  library_character_id: string | null;
  category: AnimationActionCategory;
  description: string;
  supported: boolean;
  mapped_animation_state: AnimationStateType | null;
  mapped_preset_id: string | null;
  required_rig: boolean;
  required_parts: string[];
  missing_parts: string[];
  parameters: Record<string, unknown>;
  estimated_duration_ms: number;
  unsupported_reason: string;
  manual_alternative: string;
}

export interface CameraProductionPlan {
  shot_size: ShotSize;
  camera_angle: CameraAngle;
  camera_movement: CameraMovement;
  support_status: CameraSupportStatus;
  support_note: string;
  angle_note: string;
  start_framing: string;
  end_framing: string;
  focus_target: string;
  duration_ms: number;
  transition_out: ShotTransition;
  camera_plan: Camera2DKeyPlan;
  executable_on_timeline: boolean;
}

export interface AudioPlanItem {
  audio_plan_id: string;
  audio_type: AudioSuggestionType;
  category: string;
  description: string;
  match_classification: AssetMatchClassification;
  matched_sound_id: string | null;
  matched_sound_name: string;
  license_verified: boolean;
  license_note: string;
  candidates: AssetMatchCandidate[];
  offset_ms: number;
  duration_ms: number | null;
  volume: number;
  fade_in_ms: number;
  fade_out_ms: number;
  loop: boolean;
  notes: string;
}

export interface VoiceSubtitlePlanItem {
  item_plan_id: string;
  item_type: 'dialogue' | 'narration' | 'internal_thought';
  script_ref_id: string;
  script_entry_id: string | null;
  speaker_name: string;
  library_character_id: string | null;
  text: string;
  voice_audio_asset_id: string | null;
  voice_sound_id: string | null;
  subtitle_segment_id: string | null;
  spans_multiple_shots: boolean;
  sync_mode: 'exact_voice' | 'estimated';
  start_offset_ms: number;
  duration_ms: number;
  notes: string;
}

export interface MissingDependency {
  dependency_id: string;
  kind: 'character' | 'rig' | 'asset' | 'animation' | 'camera' | 'audio' | 'voice' | 'review';
  severity: 'info' | 'warning' | 'blocking';
  label: string;
  reason: string;
  suggested_action: string;
}

export interface TimelineAppliedRefs {
  applied: boolean;
  applied_at: string | null;
  stage_scene_id: string | null;
  applied_start_ms: number;
  applied_end_ms: number;
  character_instance_ids: string[];
  keyframe_ids: string[];
  animation_clip_ids: string[];
  sound_event_ids: string[];
  subtitle_ids: string[];
  skipped_operations: string[];
}

export interface ProductionShotPlan {
  production_shot_id: string;
  shot_id: string;
  scene_id: string;
  shot_order: number;
  title: string;
  duration_ms: number;
  start_time_ms: number;
  end_time_ms: number;
  readiness_status: ProductionReadinessStatus;
  readiness_reasons: string[];
  execution_capability: ExecutionCapability;
  approval_status: ProductionApprovalStatus;
  locked: boolean;

  characters: CharacterStagingPlan[];
  background: AssetMatchItem | null;
  assets: AssetMatchItem[];
  initial_pose_summary: string;
  final_pose_summary: string;
  action_summary: string;
  animation_plans: AnimationActionPlan[];
  camera_plan: CameraProductionPlan;
  voice_subtitle_plans: VoiceSubtitlePlanItem[];
  sfx_plans: AudioPlanItem[];
  bgm_plans: AudioPlanItem[];
  transition_out: ShotTransition;

  warnings: string[];
  missing_dependencies: MissingDependency[];
  user_edited_fields: string[];
  timeline_refs: TimelineAppliedRefs;
  ai_notes: string;
  original_ai_snapshot?: Record<string, unknown> | null;
}

export interface ProductionProgress {
  project_id: string;
  status: 'idle' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';
  stage: string;
  current_scene: number;
  total_scenes: number;
  current_scene_title: string;
  progress_pct: number;
  message: string;
  error: string | null;
  started_at: string | null;
  ended_at: string | null;
}

export interface ProductionPlanDocument {
  plan_id: string;
  version: number;
  provider_id: string;
  model: string;
  analysis_language: AnalysisLanguage;
  status: 'idle' | 'generated' | 'partial' | 'edited' | 'applied' | 'error';
  shots: ProductionShotPlan[];
  scene_hashes: Record<string, string>;
  updated_at: string;
}

export interface ProjectState {
  meta: ProjectMeta;
  scenes: Scene[];
  timeline: MasterTimeline;
  script?: ScriptDocument;
  subtitles?: SubtitleDocument;
  director?: DirectorAnalysisDocument | null;
  storyboard?: StoryboardDocument | null;
  production_plan?: ProductionPlanDocument | null;
  production_queue?: ProductionQueueDocument | null;
  qc_report?: ProductionQCReport | null;
  /** Phase 09.1: server-maintained per-section revisions this copy is based on. */
  revisions?: Record<string, number>;
}

export interface ProjectSummary {
  project_id: string;
  name: string;
  description: string;
  width: number;
  height: number;
  fps: number;
  duration_ms: number;
  scene_count: number;
  created_at: string;
  updated_at: string;
}

export interface BackupInfo {
  backup_id: string;
  filename: string;
  created_at: string;
  size_bytes: number;
}

export type AudioType = 'sfx' | 'bgm';

export type SoundCategory =
  // 24 SFX categories
  | 'footsteps'
  | 'walking'
  | 'running'
  | 'punch'
  | 'impact'
  | 'doors'
  | 'objects'
  | 'paper'
  | 'glass'
  | 'wind'
  | 'rain'
  | 'thunder'
  | 'fire'
  | 'water'
  | 'crowd'
  | 'animals'
  | 'vehicles'
  | 'magic'
  | 'horror'
  | 'suspense'
  | 'transitions'
  | 'ui'
  | 'comedy'
  | 'cinematic'
  // BGM categories
  | 'emotional'
  | 'sad'
  | 'happy'
  | 'romantic'
  | 'action'
  | 'adventure'
  | 'ambient'
  | 'dramatic'
  | 'calm'
  | 'fantasy'
  // Legacy backward-compatible SFX categories
  | 'movement'
  | 'environment'
  | 'atmosphere'
  | 'notification';

export type LicenseSource = 'user_imported' | 'cc0' | 'cc_by' | 'royalty_free' | 'custom';
export type LicenseUsage = 'verified' | 'unverified';

export interface SoundLicense {
  source: LicenseSource;
  usage: LicenseUsage;
  attribution: string;
  notes: string;
  origin_source?: string;
}

export interface SoundAsset {
  sound_id: string;
  name: string;
  audio_type?: AudioType;
  category: SoundCategory;
  tags: string[];
  file_path: string;
  sha256: string;
  duration_ms: number;
  sample_rate: number;
  channels: number;
  codec: string;
  default_volume: number;
  loopable: boolean;
  fade_in_ms: number;
  fade_out_ms: number;
  is_favorite: boolean;
  is_bundled?: boolean;
  waveform_peaks: number[];
  license: SoundLicense;
  created_at: string;
}

export interface SoundCategoryMeta {
  id: SoundCategory;
  audio_type?: AudioType;
  label: string;
  description: string;
}

export interface AudioStarterManifest {
  pack_name: string;
  version: string;
  generated_at?: string;
  license: string;
  license_notice: string;
  sfx_count?: number;
  bgm_count?: number;
  assets: Array<{
    asset_id: string;
    name: string;
    type: AudioType;
    category: SoundCategory;
    tags: string[];
    duration_ms: number;
    format: string;
    license: string;
    source: string;
    file_path: string;
    import_date: string;
    favorite: boolean;
  }>;
}

export type JobStatus =
  | 'pending'
  | 'queued'
  | 'preparing'
  | 'rendering'
  | 'encoding'
  | 'validating'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export const ACTIVE_JOB_STATUSES: JobStatus[] = ['preparing', 'rendering', 'encoding', 'validating', 'running'];
export const WAITING_JOB_STATUSES: JobStatus[] = ['pending', 'queued'];

export interface ExportPreset {
  preset_id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  video_codec: 'auto' | 'h264_videotoolbox' | 'h264_nvenc' | 'h264_qsv' | 'libx264';
  video_bitrate_kbps: number;
  audio_codec: 'aac';
  audio_bitrate_kbps: number;
  sample_rate: number;
  is_builtin: boolean;
}

export interface RenderChunk {
  chunk_id: string;
  job_id: string;
  chunk_index: number;
  start_frame: number;
  end_frame: number;
  output_path: string;
  status: JobStatus;
  retry_count: number;
  error_message: string | null;
}

export interface RenderJob {
  job_id: string;
  project_id: string;
  job_type: 'export_mp4' | 'import_audio';
  status: JobStatus;
  progress_pct: number;
  message: string;
  input_json: Record<string, unknown>;
  output_json: Record<string, unknown> | null;
  error_log: string | null;
  retry_count: number;
  depends_on_job_id: string | null;
  chunks: RenderChunk[];
  name?: string;
  queue_position?: number;
  progress?: RenderJobProgress;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
}

export interface RenderJobProgress {
  stage?: string;
  frames_done?: number;
  total_frames?: number;
  chunk_count?: number;
  chunk_index?: number;
  render_fps?: number | null;
  eta_seconds?: number | null;
  active_seconds?: number;
  mux_fraction?: number;
  interrupted?: boolean;
}

// ---- Phase 08 Batch 3: Export configuration, validation & FFmpeg environment ----
export type ExportScopeKind = 'project' | 'scene' | 'scenes' | 'shot' | 'shots' | 'range';
export type ResolutionPresetId =
  | 'project'
  | 'hd'
  | 'fhd'
  | 'qhd'
  | 'uhd'
  | 'portrait_hd'
  | 'portrait_fhd'
  | 'custom';
export type ContainerFormat = 'mp4' | 'mov' | 'webm';
export type VideoCodecId = 'h264' | 'hevc' | 'vp9' | 'prores';
export type QualityPresetId = 'draft' | 'standard' | 'high' | 'maximum';
export type CollisionPolicy = 'auto_number' | 'overwrite' | 'fail';

export interface ExportScope {
  kind: ExportScopeKind;
  scene_ids: string[];
  shots: { scene_id: string; shot_id: string }[];
  range_start_ms: number | null;
  range_end_ms: number | null;
}

export interface AdvancedVideoSettings {
  crf: number | null;
  bitrate_kbps: number | null;
  encoder_preset: string | null;
  profile: string | null;
  pix_fmt: string | null;
  keyframe_interval: number | null;
}

export interface ExportSettings {
  scope: ExportScope;
  resolution_preset: ResolutionPresetId;
  width: number;
  height: number;
  aspect_mode: 'fit' | 'fill' | 'stretch';
  fps: number;
  container: ContainerFormat;
  video_codec: VideoCodecId;
  encoder: 'auto' | 'software' | 'hardware';
  quality: QualityPresetId;
  advanced: AdvancedVideoSettings;
  audio: {
    enabled: boolean;
    bitrate_kbps: number;
    sample_rate: 44100 | 48000;
    normalize_loudness: boolean;
    target_lufs: number;
  };
  subtitles: { mode: SubtitleExportMode; export_srt: boolean };
  output_dir: string | null;
  filename: string | null;
  collision_policy: CollisionPolicy;
  render_mode: 'auto' | 'pixi_stream' | 'software_compositor';
  chunk_duration_seconds: number;
  job_name: string | null;
}

export interface ExportPlanIssue {
  code: string;
  severity: 'error' | 'warning' | 'info';
  field: string | null;
  message: string;
}

export interface ExportSegmentInfo {
  label: string;
  source_start_ms: number;
  duration_ms: number;
  frame_count: number;
  output_start_frame: number;
  scene_id: string | null;
  shot_id: string | null;
}

export interface ExportPlan {
  valid: boolean;
  issues: ExportPlanIssue[];
  settings: ExportSettings;
  segments: ExportSegmentInfo[];
  total_frames: number;
  duration_ms: number;
  output_path: string | null;
  output_path_collision: boolean;
  encoder: { encoder: string; is_hardware: boolean; description: string; audio_codec: string } | null;
  renderer: string | null;
  audio_expected: boolean;
  subtitle_cue_count: number;
}

export interface CodecCapability {
  codec: VideoCodecId;
  label: string;
  containers: ContainerFormat[];
  software_encoder: string | null;
  hardware_encoders: string[];
  available: boolean;
}

export interface FFmpegEnvironment {
  available: boolean;
  ffmpeg_path: string | null;
  ffprobe_path: string | null;
  ffmpeg_version: string | null;
  ffprobe_version: string | null;
  configured_ffmpeg_path: string | null;
  configured_ffprobe_path: string | null;
  encoders: string[];
  codecs: CodecCapability[];
  containers: ContainerFormat[];
  audio_encoders: string[];
  hwaccels: string[];
  problems: string[];
}

export interface FFmpegTestResult {
  ok: boolean;
  ffmpeg_ok: boolean;
  ffprobe_ok: boolean;
  encoder_results: Record<string, boolean>;
  messages: string[];
}

export interface RenderQueueState {
  running: boolean;
  active_job_id: string | null;
  active_project_id: string | null;
  queued_count: number;
}

export interface QCIssue {
  code: string;
  severity: 'critical' | 'warning' | 'info';
  category: string;
  message: string;
  scene_id?: string | null;
  time_ms?: number | null;
  ref_id?: string | null;
}

export interface QCReport {
  project_id: string;
  passed: boolean;
  critical_count: number;
  warning_count: number;
  issues: QCIssue[];
  audio_peak_db?: number | null;
}

export interface HealthResponse {
  status: string;
  app_version: string;
  python_version: string;
  os: string;
  arch: string;
  workspace_dir: string;
  ffmpeg: {
    available: boolean;
    ffmpeg_path: string | null;
    ffprobe_path: string | null;
    version: string | null;
    available_h264_encoders: string[];
    recommended_h264_encoder: string;
  };
  pixi_render_worker_connected: boolean;
  sound_categories: SoundCategory[];
}

// Phase 07 Batch 1 — Scene Execution Engine, Validation & Assembly Preview
export type ExecutionValidationStatus =
  | 'ready'
  | 'warning'
  | 'missing_dependency'
  | 'unsupported'
  | 'invalid'
  | 'needs_review';

export type ExistingExecutionPolicy =
  | 'update_existing'
  | 'reuse_existing'
  | 'skip_existing';

export interface ValidationIssue {
  issue_id: string;
  code: string;
  severity: 'error' | 'warning' | 'info';
  category:
    | 'scene_ref'
    | 'shot_ref'
    | 'character'
    | 'rig'
    | 'asset'
    | 'background'
    | 'animation'
    | 'camera'
    | 'duration'
    | 'dimensions'
    | 'staging'
    | 'existing_state';
  label: string;
  message: string;
  suggested_action: string;
  production_shot_id: string | null;
  requirement_id: string | null;
  staging_id: string | null;
  repairable: boolean;
}

export interface ShotValidationResult {
  production_shot_id: string;
  shot_id: string;
  scene_id: string;
  shot_order: number;
  title: string;
  status: ExecutionValidationStatus;
  executable: boolean;
  already_executed: boolean;
  existing_shot_id: string | null;
  issues: ValidationIssue[];
  missing_dependencies: ValidationIssue[];
  unsupported_actions: string[];
  warnings: string[];
}

export interface SceneValidationReport {
  project_id: string;
  plan_id: string | null;
  overall_status: ExecutionValidationStatus;
  stage_width: number;
  stage_height: number;
  fps: number;
  total_shots: number;
  ready_count: number;
  warning_count: number;
  missing_dependency_count: number;
  unsupported_count: number;
  invalid_count: number;
  needs_review_count: number;
  already_executed_count: number;
  project_issues: ValidationIssue[];
  shots: ShotValidationResult[];
  checked_at: string;
}

export interface StagedCharacterPlacement {
  staging_id: string;
  stable_instance_id: string;
  character_name: string;
  library_character_id: string | null;
  resolved: boolean;
  screen_position: string;
  depth_layer: string;
  facing_direction: string;
  normalized_x: number;
  normalized_y: number;
  transform: Transform2D;
  z_index: number;
  visible: boolean;
  pose_id: string | null;
  pose_name: string;
  expression_id: string | null;
  expression_name: string;
  fallback_used: boolean;
  fallback_reason: string;
}

export interface StagedObjectPlacement {
  requirement_id: string;
  stable_prop_instance_id: string;
  name: string;
  role: 'background' | 'environment' | 'prop' | 'foreground';
  asset_id: string | null;
  asset_name: string;
  resolved: boolean;
  transform: Transform2D;
  z_index: number;
  visible: boolean;
  notes: string;
}

export interface LayerPreviewEntry {
  layer_id: string;
  name: string;
  kind: 'background' | 'character' | 'prop' | 'environment' | 'foreground';
  z_index: number;
  resolved: boolean;
}

export interface ShotAssemblyPreview {
  production_shot_id: string;
  stable_shot_id: string;
  scene_id: string;
  target_stage_scene_id: string;
  shot_order: number;
  title: string;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  validation_status: ExecutionValidationStatus;
  executable: boolean;
  already_executed: boolean;
  background: StagedObjectPlacement | null;
  characters: StagedCharacterPlacement[];
  objects: StagedObjectPlacement[];
  layer_order: LayerPreviewEntry[];
  camera_default: CameraState;
  camera_executable: boolean;
  missing_dependencies: ValidationIssue[];
  unsupported_actions: string[];
  warnings: string[];
  staging_fallbacks: string[];
  expected_timeline_changes: string[];
}

export interface SceneAssemblyPreviewGroup {
  source_scene_id: string;
  target_stage_scene_id: string;
  scene_name: string;
  will_create_scene: boolean;
  already_executed: boolean;
  start_ms: number;
  total_duration_ms: number;
  existing_user_object_count: number;
  shots: ShotAssemblyPreview[];
}

export interface SceneExecutionPreview {
  project_id: string;
  plan_id: string | null;
  validation: SceneValidationReport;
  scenes: SceneAssemblyPreviewGroup[];
  total_shots_eligible: number;
  total_shots_blocked: number;
  has_existing_execution: boolean;
  recommended_policy: ExistingExecutionPolicy;
  expected_timeline_summary: string[];
}

export interface ShotExecutionOutcome {
  production_shot_id: string;
  stable_shot_id: string;
  target_stage_scene_id: string;
  shot_order: number;
  title: string;
  outcome: 'assembled' | 'updated' | 'reused' | 'skipped' | 'blocked' | 'failed';
  reason: string;
  characters_assembled: number;
  objects_assembled: number;
  warnings: string[];
  staging_fallbacks: string[];
}

export interface SceneExecutionResult {
  project_id: string;
  status: 'completed' | 'partial' | 'no_changes' | 'rolled_back';
  scenes_created: number;
  scenes_updated: number;
  shots_assembled: number;
  shots_updated: number;
  shots_reused: number;
  shots_skipped: number;
  shots_blocked: number;
  characters_created: number;
  characters_reused: number;
  props_created: number;
  props_reused: number;
  keyframes_synced: number;
  warnings: string[];
  outcomes: ShotExecutionOutcome[];
  updated_project?: ProjectState | null;
  executed_at: string;
}

export interface RepairAssetRequest {
  production_shot_id: string;
  target_kind: 'background' | 'prop' | 'character';
  requirement_id?: string | null;
  staging_id?: string | null;
  asset_id?: string | null;
  character_id?: string | null;
}

// Phase 07 Batch 2 — Animation Capabilities, Motion Library, Motion Preview & Camera Motion
export type RigCapability =
  | 'root_movement'
  | 'body_rotation'
  | 'head_rotation'
  | 'arm_rotation'
  | 'leg_rotation'
  | 'hand_rotation'
  | 'eye_state'
  | 'mouth_state'
  | 'scale_animation'
  | 'opacity_animation';

export type RigType = 'full_cutout' | 'upper_body' | 'simple_cutout' | 'empty';

export type MotionDirection =
  | 'left'
  | 'right'
  | 'up'
  | 'down'
  | 'forward'
  | 'backward'
  | 'in_place';

export type MotionSupportLevel = 'full' | 'partial' | 'unsupported';

export interface CharacterRigCapabilities {
  character_id: string;
  character_name: string;
  rig_type: RigType;
  part_count: number;
  capabilities: RigCapability[];
  available_part_roles: string[];
  part_slots_by_role: Record<string, string>;
  eye_variants: string[];
  mouth_variants: string[];
  pose_ids: string[];
  pose_names: Record<string, string>;
  expression_ids: string[];
  limitations: string[];
}

export interface MotionParameters {
  duration_ms: number;
  speed: number;
  intensity: number;
  distance_px: number;
  direction: MotionDirection;
  start_pose_id: string | null;
  end_pose_id: string | null;
  easing: EasingType;
  loop: boolean;
  delay_ms: number;
}

export interface CameraMotionParameters {
  movement: CameraMovement;
  start_x: number;
  start_y: number;
  start_zoom: number;
  start_rotation_deg: number;
  end_x: number;
  end_y: number;
  end_zoom: number;
  end_rotation_deg: number;
  duration_ms: number;
  easing: EasingType;
  shake_intensity_px: number;
  shake_frequency_hz: number;
  follow_instance_id: string | null;
  follow_strength: number;
  focus_target_id: string | null;
  delay_ms: number;
}

export interface MotionPreset {
  preset_id: string;
  name: string;
  category: AnimationActionCategory;
  description: string;
  is_builtin: boolean;
  required_capabilities: RigCapability[];
  optional_capabilities: RigCapability[];
  supported_rig_types: RigType[];
  motion_targets: string[];
  supported_easings: EasingType[];
  min_duration_ms: number;
  max_duration_ms: number;
  default_parameters: MotionParameters;
  limitations: string[];
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface MotionCompatibilityResult {
  preset_id: string;
  preset_name: string;
  character_id: string;
  character_name: string;
  compatible: boolean;
  support_level: MotionSupportLevel;
  missing_capabilities: RigCapability[];
  available_optional_capabilities: RigCapability[];
  warnings: string[];
  limitations: string[];
}

export interface GeneratedMotionRecord {
  motion_id: string;
  source_action_plan_id: string | null;
  preset_id: string;
  preset_name: string;
  category: string;
  target_kind: 'character' | 'camera';
  instance_id: string | null;
  character_id: string | null;
  parameters: MotionParameters;
  camera_parameters: CameraMotionParameters | null;
  start_ms: number;
  end_ms: number;
  keyframe_ids: string[];
  clip_ids: string[];
  support_level: MotionSupportLevel;
  warnings: string[];
  user_modified: boolean;
  applied_at: string;
}

export interface MotionPreviewResponse {
  compatible: boolean;
  support_level: MotionSupportLevel;
  compatibility: MotionCompatibilityResult | null;
  start_ms: number;
  end_ms: number;
  keyframes: Keyframe[];
  animation_clips: CharacterAnimationClip[];
  warnings: string[];
  errors: string[];
  sync_summary: string;
}

export interface MotionApplyResponse {
  applied: boolean;
  support_level: MotionSupportLevel;
  motion_record: GeneratedMotionRecord | null;
  camera_motion_record: GeneratedMotionRecord | null;
  keyframes_written: number;
  clips_written: number;
  warnings: string[];
  errors: string[];
  updated_project?: ProjectState | null;
}

export interface ActionMappingReport {
  action_plan_id: string;
  character_name: string;
  instance_id: string | null;
  character_id: string | null;
  category: AnimationActionCategory;
  description: string;
  mapped_preset_id: string | null;
  mapped_preset_name: string;
  support_level: MotionSupportLevel;
  executable: boolean;
  skipped_user_modified: boolean;
  missing_capabilities: RigCapability[];
  keyframes_count: number;
  warnings: string[];
  unsupported_reason: string;
  manual_alternative: string;
}

export interface CameraExecutionReport {
  movement: CameraMovement;
  support_level: MotionSupportLevel;
  executable: boolean;
  synchronized_with_instance_id: string | null;
  skipped_user_modified: boolean;
  keyframes_count: number;
  warnings: string[];
  unsupported_reason: string;
}

export interface ShotAnimationExecutionOutcome {
  shot_id: string;
  scene_id: string;
  production_shot_id: string | null;
  shot_order: number;
  title: string;
  start_ms: number;
  end_ms: number;
  status: 'executed' | 'partial' | 'skipped' | 'blocked' | 'preview';
  actions: ActionMappingReport[];
  camera: CameraExecutionReport | null;
  keyframes_generated: number;
  clips_generated: number;
  sync_notes: string[];
  warnings: string[];
}

export interface ShotAnimationExecuteResponse {
  project_id: string;
  dry_run: boolean;
  status: 'completed' | 'partial' | 'no_changes' | 'rolled_back';
  shots_processed: number;
  actions_executed: number;
  actions_unsupported: number;
  actions_skipped_user_edited: number;
  cameras_executed: number;
  cameras_unsupported: number;
  total_keyframes_written: number;
  total_clips_written: number;
  outcomes: ShotAnimationExecutionOutcome[];
  warnings: string[];
  errors: string[];
  updated_project?: ProjectState | null;
}

// Phase 07 Batch 3 — Automated Production Queue & 8-Category QC Types

export type ProductionTaskStatus =
  | 'pending'
  | 'queued'
  | 'validating'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'needs_review'
  | 'skipped'
  | 'cancelled';

export type ProductionExecutionMode =
  | 'single_shot'
  | 'selected_shots'
  | 'scene'
  | 'project'
  | 'production_plan';

export type ProductionTaskType =
  | 'asset_resolution'
  | 'character_validation'
  | 'scene_assembly'
  | 'shot_animation'
  | 'camera_setup'
  | 'audio_subtitle_sync'
  | 'qc_validation';

export type QueueRunStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled';

export interface ProductionQueueTask {
  task_id: string;
  run_id: string;
  task_name: string;
  task_type: ProductionTaskType;
  scene_id: string | null;
  stage_scene_id: string | null;
  scene_number: number;
  scene_title: string;
  shot_id: string | null;
  production_shot_id: string | null;
  shot_number: number;
  shot_title: string;
  status: ProductionTaskStatus;
  progress_pct: number;
  depends_on_task_ids: string[];
  blocked_by_task_ids: string[];
  message: string;
  error_details: string | null;
  warnings: string[];
  retry_count: number;
  result_summary: Record<string, unknown>;
  timeline_time_ms: number | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface ProductionQueueDocument {
  run_id: string | null;
  mode: ProductionExecutionMode;
  status: QueueRunStatus;
  selected_scene_ids: string[];
  selected_shot_ids: string[];
  include_unapproved: boolean;
  tasks: ProductionQueueTask[];
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

export interface ProductionQueueStartRequest {
  mode: ProductionExecutionMode;
  scene_ids?: string[];
  production_shot_ids?: string[];
  include_unapproved?: boolean;
  include_animation?: boolean;
  include_camera?: boolean;
  include_audio_subtitles?: boolean;
  run_qc_after?: boolean;
  preserve_user_modified?: boolean;
}

export interface ProductionQueuePlanPreview {
  project_id: string;
  mode: ProductionExecutionMode;
  total_scenes: number;
  total_shots: number;
  total_tasks: number;
  tasks: ProductionQueueTask[];
  warnings: string[];
  blocking_errors: string[];
  can_start: boolean;
}

export type ProductionQCCategory =
  | 'asset'
  | 'scene'
  | 'canvas'
  | 'animation'
  | 'camera'
  | 'audio'
  | 'subtitle'
  | 'production';

export type ProductionQCSeverity = 'error' | 'warning' | 'info';

export type QCNavTarget =
  | 'stage'
  | 'timeline'
  | 'storyboard'
  | 'production'
  | 'subtitles'
  | 'assets'
  | 'characters'
  | 'audio'
  | 'queue';

export interface ProductionQCIssue {
  issue_id: string;
  code: string;
  category: ProductionQCCategory;
  severity: ProductionQCSeverity;
  title: string;
  description: string;
  scene_id: string | null;
  scene_number: number | null;
  shot_id: string | null;
  shot_number: number | null;
  asset_id: string | null;
  subtitle_id: string | null;
  sound_event_id: string | null;
  task_id: string | null;
  time_ms: number | null;
  root_cause: string;
  recommended_action: string;
  nav_target: QCNavTarget;
  fix_action: string | null;
}

export interface ProductionQCReport {
  project_id: string;
  scope: 'project' | 'scenes';
  scene_ids: string[];
  error_count: number;
  warning_count: number;
  info_count: number;
  passed_checks: number;
  total_checks: number;
  readiness_score: number;
  production_ready: boolean;
  category_summary: Record<string, { error: number; warning: number; info: number }>;
  issues: ProductionQCIssue[];
  checked_at: string;
}

export interface SelectionState {
  type: 'none' | 'character' | 'prop' | 'camera' | 'scene' | 'shot' | 'sfx_event' | 'subtitle' | 'asset';
  id: string | null;
  subSlotId?: string | null;
  multiIds?: string[];
}

declare global {
  interface Window {
    electronAPI?: {
      getBackendConfig: () => Promise<{ baseUrl: string; wsUrl: string; token: string; port: number }>;
      selectExportDirectory: () => Promise<string | null>;
      revealInFolder: (filePath: string) => Promise<void>;
      openPath?: (filePath: string) => Promise<string>;
      setRenderActive: (active: boolean) => Promise<void>;
      platform: string;
    };
  }
}
