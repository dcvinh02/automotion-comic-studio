import { Container, Graphics, Sprite, Text, TextStyle, Texture } from 'pixi.js';
import type { EvaluatedCharacter, EvaluatedPart, EvaluatedStage } from '@/engine/evaluator';
import { getActiveSubtitlesAtMs, resolveEffectiveSubtitleStyle } from '@/engine/subtitleEngine';
import type { SubtitleDocument, SubtitleSegment, SubtitleStyle } from '@/types/models';
import type { AssetTextureCache } from './textureCache';

type Mat2D = [number, number, number, number, number, number];

function composeMat(x: number, y: number, rotDeg: number, sx: number, sy: number): Mat2D {
  const rad = (rotDeg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [c * sx, s * sx, -s * sy, c * sy, x, y];
}

function mulMat(m1: Mat2D, m2: Mat2D): Mat2D {
  const [a1, b1, c1, d1, tx1, ty1] = m1;
  const [a2, b2, c2, d2, tx2, ty2] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * tx2 + c1 * ty2 + tx1,
    b1 * tx2 + d1 * ty2 + ty1,
  ];
}

function decomposeMat(m: Mat2D): { x: number; y: number; rotRad: number; sx: number; sy: number } {
  const [a, b, c, d, tx, ty] = m;
  const sx = Math.hypot(a, b);
  const det = a * d - b * c;
  const sy = (det < 0 ? -1 : 1) * Math.hypot(c, d);
  const rotRad = Math.atan2(b, a);
  return { x: tx, y: ty, rotRad, sx, sy };
}

function parseHexToInt(hex: string): number {
  const clean = hex.replace('#', '');
  const parsed = parseInt(clean, 16);
  return Number.isFinite(parsed) ? parsed : 0x101216;
}

export interface RenderedBounds {
  type: 'character' | 'prop';
  id: string;
  x: number;
  y: number;
  boxCenterX: number;
  boxCenterY: number;
  width: number;
  height: number;
  rotationDeg: number;
}

/**
 * Pooled PixiJS v8 Scene Graph renderer shared by interactive Stage Preview
 * and the Offscreen WebGL Chunk Renderer.
 * Reuses Pixi Container/Sprite display nodes across frames (zero per-frame GC churn).
 */
export class PixiSceneGraph {
  readonly root = new Container();
  readonly worldContainer = new Container();
  private readonly bgFill = new Graphics();
  private readonly fadeCurtain = new Graphics();
  private readonly subtitleLayer = new Container();
  private lastSubtitleSig = '';
  private readonly textureCache: AssetTextureCache;
  /** Asset IDs requested by the frame currently being rendered (protected from eviction). */
  private texturesInUse = new Set<string>();
  private stageWidth: number;
  private stageHeight: number;
  private onTextureLoaded?: () => void;

  // Persistent pooled display nodes keyed by stable IDs
  private bgSprite: Sprite | null = null;
  private propSprites = new Map<string, Sprite>();
  private charContainers = new Map<string, Container>();
  private charPartSprites = new Map<string, Sprite>();
  private charPlaceholders = new Map<string, Graphics>();

  constructor(
    textureCache: AssetTextureCache,
    stageWidth: number,
    stageHeight: number,
    onTextureLoaded?: () => void,
  ) {
    this.textureCache = textureCache;
    this.stageWidth = stageWidth;
    this.stageHeight = stageHeight;
    this.onTextureLoaded = onTextureLoaded;

    this.worldContainer.sortableChildren = true;
    this.root.addChild(this.bgFill);
    this.root.addChild(this.worldContainer);
    this.root.addChild(this.fadeCurtain);
    this.root.addChild(this.subtitleLayer);
  }

  setStageSize(width: number, height: number): void {
    this.stageWidth = width;
    this.stageHeight = height;
  }

