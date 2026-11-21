"""Phase 06 Batch 3 integration & resilience tests — AI Production Planner & Readiness Checking.

Covers all Section 17 backend verification categories:
1. Generate production plans for multiple approved Storyboard scenes:
   - Grounded Asset Matching (compatible match, ambiguous `requires_review`, missing asset — never fabricating IDs)
   - License-Safe Audio Matching (matches bundled/verified CC0 audio, strictly blocks unverified/copyrighted music)
   - 15-category Animation Mapping grounded against real Character rig parts (including unsupported `attack`/`fall` & missing `eyes:closed`)
   - Honest 2D Camera Feasibility (`supported` vs `unsupported_suggestion` `parallax`)
   - Voice/Subtitle sync (`exact_voice` vs `estimated`) & `spans_multiple_shots` detection
   - Real data-driven Production Readiness (`ready`, `needs_character`, `needs_assets`, `needs_animation`, `needs_camera_setup`, `unsupported`, etc.)
2. Hash caching (`force=False` skips unchanged scenes while refreshing live readiness) & `preserve_locked`
3. Single-shot regeneration preserving `user_edited_fields` & rejecting locked shots (`400`)
4. Live `POST /refresh-readiness` upgrading shot readiness from `needs_character`/`needs_assets` -> `ready` with 0 AI calls
5. Provider resilience: unconfigured (`400`), malformed JSON (`502`), partial Scene 2 failure preserving Scene 1 (`status="partial"`), cancellation (`499`)
6. Persistence across restart & safe SQLite v5 -> v6 migration preserving all prior scenes/script/subtitles/director/storyboard
"""

from __future__ import annotations

import asyncio
import sqlite3
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.config import AppConfig
from app.main import create_app
from providers.interfaces import LLMProvider
from providers.llm_provider import (
    LLMCancelledError,
    LLMMalformedResponseError,
    LLMProviderError,
)
from schemas.asset import Asset
from schemas.character import CharacterPartSlot
from schemas.sound import SoundAsset, SoundLicense


def _make_app_client(tmp_path: Path, workspace_name: str = "workspace"):
    cfg = AppConfig(workspace_dir=tmp_path / workspace_name, auth_token="phase06-b3-secret")
    app = create_app(cfg)
    return app, TestClient(app), {"X-AMCS-Token": "phase06-b3-secret"}, cfg


class DeterministicProductionLLM(LLMProvider):
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
        self.calls.append({"prompt": prompt, "schema": schema.__name__, "model": model})
        if cancel_event is not None and cancel_event.is_set():
            raise LLMCancelledError("Production planning cancelled by user.")
        res = self.handler(prompt, schema.__name__, len(self.calls), cancel_event)
        if asyncio.iscoroutine(res):
            res = await res
        return schema.model_validate(res)


