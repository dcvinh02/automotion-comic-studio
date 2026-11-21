import type { ProjectState, SoundAsset } from '@/types/models';

export interface AudioPreviewState {
  soundId: string | null;
  status: 'idle' | 'loading' | 'playing' | 'paused';
  positionSec: number;
  durationSec: number;
  error: string | null;
}

type PreviewListener = (state: AudioPreviewState) => void;

const MAX_CACHED_BUFFERS = 24;

class AudioPreviewEngine {
  private ctx: AudioContext | null = null;
  private bufferCache = new Map<string, AudioBuffer>();
  private inFlightLoads = new Map<string, Promise<AudioBuffer>>();

  private previewSource: AudioBufferSourceNode | null = null;
  private previewGain: GainNode | null = null;
  private previewSoundId: string | null = null;
  private previewUrl: string | null = null;
  private previewStatus: 'idle' | 'loading' | 'playing' | 'paused' = 'idle';
  private previewStartedAtCtx = 0;
  private previewOffsetSec = 0;
  private previewDurationSec = 0;
  private previewVolume = 0.85;
  private previewLoop = false;
  private previewError: string | null = null;
  private listeners = new Set<PreviewListener>();

  private activeTimelineSources: AudioBufferSourceNode[] = [];

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
    return this.ctx;
  }

  private emitPreviewState(): void {
    const snap = this.getPreviewState();
    for (const listener of this.listeners) {
      try {
        listener(snap);
      } catch {
        // Ignore listener error
      }
    }
  }

  getPreviewState(): AudioPreviewState {
    let pos = this.previewOffsetSec;
    if (this.previewStatus === 'playing' && this.ctx) {
      const elapsed = Math.max(0, this.ctx.currentTime - this.previewStartedAtCtx);
      pos = this.previewDurationSec > 0
        ? this.previewLoop
          ? (this.previewOffsetSec + elapsed) % this.previewDurationSec
          : Math.min(this.previewDurationSec, this.previewOffsetSec + elapsed)
        : this.previewOffsetSec + elapsed;
    }
    return {
      soundId: this.previewSoundId,
      status: this.previewStatus,
      positionSec: pos,
      durationSec: this.previewDurationSec,
      error: this.previewError,
    };
  }

  subscribePreviewState(listener: PreviewListener): () => void {
    this.listeners.add(listener);
    listener(this.getPreviewState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private touchCache(soundId: string, buffer: AudioBuffer): void {
    // True LRU: delete & re-insert so recently used stays warm, evict oldest beyond cap
    if (this.bufferCache.has(soundId)) {
      this.bufferCache.delete(soundId);
    }
    this.bufferCache.set(soundId, buffer);
    while (this.bufferCache.size > MAX_CACHED_BUFFERS) {
      const oldestKey = this.bufferCache.keys().next().value;
      if (oldestKey === undefined) break;
      this.bufferCache.delete(oldestKey);
    }
  }

  async loadBuffer(soundId: string, url: string): Promise<AudioBuffer> {
    const cached = this.bufferCache.get(soundId);
    if (cached) {
      this.touchCache(soundId, cached);
      return cached;
    }

    const pending = this.inFlightLoads.get(soundId);
    if (pending) return pending;

    const loadPromise = (async () => {
      const ctx = this.ensureContext();
      const res = await fetch(url);
      if (!res.ok) {
        if (res.status === 404) {
          throw new Error(`Audio file missing or deleted (404)`);
        }
        throw new Error(`Failed to fetch audio (${res.status})`);
      }
      const arrBuf = await res.arrayBuffer();
      if (arrBuf.byteLength === 0) {
        throw new Error('Audio file is empty');
      }
      let decoded: AudioBuffer;
      try {
        decoded = await ctx.decodeAudioData(arrBuf.slice(0));
      } catch {
        throw new Error('Unsupported or corrupted audio format');
      }
      this.touchCache(soundId, decoded);
      return decoded;
    })();

    this.inFlightLoads.set(soundId, loadPromise);
    try {
      return await loadPromise;
    } finally {
      this.inFlightLoads.delete(soundId);
    }
  }

  invalidateSound(soundId: string): void {
    this.bufferCache.delete(soundId);
    if (this.previewSoundId === soundId) {
      this.stopPreview();
    }
  }

  private stopPreviewNodeOnly(): void {
    if (this.previewSource) {
      this.previewSource.onended = null;
      try {
        this.previewSource.stop();
      } catch {
        // Ignore already stopped
      }
      try {
        this.previewSource.disconnect();
      } catch {
        // Ignore
      }
      this.previewSource = null;
    }
    if (this.previewGain) {
      try {
        this.previewGain.disconnect();
      } catch {
        // Ignore
      }
      this.previewGain = null;
    }
  }

  private startPreviewBufferAt(
    soundId: string,
    url: string,
    buffer: AudioBuffer,
    offsetSec: number,
    volume: number,
    loop: boolean,
  ): void {
    this.stopPreviewNodeOnly();
    const ctx = this.ensureContext();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = loop;

    const gain = ctx.createGain();
    gain.gain.value = Math.max(0, Math.min(2, volume));
    source.connect(gain);
    gain.connect(ctx.destination);

    const safeOffset = buffer.duration > 0 ? Math.max(0, Math.min(buffer.duration - 0.01, offsetSec)) : 0;
    source.start(0, safeOffset);

    this.previewSource = source;
    this.previewGain = gain;
    this.previewSoundId = soundId;
    this.previewUrl = url;
    this.previewStatus = 'playing';
    this.previewStartedAtCtx = ctx.currentTime;
    this.previewOffsetSec = safeOffset;
    this.previewDurationSec = buffer.duration;
    this.previewVolume = volume;
    this.previewLoop = loop;
    this.previewError = null;

    source.onended = () => {
      if (this.previewSource === source) {
        this.stopPreviewNodeOnly();
        this.previewStatus = 'idle';
        this.previewSoundId = null;
        this.previewOffsetSec = 0;
        this.emitPreviewState();
      }
    };
    this.emitPreviewState();
  }

  async previewSound(
    soundId: string,
    url: string,
    volume = 0.85,
    options?: { loop?: boolean },
  ): Promise<void> {
    const loop = Boolean(options?.loop);

    // If resuming the same paused sound, continue from paused offset
    if (this.previewSoundId === soundId && this.previewStatus === 'paused') {
      await this.resumePreview(volume);
      return;
    }

    // Never allow accidental overlapping previews
    this.stopPreviewNodeOnly();
    this.previewSoundId = soundId;
    this.previewUrl = url;
    this.previewStatus = 'loading';
    this.previewOffsetSec = 0;
    this.previewVolume = volume;
    this.previewLoop = loop;
    this.previewError = null;
    this.emitPreviewState();

    try {
      const buffer = await this.loadBuffer(soundId, url);
      // Guard against stopPreview or another previewSound called while decoding
      if (this.previewSoundId !== soundId || this.previewStatus !== 'loading') {
        return;
      }
      this.startPreviewBufferAt(soundId, url, buffer, 0, volume, loop);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Audio preview failed';
      if (this.previewSoundId === soundId) {
        this.previewStatus = 'idle';
        this.previewSoundId = null;
        this.previewError = msg;
        this.emitPreviewState();
      }
      throw err;
    }
  }

  pausePreview(): void {
    if (this.previewStatus !== 'playing' || !this.previewSoundId) return;
    const elapsed = this.ctx ? Math.max(0, this.ctx.currentTime - this.previewStartedAtCtx) : 0;
    const nextOffset =
      this.previewDurationSec > 0
        ? this.previewLoop
          ? (this.previewOffsetSec + elapsed) % this.previewDurationSec
          : Math.min(this.previewDurationSec, this.previewOffsetSec + elapsed)
        : 0;
    this.stopPreviewNodeOnly();
    this.previewOffsetSec = nextOffset;
    this.previewStatus = 'paused';
    this.emitPreviewState();
  }

  async resumePreview(volume?: number): Promise<void> {
    if (this.previewStatus !== 'paused' || !this.previewSoundId || !this.previewUrl) return;
    const targetId = this.previewSoundId;
    const targetUrl = this.previewUrl;
    const vol = volume ?? this.previewVolume;
    const buffer = await this.loadBuffer(targetId, targetUrl);
    if (this.previewSoundId !== targetId || this.previewStatus !== 'paused') return;
    this.startPreviewBufferAt(targetId, targetUrl, buffer, this.previewOffsetSec, vol, this.previewLoop);
  }

  setPreviewVolume(volume: number): void {
    this.previewVolume = Math.max(0, Math.min(2, volume));
    if (this.previewGain) {
      this.previewGain.gain.value = this.previewVolume;
    }
  }

  stopPreview(): void {
    this.stopPreviewNodeOnly();
    this.previewSoundId = null;
    this.previewUrl = null;
    this.previewStatus = 'idle';
    this.previewOffsetSec = 0;
    this.previewDurationSec = 0;
    this.previewError = null;
    this.emitPreviewState();
  }

  async startTimelinePlayback(
    startMs: number,
    state: ProjectState,
    soundsById: Record<string, SoundAsset>,
    getSoundUrl: (soundId: string) => string,
  ): Promise<void> {
    this.stopPreview();
    this.stopTimelinePlayback();
    const ctx = this.ensureContext();

    const tracksById = new Map(state.timeline.tracks.map((t) => [t.track_id, t]));
    const soloAudioIds = new Set(
      state.timeline.tracks
        .filter((t) => ['sfx', 'voice', 'ambient', 'bgm'].includes(t.track_type) && t.solo)
        .map((t) => t.track_id),
    );

    const candidateEvents = state.timeline.sound_events.filter((ev) => {
      if (ev.end_ms <= startMs) return false;
      const track = tracksById.get(ev.track_id);
      if (track?.muted) return false;
      if (soloAudioIds.size > 0 && (!track || !soloAudioIds.has(track.track_id))) return false;
      return Boolean(soundsById[ev.sound_id]);
    });

    if (candidateEvents.length === 0) return;

    // Decode only the active timeline audio clips (never the whole library)
    const uniqueIds = [...new Set(candidateEvents.map((e) => e.sound_id))];
    await Promise.all(
      uniqueIds.map((sid) => this.loadBuffer(sid, getSoundUrl(sid)).catch(() => null)),
    );

    const nowCtx = ctx.currentTime + 0.02;

    for (const ev of candidateEvents) {
      const buffer = this.bufferCache.get(ev.sound_id);
      if (!buffer) continue;

      const track = tracksById.get(ev.track_id);
      const trackVol = track?.volume ?? 1;
      const targetGain = Math.max(0, Math.min(2, ev.volume * trackVol));
      if (targetGain <= 0.0001) continue;

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = Math.max(0.5, Math.min(2, ev.speed));
      source.loop = ev.loop;

      const gain = ctx.createGain();
      const panner = ctx.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, ev.spatial_position));

      source.connect(gain);
      gain.connect(panner);
      panner.connect(ctx.destination);

      const delaySec = Math.max(0, (ev.start_ms - startMs) / 1000);
      const alreadyElapsedSec = Math.max(0, (startMs - ev.start_ms) / 1000);
      const remainingDurSec = Math.max(0.01, (ev.end_ms - Math.max(startMs, ev.start_ms)) / 1000);
      const offsetSec = (ev.trim_start_ms / 1000) + alreadyElapsedSec * ev.speed;

      const startAt = nowCtx + delaySec;
      const endAt = startAt + remainingDurSec;

      const fadeInSec = Math.min(remainingDurSec, ev.fade_in_ms / 1000);
      const fadeOutSec = Math.min(remainingDurSec, ev.fade_out_ms / 1000);

      if (fadeInSec > 0 && alreadyElapsedSec === 0) {
        gain.gain.setValueAtTime(0.0001, startAt);
        gain.gain.linearRampToValueAtTime(targetGain, startAt + fadeInSec);
      } else {
        gain.gain.setValueAtTime(targetGain, startAt);
      }

      if (fadeOutSec > 0 && endAt - fadeOutSec > startAt) {
        gain.gain.setValueAtTime(targetGain, endAt - fadeOutSec);
        gain.gain.linearRampToValueAtTime(0.0001, endAt);
      }

      if (ev.loop) {
        source.start(startAt, offsetSec % Math.max(0.05, buffer.duration), remainingDurSec);
      } else if (offsetSec < buffer.duration) {
        source.start(startAt, offsetSec, remainingDurSec);
      } else {
        continue;
      }

      this.activeTimelineSources.push(source);
    }
  }

  stopTimelinePlayback(): void {
    for (const src of this.activeTimelineSources) {
      try {
        src.stop();
      } catch {
        // Ignore already stopped
      }
      try {
        src.disconnect();
      } catch {
        // Ignore
      }
    }
    this.activeTimelineSources = [];
  }

  getCachedBufferCount(): number {
    return this.bufferCache.size;
  }
}

export const audioPreviewEngine = new AudioPreviewEngine();
