import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Mic,
  Pause,
  Play,
  RefreshCw,
  Save,
  Square,
  Trash2,
  Volume2,
} from 'lucide-react';
import { EmptyState, ErrorBanner, formatTimecode, WaveformCanvas } from '@/components/common/CommonUI';
import { F5TTSConfigSection } from '@/components/sidebar/F5TTSConfigSection';
import { SliderWithInput } from '@/components/ui/PropertyControls';
import { useI18n } from '@/i18n/useLocaleStore';
import { useJobStore } from '@/stores/useJobStore';
import { useLibraryStore } from '@/stores/useLibraryStore';
import { useProjectStore } from '@/stores/useProjectStore';
import { useVoiceStore } from '@/stores/useVoiceStore';
import type { VoiceAudioAsset, VoiceProviderInfo } from '@/types/models';

export function ProviderKindBadge({
  provider,
}: {
  provider: Pick<VoiceProviderInfo, 'provider_kind' | 'is_mock' | 'is_configured'>;
}) {
  const { t } = useI18n();
  if (provider.is_mock || provider.provider_kind === 'dev_mock') {
    return (
      <span className="badge warning" style={{ fontSize: 9, fontWeight: 700 }}>
        {t('voice.mockBadge')}
      </span>
    );
  }
  if (!provider.is_configured) {
    return (
      <span className="badge danger" style={{ fontSize: 9, fontWeight: 700 }}>
        {t('voice.unconfiguredBadge')}
      </span>
    );
  }
  if (provider.provider_kind === 'local_os_tts') {
    return (
      <span className="badge" style={{ fontSize: 9, color: '#2dd4bf', borderColor: '#2dd4bf44' }}>
        {t('voice.localOsBadge')}
      </span>
    );
  }
  return (
    <span className="badge accent" style={{ fontSize: 9, fontWeight: 700 }}>
      {t('voice.aiBadge')}
    </span>
  );
}

