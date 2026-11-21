import { describe, expect, it } from 'vitest';
import type { Texture } from 'pixi.js';
import { AssetTextureCache } from './textureCache';

function fakeTex(w: number, h: number) {
  return { width: w, height: h, destroyed: false, destroy() { this.destroyed = true; } };
}

describe('AssetTextureCache bounded LRU (Phase 09.2)', () => {
  it('evicts least-recently-used unused textures until under budget, never in-use ones', () => {
    const MB = 1024 * 1024;
    const cache = new AssetTextureCache(3 * MB); // budget: three 1 MB textures (512×512×4)
    const texs: Record<string, ReturnType<typeof fakeTex>> = {};
    const internal = cache as unknown as { textures: Map<string, Texture> };
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      texs[id] = fakeTex(512, 512);
      internal.textures.set(id, texs[id] as unknown as Texture);
    }
    cache.getSync('a'); // 'a' becomes most recently used → LRU order is b, c, d, e, a
    const evicted = cache.evictUnused(new Set(['b']));
    expect(evicted).toEqual(['c', 'd']);
    expect(texs.c.destroyed && texs.d.destroyed).toBe(true);
    expect(texs.b.destroyed).toBe(false); // in use by the current frame
    expect(cache.size).toBe(3);
    expect(cache.totalBytes()).toBeLessThanOrEqual(3 * MB);
    expect(cache.evictUnused(new Set())).toEqual([]); // already within budget
  });

  it('keeps everything when the frame itself needs more than the budget', () => {
    const cache = new AssetTextureCache(1);
    const internal = cache as unknown as { textures: Map<string, Texture> };
    internal.textures.set('x', fakeTex(100, 100) as unknown as Texture);
    internal.textures.set('y', fakeTex(100, 100) as unknown as Texture);
    expect(cache.evictUnused(new Set(['x', 'y']))).toEqual([]);
    expect(cache.size).toBe(2);
  });
});
