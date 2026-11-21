import { Application, Graphics } from 'pixi.js';
import type { EvaluatedStage } from '@/engine/evaluator';
import type { SelectionState, SubtitleDocument } from '@/types/models';
import { PixiSceneGraph, type RenderedBounds } from './PixiSceneGraph';
import { AssetTextureCache } from './textureCache';

export interface StageOverlayOptions {
  showGizmos: boolean;
  showGrid: boolean;
  showSafeGuides: boolean;
  activeTool?: 'select' | 'move' | 'rotate' | 'scale' | 'pivot';
  selectionLocked?: boolean;
  subtitles?: SubtitleDocument | null;
  subtitlesVisible?: boolean;
}

export class PixiStageController {
  private app: Application | null = null;
  private sceneGraph: PixiSceneGraph | null = null;
  private overlay = new Graphics();
  private textureCache = new AssetTextureCache();
  private lastBounds: RenderedBounds[] = [];
  private stageWidth = 1920;
  private stageHeight = 1080;
  private destroyed = false;
  private onNeedsRedraw?: () => void;

  async mount(
    hostEl: HTMLElement,
    stageWidth: number,
    stageHeight: number,
    onNeedsRedraw: () => void,
  ): Promise<HTMLCanvasElement> {
    this.stageWidth = stageWidth;
    this.stageHeight = stageHeight;
    this.onNeedsRedraw = onNeedsRedraw;

    const app = new Application();
    await app.init({
      width: stageWidth,
      height: stageHeight,
      backgroundColor: 0x101216,
      antialias: true,
      autoDensity: false,
      resolution: 1,
      preserveDrawingBuffer: true,
      preference: 'webgl',
    });

    if (this.destroyed) {
      app.destroy(true, { children: true });
      throw new Error('Stage controller destroyed during init');
    }

    this.app = app;
    this.sceneGraph = new PixiSceneGraph(this.textureCache, stageWidth, stageHeight, () => {
      if (!this.destroyed) {
        this.onNeedsRedraw?.();
      }
    });

    app.stage.addChild(this.sceneGraph.root);
    app.stage.addChild(this.overlay);

    const canvas = app.canvas;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.objectFit = 'contain';
    canvas.style.display = 'block';
    canvas.style.boxShadow = '0 10px 36px rgba(0, 0, 0, 0.55)';
    hostEl.innerHTML = '';
    hostEl.appendChild(canvas);

    return canvas;
  }

  render(
    evaluated: EvaluatedStage,
    selection: SelectionState,
    options: StageOverlayOptions,
    getAssetUrl: (assetId: string) => string,
  ): void {
    if (!this.app || !this.sceneGraph || this.destroyed) return;
    if (
      evaluated.scene &&
      (this.stageWidth !== this.app.renderer.width || this.stageHeight !== this.app.renderer.height)
    ) {
      this.app.renderer.resize(this.stageWidth, this.stageHeight);
      this.sceneGraph.setStageSize(this.stageWidth, this.stageHeight);
    }

    this.lastBounds = this.sceneGraph.renderEvaluatedStage(evaluated, getAssetUrl);
    this.sceneGraph.renderSubtitles(
      options.subtitles,
      evaluated.timeMs,
      options.subtitlesVisible !== false,
    );
    this.drawOverlay(evaluated, selection, options);
    this.app.renderer.render(this.app.stage);
  }

  setStageDimensions(width: number, height: number): void {
    if (width === this.stageWidth && height === this.stageHeight) return;
    this.stageWidth = width;
    this.stageHeight = height;
    if (this.app && this.sceneGraph) {
      this.app.renderer.resize(width, height);
      this.sceneGraph.setStageSize(width, height);
    }
  }

  worldFromStagePoint(
    stageX: number,
    stageY: number,
    camera: EvaluatedStage['camera'],
  ): { x: number; y: number } {
    const cx = this.stageWidth / 2;
    const cy = this.stageHeight / 2;
    const dx = (stageX - cx) / Math.max(0.1, camera.zoom);
    const dy = (stageY - cy) / Math.max(0.1, camera.zoom);
    const rad = (camera.rotation_deg * Math.PI) / 180;
    const rx = dx * Math.cos(rad) - dy * Math.sin(rad);
    const ry = dx * Math.sin(rad) + dy * Math.cos(rad);
    return {
      x: rx + cx + camera.x,
      y: ry + cy + camera.y,
    };
  }

