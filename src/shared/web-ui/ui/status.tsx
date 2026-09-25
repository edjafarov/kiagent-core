import React from 'react';
import { cx } from './cx';

/** `ok` is only for the state line of a running service the user switched
 *  on — never for rows of healthy items. `rec` is a recording, not an error. */
export type StatusTone = 'ok' | 'work' | 'err' | 'off' | 'rec';

export function Status(props: {
  tone: StatusTone;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <span className={cx('ui-status', `is-${props.tone}`)}>
      <span className="ui-dot" aria-hidden="true" />
      {props.children}
    </span>
  );
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
}

function pct(n: number): string {
  return `${Math.round(clamp01(n) * 1000) / 10}%`;
}

export function ProgressBar(props: {
  'aria-label': string;
  value: number;
  /** A light segment after `value` (work in flight). */
  running?: number;
  /** Fill in this brand colour, toned (first import only). */
  brand?: string;
}): React.ReactElement {
  const value = clamp01(props.value);
  return (
    <div
      className="ui-track"
      role="progressbar"
      aria-label={props['aria-label']}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
    >
      <span
        className={cx('ui-bar', props.brand ? 'is-brand' : 'is-v')}
        style={
          {
            width: pct(value),
            ...(props.brand ? { '--brand': props.brand } : {}),
          } as React.CSSProperties
        }
      />
      {props.running != null && props.running > 0 && (
        <span className="ui-bar is-f" style={{ width: pct(props.running) }} />
      )}
    </div>
  );
}
