import { Search, X } from 'lucide-react';
import { useI18n } from '@/i18n/useLocaleStore';

export function SearchInput({
  value,
  onChange,
  placeholder,
  ariaLabel,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  ariaLabel?: string;
}) {
  const { t } = useI18n();
  const resolvedPlaceholder = placeholder ?? t('common.search');
  return (
    <div className="search-input-wrap">
      <Search
        size={13}
        style={{
          position: 'absolute',
          left: 8,
          color: 'var(--text-muted)',
          pointerEvents: 'none',
        }}
      />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={resolvedPlaceholder}
        aria-label={ariaLabel ?? resolvedPlaceholder}
      />
      {value && (
        <button
          type="button"
          className="btn-ghost btn-icon"
          aria-label={t('common.clearSearch')}
          onClick={() => onChange('')}
          style={{ position: 'absolute', right: 2, width: 20, height: 20 }}
        >
          <X size={11} />
        </button>
      )}
    </div>
  );
}
