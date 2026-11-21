import React, { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

export function CollapsibleSection({
  title,
  icon,
  badge,
  action,
  defaultOpen = true,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  badge?: string | number;
  action?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="collapsible-section">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
        <button
          type="button"
          className="collapsible-trigger"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0, overflow: 'hidden' }}>
            <span style={{ flexShrink: 0, display: 'inline-flex' }}>
              {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </span>
            {icon && <span style={{ flexShrink: 0, display: 'inline-flex' }}>{icon}</span>}
            <span
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                minWidth: 0,
              }}
              title={title}
            >
              {title}
            </span>
            {badge !== undefined && (
              <span className="tag-pill mono" style={{ fontSize: 9, flexShrink: 0 }}>
                {badge}
              </span>
            )}
          </span>
        </button>
        {action && <div style={{ paddingRight: 6, flexShrink: 0 }}>{action}</div>}
      </div>
      {open && <div className="collapsible-body">{children}</div>}
    </div>
  );
}
