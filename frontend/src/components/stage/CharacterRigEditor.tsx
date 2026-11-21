import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Application, Graphics } from 'pixi.js';
import {
  AlignCenterHorizontal,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Crosshair,
  Eye,
  EyeOff,
  FolderPlus,
  FolderUp,
  Grid,
  HelpCircle,
  Lock,
  Maximize2,
  Move,
  Play,
  Plus,
  RotateCcw,
  RotateCw,
  Save,
  Smile,
  Square,
  Trash2,
  Unlock,
  Upload,
  UserPlus,
} from 'lucide-react';
import { evaluateStageAtFrame } from '@/engine/evaluator';
import {
  ALL_PART_ROLES,
  analyzeCharacterRig,
  applyLinearInverse,
  applyRigPreviewPoseToCharacter,
  buildHierarchyTree,
  canReparentPart,
  canvasPointToPartAnchor,
  computePartCanvasQuad,
  computePartWorldMatrices,
  evaluateRigPreviewPose,
  getDefaultPivotForRole,
  getDescendantSlotIds,
  getSuggestedLocalOffsetForRole,
  getSuggestedParentSlotId,
  getSuggestedZIndexForRole,
  groupPartsUnderNewGroup,
  guessPartRoleFromFilename,
  hitTestCharacterParts,
  movePartPivotPreservingVisualPosition,
  reparentPartPreservingWorldTransform,
  RIG_PREVIEW_ACTIONS,
  ungroupPart,
  type RigPreviewActionId,
} from '@/engine/characterRigEngine';
import { useI18n } from '@/i18n/useLocaleStore';
import { PixiSceneGraph } from '@/renderer/PixiSceneGraph';
import { AssetTextureCache } from '@/renderer/textureCache';
import { apiClient } from '@/services/apiClient';
import { useJobStore } from '@/stores/useJobStore';
import { useLibraryStore } from '@/stores/useLibraryStore';
import { useProjectStore } from '@/stores/useProjectStore';
import type {
  Asset,
  Character,
  CharacterPartSlot,
  ExpressionPreset,
  PartRole,
  ProjectState,
} from '@/types/models';
import { createStarterCharacterPayload } from '@/components/sidebar/CharactersPanel';
import { CollapsibleSection } from '@/components/ui/CollapsibleSection';
import {
  NumericInput,
  PropertySlider,
  SliderWithInput,
  Vector2Control,
} from '@/components/ui/PropertyControls';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { EmptyState } from '@/components/common/CommonUI';

const STANDARD_EYE_VARIANTS = ['open', 'half', 'closed', 'happy', 'angry', 'surprised'];
const STANDARD_MOUTH_VARIANTS = ['closed', 'a', 'e', 'i', 'o', 'u', 'smile', 'frown'];

const CANVAS_SIZE = 620;
const RIG_ROOT_X = 310;
const RIG_ROOT_Y = 390;

type BuilderTool = 'select' | 'rotate' | 'scale' | 'pivot';

function round2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}