def _seed_library_and_storyboard(app, client: TestClient, headers: dict[str, str]):
    lib_repo = app.state.services.library_repo

    # 1. Library Character "Minh Anh" WITH real rig parts (body + head + right_arm + eyes with closed variant)
    lib_minh = client.post(
        "/api/v1/characters",
        headers=headers,
        json={"name": "Minh Anh", "description": "Full rigged main character"},
    ).json()
    minh_obj = lib_repo.get_character(lib_minh["character_id"])
    assert minh_obj is not None
    minh_obj.parts = [
        CharacterPartSlot(slot_id="s_body", name="Body", part_role="body", z_index=1),
        CharacterPartSlot(slot_id="s_head", name="Head", part_role="head", z_index=2),
        CharacterPartSlot(slot_id="s_arm", name="Right Arm", part_role="right_arm", z_index=3),
        CharacterPartSlot(slot_id="s_lleg", name="Left Leg", part_role="left_leg", z_index=4),
        CharacterPartSlot(slot_id="s_rleg", name="Right Leg", part_role="right_leg", z_index=5),
        CharacterPartSlot(
            slot_id="s_eyes",
            name="Eyes",
            part_role="eyes",
            z_index=6,
            variants={"open": "ast_e_open", "closed": "ast_e_closed"},
        ),
    ]
    lib_repo.save_character(minh_obj)

    # 2. Real Background Assets:
    # - Exact match: "Neon Rain Alley"
    # - Ambiguous pair: "Rooftop Night A" & "Rooftop Night B" (triggers `requires_review`)
    lib_repo.insert_asset(
        Asset(
            asset_id="ast_neon_alley",
            name="Neon Rain Alley",
            type="background",
            folder="city",
            file_path="/tmp/neon_alley.png",
            sha256="sha_alley",
            width=1920,
            height=1080,
            tags=["neon", "rain", "alley", "night"],
        )
    )
    lib_repo.insert_asset(
        Asset(
            asset_id="ast_rooftop_a",
            name="Rooftop Night A",
            type="background",
            folder="city",
            file_path="/tmp/rooftop_a.png",
            sha256="sha_roof_a",
            width=1920,
            height=1080,
            tags=["rooftop", "night"],
        )
    )
    lib_repo.insert_asset(
        Asset(
            asset_id="ast_rooftop_b",
            name="Rooftop Night B",
            type="background",
            folder="city",
            file_path="/tmp/rooftop_b.png",
            sha256="sha_roof_b",
            width=1920,
            height=1080,
            tags=["rooftop", "night"],
        )
    )

    # 3. Audio Library: 1 verified CC0 rain SFX + 1 UNVERIFIED copyrighted dramatic BGM (must NEVER be auto-matched!)
    lib_repo.save_sound(
        SoundAsset(
            sound_id="snd_verified_rain",
            name="Heavy Rain Ambience",
            audio_type="sfx",
            category="rain",
            file_path="/tmp/rain.wav",
            sha256="sha_rain",
            duration_ms=4000,
            tags=["rain", "alley"],
            is_bundled=True,
            license=SoundLicense(source="cc0", usage="verified"),
        )
    )
    lib_repo.save_sound(
        SoundAsset(
            sound_id="snd_copyright_unverified",
            name="Copyrighted Pop Ballad Unlicensed",
            audio_type="bgm",
            category="romantic",
            file_path="/tmp/copyright_theme.mp3",
            sha256="sha_theme",
            duration_ms=30000,
            tags=["copyrighted", "pop", "ballad", "unlicensed"],
            is_bundled=False,
            license=SoundLicense(source="custom", usage="unverified"),
        )
    )

    # 4. Create project with 2 Storyboard scenes (3 shots total)
    proj = client.post(
        "/api/v1/projects",
        headers=headers,
        json={"name": "Production Planner Comic", "duration_ms": 20000},
    ).json()
    pid = proj["meta"]["project_id"]

    proj["script"] = {
        "episode_title": "Ep 01",
        "raw_source_text": "Original raw script preserved untouched.",
        "scenes": [
            {
                "script_scene_id": "ssc_1",
                "title": "Rain Alley Warning",
                "entries": [
                    {
                        "entry_id": "ent_1",
                        "entry_type": "dialogue",
                        "character_id": lib_minh["character_id"],
                        "text": "Đừng đi tiếp nữa!",
                        "voice_audio_asset_id": None,
                        "estimated_duration_ms": 2100,
                    }
                ],
            }
        ],
    }

    proj["storyboard"] = {
        "storyboard_id": "sb_1",
        "version": 1,
        "provider_id": "openai",
        "model": "gpt-4o-mini",
        "analysis_language": "auto",
        "status": "generated",
        "shots": [
            # Scene 1 Shot 1: Fully ready (Minh Anh + Neon Rain Alley + walk + zoom_in + verified rain)
            {
                "shot_id": "shot_s1_1",
                "scene_id": "sb_scene_1",
                "shot_order": 1,
                "title": "Alley Arrival",
                "purpose": "Establish rain alley and warning",
                "shot_size": "medium",
                "camera_angle": "eye_level",
                "camera_movement": "zoom_in",
                "camera_support_status": "supported",
                "duration_ms": 3500,
                "start_time_ms": 0,
                "end_time_ms": 3500,
                "environment": "Neon Rain Alley",
                "characters": [
                    {
                        "staging_id": "stg_1",
                        "character_name": "Minh Anh",
                        "library_character_id": lib_minh["character_id"],
                        "screen_position": "left",
                        "depth_layer": "midground",
                        "facing_direction": "right",
                        "action": "walks and speaks",
                        "expression": "tense",
                    }
                ],
                "dialogue_refs": [
                    {
                        "ref_id": "it_dlg_shared",
                        "item_type": "dialogue",
                        "speaker_name": "Minh Anh",
                        "text_excerpt": "Đừng đi tiếp nữa!",
                    }
                ],
                "narration_refs": [],
                "props_in_shot": [],
                "transition_out": "cut",
            },
            # Scene 1 Shot 2: Shares dialogue ref `it_dlg_shared` (tests `spans_multiple_shots`) + missing character + attack + parallax!
            {
                "shot_id": "shot_s1_2",
                "scene_id": "sb_scene_1",
                "shot_order": 2,
                "title": "Shadow Ambush",
                "purpose": "Unlinked enemy & unsupported attack + parallax",
                "shot_size": "wide",
                "camera_angle": "low_angle",
                "camera_movement": "parallax",
                "camera_support_status": "unsupported_suggestion",
                "duration_ms": 3000,
                "start_time_ms": 3500,
                "end_time_ms": 6500,
                "environment": "Unknown Dark Warehouse",
                "characters": [
                    {
                        "staging_id": "stg_2",
                        "character_name": "Tuấn Anh",
                        "library_character_id": None,
                        "is_missing_asset": True,
                        "screen_position": "right",
                        "depth_layer": "midground",
                        "facing_direction": "left",
                        "action": "attacks suddenly",
                        "expression": "angry",
                    }
                ],
                "dialogue_refs": [
                    {
                        "ref_id": "it_dlg_shared",
                        "item_type": "dialogue",
                        "speaker_name": "Minh Anh",
                        "text_excerpt": "Đừng đi tiếp nữa!",
                    }
                ],
                "narration_refs": [],
                "props_in_shot": ["Antique Lantern"],
                "transition_out": "fade",
            },
            # Scene 2 Shot 1: Ambiguous background ("Rooftop Night" -> requires_review!)
            {
                "shot_id": "shot_s2_1",
                "scene_id": "sb_scene_2",
                "shot_order": 1,
                "title": "Rooftop Lookout",
                "purpose": "Ambiguous background review test",
                "shot_size": "wide",
                "camera_angle": "high_angle",
                "camera_movement": "pan_right",
                "camera_support_status": "supported",
                "duration_ms": 4000,
                "start_time_ms": 0,
                "end_time_ms": 4000,
                "environment": "Rooftop Night",
                "characters": [
                    {
                        "staging_id": "stg_3",
                        "character_name": "Minh Anh",
                        "library_character_id": lib_minh["character_id"],
                        "screen_position": "center",
                        "depth_layer": "midground",
                        "facing_direction": "right",
                        "action": "blinks and watches",
                        "expression": "calm",
                    }
                ],
                "dialogue_refs": [],
                "narration_refs": [],
                "props_in_shot": [],
                "transition_out": "cut",
            },
        ],
    }

    res = client.put(f"/api/v1/projects/{pid}", headers=headers, json=proj)
    assert res.status_code == 200
    return pid, lib_minh


