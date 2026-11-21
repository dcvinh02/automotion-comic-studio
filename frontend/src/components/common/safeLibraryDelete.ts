import { tGlobal as translate } from '@/i18n/useLocaleStore';

interface RefEntry {
  kind: string;
  name: string;
  where: string;
}

/**
 * Phase 09.1: library assets/characters are shared by every project. Deleting one is permanent
 * (the file is removed), so always confirm, and when the backend reports it is still in use
 * (HTTP 409) list where, and only force the delete after an explicit second confirmation.
 * Returns true when the item was deleted.
 */
export async function safeLibraryDelete(
  name: string,
  doDelete: (force: boolean) => Promise<void>,
  onError: (message: string) => void,
): Promise<boolean> {
  if (!window.confirm(translate('library.deleteConfirm', { name }))) return false;
  try {
    await doDelete(false);
    return true;
  } catch (err) {
    const e = err as Error & { status?: number; payload?: { references?: RefEntry[] } };
    if (e.status === 409 && e.payload?.references?.length) {
      const lines = e.payload.references.slice(0, 8).map((r) => `• ${r.name}: ${r.where}`);
      const ok = window.confirm(translate('library.deleteInUse', { name, usages: lines.join('\n') }));
      if (!ok) return false;
      try {
        await doDelete(true);
        return true;
      } catch (err2) {
        onError(err2 instanceof Error ? err2.message : String(err2));
        return false;
      }
    }
    onError(e.message || String(err));
    return false;
  }
}
