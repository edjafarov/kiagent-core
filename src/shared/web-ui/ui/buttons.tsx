import React from 'react';
import { Icon } from '../icon-sprite';
import { cx } from './cx';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

/** Native button props; `className` and `type` are restated so the
 *  prop-types lint sees them. `reset` buttons are not offered. */
interface NativeButton extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  className?: string;
  type?: 'button' | 'submit';
}

export interface ButtonProps extends NativeButton {
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
      ...rest
    } = props;
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
      >
        {icon && <Icon name={icon} size={size === 'sm' ? 12 : 14} />}
        {children}
      </button>
    );
  },
);

export interface IconButtonProps extends Omit<NativeButton, 'children'> {
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
      ...rest
    } = props;
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
      >
        <Icon name={icon} size={size === 'sm' ? 13 : 15} />
      </button>
    );
  },
);

/** Inline violet text action (a button, not a navigation link). */
export function TextButton(props: NativeButton): React.ReactElement {
  const { className, type, ...rest } = props;
  return (
    <button
      type={type === 'submit' ? 'submit' : 'button'}
      className={cx('ui-link', className)}
      {...rest}
    />
  );
}
