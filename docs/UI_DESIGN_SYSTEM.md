# AutoMotion Comic Studio — UI/UX Design System (Phase 02)

## 1. Visual Identity & Color Architecture
All colors, spacing, radii, typography, and elevations are defined centrally in [tokens.css](file:///Users/nguyentuan/Documents/Antigravity/AutoMotion%20Comic%20Studio/frontend/src/styles/tokens.css) using CSS custom properties with `[data-theme="dark-studio"]` (default) and `[data-theme="slate-contrast"]` (high-contrast obsidian) themes:

- **Canvas Backdrop:** `#0b0c0f` (visually isolates the 16:9 PixiJS WebGL stage)
- **Layered Charcoal Panels:** `#101216` base → `#16181e` panels → `#1a1d24` headers → `#232732` controls
- **Subtle Hairline Borders:** `#252934` / `#2e3342` / `#3f4659`
- **Restrained Studio Accent:** Blue-Violet `#7c6cf6` (active selections, playhead, primary CTA, focus ring)
- **Non-Color-Only Semantic Statuses:** Every `ok` / `warn` / `err` indicator pairs a crisp Lucide icon + text label + subtle tint (`StatusBadge`, `save-status-pill`).

## 2. Persistent 5-Zone Studio Layout & Modular Workspaces
A single Zustand state store (`useProjectStore`) backs all 5 workspace presets managed by [useWorkspaceStore.ts](file:///Users/nguyentuan/Documents/Antigravity/AutoMotion%20Comic%20Studio/frontend/src/stores/useWorkspaceStore.ts):
1. **Animation Workspace:** Characters/Animation left, dominant Stage Preview center, Transform & Motion Inspector right, expanded Master Timeline bottom.
2. **Scene Workspace:** Scenes & Layers left, Stage Preview with Action/Title Safe-Area Guides center, Scene/Camera Inspector right.
3. **Audio Workspace:** 16-Category Sound Effects Library left, expanded SFX Timeline & Waveform view bottom, Audio Clip Inspector right.
4. **Assets Workspace:** Expanded wide-grid PNG Asset Library left, Asset Metadata Inspector right, collapsed Timeline.
5. **Script Workspace (`v0.2`):** Honest roadmap panel explaining Module 01 (OpenAI Structured Outputs) & Module 03 (F5-TTS) prerequisites — no mock editor.

## 3. Reusable UI Component Library (`frontend/src/components/ui/`)
- [BrandLogo.tsx](file:///Users/nguyentuan/Documents/Antigravity/AutoMotion%20Comic%20Studio/frontend/src/components/ui/BrandLogo.tsx): Minimal geometric frame + kinetic curve vector emblem.
- [CollapsibleSection.tsx](file:///Users/nguyentuan/Documents/Antigravity/AutoMotion%20Comic%20Studio/frontend/src/components/ui/CollapsibleSection.tsx): Accordion property groups with icons, counts, and inline action buttons.
- [NumericScrubber.tsx](file:///Users/nguyentuan/Documents/Antigravity/AutoMotion%20Comic%20Studio/frontend/src/components/ui/NumericScrubber.tsx): Horizontal drag-to-scrub numeric controls (`Shift` = 5x, `Alt` = fine) with direct keyboard editing and unit suffixes.
- [ToggleSwitch.tsx](file:///Users/nguyentuan/Documents/Antigravity/AutoMotion%20Comic%20Studio/frontend/src/components/ui/ToggleSwitch.tsx): Accessible `role="switch"` studio toggles.
- [SearchInput.tsx](file:///Users/nguyentuan/Documents/Antigravity/AutoMotion%20Comic%20Studio/frontend/src/components/ui/SearchInput.tsx): Unified filter input with clear button.
- [ContextMenu.tsx](file:///Users/nguyentuan/Documents/Antigravity/AutoMotion%20Comic%20Studio/frontend/src/components/ui/ContextMenu.tsx): Viewport-clamped right-click menus with icons, shortcut hints, and Escape/click-away close.
- [StatusBadge.tsx](file:///Users/nguyentuan/Documents/Antigravity/AutoMotion%20Comic%20Studio/frontend/src/components/ui/StatusBadge.tsx): Accessible icon + label status pills.

## 4. Contextual Inspector Modes
[RightInspector.tsx](file:///Users/nguyentuan/Documents/Antigravity/AutoMotion%20Comic%20Studio/frontend/src/components/inspector/RightInspector.tsx) adapts dynamically to the selected entity:
- **Scene:** Name, Duration, Resolution, Transition In/Duration, Background PNG/Color, Default Camera.
- **Character:** Active Rig Body-Part Target selector (Root or individual limb/head), Transform (`X/Y/Rot/Scale/Opacity/Z` + Keyframe Diamonds), 9 Editable Animation Presets, Expression/Eyes/Mouth + Keyframes, Animation State & Procedural Auto-Blink/Breathing/Walk, Keyframe Copy/Paste & Easing editor (`Hold/Linear/Ease In/Ease Out/Ease In Out`).
- **Asset:** Thumbnail preview, Name, Type, Role, Dimensions, Folder, editable Tags, Identity Verification toggle, SHA-256 checksum & quick stage actions.
- **Camera:** Pan X/Y, Zoom, Roll + Keyframe Diamonds, framing & editable zoom presets, keyframe list.
- **Prop / Stage Object:** Transform + Keyframe Diamonds, Pivot X/Y (`anchor_x`/`anchor_y`), Z-Index, Parent Object hierarchy selector (cycle-safe), Visibility & Lock toggles, Editable Animation Presets, Keyframe Copy/Paste & Easing editor.
- **Audio / SFX Clip:** Waveform, Start/End/Trim Offset, Volume, Speed, Fade In/Out, Stereo Pan, Loop, License metadata.

## 5. Bilingual Localization, Transform Tools & Responsive Breakpoints
- **Bilingual (`vi` default / `en`):** 510 symmetric keys in `locales/vi.json` and `locales/en.json` with immediate non-reloading language switching and `localStorage` persistence.
- **Floating Stage Transform Tool Rail:** `Select (V)`, `Move (W)`, `Rotate (R)`, `Scale (S)`, `Pivot (P)` overlaid cleanly on the left edge of the PixiJS viewport without colliding with top resolution/zoom HUD chips.
- Tested across **Large (`1480×920`)**, **Medium (`1200×760`)**, and **Small (`1024×660`)** Electron window dimensions in both Vietnamese and English; collapsible Left Rail, Left Sidebar (`[`), Right Inspector (`]`), and Bottom Timeline (`Cmd/Ctrl+\`) guarantee canvas dominance at every size.
- Full NLE shortcut sheet available inside the app via `?` ([ShortcutsModal.tsx](file:///Users/nguyentuan/Documents/Antigravity/AutoMotion%20Comic%20Studio/frontend/src/components/modals/ShortcutsModal.tsx)); editing shortcuts automatically pause while typing in any input field.


## Phase 04 — Pro Inspector Property Controls & Script/Voice Workspace UI

- **Reusable Property Controls (`frontend/src/components/ui/PropertyControls.tsx`)**:
  - `NumericInput`: text-mode decimal input without native browser spinners; supports exact entry, `Enter` commit, `Escape` revert, `ArrowUp`/`ArrowDown` stepping (`Shift = 10x`, `Alt = 0.1x`), horizontal label scrubbing, and NaN/Infinity/invalid text rejection.
  - `PropertySlider` & `SliderWithInput`: combined precision range slider + editable numeric box (used for Opacity `0–100%`, Scale, Camera Zoom, Audio Volume `0–200%`, Stereo Pan, and provider-supported Voice settings).
  - `Vector2Control`: paired X/Y controls with optional Aspect Ratio Lock (`Link2`/`Unlink2`) for Scale and per-property Reset buttons.
  - `KeyframeDiamondButton`: truthful 3-state indicator (filled amber = keyframe at current frame; outlined amber = animated on other frames; muted = unkeyed).
- **Integrated 3-Pane Script & Voice Workspace**:
  - Left: `ScriptScenesPanel` (episode title, drag/reorderable script scenes, duration summary, Stage sync).
  - Center: `ScriptEditorWorkspace` (scene metadata, drag/reorderable Dialogue/Narration/Action entries, live voice generation status, real HTML5 audio preview player with interactive waveform seek, honest provider badges, Add to Timeline).
  - Right: `VoicePanel` (character voice assignment, dynamic provider-supported settings only, voice preview, honest provider status list).
- **Complete Bilingual Coverage (`vi` default / `en`)**: 640 symmetric translation keys across `vi.json` and `en.json` with verified parity tests and zero translation of user-created content.
