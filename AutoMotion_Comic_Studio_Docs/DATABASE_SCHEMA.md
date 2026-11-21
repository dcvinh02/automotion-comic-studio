# DATABASE & DOMAIN SCHEMA — INITIAL DESIGN
## AutoMotion Comic Studio

This is a conceptual baseline, not a final migration-ready schema. Refine it after reviewing Version 0.1 requirements and implementation constraints.

## Design rules
- Use stable UUIDs or equivalent IDs.
- Keep domain models independent from UI components.
- Persist project-local media using managed paths; prefer relative paths.
- Include timestamps where useful.
- Version project/schema formats.
- Validate data on load.
- Use migrations for schema evolution.
- Never silently delete fields or media during migration.

## Core entities

### Project
- `id`
- `name`
- `project_version`
- `schema_version`
- `created_at`
- `updated_at`
- `settings` (resolution, FPS, aspect ratio, defaults)
- `root_path`

### Asset
- `id`
- `project_id`
- `name`
- `asset_type` (image, audio, background, prop, character_part, other)
- `category`
- `tags`
- `source_path`
- `managed_path`
- `mime_type`
- `width`
- `height`
- `duration_ms` (nullable)
- `license_source` (nullable)
- `checksum`
- `created_at`

### Character
- `id`
- `project_id`
- `name`
- `description`
- `identity_key`
- `default_voice_profile_id` (nullable)
- `metadata`

### CharacterPart
- `id`
- `character_id`
- `asset_id`
- `part_type` (head, body, eyes, mouth, hair, arm, leg, accessory, other)
- `parent_part_id` (nullable)
- `pivot_x`
- `pivot_y`
- `default_transform`
- `z_order`

### Expression
- `id`
- `character_id`
- `name`
- `expression_type`
- `part_overrides`
- `metadata`

### Scene
- `id`
- `project_id`
- `name`
- `scene_order`
- `duration_frames`
- `background_asset_id` (nullable)
- `camera_settings`
- `metadata`

### SceneCharacter
- `id`
- `scene_id`
- `character_id`
- `instance_name`
- `initial_transform`
- `z_order`
- `metadata`

### TimelineEvent
- `id`
- `project_id`
- `scene_id` (nullable)
- `track_type` (video, animation, voice, sfx, ambient, bgm)
- `event_type`
- `start_frame`
- `end_frame`
- `asset_id` (nullable)
- `target_id` (nullable)
- `payload`
- `created_at`
- `updated_at`

### Keyframe
- `id`
- `timeline_event_id`
- `frame`
- `property`
- `value`
- `interpolation` (linear, ease-in, ease-out, ease-in-out, step; extensible)

### SoundEffect
- `id`
- `asset_id`
- `name`
- `category`
- `tags`
- `default_volume`
- `loopable`
- `default_fade_in_ms`
- `default_fade_out_ms`
- `license_source`

### VoiceProfile
- `id`
- `name`
- `provider`
- `provider_voice_id`
- `language`
- `settings`
- `metadata`

### DialogueLine
- `id`
- `scene_id`
- `character_id`
- `text`
- `sequence`
- `audio_asset_id` (nullable)
- `start_frame` (nullable)
- `end_frame` (nullable)
- `emotion`
- `metadata`

### RenderJob
- `id`
- `project_id`
- `status` (pending, running, completed, failed, cancelled, paused)
- `progress`
- `settings`
- `output_path`
- `error_message`
- `created_at`
- `updated_at`

## Timeline convention
- Store timing in integer frames for animation/render determinism.
- Project FPS is explicit.
- Convert display time to frames using a single shared utility.
- Avoid mixing floating-point seconds and frame values in persisted event timing without explicit units.

## Relationship overview
Project owns assets, characters, scenes, timeline events, and render jobs.
Character owns character parts and expressions.
CharacterPart references reusable assets.
Scene contains character instances and timeline events.
TimelineEvent may reference an asset, character, dialogue line, or other target through typed fields/payload.
RenderJob belongs to a project.

## Open decisions for implementation
- SQLite table layout versus JSON payloads for flexible metadata.
- Asset deduplication strategy.
- Project folder/media ownership and relinking.
- Undo/redo event model.
- Migration strategy and compatibility guarantees.
- Whether cross-project asset library is introduced in 0.1 or later.
