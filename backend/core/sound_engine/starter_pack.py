"""Original CC0 Bundled Starter Audio Pack (24 SFX + 10 Looping BGM).

All audio assets in this pack are 100% original procedural DSP waveforms synthesized
locally on first workspace bootstrap and released under CC0-1.0 (Public Domain).
No copyrighted audio is downloaded or embedded in source code.
"""

from __future__ import annotations

import array
import json
import math
import random
import wave
from dataclasses import dataclass
from pathlib import Path

from app.config import AppConfig
from app.logging_config import get_logger
from database.connection import connect_sqlite, sqlite_transaction
from database.library_repo import LibraryRepository
from schemas.common import utc_now_iso
from schemas.sound import AudioType, SoundAsset, SoundCategory, SoundLicense
from utils.paths import compute_sha256_bytes, to_posix_relative

logger = get_logger("starter_pack")

STARTER_PACK_VERSION = "1.0.0"
SAMPLE_RATE = 22050
TWO_PI = 2.0 * math.pi


@dataclass(frozen=True)
class StarterSpec:
    sound_id: str
    name: str
    audio_type: AudioType
    category: SoundCategory
    tags: tuple[str, ...]
    duration_s: float
    loopable: bool
    default_volume: float
    fade_in_ms: int
    fade_out_ms: int
    recipe: str