export function VoicePanel({
  preselectedCharacterId,
}: {
  preselectedCharacterId?: string | null;
}) {
  const { t } = useI18n();
  const project = useProjectStore((s) => s.project);
  const characters = useLibraryStore((s) => s.characters);
  const providers = useVoiceStore((s) => s.providers);
  const profiles = useVoiceStore((s) => s.profiles);
  const loading = useVoiceStore((s) => s.loading);
  const error = useVoiceStore((s) => s.error);
  const generatingKeys = useVoiceStore((s) => s.generatingKeys);
  const entryErrors = useVoiceStore((s) => s.entryErrors);
  const playingAudioId = useVoiceStore((s) => s.playingAudioId);
  const isAudioPaused = useVoiceStore((s) => s.isAudioPaused);
  const refreshAll = useVoiceStore((s) => s.refreshAll);
  const createProfile = useVoiceStore((s) => s.createProfile);
  const updateProfile = useVoiceStore((s) => s.updateProfile);
  const assignCharacterVoice = useVoiceStore((s) => s.assignCharacterVoice);
  const generateVoice = useVoiceStore((s) => s.generateVoice);
  const playAudioAsset = useVoiceStore((s) => s.playAudioAsset);
  const pauseAudio = useVoiceStore((s) => s.pauseAudio);
  const stopAudio = useVoiceStore((s) => s.stopAudio);
  const pushToast = useJobStore((s) => s.pushToast);

  const [selectedCharId, setSelectedCharId] = useState<string>('');
  const [providerId, setProviderId] = useState<string>('');
  const [voiceId, setVoiceId] = useState<string>('');
  const [settings, setSettings] = useState<Record<string, number | string>>({});
  const [saving, setSaving] = useState(false);
  const [previewAudio, setPreviewAudio] = useState<VoiceAudioAsset | null>(null);

  useEffect(() => {
    if (providers.length === 0 && !loading) {
      void refreshAll();
    }
  }, [providers.length, loading]);

  // Sync character focus when Script Editor selects a dialogue line
  useEffect(() => {
    if (preselectedCharacterId && characters.some((c) => c.character_id === preselectedCharacterId)) {
      setSelectedCharId(preselectedCharacterId);
    } else if (!selectedCharId && characters.length > 0) {
      setSelectedCharId(characters[0].character_id);
    }
  }, [preselectedCharacterId, characters]);

  const selectedCharacter = useMemo(
    () => characters.find((c) => c.character_id === selectedCharId) ?? null,
    [characters, selectedCharId],
  );

  const assignedProfile = useMemo(
    () =>
      selectedCharacter?.voice_profile_id
        ? profiles.find((p) => p.voice_profile_id === selectedCharacter.voice_profile_id) ?? null
        : null,
    [selectedCharacter, profiles],
  );

  const defaultProvider = useMemo(
    () =>
      providers.find((p) => p.is_configured && !p.is_mock) ??
      providers.find((p) => p.is_configured) ??
      providers[0] ??
      null,
    [providers],
  );

  // Hydrate form from assigned profile when switching character
  useEffect(() => {
    setPreviewAudio(null);
    if (assignedProfile) {
      const prov = providers.find((p) => p.provider_id === assignedProfile.provider_id) ?? defaultProvider;
      setProviderId(prov?.provider_id ?? assignedProfile.provider_id);
      setVoiceId(assignedProfile.provider_voice_id);
      const defaults: Record<string, number | string> = {};
      for (const spec of prov?.supported_settings ?? []) {
        defaults[spec.key] = assignedProfile.settings[spec.key] ?? spec.default;
      }
      setSettings(defaults);
    } else if (defaultProvider) {
      setProviderId(defaultProvider.provider_id);
      setVoiceId(defaultProvider.voices[0]?.voice_id ?? '');
      const defaults: Record<string, number | string> = {};
      for (const spec of defaultProvider.supported_settings) {
        defaults[spec.key] = spec.default;
      }
      setSettings(defaults);
    }
  }, [selectedCharId, assignedProfile?.voice_profile_id, defaultProvider?.provider_id]);

  const selectedProvider = useMemo(
    () => providers.find((p) => p.provider_id === providerId) ?? defaultProvider,
    [providers, providerId, defaultProvider],
  );

  const handleProviderChange = (nextProviderId: string) => {
    setProviderId(nextProviderId);
    const nextProv = providers.find((p) => p.provider_id === nextProviderId);
    if (nextProv) {
      setVoiceId(nextProv.voices[0]?.voice_id ?? '');
      const defaults: Record<string, number | string> = {};
      for (const spec of nextProv.supported_settings) {
        defaults[spec.key] = spec.default;
      }
      setSettings(defaults);
    }
  };

  const selectedVoiceOption = useMemo(
    () =>
      selectedProvider?.voices.find((v) => v.voice_id === voiceId) ??
      selectedProvider?.voices[0] ??
      null,
    [selectedProvider, voiceId],
  );

  const handleSaveAssignment = async () => {
    if (!selectedCharacter || !selectedProvider) return;
    setSaving(true);
    try {
      const payload = {
        name: `${selectedCharacter.name} — ${selectedVoiceOption?.name ?? selectedProvider.display_name}`,
        provider_id: selectedProvider.provider_id,
        provider_voice_id: selectedVoiceOption?.voice_id ?? voiceId,
        language: selectedVoiceOption?.language ?? selectedProvider.supported_languages[0] ?? 'vi-VN',
        settings,
      };
      const profile = assignedProfile
        ? await updateProfile(assignedProfile.voice_profile_id, payload)
        : await createProfile(payload);
      await assignCharacterVoice(selectedCharacter.character_id, profile.voice_profile_id);
      pushToast('success', t('voice.savedToast', { name: selectedCharacter.name }));
    } catch (err) {
      pushToast(
        'error',
        t('voice.generateFailedToast', {
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      setSaving(false);
    }
  };

  const handleClearAssignment = async () => {
    if (!selectedCharacter) return;
    setSaving(true);
    try {
      await assignCharacterVoice(selectedCharacter.character_id, null);
      pushToast('info', t('voice.clearedToast', { name: selectedCharacter.name }));
    } finally {
      setSaving(false);
    }
  };

  const previewKey = `preview:${selectedCharacter?.character_id ?? 'global'}`;
  const isPreviewGenerating = Boolean(generatingKeys[previewKey]);
  const previewError = entryErrors[previewKey];

  const handlePreviewVoice = async () => {
    if (!project || !selectedProvider) return;
    try {
      const audio = await generateVoice(previewKey, {
        project_id: project.meta.project_id,
        text: t('voice.sampleText'),
        character_id: selectedCharacter?.character_id ?? null,
        provider_id: selectedProvider.provider_id,
        provider_voice_id: selectedVoiceOption?.voice_id ?? voiceId,
        language: selectedVoiceOption?.language ?? selectedProvider.supported_languages[0] ?? 'vi-VN',
        settings,
      });
      if (audio) {
        setPreviewAudio(audio);
        playAudioAsset(project.meta.project_id, audio.audio_asset_id);
      }
    } catch (err) {
      pushToast(
        'error',
        t('voice.generateFailedToast', {
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {error && <ErrorBanner message={error} onRetry={() => void refreshAll()} />}

      {/* Character Voice Assignment Section */}
      <div className="inspector-section" style={{ borderBottom: 'none', paddingBottom: 0 }}>
        <div className="section-title">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <Mic size={12} /> {t('voice.assignTitle')}
          </span>
          <button
            type="button"
            className="btn-ghost btn-icon btn-xs"
            onClick={() => void refreshAll()}
            title={t('common.refresh')}
            aria-label={t('common.refresh')}
          >
            <RefreshCw size={11} className={loading ? 'spin' : ''} />
          </button>
        </div>

        {characters.length === 0 ? (
          <EmptyState
            title={t('voice.assignTitle')}
            description={t('voice.noCharactersYet')}
          />
        ) : (
          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {/* Character Picker */}
            <div className="field-row">
              <label className="field-label" htmlFor="voice-character-select">
                {t('script.character')}
              </label>
              <select
                id="voice-character-select"
                value={selectedCharId}
                onChange={(e) => setSelectedCharId(e.target.value)}
              >
                {characters.map((ch) => (
                  <option key={ch.character_id} value={ch.character_id}>
                    {ch.name}
                    {ch.voice_profile_id ? ' ✓' : ''}
                  </option>
                ))}
              </select>
            </div>

            {selectedCharacter && (
              <>
                {/* Provider Picker */}
                <div className="field-row">
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                    <label className="field-label" htmlFor="voice-provider-select">
                      {t('voice.provider')}
                    </label>
                    {selectedProvider && <ProviderKindBadge provider={selectedProvider} />}
                  </div>
                  <select
                    id="voice-provider-select"
                    value={selectedProvider?.provider_id ?? ''}
                    onChange={(e) => handleProviderChange(e.target.value)}
                  >
                    {providers.map((p) => (
                      <option key={p.provider_id} value={p.provider_id}>
                        {p.display_name}
                        {p.is_mock
                          ? ` — ${t('voice.mockBadge')}`
                          : !p.is_configured
                            ? ` — ${t('voice.unconfiguredBadge')}`
                            : ''}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Honest Provider Notice for Dev Mock or Unconfigured Providers */}
                {selectedProvider?.is_mock && (
                  <div
                    style={{
                      padding: '6px 8px',
                      borderRadius: 'var(--radius-sm)',
                      background: 'rgba(245, 158, 11, 0.12)',
                      border: '1px solid rgba(245, 158, 11, 0.35)',
                      fontSize: 11,
                      color: '#fbbf24',
                      display: 'flex',
                      gap: 6,
                      alignItems: 'flex-start',
                    }}
                  >
                    <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                    <span>{t('voice.mockNotice')}</span>
                  </div>
                )}

                {selectedProvider && !selectedProvider.is_configured && (
                  <div
                    style={{
                      padding: '6px 8px',
                      borderRadius: 'var(--radius-sm)',
                      background: 'rgba(239, 68, 68, 0.1)',
                      border: '1px solid rgba(239, 68, 68, 0.3)',
                      fontSize: 11,
                      color: '#fca5a5',
                    }}
                  >
                    {selectedProvider.status_message}
                  </div>
                )}

                {/* Voice Picker */}
                {selectedProvider && selectedProvider.voices.length > 0 && (
                  <div className="field-row">
                    <label className="field-label" htmlFor="voice-option-select">
                      {t('voice.voiceSelect')}
                    </label>
                    <select
                      id="voice-option-select"
                      value={selectedVoiceOption?.voice_id ?? ''}
                      onChange={(e) => setVoiceId(e.target.value)}
                    >
                      {selectedProvider.voices.map((v) => (
                        <option key={v.voice_id} value={v.voice_id}>
                          {v.name} ({v.language})
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {/* ONLY Provider-Supported Settings — Never Fake Controls! */}
                {selectedProvider && selectedProvider.supported_settings.length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {selectedProvider.supported_settings.map((spec) => {
                      const val = settings[spec.key] ?? spec.default;
                      if (spec.type === 'select' && spec.options.length > 0) {
                        return (
                          <div className="field-row" key={spec.key}>
                            <label className="field-label">{spec.label}</label>
                            <select
                              value={String(val)}
                              onChange={(e) =>
                                setSettings((prev) => ({ ...prev, [spec.key]: e.target.value }))
                              }
                            >
                              {spec.options.map((opt) => (
                                <option key={opt} value={opt}>
                                  {opt}
                                </option>
                              ))}
                            </select>
                          </div>
                        );
                      }
                      const numVal = typeof val === 'number' ? val : Number(spec.default) || 1;
                      return (
                        <SliderWithInput
                          key={spec.key}
                          label={spec.label}
                          value={numVal}
                          min={spec.min ?? 0.5}
                          max={spec.max ?? 2.0}
                          step={spec.step ?? 0.05}
                          precision={2}
                          unit="x"
                          onChange={(v) =>
                            setSettings((prev) => ({ ...prev, [spec.key]: v }))
                          }
                        />
                      );
                    })}
                  </div>
                ) : (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {t('voice.noSettings')}
                  </div>
                )}

                {/* Actions: Preview & Save Assignment */}
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn-xs"
                    style={{ flex: 1, justifyContent: 'center' }}
                    disabled={!project || !selectedProvider || isPreviewGenerating}
                    title={!project ? t('voice.openProjectFirst') : t('voice.previewVoice')}
                    onClick={() => void handlePreviewVoice()}
                  >
                    {isPreviewGenerating ? (
                      <Loader2 size={11} className="spin" />
                    ) : (
                      <Volume2 size={11} />
                    )}
                    {t('voice.previewVoice')}
                  </button>
                  <button
                    type="button"
                    className="btn-xs btn-primary"
                    style={{ flex: 1, justifyContent: 'center' }}
                    disabled={saving || !selectedProvider}
                    onClick={() => void handleSaveAssignment()}
                  >
                    <Save size={11} /> {t('voice.saveAssignment')}
                  </button>
                  {assignedProfile && (
                    <button
                      type="button"
                      className="btn-xs"
                      disabled={saving}
                      title={t('voice.clearAssignment')}
                      onClick={() => void handleClearAssignment()}
                    >
                      <Trash2 size={11} />
                    </button>
                  )}
                </div>

                {previewError && <ErrorBanner message={previewError} />}

                {/* Real Preview Audio Strip */}
                {previewAudio && project && (
                  <div
                    style={{
                      padding: 8,
                      borderRadius: 'var(--radius-sm)',
                      background: 'var(--bg-elevated)',
                      border: '1px solid var(--border-subtle)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 6,
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 6,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <button
                          type="button"
                          className="btn-xs btn-icon"
                          onClick={() =>
                            playingAudioId === previewAudio.audio_asset_id && !isAudioPaused
                              ? pauseAudio()
                              : playAudioAsset(project.meta.project_id, previewAudio.audio_asset_id)
                          }
                          aria-label={
                            playingAudioId === previewAudio.audio_asset_id && !isAudioPaused
                              ? t('voice.pauseAudio')
                              : t('voice.playAudio')
                          }
                        >
                          {playingAudioId === previewAudio.audio_asset_id && !isAudioPaused ? (
                            <Pause size={11} />
                          ) : (
                            <Play size={11} />
                          )}
                        </button>
                        <button
                          type="button"
                          className="btn-xs btn-icon"
                          onClick={stopAudio}
                          aria-label={t('voice.stopAudio')}
                        >
                          <Square size={10} />
                        </button>
                        <span className="mono" style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                          {formatTimecode(previewAudio.duration_ms)}
                        </span>
                      </div>
                      <ProviderKindBadge
                        provider={{
                          provider_kind: previewAudio.provider_kind,
                          is_mock: previewAudio.is_mock,
                          is_configured: true,
                        }}
                      />
                    </div>
                    <WaveformCanvas peaks={previewAudio.waveform_peaks} height={22} color="#38bdf8" />
                  </div>
                )}

                {assignedProfile && (
                  <div
                    style={{
                      fontSize: 10,
                      color: 'var(--text-secondary)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                  >
                    <CheckCircle2 size={11} style={{ color: 'var(--success)' }} />
                    <span>{assignedProfile.name}</span>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Dedicated F5-TTS Configuration & Voice Reference Panel */}
      <F5TTSConfigSection />

      {/* Providers Overview */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div className="section-title">
          <span>{t('voice.providerSection')}</span>
        </div>
        {providers.map((prov) => (
          <div
            key={prov.provider_id}
            className="card"
            style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 4 }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 600 }}>{prov.display_name}</span>
              <ProviderKindBadge provider={prov} />
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.4 }}>
              {prov.status_message}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
