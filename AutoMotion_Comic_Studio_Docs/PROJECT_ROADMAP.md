# PROJECT ROADMAP
## AutoMotion Comic Studio

Status labels: `NOT STARTED`, `IN PROGRESS`, `BLOCKED`, `TESTING`, `DONE`.
Do not mark an item DONE without evidence from a test or working demonstration.

## Phase 0 — Project foundation
- [ ] Repository and Git baseline
- [ ] Documentation imported
- [ ] Environment audit (Node, package manager, Python, FFmpeg)
- [ ] Architecture and folder layout reviewed
- [ ] Build and run instructions documented
- [ ] CI or repeatable local checks established

## Version 0.1 — Core Animation Engine
### Project
- [ ] Create project
- [ ] Save/open project
- [ ] Versioned project metadata
- [ ] Autosave/backup strategy
### Asset
- [ ] Import PNG
- [ ] Transparent image support
- [ ] Asset browser
- [ ] Metadata and tags
### Character
- [ ] Layered character assembly
- [ ] Parts positioning
- [ ] Identity-safe replacement
- [ ] Expression/eye/mouth switching
### Canvas and scene
- [ ] Scene graph
- [ ] Select/move/rotate/scale
- [ ] Z-order
- [ ] Camera pan/zoom
### Animation
- [ ] Keyframe model
- [ ] Basic tweening
- [ ] Idle animation
- [ ] Basic motion states
- [ ] Preview playback
### Timeline
- [ ] Master timeline
- [ ] FPS/frame mapping
- [ ] Basic clips/events
- [ ] Move/trim
- [ ] Playhead and playback
### Sound Effects
- [ ] Import sound files
- [ ] Preview
- [ ] Search/category
- [ ] Place SFX on timeline
- [ ] Volume and fade basics
### Export
- [ ] Render short test scene
- [ ] MP4 export
- [ ] Verify video/audio output
### Acceptance
- [ ] End-to-end PNG → character → animation → SFX → preview → MP4 workflow works
- [ ] Project closes and reopens without losing edits

## Version 0.2 — Script & Voice
- [ ] Script editor/import
- [ ] Structured dialogue
- [ ] Character mapping
- [ ] Voice profiles
- [ ] TTS provider adapter
- [ ] Per-line generation
- [ ] Audio storage and reuse
- [ ] Dialogue timing and audio track

## Version 0.3 — AI Director
- [ ] Script analysis
- [ ] Scene segmentation
- [ ] Character/action/emotion extraction
- [ ] Storyboard generation
- [ ] Shot and camera suggestions
- [ ] Animation suggestions
- [ ] SFX suggestions
- [ ] Review/approval workflow
- [ ] Editable structured output

## Version 0.4 — Automatic Production
- [ ] Scene generation pipeline
- [ ] Character placement automation
- [ ] Animation orchestration
- [ ] Hybrid lip-sync
- [ ] Automatic SFX assignment
- [ ] Ambient/BGM support
- [ ] Job queue
- [ ] Retry/cancel/resume
- [ ] Chunk rendering
- [ ] QC report

## Version 1.0 — Production Studio
- [ ] Multi-episode projects
- [ ] Asset reuse across episodes
- [ ] Long-video rendering
- [ ] Batch processing
- [ ] Recoverable jobs
- [ ] Export presets
- [ ] Performance profiling and optimization
- [ ] macOS packaging
- [ ] Windows packaging
- [ ] Installer and setup guide
- [ ] Release smoke tests

## Milestone record
For every milestone, record:
- Date/version
- Scope
- Changes
- Test evidence
- Known issues
- Git commit/tag
- Next milestone

## Current planning note
The roadmap is a planning baseline. The actual implementation status must be checked against the repository and tests at the start of each AI session.
