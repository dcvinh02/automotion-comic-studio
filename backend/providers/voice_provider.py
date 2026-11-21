"""Pluggable Voice Provider architecture (Phase 04 / Version 0.2 Foundation).

Supports clean separation between:
- Local OS Speech (e.g. macOS `say` when available — real offline speech, NOT AI TTS)
- Real AI TTS Providers (e.g. F5-TTS HTTP adapter when AMCS_F5_TTS_URL is configured)
- Development Mock Provider (`dev_mock`, explicitly marked is_mock=True for testing only)
"""

from __future__ import annotations

import asyncio
import collections
import json
import math
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import wave
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any

import httpx

from app.config import AppConfig
from database.library_repo import LibraryRepository
from schemas.voice import (
    F5TTSConfig,
    F5TTSConfigUpdate,
    F5TTSReferenceVoice,
    F5TTSStatus,
    F5TTSTestConnectionResult,
    VoiceOption,
    VoiceProviderInfo,
    VoiceSettingSpec,
)
from utils.ffmpeg import FFmpegLocator
from utils.paths import safe_resolve_under


class VoiceProvider(ABC):
    """Unified provider interface for speech synthesis."""

    provider_id: str

    @abstractmethod
    def get_info(self) -> VoiceProviderInfo:
        raise NotImplementedError

    @abstractmethod
    def list_voices(self) -> list[VoiceOption]:
        raise NotImplementedError

    @abstractmethod
    async def synthesize(
        self,
        *,
        text: str,
        voice_id: str,
        language: str,
        settings: dict[str, Any],
        output_wav_path: Path,
    ) -> dict[str, Any]:
        """Generate a PCM WAV file at output_wav_path and return metadata."""
        raise NotImplementedError


