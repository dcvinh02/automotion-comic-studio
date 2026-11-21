# MASTER TECHNICAL SPECIFICATION
## AutoMotion Comic Studio

**Document status:** Planning baseline  
**Version:** 2.0  
**Product type:** Desktop application for 2D cutout animation / motion comic production

## 1. Product vision
Build a desktop studio that assists creators in turning scripts into editable, animated motion-comic videos. The product should combine asset reuse, character assembly, scene composition, timeline editing, voice/audio workflows, AI-assisted direction, rendering, and quality control.

Target workflow:
Script → Analysis → Characters/Assets → Storyboard/Scenes → Voice → Animation/Lip-sync → SFX/Ambience/BGM → Timeline → Preview → QC → Export.

Long-term target: support multi-episode projects and videos approximately 15–30 minutes long, while retaining manual control and editability.

## 2. Product principles
- Automation assists; users remain in control.
- Character identity and asset selection must not be silently altered.
- Every timeline event must be editable.
- Project data must be recoverable.
- Rendering must support progress, cancellation, retry, and resumability where practical.
- UI controls must represent real capabilities, not decorative mock functionality.
- Cross-platform support is a design goal; verify OS-specific behavior rather than assuming parity.

## 3. Proposed technology stack
### Desktop / frontend
- Electron
- React
- TypeScript
- PixiJS / WebGL for scene rendering
- Zustand or a comparable state-management library

### Backend
- Python 3.11+
- FastAPI
- Pydantic
- SQLite
- WebSocket for progress/events
- Background worker processes for expensive jobs

### AI and search
- OpenAI API using structured output / JSON Schema where suitable
- F5-TTS through a provider abstraction
- multilingual-e5-small for semantic asset retrieval, with SQLite and/or FAISS as appropriate

### Media
- FFmpeg for media processing and final encoding
- Audio analysis: RMS, silence/VAD, pitch where useful, phoneme/viseme alignment
- PixiJS rendering for compositing and animation preview

Dependency versions must be selected, pinned, and verified during setup. Do not assume any package, model, or binary is already installed.

## 4. Architecture
Separate responsibilities into:
- Desktop shell and application lifecycle
- Frontend presentation and interaction
- Domain/state layer
- Backend API and job orchestration
- AI provider adapters
- Asset and project persistence
- Animation/scene runtime
- Audio/media pipeline
- Rendering/export
- QC and test infrastructure

Avoid direct coupling between UI components and filesystem, media encoders, AI providers, or database internals. Use typed interfaces and services.

## 5. Core modules
### 5.1 Script Intelligence
- Script import/edit
- Character and dialogue extraction
- Emotion/action/context tagging
- Scene segmentation
- Structured storyboard data
- Human review/editing before production

### 5.2 Asset & Character Management
- Import images and media
- Asset metadata, categories, tags, previews, favorites
- Character identity, variants, expressions, poses
- Layered character parts (head, body, eyes, mouth, hair, limbs, accessories)
- Asset replacement and duplicate detection
- Semantic search may suggest assets but must not make identity decisions without safeguards

### 5.3 Voice Production
- Voice profiles and character assignment
- Dialogue audio generation
- Per-line regeneration
- Audio storage and reuse
- Provider abstraction and clear failure states

### 5.4 Audio Intelligence
- Duration and waveform information
- RMS and silence/VAD analysis
- Pitch analysis where relevant
- Phoneme/viseme alignment when available
- Timing metadata for dialogue, lip-sync, and automation
- Audio analysis must not rely on RMS alone for mouth movement

### 5.5 AI Director
- Scene and shot suggestions
- Character positioning suggestions
- Action, expression, camera and transition suggestions
- Sound-effect suggestions
- Generate structured editable data
- User approval or editing before committing generated changes

