import { useCallback } from 'react';
import { create } from 'zustand';
import en from '@/locales/en.json';
import vi from '@/locales/vi.json';

export type LocaleCode = 'vi' | 'en';
export type TranslationKey = keyof typeof en;
export type TranslationParams = Record<string, string | number>;

const STORAGE_KEY = 'amcs.locale';

const DICTIONARIES: Record<LocaleCode, Record<string, string>> = {
  vi,
  en,
};

function readPersistedLocale(): LocaleCode {
  try {
    if (typeof window !== 'undefined' && typeof window.localStorage?.getItem === 'function') {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw === 'en' || raw === 'vi') return raw;
    }
  } catch {
    // Ignore storage access errors in restricted environments
  }
  return 'vi'; // Default language for new installations per Phase 03 Section 2.1
}

function writePersistedLocale(locale: LocaleCode): void {
  try {
    if (typeof window !== 'undefined' && typeof window.localStorage?.setItem === 'function') {
      window.localStorage.setItem(STORAGE_KEY, locale);
    }
  } catch {
    // Ignore storage quota errors
  }
}

export function translate(
  locale: LocaleCode,
  key: TranslationKey | string,
  params?: TranslationParams,
): string {
  const dict = DICTIONARIES[locale] ?? DICTIONARIES.vi;
  let template = dict[key] ?? DICTIONARIES.en[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      template = template.replaceAll(`{{${k}}}`, String(v));
    }
  }
  return template;
}

interface LocaleStore {
  locale: LocaleCode;
  setLocale: (locale: LocaleCode) => void;
  toggleLocale: () => void;
}

export const useLocaleStore = create<LocaleStore>((set, get) => ({
  locale: readPersistedLocale(),

  setLocale: (locale) => {
    const safe: LocaleCode = locale === 'en' ? 'en' : 'vi';
    writePersistedLocale(safe);
    if (typeof document !== 'undefined') {
      document.documentElement.lang = safe;
    }
    set({ locale: safe });
  },

  toggleLocale: () => {
    const next: LocaleCode = get().locale === 'vi' ? 'en' : 'vi';
    get().setLocale(next);
  },
}));

export function useI18n() {
  const locale = useLocaleStore((s) => s.locale);
  const setLocale = useLocaleStore((s) => s.setLocale);
  const toggleLocale = useLocaleStore((s) => s.toggleLocale);
  const t = useCallback(
    (key: TranslationKey | string, params?: TranslationParams) => translate(locale, key, params),
    [locale],
  );
  return { locale, setLocale, toggleLocale, t };
}

export function tGlobal(key: TranslationKey | string, params?: TranslationParams): string {
  return translate(useLocaleStore.getState().locale, key, params);
}
