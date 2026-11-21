import type {
  ProjectIntegrityReport,
  ProjectStorageInfo,
  ExportPlan,
  ExportSettings,
  FFmpegEnvironment,
  FFmpegTestResult,
  RenderQueueState,
  AIFeatureKey,
  AIModelDiscoveryResult,
  AIProviderConfig,
  AIProviderConfigUpdate,
  AIProviderRegistryResponse,
  F5TTSConfig,
  F5TTSReferenceVoice,
  F5TTSStatus,
  F5TTSTestConnectionResult,
  FeatureModelOverride,
  LLMProviderId,
  ModelCompatibilityResult,
  AnalysisLanguage,
  AnalysisProgress,
  AnimationActionCategory,
  ApprovedSceneSummary,
  Asset,
  AssetType,
  AudioStarterManifest,
  AudioType,
  BackupInfo,
  CameraMotionParameters,
  Character,
  CharacterRigCapabilities,
  ContinuityWarning,
  DirectorAnalysisDocument,
  ExistingExecutionPolicy,
  ExportPreset,
  HealthResponse,
  LicenseSource,
  LicenseUsage,
  MotionApplyResponse,
  MotionCompatibilityResult,
  MotionParameters,
  MotionPreset,
  MotionPreviewResponse,
  PartRole,
  ProductionPlanDocument,
  ProductionProgress,
  ProductionQCReport,
  ProductionQueueDocument,
  ProductionQueuePlanPreview,
  ProductionQueueStartRequest,
  ProductionShotPlan,
  ProjectState,
  ProjectSummary,
  QCReport,
  RegenerateStrategy,
  RenderJob,
  RepairAssetRequest,
  RigCapability,
  SceneBreakdownItem,
  SceneExecutionPreview,
  SceneExecutionResult,
  SceneShot,
  SceneValidationReport,
  ScriptSourceMode,
  ShotAnimationExecuteResponse,
  SoundAsset,
  SoundCategory,
  SoundCategoryMeta,
  SoundEffectEvent,
  SrtImportResponse,
  StoryboardDocument,
  StoryboardProgress,
  StoryboardShot,
  SubtitleExportMode,
  SubtitleSegment,
  SubtitleStyle,
  VoiceAudioAsset,
  VoiceGenerateRequest,
  VoiceProfile,
  VoiceProfileUpsertRequest,
  VoiceProviderInfo,
} from '@/types/models';

export interface BackendConnection {
  baseUrl: string;
  wsUrl: string;
  token: string;
}

class ApiClient {
  private conn: BackendConnection = {
    baseUrl: 'http://127.0.0.1:8765',
    wsUrl: 'ws://127.0.0.1:8765',
    token: '',
  };
  private initialized = false;

  async init(): Promise<BackendConnection> {
    if (this.initialized) return this.conn;
    if (window.electronAPI) {
      const cfg = await window.electronAPI.getBackendConfig();
      this.conn = {
        baseUrl: cfg.baseUrl,
        wsUrl: cfg.wsUrl,
        token: cfg.token,
      };
    }
    this.initialized = true;
    return this.conn;
  }

  getConnection(): BackendConnection {
    return this.conn;
  }

  getAssetFileUrl(assetId: string): string {
    const q = this.conn.token ? `?token=${encodeURIComponent(this.conn.token)}` : '';
    return `${this.conn.baseUrl}/api/v1/assets/${encodeURIComponent(assetId)}/file${q}`;
  }

  getSoundFileUrl(soundId: string): string {
    const q = this.conn.token ? `?token=${encodeURIComponent(this.conn.token)}` : '';
    return `${this.conn.baseUrl}/api/v1/sounds/${encodeURIComponent(soundId)}/file${q}`;
  }

