# AutoMotion Comic Studio — Architecture Documentation (Version 0.1)

Aligned with Master Technical Specification v2.0 (`Kiến trúc nền tảng.rtf`).

## 1. Process & Communication Architecture

- **Electron Main Process (`frontend/electron/main.ts`):**
  - Dynamically binds a free localhost port on `127.0.0.1` and generates a 48-char random `AMCS_TOKEN`.
  - Spawns Python 3.12 (`backend/.venv`) running FastAPI/Uvicorn with `AMCS_PORT`, `AMCS_TOKEN`, `AMCS_PARENT_PID`, and `AMCS_WORKSPACE_DIR`.
  - Spawns a hidden non-throttled Electron BrowserWindow (`?mode=render-worker`) hosting the **PixiJS v8 WebGL Offscreen Renderer** with `powerSaveBlocker` during active exports.
  - Terminates both render worker and Python backend cleanly on `before-quit`.
- **Python Backend (`backend/app/main.py`):**
  - Enforces `X-AMCS-Token` (or `?token=` for media/WS URLs) on all `/api/v1/*` and `/ws/*` routes except `/api/v1/health`.
  - Runs a Parent-PID watchdog every 2 seconds so an unexpected Electron crash never leaves orphan Uvicorn/FFmpeg processes holding SQLite locks.
- **Persistence (SQLite WAL Mode):**
  - Global reusable library: `workspace/asset_library/library.db` (`assets`, `characters`, `sounds`, `export_presets`).
  - Per-project database: `workspace/projects/<project_id>/project.db` (`project_meta`, `project_state`, `jobs`, `render_chunks`) with atomic online `.backup()` snapshots in `backups/`.

## 2. Deterministic Master Timeline & WYSIWYG Parity

- Display / storage time unit: **milliseconds (`ms`)**.
- Render execution time unit: **frame index** (`frame_index = floor(ms * fps / 1000)`).
- Single pure deterministic evaluator (`frontend/src/engine/evaluator.ts`, mirrored in `backend/core/render_engine/software_compositor.py`):
  - Hierarchical 2D Cutout Rig matrix composition (`body -> head -> eyes/mouth/hair`, `arms/legs`) with independent cross-branch `z_index` sorting.
  - Keyframe interpolation (`linear`, `ease_in`, `ease_out`, `ease_in_out`, `cubic_bezier`, `step`).
  - Seeded deterministic procedural motion (`Auto-Blink`, `Breathing`, `Idle` head sway, `WALKING`/`RUNNING` bounce & limb swing).
  - Camera Zoom / Pan / Rotation & Scene Fade transitions.

## 3. Chunked Export & Audio Mixing Pipeline

1. **Pre-Flight Quality Control (`backend/core/quality_engine/checker.py`):** Blocks export on missing assets, missing character definitions, missing sound files, invalid timeline bounds, or missing FFmpeg; surfaces warnings for unconfirmed character identity, unverified SFX licenses, and dense SFX overlaps.
2. **Chunk Orchestration (`backend/core/render_engine/orchestrator.py`):** Splits Master Timeline into fixed-duration chunks (default 10s), persists chunk checkpoints in `render_chunks`, streams raw RGBA frames from PixiJS WebGL over binary WebSocket (`/ws/render-stream/{job_id}/{chunk_id}`) with 2-frame ack backpressure directly into FFmpeg stdin (`h264_videotoolbox` on macOS, `h264_nvenc`/`h264_qsv` on Windows, `libx264` fallback).
3. **Audio Mixing (`backend/core/render_engine/audio_mixer.py`):** Builds an FFmpeg `filter_complex` mixing all non-muted Master Timeline SFX events (`trim`, `atempo`, `aloop`, `afade`, stereo `pan`, `volume`, `adelay`, `amix=normalize=0`, `alimiter=limit=0.95`) and verifies peak dBFS via `volumedetect`.
4. **Mux & Post-Export Verification:** Concatenates chunks with `-c:v copy`, muxes AAC 48kHz audio with `+faststart`, and verifies video/audio stream integrity & duration via `ffprobe`.
5. **Resume & Recovery:** Interrupted/failed jobs skip already-completed chunk MP4 files on Resume.

## 4. Phase 02 Studio UI & Workspace Architecture

- **Centralized Design Tokens (`frontend/src/styles/tokens.css`):** Deep charcoal surfaces, restrained blue-violet studio accent (`#7c6cf6`), non-color-only semantic status indicators, accessible `:focus-visible` rings, and `[data-theme]` switching (`dark-studio`, `slate-contrast`).
- **Reusable Component System (`frontend/src/components/ui/`):** `BrandLogo`, `CollapsibleSection`, `NumericScrubber` (horizontal drag-to-scrub numeric controls), `ToggleSwitch`, `SearchInput`, `ContextMenuOverlay`, and `StatusBadge`.
- **Modular Workspaces (`frontend/src/stores/useWorkspaceStore.ts`):** `Animation`, `Scene`, `Audio`, `Assets`, and roadmapped `Script (v0.2)` workspaces share one single `useProjectStore` without duplicating or resetting project state.
- **Responsive Container-Query Layout:** Center canvas HUD & Transport Bar adapt smoothly via `@container center-stage` breakpoints alongside responsive panel bounds across Large (`1480×920`), Medium (`1200×760`), and Small (`1024×660`) desktop windows.
- See [docs/UI_DESIGN_SYSTEM.md](UI_DESIGN_SYSTEM.md) for the complete UI design reference.