  stageFromWorldPoint(
    worldX: number,
    worldY: number,
    camera: EvaluatedStage['camera'],
  ): { x: number; y: number } {
    const cx = this.stageWidth / 2;
    const cy = this.stageHeight / 2;
    const dx = worldX - (cx + camera.x);
    const dy = worldY - (cy + camera.y);
    const rad = (-camera.rotation_deg * Math.PI) / 180;
    const rx = dx * Math.cos(rad) - dy * Math.sin(rad);
    const ry = dx * Math.sin(rad) + dy * Math.cos(rad);
    return {
      x: rx * camera.zoom + cx,
      y: ry * camera.zoom + cy,
    };
  }

  getBoundsById(id: string): RenderedBounds | null {
    return this.lastBounds.find((b) => b.id === id) ?? null;
  }

  hitTest(worldX: number, worldY: number): RenderedBounds | null {
    for (let i = this.lastBounds.length - 1; i >= 0; i--) {
      const b = this.lastBounds[i];
      const hw = Math.max(55, b.width / 2);
      const hh = Math.max(70, b.height / 2);
      if (
        worldX >= b.boxCenterX - hw &&
        worldX <= b.boxCenterX + hw &&
        worldY >= b.boxCenterY - hh &&
        worldY <= b.boxCenterY + hh
      ) {
        return b;
      }
    }
    return null;
  }

  hitTestHandle(
    stageX: number,
    stageY: number,
    selection: SelectionState,
    camera: EvaluatedStage['camera'],
  ): 'rotate' | 'scale' | null {
    if (selection.type !== 'character' && selection.type !== 'prop') return null;
    const b = this.lastBounds.find((item) => item.id === selection.id);
    if (!b) return null;
    const boxCenter = this.stageFromWorldPoint(b.boxCenterX, b.boxCenterY, camera);
    const hw = (b.width * camera.zoom) / 2;
    const hh = (b.height * camera.zoom) / 2;

    const rotPt = { x: boxCenter.x, y: boxCenter.y - hh - 30 };
    if (Math.hypot(stageX - rotPt.x, stageY - rotPt.y) <= 20) {
      return 'rotate';
    }
    const scalePt = { x: boxCenter.x + hw, y: boxCenter.y + hh };
    if (Math.hypot(stageX - scalePt.x, stageY - scalePt.y) <= 20) {
      return 'scale';
    }
    return null;
  }

