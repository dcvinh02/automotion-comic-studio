"""Phase 06 Batch 1 integration & resilience tests — Script Intelligence Engine & Scene Breakdown.

Covers all Section 15 test categories:
1. Short script analysis, hash caching, force re-analysis & persistence across restart
2. Long multi-chunk script analysis with rolling context, cross-chunk consolidation & global synthesis
3. Edge cases: empty script (400), binary/invalid script (400), multilingual VI+EN, unnamed characters
4. Character extraction, conservative alias resolution, cross-character ambiguity detection,
   unspecified appearance grounding, unresolved speakers & non-duplicating Library linking
5. Single-scene regeneration strictly preserving `user_edited_fields`
6. Real LLM provider adapters (OpenAI, Gemini, OpenAI-compatible): unconfigured error (400),
   masked key persistence, HTTP error retry recovery, malformed JSON retry/failure, timeout (504),
   and cancellation (499)
7. Safe SQLite v3 -> v4 migration without losing existing project data or raw script text
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import AppConfig
from app.main import create_app
from providers.interfaces import LLMProvider
from providers.llm_provider import (
    GeminiLLMProvider,
    LLMCancelledError,
    LLMMalformedResponseError,
    LLMNotConfiguredError,
    LLMTimeoutError,
    OpenAICompatibleLLMProvider,
    OpenAILLMProvider,
)


def _make_app_client(tmp_path: Path, workspace_name: str = "workspace"):
    cfg = AppConfig(workspace_dir=tmp_path / workspace_name, auth_token="phase06-secret")
    app = create_app(cfg)
    return app, TestClient(app), {"X-AMCS-Token": "phase06-secret"}, cfg


class DeterministicScriptLLM(LLMProvider):
    """Deterministic test double implementing `LLMProvider` for end-to-end backend tests."""

    def __init__(self, handler):
        self.handler = handler
        self.calls: list[dict[str, Any]] = []

    async def generate_structured(
        self,
        prompt: str,
        schema: type,
        *,
        system_prompt: str = "",
        model: str | None = None,
        cancel_event: asyncio.Event | None = None,
    ):
        self.calls.append(
            {"prompt": prompt, "schema": schema.__name__, "system_prompt": system_prompt, "model": model}
        )
        if cancel_event is not None and cancel_event.is_set():
            raise LLMCancelledError("Analysis cancelled by user.")
        payload = self.handler(prompt, schema.__name__, len(self.calls), cancel_event)
        if asyncio.iscoroutine(payload):
            payload = await payload
        return schema.model_validate(payload)


def noir_analysis_payload() -> dict:
    """Deterministic _LLMChunkAnalysisResult payload (shared with Phase 09.1 integration tests)."""
    return {
        "story_overview": {
            "title": "Con Hẻm Đêm Mưa",
            "genre": "Mystery / Noir",
            "premise": "Hai người đối mặt trong con hẻm mưa trước một giọng nói bí ẩn.",
            "synopsis": "Minh Anh ngăn Tuấn Anh tiến sâu hơn trước khi một giọng lạ xuất hiện.",
            "themes": ["Cảnh giác", "Bí ẩn"],
            "narrative_tone": "Căng thẳng",
            "story_structure": "Mở đầu bí ẩn",
            "structure_uncertainty": "Đoạn trích ngắn, chưa rõ kết cục.",
            "conflict": "Minh Anh muốn dừng lại còn Tuấn Anh muốn tiếp tục.",
            "turning_points": ["Giọng lạ vang lên từ bóng tối"],
            "climax": "Sự xuất hiện của giọng lạ",
            "ending": "Bỏ ngỏ",
            "narrative_beats": [
                {
                    "stage": "introduction",
                    "label": "Thiết lập hẻm mưa",
                    "summary": "Minh Anh chờ dưới mái hiên.",
                    "source_paragraphs": [0],
                    "uncertainty_note": "",
                    "confidence": 0.9,
                }
            ],
        },
        "production_analysis": {
            "visual_opportunities": ["Ánh đèn neon phản chiếu trên vũng nước"],
            "action_moments": ["Tuấn Anh bước tới"],
            "emotional_beats": ["Lời cảnh báo gấp gáp của Minh Anh"],
            "dramatic_pauses": ["Khoảng lặng trước giọng lạ"],
            "establishing_shots": ["Toàn cảnh con hẻm mưa đêm"],
            "environmental_details": ["Mưa đêm", "Mái hiên", "Đèn neon"],
            "transition_ideas": ["Cắt nhanh sang bóng tối"],
            "vfx_scenes": ["Hạt mưa rơi dưới ánh đèn neon"],
        },
        "characters": [
            {
                "canonical_name": "Minh Anh",
                "aliases": ["Minh", "Anh"],
                "ambiguous_aliases": [],
                "role": "Người cảnh báo",
                "personality": "Thận trọng",
                "appearance_description": "unspecified",
                "appearance_specified": False,
                "relationships": [
                    {
                        "target_name": "Tuấn Anh",
                        "relationship_type": "Đồng hành",
                        "description": "Cố gắng ngăn cản Tuấn Anh",
                    }
                ],
                "narrative_importance": "main",
                "emotional_states": ["Lo lắng"],
                "actions": ["Đứng dưới mái hiên"],
                "confidence": 0.93,
                "notes": "",
            },
            {
                "canonical_name": "Tuấn Anh",
                "aliases": ["Anh"],
                "ambiguous_aliases": [],
                "role": "Người kiên quyết",
                "personality": "Quyết đoán",
                "appearance_description": "unspecified",
                "appearance_specified": False,
                "relationships": [],
                "narrative_importance": "main",
                "emotional_states": ["Kiên định"],
                "actions": ["Bước tới dưới đèn neon"],
                "confidence": 0.9,
                "notes": "",
            },
        ],
        "extracted_items": [
            {
                "item_type": "narration",
                "original_text": "Mưa đêm rơi xuống con hẻm nhỏ. Minh Anh đứng lặng dưới mái hiên.",
                "speaker_name_raw": "",
                "speaker_unresolved": False,
                "paragraph_index": 0,
                "language": "vi",
                "emotion": "tense",
                "notes": "",
            },
            {
                "item_type": "dialogue",
                "original_text": "Đừng đi tiếp nữa, Tuấn Anh!",
                "speaker_name_raw": "Minh",
                "speaker_unresolved": False,
                "paragraph_index": 1,
                "language": "vi",
                "emotion": "urgent",
                "notes": "",
            },
            {
                "item_type": "dialogue",
                "original_text": "We have no choice tonight.",
                "speaker_name_raw": "Tuấn Anh",
                "speaker_unresolved": False,
                "paragraph_index": 2,
                "language": "en",
                "emotion": "determined",
                "notes": "",
            },
            {
                "item_type": "dialogue",
                "original_text": "Ai đang ở đó?",
                "speaker_name_raw": "Giọng lạ",
                "speaker_unresolved": True,
                "paragraph_index": 3,
                "language": "vi",
                "emotion": "suspense",
                "notes": "Unidentified voice from darkness",
            },
        ],
        "scenes": [
            {
                "title": "Hẻm Mưa & Lời Cảnh Báo",
                "source_paragraphs": [0, 1],
                "location": "Con hẻm nhỏ",
                "time_of_day": "Đêm",
                "environment": "Mưa đêm, mái hiên",
                "characters_present": ["Minh", "Tuấn Anh"],
                "character_entrances": ["Minh Anh"],
                "character_exits": [],
                "main_action": "Minh Anh cảnh báo Tuấn Anh dưới mưa.",
                "emotional_beat": "Lo âu căng thẳng",
                "scene_purpose": "Mở đầu xung đột",
                "conflict": "Tranh luận có nên đi tiếp",
                "visual_opportunities": ["Mưa hắt dưới mái hiên"],
                "atmosphere": "Noir ẩm ướt",
                "suggested_duration_min_s": 7,
                "suggested_duration_max_s": 12,
                "importance": "high",
                "transition_suggestion": "Cut",
                "ai_confidence": 0.91,
                "unresolved_questions": [],
            },
            {
                "title": "Giọng Nói Trong Bóng Tối",
                "source_paragraphs": [2, 3],
                "location": "Con hẻm nhỏ",
                "time_of_day": "Đêm",
                "environment": "Ánh đèn neon và bóng tối",
                "characters_present": ["Tuấn Anh"],
                "character_entrances": ["Tuấn Anh"],
                "character_exits": [],
                "main_action": "Tuấn Anh khẳng định không còn lựa chọn rồi nghe giọng lạ.",
                "emotional_beat": "Bất ngờ cảnh giác",
                "scene_purpose": "Đẩy cao kịch tính",
                "conflict": "Người lạ ẩn mình",
                "visual_opportunities": ["Ánh neon hắt lên vai"],
                "atmosphere": "Bí ẩn",
                "suggested_duration_min_s": 6,
                "suggested_duration_max_s": 11,
                "importance": "climax",
                "transition_suggestion": "Fade",
                "ai_confidence": 0.85,
                "unresolved_questions": ["Danh tính giọng lạ là ai?"],
            },
        ],
        "rolling_summary": "Minh Anh warns Tuấn Anh; unknown voice speaks.",
        "warnings": [],
    }


def test_unconfigured_provider_returns_actionable_error_and_config_masks_keys(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    # Ensure no ambient API key env vars interfere
    for var in ("OPENAI_API_KEY", "AMCS_OPENAI_API_KEY", "GEMINI_API_KEY", "AMCS_GEMINI_API_KEY"):
        monkeypatch.delenv(var, raising=False)

    app, client, headers, cfg = _make_app_client(tmp_path)
    proj = client.post(
        "/api/v1/projects",
        headers=headers,
        json={"name": "Config Test", "duration_ms": 10000},
    ).json()
    pid = proj["meta"]["project_id"]

    # Add raw script so we specifically hit provider-not-configured (not empty-script)
    proj["script"] = {
        "episode_title": "Ep 1",
        "raw_source_text": "Minh enters the quiet station.\n\nMinh: \"Are we late?\"",
        "scenes": [],
    }
    assert client.put(f"/api/v1/projects/{pid}", headers=headers, json=proj).status_code == 200

    # Providers endpoint lists openai/gemini/openai_compatible with OpenAI unconfigured
    reg = client.get("/api/v1/director/providers", headers=headers)
    assert reg.status_code == 200
    reg_body = reg.json()
    assert reg_body["config"]["provider_id"] == "openai"
    assert reg_body["config"]["api_key_configured"] is False
    assert reg_body["config"]["api_key_masked"] == ""

    # Calling Analyze without an API key MUST fail with 400 (NO fake/mock analysis!)
    bad_analyze = client.post(
        f"/api/v1/director/{pid}/analyze",
        headers=headers,
        json={"script_source_mode": "auto"},
    )
    assert bad_analyze.status_code == 400
    assert "API key" in bad_analyze.json()["detail"]

    # Saving config stores masked key safely in library.db and persists across restart
    upd = client.put(
        "/api/v1/director/config",
        headers=headers,
        json={
            "provider_id": "gemini",
            "model": "gemini-2.5-flash",
            "api_key": "AIzaSyTestSecretKey98765",
            "analysis_language": "vi",
            "timeout_seconds": 45,
            "max_retries": 3,
            "max_chunk_chars": 4500,
        },
    )
    assert upd.status_code == 200
    upd_body = upd.json()
    assert upd_body["provider_id"] == "gemini"
    assert upd_body["api_key_configured"] is True
    assert upd_body["api_key_masked"] == "AIza...8765"
    assert "TestSecretKey" not in json.dumps(upd_body)

    # Reopen fresh app against same workspace -> config persists!
    app2 = create_app(cfg)
    client2 = TestClient(app2)
    reg2 = client2.get("/api/v1/director/providers", headers=headers).json()
    assert reg2["config"]["provider_id"] == "gemini"
    assert reg2["config"]["model"] == "gemini-2.5-flash"
    assert reg2["config"]["api_key_masked"] == "AIza...8765"
    assert reg2["config"]["analysis_language"] == "vi"

    # Clear key cleanly
    cleared = client2.put(
        "/api/v1/director/config",
        headers=headers,
        json={"provider_id": "gemini", "clear_api_key": True},
    ).json()
    assert cleared["api_key_configured"] is False
    assert cleared["api_key_masked"] == ""


def test_short_multilingual_script_aliases_grounding_caching_and_persistence(tmp_path: Path):
    app, client, headers, cfg = _make_app_client(tmp_path)

    # Create an existing Library Character named "Minh Anh" -> should link WITHOUT duplicating!
    lib_char = client.post(
        "/api/v1/characters",
        headers=headers,
        json={"name": "Minh Anh", "description": "Existing character asset"},
    ).json()
    existing_lib_count = len(client.get("/api/v1/characters", headers=headers).json())

    raw_script = (
        "Mưa đêm rơi xuống con hẻm nhỏ. Minh Anh đứng lặng dưới mái hiên.\n\n"
        "Minh: \"Đừng đi tiếp nữa, Tuấn Anh!\"\n\n"
        "Tuấn Anh bước tới, ánh đèn neon hắt lên vai. Anh nói khẽ: \"We have no choice tonight.\"\n\n"
        "Một giọng lạ vang lên từ bóng tối: \"Ai đang ở đó?\""
    )

    proj = client.post(
        "/api/v1/projects",
        headers=headers,
        json={"name": "Bilingual Noir Episode", "duration_ms": 12000},
    ).json()
    pid = proj["meta"]["project_id"]
    proj["script"] = {"episode_title": "Tập 1", "raw_source_text": raw_script, "scenes": []}
    client.put(f"/api/v1/projects/{pid}", headers=headers, json=proj)

    def _handler(prompt: str, schema_name: str, call_idx: int, _ev):
        assert schema_name == "_LLMChunkAnalysisResult"
        return noir_analysis_payload()

    llm = DeterministicScriptLLM(_handler)
    app.state.services.llm_registry.set_override_provider(llm)

    # 1. Analyze short multilingual script
    res = client.post(
        f"/api/v1/director/{pid}/analyze",
        headers=headers,
        json={"script_source_mode": "auto"},
    )
    assert res.status_code == 200
    doc = res.json()
    assert len(llm.calls) == 1
    assert doc["status"] == "analyzed"
    assert len(doc["characters"]) == 2
    assert len(doc["scenes"]) == 2
    assert len(doc["extracted_items"]) == 4

    # Grounding & alias checks
    minh = next(c for c in doc["characters"] if c["canonical_name"] == "Minh Anh")
    tuan = next(c for c in doc["characters"] if c["canonical_name"] == "Tuấn Anh")
    assert minh["appearance_specified"] is False
    assert minh["appearance_description"] == "unspecified"
    # Auto-linked to existing Library character without duplicating!
    assert minh["linked_character_id"] == lib_char["character_id"]
    assert len(client.get("/api/v1/characters", headers=headers).json()) == existing_lib_count
    # Cross-character partial-token ambiguity detection flagged "anh" automatically!
    assert "anh" in [a.lower() for a in minh["ambiguous_aliases"]]
    assert "anh" in [a.lower() for a in tuan["ambiguous_aliases"]]

    # Verbatim multilingual dialogue preserved & unresolved speaker flagged
    en_line = next(i for i in doc["extracted_items"] if i["language"] == "en")
    assert en_line["original_text"] == "We have no choice tonight."
    unresolved_line = next(i for i in doc["extracted_items"] if i["speaker_unresolved"])
    assert unresolved_line["original_text"] == "Ai đang ở đó?"

    # Scene source_text grounded verbatim from paragraphs & alias mapped to canonical name
    assert "Minh Anh" in doc["scenes"][0]["characters_present"]
    assert "Mưa đêm rơi xuống con hẻm nhỏ." in doc["scenes"][0]["source_text"]
    assert doc["scenes"][0]["original_ai_snapshot"] is not None

    # 2. Hash cache: calling analyze again with force=False reuses saved analysis (0 extra LLM calls)
    cached = client.post(
        f"/api/v1/director/{pid}/analyze",
        headers=headers,
        json={"script_source_mode": "auto", "force": False},
    )
    assert cached.status_code == 200
    assert len(llm.calls) == 1

    # 3. Force re-analyze invokes LLM again and bumps version
    forced = client.post(
        f"/api/v1/director/{pid}/analyze",
        headers=headers,
        json={"script_source_mode": "auto", "force": True},
    )
    assert forced.status_code == 200
    assert len(llm.calls) == 2
    assert forced.json()["version"] == 2

    # 4. Persistence across app restart + original raw script untouched
    app2 = create_app(cfg)
    client2 = TestClient(app2)
    reopened = client2.get(f"/api/v1/projects/{pid}", headers=headers).json()
    assert reopened["script"]["raw_source_text"] == raw_script
    assert reopened["director"]["version"] == 2
    assert len(reopened["director"]["scenes"]) == 2


def test_long_multichunk_script_consolidation_and_edge_cases(tmp_path: Path):
    app, client, headers, _ = _make_app_client(tmp_path)
    proj = client.post(
        "/api/v1/projects",
        headers=headers,
        json={"name": "Long & Edge Script", "duration_ms": 10000},
    ).json()
    pid = proj["meta"]["project_id"]

    # Edge Case A: Empty script -> 400
    empty_res = client.post(
        f"/api/v1/director/{pid}/analyze",
        headers=headers,
        json={"script_source_mode": "custom_text", "custom_script_text": "   \n\n  "},
    )
    assert empty_res.status_code == 400

    # Edge Case B: Binary / non-word garbage script -> 400
    binary_res = client.post(
        f"/api/v1/director/{pid}/analyze",
        headers=headers,
        json={"script_source_mode": "custom_text", "custom_script_text": "\x00\x01\x02!!!@@@###"},
    )
    assert binary_res.status_code == 400

    # Edge Case C: Script with NO explicit character names
    def _unnamed_handler(prompt: str, schema_name: str, _call_idx: int, _ev):
        return {
            "story_overview": {"title": "Silent Valley", "genre": "Atmospheric", "synopsis": "Wind blows."},
            "production_analysis": {"establishing_shots": ["Empty foggy valley"]},
            "characters": [],
            "extracted_items": [
                {
                    "item_type": "scene_description",
                    "original_text": "Fog drifts slowly across the empty bamboo valley at dawn.",
                    "paragraph_index": 0,
                    "language": "en",
                }
            ],
            "scenes": [
                {
                    "title": "Dawn Over Bamboo Valley",
                    "source_paragraphs": [0],
                    "location": "Bamboo Valley",
                    "time_of_day": "Dawn",
                    "characters_present": [],
                    "main_action": "Fog drifts across the empty valley.",
                }
            ],
        }

    app.state.services.llm_registry.set_override_provider(DeterministicScriptLLM(_unnamed_handler))
    unnamed_res = client.post(
        f"/api/v1/director/{pid}/analyze",
        headers=headers,
        json={
            "script_source_mode": "custom_text",
            "custom_script_text": "Fog drifts slowly across the empty bamboo valley at dawn.",
            "force": True,
        },
    )
    assert unnamed_res.status_code == 200
    assert unnamed_res.json()["characters"] == []
    assert len(unnamed_res.json()["scenes"]) == 1

    # Long Multi-Chunk Script: 8 paragraphs (~3600 chars) with max_chunk_chars=1500 -> 3 chunks + 1 global synthesis!
    long_paras = [
        f"Paragraph {i + 1}: " + ("Linh walks through the ancient stone corridor carrying a dim lantern. " * 7)
        for i in range(8)
    ]
    long_script = "\n\n".join(long_paras)

    chunk_seen_prompts: list[str] = []

    def _chunk_handler(prompt: str, schema_name: str, call_idx: int, _ev):
        chunk_seen_prompts.append(prompt)
        if schema_name == "_LLMGlobalSynthesisResult":
            return {
                "story_overview": {
                    "title": "The Endless Corridor",
                    "genre": "Adventure",
                    "premise": "Linh explores an ancient corridor across multiple chambers.",
                    "synopsis": "Consolidated multi-chunk synthesis.",
                    "story_structure": "Three-act exploration",
                    "narrative_beats": [],
                },
                "production_analysis": {
                    "visual_opportunities": ["Lantern glow on carved walls"],
                    "establishing_shots": ["Long corridor perspective"],
                },
                "warnings": [],
            }
        # Extract paragraph indices referenced in prompt "[P0]", "[P1]", ...
        import re

        p_nums = [int(m) for m in re.findall(r"\[P(\d+)\]", prompt)]
        first_p, last_p = p_nums[0], p_nums[-1]
        return {
            "characters": [
                {
                    "canonical_name": "Linh" if call_idx == 1 else "Cô Linh",
                    "aliases": ["Cô Linh"] if call_idx == 1 else ["Linh"],
                    "role": "Explorer",
                    "appearance_description": "unspecified",
                    "appearance_specified": False,
                    "narrative_importance": "main",
                }
            ],
            "extracted_items": [
                {
                    "item_type": "narration",
                    "original_text": long_paras[first_p],
                    "paragraph_index": first_p,
                    "language": "en",
                }
            ],
            "scenes": [
                {
                    "title": f"Corridor Segment P{first_p + 1}-P{last_p + 1}",
                    "source_paragraphs": p_nums,
                    "location": "Ancient Corridor",
                    "characters_present": ["Linh"],
                    "main_action": f"Linh traverses paragraphs {first_p + 1} to {last_p + 1}.",
                }
            ],
            "rolling_summary": f"Linh reached paragraph {last_p + 1}.",
        }

    chunk_llm = DeterministicScriptLLM(_chunk_handler)
    app.state.services.llm_registry.set_override_provider(chunk_llm)

    long_res = client.post(
        f"/api/v1/director/{pid}/analyze",
        headers=headers,
        json={
            "script_source_mode": "custom_text",
            "custom_script_text": long_script,
            "max_chunk_chars": 1500,
            "force": True,
        },
    )
    assert long_res.status_code == 200
    long_doc = long_res.json()
    # Multiple chunk calls + 1 global synthesis call!
    assert len(chunk_llm.calls) >= 3
    assert chunk_llm.calls[-1]["schema"] == "_LLMGlobalSynthesisResult"
    # Cross-chunk alias consolidation merged "Linh" and "Cô Linh" into ONE canonical character!
    assert len(long_doc["characters"]) == 1
    assert long_doc["characters"][0]["canonical_name"] == "Linh"
    assert "Cô Linh" in long_doc["characters"][0]["aliases"]
    assert "Chunked rolling-context analysis" in long_doc["context_strategy_note"]
    assert long_doc["story_overview"]["title"] == "The Endless Corridor"


def test_single_scene_regeneration_preserves_user_edited_fields(tmp_path: Path):
    app, client, headers, _ = _make_app_client(tmp_path)
    proj = client.post(
        "/api/v1/projects",
        headers=headers,
        json={"name": "Regen Protection Test", "duration_ms": 10000},
    ).json()
    pid = proj["meta"]["project_id"]

    def _handler(prompt: str, schema_name: str, _call_idx: int, _ev):
        if schema_name == "_LLMSceneProposal":
            return {
                "title": "AI Overwritten Title (SHOULD BE IGNORED)",
                "location": "AI Overwritten Location (SHOULD BE IGNORED)",
                "time_of_day": "Late Dusk",
                "environment": "Sparkling rain puddles",
                "characters_present": ["An"],
                "main_action": "Regenerated more cinematic action beat.",
                "emotional_beat": "Renewed resolve",
                "atmosphere": "Cinematic amber glow",
                "visual_opportunities": ["Macro raindrop reflection"],
                "suggested_duration_min_s": 9,
                "suggested_duration_max_s": 15,
                "importance": "high",
                "transition_suggestion": "Cross dissolve",
                "ai_confidence": 0.94,
            }
        return {
            "story_overview": {"title": "Test"},
            "characters": [{"canonical_name": "An"}],
            "extracted_items": [],
            "scenes": [
                {
                    "title": "Initial AI Title",
                    "source_paragraphs": [0],
                    "location": "Initial Location",
                    "atmosphere": "Plain",
                    "main_action": "Initial action",
                }
            ],
        }

    app.state.services.llm_registry.set_override_provider(DeterministicScriptLLM(_handler))
    doc = client.post(
        f"/api/v1/director/{pid}/analyze",
        headers=headers,
        json={"script_source_mode": "custom_text", "custom_script_text": "An stands in the amber rain."},
    ).json()
    sb_id = doc["scenes"][0]["scene_breakdown_id"]

    # Simulate user editing `title` and `location` and saving state
    state = client.get(f"/api/v1/projects/{pid}", headers=headers).json()
    state["director"]["scenes"][0]["title"] = "My Hand-Crafted Title"
    state["director"]["scenes"][0]["location"] = "My Exact Cafe"
    state["director"]["scenes"][0]["user_edited_fields"] = ["title", "location"]
    assert client.put(f"/api/v1/projects/{pid}", headers=headers, json=state).status_code == 200

    # Regenerate single scene with preserve_user_edits=True
    regen = client.post(
        f"/api/v1/director/{pid}/regenerate-scene/{sb_id}",
        headers=headers,
        json={"instructions": "Make atmosphere richer", "preserve_user_edits": True},
    )
    assert regen.status_code == 200
    sc = regen.json()
    # User-edited fields strictly preserved!
    assert sc["title"] == "My Hand-Crafted Title"
    assert sc["location"] == "My Exact Cafe"
    # Non-edited fields updated cleanly by AI!
    assert sc["atmosphere"] == "Cinematic amber glow"
    assert sc["main_action"] == "Regenerated more cinematic action beat."
    assert sc["review_status"] == "edited"


@pytest.mark.asyncio
async def test_real_llm_adapters_retry_timeout_malformed_and_cancel(monkeypatch: pytest.MonkeyPatch):
    """Exercise real OpenAI, Gemini & OpenAI-Compatible adapters over httpx.MockTransport."""
    from pydantic import BaseModel

    class _MiniOut(BaseModel):
        answer: str

    # 1. OpenAI adapter: first returns 503 transient error, second returns malformed JSON, third succeeds!
    attempts = {"count": 0}

    def _openai_transport(request: httpx.Request) -> httpx.Response:
        attempts["count"] += 1
        assert request.headers["Authorization"] == "Bearer sk-test-key"
        if attempts["count"] == 1:
            return httpx.Response(503, text="Temporary overloaded")
        if attempts["count"] == 2:
            return httpx.Response(
                200,
                json={"choices": [{"message": {"content": "NOT VALID JSON AT ALL"}}]},
            )
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": '```json\n{"answer": "recovered"}\n```'}}]},
        )

    real_async_client = httpx.AsyncClient

    def _patched_client(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(_openai_transport)
        return real_async_client(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", _patched_client)
    openai_provider = OpenAILLMProvider(
        api_key="sk-test-key",
        base_url="https://api.openai.com/v1",
        default_model="gpt-4o-mini",
        timeout_seconds=10,
        max_retries=2,
    )
    out = await openai_provider.generate_structured("test", _MiniOut)
    assert out.answer == "recovered"
    assert attempts["count"] == 3

    # 2. Gemini adapter structured JSON response
    def _gemini_transport(request: httpx.Request) -> httpx.Response:
        assert "gemini-2.5-flash:generateContent" in str(request.url)
        return httpx.Response(
            200,
            json={"candidates": [{"content": {"parts": [{"text": '{"answer": "gemini-ok"}'}]}}]},
        )

    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda *a, **kw: real_async_client(*a, **{**kw, "transport": httpx.MockTransport(_gemini_transport)}),
    )
    gemini_provider = GeminiLLMProvider(api_key="AIza-test", default_model="gemini-2.5-flash")
    g_out = await gemini_provider.generate_structured("test", _MiniOut)
    assert g_out.answer == "gemini-ok"

    # 3. Timeout error -> LLMTimeoutError
    def _timeout_transport(_request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("Timed out")

    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda *a, **kw: real_async_client(*a, **{**kw, "transport": httpx.MockTransport(_timeout_transport)}),
    )
    compat_provider = OpenAICompatibleLLMProvider(
        base_url="http://127.0.0.1:11434/v1",
        default_model="llama3.1:8b",
        max_retries=0,
    )
    with pytest.raises(LLMTimeoutError):
        await compat_provider.generate_structured("test", _MiniOut)

    # 4. Malformed JSON exhaustion -> LLMMalformedResponseError
    def _bad_json_transport(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": "{broken json"}}]},
        )

    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda *a, **kw: real_async_client(*a, **{**kw, "transport": httpx.MockTransport(_bad_json_transport)}),
    )
    with pytest.raises(LLMMalformedResponseError):
        await compat_provider.generate_structured("test", _MiniOut)

    # 5. Cancellation via asyncio.Event -> LLMCancelledError
    cancel_ev = asyncio.Event()
    cancel_ev.set()
    with pytest.raises(LLMCancelledError):
        await compat_provider.generate_structured("test", _MiniOut, cancel_event=cancel_ev)

    # 6. Missing OpenAI key -> LLMNotConfiguredError
    unconfigured = OpenAILLMProvider(api_key="")
    with pytest.raises(LLMNotConfiguredError):
        await unconfigured.generate_structured("test", _MiniOut)


def test_cancel_endpoint_and_v3_to_v4_safe_migration(tmp_path: Path):
    app, client, headers, cfg = _make_app_client(tmp_path)

    # Create a real project, save raw script, then downgrade project_state to legacy v3 (no director_json column)
    proj = client.post(
        "/api/v1/projects",
        headers=headers,
        json={"name": "Legacy V3 Comic", "duration_ms": 8000},
    ).json()
    legacy_pid = proj["meta"]["project_id"]
    proj["script"] = {
        "episode_title": "Legacy Ep",
        "raw_source_text": "Preserved V3 Script text that must survive migration.",
        "scenes": [],
    }
    assert client.put(f"/api/v1/projects/{legacy_pid}", headers=headers, json=proj).status_code == 200

    db_path = cfg.project_db_path(legacy_pid)
    conn = sqlite3.connect(str(db_path))
    try:
        row = conn.execute(
            "SELECT scenes_json, timeline_json, script_json, subtitles_json, updated_at FROM project_state WHERE id = 1"
        ).fetchone()
        conn.execute("DROP TABLE project_state")
        conn.execute(
            """
            CREATE TABLE project_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                scenes_json TEXT NOT NULL,
                timeline_json TEXT NOT NULL,
                script_json TEXT NOT NULL DEFAULT '{}',
                subtitles_json TEXT NOT NULL DEFAULT '{}',
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            "INSERT INTO project_state (id, scenes_json, timeline_json, script_json, subtitles_json, updated_at) VALUES (1, ?, ?, ?, ?, ?)",
            row,
        )
        conn.execute("UPDATE schema_meta SET value = '3' WHERE key = 'version'")
        conn.commit()
    finally:
        conn.close()

    # Loading via API runs safe v3 -> v4 migration without losing scenes or script!
    loaded = client.get(f"/api/v1/projects/{legacy_pid}", headers=headers)
    assert loaded.status_code == 200
    body = loaded.json()
    assert body["meta"]["name"] == "Legacy V3 Comic"
    assert len(body["scenes"]) == 1
    assert body["script"]["raw_source_text"] == "Preserved V3 Script text that must survive migration."
    assert body["director"] is None

    # Confirm schema_meta version was cleanly upgraded to 4 and director_json exists
    conn = sqlite3.connect(str(db_path))
    try:
        ver = conn.execute("SELECT value FROM schema_meta WHERE key = 'version'").fetchone()[0]
        cols = [r[1] for r in conn.execute("PRAGMA table_info(project_state)").fetchall()]
        assert int(ver) >= 4
        assert "director_json" in cols
    finally:
        conn.close()

    # Progress & Cancel endpoints respond cleanly
    prog = client.get(f"/api/v1/director/{legacy_pid}/progress", headers=headers)
    assert prog.status_code == 200
    assert prog.json()["status"] == "idle"
    cancel = client.post(f"/api/v1/director/{legacy_pid}/cancel", headers=headers)
    assert cancel.status_code == 200

    # Verify HTTP error mapping for timeout (504) and cancellation (499) via API
    async def _timeout_handler(*_a):
        raise LLMTimeoutError("Simulated provider timeout")

    app.state.services.llm_registry.set_override_provider(DeterministicScriptLLM(_timeout_handler))
    t_res = client.post(
        f"/api/v1/director/{legacy_pid}/analyze",
        headers=headers,
        json={"script_source_mode": "auto"},
    )
    assert t_res.status_code == 504

    async def _cancel_handler(*_a):
        raise LLMCancelledError("Simulated cancellation")

    app.state.services.llm_registry.set_override_provider(DeterministicScriptLLM(_cancel_handler))
    c_res = client.post(
        f"/api/v1/director/{legacy_pid}/analyze",
        headers=headers,
        json={"script_source_mode": "auto"},
    )
    assert c_res.status_code == 499
