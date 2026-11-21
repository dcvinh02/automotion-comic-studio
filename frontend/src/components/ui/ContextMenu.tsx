import React, { useEffect, useRef } from 'react';

export interface ContextMenuItem {
  id: string;
  label?: string;
  icon?: React.ReactNode;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  divider?: boolean;
  onSelect?: () => void;
}

export interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

export function ContextMenuOverlay({
  menu,
  onClose,
}: {
  menu: ContextMenuState | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [menu, onClose]);

  if (!menu) return null;

  const safeX = Math.min(menu.x, window.innerWidth - 210);
  const safeY = Math.min(menu.y, window.innerHeight - Math.min(320, menu.items.length * 32 + 16));

  return (
    <div
      ref={ref}
      role="menu"
      className="context-menu"
      style={{ left: Math.max(8, safeX), top: Math.max(8, safeY) }}
    >
      {menu.items.map((item) =>
        item.divider ? (
          <div key={item.id} className="context-menu-divider" />
        ) : (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            className={`context-menu-item ${item.danger ? 'danger' : ''}`}
            onClick={() => {
              item.onSelect?.();
              onClose();
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              {item.icon}
              <span>{item.label}</span>
            </span>
            {item.shortcut && (
              <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                {item.shortcut}
              </span>
            )}
          </button>
        ),
      )}
    </div>
  );
}