  getVoiceAudioFileUrl(projectId: string, audioAssetId: string): string {
    const q = this.conn.token ? `?token=${encodeURIComponent(this.conn.token)}` : '';
    return `${this.conn.baseUrl}/api/v1/voice/audio/${encodeURIComponent(projectId)}/${encodeURIComponent(audioAssetId)}/file${q}`;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    await this.init();
    const headers = new Headers(init.headers);
    if (this.conn.token) {
      headers.set('X-AMCS-Token', this.conn.token);
    }
    if (!(init.body instanceof FormData) && init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    const res = await fetch(`${this.conn.baseUrl}${path}`, {
      ...init,
      headers,
    });

    if (!res.ok) {
      let detail: unknown = `${res.status} ${res.statusText}`;
      try {
        const body = await res.json();
        detail = body.detail ?? body;
      } catch {
        // Ignore JSON parse failure
      }
      const err = new Error(
        typeof detail === 'string'
          ? detail
          : (detail as { message?: string })?.message || JSON.stringify(detail),
      ) as Error & { status?: number; payload?: unknown };
      err.status = res.status;
      err.payload = detail;
      throw err;
    }

    if (res.status === 204) {
      return undefined as T;
    }
    return (await res.json()) as T;
  }

  // Health
  getHealth(): Promise<HealthResponse> {
    return this.request<HealthResponse>('/api/v1/health');
  }

  // Projects
  listProjects(): Promise<ProjectSummary[]> {
    return this.request<ProjectSummary[]>('/api/v1/projects');
  }

  createProject(payload: {
    name: string;
    description?: string;
    width?: number;
    height?: number;
    fps?: number;
    duration_ms?: number;
  }): Promise<ProjectState> {
    return this.request<ProjectState>('/api/v1/projects', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  getProject(projectId: string): Promise<ProjectState> {
    return this.request<ProjectState>(`/api/v1/projects/${encodeURIComponent(projectId)}`);
  }

  /** Phase 09.1 section-aware save: only `dirty` sections are written; returns detected conflicts. */
  async saveProjectSections(
    state: ProjectState,
    dirty: string[],
    backup = false,
  ): Promise<{ state: ProjectState; conflicts: string[] }> {
    await this.init();
    const params = new URLSearchParams({ dirty: dirty.join(',') });
    if (backup) params.set('backup', 'true');
    const res = await fetch(
      `${this.conn.baseUrl}/api/v1/projects/${encodeURIComponent(state.meta.project_id)}?${params.toString()}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(this.conn.token ? { 'X-AMCS-Token': this.conn.token } : {}),
        },
        body: JSON.stringify(state),
      },
    );
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try {
        const body = await res.json();
        msg = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail ?? body);
      } catch {
        // keep status text
      }
      throw new Error(msg);
    }
    const conflicts = (res.headers.get('X-AMCS-Conflicts') ?? '').split(',').filter(Boolean);
    return { state: (await res.json()) as ProjectState, conflicts };
  }

  saveProject(state: ProjectState, backup = false): Promise<ProjectState> {
    const q = backup ? '?backup=true' : '';
    return this.request<ProjectState>(
      `/api/v1/projects/${encodeURIComponent(state.meta.project_id)}${q}`,
      {
        method: 'PUT',
        body: JSON.stringify(state),
      },
    );
  }

  deleteProject(projectId: string): Promise<void> {
    return this.request<void>(`/api/v1/projects/${encodeURIComponent(projectId)}`, {
      method: 'DELETE',
    });
  }

  listBackups(projectId: string): Promise<BackupInfo[]> {
    return this.request<BackupInfo[]>(`/api/v1/projects/${encodeURIComponent(projectId)}/backups`);
  }

  createBackup(projectId: string, tag: 'manual' | 'pre_recovery' = 'manual'): Promise<BackupInfo> {
    return this.request<BackupInfo>(`/api/v1/projects/${encodeURIComponent(projectId)}/backups?tag=${tag}`, {
      method: 'POST',
    });
  }

  /** Save As / save recovered work as a new project (the source is never modified). */
  duplicateProject(projectId: string, name: string, state?: ProjectState): Promise<ProjectState> {
    return this.request<ProjectState>(`/api/v1/projects/${encodeURIComponent(projectId)}/duplicate`, {
      method: 'POST',
      body: JSON.stringify({ name, state: state ?? null }),
    });
  }

  getProjectIntegrity(projectId: string): Promise<ProjectIntegrityReport> {
    return this.request<ProjectIntegrityReport>(`/api/v1/projects/${encodeURIComponent(projectId)}/integrity`);
  }

  relinkAsset(projectId: string, fromAssetId: string, toAssetId: string): Promise<ProjectState> {
    return this.request<ProjectState>(`/api/v1/projects/${encodeURIComponent(projectId)}/relink-asset`, {
      method: 'POST',
      body: JSON.stringify({ from_asset_id: fromAssetId, to_asset_id: toAssetId }),
    });
  }

  getProjectStorage(projectId: string): Promise<ProjectStorageInfo> {
    return this.request<ProjectStorageInfo>(`/api/v1/projects/${encodeURIComponent(projectId)}/storage`);
  }

  cleanupProjectStorage(projectId: string): Promise<{ removed_render_dirs: string[]; removed_partial_backups: number; freed_bytes: number }> {
    return this.request(`/api/v1/projects/${encodeURIComponent(projectId)}/storage/cleanup`, { method: 'POST' });
  }

  restoreBackup(projectId: string, filename: string): Promise<ProjectState> {
    return this.request<ProjectState>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/backups/${encodeURIComponent(filename)}/restore`,
      { method: 'POST' },
    );
  }

  // Assets
  listAssets(params?: { type?: string; folder?: string; search?: string }): Promise<Asset[]> {
    const q = new URLSearchParams();
    if (params?.type) q.set('type', params.type);
    if (params?.folder) q.set('folder', params.folder);
    if (params?.search) q.set('search', params.search);
    const qs = q.toString() ? `?${q.toString()}` : '';
    return this.request<Asset[]>(`/api/v1/assets${qs}`);
  }

  importAsset(payload: {
    file: File;
    name?: string;
    type: AssetType;
    part_role?: PartRole | null;
    folder?: string;
    tags?: string[];
    anchor_x?: number;
    anchor_y?: number;
    identity_verified?: boolean;
  }): Promise<Asset> {
    const fd = new FormData();
    fd.append('file', payload.file);
    if (payload.name) fd.append('name', payload.name);
    fd.append('type', payload.type);
    if (payload.part_role) fd.append('part_role', payload.part_role);
    fd.append('folder', payload.folder || 'general');
    fd.append('tags', (payload.tags ?? []).join(','));
    fd.append('anchor_x', String(payload.anchor_x ?? 0.5));
    fd.append('anchor_y', String(payload.anchor_y ?? 0.5));
    fd.append('identity_verified', String(payload.identity_verified ?? true));
    return this.request<Asset>('/api/v1/assets/import', {
      method: 'POST',
      body: fd,
    });
  }

  updateAsset(assetId: string, patch: Partial<Asset>): Promise<Asset> {
    return this.request<Asset>(`/api/v1/assets/${encodeURIComponent(assetId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  }

  deleteAsset(assetId: string, force = false): Promise<void> {
    return this.request<void>(`/api/v1/assets/${encodeURIComponent(assetId)}${force ? '?force=true' : ''}`, {
      method: 'DELETE',
    });
  }

  // Characters
  listCharacters(search?: string): Promise<Character[]> {
    const qs = search ? `?search=${encodeURIComponent(search)}` : '';
    return this.request<Character[]>(`/api/v1/characters${qs}`);
  }

  createCharacter(payload: Partial<Character> & { name: string }): Promise<Character> {
    return this.request<Character>('/api/v1/characters', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  updateCharacter(characterId: string, payload: Partial<Character>): Promise<Character> {
    return this.request<Character>(`/api/v1/characters/${encodeURIComponent(characterId)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  }

  deleteCharacter(characterId: string, force = false): Promise<void> {
    return this.request<void>(`/api/v1/characters/${encodeURIComponent(characterId)}${force ? '?force=true' : ''}`, {
      method: 'DELETE',
    });
  }

  // Sounds (Separated SFX & BGM)
  listSoundCategories(audioType?: AudioType): Promise<SoundCategoryMeta[]> {
    const qs = audioType ? `?audio_type=${encodeURIComponent(audioType)}` : '';
    return this.request<SoundCategoryMeta[]>(`/api/v1/sounds/categories${qs}`);
  }

  getSoundManifest(): Promise<AudioStarterManifest> {
    return this.request<AudioStarterManifest>('/api/v1/sounds/manifest');
  }

  listSounds(params?: {
    audio_type?: AudioType;
    category?: string;
    search?: string;
    tag?: string;
    favorites_only?: boolean;
  }): Promise<SoundAsset[]> {
    const q = new URLSearchParams();
    if (params?.audio_type) q.set('audio_type', params.audio_type);
    if (params?.category) q.set('category', params.category);
    if (params?.search) q.set('search', params.search);
    if (params?.tag) q.set('tag', params.tag);
    if (params?.favorites_only) q.set('favorites_only', 'true');
    const qs = q.toString() ? `?${q.toString()}` : '';
    return this.request<SoundAsset[]>(`/api/v1/sounds${qs}`);
  }

  importSound(payload: {
    file: File;
    name?: string;
    audio_type?: AudioType;
    category: SoundCategory;
    tags?: string[];
    default_volume?: number;
    loopable?: boolean;
    fade_in_ms?: number;
    fade_out_ms?: number;
    license_source: LicenseSource;
    license_usage: LicenseUsage;
    license_attribution?: string;
    license_notes?: string;
    license_origin_source?: string;
  }): Promise<SoundAsset> {
    const fd = new FormData();
    fd.append('file', payload.file);
    if (payload.name) fd.append('name', payload.name);
    fd.append('audio_type', payload.audio_type ?? 'sfx');
    fd.append('category', payload.category);
    fd.append('tags', (payload.tags ?? []).join(','));
    fd.append('default_volume', String(payload.default_volume ?? (payload.audio_type === 'bgm' ? 0.55 : 0.8)));
    fd.append('loopable', String(payload.loopable ?? (payload.audio_type === 'bgm')));
    fd.append('fade_in_ms', String(payload.fade_in_ms ?? 0));
    fd.append('fade_out_ms', String(payload.fade_out_ms ?? 0));
    fd.append('license_source', payload.license_source);
    fd.append('license_usage', payload.license_usage);
    fd.append('license_attribution', payload.license_attribution ?? '');
    fd.append('license_notes', payload.license_notes ?? '');
    fd.append('license_origin_source', payload.license_origin_source ?? '');
    return this.request<SoundAsset>('/api/v1/sounds/import', {
      method: 'POST',
      body: fd,
    });
  }

  updateSound(soundId: string, patch: Partial<SoundAsset>): Promise<SoundAsset> {
    return this.request<SoundAsset>(`/api/v1/sounds/${encodeURIComponent(soundId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  }

  replaceSoundFile(soundId: string, file: File): Promise<SoundAsset> {
    const fd = new FormData();
    fd.append('file', file);
    return this.request<SoundAsset>(`/api/v1/sounds/${encodeURIComponent(soundId)}/replace`, {
      method: 'PUT',
      body: fd,
    });
  }

  deleteSound(soundId: string): Promise<void> {
    return this.request<void>(`/api/v1/sounds/${encodeURIComponent(soundId)}`, {
      method: 'DELETE',
    });
  }

  detectSoundOverlaps(events: SoundEffectEvent[]): Promise<{ count: number; overlaps: Array<{ type: string; time_ms: number; event_ids: string[]; message: string }> }> {
    return this.request('/api/v1/sounds/overlaps', {
      method: 'POST',
      body: JSON.stringify(events),
    });
  }

  // Render, Presets, QC & Jobs
  listExportPresets(): Promise<ExportPreset[]> {
    return this.request<ExportPreset[]>('/api/v1/render/presets');
  }

  createExportPreset(payload: Omit<ExportPreset, 'preset_id' | 'audio_codec' | 'is_builtin'>): Promise<ExportPreset> {
    return this.request<ExportPreset>('/api/v1/render/presets', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  runQC(projectId: string): Promise<QCReport> {
    return this.request<QCReport>(`/api/v1/render/qc/${encodeURIComponent(projectId)}`, {
      method: 'POST',
    });
  }

  startExport(payload: {
    project_id: string;
    preset_id: string;
    output_filename?: string;
    output_dir?: string;
    chunk_duration_seconds?: number;
    render_mode?: 'auto' | 'pixi_stream' | 'software_compositor';
    subtitle_mode?: SubtitleExportMode;
    export_srt_sidecar?: boolean;
    ignore_warnings?: boolean;
    settings?: ExportSettings;
    start_mode?: 'render_now' | 'queue';
  }): Promise<RenderJob> {
    return this.request<RenderJob>('/api/v1/render/export', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  // Phase 08 Batch 3 — export validation, FFmpeg environment, render queue & history
  validateExport(projectId: string, settings: ExportSettings): Promise<ExportPlan> {
    return this.request<ExportPlan>('/api/v1/render/validate', {
      method: 'POST',
      body: JSON.stringify({ project_id: projectId, settings }),
    });
  }

  getRenderEnvironment(refresh = false): Promise<FFmpegEnvironment> {
    return this.request<FFmpegEnvironment>(`/api/v1/render/environment${refresh ? '?refresh=true' : ''}`);
  }

  updateFFmpegConfig(payload: { ffmpeg_path: string | null; ffprobe_path: string | null }): Promise<FFmpegEnvironment> {
    return this.request<FFmpegEnvironment>('/api/v1/render/environment/config', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  }

  testFFmpeg(): Promise<FFmpegTestResult> {
    return this.request<FFmpegTestResult>('/api/v1/render/environment/test', { method: 'POST' });
  }

  getRenderQueueState(): Promise<RenderQueueState> {
    return this.request<RenderQueueState>('/api/v1/render/queue');
  }

  startRenderQueue(): Promise<RenderQueueState> {
    return this.request<RenderQueueState>('/api/v1/render/queue/start', { method: 'POST' });
  }

  stopRenderQueue(): Promise<RenderQueueState> {
    return this.request<RenderQueueState>('/api/v1/render/queue/stop', { method: 'POST' });
  }

  private jobUrl(projectId: string, jobId: string, suffix = ''): string {
    return `/api/v1/jobs/${encodeURIComponent(projectId)}/${encodeURIComponent(jobId)}${suffix}`;
  }

  pauseJob(projectId: string, jobId: string): Promise<RenderJob> {
    return this.request<RenderJob>(this.jobUrl(projectId, jobId, '/pause'), { method: 'POST' });
  }

  retryJob(projectId: string, jobId: string): Promise<RenderJob> {
    return this.request<RenderJob>(this.jobUrl(projectId, jobId, '/retry'), { method: 'POST' });
  }

  skipJob(projectId: string, jobId: string): Promise<RenderJob> {
    return this.request<RenderJob>(this.jobUrl(projectId, jobId, '/skip'), { method: 'POST' });
  }

  moveJob(projectId: string, jobId: string, direction: 'up' | 'down'): Promise<RenderJob[]> {
    return this.request<RenderJob[]>(this.jobUrl(projectId, jobId, '/move'), {
      method: 'POST',
      body: JSON.stringify({ direction }),
    });
  }

  removeJob(projectId: string, jobId: string): Promise<{ removed: boolean; output_file_deleted: boolean }> {
    return this.request(this.jobUrl(projectId, jobId), { method: 'DELETE' });
  }

  reexportJob(projectId: string, jobId: string, startMode: 'render_now' | 'queue' = 'queue'): Promise<RenderJob> {
    return this.request<RenderJob>(this.jobUrl(projectId, jobId, `/reexport?start_mode=${startMode}`), {
      method: 'POST',
    });
  }

  getJobOutputUrl(projectId: string, jobId: string): string {
    const q = this.conn.token ? `?token=${encodeURIComponent(this.conn.token)}` : '';
    return `${this.conn.baseUrl}${this.jobUrl(projectId, jobId, '/output')}${q}`;
  }

  async getJobLog(projectId: string, jobId: string): Promise<string> {
    await this.init();
    const res = await fetch(`${this.conn.baseUrl}${this.jobUrl(projectId, jobId, '/log')}`, {
      headers: this.conn.token ? { 'X-AMCS-Token': this.conn.token } : {},
    });
    if (!res.ok) throw new Error(`Log unavailable (${res.status})`);
    return res.text();
  }

  // Subtitles (SRT / ASS)
  importSrt(payload: {
    content: string;
    default_style_id?: string;
    scene_id?: string | null;
  }): Promise<SrtImportResponse> {
    return this.request<SrtImportResponse>('/api/v1/subtitles/import-srt', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  async exportSrt(payload: {
    segments: SubtitleSegment[];
    styles?: SubtitleStyle[];
    include_disabled?: boolean;
  }): Promise<string> {
    const { baseUrl, token } = this.getConnection();
    const res = await fetch(`${baseUrl}/api/v1/subtitles/export-srt`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'X-AMCS-Token': token } : {}),
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`SRT export failed (${res.status})`);
    return res.text();
  }

  async exportAss(payload: {
    segments: SubtitleSegment[];
    styles: SubtitleStyle[];
    width?: number;
    height?: number;
    include_disabled?: boolean;
  }): Promise<string> {
    const { baseUrl, token } = this.getConnection();
    const res = await fetch(`${baseUrl}/api/v1/subtitles/export-ass`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'X-AMCS-Token': token } : {}),
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`ASS export failed (${res.status})`);
    return res.text();
  }

  listJobs(projectId: string): Promise<RenderJob[]> {
    return this.request<RenderJob[]>(`/api/v1/jobs/${encodeURIComponent(projectId)}`);
  }

  cancelJob(projectId: string, jobId: string): Promise<RenderJob> {
    return this.request<RenderJob>(
      `/api/v1/jobs/${encodeURIComponent(projectId)}/${encodeURIComponent(jobId)}/cancel`,
      { method: 'POST' },
    );
  }

  resumeJob(projectId: string, jobId: string): Promise<RenderJob> {
    return this.request<RenderJob>(
      `/api/v1/jobs/${encodeURIComponent(projectId)}/${encodeURIComponent(jobId)}/resume`,
      { method: 'POST' },
    );
  }

  // Voice Engine (Providers, Profiles, Character Assignment, Generation & Timeline Registration)
  listVoiceProviders(): Promise<VoiceProviderInfo[]> {
    return this.request<VoiceProviderInfo[]>('/api/v1/voice/providers');
  }

  listVoiceProfiles(): Promise<VoiceProfile[]> {
    return this.request<VoiceProfile[]>('/api/v1/voice/profiles');
  }

  createVoiceProfile(payload: VoiceProfileUpsertRequest): Promise<VoiceProfile> {
    return this.request<VoiceProfile>('/api/v1/voice/profiles', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  updateVoiceProfile(
    voiceProfileId: string,
    payload: VoiceProfileUpsertRequest,
  ): Promise<VoiceProfile> {
    return this.request<VoiceProfile>(
      `/api/v1/voice/profiles/${encodeURIComponent(voiceProfileId)}`,
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      },
    );
  }

  deleteVoiceProfile(voiceProfileId: string): Promise<void> {
    return this.request<void>(`/api/v1/voice/profiles/${encodeURIComponent(voiceProfileId)}`, {
      method: 'DELETE',
    });
  }

  assignCharacterVoice(characterId: string, voiceProfileId: string | null): Promise<Character> {
    return this.request<Character>(
      `/api/v1/voice/characters/${encodeURIComponent(characterId)}/assign`,
      {
        method: 'PUT',
        body: JSON.stringify({ voice_profile_id: voiceProfileId }),
      },
    );
  }

  generateVoiceAudio(payload: VoiceGenerateRequest): Promise<VoiceAudioAsset> {
    return this.request<VoiceAudioAsset>('/api/v1/voice/generate', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  listProjectVoiceAudio(projectId: string): Promise<VoiceAudioAsset[]> {
    return this.request<VoiceAudioAsset[]>(
      `/api/v1/voice/audio/${encodeURIComponent(projectId)}`,
    );
  }

  registerVoiceAsSound(
    projectId: string,
    audioAssetId: string,
    label?: string,
  ): Promise<SoundAsset> {
    return this.request<SoundAsset>(
      `/api/v1/voice/audio/${encodeURIComponent(projectId)}/${encodeURIComponent(audioAssetId)}/register-sound`,
      {
        method: 'POST',
        body: JSON.stringify({ label: label ?? null }),
      },
    );
  }

  // Phase 07 Batch 3 — Real F5-TTS Configuration, Lifecycle & Voice Reference API
  getF5TTSStatus(probe = false): Promise<F5TTSStatus> {
    return this.request<F5TTSStatus>(`/api/v1/voice/f5-tts/status?probe=${probe ? 'true' : 'false'}`);
  }

  updateF5TTSConfig(patch: Partial<F5TTSConfig>): Promise<F5TTSConfig> {
    return this.request<F5TTSConfig>('/api/v1/voice/f5-tts/config', {
      method: 'PUT',
      body: JSON.stringify(patch),
    });
  }

  startF5TTSService(): Promise<F5TTSStatus> {
    return this.request<F5TTSStatus>('/api/v1/voice/f5-tts/start', { method: 'POST' });
  }

  stopF5TTSService(): Promise<F5TTSStatus> {
    return this.request<F5TTSStatus>('/api/v1/voice/f5-tts/stop', { method: 'POST' });
  }

  testF5TTSConnection(): Promise<F5TTSTestConnectionResult> {
    return this.request<F5TTSTestConnectionResult>('/api/v1/voice/f5-tts/test-connection', {
      method: 'POST',
    });
  }

  testF5TTSGenerate(payload: {
    project_id: string;
    text: string;
    ref_id?: string | null;
    language?: string | null;
    speed?: number;
    nfe_step?: number;
    cfg_strength?: number;
  }): Promise<VoiceAudioAsset> {
    return this.request<VoiceAudioAsset>('/api/v1/voice/f5-tts/test-generate', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  listF5TTSReferences(): Promise<F5TTSReferenceVoice[]> {
    return this.request<F5TTSReferenceVoice[]>('/api/v1/voice/f5-tts/references');
  }

  async importF5TTSReference(payload: {
    file: File;
    name: string;
    transcript: string;
    language: string;
  }): Promise<F5TTSReferenceVoice> {
    await this.init();
    const fd = new FormData();
    fd.append('file', payload.file);
    fd.append('name', payload.name);
    fd.append('transcript', payload.transcript);
    fd.append('language', payload.language);
    const headers: Record<string, string> = {};
    if (this.conn.token) {
      headers['X-AMCS-Token'] = this.conn.token;
    }
    const res = await fetch(`${this.conn.baseUrl}/api/v1/voice/f5-tts/references`, {
      method: 'POST',
      headers,
      body: fd,
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const j = (await res.json()) as { detail?: string };
        if (j?.detail) detail = j.detail;
      } catch {
        // ignore
      }
      throw new Error(detail);
    }
    return (await res.json()) as F5TTSReferenceVoice;
  }

  getF5TTSReferenceAudioUrl(refId: string): string {
    const q = this.conn.token ? `?token=${encodeURIComponent(this.conn.token)}` : '';
    return `${this.conn.baseUrl}/api/v1/voice/f5-tts/references/${encodeURIComponent(refId)}/file${q}`;
  }

  deleteF5TTSReference(refId: string): Promise<void> {
    return this.request<void>(`/api/v1/voice/f5-tts/references/${encodeURIComponent(refId)}`, {
      method: 'DELETE',
    });
  }

  // Phase 06 Batch 1 — AI Director: Script Intelligence & Scene Breakdown
  getDirectorProviders(): Promise<AIProviderRegistryResponse> {
    return this.request<AIProviderRegistryResponse>('/api/v1/director/providers');
  }

  updateDirectorConfig(patch: AIProviderConfigUpdate): Promise<AIProviderConfig> {
    return this.request<AIProviderConfig>('/api/v1/director/config', {
      method: 'PUT',
      body: JSON.stringify(patch),
    });
  }

  getProviderModels(
    providerId: LLMProviderId,
    refresh = false,
  ): Promise<AIModelDiscoveryResult> {
    return this.request<AIModelDiscoveryResult>(
      `/api/v1/director/models/${encodeURIComponent(providerId)}?refresh=${refresh ? 'true' : 'false'}`,
    );
  }

  refreshProviderModels(providerId: LLMProviderId): Promise<AIModelDiscoveryResult> {
    return this.request<AIModelDiscoveryResult>(
      `/api/v1/director/models/${encodeURIComponent(providerId)}/refresh`,
      { method: 'POST' },
    );
  }

  updateFeatureModels(
    featureModels: Record<string, FeatureModelOverride>,
  ): Promise<AIProviderConfig> {
    return this.request<AIProviderConfig>('/api/v1/director/feature-models', {
      method: 'PUT',
      body: JSON.stringify(featureModels),
    });
  }

  checkModelCompatibility(payload: {
    feature_key: AIFeatureKey;
    provider_id: LLMProviderId;
    model: string;
    estimated_input_chars?: number;
    requires_vision?: boolean;
    requires_tools?: boolean;
  }): Promise<ModelCompatibilityResult> {
    return this.request<ModelCompatibilityResult>('/api/v1/director/models/check-compatibility', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  testDirectorProvider(): Promise<{ ok: boolean; provider_id: string; model: string }> {
    return this.request<{ ok: boolean; provider_id: string; model: string }>(
      '/api/v1/director/test-provider',
      { method: 'POST' },
    );
  }

  analyzeProjectScript(
    projectId: string,
    payload: {
      script_source_mode?: ScriptSourceMode;
      custom_script_text?: string | null;
      analysis_language?: AnalysisLanguage | null;
      force?: boolean;
      max_chunk_chars?: number | null;
    },
  ): Promise<DirectorAnalysisDocument> {
    return this.request<DirectorAnalysisDocument>(
      `/api/v1/director/${encodeURIComponent(projectId)}/analyze`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    );
  }

  getDirectorProgress(projectId: string): Promise<AnalysisProgress> {
    return this.request<AnalysisProgress>(
      `/api/v1/director/${encodeURIComponent(projectId)}/progress`,
    );
  }

  cancelDirectorAnalysis(projectId: string): Promise<AnalysisProgress> {
    return this.request<AnalysisProgress>(
      `/api/v1/director/${encodeURIComponent(projectId)}/cancel`,
      { method: 'POST' },
    );
  }

  regenerateDirectorScene(
    projectId: string,
    sceneBreakdownId: string,
    payload?: { instructions?: string; preserve_user_edits?: boolean },
  ): Promise<SceneBreakdownItem> {
    return this.request<SceneBreakdownItem>(
      `/api/v1/director/${encodeURIComponent(projectId)}/regenerate-scene/${encodeURIComponent(sceneBreakdownId)}`,
      {
        method: 'POST',
        body: JSON.stringify({
          instructions: payload?.instructions ?? '',
          preserve_user_edits: payload?.preserve_user_edits ?? true,
        }),
      },
    );
  }

  // Phase 06 Batch 2 — AI Storyboard, Shot Planning & Camera Direction
  listStoryboardApprovedScenes(projectId: string): Promise<ApprovedSceneSummary[]> {
    return this.request<ApprovedSceneSummary[]>(
      `/api/v1/storyboard/${encodeURIComponent(projectId)}/approved-scenes`,
    );
  }

  generateStoryboard(
    projectId: string,
    payload?: {
      scene_ids?: string[] | null;
      force?: boolean;
      strategy?: RegenerateStrategy;
      confirm_replace_all?: boolean;
      analysis_language?: AnalysisLanguage | null;
    },
  ): Promise<StoryboardDocument> {
    return this.request<StoryboardDocument>(
      `/api/v1/storyboard/${encodeURIComponent(projectId)}/generate`,
      {
        method: 'POST',
        body: JSON.stringify(payload ?? {}),
      },
    );
  }

  generateSceneStoryboard(
    projectId: string,
    sceneId: string,
    payload?: {
      force?: boolean;
      strategy?: RegenerateStrategy;
      confirm_replace_all?: boolean;
      instructions?: string;
      analysis_language?: AnalysisLanguage | null;
    },
  ): Promise<StoryboardDocument> {
    return this.request<StoryboardDocument>(
      `/api/v1/storyboard/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(sceneId)}/generate`,
      {
        method: 'POST',
        body: JSON.stringify(payload ?? {}),
      },
    );
  }

  regenerateStoryboardShot(
    projectId: string,
    shotId: string,
    payload?: { instructions?: string; preserve_user_edits?: boolean },
  ): Promise<StoryboardShot> {
    return this.request<StoryboardShot>(
      `/api/v1/storyboard/${encodeURIComponent(projectId)}/shots/${encodeURIComponent(shotId)}/regenerate`,
      {
        method: 'POST',
        body: JSON.stringify({
          instructions: payload?.instructions ?? '',
          preserve_user_edits: payload?.preserve_user_edits ?? true,
        }),
      },
    );
  }

  runStoryboardContinuityCheck(
    projectId: string,
  ): Promise<{ warnings: ContinuityWarning[]; total_shots_checked: number }> {
    return this.request<{ warnings: ContinuityWarning[]; total_shots_checked: number }>(
      `/api/v1/storyboard/${encodeURIComponent(projectId)}/continuity-check`,
      { method: 'POST' },
    );
  }

  getStoryboardProgress(projectId: string): Promise<StoryboardProgress> {
    return this.request<StoryboardProgress>(
      `/api/v1/storyboard/${encodeURIComponent(projectId)}/progress`,
    );
  }

  cancelStoryboardGeneration(projectId: string): Promise<StoryboardProgress> {
    return this.request<StoryboardProgress>(
      `/api/v1/storyboard/${encodeURIComponent(projectId)}/cancel`,
      { method: 'POST' },
    );
  }

  // Phase 06 Batch 3 — AI Production Planner & Readiness Checking
  generateProductionPlan(
    projectId: string,
    payload?: {
      scene_ids?: string[] | null;
      force?: boolean;
      preserve_locked?: boolean;
      analysis_language?: AnalysisLanguage | null;
    },
  ): Promise<ProductionPlanDocument> {
    return this.request<ProductionPlanDocument>(
      `/api/v1/production/${encodeURIComponent(projectId)}/generate`,
      {
        method: 'POST',
        body: JSON.stringify(payload ?? {}),
      },
    );
  }

  generateSceneProductionPlan(
    projectId: string,
    sceneId: string,
    payload?: {
      preserve_locked?: boolean;
      analysis_language?: AnalysisLanguage | null;
    },
  ): Promise<ProductionPlanDocument> {
    return this.request<ProductionPlanDocument>(
      `/api/v1/production/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(sceneId)}/generate`,
      {
        method: 'POST',
        body: JSON.stringify({ ...(payload ?? {}), force: true }),
      },
    );
  }

  regenerateProductionShot(
    projectId: string,
    productionShotId: string,
    payload?: { instructions?: string; preserve_user_edits?: boolean },
  ): Promise<ProductionShotPlan> {
    return this.request<ProductionShotPlan>(
      `/api/v1/production/${encodeURIComponent(projectId)}/shots/${encodeURIComponent(productionShotId)}/regenerate`,
      {
        method: 'POST',
        body: JSON.stringify({
          instructions: payload?.instructions ?? '',
          preserve_user_edits: payload?.preserve_user_edits ?? true,
        }),
      },
    );
  }

  refreshProductionReadiness(projectId: string): Promise<ProductionPlanDocument> {
    return this.request<ProductionPlanDocument>(
      `/api/v1/production/${encodeURIComponent(projectId)}/refresh-readiness`,
      { method: 'POST' },
    );
  }

  getProductionProgress(projectId: string): Promise<ProductionProgress> {
    return this.request<ProductionProgress>(
      `/api/v1/production/${encodeURIComponent(projectId)}/progress`,
    );
  }

  cancelProductionGeneration(projectId: string): Promise<ProductionProgress> {
    return this.request<ProductionProgress>(
      `/api/v1/production/${encodeURIComponent(projectId)}/cancel`,
      { method: 'POST' },
    );
  }

  // Phase 07 Batch 1 — Scene Execution Engine & Automated Scene Assembly
  validateSceneExecution(
    projectId: string,
    includeUnapproved = true,
  ): Promise<SceneValidationReport> {
    return this.request<SceneValidationReport>(
      `/api/v1/scene-execution/${encodeURIComponent(projectId)}/validate?include_unapproved=${includeUnapproved ? 'true' : 'false'}`,
    );
  }

  previewSceneExecution(
    projectId: string,
    payload?: {
      scene_ids?: string[] | null;
      production_shot_ids?: string[] | null;
      include_unapproved?: boolean;
    },
  ): Promise<SceneExecutionPreview> {
    return this.request<SceneExecutionPreview>(
      `/api/v1/scene-execution/${encodeURIComponent(projectId)}/preview`,
      {
        method: 'POST',
        body: JSON.stringify({
          scene_ids: payload?.scene_ids ?? null,
          production_shot_ids: payload?.production_shot_ids ?? null,
          include_unapproved: payload?.include_unapproved ?? false,
        }),
      },
    );
  }

  executeSceneAssembly(
    projectId: string,
    payload: {
      scene_ids?: string[] | null;
      production_shot_ids?: string[] | null;
      skip_shot_ids?: string[];
      include_unapproved?: boolean;
      existing_policy?: ExistingExecutionPolicy;
      allow_partial?: boolean;
      sync_timeline_keyframes?: boolean;
    },
  ): Promise<SceneExecutionResult> {
    return this.request<SceneExecutionResult>(
      `/api/v1/scene-execution/${encodeURIComponent(projectId)}/execute`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    );
  }

  repairMissingAsset(
    projectId: string,
    payload: RepairAssetRequest,
  ): Promise<{ project: ProjectState; validation: SceneValidationReport }> {
    return this.request<{ project: ProjectState; validation: SceneValidationReport }>(
      `/api/v1/scene-execution/${encodeURIComponent(projectId)}/repair-asset`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    );
  }

  updateExecutedShot(
    projectId: string,
    shotId: string,
    payload: {
      title?: string;
      duration_ms?: number;
      background_asset_id?: string | null;
      clear_background?: boolean;
      camera_default?: SceneShot['camera_default'];
      character_states?: SceneShot['character_states'];
      prop_states?: SceneShot['prop_states'];
    },
  ): Promise<{ shot: SceneShot; project: ProjectState }> {
    return this.request<{ shot: SceneShot; project: ProjectState }>(
      `/api/v1/scene-execution/${encodeURIComponent(projectId)}/shots/${encodeURIComponent(shotId)}`,
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      },
    );
  }

  // Phase 07 Batch 2 — Animation Capabilities, Motion Library, Motion Preview & Camera Motion
  getCharacterCapabilities(characterId: string): Promise<CharacterRigCapabilities> {
    return this.request<CharacterRigCapabilities>(
      `/api/v1/animation-execution/capabilities/${encodeURIComponent(characterId)}`,
    );
  }

  listMotionPresets(category?: string): Promise<MotionPreset[]> {
    const q = category ? `?category=${encodeURIComponent(category)}` : '';
    return this.request<MotionPreset[]>(`/api/v1/animation-execution/presets${q}`);
  }

  createMotionPreset(payload: {
    name: string;
    category: AnimationActionCategory;
    description?: string;
    base_preset_id?: string | null;
    required_capabilities?: RigCapability[] | null;
    optional_capabilities?: RigCapability[] | null;
    default_parameters: MotionParameters;
    limitations?: string[];
    tags?: string[];
  }): Promise<MotionPreset> {
    return this.request<MotionPreset>('/api/v1/animation-execution/presets', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  updateMotionPreset(
    presetId: string,
    payload: {
      name?: string;
      description?: string;
      default_parameters?: MotionParameters;
      tags?: string[];
      limitations?: string[];
    },
  ): Promise<MotionPreset> {
    return this.request<MotionPreset>(
      `/api/v1/animation-execution/presets/${encodeURIComponent(presetId)}`,
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      },
    );
  }

  duplicateMotionPreset(presetId: string, name?: string): Promise<MotionPreset> {
    return this.request<MotionPreset>(
      `/api/v1/animation-execution/presets/${encodeURIComponent(presetId)}/duplicate`,
      {
        method: 'POST',
        body: JSON.stringify(name ? { name } : {}),
      },
    );
  }

  deleteMotionPreset(presetId: string): Promise<{ deleted: boolean }> {
    return this.request<{ deleted: boolean }>(
      `/api/v1/animation-execution/presets/${encodeURIComponent(presetId)}`,
      { method: 'DELETE' },
    );
  }

  checkMotionPresetCompatibility(
    presetId: string,
    characterId: string,
  ): Promise<MotionCompatibilityResult> {
    return this.request<MotionCompatibilityResult>(
      `/api/v1/animation-execution/presets/${encodeURIComponent(presetId)}/compatibility/${encodeURIComponent(characterId)}`,
    );
  }

  previewMotion(
    projectId: string,
    payload: {
      scene_id: string;
      shot_id?: string | null;
      target_kind: 'character' | 'camera';
      instance_id?: string | null;
      preset_id?: string | null;
      start_time_ms?: number | null;
      parameters?: MotionParameters;
      camera_parameters?: CameraMotionParameters | null;
      sync_camera_follow?: boolean;
    },
  ): Promise<MotionPreviewResponse> {
    return this.request<MotionPreviewResponse>(
      `/api/v1/animation-execution/${encodeURIComponent(projectId)}/preview-motion`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    );
  }

  applyMotion(
    projectId: string,
    payload: {
      scene_id: string;
      shot_id?: string | null;
      target_kind: 'character' | 'camera';
      instance_id?: string | null;
      preset_id?: string | null;
      motion_id?: string | null;
      start_time_ms?: number | null;
      parameters?: MotionParameters;
      camera_parameters?: CameraMotionParameters | null;
      sync_camera_follow?: boolean;
      allow_partial?: boolean;
    },
  ): Promise<MotionApplyResponse> {
    return this.request<MotionApplyResponse>(
      `/api/v1/animation-execution/${encodeURIComponent(projectId)}/apply-motion`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    );
  }

  executeShotAnimations(
    projectId: string,
    payload: {
      scene_ids?: string[] | null;
      shot_ids?: string[] | null;
      production_shot_ids?: string[] | null;
      include_character_motion?: boolean;
      include_camera_motion?: boolean;
      sync_camera_with_character?: boolean;
      preserve_user_modified?: boolean;
      regenerate_motion_ids?: string[];
      allow_partial?: boolean;
      dry_run?: boolean;
    },
  ): Promise<ShotAnimationExecuteResponse> {
    return this.request<ShotAnimationExecuteResponse>(
      `/api/v1/animation-execution/${encodeURIComponent(projectId)}/execute-shots`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    );
  }

  // Phase 07 Batch 3 — Automated Production Queue & 8-Category QC
  getProductionQueue(projectId: string): Promise<ProductionQueueDocument> {
    return this.request<ProductionQueueDocument>(
      `/api/v1/production-queue/${encodeURIComponent(projectId)}`,
    );
  }

  planProductionQueue(
    projectId: string,
    payload: ProductionQueueStartRequest,
  ): Promise<ProductionQueuePlanPreview> {
    return this.request<ProductionQueuePlanPreview>(
      `/api/v1/production-queue/${encodeURIComponent(projectId)}/plan`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    );
  }

  startProductionQueue(
    projectId: string,
    payload: ProductionQueueStartRequest,
  ): Promise<ProductionQueueDocument> {
    return this.request<ProductionQueueDocument>(
      `/api/v1/production-queue/${encodeURIComponent(projectId)}/start`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    );
  }

  pauseProductionQueue(projectId: string): Promise<ProductionQueueDocument> {
    return this.request<ProductionQueueDocument>(
      `/api/v1/production-queue/${encodeURIComponent(projectId)}/pause`,
      { method: 'POST' },
    );
  }

  resumeProductionQueue(projectId: string): Promise<ProductionQueueDocument> {
    return this.request<ProductionQueueDocument>(
      `/api/v1/production-queue/${encodeURIComponent(projectId)}/resume`,
      { method: 'POST' },
    );
  }

  cancelProductionQueue(projectId: string): Promise<ProductionQueueDocument> {
    return this.request<ProductionQueueDocument>(
      `/api/v1/production-queue/${encodeURIComponent(projectId)}/cancel`,
      { method: 'POST' },
    );
  }

  retryProductionTask(projectId: string, taskId: string): Promise<ProductionQueueDocument> {
    return this.request<ProductionQueueDocument>(
      `/api/v1/production-queue/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/retry`,
      { method: 'POST' },
    );
  }

  skipProductionTask(projectId: string, taskId: string): Promise<ProductionQueueDocument> {
    return this.request<ProductionQueueDocument>(
      `/api/v1/production-queue/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/skip`,
      { method: 'POST' },
    );
  }

  cancelProductionTask(projectId: string, taskId: string): Promise<ProductionQueueDocument> {
    return this.request<ProductionQueueDocument>(
      `/api/v1/production-queue/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/cancel`,
      { method: 'POST' },
    );
  }

  runProjectQC(projectId: string, sceneIds?: string[] | null): Promise<ProductionQCReport> {
    return this.request<ProductionQCReport>(`/api/v1/qc/${encodeURIComponent(projectId)}/run`, {
      method: 'POST',
      body: JSON.stringify({ scene_ids: sceneIds ?? null }),
    });
  }

  getLatestProjectQC(projectId: string): Promise<ProductionQCReport> {
    return this.request<ProductionQCReport>(
      `/api/v1/qc/${encodeURIComponent(projectId)}/latest`,
    );
  }

  fixProjectQCIssue(
    projectId: string,
    payload: {
      issue_id: string;
      fix_action: string;
      scene_id?: string | null;
      shot_id?: string | null;
      subtitle_id?: string | null;
      sound_event_id?: string | null;
    },
  ): Promise<{ ok: boolean; message: string; report: ProductionQCReport; updated_project: ProjectState }> {
    return this.request<{
      ok: boolean;
      message: string;
      report: ProductionQCReport;
      updated_project: ProjectState;
    }>(`/api/v1/qc/${encodeURIComponent(projectId)}/fix`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }
}

export const apiClient = new ApiClient();
