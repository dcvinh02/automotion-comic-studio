import { Texture } from 'pixi.js';

/** Default GPU texture budget (estimated as width × height × 4 bytes). */
export const DEFAULT_TEXTURE_BUDGET_BYTES = 384 * 1024 * 1024;

export class AssetTextureCache {
  // Map iteration order = least-recently-used first (entries are re-inserted on use)
  private textures = new Map<string, Texture>();
  private loading = new Map<string, Promise<Texture | null>>();

  constructor(private readonly budgetBytes = DEFAULT_TEXTURE_BUDGET_BYTES) {}

  getSync(assetId: string): Texture | null {
    const tex = this.textures.get(assetId);
    if (!tex) return null;
    this.textures.delete(assetId);
    this.textures.set(assetId, tex);
    return tex;
  }

  static estimateBytes(tex: Texture): number {
    return Math.max(1, Math.round(tex.width)) * Math.max(1, Math.round(tex.height)) * 4;
  }

  totalBytes(): number {
    let sum = 0;
    for (const t of this.textures.values()) sum += AssetTextureCache.estimateBytes(t);
    return sum;
  }

  get size(): number {
    return this.textures.size;
  }

  /**
   * Phase 09.2: the cache used to grow for the whole session (every asset ever shown stayed on the
   * GPU). Evict least-recently-used textures that are NOT used by the current frame until the
   * estimated total fits the budget. Textures in use are never destroyed.
   */
  evictUnused(inUse: ReadonlySet<string>): string[] {
    let total = this.totalBytes();
    if (total <= this.budgetBytes) return [];
    const evicted: string[] = [];
    for (const [id, tex] of [...this.textures.entries()]) {
      if (total <= this.budgetBytes) break;
      if (inUse.has(id)) continue;
      total -= AssetTextureCache.estimateBytes(tex);
      this.textures.delete(id);
      evicted.push(id);
      try {
        tex.destroy(true);
      } catch {
        // already destroyed
      }
    }
    return evicted;
  }

  async load(assetId: string, url: string): Promise<Texture | null> {
    const existing = this.textures.get(assetId);
    if (existing) return existing;

    const inflight = this.loading.get(assetId);
    if (inflight) return inflight;

    const promise = new Promise<Texture | null>((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const tex = Texture.from(img);
          this.textures.set(assetId, tex);
          resolve(tex);
        } catch {
          resolve(null);
        } finally {
          this.loading.delete(assetId);
        }
      };
      img.onerror = () => {
        this.loading.delete(assetId);
        resolve(null);
      };
      img.src = url;
    });

    this.loading.set(assetId, promise);
    return promise;
  }

  destroyAll(): void {
    for (const tex of this.textures.values()) {
      try {
        tex.destroy(true);
      } catch {
        // Ignore already destroyed
      }
    }
    this.textures.clear();
    this.loading.clear();
  }
}