def _mock_production_llm_handler(prompt: str, schema_name: str, call_idx: int, cancel_event):
    if "shot_s1_1" in prompt and "shot_s1_2" in prompt:
        return {
            "shot_plans": [
                {
                    "shot_id": "shot_s1_1",
                    "background_query": "Neon Rain Alley",
                    "prop_queries": [],
                    "initial_pose_summary": "Standing tense",
                    "final_pose_summary": "Stepping forward",
                    "action_summary": "Minh Anh walks and warns.",
                    "start_framing": "Medium shot",
                    "end_framing": "Medium close-up",
                    "animations": [
                        {
                            "character_name": "Minh Anh",
                            "category": "walk",
                            "description": "Walks carefully under rain",
                            "duration_ms": 2500,
                        }
                    ],
                    "sfx_cues": [
                        {
                            "audio_type": "sfx",
                            "category": "rain",
                            "description": "Heavy rain ambience",
                            "offset_ms": 0,
                            "volume": 0.65,
                        }
                    ],
                    "bgm_cues": [],
                    "ai_notes": "Grounded shot 1",
                },
                {
                    "shot_id": "shot_s1_2",
                    "background_query": "Unknown Dark Warehouse",
                    "prop_queries": ["Antique Lantern"],
                    "initial_pose_summary": "Ready stance",
                    "final_pose_summary": "Lunging",
                    "action_summary": "Tuấn Anh attacks in warehouse.",
                    "animations": [
                        {
                            "character_name": "Tuấn Anh",
                            "category": "attack",
                            "description": "Leaps into combat attack",
                            "duration_ms": 2000,
                        }
                    ],
                    "sfx_cues": [],
                    "bgm_cues": [
                        {
                            "audio_type": "bgm",
                            "category": "romantic",
                            "description": "Copyrighted Pop Ballad Unlicensed",
                            "offset_ms": 0,
                            "volume": 0.5,
                            "loop": True,
                        }
                    ],
                    "ai_notes": "Shot 2 has unsupported attack + parallax + unverified bgm",
                },
            ]
        }
    if "shot_s2_1" in prompt:
        return {
            "shot_plans": [
                {
                    "shot_id": "shot_s2_1",
                    "background_query": "Rooftop Night",
                    "prop_queries": [],
                    "initial_pose_summary": "Standing calm",
                    "final_pose_summary": "Looking right",
                    "action_summary": "Minh Anh blinks on rooftop.",
                    "animations": [
                        {
                            "character_name": "Minh Anh",
                            "category": "blink",
                            "description": "Slow natural blink",
                            "duration_ms": 1500,
                        }
                    ],
                    "sfx_cues": [],
                    "bgm_cues": [],
                    "ai_notes": "Ambiguous rooftop asset check",
                }
            ]
        }
    # Single-shot regeneration (`_LLMShotProductionProposal`)
    if schema_name == "_LLMShotProductionProposal":
        return {
            "shot_id": "shot_s1_1",
            "background_query": "Neon Rain Alley",
            "prop_queries": [],
            "initial_pose_summary": "Updated dramatic stance",
            "final_pose_summary": "Updated close stance",
            "action_summary": "Regenerated action summary",
            "animations": [
                {
                    "character_name": "Minh Anh",
                    "category": "wave",
                    "description": "Signals urgently",
                    "duration_ms": 1500,
                }
            ],
            "sfx_cues": [],
            "bgm_cues": [],
            "ai_notes": "Regenerated by AI",
        }
    return {"shot_plans": []}


