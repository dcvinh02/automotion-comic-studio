import { beforeEach, describe, expect, it } from 'vitest';
import en from '@/locales/en.json';
import vi from '@/locales/vi.json';
import { translate, useLocaleStore } from './useLocaleStore';

function installMemoryStorage() {
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => {
      map.set(k, String(v));
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });
}

describe('Bilingual Localization System (vi / en)', () => {
  beforeEach(() => {
    installMemoryStorage();
    useLocaleStore.getState().setLocale('vi');
  });

  it('has 100% key parity between en.json and vi.json with non-empty values', () => {
    const enKeys = Object.keys(en).sort();
    const viKeys = Object.keys(vi).sort();
    expect(viKeys).toEqual(enKeys);
    for (const k of enKeys) {
      expect((en as Record<string, string>)[k].trim().length).toBeGreaterThan(0);
      expect((vi as Record<string, string>)[k].trim().length).toBeGreaterThan(0);
    }
  });

  it('defaults to Vietnamese (vi) and translates core animation terms accurately', () => {
    expect(useLocaleStore.getState().locale).toBe('vi');
    expect(translate('vi', 'transport.play')).toBe('Phát');
    expect(translate('vi', 'transport.pause')).toBe('Tạm dừng');
    expect(translate('vi', 'transport.stop')).toBe('Dừng');
    expect(translate('vi', 'workspace.animation')).toBe('Hoạt ảnh');
    expect(translate('vi', 'timeline.title')).toBe('Dòng thời gian');
    expect(translate('en', 'transport.play')).toBe('Play');
  });

  it('switches language immediately and persists selection in localStorage', () => {
    useLocaleStore.getState().setLocale('en');
    expect(useLocaleStore.getState().locale).toBe('en');
    expect(window.localStorage.getItem('amcs.locale')).toBe('en');
    expect(document.documentElement.lang).toBe('en');

    useLocaleStore.getState().toggleLocale();
    expect(useLocaleStore.getState().locale).toBe('vi');
    expect(window.localStorage.getItem('amcs.locale')).toBe('vi');
  });

  it('interpolates parameters and safely falls back on missing keys without throwing', () => {
    expect(translate('vi', 'scenes.header', { count: 4 })).toBe('Danh sách cảnh (4)');
    expect(translate('en', 'scenes.header', { count: 4 })).toBe('Scenes (4)');
    expect(translate('vi', 'nonexistent.missing.key')).toBe('nonexistent.missing.key');
  });
});
