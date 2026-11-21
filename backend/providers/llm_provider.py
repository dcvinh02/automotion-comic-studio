"""Real Structured LLM Provider Adapters, Live Model Discovery & Feature Model Registry.

Implements `providers.interfaces.LLMProvider` using `httpx` with zero hardcoded API keys.
Supports:
- OpenAI (`openai`)
- Anthropic Claude (`anthropic`)
- Google Gemini (`gemini`)
- DeepSeek (`deepseek`)
- OpenRouter (`openrouter`)
- Groq (`groq`)
- OpenAI-Compatible / Local (`openai_compatible` — Ollama, LM Studio, vLLM, etc.)

Phase 07 Batch 3:
- Live API model discovery per provider with safe caching in `library.db`
- Honest error reporting for invalid credentials, rate limits, and network failures
- Capability metadata (context length, text/JSON, vision, reasoning, tools)
- Compatibility validation that prevents invalid execution without silently switching models
- Per-provider saved models/base URLs/keys and per-feature model overrides
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from typing import Any, TypeVar

import httpx
from pydantic import BaseModel, ValidationError

from app.config import AppConfig
from app.logging_config import get_logger
from database.library_repo import LibraryRepository
from providers.interfaces import LLMProvider
from schemas.common import utc_now_iso
from schemas.director import (
    AIFeatureKey,
    AIModelDiscoveryResult,
    AIModelInfo,
    AIProviderConfig,
    AIProviderConfigUpdate,
    AIProviderInfo,
    AIProviderRegistryResponse,
    FeatureModelOverride,
    LLMProviderId,
    ModelCompatibilityRequest,
    ModelCompatibilityResult,
)

logger = get_logger("llm_provider")
TModel = TypeVar("TModel", bound=BaseModel)

SETTINGS_KEY = "ai_provider_config"
MODEL_CACHE_KEY = "ai_model_cache"

ALL_FEATURE_KEYS: list[AIFeatureKey] = [
    "script_analysis",
    "script_generation",
    "character_analysis",
    "storyboard",
    "ai_director",
    "production_plan",
    "animation_planning",
    "asset_prompts",
]

PROVIDER_CATALOG: dict[LLMProviderId, dict[str, Any]] = {
    "openai": {
        "display_name": "OpenAI",
        "default_model": "gpt-4o-mini",
        "suggested_models": ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1", "o3-mini"],
        "default_base_url": "https://api.openai.com/v1",
        "context_limit_chars": 128000,
        "env_vars": ["AMCS_OPENAI_API_KEY", "OPENAI_API_KEY"],
        "requires_key": True,
        "discovery_protocol": "openai",
    },
    "anthropic": {
        "display_name": "Anthropic (Claude)",
        "default_model": "claude-sonnet-4-20250514",
        "suggested_models": [
            "claude-sonnet-4-20250514",
            "claude-3-7-sonnet-20250219",
            "claude-3-5-sonnet-20241022",
            "claude-3-5-haiku-20241022",
        ],
        "default_base_url": "https://api.anthropic.com",
        "context_limit_chars": 200000,
        "env_vars": ["AMCS_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"],
        "requires_key": True,
        "discovery_protocol": "anthropic",
    },
    "gemini": {
        "display_name": "Google Gemini",
        "default_model": "gemini-2.5-flash",
        "suggested_models": ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"],
        "default_base_url": "https://generativelanguage.googleapis.com/v1beta",
        "context_limit_chars": 1000000,
        "env_vars": ["AMCS_GEMINI_API_KEY", "GEMINI_API_KEY"],
        "requires_key": True,
        "discovery_protocol": "gemini",
    },
    "deepseek": {
        "display_name": "DeepSeek",
        "default_model": "deepseek-chat",
        "suggested_models": ["deepseek-chat", "deepseek-reasoner"],
        "default_base_url": "https://api.deepseek.com/v1",
        "context_limit_chars": 64000,
        "env_vars": ["AMCS_DEEPSEEK_API_KEY", "DEEPSEEK_API_KEY"],
        "requires_key": True,
        "discovery_protocol": "openai",
    },
    "openrouter": {
        "display_name": "OpenRouter",
        "default_model": "openai/gpt-4o-mini",
        "suggested_models": [
            "openai/gpt-4o-mini",
            "anthropic/claude-3.5-sonnet",
            "google/gemini-2.5-flash",
            "deepseek/deepseek-chat",
        ],
        "default_base_url": "https://openrouter.ai/api/v1",
        "context_limit_chars": 128000,
        "env_vars": ["AMCS_OPENROUTER_API_KEY", "OPENROUTER_API_KEY"],
        "requires_key": True,
        "discovery_protocol": "openrouter",
    },
    "groq": {
        "display_name": "Groq",
        "default_model": "llama-3.3-70b-versatile",
        "suggested_models": [
            "llama-3.3-70b-versatile",
            "llama-3.1-8b-instant",
            "mixtral-8x7b-32768",
        ],
        "default_base_url": "https://api.groq.com/openai/v1",
        "context_limit_chars": 128000,
        "env_vars": ["AMCS_GROQ_API_KEY", "GROQ_API_KEY"],
        "requires_key": True,
        "discovery_protocol": "openai",
    },
    "openai_compatible": {
        "display_name": "OpenAI-Compatible / Local (Ollama, LM Studio, vLLM)",
        "default_model": "llama3.1:8b",
        "suggested_models": ["llama3.1:8b", "qwen2.5:14b", "mistral"],
        "default_base_url": "http://127.0.0.1:11434/v1",
        "context_limit_chars": 32000,
        "env_vars": ["AMCS_AI_API_KEY"],
        "requires_key": False,
        "discovery_protocol": "openai_compatible",
    },
}


class LLMProviderError(RuntimeError):
    """Base error raised by LLM providers."""


class LLMNotConfiguredError(LLMProviderError):
    """Raised when the selected AI provider lacks required credentials/config."""


class LLMIncompatibleModelError(LLMProviderError):
    """Raised when the user selected a model incompatible with the requested AI feature."""

    def __init__(self, message: str, recommended_models: list[str] | None = None) -> None:
        super().__init__(message)
        self.recommended_models = recommended_models or []


class LLMTimeoutError(LLMProviderError):
    """Raised when the AI provider request times out."""


class LLMMalformedResponseError(LLMProviderError):
    """Raised when the AI provider returns invalid or non-conforming JSON."""


class LLMCancelledError(LLMProviderError):
    """Raised when analysis is cancelled by the user."""


def mask_api_key(key: str) -> str:
    clean = (key or "").strip()
    if not clean:
        return ""
    if len(clean) <= 8:
        return "*" * len(clean)
    return f"{clean[:4]}...{clean[-4:]}"


def extract_json_object(raw_text: str) -> dict[str, Any]:
    """Extract and parse a JSON object from plain or Markdown-fenced LLM output."""
    text = (raw_text or "").strip()
    if not text:
        raise LLMMalformedResponseError("AI provider returned an empty response.")

    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text, re.IGNORECASE)
    if fence:
        text = fence.group(1).strip()

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start == -1 or end == -1 or end <= start:
            raise LLMMalformedResponseError(
                f"AI provider response did not contain a valid JSON object: {text[:160]!r}"
            )
        try:
            parsed = json.loads(text[start : end + 1])
        except json.JSONDecodeError as exc:
            raise LLMMalformedResponseError(f"Invalid JSON returned by AI provider: {exc}") from exc

    if not isinstance(parsed, dict):
        raise LLMMalformedResponseError("Expected top-level JSON object from AI provider.")
    return parsed


def _build_schema_instruction(schema: type[BaseModel]) -> str:
    schema_json = json.dumps(schema.model_json_schema(), ensure_ascii=False)
    return (
        "You MUST respond with ONLY a single valid JSON object (no markdown fences, no commentary) "
        f"strictly conforming to this JSON Schema:\n{schema_json}"
    )


_NON_TEXT_MODEL_PATTERNS = (
    "embedding",
    "whisper",
    "tts-",
    "dall-e",
    "moderation",
    "imagen",
    "veo-",
    "text-moderation",
    "audio-preview",
    "realtime",
    "transcribe",
    "aqa",
)


def infer_model_info(
    provider_id: LLMProviderId,
    model_id: str,
    *,
    source: str = "discovered",
    display_name: str | None = None,
    raw_meta: dict[str, Any] | None = None,
) -> AIModelInfo:
    """Build accurate capability metadata from API response + verified model traits."""
    mid = model_id.strip()
    low = mid.lower()
    meta = raw_meta or {}

    # Detect non-text / specialized models returned by /models APIs
    is_non_text = any(p in low for p in _NON_TEXT_MODEL_PATTERNS)
    if provider_id == "gemini" and isinstance(meta.get("supportedGenerationMethods"), list):
        methods = [str(m) for m in meta["supportedGenerationMethods"]]
        if "generateContent" not in methods:
            is_non_text = True

    supports_text = not is_non_text
    supports_json = supports_text

    # Context window from API metadata when available
    ctx: int | None = None
    for key in ("context_length", "context_window", "inputTokenLimit", "max_context_length"):
        val = meta.get(key)
        if isinstance(val, (int, float)) and val > 0:
            ctx = int(val)
            break
    if ctx is None:
        if "gemini-2" in low or "gemini-1.5" in low:
            ctx = 1_048_576
        elif "claude-3" in low or "claude-4" in low or "claude-sonnet-4" in low or "claude-opus-4" in low:
            ctx = 200_000
        elif "gpt-4.1" in low:
            ctx = 1_000_000
        elif "gpt-4o" in low or "o1" in low or "o3" in low or "o4" in low:
            ctx = 128_000
        elif "deepseek" in low:
            ctx = 64_000
        elif "llama-3.3" in low or "llama-3.1" in low or "llama3.1" in low:
            ctx = 128_000
        elif "mixtral-8x7b-32768" in low:
            ctx = 32_768

    # Vision capability
    supports_vision = False
    arch = meta.get("architecture")
    if isinstance(arch, dict):
        modality = str(arch.get("modality") or "").lower()
        input_mods = arch.get("input_modalities") or []
        if "image" in modality or (isinstance(input_mods, list) and "image" in input_mods):
            supports_vision = True
    if not supports_vision and supports_text:
        if any(
            tok in low
            for tok in (
                "gpt-4o",
                "gpt-4.1",
                "gpt-4-vision",
                "gpt-5",
                "claude-3",
                "claude-4",
                "claude-sonnet-4",
                "claude-opus-4",
                "gemini-1.5",
                "gemini-2",
                "gemini-3",
                "llava",
                "vision",
                "pixtral",
                "qwen2-vl",
                "qwen2.5-vl",
            )
        ):
            supports_vision = True

    # Reasoning capability
    supports_reasoning = any(
        tok in low
        for tok in (
            "o1",
            "o3",
            "o4-mini",
            "reasoner",
            "r1",
            "thinking",
            "gemini-2.5-pro",
            "gemini-2.5-flash",
            "claude-3-7",
            "claude-sonnet-4",
            "claude-opus-4",
            "qwq",
        )
    )

    # Tool / function calling support
    supports_tools = False
    supported_params = meta.get("supported_parameters")
    if isinstance(supported_params, list) and "tools" in supported_params:
        supports_tools = True
    elif supports_text and any(
        tok in low
        for tok in (
            "gpt-4",
            "gpt-5",
            "o3",
            "o4",
            "claude-3",
            "claude-4",
            "claude-sonnet-4",
            "claude-opus-4",
            "gemini-1.5",
            "gemini-2",
            "gemini-3",
            "deepseek-chat",
            "llama-3.3",
            "llama-3.1",
            "qwen2.5",
            "mistral",
        )
    ):
        supports_tools = True

    notes = ""
    if is_non_text:
        notes = "Non-chat / specialized model (not compatible with structured text JSON generation)."

    return AIModelInfo(
        model_id=mid,
        display_name=(display_name or meta.get("displayName") or meta.get("name") or mid).strip(),
        provider_id=provider_id,
        source=source,  # type: ignore[arg-type]
        context_length=ctx,
        supports_text=supports_text,
        supports_structured_json=supports_json,
        supports_vision=supports_vision,
        supports_reasoning=supports_reasoning,
        supports_tools=supports_tools,
        deprecated=bool(meta.get("deprecated", False)),
        notes=notes,
    )


class HTTPBaseLLMProvider(LLMProvider):
    """Shared retry, timeout, cancellation & Pydantic validation lifecycle for HTTP LLM adapters."""

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str,
        default_model: str,
        timeout_seconds: int = 60,
        max_retries: int = 2,
    ) -> None:
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.default_model = default_model
        self.timeout_seconds = max(5, timeout_seconds)
        self.max_retries = max(0, max_retries)

    async def _raw_request(
        self,
        *,
        prompt: str,
        system_prompt: str,
        model: str,
        schema: type[BaseModel],
    ) -> str:
        raise NotImplementedError

    async def generate_structured(
        self,
        prompt: str,
        schema: type[TModel],
        system_prompt: str | None = None,
        model: str | None = None,
        cancel_event: asyncio.Event | None = None,
    ) -> TModel:
        resolved_model = (model or self.default_model).strip()
        full_system = ((system_prompt or "").strip() + "\n\n" + _build_schema_instruction(schema)).strip()

        last_err: Exception | None = None
        attempts = self.max_retries + 1

        for attempt in range(attempts):
            if cancel_event and cancel_event.is_set():
                raise LLMCancelledError("AI task was cancelled.")
            try:
                raw_text = await self._raw_request(
                    prompt=prompt,
                    system_prompt=full_system,
                    model=resolved_model,
                    schema=schema,
                )
                if cancel_event and cancel_event.is_set():
                    raise LLMCancelledError("AI task was cancelled.")
                data = extract_json_object(raw_text)
                return schema.model_validate(data)
            except LLMCancelledError:
                raise
            except ValidationError as exc:
                last_err = LLMMalformedResponseError(
                    f"AI response failed schema validation: {exc.errors()[0].get('msg', str(exc))}"
                )
                logger.warning("LLM schema validation failed (attempt %d/%d): %s", attempt + 1, attempts, last_err)
            except LLMMalformedResponseError as exc:
                last_err = exc
                logger.warning("LLM malformed JSON (attempt %d/%d): %s", attempt + 1, attempts, exc)
            except httpx.TimeoutException as exc:
                last_err = LLMTimeoutError(
                    f"AI provider timed out after {self.timeout_seconds}s: {exc}"
                )
                logger.warning("LLM request timed out (attempt %d/%d)", attempt + 1, attempts)
            except httpx.HTTPStatusError as exc:
                code = exc.response.status_code
                body_preview = exc.response.text[:240].strip()
                last_err = LLMProviderError(f"AI provider HTTP {code}: {body_preview}")
                if code in (400, 401, 403, 404):
                    raise last_err from exc
                logger.warning("LLM transient HTTP %d (attempt %d/%d)", code, attempt + 1, attempts)
            except httpx.RequestError as exc:
                last_err = LLMProviderError(f"Could not connect to AI provider ({self.base_url}): {exc}")
                logger.warning("LLM connection error (attempt %d/%d): %s", attempt + 1, attempts, exc)

            if attempt + 1 < attempts:
                await asyncio.sleep(min(4.0, 0.8 * (2**attempt)))

        assert last_err is not None
        raise last_err


class OpenAILLMProvider(HTTPBaseLLMProvider):
    """OpenAI-protocol Chat Completions adapter (OpenAI, DeepSeek, OpenRouter, Groq)."""

    def __init__(
        self,
        *,
        provider_label: str = "OpenAI",
        api_key: str = "",
        base_url: str = PROVIDER_CATALOG["openai"]["default_base_url"],
        default_model: str = PROVIDER_CATALOG["openai"]["default_model"],
        timeout_seconds: int = 60,
        max_retries: int = 2,
        extra_headers: dict[str, str] | None = None,
        require_api_key: bool = True,
    ) -> None:
        super().__init__(
            api_key=api_key,
            base_url=base_url,
            default_model=default_model,
            timeout_seconds=timeout_seconds,
            max_retries=max_retries,
        )
        self.provider_label = provider_label
        self.extra_headers = extra_headers or {}
        self.require_api_key = require_api_key

    async def _raw_request(
        self,
        *,
        prompt: str,
        system_prompt: str,
        model: str,
        schema: type[BaseModel],
    ) -> str:
        if self.require_api_key and not self.api_key:
            raise LLMNotConfiguredError(
                f"{self.provider_label} API key is not configured. Configure it in Settings -> AI Provider."
            )
        if not self.base_url:
            raise LLMNotConfiguredError(f"Base URL is required for {self.provider_label}.")
        payload: dict[str, Any] = {
            "model": model,
            "temperature": 0.2,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": prompt},
            ],
        }
        # Reasoning models (o1/o3/deepseek-reasoner) may reject response_format or temperature
        low_model = model.lower()
        if "reasoner" not in low_model and not low_model.startswith(("o1", "o3", "o4")):
            payload["response_format"] = {"type": "json_object"}
        else:
            payload.pop("temperature", None)

        headers: dict[str, str] = {"Content-Type": "application/json", **self.extra_headers}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
            resp = await client.post(
                f"{self.base_url}/chat/completions",
                headers=headers,
                json=payload,
            )
            resp.raise_for_status()
            body = resp.json()
        choices = body.get("choices") or []
        if not choices:
            raise LLMMalformedResponseError(f"{self.provider_label} response contained no choices.")
        content = choices[0].get("message", {}).get("content", "")
        if not isinstance(content, str):
            raise LLMMalformedResponseError(f"{self.provider_label} response content was not a string.")
        return content


class AnthropicLLMProvider(HTTPBaseLLMProvider):
    """Anthropic Messages API adapter (`POST /v1/messages`)."""

    def __init__(
        self,
        *,
        api_key: str = "",
        base_url: str = PROVIDER_CATALOG["anthropic"]["default_base_url"],
        default_model: str = PROVIDER_CATALOG["anthropic"]["default_model"],
        timeout_seconds: int = 60,
        max_retries: int = 2,
    ) -> None:
        super().__init__(
            api_key=api_key,
            base_url=base_url,
            default_model=default_model,
            timeout_seconds=timeout_seconds,
            max_retries=max_retries,
        )

    async def _raw_request(
        self,
        *,
        prompt: str,
        system_prompt: str,
        model: str,
        schema: type[BaseModel],
    ) -> str:
        if not self.api_key:
            raise LLMNotConfiguredError(
                "Anthropic API key is not configured. Set ANTHROPIC_API_KEY / AMCS_ANTHROPIC_API_KEY or configure it in Settings -> AI Provider."
            )
        endpoint = (
            f"{self.base_url}/messages"
            if self.base_url.endswith("/v1")
            else f"{self.base_url}/v1/messages"
        )
        payload = {
            "model": model,
            "max_tokens": 4096,
            "temperature": 0.2,
            "system": system_prompt,
            "messages": [{"role": "user", "content": prompt}],
        }
        headers = {
            "x-api-key": self.api_key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        }
        async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
            resp = await client.post(endpoint, headers=headers, json=payload)
            resp.raise_for_status()
            body = resp.json()
        blocks = body.get("content") or []
        texts = [
            str(b.get("text", ""))
            for b in blocks
            if isinstance(b, dict) and b.get("type") == "text" and b.get("text")
        ]
        if not texts:
            raise LLMMalformedResponseError("Anthropic response contained no text blocks.")
        return "\n".join(texts)


class GeminiLLMProvider(HTTPBaseLLMProvider):
    """Google Gemini REST API adapter using native JSON mime-type structured output."""

    def __init__(
        self,
        *,
        api_key: str = "",
        base_url: str = PROVIDER_CATALOG["gemini"]["default_base_url"],
        default_model: str = PROVIDER_CATALOG["gemini"]["default_model"],
        timeout_seconds: int = 60,
        max_retries: int = 2,
    ) -> None:
        super().__init__(
            api_key=api_key,
            base_url=base_url,
            default_model=default_model,
            timeout_seconds=timeout_seconds,
            max_retries=max_retries,
        )

    async def _raw_request(
        self,
        *,
        prompt: str,
        system_prompt: str,
        model: str,
        schema: type[BaseModel],
    ) -> str:
        if not self.api_key:
            raise LLMNotConfiguredError(
                "Google Gemini API key is not configured. Set GEMINI_API_KEY / AMCS_GEMINI_API_KEY or configure it in Settings -> AI Provider."
            )
        clean_model = model[7:] if model.startswith("models/") else model
        url = f"{self.base_url}/models/{clean_model}:generateContent"
        payload = {
            "systemInstruction": {"parts": [{"text": system_prompt}]},
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": 0.2,
                "responseMimeType": "application/json",
            },
        }
        async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
            resp = await client.post(
                url,
                params={"key": self.api_key},
                headers={"Content-Type": "application/json"},
                json=payload,
            )
            resp.raise_for_status()
            body = resp.json()

        candidates = body.get("candidates") or []
        if not candidates:
            raise LLMMalformedResponseError("Gemini response contained no candidates.")
        parts = candidates[0].get("content", {}).get("parts") or []
        texts = [p.get("text", "") for p in parts if isinstance(p, dict) and p.get("text")]
        if not texts:
            raise LLMMalformedResponseError("Gemini response contained no text parts.")
        return "\n".join(texts)


class OpenAICompatibleLLMProvider(OpenAILLMProvider):
    """Adapter for local/custom OpenAI-compatible endpoints (Ollama, LM Studio, vLLM)."""

    def __init__(
        self,
        *,
        api_key: str = "",
        base_url: str = PROVIDER_CATALOG["openai_compatible"]["default_base_url"],
        default_model: str = PROVIDER_CATALOG["openai_compatible"]["default_model"],
        timeout_seconds: int = 60,
        max_retries: int = 2,
    ) -> None:
        super().__init__(
            provider_label="OpenAI-Compatible / Local LLM",
            api_key=api_key,
            base_url=base_url,
            default_model=default_model,
            timeout_seconds=timeout_seconds,
            max_retries=max_retries,
            require_api_key=False,
        )


class LLMProviderRegistry:
    """Manages AI provider settings, live model discovery/caching, compatibility, and per-feature overrides."""

    def __init__(self, config: AppConfig, library_repo: LibraryRepository) -> None:
        self.config = config
        self.library_repo = library_repo
        self._override_provider: LLMProvider | None = None

    def set_override_provider(self, provider: LLMProvider | None) -> None:
        """Allow deterministic dependency injection in unit/integration tests."""
        self._override_provider = provider

    def _raw_saved_settings(self) -> dict[str, Any]:
        return self.library_repo.get_app_setting(SETTINGS_KEY) or {}

    def _raw_model_cache(self) -> dict[str, Any]:
        val = self.library_repo.get_app_setting(MODEL_CACHE_KEY)
        return val if isinstance(val, dict) else {}

    def _save_model_cache_entry(
        self,
        provider_id: LLMProviderId,
        models: list[AIModelInfo],
        fetched_at: str,
    ) -> None:
        cache = dict(self._raw_model_cache())
        cache[provider_id] = {
            "fetched_at": fetched_at,
            "models": [m.model_dump(mode="json") for m in models],
        }
        self.library_repo.set_app_setting(MODEL_CACHE_KEY, cache)

    def _resolve_api_key(self, provider_id: LLMProviderId, saved: dict[str, Any]) -> tuple[str, str]:
        """Return (api_key, source) checking saved settings first, then environment variables."""
        saved_keys = saved.get("api_keys") if isinstance(saved.get("api_keys"), dict) else {}
        if isinstance(saved_keys.get(provider_id), str) and saved_keys[provider_id].strip():
            return saved_keys[provider_id].strip(), "settings"

        if provider_id == "openai" and self.config.openai_api_key:
            return self.config.openai_api_key.strip(), "env"
        if provider_id == "gemini" and self.config.gemini_api_key:
            return self.config.gemini_api_key.strip(), "env"

        cat = PROVIDER_CATALOG[provider_id]
        for env_name in cat.get("env_vars", []):
            env_val = (os.getenv(env_name) or "").strip()
            if env_val:
                return env_val, "env"
        return "", "none"

    def _resolve_provider_model(self, provider_id: LLMProviderId, saved: dict[str, Any]) -> str:
        cat = PROVIDER_CATALOG[provider_id]
        per_provider = saved.get("provider_models")
        if isinstance(per_provider, dict) and isinstance(per_provider.get(provider_id), str):
            val = per_provider[provider_id].strip()
            if val:
                return val
        if saved.get("provider_id") == provider_id and isinstance(saved.get("model"), str) and saved["model"].strip():
            return saved["model"].strip()
        if self.config.ai_provider == provider_id and self.config.ai_model:
            return self.config.ai_model.strip()
        return str(cat["default_model"])

    def _resolve_provider_base_url(self, provider_id: LLMProviderId, saved: dict[str, Any]) -> str:
        cat = PROVIDER_CATALOG[provider_id]
        per_provider = saved.get("provider_base_urls")
        if isinstance(per_provider, dict) and isinstance(per_provider.get(provider_id), str):
            val = per_provider[provider_id].strip()
            if val:
                return val
        if saved.get("provider_id") == provider_id and isinstance(saved.get("base_url"), str) and saved["base_url"].strip():
            return saved["base_url"].strip()
        if self.config.ai_provider == provider_id and self.config.ai_base_url:
            return self.config.ai_base_url.strip()
        return str(cat["default_base_url"])

    def _resolve_feature_models(self, saved: dict[str, Any]) -> dict[str, FeatureModelOverride]:
        raw = saved.get("feature_models")
        out: dict[str, FeatureModelOverride] = {}
        if isinstance(raw, dict):
            for k, v in raw.items():
                if k in ALL_FEATURE_KEYS and isinstance(v, dict):
                    pid = v.get("provider_id")
                    mod = v.get("model")
                    if pid is not None and pid not in PROVIDER_CATALOG:
                        pid = None
                    out[k] = FeatureModelOverride(
                        provider_id=pid,
                        model=(str(mod).strip() or None) if mod is not None else None,
                    )
        return out

    def get_public_config(self) -> AIProviderConfig:
        saved = self._raw_saved_settings()
        raw_pid = saved.get("provider_id") or self.config.ai_provider or "openai"
        provider_id: LLMProviderId = raw_pid if raw_pid in PROVIDER_CATALOG else "openai"

        model = self._resolve_provider_model(provider_id, saved)
        base_url = self._resolve_provider_base_url(provider_id, saved)
        api_key, key_source = self._resolve_api_key(provider_id, saved)

        provider_models = {
            pid: self._resolve_provider_model(pid, saved) for pid in PROVIDER_CATALOG
        }
        provider_base_urls = {
            pid: self._resolve_provider_base_url(pid, saved) for pid in PROVIDER_CATALOG
        }

        return AIProviderConfig(
            provider_id=provider_id,
            model=model,
            base_url=base_url,
            api_key_configured=bool(api_key)
            or not PROVIDER_CATALOG[provider_id]["requires_key"]
            or self._override_provider is not None,
            api_key_masked=mask_api_key(api_key),
            api_key_source=key_source,  # type: ignore[arg-type]
            timeout_seconds=int(saved.get("timeout_seconds", 60)),
            max_retries=int(saved.get("max_retries", 2)),
            analysis_language=saved.get("analysis_language", "auto"),
            max_chunk_chars=int(saved.get("max_chunk_chars", 6000)),
            provider_models=provider_models,
            provider_base_urls=provider_base_urls,
            feature_models=self._resolve_feature_models(saved),
        )

    def update_config(self, patch: AIProviderConfigUpdate) -> AIProviderConfig:
        saved = dict(self._raw_saved_settings())
        api_keys = dict(saved.get("api_keys") or {}) if isinstance(saved.get("api_keys"), dict) else {}
        provider_models = (
            dict(saved.get("provider_models") or {})
            if isinstance(saved.get("provider_models"), dict)
            else {}
        )
        provider_base_urls = (
            dict(saved.get("provider_base_urls") or {})
            if isinstance(saved.get("provider_base_urls"), dict)
            else {}
        )

        prev_pid: LLMProviderId = (
            saved.get("provider_id")
            if saved.get("provider_id") in PROVIDER_CATALOG
            else "openai"
        )
        next_pid: LLMProviderId = patch.provider_id or prev_pid
        cat = PROVIDER_CATALOG[next_pid]

        # Preserve previous provider's model/base_url before switching so switching never corrupts config
        if prev_pid not in provider_models and isinstance(saved.get("model"), str) and saved["model"].strip():
            provider_models[prev_pid] = saved["model"].strip()
        if prev_pid not in provider_base_urls and isinstance(saved.get("base_url"), str) and saved["base_url"].strip():
            provider_base_urls[prev_pid] = saved["base_url"].strip()

        saved["provider_id"] = next_pid

        if patch.model is not None and patch.model.strip():
            chosen_model = patch.model.strip()
            provider_models[next_pid] = chosen_model
            saved["model"] = chosen_model
        else:
            saved["model"] = provider_models.get(next_pid) or cat["default_model"]

        if patch.base_url is not None:
            chosen_url = patch.base_url.strip() or cat["default_base_url"]
            provider_base_urls[next_pid] = chosen_url
            saved["base_url"] = chosen_url
        else:
            saved["base_url"] = provider_base_urls.get(next_pid) or cat["default_base_url"]

        if patch.clear_api_key:
            api_keys.pop(next_pid, None)
        elif patch.api_key is not None and patch.api_key.strip():
            api_keys[next_pid] = patch.api_key.strip()

        saved["api_keys"] = api_keys
        saved["provider_models"] = provider_models
        saved["provider_base_urls"] = provider_base_urls

        if patch.timeout_seconds is not None:
            saved["timeout_seconds"] = patch.timeout_seconds
        if patch.max_retries is not None:
            saved["max_retries"] = patch.max_retries
        if patch.analysis_language is not None:
            saved["analysis_language"] = patch.analysis_language
        if patch.max_chunk_chars is not None:
            saved["max_chunk_chars"] = patch.max_chunk_chars
        if patch.feature_models is not None:
            existing_fm = dict(saved.get("feature_models") or {}) if isinstance(saved.get("feature_models"), dict) else {}
            for fkey, ov in patch.feature_models.items():
                if fkey not in ALL_FEATURE_KEYS:
                    continue
                if ov.provider_id is None and (ov.model is None or not ov.model.strip()):
                    existing_fm.pop(fkey, None)
                else:
                    existing_fm[fkey] = {
                        "provider_id": ov.provider_id,
                        "model": ov.model.strip() if ov.model else None,
                    }
            saved["feature_models"] = existing_fm

        self.library_repo.set_app_setting(SETTINGS_KEY, saved)
        return self.get_public_config()

    def update_feature_models(
        self,
        feature_models: dict[str, FeatureModelOverride],
    ) -> AIProviderConfig:
        return self.update_config(AIProviderConfigUpdate(feature_models=feature_models))

    def _catalog_models_for_provider(self, provider_id: LLMProviderId) -> list[AIModelInfo]:
        cat = PROVIDER_CATALOG[provider_id]
        return [
            infer_model_info(provider_id, m, source="catalog")
            for m in cat["suggested_models"]
        ]

    def get_cached_models(self, provider_id: LLMProviderId) -> tuple[list[AIModelInfo], str | None]:
        cache = self._raw_model_cache()
        entry = cache.get(provider_id)
        if not isinstance(entry, dict):
            return [], None
        raw_models = entry.get("models")
        if not isinstance(raw_models, list):
            return [], None
        parsed: list[AIModelInfo] = []
        for item in raw_models:
            try:
                parsed.append(AIModelInfo.model_validate(item))
            except Exception:
                continue
        return parsed, entry.get("fetched_at")

    async def discover_models(
        self,
        provider_id: LLMProviderId,
        *,
        force_refresh: bool = False,
    ) -> AIModelDiscoveryResult:
        """Fetch live models available to the user's account for the provider (with safe caching & honest error handling)."""
        if provider_id not in PROVIDER_CATALOG:
            raise ValueError(f"Unsupported AI provider: {provider_id}")

        saved = self._raw_saved_settings()
        cat = PROVIDER_CATALOG[provider_id]
        api_key, _ = self._resolve_api_key(provider_id, saved)
        base_url = self._resolve_provider_base_url(provider_id, saved).rstrip("/")
        selected_model = self._resolve_provider_model(provider_id, saved)
        timeout = min(20, int(saved.get("timeout_seconds", 60)))

        # Return cached discovered models if not forcing refresh
        if not force_refresh:
            cached, fetched_at = self.get_cached_models(provider_id)
            if cached:
                valid, warning = self._validate_selected_in_list(selected_model, cached)
                return AIModelDiscoveryResult(
                    provider_id=provider_id,
                    models=cached,
                    source="cache",
                    discovered_count=len(cached),
                    fetched_at=fetched_at,
                    selected_model_valid=valid,
                    selected_model_warning=warning,
                )

        # If provider requires API key and none is configured, return honest status + reference catalog (clearly marked as 'catalog')
        if cat["requires_key"] and not api_key:
            catalog_list = self._catalog_models_for_provider(provider_id)
            return AIModelDiscoveryResult(
                provider_id=provider_id,
                models=catalog_list,
                source="catalog_fallback",
                discovered_count=0,
                fetched_at=None,
                error=f"{cat['display_name']} API key is not configured. Showing reference catalog only — enter an API key to discover account models.",
                error_code="missing_credentials",
                selected_model_valid=True,
                selected_model_warning="",
            )

        # Perform live API discovery
        try:
            discovered = await self._fetch_live_models(
                provider_id=provider_id,
                base_url=base_url,
                api_key=api_key,
                timeout=timeout,
            )
            now = utc_now_iso()
            self._save_model_cache_entry(provider_id, discovered, now)
            valid, warning = self._validate_selected_in_list(selected_model, discovered)
            return AIModelDiscoveryResult(
                provider_id=provider_id,
                models=discovered,
                source="live_api",
                discovered_count=len(discovered),
                fetched_at=now,
                error=None,
                error_code="none",
                selected_model_valid=valid,
                selected_model_warning=warning,
            )
        except httpx.HTTPStatusError as exc:
            code = exc.response.status_code
            preview = exc.response.text[:220].strip()
            if code in (401, 403):
                err_code = "invalid_credentials"
                msg = f"Authentication failed (HTTP {code}) for {cat['display_name']}. Verify your API key."
            elif code == 429:
                err_code = "rate_limited"
                msg = f"Rate limit reached (HTTP 429) while querying {cat['display_name']} models. Please retry shortly."
            else:
                err_code = "http_error"
                msg = f"{cat['display_name']} model discovery returned HTTP {code}: {preview}"
            logger.warning("Model discovery HTTP error for %s: %s", provider_id, msg)
            return self._discovery_error_result(provider_id, selected_model, msg, err_code)
        except httpx.TimeoutException:
            msg = f"Model discovery timed out after {timeout}s for {cat['display_name']} ({base_url})."
            logger.warning(msg)
            return self._discovery_error_result(provider_id, selected_model, msg, "network_error")
        except httpx.RequestError as exc:
            msg = f"Network error connecting to {cat['display_name']} ({base_url}): {exc}"
            logger.warning(msg)
            return self._discovery_error_result(provider_id, selected_model, msg, "network_error")
        except Exception as exc:
            msg = f"Unexpected error discovering models for {cat['display_name']}: {exc}"
            logger.warning(msg)
            return self._discovery_error_result(provider_id, selected_model, msg, "http_error")

    def _discovery_error_result(
        self,
        provider_id: LLMProviderId,
        selected_model: str,
        error_msg: str,
        error_code: str,
    ) -> AIModelDiscoveryResult:
        # On error, return cached models if previously discovered (do NOT claim fresh discovery); otherwise empty (honest!)
        cached, fetched_at = self.get_cached_models(provider_id)
        if cached:
            valid, warning = self._validate_selected_in_list(selected_model, cached)
            return AIModelDiscoveryResult(
                provider_id=provider_id,
                models=cached,
                source="cache",
                discovered_count=len(cached),
                fetched_at=fetched_at,
                error=error_msg,
                error_code=error_code,  # type: ignore[arg-type]
                selected_model_valid=valid,
                selected_model_warning=warning,
            )
        return AIModelDiscoveryResult(
            provider_id=provider_id,
            models=[],
            source="catalog_fallback",
            discovered_count=0,
            fetched_at=None,
            error=error_msg,
            error_code=error_code,  # type: ignore[arg-type]
            selected_model_valid=True,
            selected_model_warning="",
        )

    def _validate_selected_in_list(
        self,
        selected_model: str,
        models: list[AIModelInfo],
    ) -> tuple[bool, str]:
        if not selected_model or not models:
            return True, ""
        ids = {m.model_id for m in models}
        if selected_model in ids:
            return True, ""
        return (
            False,
            f"Selected model '{selected_model}' was not returned by the provider's available model list. Your selection was preserved, but execution may fail unless you choose an available model.",
        )

    async def _fetch_live_models(
        self,
        *,
        provider_id: LLMProviderId,
        base_url: str,
        api_key: str,
        timeout: int,
    ) -> list[AIModelInfo]:
        protocol = PROVIDER_CATALOG[provider_id]["discovery_protocol"]
        async with httpx.AsyncClient(timeout=timeout) as client:
            if protocol == "gemini":
                resp = await client.get(
                    f"{base_url}/models",
                    params={"key": api_key, "pageSize": 100},
                )
                resp.raise_for_status()
                body = resp.json()
                raw_list = body.get("models") or []
                models: list[AIModelInfo] = []
                for item in raw_list:
                    if not isinstance(item, dict):
                        continue
                    raw_name = str(item.get("name") or "").strip()
                    if not raw_name:
                        continue
                    mid = raw_name[7:] if raw_name.startswith("models/") else raw_name
                    models.append(
                        infer_model_info(
                            provider_id,
                            mid,
                            source="discovered",
                            display_name=str(item.get("displayName") or mid),
                            raw_meta=item,
                        )
                    )
                models.sort(key=lambda m: (not m.supports_text, m.model_id))
                return models

            if protocol == "anthropic":
                endpoint = (
                    f"{base_url}/models"
                    if base_url.endswith("/v1")
                    else f"{base_url}/v1/models"
                )
                resp = await client.get(
                    endpoint,
                    headers={
                        "x-api-key": api_key,
                        "anthropic-version": "2023-06-01",
                    },
                    params={"limit": 100},
                )
                resp.raise_for_status()
                body = resp.json()
                raw_list = body.get("data") or []
                models = []
                for item in raw_list:
                    if not isinstance(item, dict) or not item.get("id"):
                        continue
                    models.append(
                        infer_model_info(
                            provider_id,
                            str(item["id"]),
                            source="discovered",
                            display_name=str(item.get("display_name") or item["id"]),
                            raw_meta=item,
                        )
                    )
                models.sort(key=lambda m: (not m.supports_text, m.model_id))
                return models

            # OpenAI / DeepSeek / OpenRouter / Groq / OpenAI-Compatible
            headers: dict[str, str] = {}
            if api_key:
                headers["Authorization"] = f"Bearer {api_key}"
            if provider_id == "openrouter":
                headers["HTTP-Referer"] = "https://automotion-comic-studio.local"
                headers["X-Title"] = "AutoMotion Comic Studio"

            try:
                resp = await client.get(f"{base_url}/models", headers=headers)
                resp.raise_for_status()
                body = resp.json()
                raw_list = body.get("data") or body.get("models") or []
            except httpx.HTTPStatusError:
                # Fallback for Ollama native /api/tags if base_url is localhost Ollama without /v1/models
                if protocol == "openai_compatible":
                    ollama_root = re.sub(r"/v1/?$", "", base_url)
                    resp = await client.get(f"{ollama_root}/api/tags")
                    resp.raise_for_status()
                    body = resp.json()
                    raw_list = body.get("models") or []
                else:
                    raise

            models = []
            seen: set[str] = set()
            for item in raw_list:
                if not isinstance(item, dict):
                    continue
                mid = str(item.get("id") or item.get("name") or "").strip()
                if not mid or mid in seen:
                    continue
                seen.add(mid)
                models.append(
                    infer_model_info(
                        provider_id,
                        mid,
                        source="discovered",
                        display_name=str(item.get("name") or mid),
                        raw_meta=item,
                    )
                )
            models.sort(key=lambda m: (not m.supports_text, m.model_id))
            return models

    def check_model_compatibility(self, req: ModelCompatibilityRequest) -> ModelCompatibilityResult:
        """Capability-aware compatibility check that explains incompatibility and suggests real alternatives."""
        cached, _ = self.get_cached_models(req.provider_id)
        pool = cached if cached else self._catalog_models_for_provider(req.provider_id)
        info = next((m for m in pool if m.model_id == req.model), None)
        if info is None:
            info = infer_model_info(req.provider_id, req.model, source="manual")

        reasons: list[str] = []
        if not info.supports_text or not info.supports_structured_json:
            reasons.append(
                f"Model '{req.model}' does not support structured text/JSON generation required for '{req.feature_key}'."
            )
        if req.requires_vision and not info.supports_vision:
            reasons.append(
                f"Model '{req.model}' does not advertise vision/image-input capability required for this operation."
            )
        if req.requires_tools and not info.supports_tools:
            reasons.append(
                f"Model '{req.model}' does not advertise tool/function-calling capability required for this operation."
            )
        if req.estimated_input_chars > 0 and info.context_length:
            # Conservative ~3.5 chars per token estimate
            est_tokens = int(req.estimated_input_chars / 3.5)
            if est_tokens > int(info.context_length * 0.85):
                reasons.append(
                    f"Estimated input (~{est_tokens:,} tokens) exceeds safe context limit for '{req.model}' ({info.context_length:,} tokens)."
                )

        compatible = len(reasons) == 0
        recommended: list[str] = []
        if not compatible:
            for cand in pool:
                if cand.model_id == req.model:
                    continue
                if not cand.supports_text or not cand.supports_structured_json:
                    continue
                if req.requires_vision and not cand.supports_vision:
                    continue
                if req.requires_tools and not cand.supports_tools:
                    continue
                if req.estimated_input_chars > 0 and cand.context_length:
                    if int(req.estimated_input_chars / 3.5) > int(cand.context_length * 0.85):
                        continue
                recommended.append(cand.model_id)
                if len(recommended) >= 5:
                    break

        return ModelCompatibilityResult(
            compatible=compatible,
            feature_key=req.feature_key,
            provider_id=req.provider_id,
            model=req.model,
            reasons=reasons,
            recommended_models=recommended,
        )

    def list_registry_info(self) -> AIProviderRegistryResponse:
        saved = self._raw_saved_settings()
        active_cfg = self.get_public_config()
        infos: list[AIProviderInfo] = []
        for pid, meta in PROVIDER_CATALOG.items():
            key, source = self._resolve_api_key(pid, saved)
            cached_models, fetched_at = self.get_cached_models(pid)
            sel_model = self._resolve_provider_model(pid, saved)
            saved_url = self._resolve_provider_base_url(pid, saved)

            if self._override_provider is not None and pid == active_cfg.provider_id:
                configured = True
                status_msg = "Connected via active test/injected provider."
            elif not meta["requires_key"]:
                configured = True
                status_msg = f"Endpoint: {saved_url} (local/custom server)"
            elif key:
                configured = True
                status_msg = f"API key configured via {source} ({mask_api_key(key)})"
            else:
                configured = False
                env_hint = meta["env_vars"][-1] if meta["env_vars"] else "API_KEY"
                status_msg = f"Missing API key. Set {env_hint} or save key in Settings -> AI Provider."

            infos.append(
                AIProviderInfo(
                    provider_id=pid,
                    display_name=meta["display_name"],
                    is_configured=configured,
                    api_key_masked=mask_api_key(key),
                    api_key_source=source,  # type: ignore[arg-type]
                    default_model=meta["default_model"],
                    selected_model=sel_model,
                    suggested_models=list(meta["suggested_models"]),
                    default_base_url=meta["default_base_url"],
                    saved_base_url=saved_url,
                    supports_model_discovery=True,
                    supports_structured_output=True,
                    context_limit_chars=meta["context_limit_chars"],
                    cached_models_count=len(cached_models),
                    last_discovered_at=fetched_at,
                    status_message=status_msg,
                )
            )
        return AIProviderRegistryResponse(
            config=active_cfg,
            providers=infos,
            feature_keys=list(ALL_FEATURE_KEYS),
        )

    def _build_provider(
        self,
        provider_id: LLMProviderId,
        model: str,
        saved: dict[str, Any],
        timeout_seconds: int,
        max_retries: int,
    ) -> LLMProvider:
        api_key, _ = self._resolve_api_key(provider_id, saved)
        base_url = self._resolve_provider_base_url(provider_id, saved)
        cat = PROVIDER_CATALOG[provider_id]

        if provider_id == "anthropic":
            return AnthropicLLMProvider(
                api_key=api_key,
                base_url=base_url or cat["default_base_url"],
                default_model=model,
                timeout_seconds=timeout_seconds,
                max_retries=max_retries,
            )
        if provider_id == "gemini":
            return GeminiLLMProvider(
                api_key=api_key,
                base_url=base_url or cat["default_base_url"],
                default_model=model,
                timeout_seconds=timeout_seconds,
                max_retries=max_retries,
            )
        if provider_id == "openai_compatible":
            return OpenAICompatibleLLMProvider(
                api_key=api_key,
                base_url=base_url or cat["default_base_url"],
                default_model=model,
                timeout_seconds=timeout_seconds,
                max_retries=max_retries,
            )
        extra_headers: dict[str, str] = {}
        if provider_id == "openrouter":
            extra_headers = {
                "HTTP-Referer": "https://automotion-comic-studio.local",
                "X-Title": "AutoMotion Comic Studio",
            }
        return OpenAILLMProvider(
            provider_label=cat["display_name"],
            api_key=api_key,
            base_url=base_url or cat["default_base_url"],
            default_model=model,
            timeout_seconds=timeout_seconds,
            max_retries=max_retries,
            extra_headers=extra_headers,
            require_api_key=bool(cat["requires_key"]),
        )

    def get_active_provider(self) -> tuple[LLMProvider, AIProviderConfig]:
        cfg = self.get_public_config()
        if self._override_provider is not None:
            return self._override_provider, cfg
        saved = self._raw_saved_settings()
        provider = self._build_provider(
            cfg.provider_id,
            cfg.model,
            saved,
            cfg.timeout_seconds,
            cfg.max_retries,
        )
        return provider, cfg

    def get_provider_for_feature(
        self,
        feature_key: AIFeatureKey,
        *,
        estimated_input_chars: int = 0,
        requires_vision: bool = False,
        requires_tools: bool = False,
    ) -> tuple[LLMProvider, AIProviderConfig]:
        """Resolve provider + model for a specific feature (respecting overrides and validating compatibility)."""
        cfg = self.get_public_config()
        saved = self._raw_saved_settings()
        override = cfg.feature_models.get(feature_key)

        target_pid: LLMProviderId = (
            override.provider_id if override and override.provider_id else cfg.provider_id
        )
        target_model = (
            override.model.strip()
            if override and override.model and override.model.strip()
            else (
                self._resolve_provider_model(target_pid, saved)
                if target_pid != cfg.provider_id
                else cfg.model
            )
        )

        # Compatibility gate — NEVER silently switch models!
        compat = self.check_model_compatibility(
            ModelCompatibilityRequest(
                feature_key=feature_key,
                provider_id=target_pid,
                model=target_model,
                estimated_input_chars=estimated_input_chars,
                requires_vision=requires_vision,
                requires_tools=requires_tools,
            )
        )
        if not compat.compatible:
            rec_hint = (
                f" Recommended compatible models: {', '.join(compat.recommended_models)}."
                if compat.recommended_models
                else ""
            )
            raise LLMIncompatibleModelError(
                " ".join(compat.reasons) + rec_hint,
                recommended_models=compat.recommended_models,
            )

        effective_cfg = cfg.model_copy(
            update={
                "provider_id": target_pid,
                "model": target_model,
                "base_url": self._resolve_provider_base_url(target_pid, saved),
            }
        )
        if self._override_provider is not None:
            return self._override_provider, effective_cfg

        provider = self._build_provider(
            target_pid,
            target_model,
            saved,
            cfg.timeout_seconds,
            cfg.max_retries,
        )
        return provider, effective_cfg

    async def test_active_provider(self) -> dict[str, Any]:
        """Perform a lightweight structured health check against the active AI provider."""

        class _PingSchema(BaseModel):
            ok: bool = True

        provider, cfg = self.get_active_provider()
        res = await provider.generate_structured(
            prompt='Return {"ok": true}.',
            schema=_PingSchema,
            system_prompt="Return only valid JSON.",
            model=cfg.model,
        )
        return {
            "ok": bool(res.ok),
            "provider_id": cfg.provider_id,
            "model": cfg.model,
        }