class LocalMacOSSpeechProvider(VoiceProvider):
    """Offline macOS `say` system speech provider (clearly labeled Local OS Speech, not AI)."""

    provider_id = "local_os_tts"

    def __init__(self, config: AppConfig) -> None:
        self.config = config
        self._say_bin = shutil.which("say")
        self._cached_voices: list[VoiceOption] | None = None

    def is_available(self) -> bool:
        return bool(self._say_bin and FFmpegLocator.find_ffmpeg(self.config))

    def list_voices(self) -> list[VoiceOption]:
        if not self.is_available():
            return []
        if self._cached_voices is not None:
            return self._cached_voices

        # Curated subset prioritizing clear Vietnamese & English system voices if installed
        preferred = [
            ("Linh", "Linh (Tiếng Việt — macOS)", "vi-VN", "female"),
            ("Samantha", "Samantha (English US — macOS)", "en-US", "female"),
            ("Daniel", "Daniel (English UK — macOS)", "en-GB", "male"),
            ("Alex", "Alex (English US — macOS)", "en-US", "male"),
            ("Eddy (Tiếng Anh (Mỹ))", "Eddy (English US — macOS)", "en-US", "male"),
            ("Flo (Tiếng Anh (Mỹ))", "Flo (English US — macOS)", "en-US", "female"),
            ("Fred", "Fred (English US — macOS)", "en-US", "male"),
        ]
        installed_names: set[str] = set()
        try:
            import subprocess

            proc = subprocess.run(
                [self._say_bin or "say", "-v", "?"],
                capture_output=True,
                text=True,
                timeout=4,
                check=False,
            )
            for line in proc.stdout.splitlines():
                parts = line.split("  ", 1)
                if parts and parts[0].strip():
                    installed_names.add(parts[0].strip())
        except Exception:
            installed_names = set()

        voices: list[VoiceOption] = []
        for raw_name, label, lang, gender in preferred:
            if not installed_names or raw_name in installed_names:
                voices.append(
                    VoiceOption(
                        voice_id=raw_name,
                        name=label,
                        language=lang,
                        gender=gender,
                        description="Offline macOS system speech voice",
                    )
                )
        if not voices and installed_names:
            first = sorted(installed_names)[0]
            voices.append(VoiceOption(voice_id=first, name=first, language="en-US"))

        self._cached_voices = voices
        return voices

    def get_info(self) -> VoiceProviderInfo:
        available = self.is_available()
        voices = self.list_voices() if available else []
        langs = sorted({v.language for v in voices}) or ["vi-VN", "en-US"]
        return VoiceProviderInfo(
            provider_id=self.provider_id,
            display_name="Local OS Speech (macOS)",
            provider_kind="local_os_tts",
            is_mock=False,
            is_configured=available and len(voices) > 0,
            status_message=(
                "Offline macOS system speech ready (real spoken audio, not neural AI TTS)."
                if available
                else "macOS `say` or FFmpeg is unavailable on this platform."
            ),
            supported_languages=langs,
            supported_settings=[
                VoiceSettingSpec(
                    key="speed",
                    label="Speed",
                    type="number",
                    min=0.6,
                    max=1.8,
                    step=0.05,
                    default=1.0,
                ),
            ],
            voices=voices,
        )

    async def synthesize(
        self,
        *,
        text: str,
        voice_id: str,
        language: str,
        settings: dict[str, Any],
        output_wav_path: Path,
    ) -> dict[str, Any]:
        if not self.is_available():
            raise RuntimeError("Local macOS Speech provider is not available on this OS.")
        ffmpeg = FFmpegLocator.find_ffmpeg(self.config)
        if not ffmpeg:
            raise RuntimeError("FFmpeg is required to transcode spoken audio to WAV.")

        speed = float(settings.get("speed", 1.0))
        speed = max(0.6, min(1.8, speed))
        wpm = int(round(175 * speed))

        valid_voices = {v.voice_id for v in self.list_voices()}
        chosen_voice = voice_id if voice_id in valid_voices else (next(iter(valid_voices), "Samantha"))

        output_wav_path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="amcs_say_") as tmp_dir:
            aiff_path = Path(tmp_dir) / "speech.aiff"
            say_proc = await asyncio.create_subprocess_exec(
                self._say_bin or "say",
                "-v",
                chosen_voice,
                "-r",
                str(wpm),
                "-o",
                str(aiff_path),
                text,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            _, stderr = await say_proc.communicate()
            if say_proc.returncode != 0 or not aiff_path.is_file():
                raise RuntimeError(
                    f"macOS speech synthesis failed: {stderr.decode('utf-8', errors='ignore').strip()}"
                )

            ff_proc = await asyncio.create_subprocess_exec(
                ffmpeg,
                "-y",
                "-i",
                str(aiff_path),
                "-ar",
                "48000",
                "-ac",
                "1",
                "-c:a",
                "pcm_s16le",
                str(output_wav_path),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            _, ff_err = await ff_proc.communicate()
            if ff_proc.returncode != 0 or not output_wav_path.is_file():
                raise RuntimeError(
                    f"FFmpeg WAV conversion failed: {ff_err.decode('utf-8', errors='ignore').strip()}"
                )

        return {
            "provider_id": self.provider_id,
            "provider_voice_id": chosen_voice,
            "is_mock": False,
        }


F5_CONFIG_SETTING_KEY = "f5_tts_config"
F5_REFS_SETTING_KEY = "f5_tts_references"

F5_INSTALL_INSTRUCTIONS = [
    "Create an isolated Python venv (avoid modifying AutoMotion's venv): python3 -m venv ~/f5tts_venv",
    "Activate and install official F5-TTS: source ~/f5tts_venv/bin/activate && pip install f5-tts",
    "Option A (Local Managed Mode): Set Python Executable to ~/f5tts_venv/bin/python and click Start Service.",
    "Option B (External Server Mode): Run `f5-tts_infer-gradio --host 127.0.0.1 --port 7860` (or your F5-TTS HTTP server) and configure Service URL.",
]


class F5TTSProvider(VoiceProvider):
    """Real F5-TTS Provider Adapter (External HTTP/Gradio Server OR Managed Local F5-TTS Process).

    Never reports fake statuses: installation, GPU/MPS/CPU availability, process status,
    and endpoint reachability are inspected directly from the runtime environment.
    """

    provider_id = "f5_tts"

    def __init__(self, config: AppConfig, library_repo: LibraryRepository | None = None) -> None:
        self.config = config
        self.library_repo = library_repo
        self._managed_proc: asyncio.subprocess.Process | None = None
        self._log_task_out: asyncio.Task[None] | None = None
        self._log_task_err: asyncio.Task[None] | None = None
        self._logs: collections.deque[str] = collections.deque(maxlen=80)
        self._last_probe_ok: bool = False
        self._last_probe_msg: str = ""
        self._last_api_style: str = "unknown"

    def _append_log(self, line: str) -> None:
        clean = (line or "").rstrip()
        if clean:
            self._logs.append(clean)

    def get_config(self) -> F5TTSConfig:
        raw = self.library_repo.get_app_setting(F5_CONFIG_SETTING_KEY) if self.library_repo else None
        if isinstance(raw, dict):
            try:
                cfg = F5TTSConfig.model_validate(raw)
                if not cfg.service_url and self.config.f5_tts_url:
                    cfg.service_url = self.config.f5_tts_url.strip().rstrip("/")
                return cfg
            except Exception:
                pass
        env_url = (self.config.f5_tts_url or "").strip().rstrip("/")
        return F5TTSConfig(
            mode="external_http",
            service_url=env_url or "http://127.0.0.1:7860",
        )

    def update_config(self, patch: F5TTSConfigUpdate) -> F5TTSConfig:
        current = self.get_config()
        updates = patch.model_dump(exclude_none=True)
        if "service_url" in updates:
            updates["service_url"] = str(updates["service_url"]).strip().rstrip("/")
        if "python_executable" in updates:
            updates["python_executable"] = str(updates["python_executable"]).strip()
        updated = current.model_copy(update=updates)
        if self.library_repo:
            self.library_repo.set_app_setting(F5_CONFIG_SETTING_KEY, updated.model_dump(mode="json"))
        self._last_probe_ok = False
        return updated

    def list_references(self) -> list[F5TTSReferenceVoice]:
        if not self.library_repo:
            return []
        raw = self.library_repo.get_app_setting(F5_REFS_SETTING_KEY)
        items = raw.get("items") if isinstance(raw, dict) else raw
        if not isinstance(items, list):
            return []
        out: list[F5TTSReferenceVoice] = []
        for item in items:
            try:
                out.append(F5TTSReferenceVoice.model_validate(item))
            except Exception:
                continue
        return out

    def save_references(self, refs: list[F5TTSReferenceVoice]) -> None:
        if self.library_repo:
            self.library_repo.set_app_setting(
                F5_REFS_SETTING_KEY, {"items": [r.model_dump(mode="json") for r in refs]}
            )

    def resolve_reference_audio_path(self, ref: F5TTSReferenceVoice) -> Path:
        return safe_resolve_under(self.config.workspace_dir, ref.file_path)

    @property
    def base_url(self) -> str | None:
        cfg = self.get_config()
        url = (cfg.service_url or self.config.f5_tts_url or "").strip().rstrip("/")
        return url or None

    def _is_managed_running(self) -> bool:
        return self._managed_proc is not None and self._managed_proc.returncode is None

    def _probe_python_env(self, python_exec: str) -> dict[str, Any]:
        py = python_exec.strip() if python_exec.strip() else sys.executable
        cli_path = shutil.which("f5-tts_infer-cli")
        gradio_path = shutil.which("f5-tts_infer-gradio")
        # Also check sibling bin/Scripts dir of custom python_executable
        if py:
            py_dir = Path(py).parent
            for cand_cli in (py_dir / "f5-tts_infer-cli", py_dir / "f5-tts_infer-cli.exe"):
                if cand_cli.is_file():
                    cli_path = str(cand_cli)
                    break
            for cand_gr in (py_dir / "f5-tts_infer-gradio", py_dir / "f5-tts_infer-gradio.exe"):
                if cand_gr.is_file():
                    gradio_path = str(cand_gr)
                    break

        probe = {
            "python_ok": False,
            "f5_tts": False,
            "torch": False,
            "cuda": False,
            "mps": False,
            "device_info": "Python environment not checked",
            "cli_path": cli_path,
            "gradio_cli_path": gradio_path,
        }
        if not py or not Path(py).exists():
            probe["device_info"] = f"Configured Python executable not found: {py or '(none)'}"
            return probe

        code = (
            "import importlib.util, json, platform; "
            "has_f5 = importlib.util.find_spec('f5_tts') is not None; "
            "has_torch = importlib.util.find_spec('torch') is not None; "
            "cuda = False; mps = False; dev = platform.machine(); "
            "exec('if has_torch:\\n import torch\\n cuda = bool(torch.cuda.is_available())\\n mps = bool(getattr(torch.backends, \"mps\", None) and torch.backends.mps.is_available())\\n dev = torch.cuda.get_device_name(0) if cuda else (\"Apple Silicon MPS\" if mps else \"CPU only (PyTorch \" + torch.__version__ + \")\")'); "
            "print(json.dumps({'f5_tts': has_f5, 'torch': has_torch, 'cuda': cuda, 'mps': mps, 'device': dev}))"
        )
        try:
            res = subprocess.run(
                [py, "-c", code],
                capture_output=True,
                text=True,
                timeout=6,
                check=False,
            )
            if res.returncode == 0 and res.stdout.strip():
                data = json.loads(res.stdout.strip().splitlines()[-1])
                probe["python_ok"] = True
                probe["f5_tts"] = bool(data.get("f5_tts", False))
                probe["torch"] = bool(data.get("torch", False))
                probe["cuda"] = bool(data.get("cuda", False))
                probe["mps"] = bool(data.get("mps", False))
                probe["device_info"] = str(data.get("device", ""))
            else:
                probe["device_info"] = (res.stderr or "Python probe failed").strip()[:180]
        except Exception as exc:
            probe["device_info"] = f"Environment probe error: {exc}"
        return probe

    async def test_connection(self) -> F5TTSTestConnectionResult:
        cfg = self.get_config()
        url = (cfg.service_url or "").strip().rstrip("/")
        if not url:
            self._last_probe_ok = False
            return F5TTSTestConnectionResult(
                ok=False,
                message="F5-TTS service URL is empty. Configure a running F5-TTS HTTP or Gradio server URL.",
            )

        t0 = time.monotonic()
        try:
            async with httpx.AsyncClient(timeout=6.0) as client:
                # 1. Check standard /health
                for ep in ("/health", "/info", "/"):
                    try:
                        resp = await client.get(f"{url}{ep}")
                    except httpx.RequestError:
                        raise
                    latency = int((time.monotonic() - t0) * 1000)
                    if resp.status_code < 400:
                        text_low = resp.text[:400].lower()
                        api_style: str = "http_api"
                        if ep == "/info" or "gradio" in text_low or "basic_tts" in text_low:
                            api_style = "gradio"
                        self._last_probe_ok = True
                        self._last_api_style = api_style
                        self._last_probe_msg = f"Connected to {url}{ep} ({latency}ms, {api_style})"
                        return F5TTSTestConnectionResult(
                            ok=True,
                            status_code=resp.status_code,
                            latency_ms=latency,
                            detected_api_style=api_style,  # type: ignore[arg-type]
                            message=self._last_probe_msg,
                        )
                    if ep == "/":
                        self._last_probe_ok = False
                        msg = f"F5-TTS endpoint {url} returned HTTP {resp.status_code}."
                        self._last_probe_msg = msg
                        return F5TTSTestConnectionResult(
                            ok=False,
                            status_code=resp.status_code,
                            latency_ms=latency,
                            message=msg,
                        )
        except httpx.TimeoutException:
            latency = int((time.monotonic() - t0) * 1000)
            self._last_probe_ok = False
            msg = f"Connection to F5-TTS at {url} timed out after {latency}ms."
            self._last_probe_msg = msg
            return F5TTSTestConnectionResult(ok=False, latency_ms=latency, message=msg)
        except httpx.RequestError as exc:
            latency = int((time.monotonic() - t0) * 1000)
            self._last_probe_ok = False
            msg = f"F5-TTS service unreachable at {url}: {exc}"
            self._last_probe_msg = msg
            return F5TTSTestConnectionResult(ok=False, latency_ms=latency, message=msg)

        return F5TTSTestConnectionResult(ok=False, message=f"No valid response from {url}")

    async def get_status(self, *, probe_connection: bool = False) -> F5TTSStatus:
        cfg = self.get_config()
        env = self._probe_python_env(cfg.python_executable)
        installed = bool(env["f5_tts"] or env["cli_path"] or env["gradio_cli_path"])
        managed_running = self._is_managed_running()
        refs = self.list_references()

        conn_ok = self._last_probe_ok
        conn_msg = self._last_probe_msg
        if probe_connection and cfg.service_url:
            probe_res = await self.test_connection()
            conn_ok = probe_res.ok
            conn_msg = probe_res.message

        if env["cuda"]:
            gpu_backend = "cuda"
        elif env["mps"]:
            gpu_backend = "mps"
        elif env["torch"]:
            gpu_backend = "cpu"
        else:
            gpu_backend = "none"

        if cfg.mode == "external_http":
            if conn_ok:
                service_status = "running"
                model_status = "ready"
                status_msg = conn_msg or f"Connected to external F5-TTS server at {cfg.service_url}"
            else:
                service_status = "unreachable" if probe_connection else "stopped"
                model_status = "unknown"
                status_msg = (
                    conn_msg
                    or f"External F5-TTS server configured at {cfg.service_url}. Click 'Test Connection' to verify."
                )
        else:
            if not installed:
                service_status = "not_installed"
                model_status = "not_installed"
                status_msg = (
                    "F5-TTS is not installed in the configured Python environment. "
                    "Follow the setup instructions below or switch to External Server mode."
                )
            elif managed_running:
                service_status = "running"
                model_status = "ready" if conn_ok else "not_loaded"
                status_msg = f"Managed local F5-TTS process running (PID {self._managed_proc.pid if self._managed_proc else '?'})"
            else:
                service_status = "stopped"
                model_status = "not_loaded"
                status_msg = "F5-TTS is installed locally but the service is stopped. Click 'Start Service'."

        return F5TTSStatus(
            mode=cfg.mode,
            service_url=cfg.service_url,
            installed=installed,
            cli_path=env["cli_path"],
            gradio_cli_path=env["gradio_cli_path"],
            torch_installed=bool(env["torch"]),
            gpu_available=bool(env["cuda"] or env["mps"]),
            gpu_backend=gpu_backend,  # type: ignore[arg-type]
            device_info=str(env["device_info"] or ""),
            cpu_fallback_supported=True,
            managed_process_running=managed_running,
            managed_pid=self._managed_proc.pid if managed_running and self._managed_proc else None,
            connection_ok=conn_ok,
            service_status=service_status,  # type: ignore[arg-type]
            model_status=model_status,  # type: ignore[arg-type]
            status_message=status_msg,
            install_instructions=list(F5_INSTALL_INSTRUCTIONS),
            logs=list(self._logs),
            reference_count=len(refs),
            config=cfg,
        )

    async def _pump_stream(self, stream: asyncio.StreamReader | None, prefix: str) -> None:
        if not stream:
            return
        try:
            while True:
                line = await stream.readline()
                if not line:
                    break
                self._append_log(f"[{prefix}] {line.decode('utf-8', errors='replace')}")
        except Exception:
            pass

    async def start_managed_service(self) -> F5TTSStatus:
        cfg = self.get_config()
        if cfg.mode == "external_http":
            return await self.get_status(probe_connection=True)

        if self._is_managed_running():
            return await self.get_status(probe_connection=True)

        env = self._probe_python_env(cfg.python_executable)
        if not (env["f5_tts"] or env["gradio_cli_path"]):
            err = (
                "Cannot start local F5-TTS service: `f5-tts` package and `f5-tts_infer-gradio` CLI were not found. "
                "Install F5-TTS in an isolated venv first, or configure an External F5-TTS Server URL."
            )
            self._append_log(f"[error] {err}")
            raise RuntimeError(err)

        # Parse host/port from service_url
        from urllib.parse import urlparse

        parsed = urlparse(cfg.service_url or "http://127.0.0.1:7860")
        host = parsed.hostname or "127.0.0.1"
        port = str(parsed.port or 7860)

        if env["gradio_cli_path"]:
            cmd = [env["gradio_cli_path"], "--host", host, "--port", port]
        else:
            py = cfg.python_executable.strip() or sys.executable
            cmd = [py, "-m", "f5_tts.infer.infer_gradio", "--host", host, "--port", port]

        self._append_log(f"[system] Launching F5-TTS: {' '.join(cmd)}")
        try:
            self._managed_proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            self._log_task_out = asyncio.create_task(self._pump_stream(self._managed_proc.stdout, "stdout"))
            self._log_task_err = asyncio.create_task(self._pump_stream(self._managed_proc.stderr, "stderr"))
            await asyncio.sleep(0.6)
            if self._managed_proc.returncode is not None:
                raise RuntimeError(
                    f"F5-TTS process exited immediately with code {self._managed_proc.returncode}. Check logs."
                )
        except Exception as exc:
            self._append_log(f"[error] Failed to start F5-TTS: {exc}")
            raise RuntimeError(f"Failed to start local F5-TTS service: {exc}") from exc

        return await self.get_status(probe_connection=True)

    async def stop_managed_service(self) -> F5TTSStatus:
        if self._managed_proc is not None and self._managed_proc.returncode is None:
            self._append_log(f"[system] Stopping F5-TTS PID {self._managed_proc.pid}...")
            try:
                self._managed_proc.terminate()
                await asyncio.wait_for(self._managed_proc.wait(), timeout=5.0)
            except Exception:
                try:
                    self._managed_proc.kill()
                except Exception:
                    pass
        self._managed_proc = None
        self._last_probe_ok = False
        return await self.get_status(probe_connection=False)

    def list_voices(self) -> list[VoiceOption]:
        refs = self.list_references()
        voices: list[VoiceOption] = [
            VoiceOption(
                voice_id=r.ref_id,
                name=f"{r.name} ({r.language})",
                language=r.language,
                description=f"Reference transcript: {r.transcript[:64]}",
            )
            for r in refs
        ]
        if not voices:
            voices.append(
                VoiceOption(
                    voice_id="f5_default_ref",
                    name="F5-TTS Default (Import reference voice for cloning)",
                    language=self.get_config().default_language,
                    description="Import a reference voice WAV/MP3 + transcript in Voice Studio -> F5-TTS",
                )
            )
        return voices

    def is_explicitly_configured(self) -> bool:
        raw = self.library_repo.get_app_setting(F5_CONFIG_SETTING_KEY) if self.library_repo else None
        if isinstance(raw, dict):
            mode = raw.get("mode", "external_http")
            if mode == "external_http":
                return bool(str(raw.get("service_url") or "").strip())
            return self._is_managed_running() or bool(self._probe_python_env(str(raw.get("python_executable") or "")).get("f5_tts"))
        return bool((self.config.f5_tts_url or "").strip())

    def get_info(self) -> VoiceProviderInfo:
        cfg = self.get_config()
        url = self.base_url
        env_configured = self.is_explicitly_configured()
        refs = self.list_references()
        return VoiceProviderInfo(
            provider_id=self.provider_id,
            display_name="F5-TTS (AI Neural TTS)",
            provider_kind="real_local_ai",
            is_mock=False,
            is_configured=env_configured,
            status_message=(
                f"Mode: {cfg.mode} • Endpoint: {url} • {len(refs)} reference voice(s)"
                if env_configured
                else "F5-TTS not configured. Open Voice -> F5-TTS Configuration or set AMCS_F5_TTS_URL to connect a local or external F5-TTS server."
            ),
            supported_languages=["vi-VN", "en-US", "zh-CN", "ja-JP", "ko-KR"],
            supported_settings=[
                VoiceSettingSpec(
                    key="speed",
                    label="Speed",
                    type="number",
                    min=0.5,
                    max=2.0,
                    step=0.05,
                    default=1.0,
                ),
                VoiceSettingSpec(
                    key="nfe_step",
                    label="NFE Steps",
                    type="number",
                    min=8,
                    max=64,
                    step=4,
                    default=cfg.nfe_step,
                ),
                VoiceSettingSpec(
                    key="cfg_strength",
                    label="CFG Strength",
                    type="number",
                    min=0.5,
                    max=5.0,
                    step=0.1,
                    default=cfg.cfg_strength,
                ),
            ],
            voices=self.list_voices(),
        )

    async def _normalize_audio_to_wav(self, raw_bytes: bytes, output_wav_path: Path) -> None:
        if not raw_bytes or len(raw_bytes) < 44:
            raise RuntimeError("F5-TTS server returned empty or truncated audio output.")
        # Reject obvious HTML/JSON error bodies masquerading as audio
        head = raw_bytes[:32].lstrip()
        if head.startswith((b"<html", b"<!DOCTYPE", b"{", b"[")):
            raise RuntimeError(
                f"F5-TTS returned non-audio response: {raw_bytes[:180].decode('utf-8', errors='replace')}"
            )
        output_wav_path.parent.mkdir(parents=True, exist_ok=True)
        ffmpeg = FFmpegLocator.find_ffmpeg(self.config)
        if ffmpeg:
            with tempfile.TemporaryDirectory(prefix="amcs_f5_") as tmp_dir:
                raw_path = Path(tmp_dir) / "raw_audio"
                raw_path.write_bytes(raw_bytes)
                proc = await asyncio.create_subprocess_exec(
                    ffmpeg,
                    "-y",
                    "-i",
                    str(raw_path),
                    "-ar",
                    "48000",
                    "-ac",
                    "1",
                    "-c:a",
                    "pcm_s16le",
                    str(output_wav_path),
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                _, err = await proc.communicate()
                if proc.returncode == 0 and output_wav_path.is_file() and output_wav_path.stat().st_size > 44:
                    return
                raise RuntimeError(
                    f"F5-TTS output could not be decoded as valid audio: {err.decode('utf-8', errors='ignore')[:200]}"
                )
        # Without FFmpeg, accept standard RIFF/WAVE bytes directly
        if not raw_bytes.startswith(b"RIFF"):
            raise RuntimeError("F5-TTS returned non-WAV audio and FFmpeg is unavailable to transcode it.")
        output_wav_path.write_bytes(raw_bytes)

    async def synthesize(
        self,
        *,
        text: str,
        voice_id: str,
        language: str,
        settings: dict[str, Any],
        output_wav_path: Path,
    ) -> dict[str, Any]:
        clean_text = (text or "").strip()
        if not clean_text:
            raise ValueError("Dialogue text cannot be empty for F5-TTS generation.")

        cfg = self.get_config()
        url = self.base_url
        if not url:
            raise RuntimeError(
                "F5-TTS service URL is not configured. Configure F5-TTS in Voice Studio before generating."
            )

        refs = self.list_references()
        ref_id = str(settings.get("ref_id") or voice_id or "").strip()
        ref = next((r for r in refs if r.ref_id == ref_id), None)
        if ref is None and refs and voice_id == "f5_default_ref":
            ref = refs[0]

        ref_path: Path | None = None
        ref_transcript = str(settings.get("ref_text") or "").strip()
        if ref is not None:
            ref_path = self.resolve_reference_audio_path(ref)
            if not ref_path.is_file():
                raise RuntimeError(
                    f"F5-TTS reference voice audio file is missing on disk ({ref.name}). Re-import the reference voice."
                )
            ref_transcript = ref_transcript or ref.transcript.strip()
            if not ref_transcript:
                raise ValueError(
                    f"Reference voice '{ref.name}' requires a non-empty reference transcript for F5-TTS."
                )

        speed = max(0.5, min(2.0, float(settings.get("speed", 1.0))))
        nfe_step = max(8, min(64, int(float(settings.get("nfe_step", cfg.nfe_step)))))
        cfg_strength = max(0.5, min(5.0, float(settings.get("cfg_strength", cfg.cfg_strength))))

        self._append_log(
            f"[synth] F5-TTS request ({cfg.mode}, url={url}, ref={ref.name if ref else voice_id}, speed={speed})"
        )

        try:
            async with httpx.AsyncClient(timeout=float(cfg.timeout_seconds)) as client:
                if ref_path is not None:
                    # Send real multipart request with reference audio + transcript (standard F5-TTS HTTP API)
                    with ref_path.open("rb") as fh:
                        files = {"ref_audio": (ref_path.name, fh.read(), "audio/wav")}
                    form_data = {
                        "gen_text": clean_text,
                        "text": clean_text,
                        "ref_text": ref_transcript,
                        "voice_id": ref.ref_id if ref else voice_id,
                        "language": language or cfg.default_language,
                        "model_name": cfg.model_name,
                        "speed": str(speed),
                        "nfe_step": str(nfe_step),
                        "cfg_strength": str(cfg_strength),
                        "cross_fade_duration": str(cfg.cross_fade_duration),
                        "device": cfg.device_preference,
                    }
                    resp = await client.post(f"{url}/synthesize", data=form_data, files=files)
                else:
                    payload = {
                        "text": clean_text,
                        "gen_text": clean_text,
                        "ref_text": ref_transcript,
                        "voice_id": voice_id,
                        "language": language or cfg.default_language,
                        "model_name": cfg.model_name,
                        "speed": speed,
                        "nfe_step": nfe_step,
                        "cfg_strength": cfg_strength,
                        "cross_fade_duration": cfg.cross_fade_duration,
                        "device": cfg.device_preference,
                    }
                    resp = await client.post(f"{url}/synthesize", json=payload)

                if resp.status_code >= 400:
                    body_txt = resp.text[:300].strip()
                    low_body = body_txt.lower()
                    if "out of memory" in low_body or "cuda" in low_body or "oom" in low_body:
                        err_msg = (
                            f"F5-TTS GPU/OOM error ({resp.status_code}): {body_txt}. "
                            "Try switching Device Preference to 'cpu' (CPU fallback) or lowering NFE Steps."
                        )
                    else:
                        err_msg = f"F5-TTS server error ({resp.status_code}): {body_txt}"
                    self._append_log(f"[error] {err_msg}")
                    raise RuntimeError(err_msg)

                await self._normalize_audio_to_wav(resp.content, output_wav_path)
                self._last_probe_ok = True
        except httpx.TimeoutException as exc:
            msg = f"F5-TTS generation timed out after {cfg.timeout_seconds}s at {url}."
            self._append_log(f"[error] {msg}")
            raise RuntimeError(msg) from exc
        except httpx.RequestError as exc:
            self._last_probe_ok = False
            msg = f"F5-TTS service unavailable at {url}: {exc}"
            self._append_log(f"[error] {msg}")
            raise RuntimeError(msg) from exc

        return {
            "provider_id": self.provider_id,
            "provider_voice_id": ref.ref_id if ref else voice_id,
            "is_mock": False,
        }


class DevMockVoiceProvider(VoiceProvider):
    """Deterministic development mock provider — generates synthetic test tone WAV only.

    Explicitly marked `is_mock=True` so UI and assets never pretend this is real AI speech.
    """

    provider_id = "dev_mock"

    def list_voices(self) -> list[VoiceOption]:
        return [
            VoiceOption(
                voice_id="mock_tone_mid",
                name="Dev Mock Tone — Medium (Test Only)",
                language="vi-VN",
                description="Synthetic deterministic test audio (NOT real speech)",
            ),
            VoiceOption(
                voice_id="mock_tone_low",
                name="Dev Mock Tone — Low (Test Only)",
                language="en-US",
                description="Synthetic deterministic test audio (NOT real speech)",
            ),
            VoiceOption(
                voice_id="mock_tone_high",
                name="Dev Mock Tone — High (Test Only)",
                language="vi-VN",
                description="Synthetic deterministic test audio (NOT real speech)",
            ),
        ]

    def get_info(self) -> VoiceProviderInfo:
        return VoiceProviderInfo(
            provider_id=self.provider_id,
            display_name="Development Mock (Test Audio Only)",
            provider_kind="dev_mock",
            is_mock=True,
            is_configured=True,
            status_message="Development mock provider for pipeline testing. Generates synthetic test audio, NOT real AI voice.",
            supported_languages=["vi-VN", "en-US"],
            supported_settings=[
                VoiceSettingSpec(
                    key="speed",
                    label="Speed",
                    type="number",
                    min=0.5,
                    max=2.0,
                    step=0.1,
                    default=1.0,
                ),
                VoiceSettingSpec(
                    key="pitch",
                    label="Pitch (semitones)",
                    type="number",
                    min=-6,
                    max=6,
                    step=1,
                    default=0,
                ),
            ],
            voices=self.list_voices(),
        )

    async def synthesize(
        self,
        *,
        text: str,
        voice_id: str,
        language: str,
        settings: dict[str, Any],
        output_wav_path: Path,
    ) -> dict[str, Any]:
        speed = max(0.5, min(2.0, float(settings.get("speed", 1.0))))
        pitch_st = max(-6.0, min(6.0, float(settings.get("pitch", 0.0))))

        base_freq = 280.0
        if voice_id == "mock_tone_low":
            base_freq = 195.0
        elif voice_id == "mock_tone_high":
            base_freq = 370.0
        freq = base_freq * (2.0 ** (pitch_st / 12.0))

        # Proportional cadence duration based on word count & speed
        words = max(1, len(text.split()))
        duration_s = max(0.6, min(15.0, (words / 2.6) / speed))
        sample_rate = 48000
        num_samples = int(duration_s * sample_rate)

        output_wav_path.parent.mkdir(parents=True, exist_ok=True)
        frames = bytearray(num_samples * 2)
        syllable_rate = 4.2 * speed
        for i in range(num_samples):
            t = i / sample_rate
            # Smooth syllable-like amplitude envelope for realistic waveform preview
            env = 0.5 * (1.0 + math.sin(2.0 * math.pi * syllable_rate * t - math.pi / 2.0))
            fade = min(1.0, t / 0.04, (duration_s - t) / 0.05)
            amp = 11000.0 * max(0.0, fade) * (0.25 + 0.75 * env)
            sample = int(amp * (0.75 * math.sin(2.0 * math.pi * freq * t) + 0.25 * math.sin(2.0 * math.pi * freq * 1.5 * t)))
            struct.pack_into("<h", frames, i * 2, max(-32767, min(32767, sample)))

        with wave.open(str(output_wav_path), "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sample_rate)
            wf.writeframes(bytes(frames))

        return {
            "provider_id": self.provider_id,
            "provider_voice_id": voice_id or "mock_tone_mid",
            "is_mock": True,
        }


class VoiceProviderRegistry:
    """Registry managing pluggable TTS providers."""

    def __init__(self, config: AppConfig, library_repo: LibraryRepository | None = None) -> None:
        self.config = config
        self.library_repo = library_repo
        self._providers: dict[str, VoiceProvider] = {}
        local_os = LocalMacOSSpeechProvider(config)
        if local_os.is_available():
            self.register(local_os)
        self.f5_provider = F5TTSProvider(config, library_repo=library_repo)
        self.register(self.f5_provider)
        self.register(DevMockVoiceProvider())

    def register(self, provider: VoiceProvider) -> None:
        self._providers[provider.provider_id] = provider

    def get(self, provider_id: str) -> VoiceProvider | None:
        return self._providers.get(provider_id)

    def list_infos(self) -> list[VoiceProviderInfo]:
        return [p.get_info() for p in self._providers.values()]