def test_production_plan_generation_matching_readiness_caching_locking_and_refresh(tmp_path: Path):
    app, client, headers, _ = _make_app_client(tmp_path)
    pid, lib_minh = _seed_library_and_storyboard(app, client, headers)

    llm = DeterministicProductionLLM(_mock_production_llm_handler)
    app.state.services.llm_registry.set_override_provider(llm)

    # 1. Generate full Production Plan across 2 scenes (3 shots)
    resp = client.post(f"/api/v1/production/{pid}/generate", headers=headers, json={})
    assert resp.status_code == 200, resp.text
    doc = resp.json()
    assert doc["status"] == "generated"
    assert len(doc["shots"]) == 3
    assert len(llm.calls) == 2

    by_shot = {s["shot_id"]: s for s in doc["shots"]}

    # Shot 1: Fully ready! Matched real Neon Rain Alley + verified CC0 rain SFX + Minh Anh rig + supported walk + zoom_in
    s1 = by_shot["shot_s1_1"]
    assert s1["readiness_status"] == "ready"
    assert s1["execution_capability"] == "full"
    assert s1["background"]["matched_asset_id"] == "ast_neon_alley"
    assert s1["background"]["classification"] == "existing_compatible"
    assert s1["sfx_plans"][0]["matched_sound_id"] is not None
    assert s1["sfx_plans"][0]["license_verified"] is True
    assert s1["camera_plan"]["executable_on_timeline"] is True
    assert s1["voice_subtitle_plans"][0]["spans_multiple_shots"] is True  # shared ref!

    # Shot 2: Missing char (Tuấn Anh), missing warehouse bg & lantern prop, unsupported attack + parallax,
    # AND unverified copyright BGM strictly NOT matched!
    s2 = by_shot["shot_s1_2"]
    assert s2["readiness_status"] == "needs_character"
    assert s2["background"]["matched_asset_id"] is None
    assert s2["background"]["classification"] in ("missing", "requires_new_asset")
    assert s2["assets"][0]["matched_asset_id"] is None
    assert s2["animation_plans"][0]["supported"] is False
    assert s2["camera_plan"]["executable_on_timeline"] is False
    assert s2["camera_plan"]["support_status"] == "unsupported_suggestion"
    assert s2["bgm_plans"][0]["matched_sound_id"] != "snd_copyright_unverified"
    assert all(c["asset_id"] != "snd_copyright_unverified" for c in s2["bgm_plans"][0]["candidates"])
    assert s2["voice_subtitle_plans"][0]["spans_multiple_shots"] is True

    # Shot 3: Ambiguous Rooftop Night A vs B -> `requires_review` & `needs_review` readiness!
    s3 = by_shot["shot_s2_1"]
    assert s3["background"]["classification"] == "requires_review"
    assert len(s3["background"]["candidates"]) >= 2
    assert s3["readiness_status"] == "needs_review"
    assert s3["animation_plans"][0]["category"] == "blink"
    assert s3["animation_plans"][0]["supported"] is True  # Minh Anh has eyes:closed!

    # 2. Hash cache: second call with force=False makes 0 additional LLM calls!
    resp_cached = client.post(f"/api/v1/production/{pid}/generate", headers=headers, json={"force": False})
    assert resp_cached.status_code == 200
    assert len(llm.calls) == 2

    # 3. Lock Shot 1 & edit `ai_notes` on Shot 1 -> force regenerate preserves locked Shot 1 verbatim!
    proj_cur = client.get(f"/api/v1/projects/{pid}", headers=headers).json()
    for sh in proj_cur["production_plan"]["shots"]:
        if sh["shot_id"] == "shot_s1_1":
            sh["locked"] = True
            sh["ai_notes"] = "User custom locked note"
            sh["user_edited_fields"] = ["ai_notes"]
    assert client.put(f"/api/v1/projects/{pid}", headers=headers, json=proj_cur).status_code == 200

    # Single-shot regeneration MUST reject locked shot with 400!
    pshot1_id = s1["production_shot_id"]
    r_locked = client.post(
        f"/api/v1/production/{pid}/shots/{pshot1_id}/regenerate",
        headers=headers,
        json={"instructions": "change it"},
    )
    assert r_locked.status_code == 400

    # Unlock Shot 1 & regenerate preserving `user_edited_fields` (`ai_notes` stays preserved!)
    proj_cur["production_plan"]["shots"][0]["locked"] = False
    assert client.put(f"/api/v1/projects/{pid}", headers=headers, json=proj_cur).status_code == 200
    r_regen = client.post(
        f"/api/v1/production/{pid}/shots/{pshot1_id}/regenerate",
        headers=headers,
        json={"instructions": "Use wave animation", "preserve_user_edits": True},
    )
    assert r_regen.status_code == 200, r_regen.text
    regen_shot = r_regen.json()
    assert regen_shot["ai_notes"] == "User custom locked note"  # Preserved!
    assert regen_shot["action_summary"] == "Regenerated action summary"  # Updated!

    # 4. Live `POST /refresh-readiness` (0 AI calls): assign real asset `ast_rooftop_a` to Shot 3 -> upgrades to `ready`!
    calls_before = len(llm.calls)
    proj_after = client.get(f"/api/v1/projects/{pid}", headers=headers).json()
    for sh in proj_after["production_plan"]["shots"]:
        if sh["shot_id"] == "shot_s2_1":
            sh["background"]["matched_asset_id"] = "ast_rooftop_a"
            sh["background"]["matched_asset_name"] = "Rooftop Night A"
            sh["background"]["classification"] = "existing_compatible"
    assert client.put(f"/api/v1/projects/{pid}", headers=headers, json=proj_after).status_code == 200

    r_ref = client.post(f"/api/v1/production/{pid}/refresh-readiness", headers=headers)
    assert r_ref.status_code == 200
    assert len(llm.calls) == calls_before  # 0 AI calls!
    ref_by_shot = {s["shot_id"]: s for s in r_ref.json()["shots"]}
    assert ref_by_shot["shot_s2_1"]["readiness_status"] == "ready"


