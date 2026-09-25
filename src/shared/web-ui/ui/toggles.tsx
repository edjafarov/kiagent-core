import React from 'react';
import { cx } from './cx';

export function Toggle(props: {
  checked: boolean;
  onChange: (next: boolean) => void;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  disabled?: boolean;
}): React.ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props['aria-label']}
      aria-labelledby={props['aria-labelledby']}
      disabled={props.disabled}
      className={cx('ui-toggle', props.checked && 'is-on')}
      onClick={() => props.onChange(!props.checked)}
    >
      <span className="ui-toggle-knob" />
    </button>
  );
}

export function Checkbox(props: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: React.ReactNode;
  'aria-label'?: string;
  disabled?: boolean;
}): React.ReactElement {
  const box = (
    <input
      type="checkbox"
      className="ui-cb"
      checked={props.checked}
      disabled={props.disabled}
      aria-label={props['aria-label']}
      onChange={(e) => props.onChange(e.target.checked)}
    />
  );
  if (props.label == null) return box;
  return (
    <label className="ui-cb-label">
      {box}
      <span>{props.label}</span>
    </label>
  );
}
