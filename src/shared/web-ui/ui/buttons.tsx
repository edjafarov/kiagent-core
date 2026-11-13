import React from 'react';
import { Icon } from '../icon-sprite';
import { Spinner } from '../components';
import { cx } from './cx';

/** Same delay `Busy` uses: fast local round-trips never flash a spinner. */
const SPINNER_DELAY_MS = 200;
const DONE_MS = 1000;
const COPIED_MS = 1500;

/** Pending/done feedback props shared by Button, IconButton, TextButton. */
interface ActionProps {
  /** Click handler that returns its promise. The button is disabled with
   *  aria-busy while it runs (spinner after 200 ms); clicks meanwhile are
   *  ignored. Wins over `onClick` when both are given. A rejection only ends
   *  the pending state: the button shows no error, so an action that can
   *  fail catches and shows its own. */
  onAction?: () => Promise<unknown>;
  /** Pending driven from outside (a status push); renders like onAction. */
  busy?: boolean;
  /** With `onAction`: show a check for ~1 s after the promise resolves. */
  done?: boolean;
}

interface ActionState {
  /** aria-busy / disabled. */
  active: boolean;
  showSpinner: boolean;
  justDone: boolean;
  onClick: React.MouseEventHandler<HTMLButtonElement> | undefined;
}

function useAction(
  props: ActionProps & { onClick?: React.MouseEventHandler<HTMLButtonElement> },
): ActionState {
  const { onAction, busy, done, onClick } = props;
  const [pending, setPending] = React.useState(false);
  const [showSpinner, setShowSpinner] = React.useState(false);
  const [justDone, setJustDone] = React.useState(false);
  const inFlight = React.useRef(false);
  const mounted = React.useRef(true);
  const doneTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (doneTimer.current) clearTimeout(doneTimer.current);
    };
  }, []);
  const active = pending || !!busy;
  React.useEffect(() => {
    if (!active) {
      setShowSpinner(false);
      return undefined;
    }
    const t = setTimeout(() => setShowSpinner(true), SPINNER_DELAY_MS);
    return () => clearTimeout(t);
  }, [active]);
  if (!onAction) return { active, showSpinner, justDone: false, onClick };
  const run: React.MouseEventHandler<HTMLButtonElement> = () => {
    if (inFlight.current) return;
    const p = onAction();
    inFlight.current = true;
    setPending(true);
    setJustDone(false);
    if (doneTimer.current) clearTimeout(doneTimer.current);
    Promise.resolve(p).then(
      () => {
        inFlight.current = false;
        if (!mounted.current) return;
        setPending(false);
        if (done) {
          setJustDone(true);
          doneTimer.current = setTimeout(() => {
            if (mounted.current) setJustDone(false);
          }, DONE_MS);
        }
      },
      () => {
        inFlight.current = false;
        if (mounted.current) setPending(false);
      },
    );
  };
  return { active, showSpinner, justDone, onClick: run };
}

/** What replaces (or precedes) the icon while pending or just done. */
function lead(
  st: ActionState,
  icon: string | undefined,
  size: number,
): React.ReactNode {
  if (st.showSpinner) return <Spinner />;
  if (st.justDone) return <Icon name="check" size={size} />;
  return icon ? <Icon name={icon} size={size} /> : null;
}

/** Copy-to-clipboard feedback: `copied` is true for ~1.5 s after `copy`
 *  succeeds. A refused clipboard leaves `copied` false. */
export function useCopy(
  write: (text: string) => Promise<void> = (text) =>
    navigator.clipboard.writeText(text),
): { copied: boolean; copy: (text: string) => Promise<void> } {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  const copy = async (text: string): Promise<void> => {
    try {
      await write(text);
    } catch {
      return; // clipboard refused: stay "not copied"
    }
    if (!mounted.current) return;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (mounted.current) setCopied(false);
    }, COPIED_MS);
  };
  return { copied, copy };
}

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

/** Native button props; `className` and `type` are restated so the
 *  prop-types lint sees them. `reset` buttons are not offered. */
interface NativeButton extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  className?: string;
  type?: 'button' | 'submit';
}

export interface ButtonProps extends NativeButton, ActionProps {
  variant?: ButtonVariant;
  size?: 'md' | 'sm';
  /** Leading icon from the sprite. */
  icon?: string;
}

/** Square button. One primary per screen. */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    props: ButtonProps,
    ref: React.ForwardedRef<HTMLButtonElement>,
  ) {
    const {
      variant = 'secondary',
      size = 'md',
      icon,
      className,
      type,
      children,
      onAction,
      busy,
      done,
      ...rest
    } = props;
    const st = useAction({ onAction, busy, done, onClick: rest.onClick });
    return (
      <button
        ref={ref}
        type={type === 'submit' ? 'submit' : 'button'}
        className={cx(
          'ui-btn',
          `is-${variant}`,
          size === 'sm' && 'is-sm',
          className,
        )}
        {...rest}
        onClick={st.onClick}
        disabled={rest.disabled || st.active}
        aria-busy={st.active || undefined}
      >
        {lead(st, icon, size === 'sm' ? 12 : 14)}
        {children}
      </button>
    );
  },
);

export interface IconButtonProps
  extends Omit<NativeButton, 'children'>,
    ActionProps {
  icon: string;
  /** Accessible name and tooltip. */
  label: string;
  variant?: 'ghost' | 'secondary';
  size?: 'md' | 'sm';
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    props: IconButtonProps,
    ref: React.ForwardedRef<HTMLButtonElement>,
  ) {
    const {
      icon,
      label,
      variant = 'ghost',
      size = 'md',
      className,
      type,
      onAction,
      busy,
      done,
      ...rest
    } = props;
    const st = useAction({ onAction, busy, done, onClick: rest.onClick });
    return (
      <button
        ref={ref}
        type={type === 'submit' ? 'submit' : 'button'}
        aria-label={label}
        title={label}
        className={cx(
          'ui-btn',
          'ui-ibtn',
          `is-${variant}`,
          size === 'sm' && 'is-sm',
          className,
        )}
        {...rest}
        onClick={st.onClick}
        disabled={rest.disabled || st.active}
        aria-busy={st.active || undefined}
      >
        {lead(st, icon, size === 'sm' ? 13 : 15)}
      </button>
    );
  },
);

/** Inline violet text action (a button, not a navigation link). */
export type TextButtonProps = NativeButton & ActionProps;

export const TextButton = React.forwardRef<HTMLButtonElement, TextButtonProps>(
  function TextButton(
    props: TextButtonProps,
    ref: React.ForwardedRef<HTMLButtonElement>,
  ) {
    const { className, type, onAction, busy, done, children, ...rest } = props;
    const st = useAction({ onAction, busy, done, onClick: rest.onClick });
    return (
      <button
        ref={ref}
        type={type === 'submit' ? 'submit' : 'button'}
        className={cx('ui-link', className)}
        {...rest}
        onClick={st.onClick}
        disabled={rest.disabled || st.active}
        aria-busy={st.active || undefined}
      >
        {lead(st, undefined, 12)}
        {children}
      </button>
    );
  },
);
