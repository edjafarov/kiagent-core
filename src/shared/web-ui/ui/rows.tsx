import React, { useState } from 'react';
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
  /** Shown only while the row is hovered or holds keyboard focus. */
  hoverActions?: React.ReactNode;
  onClick?: () => void;
  'aria-label'?: string;
}): React.ReactElement {
  const [hot, setHot] = useState(false);
  const size = props.size ?? 30;
  const showActions = props.hoverActions != null && hot;
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
        hot && 'is-hot',
      )}
      onMouseEnter={() => setHot(true)}
      onMouseLeave={() => setHot(false)}
      onFocus={() => setHot(true)}
      onBlur={(e) => {
        const next = e.relatedTarget as Node | null;
        if (!next || !e.currentTarget.contains(next)) setHot(false);
      }}
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
      {showActions ? (
        <span className="ui-row-acts">{props.hoverActions}</span>
      ) : (
        props.time != null && <span className="ui-row-time">{props.time}</span>
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
