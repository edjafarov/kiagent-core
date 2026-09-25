import React from 'react';
import { cx } from './cx';

export function Card(props: {
  children: React.ReactNode;
  className?: string;
  /** Names the card when no visible header does. */
  'aria-label'?: string;
}): React.ReactElement {
  return (
    <section
      className={cx('ui-card', props.className)}
      aria-label={props['aria-label']}
    >
      {props.children}
    </section>
  );
}

export function CardHeader(props: {
  label: React.ReactNode;
  count?: React.ReactNode;
  meta?: React.ReactNode;
  action?: React.ReactNode;
}): React.ReactElement {
  const { label, count, meta, action } = props;
  return (
    <div className="ui-card-hd">
      <h2 className="ui-card-lbl">{label}</h2>
      {count != null && <span className="ui-card-count">{count}</span>}
      {meta != null && <span className="ui-card-meta">{meta}</span>}
      {action != null && <span className="ui-card-act">{action}</span>}
    </div>
  );
}

export function CardFooter(props: {
  children: React.ReactNode;
}): React.ReactElement {
  return <div className="ui-card-foot">{props.children}</div>;
}

/** The selected-item panel on the right of a split page. */
export function Panel(props: {
  title?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <section className={cx('ui-panel', props.className)}>
      {props.title != null && <h3 className="ui-panel-title">{props.title}</h3>}
      {props.children}
    </section>
  );
}

export interface KeyValueItem {
  label: React.ReactNode;
  value: React.ReactNode;
}

export function KeyValue(props: {
  items: readonly KeyValueItem[];
}): React.ReactElement {
  return (
    <dl className="ui-kv">
      {props.items.map((item, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <React.Fragment key={i}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

/** A short sentence and at most one action; no illustration. */
export function EmptyState(props: {
  children: React.ReactNode;
  action?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="ui-empty">
      <p>{props.children}</p>
      {props.action}
    </div>
  );
}
