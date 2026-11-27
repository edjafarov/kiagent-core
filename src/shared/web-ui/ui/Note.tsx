import React from 'react';
import { cx } from './cx';

/** One line of small text under or beside a control: a hint, a result, or
 *  (tone 'error') what went wrong. It has no margin of its own. */
export function Note(props: {
  tone?: 'muted' | 'error';
  /** 'span' when the note sits inside a row of other inline things. */
  as?: 'p' | 'span';
  role?: 'alert' | 'status';
  id?: string;
  className?: string;
  children: React.ReactNode;
}): React.ReactElement {
  const Tag = props.as ?? 'p';
  return (
    <Tag
      id={props.id}
      role={props.role}
      className={cx(
        'ui-note',
        props.tone === 'error' && 'is-error',
        props.className,
      )}
    >
      {props.children}
    </Tag>
  );
}
