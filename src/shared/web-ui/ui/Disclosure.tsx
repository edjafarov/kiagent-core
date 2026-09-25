import React, { useId, useState } from 'react';
import { Icon } from '../icon-sprite';
import { cx } from './cx';

/** A quiet band that hides detail: bold label, muted current-value
 *  summary, chevron. Nest at most one level. */
export function Disclosure(props: {
  label: React.ReactNode;
  summary?: React.ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onToggle?: (open: boolean) => void;
  children: React.ReactNode;
}): React.ReactElement {
  const bodyId = useId();
  const [ownOpen, setOwnOpen] = useState(props.defaultOpen ?? false);
  const open = props.open ?? ownOpen;
  const toggle = (): void => {
    if (props.open === undefined) setOwnOpen(!open);
    props.onToggle?.(!open);
  };
  return (
    <div className={cx('ui-disc', open && 'is-open')}>
      <button
        type="button"
        className="ui-disc-hd"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={toggle}
      >
        <Icon name={open ? 'chev-down' : 'chev-right'} size={14} />
        <span className="ui-disc-lbl">{props.label}</span>
        {props.summary != null && (
          <span className="ui-disc-sum">{props.summary}</span>
        )}
      </button>
      {open && (
        <div id={bodyId} className="ui-disc-body">
          {props.children}
        </div>
      )}
    </div>
  );
}