  renderEvaluatedStage(
    evaluated: EvaluatedStage,
    getAssetUrl: (assetId: string) => string,
  ): RenderedBounds[] {
    const bounds: RenderedBounds[] = [];
    const scene = evaluated.scene;

    // Base background fill (honors isolated shot background color)
    this.bgFill.clear();
    this.bgFill
      .rect(0, 0, this.stageWidth, this.stageHeight)
      .fill(parseHexToInt(evaluated.effectiveBackgroundColor || scene?.background_color || '#101216'));

    if (!scene) {
      this.hideAllNodes();
      this.fadeCurtain.clear();
      return bounds;
    }

    // Apply Scene Camera Zoom / Pan / Rotation to worldContainer
    const cx = this.stageWidth / 2;
    const cy = this.stageHeight / 2;
    this.worldContainer.position.set(cx, cy);
    this.worldContainer.pivot.set(cx + evaluated.camera.x, cy + evaluated.camera.y);
    this.worldContainer.scale.set(evaluated.camera.zoom, evaluated.camera.zoom);
    this.worldContainer.rotation = (-evaluated.camera.rotation_deg * Math.PI) / 180;

    // 1. Background Sprite (pooled — honors isolated per-shot background_asset_id!)
    const bgAssetId = evaluated.effectiveBackgroundAssetId ?? scene.background_asset_id;
    if (bgAssetId) {
      const tex = this.getOrLoadTexture(bgAssetId, getAssetUrl);
      if (tex) {
        if (!this.bgSprite) {
          this.bgSprite = new Sprite(tex);
          this.bgSprite.zIndex = -10000;
          this.worldContainer.addChild(this.bgSprite);
        } else if (this.bgSprite.texture !== tex) {
          this.bgSprite.texture = tex;
        }
        this.bgSprite.visible = true;
        this.bgSprite.anchor.set(0.5, 0.5);
        this.bgSprite.position.set(cx, cy);
        this.bgSprite.width = this.stageWidth;
        this.bgSprite.height = this.stageHeight;
      } else if (this.bgSprite) {
        this.bgSprite.visible = false;
      }
    } else if (this.bgSprite) {
      this.bgSprite.visible = false;
    }

    // 2. Props (pooled by prop_instance_id; empty layers with null asset_id skip sprite draw cleanly)
    const activePropIds = new Set<string>();
    for (const prop of evaluated.props) {
      activePropIds.add(prop.prop_instance_id);
      const tex =
        prop.visible && prop.asset_id
          ? this.getOrLoadTexture(prop.asset_id, getAssetUrl)
          : null;
      let sp = this.propSprites.get(prop.prop_instance_id);
      if (!tex) {
        if (sp) sp.visible = false;
        continue;
      }
      if (!sp) {
        sp = new Sprite(tex);
        this.propSprites.set(prop.prop_instance_id, sp);
        this.worldContainer.addChild(sp);
      } else if (sp.texture !== tex) {
        sp.texture = tex;
      }
      sp.visible = true;
      sp.zIndex = prop.z_index;
      sp.anchor.set(prop.anchor_x, prop.anchor_y);
      sp.position.set(prop.transform.x, prop.transform.y);
      sp.rotation = (prop.transform.rotation_deg * Math.PI) / 180;
      sp.scale.set(prop.transform.scale_x, prop.transform.scale_y);
      sp.alpha = prop.transform.opacity;

      const w = Math.abs(tex.width * prop.transform.scale_x);
      const h = Math.abs(tex.height * prop.transform.scale_y);
      const localOffX = (0.5 - prop.anchor_x) * tex.width * prop.transform.scale_x;
      const localOffY = (0.5 - prop.anchor_y) * tex.height * prop.transform.scale_y;
      const rad = sp.rotation;
      bounds.push({
        type: 'prop',
        id: prop.prop_instance_id,
        x: prop.transform.x,
        y: prop.transform.y,
        boxCenterX: prop.transform.x + localOffX * Math.cos(rad) - localOffY * Math.sin(rad),
        boxCenterY: prop.transform.y + localOffX * Math.sin(rad) + localOffY * Math.cos(rad),
        width: Math.max(40, w),
        height: Math.max(40, h),
        rotationDeg: prop.transform.rotation_deg,
      });
    }

    // Prune removed props
    for (const [id, sp] of this.propSprites.entries()) {
      if (!activePropIds.has(id)) {
        this.worldContainer.removeChild(sp);
        sp.destroy();
        this.propSprites.delete(id);
      }
    }

    // 3. Characters & Cutout Parts (pooled by instance_id & slot_id)
    const activeCharIds = new Set<string>();
    const activePartKeys = new Set<string>();

    for (const ch of evaluated.characters) {
      activeCharIds.add(ch.instance_id);
      if (!ch.visible) {
        const existingContainer = this.charContainers.get(ch.instance_id);
        if (existingContainer) existingContainer.visible = false;
        continue;
      }
      const b = this.renderCharacter(ch, getAssetUrl, activePartKeys);
      bounds.push(b);
    }

    for (const [key, sp] of this.charPartSprites.entries()) {
      if (!activePartKeys.has(key)) {
        sp.parent?.removeChild(sp);
        sp.destroy();
        this.charPartSprites.delete(key);
      }
    }

    for (const [cid, container] of this.charContainers.entries()) {
      if (!activeCharIds.has(cid)) {
        this.worldContainer.removeChild(container);
        container.destroy({ children: true });
        this.charContainers.delete(cid);
        this.charPlaceholders.delete(cid);
      }
    }

    this.worldContainer.sortChildren();
    // Phase 09.2: bounded texture memory — only textures not used by this frame can be evicted.
    // Pooled sprites that are hidden still point at their texture, so detach them first.
    const evicted = this.textureCache.evictUnused(this.texturesInUse);
    if (evicted.length > 0) this.detachEvictedTextures(new Set(evicted));
    this.texturesInUse = new Set();

    // Sort bounds by z_index so hit-testing prefers topmost layer
    const zLookup = new Map<string, number>();
    for (const p of evaluated.props) zLookup.set(p.prop_instance_id, p.z_index);
    for (const c of evaluated.characters) zLookup.set(c.instance_id, c.z_index);
    bounds.sort((a, b) => (zLookup.get(a.id) ?? 0) - (zLookup.get(b.id) ?? 0));

    // 4. Scene Transition Fade Overlay
    this.fadeCurtain.clear();
    if (evaluated.fadeAlpha < 0.999) {
      this.fadeCurtain
        .rect(0, 0, this.stageWidth, this.stageHeight)
        .fill({ color: 0x000000, alpha: 1 - evaluated.fadeAlpha });
    }

    return bounds;
  }

