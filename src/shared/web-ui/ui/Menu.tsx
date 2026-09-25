import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../icon-sprite';
import { cx } from './cx';
import { portalRoot } from './portal';

export interface MenuItem {
  key: string;
  label: React.ReactNode;
  icon?: string;
  danger?: boolean;
  disabled?: boolean;
  /** Keep the menu open after selecting (e.g. to show progress). */
  keepOpen?: boolean;
  onSelect: () => void;
}

export type MenuEntry = MenuItem | 'separator';

type Placement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end';

const GAP = 4;
const EDGE = 8;

function place(
  anchor: DOMRect,
  menu: DOMRect,
  placement: Placement,
): { top: number; left: number } {
  const wantTop = placement.startsWith('top');
  const above = anchor.top - GAP - menu.height;
  const below = anchor.bottom + GAP;
  let top = wantTop ? above : below;
  if (wantTop && above < EDGE) top = below;
  if (!wantTop && below + menu.height > window.innerHeight - EDGE) top = above;
  let left = placement.endsWith('end')
    ? anchor.right - menu.width
    : anchor.left;
  left = Math.max(EDGE, Math.min(left, window.innerWidth - menu.width - EDGE));
  return { top: Math.max(EDGE, top), left };
}

/** A popover list opened from a trigger the caller owns. */
export function Menu(props: {
  open: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  items: readonly MenuEntry[];
  'aria-label': string;
  placement?: Placement;
  header?: React.ReactNode;
  footer?: React.ReactNode;
}): React.ReactElement | null {
  const {
    open,
    anchorRef,
    onClose,
    items,
    placement = 'bottom-start',
    header,
    footer,
  } = props;
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({
    top: -9999,
    left: -9999,
  });

  const enabledButtons = useCallback(
    (): HTMLButtonElement[] =>
      Array.from(
        menuRef.current?.querySelectorAll<HTMLButtonElement>(
          '[role="menuitem"]:not(:disabled)',
        ) ?? [],
      ),
    [],
  );

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    const menu = menuRef.current;
    if (anchor && menu) {
      setPos(
        place(
          anchor.getBoundingClientRect(),
          menu.getBoundingClientRect(),
          placement,
        ),
      );
    }
    enabledButtons()[0]?.focus();
  }, [open, anchorRef, placement, enabledButtons]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || anchorRef.current?.contains(t))
        return;
      onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, onClose, anchorRef]);

  if (!open) return null;

  const close = (refocus: boolean): void => {
    onClose();
    if (refocus) anchorRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const buttons = enabledButtons();
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const go = (i: number): void => {
      const n = buttons.length;
      if (n) buttons[((i % n) + n) % n].focus();
    };
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at < 0 ? buttons.length - 1 : at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(buttons.length - 1);
    else if (e.key === 'Escape') {
      e.stopPropagation();
      close(true);
    } else if (e.key === 'Tab') {
      close(false);
      return;
    } else return;
    e.preventDefault();
  };

  return createPortal(
    <div
      ref={menuRef}
      className="ui-menu"
      role="menu"
      tabIndex={-1}
      aria-label={props['aria-label']}
      style={{ top: pos.top, left: pos.left }}
      onKeyDown={onKeyDown}
    >
      {header != null && <div className="ui-menu-hd">{header}</div>}
      {items.map((entry, i) =>
        entry === 'separator' ? (
          // eslint-disable-next-line react/no-array-index-key
          <div key={`sep-${i}`} role="separator" className="ui-menu-sep" />
        ) : (
          <button
            key={entry.key}
            type="button"
            role="menuitem"
            tabIndex={-1}
            disabled={entry.disabled}
            className={cx('ui-menu-i', entry.danger && 'is-danger')}
            onClick={() => {
              if (!entry.keepOpen) close(false);
              entry.onSelect();
            }}
          >
            {entry.icon && <Icon name={entry.icon} size={14} />}
            <span>{entry.label}</span>
          </button>
        ),
      )}
      {footer != null && <div className="ui-menu-foot">{footer}</div>}
    </div>,
    portalRoot(),
  );
}
