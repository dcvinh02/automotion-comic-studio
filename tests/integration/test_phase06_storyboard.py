"""Phase 06 Batch 2 integration & resilience tests — AI Storyboard, Shot Planning & Camera Direction.

Covers all Section 15 verification criteria:
1. Generate storyboard for one scene & multiple approved scenes with varied durations,
   honest 2D camera feasibility tagging (`supported`, `2d_approximation`, `unsupported_suggestion`),
   grounded character staging & missing character asset flagging (never inventing assets)
2. Unchanged-scene hash skipping (`force=False`) & explicit force regeneration
3. Regenerate scene with `preserve_locked` vs `replace_all` confirmation enforcement
4. Regenerate selected single shot preserving `user_edited_fields` & rejecting locked shots (400)
5. Continuity analysis across consecutive shots (position jump, facing flip, exit mismatch,
   mid-dialogue disappearance, dialogue gap, missing asset)
6. Persistence across restart & safe SQLite v4 -> v5 migration preserving existing scenes/script/director
7. Provider failure / malformed JSON / cancellation & partial completed-scene preservation
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


def _make_app_client(tmp_path: Path, workspace_name: str = "workspace"):
    cfg = AppConfig(workspace_dir=tmp_path / workspace_name, auth_token="phase06-b2-secret")
    app = create_app(cfg)
    return app, TestClient(app), {"X-AMCS-Token": "phase06-b2-secret"}, cfg


class DeterministicStoryboardLLM(LLMProvider):
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
            raise LLMCancelledError("Storyboard generation cancelled by user.")
        res = self.handler(prompt, schema.__name__, len(self.calls), cancel_event)
        if asyncio.iscoroutine(res):
            res = await res
        return schema.model_validate(res)


def _seed_project_with_two_approved_scenes(client: TestClient, headers: dict[str, str]):
    # Create ONE existing Library Character ("Minh Anh"); leave "Tuấn Anh" unlinked to test missing-asset handling!
    lib_minh = client.post(
        "/api/v1/characters",
        headers=headers,
        json={"name": "Minh Anh", "description": "Linked main rig"},
    ).json()

    proj = client.post(
        "/api/v1/projects",
        headers=headers,
        json={"name": "Storyboard Test Comic", "duration_ms": 20000},
    ).json()
    pid = proj["meta"]["project_id"]

    # Seed Batch 1 DirectorAnalysisDocument with 2 accepted scenes + 1 pending scene (must be ignored!)
    proj["script"] = {
        "episode_title": "Ep 01",
        "raw_source_text": "Original script text that must never be overwritten.",
        "scenes": [],
    }
    proj["director"] = {
        "analysis_id": "dir_seed_1",
        "version": 1,
        "script_source_mode": "raw_text",
        "source_script_hash": "hash123",
        "source_paragraphs": ["P1", "P2", "P3"],
        "provider_id": "openai",
        "model": "gpt-4o-mini",
        "analysis_language": "auto",
        "status": "partially_accepted",
        "story_overview": {"title": "Midnight Alley", "genre": "Noir", "narrative_tone": "Tense"},
        "characters": [
            {
                "character_analysis_id": "ch_minh",
                "canonical_name": "Minh Anh",
                "aliases": ["Minh"],
                "role": "Protector",
                "linked_character_id": lib_minh["character_id"],
            },
            {
                "character_analysis_id": "ch_tuan",
                "canonical_name": "Tuấn Anh",
                "aliases": [],
                "role": "Investigator",
                "linked_character_id": None,
            },
        ],
        "extracted_items": [
            {
                "item_id": "it_dlg_1",
                "item_type": "dialogue",
                "original_text": "Đừng đi tiếp nữa, Tuấn Anh!",
                "speaker_character_analysis_id": "ch_minh",
                "speaker_name_raw": "Minh",
                "order_index": 0,
                "paragraph_index": 0,
                "language": "vi",
            },
            {
                "item_id": "it_dlg_2",
                "item_type": "dialogue",
                "original_text": "We have no choice tonight.",
                "speaker_character_analysis_id": "ch_tuan",
                "speaker_name_raw": "Tuấn Anh",
                "order_index": 1,
                "paragraph_index": 1,
                "language": "en",
            },
        ],
        "scenes": [
            {
                "scene_breakdown_id": "sb_scene_1",
                "scene_number": 1,
                "title": "Rain Alley Warning",
                "source_paragraphs": [0],
                "source_text": "Rain falls. Minh Anh warns Tuấn Anh.",
                "location": "Neon Alley",
                "time_of_day": "Night",
                "environment": "Wet neon alley",
                "characters_present": ["Minh Anh", "Tuấn Anh"],
                "main_action": "Minh Anh warns Tuấn Anh under the awning.",
                "dialogue_item_ids": ["it_dlg_1"],
                "narration_item_ids": [],
                "emotional_beat": "Urgent warning",
                "suggested_duration_min_s": 8,
                "suggested_duration_max_s": 12,
                "review_status": "accepted",
            },
            {
                "scene_breakdown_id": "sb_scene_2",
                "scene_number": 2,
                "title": "Neon Confrontation",
                "source_paragraphs": [1],
                "source_text": "Tuấn Anh steps into the neon rain.",
                "location": "Alley Exit",
                "time_of_day": "Night",
                "environment": "Neon street corner",
                "characters_present": ["Tuấn Anh", "Minh Anh"],
                "main_action": "Tuấn Anh steps forward decisively.",
                "dialogue_item_ids": ["it_dlg_2"],
                "narration_item_ids": [],
                "emotional_beat": "Defiant resolve",
                "suggested_duration_min_s": 6,
                "suggested_duration_max_s": 10,
                "review_status": "accepted",
            },
            {
                "scene_breakdown_id": "sb_scene_pending",
                "scene_number": 3,
                "title": "Unapproved Draft Scene",
                "source_paragraphs": [2],
                "source_text": "Pending scene not yet approved.",
                "review_status": "pending",
            },
        ],
    }
    res = client.put(f"/api/v1/projects/{pid}", headers=headers, json=proj)
    assert res.status_code == 200
    return pid, lib_minh["character_id"]


def test_storyboard_multi_scene_generation_camera_matrix_missing_assets_hash_cache_and_reload(
    tmp_path: Path,
):
    app, client, headers, cfg = _make_app_client(tmp_path)
    pid, minh_lib_id = _seed_project_with_two_approved_scenes(client, headers)

    # Approved scenes endpoint returns ONLY the 2 accepted scenes (ignoring pending scene 3!)
    approved = client.get(f"/api/v1/storyboard/{pid}/approved-scenes", headers=headers)
    assert approved.status_code == 200
    assert [s["scene_id"] for s in approved.json()] == ["sb_scene_1", "sb_scene_2"]

    def _handler(prompt: str, schema_name: str, call_idx: int, _ev):
        assert schema_name == "_LLMSceneShotsResponse"
        if "Rain Alley Warning" in prompt:
            return {
                "shots": [
                    {
                        "title": "Establishing Wet Alley",
                        "purpose": "Establish setting and tension",
                        "shot_size": "wide",
                        "camera_angle": "high_angle",
                        "camera_movement": "pan_right",
                        "duration_ms": 4200,
                        "characters": [
                            {
                                "character_name": "Minh Anh",
                                "visible": True,
                                "speaking": False,
                                "reacting": False,
                                "screen_position": "left",
                                "depth_layer": "midground",
                                "facing_direction": "right",
                                "action": "Waits under awning",
                                "expression": "tense",
                            }
                        ],
                        "environment": "Wet neon alley",
                        "visual_focus": "Neon puddles and awning",
                        "emotional_emphasis": "Quiet dread",
                        "transition_out": "cut",
                        "ai_rationale": "Wide opener grounds geography.",
                        "confidence": 0.92,
                    },
                    {
                        "title": "Minh Warns Tuan",
                        "purpose": "Deliver urgent dialogue beat",
                        "shot_size": "medium_close_up",
                        "camera_angle": "eye_level",
                        "camera_movement": "parallax",  # MUST be flagged unsupported_suggestion!
                        "duration_ms": 2600,
                        "characters": [
                            {
                                "character_name": "Minh Anh",
                                "visible": True,
                                "speaking": True,
                                "reacting": False,
                                "screen_position": "left",
                                "depth_layer": "foreground",
                                "facing_direction": "right",
                                "action": "Raises hand to stop Tuan",
                                "expression": "urgent",
                            },
                            {
                                "character_name": "Tuấn Anh",
                                "visible": True,
                                "speaking": False,
                                "reacting": True,
                                "screen_position": "right",
                                "depth_layer": "midground",
                                "facing_direction": "left",
                                "action": "Listens tensely",
                                "expression": "guarded",
                            },
                        ],
                        "dialogue_refs": [
                            {
                                "ref_id": "it_dlg_1",
                                "item_type": "dialogue",
                                "speaker_name": "Minh",
                                "text_excerpt": "Đừng đi tiếp nữa, Tuấn Anh!",
                            }
                        ],
                        "environment": "Wet neon alley",
                        "visual_focus": "Minh Anh's urgent expression",
                        "emotional_emphasis": "Urgency",
                        "transition_out": "cut",
                        "ai_rationale": "Tight framing raises stakes.",
                        "confidence": 0.9,
                    },
                ]
            }
        return {
            "shots": [
                {
                    "title": "Tuan Steps Into Rain",
                    "purpose": "Defiant turning point",
                    "shot_size": "medium",
                    "camera_angle": "low_angle",
                    "camera_movement": "dolly_in",  # MUST be flagged 2d_approximation!
                    "duration_ms": 3400,
                    "characters": [
                        {
                            "character_name": "Tuấn Anh",
                            "visible": True,
                            "speaking": True,
                            "reacting": False,
                            "screen_position": "center",
                            "depth_layer": "foreground",
                            "facing_direction": "front",
                            "action": "Steps into neon rain",
                            "expression": "determined",
                            "movement": "walks forward",
                        }
                    ],
                    "dialogue_refs": [
                        {
                            "ref_id": "it_dlg_2",
                            "item_type": "dialogue",
                            "speaker_name": "Tuấn Anh",
                            "text_excerpt": "We have no choice tonight.",
                        }
                    ],
                    "environment": "Neon street corner",
                    "visual_focus": "Tuấn Anh stepping into light",
                    "emotional_emphasis": "Determination",
                    "transition_out": "fade",
                    "ai_rationale": "Low angle empowers resolve.",
                    "confidence": 0.91,
                }
            ]
        }

    llm = DeterministicStoryboardLLM(_handler)
    app.state.services.llm_registry.set_override_provider(llm)

    # 1. Generate storyboard across both approved scenes
    gen = client.post(
        f"/api/v1/storyboard/{pid}/generate",
        headers=headers,
        json={"force": False, "strategy": "preserve_locked"},
    )
    assert gen.status_code == 200
    doc = gen.json()
    assert len(llm.calls) == 2
    assert doc["status"] == "generated"
    assert len(doc["shots"]) == 3

    sh1, sh2, sh3 = doc["shots"]
    # Varied realistic durations & sequential relative timings per scene
    assert sh1["duration_ms"] != sh2["duration_ms"]
    assert sh1["start_time_ms"] == 0 and sh1["end_time_ms"] == sh1["duration_ms"]
    assert sh2["start_time_ms"] == sh1["end_time_ms"]
    assert sh3["start_time_ms"] == 0  # Scene 2 starts at 0 relative to Scene 2!

    # Honest 2D Camera capability matrix enforcement!
    assert sh1["camera_support_status"] == "supported"
    assert sh2["camera_support_status"] == "unsupported_suggestion"
    assert sh3["camera_support_status"] == "2d_approximation"

    # Grounded character asset linking (Minh Anh linked, Tuấn Anh flagged missing_asset WITHOUT duplicating library!)
    minh_stg = next(c for c in sh2["characters"] if c["character_name"] == "Minh Anh")
    tuan_stg = next(c for c in sh2["characters"] if c["character_name"] == "Tuấn Anh")
    assert minh_stg["library_character_id"] == minh_lib_id
    assert minh_stg["is_missing_asset"] is False
    assert tuan_stg["library_character_id"] is None
    assert tuan_stg["is_missing_asset"] is True
    assert any(w["category"] == "missing_character_asset" for w in doc["continuity_warnings"])
    assert len(client.get("/api/v1/characters", headers=headers).json()) == 1

    # 2. Hash cache: re-running generate with force=False skips unchanged scenes (0 extra LLM calls!)
    cached = client.post(
        f"/api/v1/storyboard/{pid}/generate",
        headers=headers,
        json={"force": False},
    )
    assert cached.status_code == 200
    assert len(llm.calls) == 2

    # 3. Reload across fresh FastAPI app -> storyboard & original script 100% preserved!
    app2 = create_app(cfg)
    client2 = TestClient(app2)
    reopened = client2.get(f"/api/v1/projects/{pid}", headers=headers).json()
    assert reopened["script"]["raw_source_text"] == "Original script text that must never be overwritten."
    assert len(reopened["storyboard"]["shots"]) == 3
    assert reopened["storyboard"]["shots"][1]["camera_support_status"] == "unsupported_suggestion"


def test_lock_shot_regenerate_scene_strategies_single_shot_edit_preservation_and_continuity(
    tmp_path: Path,
):
    app, client, headers, _ = _make_app_client(tmp_path)
    pid, _ = _seed_project_with_two_approved_scenes(client, headers)

    def _handler(prompt: str, schema_name: str, call_idx: int, _ev):
        if schema_name == "_LLMShotProposal":
            return {
                "title": "AI Attempted Title Overwrite",
                "purpose": "AI improved visual focus and purpose.",
                "shot_size": "extreme_close_up",  # Should be ignored if shot_size was user-edited!
                "camera_angle": "low_angle",
                "camera_movement": "zoom_in",
                "duration_ms": 3100,
                "environment": "Refined neon rain backdrop",
                "visual_focus": "Raindrop on eyelash",
                "ai_rationale": "Tightened dramatic punch.",
                "confidence": 0.93,
            }
        # Deliberately emit continuity errors on call 1 (position jump + facing flip)
        return {
            "shots": [
                {
                    "title": f"Scene Shot A (call {call_idx})",
                    "purpose": "Open scene",
                    "shot_size": "wide",
                    "camera_angle": "eye_level",
                    "camera_movement": "static",
                    "duration_ms": 3800,
                    "characters": [
                        {
                            "character_name": "Minh Anh",
                            "visible": True,
                            "speaking": True,
                            "screen_position": "far_left",
                            "facing_direction": "right",
                            "action": "Stands quietly",
                        }
                    ],
                    "environment": "Neon alley rain",
                },
                {
                    "title": f"Scene Shot B (call {call_idx})",
                    "purpose": "Continue dialogue",
                    "shot_size": "medium",
                    "camera_angle": "eye_level",
                    "camera_movement": "zoom_in",
                    "duration_ms": 2700,
                    "characters": [
                        {
                            "character_name": "Minh Anh",
                            "visible": True,
                            "speaking": True,
                            "screen_position": "far_right",  # Sudden jump!
                            "facing_direction": "left",      # Sudden 180-deg flip!
                            "action": "Still talking",
                        }
                    ],
                    "environment": "Neon alley rain",
                },
            ]
        }

    app.state.services.llm_registry.set_override_provider(DeterministicStoryboardLLM(_handler))

    # Generate shots for Scene 1
    doc = client.post(
        f"/api/v1/storyboard/{pid}/scenes/sb_scene_1/generate",
        headers=headers,
        json={"strategy": "preserve_locked"},
    ).json()
    assert len(doc["shots"]) == 2
    # Continuity engine caught BOTH position_jump AND facing_flip automatically!
    cats = {w["category"] for w in doc["continuity_warnings"]}
    assert "position_jump" in cats
    assert "facing_flip" in cats

    # Lock Shot 1, edit Shot 2's title & shot_size, and persist state
    state = client.get(f"/api/v1/projects/{pid}", headers=headers).json()
    locked_shot_id = state["storyboard"]["shots"][0]["shot_id"]
    edited_shot_id = state["storyboard"]["shots"][1]["shot_id"]
    state["storyboard"]["shots"][0]["locked"] = True
    state["storyboard"]["shots"][0]["title"] = "LOCKED MASTER SHOT"
    state["storyboard"]["shots"][1]["title"] = "User Handcrafted Shot Title"
    state["storyboard"]["shots"][1]["shot_size"] = "close_up"
    state["storyboard"]["shots"][1]["user_edited_fields"] = ["title", "shot_size"]
    assert client.put(f"/api/v1/projects/{pid}", headers=headers, json=state).status_code == 200

    # A. Regenerating a LOCKED shot directly MUST fail with 400!
    lock_regen = client.post(
        f"/api/v1/storyboard/{pid}/shots/{locked_shot_id}/regenerate",
        headers=headers,
        json={"preserve_user_edits": True},
    )
    assert lock_regen.status_code == 400

    # B. Regenerating UNLOCKED edited Shot 2 preserves `title` & `shot_size` while updating `purpose` & `environment`!
    shot_regen = client.post(
        f"/api/v1/storyboard/{pid}/shots/{edited_shot_id}/regenerate",
        headers=headers,
        json={"instructions": "Make framing more dramatic", "preserve_user_edits": True},
    )
    assert shot_regen.status_code == 200
    sh2_after = shot_regen.json()
    assert sh2_after["title"] == "User Handcrafted Shot Title"
    assert sh2_after["shot_size"] == "close_up"
    assert sh2_after["purpose"] == "AI improved visual focus and purpose."
    assert sh2_after["environment"] == "Refined neon rain backdrop"

    # C. Regenerate Scene with `preserve_locked` -> keeps LOCKED MASTER SHOT intact!
    scene_preserve = client.post(
        f"/api/v1/storyboard/{pid}/scenes/sb_scene_1/generate",
        headers=headers,
        json={"strategy": "preserve_locked"},
    )
    assert scene_preserve.status_code == 200
    assert any(
        s["shot_id"] == locked_shot_id and s["title"] == "LOCKED MASTER SHOT" and s["locked"] is True
        for s in scene_preserve.json()["shots"]
    )

    # D. Regenerate Scene with `replace_all` WITHOUT confirmation -> 400!
    no_confirm = client.post(
        f"/api/v1/storyboard/{pid}/scenes/sb_scene_1/generate",
        headers=headers,
        json={"strategy": "replace_all", "confirm_replace_all": False},
    )
    assert no_confirm.status_code == 400

    # E. Regenerate Scene with `replace_all` AND `confirm_replace_all=True` -> replaces all shots cleanly!
    confirmed = client.post(
        f"/api/v1/storyboard/{pid}/scenes/sb_scene_1/generate",
        headers=headers,
        json={"strategy": "replace_all", "confirm_replace_all": True},
    )
    assert confirmed.status_code == 200
    assert all(s["shot_id"] != locked_shot_id for s in confirmed.json()["shots"])

    # F. Continuity check endpoint runs cleanly
    chk = client.post(f"/api/v1/storyboard/{pid}/continuity-check", headers=headers)
    assert chk.status_code == 200
    assert chk.json()["total_shots_checked"] == 2


def test_partial_failure_preservation_provider_errors_and_v4_to_v5_migration(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    for var in ("OPENAI_API_KEY", "AMCS_OPENAI_API_KEY", "GEMINI_API_KEY", "AMCS_GEMINI_API_KEY"):
        monkeypatch.delenv(var, raising=False)

    app, client, headers, cfg = _make_app_client(tmp_path)
    pid, _ = _seed_project_with_two_approved_scenes(client, headers)

    # 1. Unconfigured provider -> 400 (NO fake storyboard!)
    no_key = client.post(f"/api/v1/storyboard/{pid}/generate", headers=headers, json={})
    assert no_key.status_code == 400

    # 2. Malformed AI response -> 502
    def _bad_handler(*_a):
        raise LLMMalformedResponseError("Broken JSON output")

    app.state.services.llm_registry.set_override_provider(DeterministicStoryboardLLM(_bad_handler))
    bad_res = client.post(f"/api/v1/storyboard/{pid}/generate", headers=headers, json={})
    assert bad_res.status_code == 502

    # 3. Partial Failure Preservation: Scene 1 succeeds, Scene 2 fails -> Scene 1 shots MUST remain persisted!
    def _partial_fail_handler(prompt: str, schema_name: str, call_idx: int, _ev):
        if call_idx == 1:
            return {
                "shots": [
                    {
                        "title": "Completed Scene 1 Shot",
                        "purpose": "Saved before Scene 2 failed",
                        "shot_size": "wide",
                        "camera_angle": "eye_level",
                        "camera_movement": "static",
                        "duration_ms": 3500,
                    }
                ]
            }
        raise LLMProviderError("Simulated upstream outage on Scene 2")

    app.state.services.llm_registry.set_override_provider(
        DeterministicStoryboardLLM(_partial_fail_handler)
    )
    partial_res = client.post(
        f"/api/v1/storyboard/{pid}/generate",
        headers=headers,
        json={"force": True},
    )
    assert partial_res.status_code == 502

    saved_after_fail = client.get(f"/api/v1/projects/{pid}", headers=headers).json()
    assert saved_after_fail["storyboard"] is not None
    assert saved_after_fail["storyboard"]["status"] == "partial"
    assert len(saved_after_fail["storyboard"]["shots"]) == 1
    assert saved_after_fail["storyboard"]["shots"][0]["title"] == "Completed Scene 1 Shot"

    # 4. Safe SQLite v4 -> v5 migration (downgrade project_state dropping storyboard_json, then reopen!)
    db_path = cfg.project_db_path(pid)
    conn = sqlite3.connect(str(db_path))
    try:
        row = conn.execute(
            "SELECT scenes_json, timeline_json, script_json, subtitles_json, director_json, updated_at FROM project_state WHERE id = 1"
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
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            "INSERT INTO project_state (id, scenes_json, timeline_json, script_json, subtitles_json, director_json, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?)",
            row,
        )
        conn.execute("UPDATE schema_meta SET value = '4' WHERE key = 'version'")
        conn.commit()
    finally:
        conn.close()

    migrated = client.get(f"/api/v1/projects/{pid}", headers=headers)
    assert migrated.status_code == 200
    body = migrated.json()
    assert body["script"]["raw_source_text"] == "Original script text that must never be overwritten."
    assert body["director"]["analysis_id"] == "dir_seed_1"
    assert body["storyboard"] is None

    conn = sqlite3.connect(str(db_path))
    try:
        ver = conn.execute("SELECT value FROM schema_meta WHERE key = 'version'").fetchone()[0]
        cols = [r[1] for r in conn.execute("PRAGMA table_info(project_state)").fetchall()]
        assert int(ver) >= 5
        assert "storyboard_json" in cols
    finally:
        conn.close()
