"""Asset & Character Rig business logic (Module 02)."""

from __future__ import annotations

import shutil
import uuid
from pathlib import Path
from PIL import Image, UnidentifiedImageError

from app.config import AppConfig
from app.logging_config import get_logger
from database.library_repo import LibraryRepository
from schemas.asset import Asset, AssetScope, AssetType, PartRole
from schemas.character import Character, CharacterCreateRequest, CharacterUpdateRequest
from schemas.common import AnchorPoint, utc_now_iso
from utils.paths import (
    compute_sha256_bytes,
    safe_resolve_under,
    sanitize_filename,
    to_posix_relative,
)

logger = get_logger("asset_engine")

_TYPE_TO_SUBDIR: dict[AssetType, str] = {
    "character_part": "characters",
    "background": "locations",
    "prop": "props",
    "spritesheet": "characters",
}

ALLOWED_IMAGE_EXTENSIONS = {".png", ".webp"}


class AssetService:
    def __init__(self, config: AppConfig, repo: LibraryRepository) -> None:
        self.config = config
        self.repo = repo

    def import_image_bytes(
        self,
        *,
        data: bytes,
        original_filename: str,
        name: str | None = None,
        asset_type: AssetType = "character_part",
        part_role: PartRole | None = None,
        folder: str = "general",
        tags: list[str] | None = None,
        scope: AssetScope = "global",
        project_id: str | None = None,
        anchor_x: float = 0.5,
        anchor_y: float = 0.5,
        identity_verified: bool = True,
    ) -> Asset:
        ext = Path(original_filename).suffix.lower()
        if ext not in ALLOWED_IMAGE_EXTENSIONS:
            raise ValueError(
                f"Unsupported image format {ext!r}. Allowed: {', '.join(sorted(ALLOWED_IMAGE_EXTENSIONS))}"
            )

        if not data:
            raise ValueError("Uploaded image file is empty")

        # Validate image and inspect dimensions using Pillow
        from io import BytesIO

        try:
            with Image.open(BytesIO(data)) as img:
                img.verify()
            with Image.open(BytesIO(data)) as img:
                width, height = img.size
        except (UnidentifiedImageError, OSError) as exc:
            raise ValueError(f"Invalid or corrupted image file: {exc}") from exc

        sha256 = compute_sha256_bytes(data)

        # Avoid duplicating identical source PNG files already in the library
        existing = self.repo.find_asset_by_sha256(sha256, asset_type=asset_type)
        if existing:
            try:
                existing_path = self.resolve_asset_file(existing)
                if existing_path.is_file():
                    if part_role and not existing.part_role:
                        existing = existing.model_copy(update={"part_role": part_role})
                        self.repo.insert_asset(existing)
                    logger.info("Reusing identical asset %s (%s)", existing.asset_id, existing.name)
                    return existing
            except Exception:
                pass

        asset_id = f"ast_{uuid.uuid4().hex[:12]}"
        clean_folder = sanitize_filename(folder.replace("/", "_"), fallback="general")
        subdir = _TYPE_TO_SUBDIR.get(asset_type, "characters")
        clean_name = sanitize_filename(Path(original_filename).stem, fallback=asset_id)

        dest_dir = self.config.asset_library_dir / subdir / clean_folder
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest_file = dest_dir / f"{clean_name}_{asset_id[-6:]}{ext}"
        dest_file.write_bytes(data)

        rel_path = to_posix_relative(dest_file, self.config.asset_library_dir)
        display_name = (name or Path(original_filename).stem).strip() or asset_id

        asset = Asset(
            asset_id=asset_id,
            scope=scope,
            project_id=project_id,
            type=asset_type,
            part_role=part_role,
            name=display_name,
            folder=clean_folder,
            tags=[t.strip() for t in (tags or []) if t.strip()],
            file_path=rel_path,
            sha256=sha256,
            width=width,
            height=height,
            default_anchor=AnchorPoint(x=anchor_x, y=anchor_y),
            version=1,
            identity_verified=identity_verified,
            created_at=utc_now_iso(),
        )
        self.repo.insert_asset(asset)
        logger.info("Imported asset %s (%s, %dx%d)", asset.asset_id, asset.name, width, height)
        return asset

    def resolve_asset_file(self, asset: Asset) -> Path:
        return safe_resolve_under(self.config.asset_library_dir, asset.file_path)

    def delete_asset_and_file(self, asset_id: str) -> bool:
        deleted = self.repo.delete_asset(asset_id)
        if not deleted:
            return False
        try:
            path = self.resolve_asset_file(deleted)
            if path.is_file():
                path.unlink()
        except Exception as exc:
            logger.warning("Failed to remove file for deleted asset %s: %s", asset_id, exc)
        return True

    def validate_character_rig(self, parts: list) -> None:
        """Ensure character rig slots have unique IDs and an acyclic parent hierarchy."""
        slot_ids = {p.slot_id for p in parts}
        if len(slot_ids) != len(parts):
            raise ValueError("Duplicate slot_id found in character rig")

        parent_map = {p.slot_id: p.parent_slot_id for p in parts}
        for slot_id, parent_id in parent_map.items():
            if parent_id is not None and parent_id not in slot_ids:
                raise ValueError(
                    f"Slot {slot_id!r} references missing parent_slot_id {parent_id!r}"
                )
            # Detect cycles
            visited: set[str] = {slot_id}
            curr = parent_id
            while curr is not None:
                if curr in visited:
                    raise ValueError(f"Cycle detected in character rig hierarchy at {curr!r}")
                visited.add(curr)
                curr = parent_map.get(curr)

    @staticmethod
    def _pick_default_thumbnail(parts: list) -> str | None:
        for preferred_role in ("head", "body"):
            for p in parts:
                if p.part_role == preferred_role and p.default_asset_id:
                    return p.default_asset_id
        for p in parts:
            if p.default_asset_id:
                return p.default_asset_id
        return None

    def create_character(self, req: CharacterCreateRequest) -> Character:
        self.validate_character_rig(req.parts)
        if not req.thumbnail_asset_id and req.parts:
            auto_thumb = self._pick_default_thumbnail(req.parts)
            if auto_thumb:
                req = req.model_copy(update={"thumbnail_asset_id": auto_thumb})
        char = self.repo.create_character(req)
        logger.info("Created character %s (%s, %d parts)", char.character_id, char.name, len(char.parts))
        return char

    def update_character(self, character_id: str, req: CharacterUpdateRequest) -> Character | None:
        if req.parts is not None:
            self.validate_character_rig(req.parts)
            if req.thumbnail_asset_id is None:
                existing = self.repo.get_character(character_id)
                if existing and not existing.thumbnail_asset_id:
                    auto_thumb = self._pick_default_thumbnail(req.parts)
                    if auto_thumb:
                        req = req.model_copy(update={"thumbnail_asset_id": auto_thumb})
        char = self.repo.update_character(character_id, req)
        if char:
            logger.info("Updated character %s (v%d)", char.character_id, char.version)
        return char