### 5.6 Animation & Lip-sync
- Animation state machine
- Transform and keyframe animation
- Tweening
- Idle, walk, run, speak, listen, react, emotional states
- Head, eye, mouth, and body motion
- Hybrid lip-sync based on phoneme/viseme data, audio energy, and silence
- Begin with a practical 6–8 mouth-shape set; expand only if tests justify it

Suggested states: IDLE, WALKING, RUNNING, SPEAKING, LISTENING, REACTING, SURPRISED, ANGRY, SAD, HAPPY, CRYING, TRANSITION.

### 5.7 Compositing & Render
- Scene graph and layers
- Character assembly
- Camera pan/zoom
- Timeline-driven playback
- Preview and export render paths
- Chunk rendering with global timeline coordinates
- FFmpeg encoding and audio muxing
- Render jobs must initialize scene state correctly at chunk boundaries

### 5.8 Quality Control & Export
- Missing assets
- Invalid or missing audio
- Timeline inconsistencies
- Lip-sync alignment checks
- Frame and render failures
- Audio clipping/peaks
- Export settings and presets
- Actionable reports

### 5.9 Sound Effects Library
A first-class audio asset library:
- Categories: footsteps, movement, impact, objects, doors, environment, atmosphere, emotional, comedy, cinematic, notification, magic, vehicles, crowd, animals, water
- Import: WAV, MP3, FLAC, OGG (verify actual support through media tools)
- Preview, search, tags, category, waveform, favorites, rename, replace, delete
- Manual placement and AI-assisted assignment
- Source/license metadata must be retained; do not use unclear-license audio as bundled content

Suggested audio tracks: Voice, SFX, Ambient, BGM. Mixing supports fades, volume automation, ducking, and peak/clipping checks. Do not hardcode mix levels without user controls or documented defaults.

## 6. Timeline principles
- One master timeline shared by video, animation, voice, SFX, ambience, and music.
- UI may display milliseconds/seconds; rendering uses frame indices derived from project FPS.
- Avoid independent timing systems that drift.
- Every event should have stable IDs.
- Support trim, move, split where appropriate, mute/solo, volume, fade, and deletion.
- Timeline changes must be undoable where feasible.

## 7. Project persistence
- Project metadata and structured data stored in a versioned format.
- SQLite may store relational/indexed data; media files should be stored in project-managed directories.
- Project references should be relative where possible.
- Save, backup, recovery, and migration rules must be explicit.
- Never silently discard unknown fields during migrations.
- Use atomic writes for critical project metadata when feasible.

## 8. Job orchestration
Job states: pending, running, completed, failed, cancelled, paused (where supported).
Jobs should provide:
- progress and status
- structured logs
- cancellation
- retry policy
- resumability where feasible
- clear error details
- resource cleanup

## 9. Version 0.1 scope
Build a non-AI core workflow:
1. Create/open project
2. Import PNG assets, including transparent images
3. Organize assets and assemble a layered character
4. Display and transform character on canvas
5. Switch basic expressions/parts
6. Create simple animations using keyframes/tweens
7. Camera pan/zoom
8. Basic timeline and preview playback
9. Import, preview, and place sound effects on timeline
10. Export a short MP4 using real rendered frames and audio

AI script analysis, automatic production, and advanced lip-sync are not required in 0.1.

## 10. Performance and reliability
- Keep expensive tasks off the UI thread.
- Use workers/background jobs.
- Release textures, audio, and render resources appropriately.
- Profile before optimizing.
- Avoid rendering an entire long video as one uninterruptible operation.
- Report real progress.
- Test project reopen and interrupted-job recovery.

## 11. Cross-platform
Target macOS and Windows. Verify file paths, permissions, binaries, packaging, audio devices, and rendering separately on each OS. Do not claim cross-platform readiness based only on one operating system.

## 12. Definition of done
A feature is complete only when:
- Implementation exists and is connected to the real workflow
- Error and empty states are handled
- Persistence works where expected
- Relevant tests pass
- Regression checks are performed
- Documentation reflects actual behavior
- The AI report distinguishes tested facts from assumptions