## 5. Phase 03 Core Animation Engine & Bilingual Localization

- **Bilingual Localization (`frontend/src/i18n/useLocaleStore.ts`, `locales/vi.json`, `locales/en.json`):**
  - Default install locale is Vietnamese (`vi`), with instant non-destructive live switching to English (`en`) via **Settings → General → Language** and the Top Bar toggle (`localStorage['amcs.locale']`).
  - Safe fallback chain (`active -> en -> key`) and strict separation of UI strings from user-authored project/scene/character/asset names.
- **Pooled PixiJS Scene Graph (`frontend/src/renderer/PixiSceneGraph.ts`):**
  - Persistent display-node registry keyed by stable IDs (`propSprites`, `charContainers`, `charPartSprites`, `charPlaceholders`) — eliminates per-frame sprite allocation/destruction.
- **Hierarchical Evaluator & Interpolation (`frontend/src/engine/evaluator.ts`, `interpolation.ts`, `presets.ts`):**
  - Supports hierarchical parent-child `ScenePropInstance` composition (mirrored in `software_compositor.py`), pivot/anchor transforms, visibility/lock flags, independent `character_part` keyframing, frame-quantized timing (`24/25/30/60` FPS), deterministic `hold`/`linear`/`ease_in`/`ease_out`/`ease_in_out`/`cubic_bezier` interpolation, 9 editable keyframe-generating animation presets, horizontal keyframe dragging, copy/paste, and expandable Timeline property sub-tracks.


## Phase 04 — Layer/Timeline Sync, Script Engine & Voice Provider Architecture

- **Single-Source-of-Truth Layer Synchronization (`frontend/src/engine/layerSync.ts`)**:
  - `reconcileProjectLayersAndTimeline()` runs on project creation, load, backup restore, and every mutation to guarantee 1-to-1 synchronization between Scene Graph layers (`SceneCharacterInstance`, `ScenePropInstance`, and empty layers where `layer_kind: "empty"` & `asset_id: null`), Layer Panel rows, Inspector controls, PixiJS Canvas Z-order, and Master Timeline tracks.
  - Non-colliding `order_index` bands: `scene = 0`, `camera = 1`, visual layers `10+` (front-to-back descending `z_index` where top row = frontmost = highest `z_index`), `voice = 500+`, `sfx = 1000+`.
  - Layer reordering (drag-and-drop or Up/Down/Front/Back) updates `z_index` cleanly while preserving all keyframes, animation clips, transforms, and parent-child hierarchies.
- **Structured Script Engine (`backend/schemas/script.py`, `backend/core/script_engine/service.py`, `frontend/src/engine/scriptEngine.ts`)**:
  - Persists `ScriptDocument` → `ScriptScene` → `ScriptEntry` (`dialogue | narration | action`) inside `project.db` (`project_state.script_json`, schema migration `v1 → v2`).
  - Dialogue lines reference stable `character_id` (character renames never break scripts), preserve verbatim user text, and compute scene/episode durations using real generated audio duration when present.
- **Provider-Based Voice Engine (`backend/providers/voice_provider.py`, `backend/core/voice_engine/service.py`, `backend/api/voice.py`)**:
  - Extensible `VoiceProvider` ABC + `VoiceProviderRegistry` with three registered adapters:
    1. `local_os_tts`: Offline macOS `/usr/bin/say` + FFmpeg 48kHz PCM WAV (labeled `LOCAL OS SPEECH`, not AI TTS).
    2. `f5_tts`: Real external HTTP adapter for F5-TTS (reports honest `NOT CONFIGURED` status and HTTP 422 guidance unless `AMCS_F5_TTS_URL` is configured).
    3. `dev_mock`: Deterministic synthetic test WAV generator explicitly badged `DEV MOCK (TEST AUDIO)`.
  - `library.db` v2 persists reusable `voice_profiles` linked via `characters.voice_profile_id`; `project.db` v2 persists `voice_audio_assets` with real FFmpeg durations and waveform peaks under `projects/<id>/audio/voice/<audio_asset_id>.wav`, plus one-click registration into the Master Timeline `voice` track for MP4 export mixing.


## Phase 05 — Batch 1: Keyframe Engine Repair, Multi-Selection & Atomic Timeline Operations

- **Pure Keyframe Engine (`frontend/src/engine/keyframeEngine.ts`) & Exact Frame Bijection (`evaluator.ts`)**:
  - Fixed `msToFrame()` to use nearest-frame rounding (`Math.round`), establishing an exact bijection with `frameIndexToQuantizedMs()` across 24, 25, 30, and 60 FPS and eliminating off-by-one frame drift during keyframe clicks/edits.
  - Collapsed summary tracks group keyframes into per-frame **Summary Keyframe Clusters** (`groupTrackKeyframesByFrame`) so dragging moves all properties at that frame atomically without leaving sibling property keyframes behind as ghost markers.
  - Enforced collision-free `(target_type, target_id, property, frame)` uniqueness via `applyMoveKeyframes()` and `deduplicateKeyframesByChannelFrame()` (also mirrored in `software_compositor.py`). Drag previews compute every frame from the immutable pre-drag snapshot so passing over intermediate keyframes never destroys them, while committing ONE atomic Undo entry on release (and zero entries on no-op or `Escape` cancel).
