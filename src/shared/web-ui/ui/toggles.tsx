import React from 'react';
import { cx } from './cx';

type NativeButton = Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'onChange' | 'type' | 'role'
>;

/** Native button props (id, aria-*, …) pass through; `className` is
 *  restated so the prop-types lint sees it. */
export interface ToggleProps extends NativeButton {
  checked: boolean;
  onChange: (next: boolean) => void;
  className?: string;
}

export const Toggle = React.forwardRef<HTMLButtonElement, ToggleProps>(
  function Toggle(
    props: ToggleProps,
    ref: React.ForwardedRef<HTMLButtonElement>,
  ) {
    const { checked, onChange, className, ...rest } = props;
    return (
      <button
        ref={ref}
        type="button"
        role="switch"
        aria-checked={checked}
        className={cx('ui-toggle', checked && 'is-on', className)}
        onClick={() => onChange(!checked)}
        {...rest}
      >
        <span className="ui-toggle-knob" />
      </button>
    );
  },
);

type NativeCheckbox = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'onChange' | 'type' | 'checked'
>;

/** Native input props pass through to the checkbox itself; `className`
 *  goes on the outer box (the label when there is one). */
export interface CheckboxProps extends NativeCheckbox {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: React.ReactNode;
  className?: string;
}

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  function Checkbox(
    props: CheckboxProps,
    ref: React.ForwardedRef<HTMLInputElement>,
  ) {
    const { checked, onChange, label, className, ...rest } = props;
    const box = (
      <input
        ref={ref}
        type="checkbox"
        className={cx('ui-cb', label == null && className)}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        {...rest}
      />
    );
    if (label == null) return box;
    return (
      <label className={cx('ui-cb-label', className)}>
        {box}
        <span>{label}</span>
      </label>
    );
  },
);
