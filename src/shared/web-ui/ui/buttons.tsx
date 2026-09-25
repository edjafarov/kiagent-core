import React from 'react';
import { Icon } from '../icon-sprite';
import { cx } from './cx';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

type NativeButton = React.ButtonHTMLAttributes<HTMLButtonElement>;

export interface ButtonProps extends NativeButton {
  variant?: ButtonVariant;
  size?: 'md' | 'sm';
  /** Leading icon from the sprite. */
  icon?: string;
}

/** Square button. One primary per screen. */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(props, ref) {
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
        // eslint-disable-next-line react/button-has-type
        type={type ?? 'button'}
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
  function IconButton(props, ref) {
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
        // eslint-disable-next-line react/button-has-type
        type={type ?? 'button'}
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

/** Inline violet text action. */
export function Link(props: NativeButton): React.ReactElement {
  const { className, type, ...rest } = props;
  return (
    // eslint-disable-next-line react/button-has-type
    <button
      type={type ?? 'button'}
      className={cx('ui-link', className)}
      {...rest}
    />
  );
}