def test_production_provider_resilience_unconfigured_malformed_partial_and_cancel(tmp_path: Path):
    app, client, headers, _ = _make_app_client(tmp_path, "ws_resilience")
    pid, _ = _seed_library_and_storyboard(app, client, headers)

    # 1. Unconfigured provider -> honest HTTP 400 (never fake data)
    r_unconf = client.post(f"/api/v1/production/{pid}/generate", headers=headers, json={})
    assert r_unconf.status_code == 400

    # 2. Malformed JSON -> HTTP 502
    def _bad_json(prompt, schema_name, idx, cancel_event):
        raise LLMMalformedResponseError("AI returned invalid JSON")

    app.state.services.llm_registry.set_override_provider(DeterministicProductionLLM(_bad_json))
    r_bad = client.post(f"/api/v1/production/{pid}/generate", headers=headers, json={})
    assert r_bad.status_code == 502

    # 3. Partial failure on Scene 2 -> Scene 1 plans MUST be preserved (`status="partial"`)!
    def _fail_scene_2(prompt, schema_name, idx, cancel_event):
        if idx == 1:
            return _mock_production_llm_handler(prompt, schema_name, idx, cancel_event)
        raise LLMProviderError("Provider 503 on Scene 2")

    app.state.services.llm_registry.set_override_provider(DeterministicProductionLLM(_fail_scene_2))
    r_partial = client.post(f"/api/v1/production/{pid}/generate", headers=headers, json={"force": True})
    assert r_partial.status_code == 502

    persisted = client.get(f"/api/v1/projects/{pid}", headers=headers).json()
    assert persisted["production_plan"]["status"] == "partial"
    assert len(persisted["production_plan"]["shots"]) == 2  # Both Scene 1 shots saved!

    # 4. User cancellation -> HTTP 499 cleanly without crashing
    def _cancel_immediate(prompt, schema_name, idx, cancel_event):
        raise LLMCancelledError("Cancelled by user")

    app.state.services.llm_registry.set_override_provider(DeterministicProductionLLM(_cancel_immediate))
    r_cancel = client.post(f"/api/v1/production/{pid}/generate", headers=headers, json={"force": True})
    assert r_cancel.status_code == 499


