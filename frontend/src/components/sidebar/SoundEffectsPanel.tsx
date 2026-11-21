import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  FileCheck2,
  Music,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Repeat,
  Square,
  Star,
  Trash2,
  Upload,
  Volume2,
  Waves,
} from 'lucide-react';
import { useI18n } from '@/i18n/useLocaleStore';
import { audioPreviewEngine, type AudioPreviewState } from '@/engine/audioPreviewEngine';
import { frameToMs } from '@/engine/evaluator';
import { apiClient } from '@/services/apiClient';
import { useJobStore } from '@/stores/useJobStore';
import { useLibraryStore } from '@/stores/useLibraryStore';
import { usePlaybackStore } from '@/stores/usePlaybackStore';
import { useProjectStore } from '@/stores/useProjectStore';
import type { AudioType, LicenseSource, LicenseUsage, SoundAsset, SoundCategory } from '@/types/models';
import { SearchInput } from '@/components/ui/SearchInput';
import { EmptyState, WaveformCanvas } from '@/components/common/CommonUI';

function formatAudioDuration(ms: number): string {
  const sec = Math.max(0, ms / 1000);
  if (sec < 60) return `${sec.toFixed(2)}s`;
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

export function SoundEffectsPanel() {
  const { t } = useI18n();
  const sounds = useLibraryStore((s) => s.sounds);
  const sfxCategories = useLibraryStore((s) => s.sfxCategories);
  const bgmCategories = useLibraryStore((s) => s.bgmCategories);
  const starterManifest = useLibraryStore((s) => s.starterManifest);
  const upsertSound = useLibraryStore((s) => s.upsertSound);
  const removeSound = useLibraryStore((s) => s.removeSound);
  const pushToast = useJobStore((s) => s.pushToast);

  const project = useProjectStore((s) => s.project);
  const activeSceneId = useProjectStore((s) => s.activeSceneId);
  const addSoundToBestTrack = useProjectStore((s) => s.addSoundToBestTrack);
  const currentFrame = usePlaybackStore((s) => s.currentFrame);

  // Strictly separated primary libraries: SFX vs BGM
  const [activeAudioTab, setActiveAudioTab] = useState<AudioType>('sfx');
  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [selectedTag, setSelectedTag] = useState<string>('all');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [previewVolume, setPreviewVolume] = useState(0.85);
  const [previewState, setPreviewState] = useState<AudioPreviewState>(() =>
    audioPreviewEngine.getPreviewState(),
  );

  const [showImport, setShowImport] = useState(false);
  const [showManifest, setShowManifest] = useState(false);
  const [impName, setImpName] = useState('');
  const [impCategory, setImpCategory] = useState<SoundCategory>('footsteps');
  const [impTags, setImpTags] = useState('');
  const [impLoopable, setImpLoopable] = useState(false);
  const [impLicenseSource, setImpLicenseSource] = useState<LicenseSource>('user_imported');
  const [impLicenseUsage, setImpLicenseUsage] = useState<LicenseUsage>('verified');
  const [impAttribution, setImpAttribution] = useState('');
  const [impOriginSource, setImpOriginSource] = useState('');
  const [uploading, setUploading] = useState(false);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  const fileRef = useRef<HTMLInputElement | null>(null);
  const replaceRef = useRef<HTMLInputElement | null>(null);
  const [replaceTargetId, setReplaceTargetId] = useState<string | null>(null);

  useEffect(() => {
    const unsub = audioPreviewEngine.subscribePreviewState(setPreviewState);
    return () => {
      unsub();
      audioPreviewEngine.stopPreview();
    };
  }, []);

  // Keep category & loop defaults clean when switching between SFX and BGM tabs
  const switchAudioTab = (tab: AudioType) => {
    setActiveAudioTab(tab);
    setSelectedCategory('all');
    setSelectedTag('all');
    setImpCategory(tab === 'bgm' ? 'cinematic' : 'footsteps');
    setImpLoopable(tab === 'bgm');
  };

  const sfxList = useMemo(
    () => sounds.filter((s) => (s.audio_type ?? 'sfx') === 'sfx'),
    [sounds],
  );
  const bgmList = useMemo(
    () => sounds.filter((s) => s.audio_type === 'bgm'),
    [sounds],
  );
  const tabSounds = activeAudioTab === 'bgm' ? bgmList : sfxList;
  const categories = activeAudioTab === 'bgm' ? bgmCategories : sfxCategories;

  const availableTags = useMemo(() => {
    const set = new Set<string>();
    for (const s of tabSounds) {
      for (const tg of s.tags) set.add(tg);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [tabSounds]);

  const filtered = useMemo(() => {
    return tabSounds.filter((s) => {
      if (selectedCategory !== 'all' && s.category !== selectedCategory) return false;
      if (selectedTag !== 'all' && !s.tags.some((tg) => tg.toLowerCase() === selectedTag.toLowerCase())) {
        return false;
      }
      if (favoritesOnly && !s.is_favorite) return false;
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        return (
          s.name.toLowerCase().includes(q) ||
          s.category.toLowerCase().includes(q) ||
          s.tags.some((tg) => tg.toLowerCase().includes(q)) ||
          (s.license.origin_source ?? '').toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [tabSounds, selectedCategory, selectedTag, favoritesOnly, search]);

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const imported = await apiClient.importSound({
        file,
        name: impName.trim() || undefined,
        audio_type: activeAudioTab,
        category: impCategory,
        tags: impTags
          .split(',')
          .map((tg) => tg.trim())
          .filter(Boolean),
        default_volume: activeAudioTab === 'bgm' ? 0.55 : 0.8,
        loopable: impLoopable,
        license_source: impLicenseSource,
        license_usage: impLicenseUsage,
        license_attribution: impAttribution.trim(),
        license_origin_source: impOriginSource.trim(),
      });
      upsertSound(imported);
      pushToast('success', `${imported.name} (${formatAudioDuration(imported.duration_ms)})`);
      setShowImport(false);
      setImpName('');
      setImpTags('');
      setImpAttribution('');
      setImpOriginSource('');
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : 'Import error');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleReplaceFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !replaceTargetId) return;
    try {
      const updated = await apiClient.replaceSoundFile(replaceTargetId, file);
      audioPreviewEngine.invalidateSound(updated.sound_id);
      upsertSound(updated);
      pushToast('success', updated.name);
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : 'Replace error');
    } finally {
      setReplaceTargetId(null);
      if (replaceRef.current) replaceRef.current.value = '';
    }
  };

  const handleTogglePlayPause = async (sound: SoundAsset) => {
    const isCurrent = previewState.soundId === sound.sound_id;
    if (isCurrent && previewState.status === 'playing') {
      audioPreviewEngine.pausePreview();
      return;
    }
    try {
      await audioPreviewEngine.previewSound(
        sound.sound_id,
        apiClient.getSoundFileUrl(sound.sound_id),
        previewVolume,
        { loop: sound.audio_type === 'bgm' && sound.loopable },
      );
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : t('audio.previewFailed'));
    }
  };

  const handleStopPreview = () => {
    audioPreviewEngine.stopPreview();
  };

  const commitRename = async (sound: SoundAsset) => {
    const next = renameDraft.trim();
    setRenamingId(null);
    if (!next || next === sound.name) return;
    try {
      const updated = await apiClient.updateSound(sound.sound_id, { name: next });
      upsertSound(updated);
      pushToast('success', t('audio.renamedToast', { name: updated.name }));
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : 'Rename error');
    }
  };

  const handleAddToTimelineAtPlayhead = (sound: SoundAsset) => {
    if (!project) return;
    const ms = frameToMs(currentFrame, project.timeline.fps);
    const preferredTrack = sound.audio_type === 'bgm' ? 'bgm' : undefined;
    addSoundToBestTrack(sound, ms, activeSceneId, preferredTrack);
    pushToast('info', `${sound.name} → ${(ms / 1000).toFixed(2)}s`);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="audio-library-panel">
      {/* Strictly separated SFX vs BGM Primary Category Tabs */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 4,
          background: 'var(--surface-base)',
          padding: 3,
          borderRadius: 6,
          border: '1px solid var(--border-subtle)',
        }}
        role="tablist"
        aria-label={t('audio.libraryTabs')}
      >
        <button
          type="button"
          role="tab"
          aria-selected={activeAudioTab === 'sfx'}
          className={`btn-xs ${activeAudioTab === 'sfx' ? 'btn-primary' : 'btn-ghost'}`}
          style={{ justifyContent: 'center', fontWeight: 600 }}
          onClick={() => switchAudioTab('sfx')}
          data-testid="audio-tab-sfx"
        >
          <Waves size={12} /> {t('audio.tabSfx')} ({sfxList.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeAudioTab === 'bgm'}
          className={`btn-xs ${activeAudioTab === 'bgm' ? 'btn-primary' : 'btn-ghost'}`}
          style={{ justifyContent: 'center', fontWeight: 600 }}
          onClick={() => switchAudioTab('bgm')}
          data-testid="audio-tab-bgm"
        >
          <Music size={12} /> {t('audio.tabBgm')} ({bgmList.length})
        </button>
      </div>

      {/* Search + Import + Starter License Manifest */}
      <div style={{ display: 'flex', gap: 5 }}>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder={
            activeAudioTab === 'bgm' ? t('audio.searchBgmPlaceholder') : t('sfx.searchPlaceholder')
          }
        />
        <button
          type="button"
          className="btn-primary btn-xs"
          onClick={() => setShowImport((v) => !v)}
          data-testid="audio-import-toggle-btn"
        >
          <Upload size={12} /> {t('sfx.importBtn')}
        </button>
        {starterManifest && (
          <button
            type="button"
            className={`btn-icon btn-xs ${showManifest ? 'active' : ''}`}
            title={t('audio.starterManifestTitle')}
            aria-label={t('audio.starterManifestTitle')}
            onClick={() => setShowManifest((v) => !v)}
            data-testid="audio-manifest-btn"
          >
            <FileCheck2 size={12} />
          </button>
        )}
      </div>

      {/* Category + Tag + Favorites Filter Row */}
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <select
          aria-label={t('sfx.category')}
          value={selectedCategory}
          onChange={(e) => setSelectedCategory(e.target.value)}
          style={{ flex: 1, minWidth: 0 }}
          data-testid="audio-category-filter"
        >
          <option value="all">{t('sfx.allCategories', { count: tabSounds.length })}</option>
          {categories.map((cat) => (
            <option key={cat.id} value={cat.id}>
              {t(`audioCat.${cat.id}`) !== `audioCat.${cat.id}` ? t(`audioCat.${cat.id}`) : cat.label}
            </option>
          ))}
        </select>

        <select
          aria-label={t('audio.filterByTag')}
          value={selectedTag}
          onChange={(e) => setSelectedTag(e.target.value)}
          style={{ width: 92 }}
          data-testid="audio-tag-filter"
        >
          <option value="all">{t('audio.allTags')}</option>
          {availableTags.map((tg) => (
            <option key={tg} value={tg}>
              #{tg}
            </option>
          ))}
        </select>

        <button
          type="button"
          className={`btn-icon btn-xs ${favoritesOnly ? 'active' : ''}`}
          title={t('sfx.favoritesOnly')}
          aria-label={t('sfx.favoritesOnly')}
          onClick={() => setFavoritesOnly((v) => !v)}
          data-testid="audio-favorites-filter"
        >
          <Star
            size={12}
            fill={favoritesOnly ? 'var(--warning)' : 'none'}
            color={favoritesOnly ? 'var(--warning)' : 'currentColor'}
          />
        </button>
      </div>

      {/* Preview Volume + Active Transport Stop */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-secondary)' }}>
        <Volume2 size={13} />
        <span>{t('sfx.previewVol')}</span>
        <input
          type="range"
          min={0}
          max={1.5}
          step={0.05}
          value={previewVolume}
          onChange={(e) => {
            const v = Number(e.target.value);
            setPreviewVolume(v);
            audioPreviewEngine.setPreviewVolume(v);
          }}
          style={{ flex: 1 }}
        />
        <span className="mono" style={{ width: 32, textAlign: 'right', fontSize: 10 }}>
          {Math.round(previewVolume * 100)}%
        </span>
        {previewState.status !== 'idle' && (
          <button
            type="button"
            className="btn-xs btn-danger"
            onClick={handleStopPreview}
            title={t('transport.stop')}
            data-testid="audio-stop-preview-btn"
          >
            <Square size={10} fill="currentColor" />
          </button>
        )}
      </div>

      {/* Starter Pack CC0 License Manifest Info Drawer */}
      {showManifest && starterManifest && (
        <div
          className="inspector-section"
          style={{ fontSize: 11, gap: 4 }}
          data-testid="audio-manifest-drawer"
        >
          <div className="inspector-section-title">
            <span>{t('audio.starterManifestTitle')}</span>
            <span className="tag-pill verified">{starterManifest.license}</span>
          </div>
          <div style={{ color: 'var(--text-secondary)', lineHeight: 1.4 }}>
            {starterManifest.license_notice}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
            {t('audio.manifestSummary', {
              sfx: starterManifest.sfx_count ?? sfxList.filter((s) => s.is_bundled).length,
              bgm: starterManifest.bgm_count ?? bgmList.filter((s) => s.is_bundled).length,
              version: starterManifest.version,
            })}
          </div>
        </div>
      )}

      {/* Import Form */}
      {showImport && (
        <div className="inspector-section" data-testid="audio-import-form">
          <div className="inspector-section-title">
            {activeAudioTab === 'bgm' ? t('audio.importBgmSection') : t('sfx.importSection')}
          </div>
          <div className="field-row">
            <label className="field-label">{t('sfx.displayNameOpt')}</label>
            <input
              value={impName}
              onChange={(e) => setImpName(e.target.value)}
              placeholder={t('sfx.defaultFilename')}
            />
          </div>
          <div className="field-grid">
            <div className="field-row">
              <label className="field-label">{t('sfx.category')}</label>
              <select
                value={impCategory}
                onChange={(e) => setImpCategory(e.target.value as SoundCategory)}
              >
                {categories.map((cat) => (
                  <option key={cat.id} value={cat.id}>
                    {t(`audioCat.${cat.id}`) !== `audioCat.${cat.id}` ? t(`audioCat.${cat.id}`) : cat.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field-row">
              <label className="field-label">{t('assets.tagsComma')}</label>
              <input
                value={impTags}
                onChange={(e) => setImpTags(e.target.value)}
                placeholder={activeAudioTab === 'bgm' ? 'loop, piano, calm' : 'walking, soft'}
              />
            </div>
          </div>
          <div className="field-grid">
            <div className="field-row">
              <label className="field-label">{t('sfx.licenseSource')}</label>
              <select
                value={impLicenseSource}
                onChange={(e) => setImpLicenseSource(e.target.value as LicenseSource)}
              >
                <option value="user_imported">User Imported</option>
                <option value="cc0">CC0 (Public Domain)</option>
                <option value="cc_by">CC-BY</option>
                <option value="royalty_free">Royalty-Free</option>
                <option value="custom">Custom</option>
              </select>
            </div>
            <div className="field-row">
              <label className="field-label">{t('sfx.licenseUsage')}</label>
              <select
                value={impLicenseUsage}
                onChange={(e) => setImpLicenseUsage(e.target.value as LicenseUsage)}
              >
                <option value="verified">Verified</option>
                <option value="unverified">Unverified</option>
              </select>
            </div>
          </div>
          <div className="field-grid">
            <div className="field-row">
              <label className="field-label">{t('sfx.licenseAttribution')}</label>
              <input
                value={impAttribution}
                onChange={(e) => setImpAttribution(e.target.value)}
              />
            </div>
            <div className="field-row">
              <label className="field-label">{t('audio.sourceOrigin')}</label>
              <input
                value={impOriginSource}
                onChange={(e) => setImpOriginSource(e.target.value)}
                placeholder="Freesound / Own Studio"
              />
            </div>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-secondary)' }}>
            <input
              type="checkbox"
              checked={impLoopable}
              onChange={(e) => setImpLoopable(e.target.checked)}
            />
            <Repeat size={11} /> {t('audio.loopableAsset')}
          </label>
          <input
            ref={fileRef}
            type="file"
            accept=".wav,.mp3,.flac,.ogg,.m4a,.aac,audio/*"
            style={{ display: 'none' }}
            onChange={handleImportFile}
          />
          <button
            type="button"
            className="btn-primary"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
          >
            <Upload size={13} /> {uploading ? t('sfx.analyzing') : t('sfx.chooseAudio')}
          </button>
        </div>
      )}

      <input
        ref={replaceRef}
        type="file"
        accept=".wav,.mp3,.flac,.ogg,.m4a,.aac,audio/*"
        style={{ display: 'none' }}
        onChange={handleReplaceFile}
      />

      {/* Audio Cards */}
      {filtered.length === 0 ? (
        <EmptyState
          title={activeAudioTab === 'bgm' ? t('audio.emptyBgmTitle') : t('sfx.emptyTitle')}
          description={activeAudioTab === 'bgm' ? t('audio.emptyBgmDesc') : t('sfx.emptyDesc')}
          action={
            <button type="button" className="btn-primary btn-xs" onClick={() => setShowImport(true)}>
              <Upload size={12} /> {t('sfx.importAudio')}
            </button>
          }
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {filtered.map((item) => {
            const isCurrent = previewState.soundId === item.sound_id;
            const isPlayingThis = isCurrent && previewState.status === 'playing';
            const isPausedThis = isCurrent && previewState.status === 'paused';
            const catLabel =
              t(`audioCat.${item.category}`) !== `audioCat.${item.category}`
                ? t(`audioCat.${item.category}`)
                : item.category;

            return (
              <div
                key={item.sound_id}
                className="list-card"
                draggable
                data-sound-id={item.sound_id}
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/x-amcs-sound-id', item.sound_id);
                  e.dataTransfer.setData('application/x-amcs-audio-type', item.audio_type ?? 'sfx');
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                style={{
                  cursor: 'grab',
                  borderColor: isPlayingThis
                    ? 'var(--accent)'
                    : isPausedThis
                      ? 'var(--warning)'
                      : undefined,
                }}
                title={t('sfx.dragHint')}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0, flex: 1 }}>
                    <button
                      type="button"
                      className={`btn-icon btn-xs ${isPlayingThis ? 'btn-primary' : ''}`}
                      onClick={() => void handleTogglePlayPause(item)}
                      title={isPlayingThis ? t('transport.pause') : t('transport.play')}
                      aria-label={isPlayingThis ? t('transport.pause') : t('transport.play')}
                    >
                      {isPlayingThis ? <Pause size={10} /> : <Play size={10} />}
                    </button>
                    {(isPlayingThis || isPausedThis) && (
                      <button
                        type="button"
                        className="btn-ghost btn-icon btn-xs"
                        onClick={handleStopPreview}
                        title={t('transport.stop')}
                        aria-label={t('transport.stop')}
                      >
                        <Square size={9} fill="currentColor" />
                      </button>
                    )}

                    {renamingId === item.sound_id ? (
                      <input
                        autoFocus
                        value={renameDraft}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onBlur={() => void commitRename(item)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void commitRename(item);
                          if (e.key === 'Escape') setRenamingId(null);
                        }}
                        style={{ flex: 1, minWidth: 0, fontSize: 11, padding: '1px 5px' }}
                      />
                    ) : (
                      <span
                        style={{
                          fontWeight: 600,
                          fontSize: 11.5,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          cursor: 'text',
                        }}
                        onDoubleClick={() => {
                          setRenamingId(item.sound_id);
                          setRenameDraft(item.name);
                        }}
                      >
                        {item.name}
                      </span>
                    )}
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0 }}>
                    <button
                      type="button"
                      className="btn-ghost btn-icon btn-xs"
                      title={t('audio.toggleFavorite')}
                      aria-label={t('audio.toggleFavorite')}
                      onClick={async () => {
                        const updated = await apiClient.updateSound(item.sound_id, {
                          is_favorite: !item.is_favorite,
                        });
                        upsertSound(updated);
                      }}
                    >
                      <Star
                        size={11}
                        fill={item.is_favorite ? 'var(--warning)' : 'none'}
                        color={item.is_favorite ? 'var(--warning)' : 'var(--text-muted)'}
                      />
                    </button>
                    <button
                      type="button"
                      className="btn-ghost btn-icon btn-xs"
                      title={t('chars.rename')}
                      aria-label={t('chars.rename')}
                      onClick={() => {
                        setRenamingId(item.sound_id);
                        setRenameDraft(item.name);
                      }}
                    >
                      <Pencil size={10} />
                    </button>
                    <button
                      type="button"
                      className="btn-ghost btn-icon btn-xs"
                      title={t('audio.replaceFile')}
                      aria-label={t('audio.replaceFile')}
                      onClick={() => {
                        setReplaceTargetId(item.sound_id);
                        replaceRef.current?.click();
                      }}
                    >
                      <RefreshCw size={10} />
                    </button>
                    <button
                      type="button"
                      className="btn-ghost btn-icon btn-xs"
                      title={t('common.delete')}
                      aria-label={t('common.delete')}
                      onClick={async () => {
                        audioPreviewEngine.invalidateSound(item.sound_id);
                        await apiClient.deleteSound(item.sound_id);
                        removeSound(item.sound_id);
                      }}
                    >
                      <Trash2 size={10} />
                    </button>
                  </div>
                </div>

                <WaveformCanvas
                  peaks={item.waveform_peaks}
                  height={22}
                  color={item.audio_type === 'bgm' ? '#818cf8' : '#34d399'}
                  background="var(--surface-base)"
                />

                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
                  <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', alignItems: 'center', minWidth: 0 }}>
                    <span className="tag-pill">{catLabel}</span>
                    <span className="tag-pill mono">{formatAudioDuration(item.duration_ms)}</span>
                    <span className="tag-pill mono" style={{ opacity: 0.78 }}>
                      {item.codec.replace('pcm_s16le', 'WAV')}
                    </span>
                    {item.loopable && (
                      <span className="tag-pill" title={t('audio.loopableAsset')}>
                        <Repeat size={8} />
                      </span>
                    )}
                    <span
                      className={`tag-pill ${item.license.usage === 'verified' ? 'verified' : 'warning'}`}
                      title={
                        [item.license.origin_source, item.license.attribution, item.license.notes]
                          .filter(Boolean)
                          .join(' — ') || item.license.source
                      }
                    >
                      {item.is_bundled ? 'CC0' : item.license.source}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn-xs"
                    disabled={!project}
                    onClick={() => handleAddToTimelineAtPlayhead(item)}
                    data-testid="audio-add-timeline-btn"
                  >
                    <Plus size={10} /> {t('sfx.addTimeline')}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
