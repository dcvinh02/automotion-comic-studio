"""Abstract AI provider adapters prepared for v0.2–v0.4.

Per Master Technical Specification v2.0 Section 2.3:
- LLM: OpenAI API with Structured Outputs / JSON Schema (v0.2/v0.3)
- TTS: F5-TTS primary, Fish Audio / Edge-TTS alternatives (v0.2)
- Semantic Search: multilingual-e5-small (v0.3)

Version 0.1 runs 100% deterministically without requiring external AI keys.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any, TypeVar
from pydantic import BaseModel

TModel = TypeVar("TModel", bound=BaseModel)


class LLMProvider(ABC):
    """Unified interface for structured LLM generation."""

    @abstractmethod
    async def generate_structured(
        self,
        prompt: str,
        schema: type[TModel],
        system_prompt: str | None = None,
        model: str | None = None,
    ) -> TModel:
        raise NotImplementedError


class TTSProvider(ABC):
    """Unified interface for multi-character voice generation (F5-TTS, Fish Audio, Edge-TTS)."""

    @abstractmethod
    async def synthesize(
        self,
        text: str,
        voice_profile: dict[str, Any],
        output_path: Path,
    ) -> dict[str, Any]:
        raise NotImplementedError


class EmbeddingProvider(ABC):
    """Unified interface for multilingual-e5-small semantic asset suggestions."""

    @abstractmethod
    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        raise NotImplementedError
