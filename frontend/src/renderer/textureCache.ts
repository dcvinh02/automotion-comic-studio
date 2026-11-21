import { Texture } from 'pixi.js';

export class AssetTextureCache {
  private textures = new Map<string, Texture>();
  private loading = new Map<string, Promise<Texture | null>>();

  getSync(assetId: string): Texture | null {
    return this.textures.get(assetId) ?? null;
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