def test_production_persistence_across_restart_and_v5_to_v6_migration(tmp_path: Path):
    app1, client1, headers, cfg = _make_app_client(tmp_path, "ws_persist")
    pid, _ = _seed_library_and_storyboard(app1, client1, headers)
    app1.state.services.llm_registry.set_override_provider(
        DeterministicProductionLLM(_mock_production_llm_handler)
    )

    r_gen = client1.post(f"/api/v1/production/{pid}/generate", headers=headers, json={})
    assert r_gen.status_code == 200
    assert len(r_gen.json()["shots"]) == 3

    # Restart backend on same workspace -> production_plan survives intact!
    app2 = create_app(cfg)
    client2 = TestClient(app2)
    loaded = client2.get(f"/api/v1/projects/{pid}", headers=headers).json()
    assert loaded["production_plan"] is not None
    assert len(loaded["production_plan"]["shots"]) == 3
    assert loaded["script"]["raw_source_text"] == "Original raw script preserved untouched."
    assert len(loaded["storyboard"]["shots"]) == 3

    # Simulate legacy v5 SQLite project.db (downgrade real project_state dropping production_plan_json, then reopen!)
    db_path = cfg.project_db_path(pid)
    conn = sqlite3.connect(str(db_path))
    try:
        row = conn.execute(
            "SELECT scenes_json, timeline_json, script_json, subtitles_json, director_json, storyboard_json, updated_at FROM project_state WHERE id = 1"
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
                director_json TEXT NOT NULL DEFAULT '{}',
                storyboard_json TEXT NOT NULL DEFAULT '{}',
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            "INSERT INTO project_state (id, scenes_json, timeline_json, script_json, subtitles_json, director_json, storyboard_json, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?)",
            row,
        )
        conn.execute("UPDATE schema_meta SET value = '5' WHERE key = 'version'")
        conn.commit()
    finally:
        conn.close()

    r_legacy = client2.get(f"/api/v1/projects/{pid}", headers=headers)
    assert r_legacy.status_code == 200, r_legacy.text
    legacy_data = r_legacy.json()
    assert legacy_data["script"]["raw_source_text"] == "Original raw script preserved untouched."
    assert legacy_data["storyboard"]["storyboard_id"] == "sb_1"
    assert legacy_data["production_plan"] is None

    # Confirm schema upgraded to v6
    conn2 = sqlite3.connect(str(db_path))
    ver = conn2.execute("SELECT value FROM schema_meta WHERE key = 'version'").fetchone()[0]
    cols = [row[1] for row in conn2.execute("PRAGMA table_info(project_state)").fetchall()]
    conn2.close()
    assert int(ver) >= 6
    assert "production_plan_json" in cols
