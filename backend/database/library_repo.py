"""Repository for workspace/asset_library/library.db (Assets, Characters, Sounds, Presets)."""

from __future__ import annotations

import json
import uuid
from typing import Any

from app.config import AppConfig
from database.connection import connect_sqlite, sqlite_transaction
from database.library_migrations import init_library_db
from schemas.animation_execution import (
    MotionPreset,
    MotionPresetCreateRequest,
    MotionPresetUpdateRequest,
)
from schemas.asset import Asset, AssetUpdateRequest
from schemas.character import (
    Character,
    CharacterCreateRequest,
    CharacterPartSlot,
    CharacterUpdateRequest,
    ExpressionPreset,
    PosePreset,
)
from schemas.common import AnchorPoint, utc_now_iso
from schemas.job import ExportPreset, ExportPresetCreateRequest
from schemas.sound import SoundAsset, SoundLicense, SoundUpdateRequest
from schemas.voice import VoiceProfile, VoiceProfileUpsertRequest


class LibraryRepository:
    def __init__(self, config: AppConfig) -> None:
        self.config = config
        init_library_db(self.config.library_db_path)

    # --- Assets ---

    def insert_asset(self, asset: Asset) -> Asset:
        with sqlite_transaction(self.config.library_db_path) as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO assets (
                    asset_id, scope, project_id, type, part_role, name, folder,
                    tags_json, file_path, sha256, width, height, anchor_x, anchor_y,
                    version, identity_verified, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    asset.asset_id,
                    asset.scope,
                    asset.project_id,
                    asset.type,
                    asset.part_role,
                    asset.name,
                    asset.folder,
                    json.dumps(asset.tags),
                    asset.file_path,
                    asset.sha256,
                    asset.width,
                    asset.height,
                    asset.default_anchor.x,
                    asset.default_anchor.y,
                    asset.version,
                    int(asset.identity_verified),
                    asset.created_at,
                ),
            )
        return asset

    def get_asset(self, asset_id: str) -> Asset | None:
        conn = connect_sqlite(self.config.library_db_path)
        try:
            row = conn.execute(
                "SELECT * FROM assets WHERE asset_id = ?", (asset_id,)
            ).fetchone()
        finally:
            conn.close()
        return self._row_to_asset(row) if row else None

    def find_asset_by_sha256(self, sha256: str) -> Asset | None:
        conn = connect_sqlite(self.config.library_db_path)
        try:
            row = conn.execute(
                "SELECT * FROM assets WHERE sha256 = ? LIMIT 1", (sha256,)
            ).fetchone()
        finally:
            conn.close()
        return self._row_to_asset(row) if row else None

    def list_assets(
        self,
        asset_type: str | None = None,
        folder: str | None = None,
        search: str | None = None,
        tag: str | None = None,
    ) -> list[Asset]:
        query = "SELECT * FROM assets WHERE 1=1"
        params: list[Any] = []
        if asset_type:
            query += " AND type = ?"
            params.append(asset_type)
        if folder:
            query += " AND folder = ?"
            params.append(folder)
        query += " ORDER BY created_at DESC"

        conn = connect_sqlite(self.config.library_db_path)
        try:
            rows = conn.execute(query, params).fetchall()
        finally:
            conn.close()

        assets = [self._row_to_asset(r) for r in rows]
        if search:
            q = search.strip().lower()
            assets = [
                a
                for a in assets
                if q in a.name.lower()
                or q in a.folder.lower()
                or any(q in t.lower() for t in a.tags)
            ]
        if tag:
            t_low = tag.strip().lower()
            assets = [a for a in assets if any(t.lower() == t_low for t in a.tags)]
        return assets

    def update_asset(self, asset_id: str, req: AssetUpdateRequest) -> Asset | None:
        existing = self.get_asset(asset_id)
        if not existing:
            return None
        patch = req.model_dump(exclude_none=True)
        updated = existing.model_copy(update=patch)
        return self.insert_asset(updated)

    def find_asset_by_sha256(
        self, sha256: str, asset_type: str | None = None
    ) -> Asset | None:
        conn = connect_sqlite(self.config.library_db_path)
        try:
            if asset_type:
                row = conn.execute(
                    "SELECT * FROM assets WHERE sha256 = ? AND type = ? ORDER BY created_at ASC LIMIT 1",
                    (sha256, asset_type),
                ).fetchone()
            else:
                row = conn.execute(
                    "SELECT * FROM assets WHERE sha256 = ? ORDER BY created_at ASC LIMIT 1",
                    (sha256,),
                ).fetchone()
        finally:
            conn.close()
        return self._row_to_asset(row) if row else None

    def delete_asset(self, asset_id: str) -> Asset | None:
        existing = self.get_asset(asset_id)
        if not existing:
            return None
        with sqlite_transaction(self.config.library_db_path) as conn:
            conn.execute("DELETE FROM assets WHERE asset_id = ?", (asset_id,))
        return existing

    @staticmethod
    def _row_to_asset(row) -> Asset:
        return Asset(
            asset_id=row["asset_id"],
            scope=row["scope"],
            project_id=row["project_id"],
            type=row["type"],
            part_role=row["part_role"],
            name=row["name"],
            folder=row["folder"],
            tags=json.loads(row["tags_json"]),
            file_path=row["file_path"],
            sha256=row["sha256"],
            width=row["width"],
            height=row["height"],
            default_anchor=AnchorPoint(x=row["anchor_x"], y=row["anchor_y"]),
            version=row["version"],
            identity_verified=bool(row["identity_verified"]),
            created_at=row["created_at"],
        )

    # --- Characters ---

    def create_character(self, req: CharacterCreateRequest) -> Character:
        now = utc_now_iso()
        character = Character(
            character_id=f"char_{uuid.uuid4().hex[:10]}",
            name=req.name.strip(),
            description=req.description.strip(),
            tags=req.tags,
            identity_confirmed=req.identity_confirmed,
            thumbnail_asset_id=req.thumbnail_asset_id,
            voice_profile_id=req.voice_profile_id,
            parts=req.parts,
            expressions=req.expressions,
            poses=req.poses,
            version=1,
            created_at=now,
            updated_at=now,
        )
        return self.save_character(character)

    def save_character(self, character: Character) -> Character:
        rig_payload = {
            "parts": [p.model_dump() for p in character.parts],
            "expressions": [e.model_dump() for e in character.expressions],
            "poses": [p.model_dump() for p in character.poses],
        }
        with sqlite_transaction(self.config.library_db_path) as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO characters (
                    character_id, name, description, tags_json, identity_confirmed,
                    thumbnail_asset_id, voice_profile_id, rig_json, version,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    character.character_id,
                    character.name,
                    character.description,
                    json.dumps(character.tags),
                    int(character.identity_confirmed),
                    character.thumbnail_asset_id,
                    character.voice_profile_id,
                    json.dumps(rig_payload),
                    character.version,
                    character.created_at,
                    character.updated_at,
                ),
            )
        return character

    def get_character(self, character_id: str) -> Character | None:
        conn = connect_sqlite(self.config.library_db_path)
        try:
            row = conn.execute(
                "SELECT * FROM characters WHERE character_id = ?", (character_id,)
            ).fetchone()
        finally:
            conn.close()
        return self._row_to_character(row) if row else None

    def list_characters(self, search: str | None = None) -> list[Character]:
        conn = connect_sqlite(self.config.library_db_path)
        try:
            rows = conn.execute(
                "SELECT * FROM characters ORDER BY updated_at DESC"
            ).fetchall()
        finally:
            conn.close()
        chars = [self._row_to_character(r) for r in rows]
        if search:
            q = search.strip().lower()
            chars = [
                c
                for c in chars
                if q in c.name.lower()
                or q in c.description.lower()
                or any(q in t.lower() for t in c.tags)
            ]
        return chars

    def update_character(
        self, character_id: str, req: CharacterUpdateRequest
    ) -> Character | None:
        existing = self.get_character(character_id)
        if not existing:
            return None
        patch = {
            field: getattr(req, field)
            for field in CharacterUpdateRequest.model_fields
            if getattr(req, field) is not None
        }
        patch["version"] = existing.version + 1
        patch["updated_at"] = utc_now_iso()
        updated = existing.model_copy(update=patch)
        return self.save_character(updated)

    def delete_character(self, character_id: str) -> bool:
        with sqlite_transaction(self.config.library_db_path) as conn:
            cur = conn.execute(
                "DELETE FROM characters WHERE character_id = ?", (character_id,)
            )
            return cur.rowcount > 0

    @staticmethod
    def _row_to_character(row) -> Character:
        rig = json.loads(row["rig_json"])
        return Character(
            character_id=row["character_id"],
            name=row["name"],
            description=row["description"],
            tags=json.loads(row["tags_json"]),
            identity_confirmed=bool(row["identity_confirmed"]),
            thumbnail_asset_id=row["thumbnail_asset_id"],
            voice_profile_id=row["voice_profile_id"],
            parts=[CharacterPartSlot.model_validate(p) for p in rig.get("parts", [])],
            expressions=[
                ExpressionPreset.model_validate(e) for e in rig.get("expressions", [])
            ],
            poses=[PosePreset.model_validate(p) for p in rig.get("poses", [])],
            version=row["version"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    # --- Sound Effects & Background Music ---

    def save_sound(self, sound: SoundAsset) -> SoundAsset:
        with sqlite_transaction(self.config.library_db_path) as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO sounds (
                    sound_id, name, audio_type, category, tags_json, file_path, sha256,
                    duration_ms, sample_rate, channels, codec, default_volume,
                    loopable, fade_in_ms, fade_out_ms, is_favorite, is_bundled,
                    waveform_json, license_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    sound.sound_id,
                    sound.name,
                    sound.audio_type,
                    sound.category,
                    json.dumps(sound.tags),
                    sound.file_path,
                    sound.sha256,
                    sound.duration_ms,
                    sound.sample_rate,
                    sound.channels,
                    sound.codec,
                    sound.default_volume,
                    int(sound.loopable),
                    sound.fade_in_ms,
                    sound.fade_out_ms,
                    int(sound.is_favorite),
                    int(sound.is_bundled),
                    json.dumps(sound.waveform_peaks),
                    json.dumps(sound.license.model_dump()),
                    sound.created_at,
                ),
            )
        return sound

    def get_sound(self, sound_id: str) -> SoundAsset | None:
        conn = connect_sqlite(self.config.library_db_path)
        try:
            row = conn.execute(
                "SELECT * FROM sounds WHERE sound_id = ?", (sound_id,)
            ).fetchone()
        finally:
            conn.close()
        return self._row_to_sound(row) if row else None

    def find_sound_by_sha256(self, sha256: str, audio_type: str | None = None) -> SoundAsset | None:
        query = "SELECT * FROM sounds WHERE sha256 = ?"
        params: list[Any] = [sha256]
        if audio_type:
            query += " AND audio_type = ?"
            params.append(audio_type)
        query += " ORDER BY created_at ASC LIMIT 1"
        conn = connect_sqlite(self.config.library_db_path)
        try:
            row = conn.execute(query, params).fetchone()
        finally:
            conn.close()
        return self._row_to_sound(row) if row else None

    def list_sounds(
        self,
        audio_type: str | None = None,
        category: str | None = None,
        search: str | None = None,
        tag: str | None = None,
        favorites_only: bool = False,
    ) -> list[SoundAsset]:
        query = "SELECT * FROM sounds WHERE 1=1"
        params: list[Any] = []
        if audio_type:
            query += " AND audio_type = ?"
            params.append(audio_type)
        if category:
            query += " AND category = ?"
            params.append(category)
        if favorites_only:
            query += " AND is_favorite = 1"
        query += " ORDER BY is_favorite DESC, is_bundled ASC, created_at DESC"

        conn = connect_sqlite(self.config.library_db_path)
        try:
            rows = conn.execute(query, params).fetchall()
        finally:
            conn.close()

        sounds = [self._row_to_sound(r) for r in rows]
        if search:
            q = search.strip().lower()
            sounds = [
                s
                for s in sounds
                if q in s.name.lower()
                or q in s.category.lower()
                or any(q in t.lower() for t in s.tags)
            ]
        if tag:
            t_low = tag.strip().lower()
            sounds = [s for s in sounds if any(t.lower() == t_low for t in s.tags)]
        return sounds

    def update_sound(self, sound_id: str, req: SoundUpdateRequest) -> SoundAsset | None:
        existing = self.get_sound(sound_id)
        if not existing:
            return None
        patch = {
            field: getattr(req, field)
            for field in SoundUpdateRequest.model_fields
            if getattr(req, field) is not None
        }
        updated = existing.model_copy(update=patch)
        return self.save_sound(updated)

    def delete_sound(self, sound_id: str) -> SoundAsset | None:
        existing = self.get_sound(sound_id)
        if not existing:
            return None
        with sqlite_transaction(self.config.library_db_path) as conn:
            conn.execute("DELETE FROM sounds WHERE sound_id = ?", (sound_id,))
        return existing

    @staticmethod
    def _row_to_sound(row) -> SoundAsset:
        keys = row.keys()
        return SoundAsset(
            sound_id=row["sound_id"],
            name=row["name"],
            audio_type=row["audio_type"] if "audio_type" in keys and row["audio_type"] else "sfx",
            category=row["category"],
            tags=json.loads(row["tags_json"]),
            file_path=row["file_path"],
            sha256=row["sha256"],
            duration_ms=row["duration_ms"],
            sample_rate=row["sample_rate"],
            channels=row["channels"],
            codec=row["codec"],
            default_volume=row["default_volume"],
            loopable=bool(row["loopable"]),
            fade_in_ms=row["fade_in_ms"],
            fade_out_ms=row["fade_out_ms"],
            is_favorite=bool(row["is_favorite"]),
            is_bundled=bool(row["is_bundled"]) if "is_bundled" in keys else False,
            waveform_peaks=json.loads(row["waveform_json"]),
            license=SoundLicense.model_validate(json.loads(row["license_json"])),
            created_at=row["created_at"],
        )

    # --- Export Presets ---

    def list_export_presets(self) -> list[ExportPreset]:
        conn = connect_sqlite(self.config.library_db_path)
        try:
            rows = conn.execute(
                "SELECT * FROM export_presets ORDER BY is_builtin DESC, name ASC"
            ).fetchall()
        finally:
            conn.close()
        return [self._row_to_preset(r) for r in rows]

    def get_export_preset(self, preset_id: str) -> ExportPreset | None:
        conn = connect_sqlite(self.config.library_db_path)
        try:
            row = conn.execute(
                "SELECT * FROM export_presets WHERE preset_id = ?", (preset_id,)
            ).fetchone()
        finally:
            conn.close()
        return self._row_to_preset(row) if row else None

    def create_export_preset(self, req: ExportPresetCreateRequest) -> ExportPreset:
        preset = ExportPreset(
            preset_id=f"preset_{uuid.uuid4().hex[:8]}",
            name=req.name.strip(),
            width=req.width,
            height=req.height,
            fps=req.fps,
            video_codec=req.video_codec,
            video_bitrate_kbps=req.video_bitrate_kbps,
            audio_codec="aac",
            audio_bitrate_kbps=req.audio_bitrate_kbps,
            sample_rate=req.sample_rate,
            is_builtin=False,
        )
        with sqlite_transaction(self.config.library_db_path) as conn:
            conn.execute(
                """
                INSERT INTO export_presets (
                    preset_id, name, width, height, fps, video_codec,
                    video_bitrate_kbps, audio_codec, audio_bitrate_kbps,
                    sample_rate, is_builtin
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
                """,
                (
                    preset.preset_id,
                    preset.name,
                    preset.width,
                    preset.height,
                    preset.fps,
                    preset.video_codec,
                    preset.video_bitrate_kbps,
                    preset.audio_codec,
                    preset.audio_bitrate_kbps,
                    preset.sample_rate,
                ),
            )
        return preset

    @staticmethod
    def _row_to_preset(row) -> ExportPreset:
        return ExportPreset(
            preset_id=row["preset_id"],
            name=row["name"],
            width=row["width"],
            height=row["height"],
            fps=row["fps"],
            video_codec=row["video_codec"],
            video_bitrate_kbps=row["video_bitrate_kbps"],
            audio_codec=row["audio_codec"],
            audio_bitrate_kbps=row["audio_bitrate_kbps"],
            sample_rate=row["sample_rate"],
            is_builtin=bool(row["is_builtin"]),
        )

    # --- Voice Profiles ---

    def list_voice_profiles(self) -> list[VoiceProfile]:
        conn = connect_sqlite(self.config.library_db_path)
        try:
            rows = conn.execute(
                "SELECT * FROM voice_profiles ORDER BY updated_at DESC"
            ).fetchall()
        finally:
            conn.close()
        return [self._row_to_voice_profile(r) for r in rows]

    def get_voice_profile(self, voice_profile_id: str) -> VoiceProfile | None:
        conn = connect_sqlite(self.config.library_db_path)
        try:
            row = conn.execute(
                "SELECT * FROM voice_profiles WHERE voice_profile_id = ?",
                (voice_profile_id,),
            ).fetchone()
        finally:
            conn.close()
        return self._row_to_voice_profile(row) if row else None

    def create_voice_profile(self, req: VoiceProfileUpsertRequest) -> VoiceProfile:
        now = utc_now_iso()
        profile = VoiceProfile(
            voice_profile_id=f"vp_{uuid.uuid4().hex[:10]}",
            name=req.name.strip(),
            provider_id=req.provider_id,
            provider_voice_id=req.provider_voice_id,
            language=req.language,
            settings=req.settings,
            created_at=now,
            updated_at=now,
        )
        return self.save_voice_profile(profile)

    def update_voice_profile(
        self, voice_profile_id: str, req: VoiceProfileUpsertRequest
    ) -> VoiceProfile | None:
        existing = self.get_voice_profile(voice_profile_id)
        if not existing:
            return None
        updated = existing.model_copy(
            update={
                "name": req.name.strip(),
                "provider_id": req.provider_id,
                "provider_voice_id": req.provider_voice_id,
                "language": req.language,
                "settings": req.settings,
                "updated_at": utc_now_iso(),
            }
        )
        return self.save_voice_profile(updated)

    def save_voice_profile(self, profile: VoiceProfile) -> VoiceProfile:
        with sqlite_transaction(self.config.library_db_path) as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO voice_profiles (
                    voice_profile_id, name, provider_id, provider_voice_id,
                    language, settings_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    profile.voice_profile_id,
                    profile.name,
                    profile.provider_id,
                    profile.provider_voice_id,
                    profile.language,
                    json.dumps(profile.settings),
                    profile.created_at,
                    profile.updated_at,
                ),
            )
        return profile

    def delete_voice_profile(self, voice_profile_id: str) -> bool:
        with sqlite_transaction(self.config.library_db_path) as conn:
            conn.execute(
                "UPDATE characters SET voice_profile_id = NULL WHERE voice_profile_id = ?",
                (voice_profile_id,),
            )
            cur = conn.execute(
                "DELETE FROM voice_profiles WHERE voice_profile_id = ?",
                (voice_profile_id,),
            )
            return cur.rowcount > 0

    def assign_character_voice_profile(
        self, character_id: str, voice_profile_id: str | None
    ) -> Character | None:
        existing = self.get_character(character_id)
        if not existing:
            return None
        updated = existing.model_copy(
            update={
                "voice_profile_id": voice_profile_id,
                "updated_at": utc_now_iso(),
            }
        )
        return self.save_character(updated)

    @staticmethod
    def _row_to_voice_profile(row) -> VoiceProfile:
        return VoiceProfile(
            voice_profile_id=row["voice_profile_id"],
            name=row["name"],
            provider_id=row["provider_id"],
            provider_voice_id=row["provider_voice_id"],
            language=row["language"],
            settings=json.loads(row["settings_json"]),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    # --- Workspace App Settings (AI provider config, etc.) ---

    def get_app_setting(self, key: str) -> dict[str, Any] | None:
        conn = connect_sqlite(self.config.library_db_path)
        try:
            row = conn.execute(
                "SELECT value_json FROM app_settings WHERE key = ?",
                (key,),
            ).fetchone()
        finally:
            conn.close()
        if not row:
            return None
        try:
            parsed = json.loads(row["value_json"])
            return parsed if isinstance(parsed, dict) else None
        except Exception:
            return None

    def set_app_setting(self, key: str, value: dict[str, Any]) -> None:
        with sqlite_transaction(self.config.library_db_path) as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO app_settings (key, value_json, updated_at)
                VALUES (?, ?, ?)
                """,
                (key, json.dumps(value), utc_now_iso()),
            )

    # --- Reusable Motion Library Presets (Phase 07 Batch 2) ---

    def list_motion_presets(self, category: str | None = None) -> list[MotionPreset]:
        conn = connect_sqlite(self.config.library_db_path)
        try:
            if category:
                rows = conn.execute(
                    """
                    SELECT * FROM motion_presets
                    WHERE category = ?
                    ORDER BY is_builtin DESC, updated_at DESC, name ASC
                    """,
                    (category,),
                ).fetchall()
            else:
                rows = conn.execute(
                    """
                    SELECT * FROM motion_presets
                    ORDER BY is_builtin DESC, category ASC, name ASC
                    """
                ).fetchall()
        finally:
            conn.close()
        return [self._row_to_motion_preset(r) for r in rows]

    def get_motion_preset(self, preset_id: str) -> MotionPreset | None:
        conn = connect_sqlite(self.config.library_db_path)
        try:
            row = conn.execute(
                "SELECT * FROM motion_presets WHERE preset_id = ?",
                (preset_id,),
            ).fetchone()
        finally:
            conn.close()
        return self._row_to_motion_preset(row) if row else None

    def save_motion_preset(self, preset: MotionPreset) -> MotionPreset:
        with sqlite_transaction(self.config.library_db_path) as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO motion_presets (
                    preset_id, name, category, description, is_builtin,
                    spec_json, tags_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    preset.preset_id,
                    preset.name,
                    preset.category,
                    preset.description,
                    1 if preset.is_builtin else 0,
                    preset.model_dump_json(),
                    json.dumps(preset.tags),
                    preset.created_at,
                    preset.updated_at,
                ),
            )
        return preset

    def create_motion_preset(self, req: MotionPresetCreateRequest) -> MotionPreset:
        now = utc_now_iso()
        base = self.get_motion_preset(req.base_preset_id) if req.base_preset_id else None
        if base is None:
            # Inherit accurate rig capability requirements from the matching built-in category preset
            cat_matches = self.list_motion_presets(category=req.category)
            base = next((p for p in cat_matches if p.is_builtin), None)

        req_caps = (
            req.required_capabilities
            if req.required_capabilities is not None
            else (list(base.required_capabilities) if base else ["root_movement"])
        )
        opt_caps = (
            req.optional_capabilities
            if req.optional_capabilities is not None
            else (list(base.optional_capabilities) if base else [])
        )
        preset = MotionPreset(
            preset_id=f"mp_{uuid.uuid4().hex[:10]}",
            name=req.name.strip(),
            category=base.category if base and req.base_preset_id else req.category,
            description=req.description or (base.description if base else ""),
            is_builtin=False,
            required_capabilities=req_caps,
            optional_capabilities=opt_caps,
            supported_rig_types=list(base.supported_rig_types)
            if base
            else ["full_cutout", "upper_body", "simple_cutout"],
            motion_targets=list(base.motion_targets) if base else ["root.x", "root.y"],
            supported_easings=list(base.supported_easings)
            if base
            else ["linear", "ease_in", "ease_out", "ease_in_out", "hold"],
            min_duration_ms=base.min_duration_ms if base else 300,
            max_duration_ms=base.max_duration_ms if base else 30000,
            default_parameters=req.default_parameters,
            limitations=req.limitations if req.limitations else (list(base.limitations) if base else []),
            tags=list(dict.fromkeys([*(req.tags or []), "custom"])),
            created_at=now,
            updated_at=now,
        )
        return self.save_motion_preset(preset)

    def update_motion_preset(
        self, preset_id: str, req: MotionPresetUpdateRequest
    ) -> MotionPreset | None:
        existing = self.get_motion_preset(preset_id)
        if not existing:
            return None
        updates: dict[str, Any] = {"updated_at": utc_now_iso()}
        if req.name is not None:
            updates["name"] = req.name.strip()
        if req.description is not None:
            updates["description"] = req.description
        if req.default_parameters is not None:
            updates["default_parameters"] = req.default_parameters
        if req.tags is not None:
            updates["tags"] = req.tags
        if req.limitations is not None:
            updates["limitations"] = req.limitations
        updated = existing.model_copy(update=updates)
        return self.save_motion_preset(updated)

    def duplicate_motion_preset(
        self, preset_id: str, new_name: str | None = None
    ) -> MotionPreset | None:
        existing = self.get_motion_preset(preset_id)
        if not existing:
            return None
        now = utc_now_iso()
        dup = existing.model_copy(
            deep=True,
            update={
                "preset_id": f"mp_{uuid.uuid4().hex[:10]}",
                "name": (new_name or f"{existing.name} (Copy)").strip(),
                "is_builtin": False,
                "tags": list(dict.fromkeys([t for t in existing.tags if t != "builtin"] + ["custom"])),
                "created_at": now,
                "updated_at": now,
            },
        )
        return self.save_motion_preset(dup)

    def delete_motion_preset(self, preset_id: str) -> tuple[bool, str]:
        existing = self.get_motion_preset(preset_id)
        if not existing:
            return False, "Motion preset not found."
        if existing.is_builtin:
            return False, "Built-in motion presets cannot be deleted (duplicate to customize)."
        with sqlite_transaction(self.config.library_db_path) as conn:
            cur = conn.execute(
                "DELETE FROM motion_presets WHERE preset_id = ?",
                (preset_id,),
            )
            return cur.rowcount > 0, ""

    @staticmethod
    def _row_to_motion_preset(row) -> MotionPreset:
        parsed = MotionPreset.model_validate_json(row["spec_json"])
        return parsed.model_copy(
            update={
                "preset_id": row["preset_id"],
                "name": row["name"],
                "description": row["description"],
                "is_builtin": bool(row["is_builtin"]),
                "updated_at": row["updated_at"],
            }
        )