- **Multi-Selection & Bulk Operations (`useProjectStore.ts`, `MasterTimeline.tsx`, `App.tsx`)**:
  - Supports single click, `Cmd/Ctrl`-click toggle, `Shift`-click range selection, empty-lane marquee box drag selection, `Shift+Drag` ruler time-range selection, Select All in Track/Property (`Cmd/Ctrl+A`), and Clear Selection (`Escape`).
  - Atomic bulk operations: rigid multi-keyframe drag (preserving exact relative timing under boundary clamping), Move to Playhead, Bulk Copy/Paste (`Cmd/Ctrl+C`/`V`), Bulk Duplicate (`Cmd/Ctrl+D`), Bulk Delete (`Delete`/`Backspace`), Bulk Easing change, and `Alt+Arrow` frame nudging.
  - Property sub-tracks sort in canonical deterministic order (`x → y → rotation_deg → scale_x → scale_y → opacity → ...`) in `presets.ts`.


## 10. Phase 05 — Batch 2: Character Builder, Character Assembly & 2D Rigging

- **Unified Character Model (No Parallel Schema):**
  - Extends `library.db`'s existing `characters` table and `CharacterPartSlot` inside `rig_json` with backward-compatible `locked: bool = False`, expanded 20-role `PartRole` (`body`, `head`, `hair`, `hair_back`, `hair_front`, `eyes`, `eyebrows`, `mouth`, `left_arm`, `right_arm`, `left_hand`, `right_hand`, `left_leg`, `right_leg`, `left_foot`, `right_foot`, `clothing`, `accessory`, `custom`, `other`), and automatic `thumbnail_asset_id` selection (`head → body → first assigned PNG`) on create and update.
  - `AssetService.import_image_bytes` checks `LibraryRepository.find_asset_by_sha256` to reuse existing identical PNG files on disk without duplicating storage; `DELETE /api/v1/characters/{id}` never removes shared source PNG assets.
  - `LibraryRepository.update_character` builds partial updates from live Pydantic model fields on `CharacterUpdateRequest` so nested `CharacterPartSlot`, `ExpressionPreset`, and `PosePreset` instances remain strongly typed during `save_character`.
- **Pure 2D Rigging & Transform Math (`frontend/src/engine/characterRigEngine.ts`):**
  - Exact 2D affine matrix propagation (`computePartWorldMatrices`) matching `PixiSceneGraph.ts` and `software_compositor.py`.
  - World-transform-preserving cycle-safe reparenting (`reparentPartPreservingWorldTransform`) and group/ungroup helpers.
  - Exact pivot compensation (`movePartPivotPreservingVisualPosition`): adjusts both the moved part's local `(x, y)` AND every direct child's local `(x, y)` so artwork and attached limbs stay visually stationary while rotation orbits the new pivot.
  - Truthful rig capability analysis (`analyzeCharacterRig`) and real non-mutating live preview pose evaluation (`evaluateRigPreviewPose` / `applyRigPreviewPoseToCharacter`) for `Idle`, `Blink`, `Wave`, `Head Turn`, `Walk`, `Run`, and `Bounce`.
- **Character Builder & Management UI (`CharacterRigEditor.tsx` & `CharactersPanel.tsx`):**
  - Always-enabled `Create Character` entry point (auto-naming `Character N` when input is blank) launching the 3-column Character Builder with 5-step guided progress bar, multi-PNG dropzone + Library reuse picker, drag-and-drop Hierarchy Tree, interactive PixiJS Assembly Canvas (`Move`, `Rotate`, `Scale`, `Pivot`, grid snap, alignment, parent/child bone connectors), Pro Transform & Pivot Inspector, and Live Rig Preview bar.
  - Upgraded Character Library cards with real auto-thumbnails, `Rig Ready` / `Basic Rig` / `Incomplete` badges, assigned/total counts, missing-part warnings, creation dates, inline rename, duplicate, and asset-safe delete.


## 11. Phase 05 — Batch 3: Audio Library (SFX & BGM), Audio Timeline & Subtitle Studio

- **Unified Separated Audio Library (`library.db` v2 → v3):**
  - Migrates `sounds` safely with `audio_type TEXT NOT NULL DEFAULT 'sfx'` (`'sfx' | 'bgm'`) and `is_bundled INTEGER NOT NULL DEFAULT 0`.
  - Separates **24 SFX categories** and **14 BGM categories** cleanly via `GET /api/v1/sounds?audio_type=...` and `GET /api/v1/sounds/categories?audio_type=...`.
  - Ships a 100% original procedural **CC0-1.0 Starter Audio Pack** (`backend/core/sound_engine/starter_pack.py`: 24 SFX + 10 seamless BGM loops) seeded idempotently once on first workspace bootstrap alongside a machine-readable `starter_pack_manifest.json` (`GET /api/v1/sounds/manifest`).
  - `AudioPreviewEngine` (`frontend/src/engine/audioPreviewEngine.ts`) uses an LRU-capped buffer cache (max 24 decoded `AudioBuffer`s), single-instance Play/Pause/Stop preview preventing overlapping previews, and synchronized playback across all 4 audio tracks (`voice`, `sfx`, `bgm`, `ambient`).
