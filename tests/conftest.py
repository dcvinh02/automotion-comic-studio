"""Shared pytest fixtures and media test generators."""

from __future__ import annotations

import io
import math
import struct
import sys
import wave
from pathlib import Path
from PIL import Image

REPO_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = REPO_ROOT / "backend"
for p in (str(BACKEND_DIR), str(REPO_ROOT)):
    if p not in sys.path:
        sys.path.insert(0, p)


def make_test_png(width: int = 128, height: int = 128, color=(220, 60, 60, 255)) -> bytes:
    buf = io.BytesIO()
    img = Image.new("RGBA", (width, height), color)
    img.save(buf, format="PNG")
    return buf.getvalue()


def make_test_wav(duration_s: float = 0.6, freq_hz: float = 440.0, sample_rate: int = 44100) -> bytes:
    buf = io.BytesIO()
    num_frames = int(duration_s * sample_rate)
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        frames = bytearray()
        for i in range(num_frames):
            val = int(16000 * math.sin(2.0 * math.pi * freq_hz * i / sample_rate))
            frames.extend(struct.pack("<h", val))
        wf.writeframes(bytes(frames))
    return buf.getvalue()