STARTER_SPECS: tuple[StarterSpec, ...] = (
    # --- 24 SFX (one for every SFX category) ---
    StarterSpec("starter_sfx_footsteps", "Soft Wood Footstep", "sfx", "footsteps", ("step", "wood", "indoor"), 0.35, False, 0.85, 0, 15, "footstep"),
    StarterSpec("starter_sfx_walking", "Steady Walking Steps", "sfx", "walking", ("walk", "cadence", "steps"), 1.6, True, 0.8, 10, 20, "walking"),
    StarterSpec("starter_sfx_running", "Fast Sprint Footsteps", "sfx", "running", ("run", "sprint", "chase"), 1.2, True, 0.85, 10, 20, "running"),
    StarterSpec("starter_sfx_punch", "Comic Punch Hit", "sfx", "punch", ("fight", "hit", "action"), 0.38, False, 0.9, 0, 20, "punch"),
    StarterSpec("starter_sfx_impact", "Heavy Thud Impact", "sfx", "impact", ("slam", "drop", "heavy"), 0.55, False, 0.9, 0, 30, "impact"),
    StarterSpec("starter_sfx_doors", "Wooden Door Shut", "sfx", "doors", ("door", "latch", "room"), 0.65, False, 0.85, 0, 25, "door"),
    StarterSpec("starter_sfx_objects", "Cup Set On Table", "sfx", "objects", ("table", "prop", "tap"), 0.32, False, 0.8, 0, 15, "object_tap"),
    StarterSpec("starter_sfx_paper", "Crisp Page Flip", "sfx", "paper", ("book", "comic", "page"), 0.42, False, 0.78, 5, 25, "paper"),
    StarterSpec("starter_sfx_glass", "Bright Glass Clink", "sfx", "glass", ("crystal", "chime", "clink"), 0.75, False, 0.8, 0, 40, "glass"),
    StarterSpec("starter_sfx_wind", "Gentle Wind Breeze", "sfx", "wind", ("air", "outdoor", "ambient"), 2.4, True, 0.65, 120, 120, "wind"),
    StarterSpec("starter_sfx_rain", "Soft Rain Bed", "sfx", "rain", ("weather", "storm", "ambient"), 2.4, True, 0.62, 120, 120, "rain"),
    StarterSpec("starter_sfx_thunder", "Distant Rolling Thunder", "sfx", "thunder", ("storm", "dramatic", "rumble"), 2.2, False, 0.88, 30, 250, "thunder"),
    StarterSpec("starter_sfx_fire", "Warm Campfire Crackle", "sfx", "fire", ("flame", "hearth", "ambient"), 2.2, True, 0.65, 100, 100, "fire"),
    StarterSpec("starter_sfx_water", "Water Drop & Plop", "sfx", "water", ("drop", "liquid", "splash"), 0.48, False, 0.82, 0, 30, "water"),
    StarterSpec("starter_sfx_crowd", "Soft Room Murmur", "sfx", "crowd", ("cafe", "people", "ambient"), 2.4, True, 0.55, 150, 150, "crowd"),
    StarterSpec("starter_sfx_animals", "Morning Bird Chirp", "sfx", "animals", ("bird", "nature", "morning"), 0.68, False, 0.8, 0, 30, "bird"),
    StarterSpec("starter_sfx_vehicles", "Vehicle Pass-By", "sfx", "vehicles", ("car", "traffic", "street"), 1.6, False, 0.78, 80, 120, "vehicle"),
    StarterSpec("starter_sfx_magic", "Arcane Sparkle Chime", "sfx", "magic", ("spell", "glow", "fantasy"), 1.15, False, 0.82, 10, 100, "magic"),
    StarterSpec("starter_sfx_horror", "Eerie Hollow Drone", "sfx", "horror", ("scary", "creepy", "dark"), 1.8, True, 0.72, 100, 120, "horror_sfx"),
    StarterSpec("starter_sfx_suspense", "Tension Sub-Pulse", "sfx", "suspense", ("heartbeat", "mystery", "thriller"), 1.4, True, 0.82, 20, 60, "suspense_sfx"),
    StarterSpec("starter_sfx_transitions", "Fast Panel Whoosh", "sfx", "transitions", ("swipe", "cut", "whoosh"), 0.52, False, 0.84, 15, 45, "whoosh"),
    StarterSpec("starter_sfx_ui", "Crisp UI Pop Chime", "sfx", "ui", ("click", "notify", "bubble"), 0.28, False, 0.8, 0, 20, "ui_pop"),
    StarterSpec("starter_sfx_comedy", "Cartoon Spring Boing", "sfx", "comedy", ("funny", "boing", "bounce"), 0.62, False, 0.85, 0, 35, "boing"),
    StarterSpec("starter_sfx_cinematic", "Trailer Impact Boom", "sfx", "cinematic", ("epic", "boom", "trailer"), 1.55, False, 0.9, 10, 200, "cinematic_hit"),
    # --- 10 Seamless Looping BGM Tracks ---
    StarterSpec("starter_bgm_cinematic", "Heroic Horizon Loop", "bgm", "cinematic", ("epic", "loop", "theme"), 3.2, True, 0.55, 180, 240, "bgm_cinematic"),
    StarterSpec("starter_bgm_emotional", "Warm Memory Piano Loop", "bgm", "emotional", ("piano", "heartfelt", "loop"), 3.2, True, 0.52, 200, 260, "bgm_emotional"),
    StarterSpec("starter_bgm_sad", "Rainy Window Minor Loop", "bgm", "sad", ("melancholy", "minor", "loop"), 3.2, True, 0.5, 220, 280, "bgm_sad"),
    StarterSpec("starter_bgm_happy", "Sunny Day Bounce Loop", "bgm", "happy", ("upbeat", "bright", "loop"), 3.0, True, 0.52, 120, 180, "bgm_happy"),
    StarterSpec("starter_bgm_romantic", "Starlight Waltz Loop", "bgm", "romantic", ("gentle", "warm", "loop"), 3.2, True, 0.5, 200, 260, "bgm_romantic"),
    StarterSpec("starter_bgm_suspense", "Midnight Mystery Pulse", "bgm", "suspense", ("detective", "tension", "loop"), 3.0, True, 0.52, 150, 200, "bgm_suspense"),
    StarterSpec("starter_bgm_horror", "Shadow Corridor Ambience", "bgm", "horror", ("dark", "eerie", "loop"), 3.2, True, 0.48, 250, 300, "bgm_horror"),
    StarterSpec("starter_bgm_action", "Chase Tempo Synth Loop", "bgm", "action", ("fast", "battle", "loop"), 3.0, True, 0.56, 80, 160, "bgm_action"),
    StarterSpec("starter_bgm_calm", "Morning Breeze Ambient", "bgm", "calm", ("chill", "peaceful", "loop"), 3.2, True, 0.48, 250, 300, "bgm_calm"),
    StarterSpec("starter_bgm_fantasy", "Enchanted Grove Arpeggio", "bgm", "fantasy", ("harp", "magic", "loop"), 3.2, True, 0.52, 180, 240, "bgm_fantasy"),
)


def _midi_to_hz(note: float) -> float:
    return 440.0 * (2.0 ** ((note - 69.0) / 12.0))


def _lowpass(samples: list[float], alpha: float) -> list[float]:
    out = [0.0] * len(samples)
    y = 0.0
    for i, x in enumerate(samples):
        y = y + alpha * (x - y)
        out[i] = y
    return out