export function CharacterRigEditor({
  characterId,
  onSelectCharacter,
  onClose,
}: {
  characterId: string | null;
  onSelectCharacter?: (characterId: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const characters = useLibraryStore((s) => s.characters);
  const assets = useLibraryStore((s) => s.assets);
  const upsertAsset = useLibraryStore((s) => s.upsertAsset);
  const upsertCharacter = useLibraryStore((s) => s.upsertCharacter);
  const pushToast = useJobStore((s) => s.pushToast);

  const project = useProjectStore((s) => s.project);
  const activeSceneId = useProjectStore((s) => s.activeSceneId);
  const addCharacterToScene = useProjectStore((s) => s.addCharacterToScene);

  const sourceChar =
    characters.find((c) => c.character_id === characterId) ??
    (characterId ? null : (characters[0] ?? null));

  const [draft, setDraft] = useState<Character | null>(null);
  const [dirty, setDirty] = useState(false);
  const [selectedSlotId, setSelectedSlotId] = useState<string | null>(null);
  const [tool, setTool] = useState<BuilderTool>('select');
  const [showPivots, setShowPivots] = useState(true);
  const [snapGrid, setSnapGrid] = useState(false);
  const [keepVisualOnPivot, setKeepVisualOnPivot] = useState(true);
  const [scaleAspectLocked, setScaleAspectLocked] = useState(true);

  // Hierarchy UI state
  const [collapsedSlots, setCollapsedSlots] = useState<Set<string>>(new Set());
  const [dragPartId, setDragPartId] = useState<string | null>(null);
  const [dropParentId, setDropParentId] = useState<string | 'ROOT' | null>(null);
  const [renamingSlotId, setRenamingSlotId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  // Import & Asset Reuse UI state
  const [uploading, setUploading] = useState(false);
  const [fileDropActive, setFileDropActive] = useState(false);
  const [creatingChar, setCreatingChar] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Live Rig Preview state
  const [previewAction, setPreviewAction] = useState<RigPreviewActionId>('idle');
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [previewElapsedMs, setPreviewElapsedMs] = useState(0);
  const [previewExprId, setPreviewExprId] = useState<string>('');
  const [previewEye, setPreviewEye] = useState<string>('open');
  const [previewMouth, setPreviewMouth] = useState<string>('closed');
  const [newVariantKey, setNewVariantKey] = useState('');
  const [newExprName, setNewExprName] = useState('');
  const [saving, setSaving] = useState(false);
  const [redrawTick, setRedrawTick] = useState(0);

  const previewHostRef = useRef<HTMLDivElement | null>(null);
  const appRef = useRef<Application | null>(null);
  const canvasElRef = useRef<HTMLCanvasElement | null>(null);
  const sceneGraphRef = useRef<PixiSceneGraph | null>(null);
  const overlayRef = useRef<Graphics | null>(null);
  const texCacheRef = useRef<AssetTextureCache | null>(null);
  const activeDragCleanupRef = useRef<(() => void) | null>(null);

  const activeScene =
    project?.scenes.find((s) => s.scene_id === activeSceneId) ?? project?.scenes[0] ?? null;

  const assetsById = useMemo(() => {
    const map: Record<string, Asset> = {};
    for (const a of assets) map[a.asset_id] = a;
    return map;
  }, [assets]);

  const assetDimsById = useMemo(() => {
    const map = new Map<string, { width: number; height: number }>();
    for (const a of assets) map.set(a.asset_id, { width: a.width, height: a.height });
    return map;
  }, [assets]);

  const partAssets = useMemo(
    () => assets.filter((a) => a.type === 'character_part' || a.type === 'prop'),
    [assets],
  );

  // Hydrate draft when switching target character
  useEffect(() => {
    activeDragCleanupRef.current?.();
    setPreviewPlaying(false);
    setPreviewElapsedMs(0);
    if (sourceChar) {
      setDraft(structuredClone(sourceChar));
      setDirty(false);
      setSelectedSlotId(sourceChar.parts[0]?.slot_id ?? null);
      setPreviewExprId(sourceChar.expressions[0]?.expression_id ?? '');
    } else {
      setDraft(null);
      setDirty(false);
    }
  }, [sourceChar?.character_id]);

  // Clean up active pointer listeners on unmount
  useEffect(() => {
    return () => {
      activeDragCleanupRef.current?.();
      activeDragCleanupRef.current = null;
    };
  }, []);

  // Single clean requestAnimationFrame loop for Live Rig Preview
  useEffect(() => {
    if (!previewPlaying || !draft) return;
    const startPerf = performance.now() - previewElapsedMs;
    let rafId = 0;
    const tick = (now: number) => {
      setPreviewElapsedMs(now - startPerf);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [previewPlaying, previewAction, draft?.character_id]);

  // Mount dedicated PixiJS Assembly Canvas once per character
  useEffect(() => {
    const host = previewHostRef.current;
    if (!host || !draft) return;

    let alive = true;
    const texCache = new AssetTextureCache();
    texCacheRef.current = texCache;
    const app = new Application();
    appRef.current = app;

    void app
      .init({
        width: CANVAS_SIZE,
        height: CANVAS_SIZE,
        backgroundColor: 0x15171e,
        antialias: true,
        resolution: 1,
        preference: 'webgl',
      })
      .then(() => {
        if (!alive) {
          app.destroy(true, { children: true });
          return;
        }
        const sg = new PixiSceneGraph(texCache, CANVAS_SIZE, CANVAS_SIZE, () => {
          if (alive) setRedrawTick((tick) => tick + 1);
        });
        const overlay = new Graphics();
        sceneGraphRef.current = sg;
        overlayRef.current = overlay;
        app.stage.addChild(sg.root);
        app.stage.addChild(overlay);
        app.canvas.style.width = '100%';
        app.canvas.style.height = '100%';
        app.canvas.style.objectFit = 'contain';
        app.canvas.style.touchAction = 'none';
        canvasElRef.current = app.canvas;
        host.innerHTML = '';
        host.appendChild(app.canvas);
        setRedrawTick((tick) => tick + 1);
      });

    return () => {
      alive = false;
      texCache.destroyAll();
      if (appRef.current) {
        try {
          appRef.current.destroy(true, { children: true });
        } catch {
          // Ignore cleanup failure
        }
      }
      appRef.current = null;
      canvasElRef.current = null;
      sceneGraphRef.current = null;
      overlayRef.current = null;
    };
  }, [draft?.character_id]);

  const rigAnalysis = useMemo(
    () => (draft ? analyzeCharacterRig(draft, assetsById) : null),
    [draft, assetsById],
  );

  // Evaluate live preview pose (only while previewPlaying is active)
  const previewPose = useMemo(() => {
    if (!draft || !previewPlaying) return null;
    if (rigAnalysis && !rigAnalysis.actions[previewAction].supported) return null;
    return evaluateRigPreviewPose(draft.parts, previewAction, previewElapsedMs);
  }, [draft, previewPlaying, previewAction, previewElapsedMs, rigAnalysis]);

  const displayChar = useMemo(() => {
    if (!draft) return null;
    return applyRigPreviewPoseToCharacter(draft, previewPose);
  }, [draft, previewPose]);

  // Render live character + interactive hierarchy/pivot/transform gizmos
  useEffect(() => {
    if (!displayChar || !draft || !appRef.current || !sceneGraphRef.current) return;

    const rootY = RIG_ROOT_Y + (previewPose?.rootOffsetY ?? 0);
    const rootSx = previewPose?.rootScaleX ?? 1;
    const rootSy = previewPose?.rootScaleY ?? 1;
    const activeEye = previewPose?.eyeStateOverride ?? previewEye;

    const syntheticProject: ProjectState = {
      meta: {
        project_id: 'rig_builder_preview',
        name: 'Character Builder',
        description: '',
        schema_version: '0.1.0',
        width: CANVAS_SIZE,
        height: CANVAS_SIZE,
        fps: 30,
        duration_ms: 1000,
        default_export_preset_id: 'preset_1080p_final',
        auto_save_enabled: false,
        created_at: '',
        updated_at: '',
      },
      scenes: [
        {
          scene_id: 'rig_scene',
          project_id: 'rig_builder_preview',
          order_index: 0,
          name: 'Rig',
          start_ms: 0,
          duration_ms: 1000,
          background_asset_id: null,
          background_color: '#15171e',
          transition_in: 'cut',
          transition_duration_ms: 0,
          camera_default: { x: 0, y: 0, zoom: 1, rotation_deg: 0 },
          characters: [
            {
              instance_id: 'rig_inst',
              scene_id: 'rig_scene',
              character_id: displayChar.character_id,
              display_name: displayChar.name,
              z_index: 1,
              initial_transform: {
                x: RIG_ROOT_X,
                y: rootY,
                rotation_deg: 0,
                scale_x: rootSx,
                scale_y: rootSy,
                opacity: 1,
              },
              default_expression_id: previewExprId || null,
              default_pose_id: null,
              default_eye_state: activeEye,
              default_mouth_state: previewMouth,
            },
          ],
          props: [],
        },
      ],
      timeline: {
        project_id: 'rig_builder_preview',
        fps: 30,
        total_duration_ms: 1000,
        tracks: [],
        keyframes: [],
        animation_clips: [],
        sound_events: [],
      },
    };

    const evaluated = evaluateStageAtFrame(
      syntheticProject,
      { [displayChar.character_id]: displayChar },
      0,
      30,
    );
    sceneGraphRef.current.renderEvaluatedStage(evaluated, (aid) => apiClient.getAssetFileUrl(aid));

    // Render crisp vector gizmos on top
    const overlay = overlayRef.current;
    if (overlay) {
      overlay.clear();

      // Optional alignment grid
      if (snapGrid) {
        const step = 32;
        for (let gx = step; gx < CANVAS_SIZE; gx += step) {
          overlay.moveTo(gx, 0).lineTo(gx, CANVAS_SIZE);
        }
        for (let gy = step; gy < CANVAS_SIZE; gy += step) {
          overlay.moveTo(0, gy).lineTo(CANVAS_SIZE, gy);
        }
        overlay.stroke({ color: 0xffffff, width: 1, alpha: 0.045 });
      }

      // Subtle vertical center axis + character ground/root crosshair
      overlay
        .moveTo(RIG_ROOT_X, 24)
        .lineTo(RIG_ROOT_X, CANVAS_SIZE - 24)
        .stroke({ color: 0x64748b, width: 1, alpha: 0.16 });
      overlay
        .moveTo(RIG_ROOT_X - 12, RIG_ROOT_Y)
        .lineTo(RIG_ROOT_X + 12, RIG_ROOT_Y)
        .moveTo(RIG_ROOT_X, RIG_ROOT_Y - 12)
        .lineTo(RIG_ROOT_X, RIG_ROOT_Y + 12)
        .stroke({ color: 0x64748b, width: 1.2, alpha: 0.65 });

      const worldMats = computePartWorldMatrices(displayChar.parts, RIG_ROOT_X, rootY);

      if (!previewPlaying && selectedSlotId) {
        const selected = displayChar.parts.find((p) => p.slot_id === selectedSlotId);
        if (selected) {
          const selMat = worldMats.get(selected.slot_id);
          const selDims = selected.default_asset_id
            ? assetDimsById.get(selected.default_asset_id)
            : undefined;

          // 1. Parent outline (cyan) + Parent→Selected joint bone line
          if (selected.parent_slot_id) {
            const parent = displayChar.parts.find((p) => p.slot_id === selected.parent_slot_id);
            const parentMat = parent ? worldMats.get(parent.slot_id) : undefined;
            if (parent && parentMat && selMat) {
              const pDims = parent.default_asset_id
                ? assetDimsById.get(parent.default_asset_id)
                : undefined;
              const pQuad = computePartCanvasQuad(parent, parentMat, pDims?.width ?? 60, pDims?.height ?? 60);
              overlay
                .moveTo(pQuad.corners[0].x, pQuad.corners[0].y)
                .lineTo(pQuad.corners[1].x, pQuad.corners[1].y)
                .lineTo(pQuad.corners[2].x, pQuad.corners[2].y)
                .lineTo(pQuad.corners[3].x, pQuad.corners[3].y)
                .closePath()
                .stroke({ color: 0x22d3ee, width: 1.2, alpha: 0.45 });
              // Bone connector from parent pivot to selected pivot
              overlay
                .moveTo(parentMat[4], parentMat[5])
                .lineTo(selMat[4], selMat[5])
                .stroke({ color: 0x22d3ee, width: 1.6, alpha: 0.7 });
              overlay.circle(parentMat[4], parentMat[5], 4).fill({ color: 0x22d3ee, alpha: 0.8 });
            }
          }

          // 2. Direct Children outlines (violet) + Selected→Child bone connectors
          const children = displayChar.parts.filter((p) => p.parent_slot_id === selected.slot_id);
          for (const child of children) {
            const cMat = worldMats.get(child.slot_id);
            if (!cMat || !selMat) continue;
            overlay
              .moveTo(selMat[4], selMat[5])
              .lineTo(cMat[4], cMat[5])
              .stroke({ color: 0xc084fc, width: 1.2, alpha: 0.55 });
            overlay.circle(cMat[4], cMat[5], 3.5).fill({ color: 0xc084fc, alpha: 0.8 });
          }

          // 3. Selected part bounding quad + handles
          if (selMat) {
            const quad = computePartCanvasQuad(
              selected,
              selMat,
              selDims?.width ?? 70,
              selDims?.height ?? 70,
            );
            const boxColor = selected.locked ? 0xf59e0b : 0x7c6cf6;
            overlay
              .moveTo(quad.corners[0].x, quad.corners[0].y)
              .lineTo(quad.corners[1].x, quad.corners[1].y)
              .lineTo(quad.corners[2].x, quad.corners[2].y)
              .lineTo(quad.corners[3].x, quad.corners[3].y)
              .closePath()
              .stroke({ color: boxColor, width: selected.locked ? 2 : 1.6, alpha: 0.95 });

            if (!selected.locked) {
              // Corner handles
              for (const pt of quad.corners) {
                overlay
                  .rect(pt.x - 4, pt.y - 4, 8, 8)
                  .fill(0xffffff)
                  .stroke({ color: boxColor, width: 1.5 });
              }
              // Top rotation handle stem
              const dirX = quad.topCenter.x - quad.center.x;
              const dirY = quad.topCenter.y - quad.center.y;
              const len = Math.hypot(dirX, dirY) || 1;
              const rotHandleX = quad.topCenter.x + (dirX / len) * 24;
              const rotHandleY = quad.topCenter.y + (dirY / len) * 24;
              overlay
                .moveTo(quad.topCenter.x, quad.topCenter.y)
                .lineTo(rotHandleX, rotHandleY)
                .stroke({ color: boxColor, width: 1.6 });
              overlay
                .circle(rotHandleX, rotHandleY, 5.5)
                .fill(0x7c6cf6)
                .stroke({ color: 0xffffff, width: 1.5 });
            }

            // 4. Amber Pivot Crosshair
            if (showPivots || tool === 'pivot') {
              const px = quad.pivot.x;
              const py = quad.pivot.y;
              const radius = tool === 'pivot' ? 12 : 9;
              overlay
                .circle(px, py, radius)
                .stroke({ color: 0xf59e0b, width: tool === 'pivot' ? 2.5 : 2 })
                .moveTo(px - radius - 6, py)
                .lineTo(px + radius + 6, py)
                .moveTo(px, py - radius - 6)
                .lineTo(px, py + radius + 6)
                .stroke({ color: 0xf59e0b, width: 2 });
              overlay.circle(px, py, 2.5).fill(0xf59e0b);
            }
          }
        }
      } else if (showPivots && !previewPlaying) {
        // Show subtle pivot dots for all parts when nothing selected
        for (const p of displayChar.parts) {
          if (!p.visible) continue;
          const m = worldMats.get(p.slot_id);
          if (m) {
            overlay.circle(m[4], m[5], 3.5).stroke({ color: 0xf59e0b, width: 1.2, alpha: 0.65 });
          }
        }
      }
    }

    appRef.current.renderer.render(appRef.current.stage);
  }, [
    displayChar,
    draft,
    selectedSlotId,
    tool,
    showPivots,
    snapGrid,
    previewPose,
    previewPlaying,
    previewExprId,
    previewEye,
    previewMouth,
    assetDimsById,
    redrawTick,
  ]);

  // Convert DOM client coordinates to logical 620x620 Pixi canvas coordinates
  const clientToCanvasCoords = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const canvas = canvasElRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const size = Math.min(rect.width, rect.height);
    const offX = (rect.width - size) / 2;
    const offY = (rect.height - size) / 2;
    return {
      x: ((clientX - rect.left - offX) / size) * CANVAS_SIZE,
      y: ((clientY - rect.top - offY) / size) * CANVAS_SIZE,
    };
  };

  const mutateDraft = (updater: (prev: Character) => Character) => {
    if (previewPlaying) {
      setPreviewPlaying(false);
      setPreviewElapsedMs(0);
    }
    setDraft((prev) => {
      if (!prev) return prev;
      return updater(prev);
    });
    setDirty(true);
  };

  const updateSlot = (slotId: string, patch: Partial<CharacterPartSlot>) => {
    mutateDraft((prev) => ({
      ...prev,
      parts: prev.parts.map((p) => (p.slot_id === slotId ? { ...p, ...patch } : p)),
    }));
  };

  const handleReparentSlot = (slotId: string, newParentId: string | null) => {
    if (!draft) return;
    if (!canReparentPart(draft.parts, slotId, newParentId)) {
      pushToast('warning', t('builder.cycleBlockedToast'));
      return;
    }
    const child = draft.parts.find((p) => p.slot_id === slotId);
    const parent = newParentId ? draft.parts.find((p) => p.slot_id === newParentId) : null;
    const nextParts = reparentPartPreservingWorldTransform(draft.parts, slotId, newParentId);
    if (!nextParts) return;
    mutateDraft((prev) => ({ ...prev, parts: nextParts }));
    if (child) {
      pushToast(
        'info',
        parent
          ? t('builder.reparentedToast', { child: child.name, parent: parent.name })
          : t('builder.unparentedToast', { child: child.name }),
      );
    }
  };

  const handleMovePivot = (slotId: string, ax: number, ay: number) => {
    if (!draft) return;
    const slot = draft.parts.find((p) => p.slot_id === slotId);
    if (!slot) return;
    if (keepVisualOnPivot) {
      const dims = slot.default_asset_id ? assetDimsById.get(slot.default_asset_id) : undefined;
      const nextParts = movePartPivotPreservingVisualPosition(
        draft.parts,
        slotId,
        ax,
        ay,
        dims?.width ?? 100,
        dims?.height ?? 100,
      );
      mutateDraft((prev) => ({ ...prev, parts: nextParts }));
    } else {
      updateSlot(slotId, {
        anchor_x: Math.max(0, Math.min(1, ax)),
        anchor_y: Math.max(0, Math.min(1, ay)),
      });
    }
  };

  const attachAssetAsPart = (asset: Asset, preferredRole?: PartRole) => {
    if (!draft) return;
    const role = preferredRole ?? asset.part_role ?? guessPartRoleFromFilename(asset.name);

    // If an unassigned starter slot already exists with the exact same role, fill it cleanly!
    const emptyMatchingSlot = draft.parts.find(
      (p) => p.part_role === role && !p.default_asset_id,
    );
    if (emptyMatchingSlot) {
      const pivot = getDefaultPivotForRole(role);
      updateSlot(emptyMatchingSlot.slot_id, {
        default_asset_id: asset.asset_id,
        anchor_x: pivot.anchor_x,
        anchor_y: pivot.anchor_y,
      });
      setSelectedSlotId(emptyMatchingSlot.slot_id);
      return;
    }

    const slotId = `slot_${role}_${Math.random().toString(36).slice(2, 6)}`;
    const pivot = getDefaultPivotForRole(role);
    const parentSlotId = getSuggestedParentSlotId(draft.parts, role);
    const offset = getSuggestedLocalOffsetForRole(role);
    const zIndex = getSuggestedZIndexForRole(role);

    const newSlot: CharacterPartSlot = {
      slot_id: slotId,
      name: asset.name,
      part_role: role,
      parent_slot_id: parentSlotId,
      default_asset_id: asset.asset_id,
      variants: {},
      z_index: zIndex,
      anchor_x: pivot.anchor_x,
      anchor_y: pivot.anchor_y,
      default_transform: {
        x: offset.x,
        y: offset.y,
        rotation_deg: 0,
        scale_x: 1,
        scale_y: 1,
        opacity: 1,
      },
      visible: true,
      locked: false,
    };

    mutateDraft((prev) => ({
      ...prev,
      parts: [...prev.parts, newSlot],
    }));
    setSelectedSlotId(slotId);
  };

  const handleImportPngFiles = async (files: File[]) => {
    if (!draft || files.length === 0) return;
    const pngs = files.filter((f) => /\.(png|webp)$/i.test(f.name) || f.type === 'image/png' || f.type === 'image/webp');
    if (pngs.length === 0) return;

    setUploading(true);
    try {
      const importedPairs: Array<{ asset: Asset; role: PartRole; partName: string }> = [];
      for (const file of pngs) {
        const guessedRole = guessPartRoleFromFilename(file.name);
        const fileStem = file.name.replace(/\.[^.]+$/, '').trim();
        const pivot = getDefaultPivotForRole(guessedRole);
        const asset = await apiClient.importAsset({
          file,
          type: 'character_part',
          part_role: guessedRole,
          folder: draft.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '_') || 'characters',
          tags: [draft.name, guessedRole],
          anchor_x: pivot.anchor_x,
          anchor_y: pivot.anchor_y,
          identity_verified: true,
        });
        upsertAsset(asset);
        importedPairs.push({ asset, role: guessedRole, partName: fileStem || asset.name });
      }

      // Attach all imported parts in logical hierarchy order (Body -> Head -> Limbs -> Hands/Feet -> Face/Hair)
      const attachPriority = (r: PartRole): number => {
        if (r === 'body') return 0;
        if (r === 'head') return 1;
        if (r === 'left_arm' || r === 'right_arm' || r === 'left_leg' || r === 'right_leg') return 2;
        if (r === 'left_hand' || r === 'right_hand' || r === 'left_foot' || r === 'right_foot') return 3;
        return 4;
      };
      importedPairs.sort((a, b) => attachPriority(a.role) - attachPriority(b.role));

      let lastSelectedId: string | null = null;
      mutateDraft((prev) => {
        let nextParts = [...prev.parts];
        for (const { asset, role, partName } of importedPairs) {
          const emptyMatch = nextParts.find((p) => p.part_role === role && !p.default_asset_id);
          if (emptyMatch) {
            const pivot = getDefaultPivotForRole(role);
            nextParts = nextParts.map((p) =>
              p.slot_id === emptyMatch.slot_id
                ? {
                    ...p,
                    default_asset_id: asset.asset_id,
                    anchor_x: pivot.anchor_x,
                    anchor_y: pivot.anchor_y,
                  }
                : p,
            );
            lastSelectedId = emptyMatch.slot_id;
          } else {
            const slotId = `slot_${role}_${Math.random().toString(36).slice(2, 6)}`;
            const pivot = getDefaultPivotForRole(role);
            const parentSlotId = getSuggestedParentSlotId(nextParts, role);
            const offset = getSuggestedLocalOffsetForRole(role);
            const zIndex = getSuggestedZIndexForRole(role);
            nextParts.push({
              slot_id: slotId,
              name: partName,
              part_role: role,
              parent_slot_id: parentSlotId,
              default_asset_id: asset.asset_id,
              variants: {},
              z_index: zIndex,
              anchor_x: pivot.anchor_x,
              anchor_y: pivot.anchor_y,
              default_transform: {
                x: offset.x,
                y: offset.y,
                rotation_deg: 0,
                scale_x: 1,
                scale_y: 1,
                opacity: 1,
              },
              visible: true,
              locked: false,
            });
            lastSelectedId = slotId;
          }
        }
        return { ...prev, parts: nextParts };
      });
      if (lastSelectedId) setSelectedSlotId(lastSelectedId);
      pushToast(
        'success',
        t('builder.importedPartsToast', { count: importedPairs.length, name: draft.name }),
      );
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : 'Import failed');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // Interactive Canvas Direct Manipulation (Select, Move, Rotate around Pivot, Scale, Move Pivot)
  const handleCanvasPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !draft) return;
    if (previewPlaying) {
      setPreviewPlaying(false);
      setPreviewElapsedMs(0);
    }
    const pt = clientToCanvasCoords(e.clientX, e.clientY);
    if (!pt) return;

    const worldMats = computePartWorldMatrices(draft.parts, RIG_ROOT_X, RIG_ROOT_Y);
    let targetSlot = selectedSlotId
      ? (draft.parts.find((p) => p.slot_id === selectedSlotId) ?? null)
      : null;

    // Check if clicking directly on the selected part's pivot, rotation handle, or scale corner
    let activeOp: 'move' | 'rotate' | 'scale' | 'pivot' =
      tool === 'select' ? 'move' : tool;

    let hitOnSelectedGizmo = false;
    if (targetSlot && !targetSlot.locked) {
      const selMat = worldMats.get(targetSlot.slot_id);
      if (selMat) {
        const dims = targetSlot.default_asset_id
          ? assetDimsById.get(targetSlot.default_asset_id)
          : undefined;
        const quad = computePartCanvasQuad(
          targetSlot,
          selMat,
          dims?.width ?? 70,
          dims?.height ?? 70,
        );

        // 1. Pivot crosshair hit (highest priority in pivot mode, or direct hit when showPivots ON)
        const distPivot = Math.hypot(pt.x - quad.pivot.x, pt.y - quad.pivot.y);
        if (tool === 'pivot' || (showPivots && distPivot <= 11)) {
          activeOp = 'pivot';
          hitOnSelectedGizmo = true;
        } else {
          // 2. Top rotation stem handle hit
          const dirX = quad.topCenter.x - quad.center.x;
          const dirY = quad.topCenter.y - quad.center.y;
          const len = Math.hypot(dirX, dirY) || 1;
          const rotHandleX = quad.topCenter.x + (dirX / len) * 24;
          const rotHandleY = quad.topCenter.y + (dirY / len) * 24;
          if (Math.hypot(pt.x - rotHandleX, pt.y - rotHandleY) <= 13) {
            activeOp = 'rotate';
            hitOnSelectedGizmo = true;
          } else {
            // 3. Corner scale handles hit
            for (const c of quad.corners) {
              if (Math.hypot(pt.x - c.x, pt.y - c.y) <= 10) {
                activeOp = 'scale';
                hitOnSelectedGizmo = true;
                break;
              }
            }
          }
        }
      }
    }

    if (!hitOnSelectedGizmo && tool !== 'pivot') {
      const hit = hitTestCharacterParts(draft.parts, worldMats, assetDimsById, pt.x, pt.y);
      if (!hit) {
        setSelectedSlotId(null);
        return;
      }
      targetSlot = hit;
      setSelectedSlotId(hit.slot_id);
      if (hit.locked) return;
      activeOp = tool === 'select' ? 'move' : tool;
    }

    if (!targetSlot || targetSlot.locked) return;

    const slotId = targetSlot.slot_id;
    const origParts = structuredClone(draft.parts);
    const origSlot = structuredClone(targetSlot);
    const origWorldMat = worldMats.get(slotId)!;
    const parentWorldMat: [number, number, number, number, number, number] =
      targetSlot.parent_slot_id && worldMats.has(targetSlot.parent_slot_id)
        ? worldMats.get(targetSlot.parent_slot_id)!
        : [1, 0, 0, 1, RIG_ROOT_X, RIG_ROOT_Y];
    const dims = targetSlot.default_asset_id
      ? assetDimsById.get(targetSlot.default_asset_id)
      : undefined;
    const texW = dims?.width ?? 100;
    const texH = dims?.height ?? 100;

    const pivotWorld = { x: origWorldMat[4], y: origWorldMat[5] };
    const startAngle = Math.atan2(pt.y - pivotWorld.y, pt.x - pivotWorld.x);
    const startDist = Math.max(12, Math.hypot(pt.x - pivotWorld.x, pt.y - pivotWorld.y));

    activeDragCleanupRef.current?.();
    const pointerTarget = e.currentTarget;
    const pointerId = e.pointerId;
    try {
      pointerTarget.setPointerCapture?.(pointerId);
    } catch {
      // Ignore synthetic events
    }

    const onMove = (me: PointerEvent) => {
      const curPt = clientToCanvasCoords(me.clientX, me.clientY);
      if (!curPt) return;

      if (activeOp === 'move') {
        const dx = curPt.x - pt.x;
        const dy = curPt.y - pt.y;
        const localDelta = applyLinearInverse(parentWorldMat, dx, dy);
        let nx = origSlot.default_transform.x + localDelta.x;
        let ny = origSlot.default_transform.y + localDelta.y;
        if (snapGrid && !me.shiftKey) {
          nx = Math.round(nx / 8) * 8;
          ny = Math.round(ny / 8) * 8;
        }
        setDraft((prev) =>
          prev
            ? {
                ...prev,
                parts: prev.parts.map((p) =>
                  p.slot_id === slotId
                    ? {
                        ...p,
                        default_transform: {
                          ...p.default_transform,
                          x: round2(nx),
                          y: round2(ny),
                        },
                      }
                    : p,
                ),
              }
            : prev,
        );
        setDirty(true);
      } else if (activeOp === 'rotate') {
        const curAngle = Math.atan2(curPt.y - pivotWorld.y, curPt.x - pivotWorld.x);
        const deltaDeg = ((curAngle - startAngle) * 180) / Math.PI;
        let nextRot = origSlot.default_transform.rotation_deg + deltaDeg;
        if (me.shiftKey) nextRot = Math.round(nextRot / 15) * 15;
        setDraft((prev) =>
          prev
            ? {
                ...prev,
                parts: prev.parts.map((p) =>
                  p.slot_id === slotId
                    ? {
                        ...p,
                        default_transform: {
                          ...p.default_transform,
                          rotation_deg: round2(nextRot),
                        },
                      }
                    : p,
                ),
              }
            : prev,
        );
        setDirty(true);
      } else if (activeOp === 'scale') {
        const curDist = Math.max(8, Math.hypot(curPt.x - pivotWorld.x, curPt.y - pivotWorld.y));
        const ratio = Math.max(0.08, Math.min(8, curDist / startDist));
        const nextSx = round2(Math.max(0.05, Math.min(10, origSlot.default_transform.scale_x * ratio)));
        const nextSy = round2(Math.max(0.05, Math.min(10, origSlot.default_transform.scale_y * ratio)));
        setDraft((prev) =>
          prev
            ? {
                ...prev,
                parts: prev.parts.map((p) =>
                  p.slot_id === slotId
                    ? {
                        ...p,
                        default_transform: {
                          ...p.default_transform,
                          scale_x: nextSx,
                          scale_y: nextSy,
                        },
                      }
                    : p,
                ),
              }
            : prev,
        );
        setDirty(true);
      } else if (activeOp === 'pivot') {
        const nextAnchor = canvasPointToPartAnchor(
          origSlot,
          origWorldMat,
          curPt.x,
          curPt.y,
          texW,
          texH,
        );
        const nextParts = keepVisualOnPivot
          ? movePartPivotPreservingVisualPosition(
              origParts,
              slotId,
              nextAnchor.anchor_x,
              nextAnchor.anchor_y,
              texW,
              texH,
            )
          : origParts.map((p) =>
              p.slot_id === slotId
                ? { ...p, anchor_x: nextAnchor.anchor_x, anchor_y: nextAnchor.anchor_y }
                : p,
            );
        setDraft((prev) => (prev ? { ...prev, parts: nextParts } : prev));
        setDirty(true);
      }
    };

    const cleanup = () => {
      try {
        if (pointerTarget.hasPointerCapture?.(pointerId)) {
          pointerTarget.releasePointerCapture(pointerId);
        }
      } catch {
        // Ignore
      }
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', cleanup);
      window.removeEventListener('pointercancel', cleanup);
      activeDragCleanupRef.current = null;
    };

    activeDragCleanupRef.current = cleanup;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', cleanup);
    window.addEventListener('pointercancel', cleanup);
  };

  const handleQuickCreateCharacter = async () => {
    setCreatingChar(true);
    try {
      const char = await apiClient.createCharacter(
        createStarterCharacterPayload(`Character ${characters.length + 1}`),
      );
      upsertCharacter(char);
      onSelectCharacter?.(char.character_id);
      setDraft(structuredClone(char));
      setSelectedSlotId(char.parts[0]?.slot_id ?? null);
      pushToast('success', t('chars.createdToast', { name: char.name }));
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : 'Error');
    } finally {
      setCreatingChar(false);
    }
  };

  if (!draft) {
    return (
      <div className="canvas-viewport">
        <EmptyState
          title={t('builder.emptyTitle')}
          description={t('builder.emptyDesc')}
          action={
            <button
              type="button"
              className="btn-primary"
              disabled={creatingChar}
              onClick={() => void handleQuickCreateCharacter()}
            >
              <UserPlus size={14} /> {t('builder.createNow')}
            </button>
          }
        />
      </div>
    );
  }

  const selectedSlot = draft.parts.find((p) => p.slot_id === selectedSlotId) ?? null;
  const selectedDescendants = selectedSlot ? getDescendantSlotIds(draft.parts, selectedSlot.slot_id) : new Set<string>();
  const hierarchyNodes = buildHierarchyTree(draft.parts, collapsedSlots);

  const addPartSlot = () => {
    const id = `slot_custom_${Math.random().toString(36).slice(2, 7)}`;
    const newSlot: CharacterPartSlot = {
      slot_id: id,
      name: `Part ${draft.parts.length + 1}`,
      part_role: 'custom',
      parent_slot_id: draft.parts.find((p) => p.part_role === 'body')?.slot_id ?? null,
      default_asset_id: null,
      variants: {},
      z_index: 20 + draft.parts.length,
      anchor_x: 0.5,
      anchor_y: 0.5,
      default_transform: { x: 0, y: 0, rotation_deg: 0, scale_x: 1, scale_y: 1, opacity: 1 },
      visible: true,
      locked: false,
    };
    mutateDraft((prev) => ({ ...prev, parts: [...prev.parts, newSlot] }));
    setSelectedSlotId(id);
  };

  const addStandardLimbs = () => {
    const bodySlot = draft.parts.find((p) => p.part_role === 'body') ?? draft.parts[0];
    const headSlot = draft.parts.find((p) => p.part_role === 'head') ?? bodySlot;
    const existingRoles = new Set(draft.parts.map((p) => p.part_role));

    const rolesToEnsure: Array<{ role: PartRole; name: string; parentId: string | null }> = [
      { role: 'hair_back', name: 'Hair Back', parentId: headSlot?.slot_id ?? null },
      { role: 'hair_front', name: 'Hair Front', parentId: headSlot?.slot_id ?? null },
      { role: 'left_arm', name: 'Left Arm', parentId: bodySlot?.slot_id ?? null },
      { role: 'right_arm', name: 'Right Arm', parentId: bodySlot?.slot_id ?? null },
      { role: 'left_leg', name: 'Left Leg', parentId: bodySlot?.slot_id ?? null },
      { role: 'right_leg', name: 'Right Leg', parentId: bodySlot?.slot_id ?? null },
    ];

    const additions: CharacterPartSlot[] = [];
    for (const item of rolesToEnsure) {
      if (existingRoles.has(item.role)) continue;
      const piv = getDefaultPivotForRole(item.role);
      const off = getSuggestedLocalOffsetForRole(item.role);
      additions.push({
        slot_id: `slot_${item.role}_${Math.random().toString(36).slice(2, 5)}`,
        name: item.name,
        part_role: item.role,
        parent_slot_id: item.parentId,
        default_asset_id: null,
        variants: {},
        z_index: getSuggestedZIndexForRole(item.role),
        anchor_x: piv.anchor_x,
        anchor_y: piv.anchor_y,
        default_transform: {
          x: off.x,
          y: off.y,
          rotation_deg: 0,
          scale_x: 1,
          scale_y: 1,
          opacity: 1,
        },
        visible: true,
        locked: false,
      });
    }

    if (additions.length === 0) {
      pushToast('info', t('rig.limbsAllPresentToast'));
      return;
    }

    mutateDraft((prev) => ({ ...prev, parts: [...prev.parts, ...additions] }));
    setSelectedSlotId(additions[0].slot_id);
    pushToast('success', t('rig.limbsAddedToast', { count: additions.length }));
  };

  const handleDeleteSlot = (slotId: string) => {
    const slot = draft.parts.find((p) => p.slot_id === slotId);
    if (!slot) return;
    // Reparent direct children to the deleted slot's parent preserving visual positions
    let next = [...draft.parts];
    for (const child of next.filter((p) => p.parent_slot_id === slotId)) {
      const reparented = reparentPartPreservingWorldTransform(
        next,
        child.slot_id,
        slot.parent_slot_id,
      );
      if (reparented) next = reparented;
    }
    next = next.filter((p) => p.slot_id !== slotId);
    mutateDraft((prev) => ({ ...prev, parts: next }));
    if (selectedSlotId === slotId) {
      setSelectedSlotId(next[0]?.slot_id ?? null);
    }
  };

  const handleGroupSelected = () => {
    if (!selectedSlot) return;
    const res = groupPartsUnderNewGroup(
      draft.parts,
      [selectedSlot.slot_id],
      `${selectedSlot.name} Group`,
      () => `slot_grp_${Math.random().toString(36).slice(2, 6)}`,
    );
    if (res) {
      mutateDraft((prev) => ({ ...prev, parts: res.parts }));
      setSelectedSlotId(res.groupId);
    }
  };

  const handleUngroupSelected = () => {
    if (!selectedSlot) return;
    const next = ungroupPart(draft.parts, selectedSlot.slot_id);
    if (next) {
      mutateDraft((prev) => ({ ...prev, parts: next }));
      setSelectedSlotId(next[0]?.slot_id ?? null);
    }
  };

  const handleResetSelectedPart = () => {
    if (!selectedSlot) return;
    const defOff = getSuggestedLocalOffsetForRole(selectedSlot.part_role);
    const defPiv = getDefaultPivotForRole(selectedSlot.part_role);
    updateSlot(selectedSlot.slot_id, {
      anchor_x: defPiv.anchor_x,
      anchor_y: defPiv.anchor_y,
      default_transform: {
        x: defOff.x,
        y: defOff.y,
        rotation_deg: 0,
        scale_x: 1,
        scale_y: 1,
        opacity: 1,
      },
    });
  };

  const handleResetCharacterPose = () => {
    setPreviewPlaying(false);
    setPreviewElapsedMs(0);
    mutateDraft((prev) => ({
      ...prev,
      parts: prev.parts.map((p) => ({
        ...p,
        default_transform: {
          ...p.default_transform,
          rotation_deg: 0,
          scale_x: 1,
          scale_y: 1,
          opacity: 1,
        },
      })),
    }));
  };

  const handleSave = async (): Promise<Character | null> => {
    setSaving(true);
    try {
      const analysis = analyzeCharacterRig(draft, assetsById);
      const saved = await apiClient.updateCharacter(draft.character_id, {
        name: draft.name.trim() || 'Character',
        description: draft.description,
        tags: draft.tags,
        identity_confirmed: draft.identity_confirmed,
        thumbnail_asset_id: analysis.thumbnailAssetId,
        parts: draft.parts,
        expressions: draft.expressions,
        poses: draft.poses,
      });
      upsertCharacter(saved);
      setDraft(structuredClone(saved));
      setDirty(false);
      pushToast('success', t('rig.savedToast', { name: saved.name, version: saved.version }));
      return saved;
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : t('rig.saveError'));
      return null;
    } finally {
      setSaving(false);
    }
  };

  const handleSaveAndAddToScene = async () => {
    if (!activeScene) return;
    const charToAdd = dirty ? await handleSave() : draft;
    if (!charToAdd) return;
    addCharacterToScene(activeScene.scene_id, charToAdd.character_id, charToAdd.name);
    pushToast(
      'success',
      t('chars.addedToStageToast', { name: charToAdd.name, scene: activeScene.name }),
    );
    onClose();
  };

  const addExpression = () => {
    const nm = newExprName.trim();
    if (!nm) return;
    const expr: ExpressionPreset = {
      expression_id: `expr_${Math.random().toString(36).slice(2, 8)}`,
      name: nm,
      slot_variant_overrides: {},
      slot_transform_overrides: {},
    };
    mutateDraft((prev) => ({ ...prev, expressions: [...prev.expressions, expr] }));
    setPreviewExprId(expr.expression_id);
    setNewExprName('');
  };

  const hasPartsWithAssets = (rigAnalysis?.assignedParts ?? 0) > 0;
  const hasHierarchy = draft.parts.some((p) => Boolean(p.parent_slot_id));
  const selectedHasChildren = Boolean(
    selectedSlot && draft.parts.some((p) => p.parent_slot_id === selectedSlot.slot_id),
  );
  const currentActionCap = rigAnalysis?.actions[previewAction];

  return (
    <div className="char-builder-shell" data-testid="character-builder">
      {/* TOP BUILDER BAR: Name, Identity, 5-Step Progress, Save / Reset / Cancel / Add to Scene */}
      <div className="char-builder-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: '1 1 260px' }}>
          <input
            aria-label={t('chars.newPlaceholder')}
            value={draft.name}
            onChange={(e) => mutateDraft((prev) => ({ ...prev, name: e.target.value }))}
            style={{ fontWeight: 600, minWidth: 110, maxWidth: 180 }}
          />
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 11,
              color: 'var(--text-secondary)',
              whiteSpace: 'nowrap',
            }}
          >
            <input
              type="checkbox"
              checked={draft.identity_confirmed}
              onChange={(e) =>
                mutateDraft((prev) => ({ ...prev, identity_confirmed: e.target.checked }))
              }
            />
            <CheckCircle2 size={12} color={draft.identity_confirmed ? '#22c55e' : '#626878'} />
            {t('rig.identityConfirmed')}
          </label>
          {dirty && <span className="tag-pill warning">{t('common.unsaved')}</span>}
        </div>

        {/* Guided 5-Step Workflow Progress */}
        <div className="char-builder-steps">
          <span className={`builder-step ${hasPartsWithAssets ? 'done' : 'active'}`}>
            {t('builder.step1')}
          </span>
          <span className="builder-step-sep">→</span>
          <span className={`builder-step ${hasPartsWithAssets && hasHierarchy ? 'done' : ''}`}>
            {t('builder.step2')}
          </span>
          <span className="builder-step-sep">→</span>
          <span className={`builder-step ${tool === 'pivot' ? 'active' : ''}`}>
            {t('builder.step3')}
          </span>
          <span className="builder-step-sep">→</span>
          <span className={`builder-step ${previewPlaying ? 'active' : ''}`}>
            {t('builder.step4')}
          </span>
          <span className="builder-step-sep">→</span>
          <span className={`builder-step ${!dirty && hasPartsWithAssets ? 'done' : ''}`}>
            {t('builder.step5')}
          </span>
        </div>

        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          {dirty && sourceChar && (
            <button
              type="button"
              className="btn-xs"
              onClick={() => {
                setDraft(structuredClone(sourceChar));
                setDirty(false);
                pushToast('info', t('builder.resetChangesToast'));
              }}
              title={t('builder.resetChanges')}
            >
              <RotateCcw size={11} /> {t('common.reset')}
            </button>
          )}
          <button type="button" className="btn-xs" onClick={onClose}>
            {t('builder.cancel')}
          </button>
          <button
            type="button"
            className="btn-primary btn-xs"
            disabled={saving}
            onClick={() => void handleSave()}
            data-testid="builder-save-btn"
          >
            <Save size={12} /> {saving ? t('common.saving') : t('rig.saveRig')}
          </button>
          <button
            type="button"
            className="btn-xs"
            disabled={!activeScene || saving}
            title={!activeScene ? t('chars.noProjectHint') : t('builder.addToScene')}
            onClick={() => void handleSaveAndAddToScene()}
            data-testid="builder-add-scene-btn"
          >
            <Plus size={11} /> {t('builder.addToScene')}
          </button>
        </div>
      </div>

      {/* 3-COLUMN CHARACTER BUILDER BODY */}
      <div className="char-builder-body">
        {/* COLUMN 1: Import Parts, Asset Reuse & Editable Hierarchy Tree */}
        <div className="char-builder-col-left">
          {/* Multi-PNG Dropzone & File Picker */}
          <div
            className={`builder-dropzone ${fileDropActive ? 'drag-over' : ''}`}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes('Files')) {
                e.preventDefault();
                setFileDropActive(true);
              }
            }}
            onDragLeave={() => setFileDropActive(false)}
            onDrop={(e) => {
              setFileDropActive(false);
              if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                e.preventDefault();
                void handleImportPngFiles(Array.from(e.dataTransfer.files));
              }
            }}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload size={14} color="var(--accent-text)" />
            <div style={{ fontSize: 11, fontWeight: 600 }}>
              {uploading ? t('common.loading') : t('builder.importPartsBtn')}
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', textAlign: 'center' }}>
              {t('builder.dropPngHint')}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".png,.webp,image/png,image/webp"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => void handleImportPngFiles(Array.from(e.target.files ?? []))}
            />
          </div>

          {/* Reuse Existing Library PNGs */}
          <CollapsibleSection
            title={t('builder.reuseAssetsTitle')}
            badge={partAssets.length}
            defaultOpen={false}
          >
            {partAssets.length === 0 ? (
              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                {t('builder.reuseAssetsEmpty')}
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 5 }}>
                {partAssets.map((a) => (
                  <button
                    key={a.asset_id}
                    type="button"
                    className="builder-asset-chip"
                    title={`${a.name} — ${t('builder.addAssetAsPart')}`}
                    onClick={() => attachAssetAsPart(a)}
                  >
                    <img src={apiClient.getAssetFileUrl(a.asset_id)} alt={a.name} />
                    <span>{a.name}</span>
                  </button>
                ))}
              </div>
            )}
          </CollapsibleSection>

          {/* Editable Character Hierarchy Tree */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, flex: 1, minHeight: 0 }}>
            <div className="inspector-section-title" style={{ marginBottom: 0 }}>
              <span>{t('builder.hierarchyTitle', { count: draft.parts.length })}</span>
              <div style={{ display: 'flex', gap: 3 }}>
                <button
                  type="button"
                  className="btn-xs"
                  onClick={addStandardLimbs}
                  title={t('rig.addStandardLimbsTip')}
                >
                  {t('rig.addStandardLimbs')}
                </button>
                <button
                  type="button"
                  className="btn-xs"
                  onClick={addPartSlot}
                  title={t('rig.addSlot')}
                >
                  <Plus size={10} />
                </button>
              </div>
            </div>

            {/* Root Dropzone (visible when dragging a part to unparent it!) */}
            {dragPartId && (
              <div
                className={`builder-root-drop ${dropParentId === 'ROOT' ? 'active' : ''}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDropParentId('ROOT');
                }}
                onDragLeave={() => {
                  if (dropParentId === 'ROOT') setDropParentId(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const src = dragPartId;
                  setDragPartId(null);
                  setDropParentId(null);
                  if (src) handleReparentSlot(src, null);
                }}
              >
                <FolderUp size={11} /> {t('builder.dropRootHint')}
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, overflowY: 'auto', flex: 1 }}>
              {hierarchyNodes.map(({ part, depth, hasChildren }) => {
                const isSelected = selectedSlotId === part.slot_id;
                const isParentOfSelected = Boolean(
                  selectedSlot && selectedSlot.parent_slot_id === part.slot_id,
                );
                const isChildOfSelected = Boolean(
                  selectedSlot && part.parent_slot_id === selectedSlot.slot_id,
                );
                const isCollapsed = collapsedSlots.has(part.slot_id);
                const isDropTarget = dropParentId === part.slot_id;

                return (
                  <div
                    key={part.slot_id}
                    draggable={renamingSlotId !== part.slot_id}
                    data-slot-id={part.slot_id}
                    className={`builder-tree-row ${isSelected ? 'selected' : ''} ${isParentOfSelected ? 'is-parent' : ''} ${isChildOfSelected ? 'is-child' : ''} ${isDropTarget ? 'drop-parent' : ''}`}
                    style={{
                      paddingLeft: 6 + depth * 14,
                      opacity: part.visible ? 1 : 0.45,
                    }}
                    onClick={() => setSelectedSlotId(part.slot_id)}
                    onDragStart={(e) => {
                      setDragPartId(part.slot_id);
                      e.dataTransfer.setData('text/plain', part.slot_id);
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragEnd={() => {
                      setDragPartId(null);
                      setDropParentId(null);
                    }}
                    onDragOver={(e) => {
                      if (!dragPartId || dragPartId === part.slot_id) return;
                      e.preventDefault();
                      setDropParentId(part.slot_id);
                    }}
                    onDragLeave={() => {
                      if (dropParentId === part.slot_id) setDropParentId(null);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      const src = dragPartId;
                      setDragPartId(null);
                      setDropParentId(null);
                      if (src && src !== part.slot_id) {
                        handleReparentSlot(src, part.slot_id);
                      }
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, flex: 1 }}>
                      {hasChildren ? (
                        <button
                          type="button"
                          className="btn-ghost btn-icon btn-xs"
                          style={{ width: 15, height: 15, padding: 0 }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setCollapsedSlots((prev) => {
                              const next = new Set(prev);
                              if (next.has(part.slot_id)) next.delete(part.slot_id);
                              else next.add(part.slot_id);
                              return next;
                            });
                          }}
                        >
                          {isCollapsed ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
                        </button>
                      ) : (
                        <span style={{ width: 15, flexShrink: 0 }} />
                      )}

                      {renamingSlotId === part.slot_id ? (
                        <input
                          autoFocus
                          value={renameDraft}
                          style={{ flex: 1, fontSize: 11, padding: '1px 4px', minWidth: 0 }}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onBlur={() => {
                            const cleaned = renameDraft.trim();
                            if (cleaned) updateSlot(part.slot_id, { name: cleaned });
                            setRenamingSlotId(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              const cleaned = renameDraft.trim();
                              if (cleaned) updateSlot(part.slot_id, { name: cleaned });
                              setRenamingSlotId(null);
                            }
                            if (e.key === 'Escape') setRenamingSlotId(null);
                          }}
                        />
                      ) : (
                        <span
                          style={{
                            fontSize: 11,
                            fontWeight: isSelected ? 600 : 500,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            setRenamingSlotId(part.slot_id);
                            setRenameDraft(part.name);
                          }}
                          title={`${part.name} (${t(`partRole.${part.part_role}`)})`}
                        >
                          {part.name}
                        </span>
                      )}

                      {!part.default_asset_id && !hasChildren && (
                        <span className="tag-pill" style={{ fontSize: 8, padding: '0 4px', opacity: 0.7 }}>
                          {t('builder.tagEmptySlot')}
                        </span>
                      )}
                      {isParentOfSelected && (
                        <span className="tag-pill" style={{ fontSize: 8, padding: '0 4px', color: '#22d3ee' }}>
                          {t('builder.tagParent')}
                        </span>
                      )}
                      {isChildOfSelected && (
                        <span className="tag-pill" style={{ fontSize: 8, padding: '0 4px', color: '#c084fc' }}>
                          {t('builder.tagChild')}
                        </span>
                      )}
                    </div>

                    <div
                      style={{ display: 'flex', gap: 1, alignItems: 'center', flexShrink: 0 }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        className={`btn-ghost btn-icon btn-xs ${!part.visible ? 'btn-danger' : ''}`}
                        title={t('rig.toggleVisibility')}
                        aria-label={t('rig.toggleVisibility')}
                        onClick={() => updateSlot(part.slot_id, { visible: !part.visible })}
                      >
                        {part.visible ? <Eye size={10} /> : <EyeOff size={10} />}
                      </button>
                      <button
                        type="button"
                        className={`btn-ghost btn-icon btn-xs ${part.locked ? 'active' : ''}`}
                        title={t('builder.partLocked')}
                        aria-label={t('builder.partLocked')}
                        onClick={() => updateSlot(part.slot_id, { locked: !part.locked })}
                      >
                        {part.locked ? <Lock size={10} /> : <Unlock size={10} />}
                      </button>
                      <button
                        type="button"
                        className="btn-ghost btn-icon btn-xs"
                        title={t('common.delete')}
                        aria-label={t('common.delete')}
                        onClick={() => handleDeleteSlot(part.slot_id)}
                      >
                        <Trash2 size={10} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Hierarchy Group / Ungroup / Unparent Quick Bar */}
            {selectedSlot && (
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', paddingTop: 4, borderTop: '1px solid var(--border-subtle)' }}>
                <button type="button" className="btn-xs" onClick={handleGroupSelected}>
                  <FolderPlus size={10} /> {t('builder.addGroup')}
                </button>
                {selectedHasChildren && (
                  <button type="button" className="btn-xs" onClick={handleUngroupSelected}>
                    <FolderUp size={10} /> {t('builder.ungroup')}
                  </button>
                )}
                {selectedSlot.parent_slot_id && (
                  <button
                    type="button"
                    className="btn-xs"
                    onClick={() => handleReparentSlot(selectedSlot.slot_id, null)}
                  >
                    {t('builder.unparent')}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* COLUMN 2: Interactive Assembly Canvas + Live Rig Preview */}
        <div className="char-builder-col-center">
          {/* Interactive Canvas Tool Strip */}
          <div className="char-builder-canvas-bar">
            <div className="toolbar-group">
              <button
                type="button"
                className={`btn-xs ${tool === 'select' ? 'active' : ''}`}
                title={t('builder.toolSelect')}
                onClick={() => setTool('select')}
                data-testid="builder-tool-select"
              >
                <Move size={11} /> {t('builder.toolSelectShort')}
              </button>
              <button
                type="button"
                className={`btn-xs ${tool === 'rotate' ? 'active' : ''}`}
                title={t('builder.toolRotate')}
                onClick={() => setTool('rotate')}
                data-testid="builder-tool-rotate"
              >
                <RotateCw size={11} /> {t('builder.toolRotateShort')}
              </button>
              <button
                type="button"
                className={`btn-xs ${tool === 'scale' ? 'active' : ''}`}
                title={t('builder.toolScale')}
                onClick={() => setTool('scale')}
                data-testid="builder-tool-scale"
              >
                <Maximize2 size={11} /> {t('builder.toolScaleShort')}
              </button>
              <button
                type="button"
                className={`btn-xs ${tool === 'pivot' ? 'active' : ''}`}
                title={t('builder.toolPivot')}
                onClick={() => setTool('pivot')}
                data-testid="builder-tool-pivot"
              >
                <Crosshair size={11} /> {t('builder.toolPivotShort')}
              </button>
            </div>

            <div className="toolbar-group">
              <button
                type="button"
                className={`btn-xs ${showPivots ? 'active' : ''}`}
                title={t('builder.showPivots')}
                onClick={() => setShowPivots((v) => !v)}
              >
                <Crosshair size={11} />
              </button>
              <button
                type="button"
                className={`btn-xs ${snapGrid ? 'active' : ''}`}
                title={t('builder.snapGrid')}
                onClick={() => setSnapGrid((v) => !v)}
              >
                <Grid size={11} />
              </button>
              {selectedSlot && !selectedSlot.locked && (
                <button
                  type="button"
                  className="btn-xs"
                  title={t('builder.alignCenterX')}
                  onClick={() =>
                    updateSlot(selectedSlot.slot_id, {
                      default_transform: { ...selectedSlot.default_transform, x: 0 },
                    })
                  }
                >
                  <AlignCenterHorizontal size={11} />
                </button>
              )}
              {selectedSlot && (
                <button
                  type="button"
                  className="btn-xs"
                  title={t('builder.resetPart')}
                  onClick={handleResetSelectedPart}
                >
                  <RotateCcw size={11} /> {t('builder.resetPart')}
                </button>
              )}
              <button
                type="button"
                className="btn-xs"
                title={t('builder.resetCharacter')}
                onClick={handleResetCharacterPose}
              >
                {t('builder.resetCharacter')}
              </button>
            </div>
          </div>

          {/* Interactive PixiJS WebGL Assembly Canvas (also accepts PNG drag-and-drop!) */}
          <div
            className="char-builder-canvas-host"
            onPointerDown={handleCanvasPointerDown}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes('Files')) {
                e.preventDefault();
                setFileDropActive(true);
              }
            }}
            onDragLeave={() => setFileDropActive(false)}
            onDrop={(e) => {
              setFileDropActive(false);
              if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                e.preventDefault();
                void handleImportPngFiles(Array.from(e.dataTransfer.files));
              }
            }}
          >
            <div
              ref={previewHostRef}
              style={{
                width: '100%',
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor:
                  tool === 'pivot'
                    ? 'crosshair'
                    : tool === 'rotate'
                      ? 'alias'
                      : tool === 'scale'
                        ? 'nwse-resize'
                        : 'default',
              }}
            />
          </div>

          {/* Bottom Live Rig Preview Bar (Real Animated Actions + Truthful Capability Feedback) */}
          <div className="char-builder-preview-bar" data-testid="rig-preview-bar">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-secondary)' }}>
                  {t('builder.rigPreviewTitle')}
                </span>
                <button
                  type="button"
                  className={`btn-xs ${previewPlaying ? 'btn-danger' : 'btn-primary'}`}
                  disabled={!currentActionCap?.supported}
                  title={
                    currentActionCap && !currentActionCap.supported && currentActionCap.reasonKey
                      ? t(currentActionCap.reasonKey)
                      : previewPlaying
                        ? t('builder.stopPreview')
                        : t('builder.playPreview')
                  }
                  onClick={() => {
                    if (previewPlaying) {
                      setPreviewPlaying(false);
                      setPreviewElapsedMs(0);
                    } else {
                      setPreviewElapsedMs(0);
                      setPreviewPlaying(true);
                    }
                  }}
                  data-testid="rig-preview-play-btn"
                >
                  {previewPlaying ? <Square size={10} /> : <Play size={10} />}
                  {previewPlaying ? t('builder.stopPreview') : t('builder.playPreview')}
                </button>
                <button
                  type="button"
                  className="btn-xs"
                  onClick={() => {
                    setPreviewPlaying(false);
                    setPreviewElapsedMs(0);
                  }}
                >
                  <RotateCcw size={10} /> {t('builder.resetPose')}
                </button>
              </div>

              {/* Expression / Eye / Mouth quick testers */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <Smile size={12} color="#60a5fa" />
                <select
                  aria-label={t('rig.noExpression')}
                  value={previewExprId}
                  onChange={(e) => setPreviewExprId(e.target.value)}
                  style={{ fontSize: 10, padding: '2px 5px' }}
                >
                  <option value="">{t('rig.noExpression')}</option>
                  {draft.expressions.map((ex) => (
                    <option key={ex.expression_id} value={ex.expression_id}>
                      {t('rig.exprPrefix', { name: ex.name })}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Eyes"
                  value={previewEye}
                  onChange={(e) => setPreviewEye(e.target.value)}
                  style={{ fontSize: 10, padding: '2px 5px' }}
                >
                  {STANDARD_EYE_VARIANTS.map((v) => (
                    <option key={v} value={v}>
                      {t('rig.eyePrefix', { val: v })}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Mouth"
                  value={previewMouth}
                  onChange={(e) => setPreviewMouth(e.target.value)}
                  style={{ fontSize: 10, padding: '2px 5px' }}
                >
                  {STANDARD_MOUTH_VARIANTS.map((v) => (
                    <option key={v} value={v}>
                      {t('rig.mouthPrefix', { val: v })}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* 7 Real Rig Action Buttons */}
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
              {RIG_PREVIEW_ACTIONS.map((act) => {
                const cap = rigAnalysis?.actions[act];
                const supported = Boolean(cap?.supported);
                const isActive = previewAction === act;
                return (
                  <button
                    key={act}
                    type="button"
                    data-rig-action={act}
                    className={`btn-xs ${isActive && previewPlaying ? 'btn-primary' : isActive ? 'active' : ''}`}
                    style={{ opacity: supported ? 1 : 0.45 }}
                    title={
                      !supported && cap?.reasonKey
                        ? t(cap.reasonKey)
                        : t(`builder.action.${act}`)
                    }
                    onClick={() => {
                      setPreviewAction(act);
                      if (supported) {
                        setPreviewElapsedMs(0);
                        setPreviewPlaying(true);
                      } else {
                        setPreviewPlaying(false);
                        setPreviewElapsedMs(0);
                      }
                    }}
                  >
                    {t(`builder.action.${act}`)}
                  </button>
                );
              })}
            </div>

            {/* Honest explanation whenever selected action is unsupported by current rig */}
            {currentActionCap && !currentActionCap.supported && currentActionCap.reasonKey && (
              <div
                style={{
                  fontSize: 10,
                  color: 'var(--warning)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                }}
              >
                <HelpCircle size={11} style={{ flexShrink: 0 }} />
                <span>{t(currentActionCap.reasonKey)}</span>
              </div>
            )}
          </div>
        </div>

        {/* COLUMN 3: Pro Transform, Joint Pivot, Hierarchy & Variants Inspector */}
        <div className="char-builder-col-right">
          {selectedSlot ? (
            <>
              {selectedSlot.locked && (
                <div
                  style={{
                    fontSize: 10,
                    color: 'var(--warning)',
                    background: 'rgba(245, 158, 11, 0.1)',
                    border: '1px solid rgba(245, 158, 11, 0.3)',
                    borderRadius: 4,
                    padding: '5px 8px',
                  }}
                >
                  {t('builder.partLockedWarn')}
                </div>
              )}

              {/* Part & Hierarchy Section */}
              <CollapsibleSection title={t('builder.partInfo')} defaultOpen>
                <div className="field-grid">
                  <div className="field-row">
                    <label className="field-label">{t('rig.slotName')}</label>
                    <input
                      value={selectedSlot.name}
                      onChange={(e) => updateSlot(selectedSlot.slot_id, { name: e.target.value })}
                    />
                  </div>
                  <div className="field-row">
                    <label className="field-label">{t('rig.slotRole')}</label>
                    <select
                      value={selectedSlot.part_role}
                      onChange={(e) =>
                        updateSlot(selectedSlot.slot_id, { part_role: e.target.value as PartRole })
                      }
                    >
                      {ALL_PART_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {t(`partRole.${r}`)}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="field-row">
                  <label className="field-label">{t('rig.defaultSprite')}</label>
                  <select
                    value={selectedSlot.default_asset_id ?? ''}
                    onChange={(e) =>
                      updateSlot(selectedSlot.slot_id, { default_asset_id: e.target.value || null })
                    }
                  >
                    <option value="">{t('rig.selectPng')}</option>
                    {partAssets.map((a) => (
                      <option key={a.asset_id} value={a.asset_id}>
                        {a.name} ({a.width}×{a.height})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="field-grid">
                  <div className="field-row">
                    <label className="field-label">{t('rig.parentSlot')}</label>
                    <select
                      value={selectedSlot.parent_slot_id ?? ''}
                      onChange={(e) =>
                        handleReparentSlot(selectedSlot.slot_id, e.target.value || null)
                      }
                    >
                      <option value="">{t('rig.rootParent')}</option>
                      {draft.parts
                        .filter(
                          (p) =>
                            p.slot_id !== selectedSlot.slot_id &&
                            !selectedDescendants.has(p.slot_id),
                        )
                        .map((p) => (
                          <option key={p.slot_id} value={p.slot_id}>
                            {p.name}
                          </option>
                        ))}
                    </select>
                  </div>

                  <div className="field-row">
                    <label className="field-label">{t('inspector.layerZ')}</label>
                    <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
                      <NumericInput
                        value={selectedSlot.z_index}
                        step={1}
                        precision={0}
                        compact
                        onChange={(v) => updateSlot(selectedSlot.slot_id, { z_index: Math.round(v) })}
                      />
                      <button
                        type="button"
                        className="btn-icon btn-xs"
                        title={t('builder.zOrderForward')}
                        onClick={() =>
                          updateSlot(selectedSlot.slot_id, { z_index: selectedSlot.z_index + 2 })
                        }
                      >
                        <ArrowUp size={10} />
                      </button>
                      <button
                        type="button"
                        className="btn-icon btn-xs"
                        title={t('builder.zOrderBackward')}
                        onClick={() =>
                          updateSlot(selectedSlot.slot_id, { z_index: selectedSlot.z_index - 2 })
                        }
                      >
                        <ArrowDown size={10} />
                      </button>
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <ToggleSwitch
                    label={t('builder.partVisible')}
                    checked={selectedSlot.visible}
                    onChange={(v) => updateSlot(selectedSlot.slot_id, { visible: v })}
                  />
                  <ToggleSwitch
                    label={t('builder.partLocked')}
                    checked={Boolean(selectedSlot.locked)}
                    onChange={(v) => updateSlot(selectedSlot.slot_id, { locked: v })}
                  />
                </div>
              </CollapsibleSection>

              {/* Pro Transform Section */}
              <CollapsibleSection title={t('builder.partTransform')} defaultOpen>
                <Vector2Control
                  label={t('inspector.position')}
                  x={selectedSlot.default_transform.x}
                  y={selectedSlot.default_transform.y}
                  unit="px"
                  precision={1}
                  disabled={Boolean(selectedSlot.locked)}
                  onChangeX={(v) =>
                    updateSlot(selectedSlot.slot_id, {
                      default_transform: { ...selectedSlot.default_transform, x: v },
                    })
                  }
                  onChangeY={(v) =>
                    updateSlot(selectedSlot.slot_id, {
                      default_transform: { ...selectedSlot.default_transform, y: v },
                    })
                  }
                  onReset={() =>
                    updateSlot(selectedSlot.slot_id, {
                      default_transform: { ...selectedSlot.default_transform, x: 0, y: 0 },
                    })
                  }
                />

                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <NumericInput
                    label={t('rig.rotationDeg')}
                    shortTag="R"
                    value={selectedSlot.default_transform.rotation_deg}
                    step={1}
                    unit="°"
                    precision={1}
                    disabled={Boolean(selectedSlot.locked)}
                    onChange={(v) =>
                      updateSlot(selectedSlot.slot_id, {
                        default_transform: { ...selectedSlot.default_transform, rotation_deg: v },
                      })
                    }
                    onReset={() =>
                      updateSlot(selectedSlot.slot_id, {
                        default_transform: { ...selectedSlot.default_transform, rotation_deg: 0 },
                      })
                    }
                  />
                  {/* Quick interactive pivot rotation test slider (-180..180) */}
                  <PropertySlider
                    value={Math.max(-180, Math.min(180, selectedSlot.default_transform.rotation_deg))}
                    min={-180}
                    max={180}
                    step={1}
                    disabled={Boolean(selectedSlot.locked)}
                    onChange={(v) =>
                      updateSlot(selectedSlot.slot_id, {
                        default_transform: { ...selectedSlot.default_transform, rotation_deg: v },
                      })
                    }
                  />
                </div>

                <Vector2Control
                  label={t('inspector.scale')}
                  xTag="SX"
                  yTag="SY"
                  x={selectedSlot.default_transform.scale_x}
                  y={selectedSlot.default_transform.scale_y}
                  step={0.05}
                  min={0.05}
                  max={10}
                  unit="x"
                  precision={2}
                  disabled={Boolean(selectedSlot.locked)}
                  aspectLocked={scaleAspectLocked}
                  onToggleAspectLock={() => setScaleAspectLocked((v) => !v)}
                  onChangeX={(v) => {
                    const ratio =
                      selectedSlot.default_transform.scale_x !== 0
                        ? v / selectedSlot.default_transform.scale_x
                        : 1;
                    updateSlot(selectedSlot.slot_id, {
                      default_transform: {
                        ...selectedSlot.default_transform,
                        scale_x: v,
                        scale_y: scaleAspectLocked
                          ? round2(Math.max(0.05, Math.min(10, selectedSlot.default_transform.scale_y * ratio)))
                          : selectedSlot.default_transform.scale_y,
                      },
                    });
                  }}
                  onChangeY={(v) => {
                    const ratio =
                      selectedSlot.default_transform.scale_y !== 0
                        ? v / selectedSlot.default_transform.scale_y
                        : 1;
                    updateSlot(selectedSlot.slot_id, {
                      default_transform: {
                        ...selectedSlot.default_transform,
                        scale_y: v,
                        scale_x: scaleAspectLocked
                          ? round2(Math.max(0.05, Math.min(10, selectedSlot.default_transform.scale_x * ratio)))
                          : selectedSlot.default_transform.scale_x,
                      },
                    });
                  }}
                  onReset={() =>
                    updateSlot(selectedSlot.slot_id, {
                      default_transform: { ...selectedSlot.default_transform, scale_x: 1, scale_y: 1 },
                    })
                  }
                />

                <SliderWithInput
                  label={t('inspector.opacity')}
                  value={Math.round(selectedSlot.default_transform.opacity * 100)}
                  min={0}
                  max={100}
                  step={1}
                  precision={0}
                  unit="%"
                  disabled={Boolean(selectedSlot.locked)}
                  onChange={(pct) =>
                    updateSlot(selectedSlot.slot_id, {
                      default_transform: {
                        ...selectedSlot.default_transform,
                        opacity: Math.max(0, Math.min(1, pct / 100)),
                      },
                    })
                  }
                />
              </CollapsibleSection>

              {/* Joint Pivot Point Section */}
              <CollapsibleSection title={t('builder.pivotSection')} icon={<Crosshair size={11} color="#f59e0b" />} defaultOpen>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.4 }}>
                  {t('builder.pivotHint')}
                </div>
                <Vector2Control
                  label={t('inspector.pivot')}
                  xTag="AX"
                  yTag="AY"
                  x={selectedSlot.anchor_x}
                  y={selectedSlot.anchor_y}
                  step={0.02}
                  min={0}
                  max={1}
                  precision={2}
                  disabled={Boolean(selectedSlot.locked)}
                  onChangeX={(v) => handleMovePivot(selectedSlot.slot_id, v, selectedSlot.anchor_y)}
                  onChangeY={(v) => handleMovePivot(selectedSlot.slot_id, selectedSlot.anchor_x, v)}
                  onReset={() => {
                    const defPiv = getDefaultPivotForRole(selectedSlot.part_role);
                    handleMovePivot(selectedSlot.slot_id, defPiv.anchor_x, defPiv.anchor_y);
                  }}
                />
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                    fontSize: 10,
                    color: 'var(--text-secondary)',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={keepVisualOnPivot}
                    onChange={(e) => setKeepVisualOnPivot(e.target.checked)}
                  />
                  {t('builder.keepVisualPos')}
                </label>

                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn-xs"
                    disabled={Boolean(selectedSlot.locked)}
                    onClick={() => handleMovePivot(selectedSlot.slot_id, 0.5, 0.12)}
                  >
                    {t('builder.pivotPresetTop')}
                  </button>
                  <button
                    type="button"
                    className="btn-xs"
                    disabled={Boolean(selectedSlot.locked)}
                    onClick={() => handleMovePivot(selectedSlot.slot_id, 0.5, 0.5)}
                  >
                    {t('builder.pivotPresetCenter')}
                  </button>
                  <button
                    type="button"
                    className="btn-xs"
                    disabled={Boolean(selectedSlot.locked)}
                    onClick={() => handleMovePivot(selectedSlot.slot_id, 0.5, 0.88)}
                  >
                    {t('builder.pivotPresetBottom')}
                  </button>
                  <button
                    type="button"
                    className="btn-xs"
                    disabled={Boolean(selectedSlot.locked)}
                    onClick={() => handleMovePivot(selectedSlot.slot_id, 0.12, 0.5)}
                  >
                    {t('builder.pivotPresetLeft')}
                  </button>
                  <button
                    type="button"
                    className="btn-xs"
                    disabled={Boolean(selectedSlot.locked)}
                    onClick={() => handleMovePivot(selectedSlot.slot_id, 0.88, 0.5)}
                  >
                    {t('builder.pivotPresetRight')}
                  </button>
                </div>
              </CollapsibleSection>

              {/* Sprite Variants (Eye / Mouth / Swaps) */}
              <CollapsibleSection
                title={t('rig.variantsTitle')}
                badge={Object.keys(selectedSlot.variants).length}
                defaultOpen={selectedSlot.part_role === 'eyes' || selectedSlot.part_role === 'mouth'}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {Object.entries(selectedSlot.variants).map(([vKey, assetId]) => (
                    <div key={vKey} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      <span className="tag-pill mono" style={{ minWidth: 56 }}>
                        {vKey}
                      </span>
                      <select
                        value={assetId}
                        style={{ flex: 1, minWidth: 0, fontSize: 11 }}
                        onChange={(e) =>
                          updateSlot(selectedSlot.slot_id, {
                            variants: { ...selectedSlot.variants, [vKey]: e.target.value },
                          })
                        }
                      >
                        {partAssets.map((a) => (
                          <option key={a.asset_id} value={a.asset_id}>
                            {a.name}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="btn-ghost btn-icon btn-xs"
                        aria-label={t('common.delete')}
                        onClick={() => {
                          const next = { ...selectedSlot.variants };
                          delete next[vKey];
                          updateSlot(selectedSlot.slot_id, { variants: next });
                        }}
                      >
                        <Trash2 size={10} />
                      </button>
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                  <input
                    placeholder={t('rig.variantPlaceholder')}
                    value={newVariantKey}
                    onChange={(e) => setNewVariantKey(e.target.value)}
                    style={{ flex: 1, minWidth: 0 }}
                  />
                  <button
                    type="button"
                    className="btn-xs"
                    disabled={!newVariantKey.trim() || partAssets.length === 0}
                    onClick={() => {
                      const key = newVariantKey.trim().toLowerCase();
                      if (!key || partAssets.length === 0) return;
                      updateSlot(selectedSlot.slot_id, {
                        variants: {
                          ...selectedSlot.variants,
                          [key]: selectedSlot.default_asset_id ?? partAssets[0].asset_id,
                        },
                      });
                      setNewVariantKey('');
                    }}
                  >
                    <Plus size={10} /> {t('rig.addVariant')}
                  </button>
                </div>
              </CollapsibleSection>
            </>
          ) : (
            <EmptyState
              title={t('builder.rigGuidanceTitle')}
              description={t('builder.rigGuidanceBody')}
            />
          )}

          {/* Expression Presets (Collapsible) */}
          <CollapsibleSection
            title={t('rig.expressionsTitle', { count: draft.expressions.length })}
            defaultOpen={false}
          >
            <div style={{ display: 'flex', gap: 4 }}>
              <input
                placeholder={t('rig.newExprPlaceholder')}
                value={newExprName}
                onChange={(e) => setNewExprName(e.target.value)}
                style={{ flex: 1, minWidth: 0 }}
              />
              <button type="button" className="btn-xs" disabled={!newExprName.trim()} onClick={addExpression}>
                <Plus size={10} /> {t('common.add')}
              </button>
            </div>
            {draft.expressions.map((expr) => (
              <div key={expr.expression_id} className="list-card" style={{ padding: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <strong style={{ fontSize: 11 }}>{expr.name}</strong>
                  <button
                    type="button"
                    className="btn-ghost btn-icon btn-xs"
                    aria-label={t('common.delete')}
                    onClick={() =>
                      mutateDraft((prev) => ({
                        ...prev,
                        expressions: prev.expressions.filter(
                          (e) => e.expression_id !== expr.expression_id,
                        ),
                      }))
                    }
                  >
                    <Trash2 size={10} />
                  </button>
                </div>
                {draft.parts
                  .filter((p) => Object.keys(p.variants).length > 0)
                  .map((p) => (
                    <div key={p.slot_id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 10, color: 'var(--text-secondary)', width: 64 }}>
                        {p.name}:
                      </span>
                      <select
                        style={{ flex: 1, fontSize: 10 }}
                        value={expr.slot_variant_overrides[p.slot_id] ?? ''}
                        onChange={(e) => {
                          const val = e.target.value;
                          mutateDraft((prev) => ({
                            ...prev,
                            expressions: prev.expressions.map((ex) => {
                              if (ex.expression_id !== expr.expression_id) return ex;
                              const nextOv = { ...ex.slot_variant_overrides };
                              if (val) nextOv[p.slot_id] = val;
                              else delete nextOv[p.slot_id];
                              return { ...ex, slot_variant_overrides: nextOv };
                            }),
                          }));
                        }}
                      >
                        <option value="">{t('common.default')}</option>
                        {Object.keys(p.variants).map((vk) => (
                          <option key={vk} value={vk}>
                            {vk}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
              </div>
            ))}
          </CollapsibleSection>

          {/* Beginner Assembly & Pivot Guide */}
          <CollapsibleSection title={t('builder.rigGuidanceTitle')} defaultOpen={false}>
            <div style={{ fontSize: 10, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              {t('builder.rigGuidanceBody')}
            </div>
          </CollapsibleSection>
        </div>
      </div>
    </div>
  );
}