- **Audio & Subtitle Master Timeline (`MasterTimeline.tsx`):**
  - Supports **Voice**, **SFX**, **BGM**, and **Ambient** tracks with drag-and-drop placement, Move, Left Trim (`trim_start_ms` + `start_ms`), Right Trim (`end_ms`), visual fade-in/out ramps, Loop indicator, Mute, Solo, and Lock.
  - Adds a dedicated **Subtitle Track** (`track_type === 'subtitle'`) with independent timed `SubtitleSegment` blocks, click-to-select & playhead jump, `Shift+Click` multi-select, bulk move, left/right edge resize, visibility/lock toggles, and context menu (Split, Merge, Duplicate, Hide/Show, Delete).
- **Subtitle Studio & Export Integration (`project.db` v2 → v3):**
  - Persists `ProjectState.subtitles` (`SubtitleDocument`: reusable `SubtitleStyle` presets + exact integer-millisecond `SubtitleSegment` cues) in `project_state.subtitles_json` via safe backward-compatible v2 → v3 migration.
  - 5 editable built-in reusable presets (`Classic White`, `Cinematic`, `Bold Comic`, `Minimal`, `High Contrast`) + custom styles.
  - Shared pixel-faithful subtitle rendering across **Live Stage Preview** (`PixiSceneGraph.renderSubtitles`), **PixiJS WebGL Burn-in Export** (`OffscreenRenderWorker.tsx`), and **Pillow Software Burn-in Export** (`software_compositor.py`), plus **FFmpeg Soft Subtitle Track** (`-c:s mov_text`) and **UTF-8 Sidecar `.srt`** (`orchestrator.py`).
  - UTF-8 Vietnamese/multiline SRT Import (with line-numbered validation preview) & SRT/ASS Export (`backend/api/subtitles.py`, `frontend/src/engine/subtitleEngine.ts`), plus Script & Voice sync truthfully distinguishing exact `voice_duration` vs `estimated` timing.

## Phase 06 Batch 1 — AI Director: Script Intelligence Engine & Automatic Scene Breakdown
- **Real Structured LLM Provider Abstraction (`backend/providers/llm_provider.py`):**
  - Implements `providers.interfaces.LLMProvider` over async `httpx` with zero hardcoded API keys: `OpenAILLMProvider` (`/v1/chat/completions`, JSON object mode), `GeminiLLMProvider` (`:generateContent`, `responseMimeType: application/json`), and `OpenAICompatibleLLMProvider` (Ollama / LM Studio / vLLM / custom servers).
  - `LLMProviderRegistry` persists provider settings and user-supplied keys locally in `library.db` (`app_settings` table, schema v4) with environment variable fallback (`OPENAI_API_KEY` / `GEMINI_API_KEY` / `AMCS_*`), key masking (`mask_api_key`), strict Pydantic validation, exponential backoff retries on transient/malformed responses, timeout mapping (`504`), cancellation (`499`), and explicit `LLMNotConfiguredError` (`400`) when unconfigured (no fake/mock fallback).
- **Chunked Script Intelligence & Consolidation (`backend/core/director_engine/service.py`, `backend/api/director.py`, `backend/schemas/director.py`):**
  - Non-destructively indexes `project.script` (or temporary custom text) into verbatim paragraphs, splits long scripts on paragraph boundaries with rolling summary + known character registry, runs conservative post-chunk character/alias consolidation (flagging shared/partial-token aliases as ambiguous instead of over-merging; keeping appearance `"unspecified"` when absent), extracts verbatim multilingual dialogue/narration with unresolved speaker detection, and synthesizes global `StoryOverview`, `NarrativeBeat`s, `ProductionAnalysis`, and grounded `SceneBreakdownItem`s with `original_ai_snapshot` and `original_scenes_snapshot`.
  - Per-project async lock guards duplicate requests; unchanged script SHA-256 hash avoids redundant calls unless `force=True`; WebSocket `director_progress` broadcasts live chunk progress; single-scene regeneration (`POST /api/v1/director/{project_id}/regenerate-scene/{scene_breakdown_id}`) strictly preserves `user_edited_fields`.
  - Safe backward-compatible SQLite `v3 → v4` migration (`project_state.director_json` + `library.db` `app_settings`).
- **Frontend Review Workspace & Pure Director Engine (`frontend/src/engine/directorEngine.ts`, `frontend/src/stores/useDirectorStore.ts`, `frontend/src/components/stage/DirectorWorkspace.tsx`, `frontend/src/components/sidebar/DirectorSidebarPanel.tsx`):**
  - Pure, Undo/Redo-enabled operations for character edit/merge/alias separation/Library Character linking (without duplication), verbatim speaker resolution, lossless Scene Split/Merge/Reorder/Delete/Restore, and explicit commit (`applyAcceptedScenesToProjectState`) into `ScriptScene` + Stage `Scene` without ever overwriting `script.raw_source_text` or pre-existing user scenes.
  - 4-tab bilingual (Vietnamese & English) Review Workspace with explicit visual tiers separating Original Script Source, Extracted Script Facts, Editable AI Suggestions, and User Edit Protection.

## Phase 06 Batch 2 — AI Storyboard, Shot Planning & Camera Direction
- **Storyboard Domain & Safe v4 → v5 Migration (`backend/schemas/storyboard.py`, `backend/database/project_migrations.py`, `backend/database/project_repo.py`):**
  - Persists `StoryboardDocument` (`project_state.storyboard_json`, schema v5) containing stable `StoryboardShot` records (11 shot sizes, 8 camera angles, 13 camera movements, `camera_support_status`, `Camera2DKeyPlan`, varied scene-relative timings, `ShotCharacterStaging`, verbatim `dialogue_refs`/`narration_refs`, `locked`, `user_edited_fields`, `original_ai_snapshot`), reviewable `ContinuityWarning`s, per-scene content `scene_hashes`, and `generation_history`.
