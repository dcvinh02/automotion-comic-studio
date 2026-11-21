export function ToggleSwitch({
  label,
  checked,
  onChange,
  description,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <label
      className="toggle-row"
      style={{ opacity: disabled ? 0.45 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
        <span>{label}</span>
        {description && (
          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{description}</span>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={`toggle-track ${checked ? 'checked' : ''}`}
        style={{ padding: 0 }}
      >
        <span className="toggle-thumb" />
      </button>
    </label>
  );
}