  private renderCharacter(
    ch: EvaluatedCharacter,
    getAssetUrl: (assetId: string) => string,
    activePartKeys: Set<string>,
  ): RenderedBounds {
    let charContainer = this.charContainers.get(ch.instance_id);
    if (!charContainer) {
      charContainer = new Container();
      charContainer.sortableChildren = true;
      this.charContainers.set(ch.instance_id, charContainer);
      this.worldContainer.addChild(charContainer);
    }

    charContainer.visible = true;
    charContainer.zIndex = ch.z_index;
    charContainer.position.set(ch.transform.x, ch.transform.y);
    charContainer.rotation = (ch.transform.rotation_deg * Math.PI) / 180;
    charContainer.scale.set(ch.transform.scale_x, ch.transform.scale_y);
    charContainer.alpha = ch.transform.opacity;

    const partsById = new Map<string, EvaluatedPart>(ch.parts.map((p) => [p.slot_id, p]));
    const localMats = new Map<string, Mat2D>();

    const computeCharSpaceMat = (slotId: string, visited = new Set<string>()): Mat2D => {
      const cached = localMats.get(slotId);
      if (cached) return cached;
      const part = partsById.get(slotId);
      if (!part) return [1, 0, 0, 1, 0, 0];
      const own = composeMat(
        part.transform.x,
        part.transform.y,
        part.transform.rotation_deg,
        part.transform.scale_x,
        part.transform.scale_y,
      );
      if (visited.has(slotId)) return own;
      visited.add(slotId);
      const parentMat =
        part.parent_slot_id && partsById.has(part.parent_slot_id)
          ? computeCharSpaceMat(part.parent_slot_id, visited)
          : ([1, 0, 0, 1, 0, 0] as Mat2D);
      const combined = mulMat(parentMat, own);
      localMats.set(slotId, combined);
      return combined;
    };

    let minX = -80;
    let maxX = 80;
    let minY = -120;
    let maxY = 120;
    let hasSprite = false;

    for (const part of ch.parts) {
      const partKey = `${ch.instance_id}:${part.slot_id}`;
      activePartKeys.add(partKey);
      let sp = this.charPartSprites.get(partKey);

      if (!part.visible || !part.asset_id) {
        if (sp) sp.visible = false;
        continue;
      }
      const tex = this.getOrLoadTexture(part.asset_id, getAssetUrl);
      if (!tex) {
        if (sp) sp.visible = false;
        continue;
      }

      if (!sp) {
        sp = new Sprite(tex);
        this.charPartSprites.set(partKey, sp);
        charContainer.addChild(sp);
      } else if (sp.texture !== tex) {
        sp.texture = tex;
      }

      const mat = computeCharSpaceMat(part.slot_id);
      const dec = decomposeMat(mat);

      sp.visible = true;
      sp.zIndex = part.z_index;
      sp.anchor.set(part.anchor_x, part.anchor_y);
      sp.position.set(dec.x, dec.y);
      sp.rotation = dec.rotRad;
      sp.scale.set(dec.sx, dec.sy);
      sp.alpha = part.transform.opacity;

      const w = Math.abs(tex.width * dec.sx);
      const h = Math.abs(tex.height * dec.sy);
      const left = dec.x - w * part.anchor_x;
      const right = left + w;
      const top = dec.y - h * part.anchor_y;
      const bottom = top + h;
      if (!hasSprite) {
        minX = left;
        maxX = right;
        minY = top;
        maxY = bottom;
        hasSprite = true;
      } else {
        minX = Math.min(minX, left);
        maxX = Math.max(maxX, right);
        minY = Math.min(minY, top);
        maxY = Math.max(maxY, bottom);
      }
    }

    charContainer.sortChildren();

    let ph = this.charPlaceholders.get(ch.instance_id);
    if (!hasSprite) {
      if (!ph) {
        ph = new Graphics();
        ph.rect(-60, -100, 120, 200).stroke({ color: 0x7c6cf6, width: 2 });
        this.charPlaceholders.set(ch.instance_id, ph);
        charContainer.addChild(ph);
      }
      ph.visible = true;
    } else if (ph) {
      ph.visible = false;
    }

    const localMidX = ((minX + maxX) / 2) * ch.transform.scale_x;
    const localMidY = ((minY + maxY) / 2) * ch.transform.scale_y;
    const rad = (ch.transform.rotation_deg * Math.PI) / 180;
    const boxCenterX = ch.transform.x + localMidX * Math.cos(rad) - localMidY * Math.sin(rad);
    const boxCenterY = ch.transform.y + localMidX * Math.sin(rad) + localMidY * Math.cos(rad);

    return {
      type: 'character',
      id: ch.instance_id,
      x: ch.transform.x,
      y: ch.transform.y,
      boxCenterX,
      boxCenterY,
      width: Math.max(80, (maxX - minX) * Math.abs(ch.transform.scale_x)),
      height: Math.max(100, (maxY - minY) * Math.abs(ch.transform.scale_y)),
      rotationDeg: ch.transform.rotation_deg,
    };
  }