- **Honest 2D Camera Capability Matrix (`backend/core/storyboard_engine/camera_capabilities.py`, `frontend/src/engine/storyboardEngine.ts`):**
  - Deterministically maps each camera movement against the real PixiJS/WebGL 2D camera (`x`, `y`, `zoom`, `rotation_deg`): `supported` (`static`, `pan_left`, `pan_right`, `tilt_up`, `tilt_down`, `zoom_in`, `zoom_out`), `2d_approximation` (`dolly_in`, `dolly_out`, `tracking`, `camera_follow`, `shake`), and `unsupported_suggestion` (`parallax`).
- **Deterministic Continuity Engine (`backend/core/storyboard_engine/continuity.py`, mirrored in `storyboardEngine.ts`):**
  - Checks consecutive shots for screen position jumps, 180° facing flips, entry/exit mismatches, mid-dialogue disappearances, invisible reacting characters, unstaged dialogue speakers, sudden environment shifts, prop continuity, and missing Character Library assets (`is_missing_asset`) without ever auto-rewriting user content.
- **Storyboard Generation Service & REST API (`backend/core/storyboard_engine/service.py`, `backend/api/storyboard.py`):**
  - Resolves approved scenes from Batch 1 AI Director (`review_status == "accepted"`) or existing `ScriptScene`/`Stage Scene`s; skips unchanged scenes via `scene_hashes` unless `force=True`; preserves `locked` shots under `preserve_locked` and enforces explicit `confirm_replace_all=true` for full scene replacement; preserves `user_edited_fields` during single-shot regeneration; persists incrementally after each scene so completed scenes survive mid-run provider errors or cancellation (`storyboard_progress` WS events).
- **Storyboard Workspace & 2D Schematic Blueprint (`frontend/src/components/stage/StoryboardWorkspace.tsx`, `ShotCompositionPreview.tsx`, `StoryboardSidebarPanel.tsx`):**
  - Promoted `Storyboard` from roadmap to a core bilingual (VI/EN) workspace featuring approved scene selector, live SVG 2D Composition Blueprints (clearly labeled `2D SCHEMATIC`, never falsely presented as AI-generated artwork), proportional scene shot timeline strip, continuity warnings drawer, full shot editing with Undo/Redo, and explicit stage scene duration reconciliation.
- **Phase 06 Batch 3 — AI Production Planner, Real Readiness Checking & Safe Timeline Integration (`project.db` schema v6):**
  - Added `production_plan_json` column to `project_state` with safe backward-compatible v5 → v6 SQLite migration preserving all prior scenes, timeline, script, subtitles, director analysis, and storyboard data.
  - Added `backend/schemas/production.py`, `backend/core/production_engine/matcher.py`, `backend/core/production_engine/service.py`, and `backend/api/production.py` (`/api/v1/production/*`):
    - Strictly grounds every matched character rig, PNG background/prop asset, SFX/BGM sound clip, voice audio clip, and subtitle reference against real `library.db` & `project.db` IDs (never fabricating IDs).
    - Semantic Asset Matching (`existing_compatible`, `existing_potentially_compatible`, `missing`, `requires_new_asset`, `requires_review`) with single-canonical-concept token expansion and ambiguity detection.
    - License-Safe Audio Matching (`is_sound_license_safe`) restricting auto-placement exclusively to bundled CC0 or verified royalty-free/CC-BY/user-imported audio; unverified/copyrighted music is never auto-matched.
    - 15-category Animation Mapping grounded directly against real `evaluator.ts` / `presets.ts` procedural states (`IDLE`, `WALKING`, `RUNNING`, `SPEAKING`, `REACTING`, `TRANSITION`), part slots (`eyes:closed`, `right_arm`/`left_arm`, `head`), and pose presets — honestly flagging unsupported categories (`fall`, `attack`, `custom`, `sit` without pose) with reasons and manual alternatives.
    - Real data-driven Production Readiness Checker (`ready`, `needs_character`, `needs_rig`, `needs_assets`, `needs_animation`, `needs_camera_setup`, `needs_audio`, `needs_review`, `unsupported`) and `execution_capability` (`full` | `partial` | `blocked`), plus zero-AI-call `POST /refresh-readiness`.
    - Scene SHA-256 hash caching (`force=False`), locked shot protection, edit-protected single-shot regeneration (`preserve_user_edits`), incremental per-scene persistence (`status="partial"` on partial failure), cancellation (`499`), and WebSocket `production_progress` broadcasts.
  - Added `frontend/src/engine/productionEngine.ts`, `useProductionStore.ts`, Undo/Redo-backed `useProjectStore.ts` production actions, `ProductionSidebarPanel.tsx`, `ProductionWorkspace.tsx` (including the 5-step navigable AI Director Pipeline Stepper), and `TimelineApplyPreviewModal.tsx`:
    - Preview Before Applying modal inspecting exact shot timeline windows, supported operations, skipped unsupported items, and detected overlaps against non-owned pre-existing user timeline keyframes/clips/audio/subtitles.
    - Safe insertion strategies (`update_owned_only`, `skip_conflicting`, `append_after_existing`) and `timeline_refs` ownership guaranteeing 100% idempotent re-application with zero duplicates and zero silent overwrites of user-created timeline content.