def _highpass(samples: list[float], alpha: float) -> list[float]:
    out = [0.0] * len(samples)
    y = 0.0
    prev_x = 0.0
    for i, x in enumerate(samples):
        y = alpha * (y + x - prev_x)
        prev_x = x
        out[i] = y
    return out


def _normalize(samples: list[float], peak: float = 0.86) -> list[float]:
    mx = max((abs(v) for v in samples), default=0.0)
    if mx < 1e-6:
        return samples
    scale = peak / mx
    return [max(-0.98, min(0.98, v * scale)) for v in samples]


def _make_seamless_loop(samples: list[float], fade_samples: int = 880) -> list[float]:
    n = len(samples)
    f = min(fade_samples, n // 6)
    if f <= 2:
        return samples
    out = list(samples)
    for i in range(f):
        w = i / float(f)
        out[i] = out[i] * w + samples[n - f + i] * (1.0 - w)
    return out[: n - f]


def _synthesize_bgm_progression(
    chords: list[tuple[int, ...]],
    duration_s: float,
    bpm_arp: float,
    wave_mode: str,
    bass_gain: float,
    rng: random.Random,
) -> list[float]:
    n = int(SAMPLE_RATE * duration_s)
    buf = [0.0] * n
    chord_len = n / float(len(chords))
    arp_step_s = 60.0 / bpm_arp / 2.0

    for i in range(n):
        t = i / float(SAMPLE_RATE)
        c_idx = min(len(chords) - 1, int(i / chord_len))
        local_frac = (i - c_idx * chord_len) / chord_len
        chord = chords[c_idx]

        # Warm chord pad envelope per bar
        pad_env = math.sin(min(1.0, local_frac / 0.14) * math.pi * 0.5) * math.sin(
            min(1.0, (1.0 - local_frac) / 0.16) * math.pi * 0.5
        )
        pad = 0.0
        for note in chord:
            hz = _midi_to_hz(note)
            if wave_mode == "dark":
                pad += 0.5 * math.sin(TWO_PI * hz * t) + 0.18 * math.sin(TWO_PI * hz * 1.503 * t)
            elif wave_mode == "action":
                pad += 0.42 * math.sin(TWO_PI * hz * t) + 0.25 * math.sin(TWO_PI * hz * 2.0 * t)
            else:
                pad += 0.55 * math.sin(TWO_PI * hz * t) + 0.16 * math.sin(TWO_PI * hz * 2.0 * t)
        pad = (pad / max(1, len(chord))) * pad_env * 0.48

        # Melodic arpeggio note
        arp_pos = t / arp_step_s
        arp_idx = int(arp_pos)
        arp_phase = arp_pos - arp_idx
        arp_note = chord[arp_idx % len(chord)] + 12
        arp_hz = _midi_to_hz(arp_note)
        arp_env = math.exp(-arp_phase * (5.2 if wave_mode != "calm" else 3.2)) * min(1.0, arp_phase * 28.0)
        arp = (0.65 * math.sin(TWO_PI * arp_hz * t) + 0.22 * math.sin(TWO_PI * arp_hz * 2.0 * t)) * arp_env * 0.34

        # Subtle root bass pulse
        bass_hz = _midi_to_hz(chord[0] - 12)
        beat_phase = (t * (bpm_arp / 60.0)) % 1.0
        bass_env = math.exp(-beat_phase * 2.4) if wave_mode in ("action", "suspense", "happy") else 0.7
        bass = math.sin(TWO_PI * bass_hz * t) * bass_env * bass_gain

        # Light hi-hat/pulse for action & happy
        perc = 0.0
        if wave_mode in ("action", "happy") and beat_phase < 0.06:
            perc = (rng.uniform(-1.0, 1.0)) * (1.0 - beat_phase / 0.06) * 0.08

        buf[i] = pad + arp + bass + perc

    buf = _lowpass(buf, 0.55 if wave_mode in ("calm", "sad", "romantic", "horror") else 0.78)
    # Apply subtle loop crossfade at ends while keeping exact duration
    fade = min(440, n // 12)
    for i in range(fade):
        w = i / float(fade)
        buf[i] *= w
        buf[n - 1 - i] *= w
    return _normalize(buf, peak=0.72)


def _synthesize_recipe(spec: StarterSpec) -> list[float]:
    rng = random.Random(hash(spec.sound_id) & 0xFFFFFFFF)
    n = max(64, int(SAMPLE_RATE * spec.duration_s))
    r = spec.recipe

    # --- BGM Recipes ---
    if r == "bgm_cinematic":
        return _synthesize_bgm_progression([(57, 60, 64), (53, 57, 60), (48, 52, 55), (55, 59, 62)], spec.duration_s, 100.0, "warm", 0.28, rng)
    if r == "bgm_emotional":
        return _synthesize_bgm_progression([(60, 64, 67), (55, 59, 62), (57, 60, 64), (53, 57, 60)], spec.duration_s, 84.0, "warm", 0.2, rng)
    if r == "bgm_sad":
        return _synthesize_bgm_progression([(57, 60, 64), (53, 57, 60), (50, 53, 57), (52, 56, 59)], spec.duration_s, 72.0, "calm", 0.22, rng)
    if r == "bgm_happy":
        return _synthesize_bgm_progression([(60, 64, 67, 72), (65, 69, 72), (67, 71, 74), (60, 64, 67)], spec.duration_s, 120.0, "happy", 0.22, rng)
    if r == "bgm_romantic":
        return _synthesize_bgm_progression([(65, 69, 72), (60, 64, 67), (62, 65, 69), (67, 71, 74)], spec.duration_s, 78.0, "calm", 0.18, rng)
    if r == "bgm_suspense":
        return _synthesize_bgm_progression([(50, 53, 57), (50, 53, 58), (50, 53, 57), (49, 52, 55)], spec.duration_s, 110.0, "suspense", 0.32, rng)
    if r == "bgm_horror":
        return _synthesize_bgm_progression([(45, 48, 51), (44, 47, 51), (45, 48, 51), (42, 46, 49)], spec.duration_s, 66.0, "dark", 0.34, rng)
    if r == "bgm_action":
        return _synthesize_bgm_progression([(52, 55, 59), (55, 59, 62), (57, 60, 64), (59, 62, 66)], spec.duration_s, 138.0, "action", 0.32, rng)
    if r == "bgm_calm":
        return _synthesize_bgm_progression([(60, 64, 67, 71), (65, 69, 72, 76), (62, 65, 69, 72), (60, 64, 67, 71)], spec.duration_s, 70.0, "calm", 0.16, rng)
    if r == "bgm_fantasy":
        return _synthesize_bgm_progression([(62, 65, 69, 74), (67, 70, 74), (65, 69, 72), (69, 72, 76)], spec.duration_s, 96.0, "warm", 0.18, rng)

    # --- SFX Recipes ---
    buf = [0.0] * n

    def add_step(offset_s: float, strength: float, pitch: float) -> None:
        start = int(offset_s * SAMPLE_RATE)
        dur = int(0.14 * SAMPLE_RATE)
        for j in range(dur):
            idx = start + j
            if idx >= n:
                break
            tj = j / float(SAMPLE_RATE)
            env = math.exp(-tj * 32.0)
            body = math.sin(TWO_PI * (pitch * math.exp(-tj * 9.0)) * tj)
            tap = rng.uniform(-1.0, 1.0) * math.exp(-tj * 65.0) * 0.55
            buf[idx] += (body * 0.75 + tap) * env * strength

    if r == "footstep":
        add_step(0.02, 1.0, 135.0)
        return _normalize(_lowpass(buf, 0.45))

    if r == "walking":
        for k in range(4):
            add_step(0.08 + k * 0.38, 0.9 if k % 2 == 0 else 0.75, 130.0 if k % 2 == 0 else 148.0)
        return _normalize(_lowpass(buf, 0.45))

    if r == "running":
        for k in range(5):
            add_step(0.04 + k * 0.22, 1.0 if k % 2 == 0 else 0.85, 150.0 if k % 2 == 0 else 168.0)
        return _normalize(_lowpass(buf, 0.55))

    if r == "punch":
        for i in range(n):
            t = i / float(SAMPLE_RATE)
            whoosh = rng.uniform(-1.0, 1.0) * math.exp(-((t - 0.04) ** 2) / 0.0008) * 0.55
            sub = math.sin(TWO_PI * (150.0 * math.exp(-t * 14.0) + 42.0) * t) * math.exp(-t * 13.0)
            snap = rng.uniform(-1.0, 1.0) * math.exp(-max(0.0, t - 0.045) * 48.0) * (1.0 if t >= 0.045 else 0.0) * 0.75
            buf[i] = whoosh + sub + snap
        return _normalize(_lowpass(buf, 0.55))

    if r == "impact":
        for i in range(n):
            t = i / float(SAMPLE_RATE)
            boom = math.sin(TWO_PI * (110.0 * math.exp(-t * 8.0) + 34.0) * t) * math.exp(-t * 7.5)
            crack = rng.uniform(-1.0, 1.0) * math.exp(-t * 36.0) * 0.65
            buf[i] = boom + crack
        return _normalize(_lowpass(buf, 0.42))

    if r == "door":
        # Latch click then deep wood shut
        add_step(0.04, 0.45, 420.0)
        for i in range(int(0.18 * SAMPLE_RATE), n):
            t = (i - int(0.18 * SAMPLE_RATE)) / float(SAMPLE_RATE)
            thud = math.sin(TWO_PI * (125.0 * math.exp(-t * 7.0) + 48.0) * t) * math.exp(-t * 11.0)
            wood = rng.uniform(-1.0, 1.0) * math.exp(-t * 38.0) * 0.45
            buf[i] += thud + wood
        return _normalize(_lowpass(buf, 0.46))

    if r == "object_tap":
        for i in range(n):
            t = i / float(SAMPLE_RATE)
            env = math.exp(-t * 34.0)
            buf[i] = (math.sin(TWO_PI * 680.0 * t) * 0.6 + math.sin(TWO_PI * 1240.0 * t) * 0.35 + rng.uniform(-0.3, 0.3)) * env
        return _normalize(buf)

    if r == "paper":
        noise = [rng.uniform(-1.0, 1.0) for _ in range(n)]
        hp = _highpass(noise, 0.82)
        for i in range(n):
            t = i / float(SAMPLE_RATE)
            env = math.sin(min(1.0, t / 0.08) * math.pi * 0.5) * math.exp(-max(0.0, t - 0.08) * 11.0)
            flutter = 0.7 + 0.3 * math.sin(TWO_PI * 22.0 * t)
            buf[i] = hp[i] * env * flutter
        return _normalize(buf, peak=0.78)

    if r == "glass":
        freqs = (2180.0, 3260.0, 4410.0, 5890.0)
        for i in range(n):
            t = i / float(SAMPLE_RATE)
            v = sum(math.sin(TWO_PI * f * t) * math.exp(-t * (6.0 + k * 2.2)) for k, f in enumerate(freqs))
            buf[i] = v
        return _normalize(buf, peak=0.8)

    if r == "wind":
        noise = [rng.uniform(-1.0, 1.0) for _ in range(n)]
        lp = _lowpass(_lowpass(noise, 0.09), 0.12)
        for i in range(n):
            t = i / float(SAMPLE_RATE)
            swell = 0.55 + 0.45 * math.sin(TWO_PI * (t / spec.duration_s))
            whistle = math.sin(TWO_PI * (340.0 + 70.0 * math.sin(TWO_PI * t / spec.duration_s)) * t) * 0.08 * swell
            buf[i] = lp[i] * swell + whistle
        return _normalize(_make_seamless_loop(buf), peak=0.7)

    if r == "rain":
        noise = [rng.uniform(-1.0, 1.0) for _ in range(n)]
        bed = _lowpass(_highpass(noise, 0.7), 0.35)
        for i in range(n):
            buf[i] = bed[i] * 0.65
        for _ in range(45):
            pos = rng.randint(0, max(0, n - 400))
            freq = rng.uniform(1100.0, 2600.0)
            for j in range(min(300, n - pos)):
                tj = j / float(SAMPLE_RATE)
                buf[pos + j] += math.sin(TWO_PI * freq * tj) * math.exp(-tj * 65.0) * 0.2
        return _normalize(_make_seamless_loop(buf), peak=0.68)

    if r == "thunder":
        noise = [rng.uniform(-1.0, 1.0) for _ in range(n)]
        rumble = _lowpass(_lowpass(noise, 0.06), 0.08)
        for i in range(n):
            t = i / float(SAMPLE_RATE)
            crack = rng.uniform(-1.0, 1.0) * math.exp(-t * 14.0) * 0.55
            roll = rumble[i] * (math.sin(min(1.0, t / 0.18) * math.pi * 0.5) * math.exp(-t * 1.4)) * (1.0 + 0.35 * math.sin(TWO_PI * 3.5 * t))
            sub = math.sin(TWO_PI * 46.0 * t) * math.exp(-t * 2.0) * 0.35
            buf[i] = crack + roll * 2.5 + sub
        return _normalize(buf, peak=0.88)

    if r == "fire":
        noise = [rng.uniform(-1.0, 1.0) for _ in range(n)]
        bed = _lowpass(noise, 0.14)
        for i in range(n):
            buf[i] = bed[i] * 0.55
        for _ in range(38):
            pos = rng.randint(0, max(0, n - 180))
            amp = rng.uniform(0.35, 0.9)
            for j in range(min(140, n - pos)):
                tj = j / float(SAMPLE_RATE)
                buf[pos + j] += rng.uniform(-1.0, 1.0) * math.exp(-tj * 95.0) * amp
        return _normalize(_make_seamless_loop(buf), peak=0.72)

    if r == "water":
        for i in range(n):
            t = i / float(SAMPLE_RATE)
            # Rising pitch water droplet plop
            freq = 420.0 + 1180.0 * min(1.0, t * 5.5)
            env = math.exp(-t * 14.0) * min(1.0, t * 90.0)
            buf[i] = math.sin(TWO_PI * freq * t) * env
        return _normalize(buf, peak=0.82)

    if r == "crowd":
        noise = [rng.uniform(-1.0, 1.0) for _ in range(n)]
        bed = _lowpass(_highpass(noise, 0.85), 0.22)
        for i in range(n):
            t = i / float(SAMPLE_RATE)
            mod = 0.72 + 0.18 * math.sin(TWO_PI * 1.4 * t) + 0.1 * math.sin(TWO_PI * 3.1 * t)
            buf[i] = bed[i] * mod
        return _normalize(_make_seamless_loop(buf), peak=0.65)

    if r == "bird":
        for i in range(n):
            t = i / float(SAMPLE_RATE)
            v = 0.0
            for start_s, f0, f1 in ((0.04, 2400.0, 3800.0), (0.28, 2800.0, 4200.0)):
                dt = t - start_s
                if 0.0 <= dt <= 0.18:
                    env = math.sin((dt / 0.18) * math.pi)
                    f = f0 + (f1 - f0) * math.sin((dt / 0.18) * math.pi)
                    v += math.sin(TWO_PI * f * dt) * env
            buf[i] = v
        return _normalize(buf, peak=0.8)

    if r == "vehicle":
        noise = [rng.uniform(-1.0, 1.0) for _ in range(n)]
        wind_bed = _lowpass(noise, 0.18)
        for i in range(n):
            t = i / float(SAMPLE_RATE)
            frac = t / spec.duration_s
            doppler = 1.0 + 0.35 * (1.0 - 2.0 * frac)
            env = math.sin(frac * math.pi) ** 1.3
            eng = (math.sin(TWO_PI * 95.0 * doppler * t) + 0.5 * math.sin(TWO_PI * 190.0 * doppler * t)) * 0.45
            buf[i] = (eng + wind_bed[i] * 0.65) * env
        return _normalize(buf, peak=0.82)

    if r == "magic":
        notes = (72, 76, 79, 84, 88, 91)
        for idx_n, midi in enumerate(notes):
            start = int((idx_n * 0.09) * SAMPLE_RATE)
            hz = _midi_to_hz(midi)
            for j in range(n - start):
                tj = j / float(SAMPLE_RATE)
                shimmer = 1.0 + 0.08 * math.sin(TWO_PI * 12.0 * tj)
                buf[start + j] += (math.sin(TWO_PI * hz * tj) + 0.35 * math.sin(TWO_PI * hz * 2.0 * tj)) * math.exp(-tj * 4.5) * shimmer
        return _normalize(buf, peak=0.82)

    if r == "horror_sfx":
        for i in range(n):
            t = i / float(SAMPLE_RATE)
            env = math.sin(min(1.0, t / 0.3) * math.pi * 0.5) * math.sin(min(1.0, (spec.duration_s - t) / 0.3) * math.pi * 0.5)
            d1 = math.sin(TWO_PI * 65.4 * t)
            d2 = math.sin(TWO_PI * 69.3 * t)
            d3 = math.sin(TWO_PI * 311.0 * t) * 0.18
            buf[i] = (d1 + d2 + d3) * env
        return _normalize(buf, peak=0.76)

    if r == "suspense_sfx":
        for i in range(n):
            t = i / float(SAMPLE_RATE)
            v = 0.0
            for pulse_t in (0.05, 0.32, 0.78, 1.05):
                dt = t - pulse_t
                if dt >= 0.0:
                    v += math.sin(TWO_PI * (58.0 * math.exp(-dt * 4.0) + 32.0) * dt) * math.exp(-dt * 11.0)
            buf[i] = v
        return _normalize(buf, peak=0.84)

    if r == "whoosh":
        noise = [rng.uniform(-1.0, 1.0) for _ in range(n)]
        bp = _lowpass(_highpass(noise, 0.85), 0.32)
        for i in range(n):
            t = i / float(SAMPLE_RATE)
            frac = t / spec.duration_s
            env = math.sin(frac * math.pi) ** 1.6
            sweep = math.sin(TWO_PI * (180.0 + 520.0 * math.sin(frac * math.pi)) * t) * 0.18
            buf[i] = (bp[i] * 1.4 + sweep) * env
        return _normalize(buf, peak=0.84)

    if r == "ui_pop":
        for i in range(n):
            t = i / float(SAMPLE_RATE)
            env = math.exp(-t * 22.0) * min(1.0, t * 140.0)
            f = 587.3 if t < 0.07 else 880.0
            buf[i] = (math.sin(TWO_PI * f * t) + 0.25 * math.sin(TWO_PI * f * 2.0 * t)) * env
        return _normalize(buf, peak=0.8)

    if r == "boing":
        for i in range(n):
            t = i / float(SAMPLE_RATE)
            freq = 160.0 + 260.0 * (1.0 - math.exp(-t * 6.5)) + 55.0 * math.sin(TWO_PI * 14.0 * t) * math.exp(-t * 3.0)
            buf[i] = math.sin(TWO_PI * freq * t) * math.exp(-t * 4.2)
        return _normalize(buf, peak=0.84)

    if r == "cinematic_hit":
        for i in range(n):
            t = i / float(SAMPLE_RATE)
            sub = math.sin(TWO_PI * (78.0 * math.exp(-t * 2.5) + 36.0) * t) * math.exp(-t * 1.8)
            brass = (math.sin(TWO_PI * 110.0 * t) + 0.6 * math.sin(TWO_PI * 165.0 * t) + 0.35 * math.sin(TWO_PI * 220.0 * t)) * math.exp(-t * 2.2) * 0.45
            hit = rng.uniform(-1.0, 1.0) * math.exp(-t * 24.0) * 0.65
            buf[i] = sub + brass + hit
        return _normalize(_lowpass(buf, 0.5), peak=0.9)

    return _normalize(buf)


def _write_wav(dest: Path, samples: list[float]) -> tuple[bytes, int, list[float]]:
    dest.parent.mkdir(parents=True, exist_ok=True)
    pcm = array.array("h", (max(-32767, min(32767, int(v * 32767.0))) for v in samples))
    with wave.open(str(dest), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(pcm.tobytes())
    raw = dest.read_bytes()
    duration_ms = max(1, int(round((len(samples) / float(SAMPLE_RATE)) * 1000.0)))

    # Compute clean 120-bucket peaks directly without spawning FFmpeg per starter file!
    buckets = min(120, len(samples))
    step = len(samples) / float(buckets)
    peaks: list[float] = []
    for idx in range(buckets):
        start = int(idx * step)
        end = max(start + 1, int((idx + 1) * step))
        pk = max((abs(v) for v in samples[start:end]), default=0.0)
        peaks.append(round(min(1.0, pk), 4))
    return raw, duration_ms, peaks


def get_manifest_path(config: AppConfig) -> Path:
    return config.sounds_dir / "starter_pack_manifest.json"


def read_starter_manifest(config: AppConfig) -> dict:
    mpath = get_manifest_path(config)
    if mpath.is_file():
        try:
            return json.loads(mpath.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {
        "pack_name": "AutoMotion Comic Studio Original CC0 Starter Audio Pack",
        "version": STARTER_PACK_VERSION,
        "license": "CC0-1.0",
        "license_notice": "100% original procedural audio synthesized locally by AutoMotion Comic Studio. Released to the public domain (CC0-1.0) with no attribution required.",
        "assets": [],
    }


def seed_starter_pack_if_needed(config: AppConfig, repo: LibraryRepository, force: bool = False) -> int:
    """Seed the original CC0 starter audio pack idempotently on first launch."""
    conn = connect_sqlite(config.library_db_path)
    try:
        row = conn.execute(
            "SELECT value FROM schema_meta WHERE key = 'starter_pack_version'"
        ).fetchone()
    finally:
        conn.close()

    manifest_path = get_manifest_path(config)
    if not force and row and row["value"] == STARTER_PACK_VERSION and manifest_path.is_file():
        return 0

    now = utc_now_iso()
    pack_dir = config.sounds_dir / "starter_pack"
    pack_dir.mkdir(parents=True, exist_ok=True)
    manifest_assets: list[dict] = []
    seeded = 0

    for spec in STARTER_SPECS:
        existing = repo.get_sound(spec.sound_id)
        subdir = pack_dir / spec.audio_type
        dest_file = subdir / f"{spec.sound_id}.wav"

        if existing and dest_file.is_file() and not force:
            manifest_assets.append(
                {
                    "asset_id": existing.sound_id,
                    "name": existing.name,
                    "type": existing.audio_type,
                    "category": existing.category,
                    "tags": existing.tags,
                    "duration_ms": existing.duration_ms,
                    "format": "wav",
                    "license": "CC0-1.0",
                    "source": existing.license.origin_source or "AutoMotion Comic Studio Original CC0 Starter Pack",
                    "file_path": existing.file_path,
                    "import_date": existing.created_at,
                    "favorite": existing.is_favorite,
                }
            )
            continue

        samples = _synthesize_recipe(spec)
        raw_bytes, duration_ms, peaks = _write_wav(dest_file, samples)
        rel_path = to_posix_relative(dest_file, config.sounds_dir)
        sound = SoundAsset(
            sound_id=spec.sound_id,
            name=spec.name,
            audio_type=spec.audio_type,
            category=spec.category,
            tags=list(spec.tags),
            file_path=rel_path,
            sha256=compute_sha256_bytes(raw_bytes),
            duration_ms=duration_ms,
            sample_rate=SAMPLE_RATE,
            channels=1,
            codec="pcm_s16le",
            default_volume=spec.default_volume,
            loopable=spec.loopable,
            fade_in_ms=spec.fade_in_ms,
            fade_out_ms=spec.fade_out_ms,
            is_favorite=False,
            is_bundled=True,
            waveform_peaks=peaks,
            license=SoundLicense(
                source="cc0",
                usage="verified",
                attribution="AutoMotion Comic Studio Original Synthesis (CC0-1.0)",
                notes="Bundled original procedural audio safe for commercial & personal redistribution.",
                origin_source="AutoMotion Comic Studio Original CC0 Starter Pack",
            ),
            created_at=now,
        )
        repo.save_sound(sound)
        seeded += 1
        manifest_assets.append(
            {
                "asset_id": sound.sound_id,
                "name": sound.name,
                "type": sound.audio_type,
                "category": sound.category,
                "tags": sound.tags,
                "duration_ms": sound.duration_ms,
                "format": "wav",
                "license": "CC0-1.0",
                "source": "AutoMotion Comic Studio Original CC0 Starter Pack",
                "file_path": sound.file_path,
                "import_date": sound.created_at,
                "favorite": sound.is_favorite,
            }
        )

    manifest = {
        "pack_name": "AutoMotion Comic Studio Original CC0 Starter Audio Pack",
        "version": STARTER_PACK_VERSION,
        "generated_at": now,
        "license": "CC0-1.0",
        "license_notice": "100% original procedural audio synthesized locally by AutoMotion Comic Studio. Released under CC0-1.0 (Public Domain) — safe for offline and commercial use.",
        "sfx_count": sum(1 for a in manifest_assets if a["type"] == "sfx"),
        "bgm_count": sum(1 for a in manifest_assets if a["type"] == "bgm"),
        "assets": manifest_assets,
    }
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")

    with sqlite_transaction(config.library_db_path) as conn:
        conn.execute(
            "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('starter_pack_version', ?)",
            (STARTER_PACK_VERSION,),
        )

    logger.info(
        "Seeded CC0 starter audio pack v%s (%d SFX, %d BGM, %d newly generated)",
        STARTER_PACK_VERSION,
        manifest["sfx_count"],
        manifest["bgm_count"],
        seeded,
    )
    return seeded