  renderSubtitles(
    subtitles: SubtitleDocument | undefined | null,
    timeMs: number,
    visible = true,
  ): void {
    const active = getActiveSubtitlesAtMs(subtitles, timeMs, visible);
    if (active.length === 0 || !subtitles) {
      if (this.lastSubtitleSig !== '') {
        for (const child of this.subtitleLayer.removeChildren()) {
          child.destroy({ children: true });
        }
        this.lastSubtitleSig = '';
      }
      return;
    }

    const entries: Array<{ seg: SubtitleSegment; style: Required<SubtitleStyle>; pos: 'bottom' | 'center' | 'top' }> =
      active.map((seg) => {
        const style = resolveEffectiveSubtitleStyle(subtitles, seg);
        return { seg, style, pos: style.position };
      });

    const sig = JSON.stringify({
      w: this.stageWidth,
      h: this.stageHeight,
      items: entries.map((e) => ({
        id: e.seg.subtitle_id,
        t: e.seg.text,
        pos: e.pos,
        st: e.style,
      })),
    });
    if (sig === this.lastSubtitleSig) return;
    this.lastSubtitleSig = sig;

    for (const child of this.subtitleLayer.removeChildren()) {
      child.destroy({ children: true });
    }

    const scaleY = this.stageHeight / 1080;
    const scaleX = this.stageWidth / 1920;
    const safeX = Math.round(this.stageWidth * 0.05);
    const safeY = Math.round(this.stageHeight * 0.05);

    const byPos: Record<'bottom' | 'center' | 'top', typeof entries> = {
      bottom: [],
      center: [],
      top: [],
    };
    for (const item of entries) {
      byPos[item.pos].push(item);
    }

    const weightMap: Record<SubtitleStyle['font_weight'], '400' | '600' | '700' | '800'> = {
      normal: '400',
      semibold: '600',
      bold: '700',
      extrabold: '800',
    };

    for (const pos of ['bottom', 'center', 'top'] as const) {
      const list = pos === 'bottom' ? [...byPos[pos]].reverse() : byPos[pos];
      let stackOffset = 0;

      for (const { seg, style } of list) {
        const fontSize = Math.max(12, Math.round(style.font_size * scaleY));
        const maxWidth = Math.max(100, Math.round(this.stageWidth * (style.max_width_pct / 100)));
        const outlineWidth = Math.max(0, style.outline_width * scaleY);
        const lineHeight = Math.round(fontSize * style.line_spacing);
        const letterSpacing = (style.letter_spacing ?? 0) * scaleX;

        const pixiStyle = new TextStyle({
          fontFamily: style.font_family || "Inter, 'Noto Sans', Arial, sans-serif",
          fontSize,
          fontWeight: weightMap[style.font_weight] ?? '700',
          fontStyle: style.italic ? 'italic' : 'normal',
          letterSpacing,
          fill: style.text_color || '#ffffff',
          align: style.alignment,
          wordWrap: style.word_wrap,
          wordWrapWidth: maxWidth,
          breakWords: true,
          lineHeight,
          stroke:
            outlineWidth > 0.05
              ? {
                  color: style.outline_color || '#000000',
                  width: outlineWidth * 2,
                  join: 'round',
                }
              : undefined,
          dropShadow: style.shadow_enabled
            ? {
                color: style.shadow_color || '#000000',
                alpha: Math.max(0, Math.min(1, style.shadow_opacity ?? 0.78)),
                blur: Math.max(0, style.shadow_blur * scaleY),
                distance: Math.hypot(style.shadow_offset_x * scaleX, style.shadow_offset_y * scaleY),
                angle: Math.atan2(style.shadow_offset_y || 2, style.shadow_offset_x || 0),
              }
            : undefined,
        });

        const textNode = new Text({ text: seg.text, style: pixiStyle });
        const textW = Math.min(maxWidth, Math.ceil(textNode.width));
        const textH = Math.ceil(textNode.height);
        const padX = Math.max(0, Math.round((style.background_padding_x ?? 18) * scaleX));
        const padY = Math.max(0, Math.round((style.background_padding_y ?? 10) * scaleY));
        const marginX = Math.round(style.margin_x * scaleX);
        const marginY = Math.round(style.margin_y * scaleY);
        const minBoxH = style.box_height_px > 0 ? Math.round(style.box_height_px * scaleY) : 0;
        const boxW = textW + padX * 2;
        const boxH = Math.max(textH + padY * 2, minBoxH);

        let boxX: number;
        if (style.alignment === 'left') {
          boxX = marginX;
        } else if (style.alignment === 'right') {
          boxX = Math.max(marginX, this.stageWidth - marginX - boxW);
        } else {
          boxX = Math.round((this.stageWidth - boxW) / 2);
        }

        let boxY: number;
        if (pos === 'top') {
          boxY = marginY + stackOffset;
        } else if (pos === 'center') {
          boxY = Math.round((this.stageHeight - boxH) / 2) + stackOffset;
        } else {
          boxY = this.stageHeight - marginY - boxH - stackOffset;
        }

        boxX += Math.round((style.offset_x ?? 0) * scaleX);
        boxY += Math.round((style.offset_y ?? 0) * scaleY);

        if (style.safe_area_clamp !== false) {
          boxX = Math.max(safeX, Math.min(this.stageWidth - safeX - boxW, boxX));
          boxY = Math.max(safeY, Math.min(this.stageHeight - safeY - boxH, boxY));
        }

        const itemContainer = new Container();
        if (style.background_enabled && style.background_opacity > 0.01) {
          const bg = new Graphics();
          bg.roundRect(boxX, boxY, boxW, boxH, Math.max(4, Math.round(10 * scaleY))).fill({
            color: parseHexToInt(style.background_color || '#090b10'),
            alpha: Math.max(0, Math.min(1, style.background_opacity)),
          });
          itemContainer.addChild(bg);
        }

        const vCenterExtra = Math.max(0, Math.round((boxH - (textH + padY * 2)) / 2));
        const textPosX = boxX + padX;
        const textPosY = boxY + padY + vCenterExtra;
        textNode.position.set(textPosX, textPosY);
        itemContainer.addChild(textNode);

        if (style.underline && textW > 0) {
          const ul = new Graphics();
          const lineCount = Math.max(1, Math.round(textH / Math.max(1, lineHeight)));
          const thickness = Math.max(1.5, 2.2 * scaleY);
          for (let li = 0; li < lineCount; li++) {
            const uy = textPosY + li * lineHeight + fontSize + Math.max(1, Math.round(2 * scaleY));
            ul.rect(textPosX, uy, textW, thickness).fill({
              color: parseHexToInt(style.text_color || '#ffffff'),
              alpha: 0.95,
            });
          }
          itemContainer.addChild(ul);
        }

        this.subtitleLayer.addChild(itemContainer);

        stackOffset += boxH + Math.max(8, Math.round(10 * scaleY));
      }
    }
  }