## Phase 07 Batch 1 — Scene Execution Engine & Automated Scene Assembly (`project.db` schema v7)
- **Editable Shot Persistence & Safe v6 → v7 Migration (`backend/schemas/scene.py`, `backend/schemas/scene_execution.py`, `backend/database/project_migrations.py`):**
  - Extended `Scene` with optional `shots: list[SceneShot]` (each storing isolated `background_asset_id`, `background_color`, `camera_default`, `character_states: list[ShotCharacterState]`, `prop_states: list[ShotPropState]`, `staging_fallbacks`, `warnings`, `status`) and `execution_meta: SceneExecutionMeta` (`owned_character_instance_ids`, `owned_prop_instance_ids`, `source_scene_id`, `production_plan_id`), backward-compatible with v1–v6 SQLite project files (`PROJECT_SCHEMA_VERSION = "7"`).
- **Dedicated Scene Execution Service Layer (`backend/core/scene_execution_engine/`, `backend/api/scene_execution.py`):**
  - `validator.py`: Structured pre-execution validation (`ready`, `warning`, `missing_dependency`, `unsupported`, `invalid`, `needs_review`) verifying real `library.db` character IDs & assembled PNG rig parts, real `library.db` asset IDs & on-disk files (never fabricating IDs), canvas dimensions/FPS, shot timings, 2D camera capabilities, animation capabilities, and existing assembled state.
  - `staging.py`: Deterministic `stable_id()` generation, normalized screen anchor mapping (`far_left`..`far_right`, `offscreen`), depth layers (`background`/`midground`/`foreground`) with depth scaling, aspect-ratio conversion, visible bounds clamping, automatic multi-character anti-overlap horizontal distribution, pose/expression preset matching, background/environment/prop/foreground z-index classification, and front-to-back layer preview ordering.
  - `service.py` & `/api/v1/scene-execution/*`: `validate`, `preview`, `execute` (transactional deep-copy snapshot with atomic rollback on failure, duplicate-safe `update_existing` / `reuse_existing` / `skip_existing` policies, partial execution, strict preservation of unrelated user scenes/characters/props/keyframes), inline `repair_missing_asset`, and isolated `update_shot`.
- **Isolated Per-Shot Evaluation, Rendering & Interactive Editing (`frontend/src/engine/sceneExecutionEngine.ts`, `evaluator.ts`, `PixiSceneGraph.ts`, `backend/core/render_engine/software_compositor.py`, `useProjectStore.ts`):**
  - `evaluateStageAtFrame()` and `software_compositor.py` resolve the active `SceneShot` at playhead timestamp and isolate execution-owned character/prop visibility, transforms, z-index, poses, expressions, animation state, background override, and camera framing while keeping non-owned user objects intact across all shots.
  - Interactive Canvas transforms (`updateCharacterInstance` / `updatePropInstance`) sync cleanly into only the active `SceneShot` when an executed shot is active, preventing shot-to-shot leakage.
- **Execution Preview Modal, Shot Switcher, Shot Inspector & Timeline Integration (`SceneExecutionPreviewModal.tsx`, `PreviewCanvas.tsx`, `ScenesPanel.tsx`, `RightInspector.tsx`, `MasterTimeline.tsx`):**
  - Preview-before-applying modal displaying validation KPIs, duplicate-safe policy selector, per-shot staged coordinates, front-to-back layer order, staging fallbacks, and inline real-Library Missing-Asset Repair dropdowns.
  - Stage Shot Switcher Bar above the PixiJS viewport, nested Executed Shots list in `ScenesPanel`, dedicated Shot Inspector in `RightInspector`, clickable Shot Boundary sub-segments on the `Scene / Background` track in `MasterTimeline`, full Undo/Redo, and 100% EN/VI localization parity.

## Phase 07 Batch 2 — AI Animation Execution, Character Motion, Camera Motion & Motion Library (`library.db` v5 / `project.db` v8)
- **Rig Capability Registry & Persistent Motion Library (`backend/schemas/animation_execution.py`, `backend/core/animation_execution_engine/capabilities.py`, `builtin_presets.py`, `backend/database/library_migrations.py`, `library_repo.py`):**
  - `inspect_character_capabilities()` inspects real `Character.parts`, `part_role`, `variants`, `poses`, and `expressions` to expose exact runtime capabilities (`root_movement`, `body_rotation`, `head_rotation`, `arm_rotation`, `leg_rotation`, `hand_rotation`, `eye_state`, `mouth_state`, `scale_animation`, `opacity_animation`) and rig classification (`full_cutout`, `upper_body`, `simple_cutout`, `empty`).
  - Migrated `library.db` safely (`v4 → v5`) with `motion_presets` table seeded idempotently with 11 built-in presets (`idle`, `walk`, `run`, `blink`, `wave`, `head_turn/look`, `talk`, `jump`, `fall`, `react`, `turn`), plus full CRUD (save custom, rename, duplicate, delete custom while protecting built-ins) and strict rig compatibility enforcement (incompatible motions are never applied silently).
