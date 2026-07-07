import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from '@shared/web-ui/icon-sprite';

export interface RowMenuAction {
  label: string;
  icon?: string;
  onSelect: () => void | Promise<void>;
  destructive?: boolean;
  confirm?: string;
}

// Matches the visual rhythm of `.menu-row` (~160px reads well for short
// labels); fixed so right-alignment doesn't need a post-render measurement.
const POPOVER_WIDTH = 180;

/** Kebab-menu popover — ported from the legacy renderer's
 *  `components/RowMenu.tsx` (same markup/behavior, kept local to this
 *  screen since the new shell has no shared RowMenu of its own yet). */
export function RowMenu(props: {
  actions: RowMenuAction[];
  ariaLabel?: string;
  buttonStyle?: React.CSSProperties;
}): React.ReactElement {
  const { actions, ariaLabel = 'More actions', buttonStyle } = props;
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number }>({
    top: 0,
    left: 0,
  });

  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = (): void => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      setPos({ top: r.bottom + 4, left: r.right - POPOVER_WIDTH });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node | null;
      if (popRef.current?.contains(t)) return;
      if (btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const runAction = (action: RowMenuAction): void => {
    if (action.confirm && !window.confirm(action.confirm)) return;
    setOpen(false);
    void action.onSelect();
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="btn ghost sm icon-only"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        style={buttonStyle}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="more" size={12} />
      </button>
      {open && (
        <div
          ref={popRef}
          role="menu"
          className="tray-pop"
          style={{
            position: 'fixed',
            top: pos.top,
            left: pos.left,
            width: POPOVER_WIDTH,
            padding: '4px 0',
            zIndex: 1000,
          }}
        >
          {actions.map((a, i) => (
            <button
              key={`${a.label}-${i}`}
              type="button"
              role="menuitem"
              className="menu-row"
              style={
                a.destructive ? { color: 'var(--error-solid)' } : undefined
              }
              onClick={() => runAction(a)}
            >
              {a.icon && (
                <Icon
                  name={a.icon}
                  size={11}
                  style={{
                    color: a.destructive
                      ? 'var(--error-solid)'
                      : 'var(--text-secondary)',
                  }}
                />
              )}
              {a.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
