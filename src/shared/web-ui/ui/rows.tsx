import React from 'react';
import { cx } from './cx';

export type RowSize = 30 | 34 | 38 | 42 | 48;

export function Rows(props: {
  children: React.ReactNode;
  'aria-label'?: string;
}): React.ReactElement {
  return (
    <ul className="ui-rows" aria-label={props['aria-label']}>
      {props.children}
    </ul>
  );
}

/** A list row without divider lines. Space separates rows; a tint marks
 *  the selected one. */
export function Row(props: {
  size?: RowSize;
  lead?: React.ReactNode;
  title: React.ReactNode;
  sub?: React.ReactNode;
  trail?: React.ReactNode;
  time?: React.ReactNode;
  selected?: boolean;
  faint?: boolean;
  /** Always mounted and in tab order; shown (over the time) while the
   *  row is hovered or holds focus. */
  hoverActions?: React.ReactNode;
  /** Shown below the line at its own height (an opened explanation); the
   *  line keeps its size. */
  detail?: React.ReactNode;
  onClick?: () => void;
  'aria-label'?: string;
  'data-testid'?: string;
}): React.ReactElement {
  const size = props.size ?? 30;
  const body = (
    <>
      {props.lead != null && <span className="ui-row-lead">{props.lead}</span>}
      <span className="ui-row-text">
        <span className="ui-row-t">{props.title}</span>
        {props.sub != null && <span className="ui-row-s">{props.sub}</span>}
      </span>
    </>
  );
  return (
    <li
      className={cx(
        'ui-row',
        size !== 30 && `is-${size}`,
        props.selected && 'is-sel',
        props.faint && 'is-faint',
        props.detail != null && 'has-detail',
      )}
      data-testid={props['data-testid']}
    >
      {props.onClick ? (
        <button
          type="button"
          className="ui-row-main"
          aria-label={props['aria-label']}
          aria-current={props.selected ? 'true' : undefined}
          onClick={props.onClick}
        >
          {body}
        </button>
      ) : (
        <span className="ui-row-main">{body}</span>
      )}
      {props.trail != null && (
        <span className="ui-row-trail">{props.trail}</span>
      )}
      {props.time != null && <span className="ui-row-time">{props.time}</span>}
      {props.hoverActions != null && (
        <span className="ui-row-acts">{props.hoverActions}</span>
      )}
      {props.detail != null && (
        <div className="ui-row-detail">{props.detail}</div>
      )}
    </li>
  );
}

/** A group label inside `Rows`: Today, Yesterday, a date. */
export function DayGroup(props: {
  children: React.ReactNode;
}): React.ReactElement {
  return <li className="ui-day">{props.children}</li>;
}