- **Procedural Real-Keyframe & 2D Camera Motion Engine (`backend/core/animation_execution_engine/procedural.py`, `camera_motion.py`, `service.py`, `backend/api/animation_execution.py`):**
  - Generates real, editable `Keyframe`s (`anim_kf_<hash>`) and `CharacterAnimationClip`s using existing Timeline models, respecting actual cutout part pivots (`anchor_x`, `anchor_y`), parent-child hierarchy, easing curves (`linear`, `ease_in`, `ease_out`, `ease_in_out`, `hold`), validated parameters (`duration_ms`, `speed`, `intensity`, `distance_px`, `direction`, `start_pose_id`, `end_pose_id`, `easing`, `loop`, `delay_ms`), and anti-slide stride synchronization for walk/run cycles.
  - Executes 2D camera motions (`static`, `pan_*`, `tilt_*`, `zoom_*`, 2D-approximated `dolly_*`, procedural damped `shake`, and character-synchronized `tracking`/`camera_follow` tracking generated character root trajectories) while honestly rejecting `parallax` as unsupported (never silently replacing it).
  - Persists `SceneShot.applied_motions: list[GeneratedMotionRecord]` (`project.db` v7 → v8), preserves `user_modified` motions on re-execution unless selected for regeneration, and rolls back atomically on mid-execution failure.
- **Zero Shot-to-Shot Motion Leakage & Non-Destructive Live Stage Preview (`frontend/src/engine/evaluator.ts`, `backend/core/render_engine/software_compositor.py`, `animationExecutionEngine.ts`, `useAnimationExecStore.ts`, `PreviewCanvas.tsx`, `AnimationPanel.tsx`, `AnimationExecutionModal.tsx`):**
  - Both `evaluator.ts` and `software_compositor.py` exclude shot-owned keyframes (`animation_refs` + `applied_motions[].keyframe_ids`) belonging to other shots when evaluating an active `SceneShot`, guaranteeing zero leakage even across shared boundary timestamps.
  - `PreviewCanvas` evaluates ephemeral `previewOverlay` keyframes directly on the live PixiJS WebGL Stage using the actual character rig with Play/Pause/Stop/Reset/Apply/Cancel controls, never writing permanent keyframes to `project.db` until explicitly applied.

## Phase 08 Batch 3 — Export Configuration, Render Queue, Output Validation (`project.db` v10)
- **Export plan (`backend/schemas/export.py`, `backend/core/render_engine/export_planner.py`):** `ExportSettings` (scope, resolution preset/custom + aspect mode, fps, container, codec, encoder preference, quality preset, advanced overrides, audio, subtitles, output dir/filename, collision policy) is resolved into an `ExportPlan`: ordered source segments (project / scene(s) / shot(s) / range, always timeline-ordered), an output-frame → source-time map, a validated encoder argv (genuinely different per quality preset; codec/container/pix_fmt/profile/CRF conflicts rejected), a collision-safe Unicode output path and every error/warning. `POST /render/validate` returns the plan without rendering; legacy `preset_id` requests are converted for v0.1 clients.
- **Pipeline (`orchestrator.py`):** project snapshot at queue time → `preparing` → `rendering` (SoftwareCompositor `render_time_rgba` or PixiJS stream with `frame_times_ms`, streaming per-chunk encode, stderr drained) → `encoding` (master mix → frame-exact per-segment audio, optional EBU R128 normalization, peak + LUFS measurement; concat + mux into a hidden `.partial` file with real `-progress` data) → `validating` (`output_validator.py`: ffprobe codec/size/fps/packet-count/duration/audio/subtitle checks + full decode) → atomic `os.replace` to the final path → history metadata in `output_json` → temp cleanup (only inside `<project>/renders/`). Aspect-mismatched outputs are letterboxed/cropped instead of stretched.
- **Render queue (`workers/job_queue.py`):** single serial worker; states `queued → preparing → rendering → encoding → validating → completed | failed | cancelled`, plus `paused`; actions start/stop queue, pause, resume, cancel, skip, retry (reuses completed chunks), remove (never deletes outputs), reorder. Startup recovery marks interrupted active jobs `failed` (never auto-reruns) and keeps queued jobs waiting with the queue stopped. `jobs` gains `name`, `queue_position`, `progress_json`; job upserts no longer use `INSERT OR REPLACE` (which cascade-deleted chunk rows).
- **FFmpeg environment (`utils/ffmpeg.py`, `/render/environment*`):** cached capability probe (all encoders, hwaccels, versions), persisted custom FFmpeg/FFprobe paths (`app_settings.ffmpeg_config`), encoder smoke tests, argv-only process execution with guaranteed child reaping.
- **Frontend:** `ExportModal.tsx` (scope/video/audio/subtitles/output/review with debounced server validation), `RenderJobCard.tsx` + `RenderQueueList.tsx` (shared by sidebar & drawer), `FFmpegSettingsSection.tsx`, `engine/exportSettings.ts` (global defaults vs per-project folder/filename/scope persistence).

## Phase 09.1 — System Integration Audit: Source of Truth, State Sync & Preview/Render Parity (`project.db` v11)

**Source of truth (as implemented).**
| Entity | Authoritative store | Other copies (and their role) |
|---|---|---|
| Project content (meta, scenes/shots, timeline, script, subtitles) | `project.db` (`project_meta`, `project_state` sections) | Editor working copy in `useProjectStore` (unsaved edits); render job snapshot `renders/<job>/project_snapshot.json` (immutable, per job) |
| AI documents (director, storyboard, production_plan, production_queue, qc_report) | `project.db` sections, written by backend services | Editor copy (adopted from server; edits saved per section) |
| Characters, assets, sounds, presets, app settings | `library.db` (shared by all projects) + files in `asset_library/` | PixiJS texture cache / compositor image cache (read-only caches) |
| Voice audio, render jobs & export history | `project.db` (`voice_audio_assets`, `jobs`, `render_chunks`) | `useJobStore` (WS-updated view) |
| Export settings defaults | `localStorage` (global defaults + per-project folder/filename/scope) | — |