  private hideAllNodes(): void {
    if (this.bgSprite) this.bgSprite.visible = false;
    for (const sp of this.propSprites.values()) sp.visible = false;
    for (const c of this.charContainers.values()) c.visible = false;
  }

  private getOrLoadTexture(assetId: string, getAssetUrl: (assetId: string) => string): Texture | null {
    this.texturesInUse.add(assetId);
    const sync = this.textureCache.getSync(assetId);
    if (sync) return sync;
    void this.textureCache.load(assetId, getAssetUrl(assetId)).then((loaded) => {
      if (loaded && this.onTextureLoaded) {
        this.onTextureLoaded();
      }
    });
    return null;
  }

  private detachEvictedTextures(evicted: Set<string>): void {
    // Hidden pooled sprites may still reference an evicted (destroyed) texture; drop those sprites
    // so they are recreated from a fresh texture if their object becomes visible again.
    for (const [id, sp] of [...this.propSprites.entries()]) {
      if (!sp.visible && (sp.texture as unknown as { destroyed?: boolean }).destroyed) {
        sp.parent?.removeChild(sp);
        sp.destroy();
        this.propSprites.delete(id);
      }
    }
    for (const [key, sp] of [...this.charPartSprites.entries()]) {
      if ((!sp.visible || !sp.parent?.visible) && (sp.texture as unknown as { destroyed?: boolean }).destroyed) {
        sp.parent?.removeChild(sp);
        sp.destroy();
        this.charPartSprites.delete(key);
      }
    }
    if (this.bgSprite && (this.bgSprite.texture as unknown as { destroyed?: boolean }).destroyed && !this.bgSprite.visible) {
      this.bgSprite.texture = Texture.EMPTY;
    }
    void evicted;
  }
}
