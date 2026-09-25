import React, {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Button, IconButton } from './buttons';
import { FOCUSABLE, portalRoot } from './portal';

function focusables(root: HTMLElement | null): HTMLElement[] {
  return root ? Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)) : [];
}

/** A modal dialog over a scrim. Mount it to open it. */
export function Sheet(props: {
  title: React.ReactNode;
  onClose: () => void;
  busy?: boolean;
  width?: 560 | 600 | 640;
  footer?: React.ReactNode;
  initialFocus?: React.RefObject<HTMLElement | null>;
  children: React.ReactNode;
}): React.ReactElement {
  const {
    title,
    onClose,
    busy = false,
    width = 560,
    footer,
    initialFocus,
    children,
  } = props;
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const footRef = useRef<HTMLDivElement>(null);
  const pressOnScrim = useRef(false);

  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const target =
      initialFocus?.current ??
      focusables(bodyRef.current)[0] ??
      focusables(footRef.current)[0] ??
      dialogRef.current;
    target?.focus();
    return () => {
      if (previous && document.contains(previous)) previous.focus();
    };
    // Focus moves once, when the sheet opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (!busy) onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = focusables(dialogRef.current);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === dialogRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      className="ui-scrim"
      role="presentation"
      onMouseDown={(e) => {
        pressOnScrim.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        const dismiss = pressOnScrim.current && e.target === e.currentTarget;
        pressOnScrim.current = false;
        if (dismiss && !busy) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="ui-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy || undefined}
        tabIndex={-1}
        style={{ width }}
        onKeyDown={onKeyDown}
      >
        <div className="ui-sheet-hd">
          <h2 id={titleId} className="ui-sheet-title">
            {title}
          </h2>
          <IconButton
            icon="x"
            label="Close"
            onClick={onClose}
            disabled={busy}
          />
        </div>
        <div ref={bodyRef} className="ui-sheet-body">
          {children}
        </div>
        {footer != null && (
          <div ref={footRef} className="ui-sheet-foot">
            {footer}
          </div>
        )}
      </div>
    </div>,
    portalRoot(),
  );
}

export function ConfirmSheet(props: {
  title: React.ReactNode;
  children: React.ReactNode;
  confirmLabel: string;
  tone?: 'primary' | 'danger';
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}): React.ReactElement {
  const {
    title,
    children,
    confirmLabel,
    tone = 'primary',
    onConfirm,
    onClose,
  } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const confirm = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      if (mounted.current) {
        setError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      }
      return;
    }
    if (mounted.current) setBusy(false);
    onClose();
  };

  return (
    <Sheet
      title={title}
      onClose={onClose}
      busy={busy}
      initialFocus={cancelRef}
      footer={
        <>
          <Button ref={cancelRef} disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant={tone} disabled={busy} onClick={() => void confirm()}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="ui-sheet-text">{children}</p>
      {error && (
        <p role="alert" className="ui-sheet-err">
          {error}
        </p>
      )}
    </Sheet>
  );
}