**Concurrent writers.** `project.db` is written by the editor autosave and by backend services (AI Director, Storyboard, Production Planner, Production Queue worker thread, QC, Scene/Animation execution). Phase 09.1 adds:
- `section_revisions` table (v10→v11, additive) — revision + content hash per section, bumped only when a section's content changes; returned as `ProjectState.revisions`.
- `ProjectRepository.save_client_state()` / `PUT /projects/{id}?dirty=a,b` — clients write **only the sections they changed**; a dirty section changed by another writer since the client's base revision is reported in `X-AMCS-Conflicts` and the overwritten version is kept in a `conflict` backup. Omitting `dirty` keeps the legacy full save.
- `ProjectRepository.patch_project_sections()` — services that await (LLM calls) re-read the latest state and replace only their own section; `holds_project_lock` serializes synchronous read-modify-write service methods (scene/animation execution, production queue sync, QC) with a per-project lock.
- `project_state_changed` WebSocket event after every save; the editor merges newer server sections (`frontend/src/engine/projectSync.ts`), keeping unsaved local edits, and its autosave sends only content-changed sections.
- Backup restore keeps render/export history and advances revisions.

**Preview vs final render.** `SoftwareCompositor.evaluate_stage()` now produces the same structure as `evaluator.ts` `evaluateStageAtFrame()` and drawing consumes only that structure. Divergences fixed: auto-blink seed hash, breathing head-bob, walk/run limb swing, REACTING/SURPRISED hop, shot `animation_state`, pose/expression part-opacity overrides, null shot expression/pose fallback, camera zoom clamp, per-shot prop asset overrides, owned-character visibility rule. `tests/integration/test_phase09_1_preview_render_parity.py` runs the real TypeScript evaluator (esbuild + Node) against the Python renderer on a fixture exercising all of these. The PixiJS stream renderer reuses `evaluator.ts` directly.

**Other integration repairs.** Scene delete / duration change move keyframes, clips, audio and subtitles with their scene (`frontend/src/engine/sceneTimeline.ts`) instead of leaving them at stale absolute times; deleting in-use library assets/characters returns 409 with usages (`core/asset_engine/references.py`) and the UI confirms; project save errors are surfaced (previously swallowed); QC reports `OUTDATED_SUBTITLE` when the script line a cue was generated from is edited or deleted.

**Known limitations (not implemented in the codebase):** Smart Blur, Animation Repair, Audio Intelligence, visual effects and color grading do not exist; cross-dissolve renders as fade-from-black; voice lines are not flagged as outdated after script edits (only subtitles); PixiJS decomposes part matrices (no skew) while the software renderer applies full affine transforms (differs only with non-uniform parent scale + rotation).

## Phase 09.2 — Performance & Memory (measured on a 40-scene / 6,960-keyframe / 2 MB stress project)

**Tooling.** `tests/performance/stress_project.py` (deterministic large project, temp workspace only), `bench_backend.py` (API/QC/render timings + exports data for the frontend), `frontend/bench_engine.ts` + `frontend/soak_store.ts` (real app code bundled with esbuild, run in Node), `frontend/src/perf/*.bench.test.tsx` (React render cost in jsdom; run with `AMCS_STRESS_DIR=…`). Always-on regression guards: `tests/performance/test_perf_regressions.py`, `frontend/src/perf/engine.perf.test.tsx`, `src/engine/structuralShare.test.ts`, `src/renderer/textureCache.test.ts`, `src/components/timeline/playhead.test.tsx`.

| Change | Before → After (measured) |
|---|---|
| `App`/`MasterTimeline` no longer subscribe to `currentFrame`; only `PlayheadNeedle`/`PlayheadTimecode` do | timeline re-render per playback frame 22.6 ms → 0.2 ms |
| Keyframe index (per immutable keyframes array) + cached "owned by other shots" set, in `evaluator.ts` and `SoftwareCompositor` | preview evaluation 14.8 ms → 0.04 ms/frame; render evaluation 21 ms → 0.15 ms/frame |
| Undo history keeps immutable states by reference; `shareUnchanged()` gives structural sharing between edits | retained heap for 80 edits 236 MB → 7 MB; soak plateau 237 MB → 11 MB; median edit 22.4 → 19.3 ms |
| Bounded frame-render thread pool (`cpu−2`, max 4, `AMCS_RENDER_THREADS`), in-order writes, ≤2×workers frames in flight | 10 s 1080p export 66.8 s → 20.5 s; decoded frames bit-identical (framemd5) |
| Per-run memoized QC library lookups (was one SQLite connection per reference) | QC preflight 277 → 141 ms; production QC 406 → 249 ms |
| Section hashes reuse the column JSON (no second full serialization); script `updated_at` no longer bumps its revision | section save ~98 → ~84 ms |
| Bounded LRU GPU texture cache (384 MB estimated budget, textures used by the current frame never evicted) | unbounded → bounded (GPU memory itself not measurable here) |
| `RightInspector` follows the playhead via `useDeferredValue` | ~9.4 ms render now interruptible (total work unchanged) |

Soak results: backend 150 load/save/QC cycles + 3 renders — constant open fds (8), threads (4), no child processes, Python heap flat after warm-up; frontend 400 edits — retained heap flat at the undo cap.