  private drawOverlay(
    evaluated: EvaluatedStage,
    selection: SelectionState,
    options: StageOverlayOptions,
  ): void {
    this.overlay.clear();

    // 1. Composition Grid Overlay
    if (options.showGrid) {
      const step = Math.max(60, Math.round(this.stageWidth / 16));
      for (let x = step; x < this.stageWidth; x += step) {
        this.overlay.moveTo(x, 0).lineTo(x, this.stageHeight);
      }
      for (let y = step; y < this.stageHeight; y += step) {
        this.overlay.moveTo(0, y).lineTo(this.stageWidth, y);
      }
      this.overlay.stroke({ color: 0xffffff, width: 1, alpha: 0.08 });

      // Rule of thirds emphasis
      const thirdX1 = this.stageWidth / 3;
      const thirdX2 = (this.stageWidth * 2) / 3;
      const thirdY1 = this.stageHeight / 3;
      const thirdY2 = (this.stageHeight * 2) / 3;
      this.overlay
        .moveTo(thirdX1, 0).lineTo(thirdX1, this.stageHeight)
        .moveTo(thirdX2, 0).lineTo(thirdX2, this.stageHeight)
        .moveTo(0, thirdY1).lineTo(this.stageWidth, thirdY1)
        .moveTo(0, thirdY2).lineTo(this.stageWidth, thirdY2)
        .stroke({ color: 0x7c6cf6, width: 1, alpha: 0.22 });
    }

    // 2. Action-Safe (90%) & Title-Safe (80%) Broadcast/Comic Guides
    if (options.showSafeGuides) {
      const ax = this.stageWidth * 0.05;
      const ay = this.stageHeight * 0.05;
      this.overlay
        .rect(ax, ay, this.stageWidth * 0.9, this.stageHeight * 0.9)
        .stroke({ color: 0x94a3b8, width: 1.2, alpha: 0.3 });

      const tx = this.stageWidth * 0.1;
      const ty = this.stageHeight * 0.1;
      this.overlay
        .rect(tx, ty, this.stageWidth * 0.8, this.stageHeight * 0.8)
        .stroke({ color: 0x7c6cf6, width: 1.2, alpha: 0.28 });

      // Stage center crosshair
      const cx = this.stageWidth / 2;
      const cy = this.stageHeight / 2;
      this.overlay
        .moveTo(cx - 14, cy).lineTo(cx + 14, cy)
        .moveTo(cx, cy - 14).lineTo(cx, cy + 14)
        .stroke({ color: 0x94a3b8, width: 1, alpha: 0.35 });
    }

    // Outer frame border
    this.overlay
      .rect(1, 1, this.stageWidth - 2, this.stageHeight - 2)
      .stroke({ color: 0x3f4659, width: 2, alpha: 0.8 });

    if (!options.showGizmos) return;
    if (selection.type !== 'character' && selection.type !== 'prop') return;
    const b = this.lastBounds.find((item) => item.id === selection.id);
    if (!b) return;

    const pivot = this.stageFromWorldPoint(b.x, b.y, evaluated.camera);
    const boxCenter = this.stageFromWorldPoint(b.boxCenterX, b.boxCenterY, evaluated.camera);
    const hw = (b.width * evaluated.camera.zoom) / 2;
    const hh = (b.height * evaluated.camera.zoom) / 2;

    // Selection bounding box (amber outline without transform handles when locked; violet when editable)
    const isLocked = Boolean(options.selectionLocked);
    this.overlay
      .rect(boxCenter.x - hw, boxCenter.y - hh, hw * 2, hh * 2)
      .stroke({ color: isLocked ? 0xf59e0b : 0x7c6cf6, width: 2, alpha: isLocked ? 0.78 : 1 });

    // Rig pivot crosshair (amber at true transform origin; enlarged ring when Pivot tool is active)
    const isPivotMode = !isLocked && options.activeTool === 'pivot';
    const crossRadius = isPivotMode ? 16 : 10;
    this.overlay
      .moveTo(pivot.x - crossRadius, pivot.y)
      .lineTo(pivot.x + crossRadius, pivot.y)
      .moveTo(pivot.x, pivot.y - crossRadius)
      .lineTo(pivot.x, pivot.y + crossRadius)
      .stroke({ color: 0xf59e0b, width: isPivotMode ? 2.5 : 2 });
    if (isPivotMode) {
      this.overlay
        .circle(pivot.x, pivot.y, 12)
        .stroke({ color: 0xf59e0b, width: 2 });
    }

    if (isLocked) {
      // Visual lock indicator badge at top-right corner of bounding box; hide rotate/scale handles
      const bx = boxCenter.x + hw - 10;
      const by = boxCenter.y - hh + 10;
      this.overlay
        .rect(bx - 7, by - 5, 14, 11)
        .fill(0xf59e0b)
        .stroke({ color: 0x0b0c0f, width: 1.5 });
      return;
    }

    // Rotate stem + handle
    const isRotMode = options.activeTool === 'rotate';
    this.overlay
      .moveTo(boxCenter.x, boxCenter.y - hh)
      .lineTo(boxCenter.x, boxCenter.y - hh - 30)
      .stroke({ color: isRotMode ? 0xf59e0b : 0x7c6cf6, width: 2 });
    this.overlay
      .circle(boxCenter.x, boxCenter.y - hh - 30, isRotMode ? 10 : 8)
      .fill(isRotMode ? 0xf59e0b : 0x7c6cf6)
      .stroke({ color: 0xffffff, width: 2 });

    // Scale handle (bottom-right)
    const isScaleMode = options.activeTool === 'scale';
    const sh = isScaleMode ? 8 : 7;
    this.overlay
      .rect(boxCenter.x + hw - sh, boxCenter.y + hh - sh, sh * 2, sh * 2)
      .fill(isScaleMode ? 0xf59e0b : 0xffffff)
      .stroke({ color: 0x7c6cf6, width: 2 });
  }

  destroy(): void {
    this.destroyed = true;
    this.textureCache.destroyAll();
    if (this.app) {
      this.app.destroy(true, { children: true });
      this.app = null;
    }
    this.sceneGraph = null;
  }
}
