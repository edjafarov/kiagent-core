import React from 'react';
import { cx } from './cx';

export type AttentionTone = 'acc' | 'err' | 'work';

export function AttentionList(props: {
  children: React.ReactNode;
  'aria-label'?: string;
}): React.ReactElement {
  return (
    <ul className="ui-attn" aria-label={props['aria-label']}>
      {props.children}
    </ul>
  );
}

/** One thing that needs the user: a coloured edge, a caps kind word,
 *  a title (may hold bold parts), an optional second line, one action,
 *  and an optional `detail` shown below at its own height. */
export function AttentionRow(props: {
  tone: AttentionTone;
  kind: string;
  title: React.ReactNode;
  sub?: React.ReactNode;
  action?: React.ReactNode;
  detail?: React.ReactNode;
  'data-testid'?: string;
}): React.ReactElement {
  return (
    <li
      className={cx(
        'ui-att',
        `is-${props.tone}`,
        props.detail != null && 'has-detail',
      )}
      data-testid={props['data-testid']}
    >
      <span className="ui-att-k">{props.kind}</span>
      <span className="ui-att-body">
        <span className="ui-att-t">{props.title}</span>
        {props.sub != null && <span className="ui-att-s">{props.sub}</span>}
      </span>
      {props.action != null && (
        <span className="ui-att-act">{props.action}</span>
      )}
      {props.detail != null && (
        <div className="ui-att-detail">{props.detail}</div>
      )}
    </li>
  );
}

/** Number tiles: two columns beside other content, or one row across the
 *  page (`layout="row"`) when they stand alone. */
export function KpiGrid(props: {
  layout?: 'grid' | 'row';
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className={cx('ui-kpis', props.layout === 'row' && 'is-row')}>
      {props.children}
    </div>
  );
}

export function Kpi(props: {
  value: React.ReactNode;
  /** A total, shown small after the value: "12 / 13". */
  of?: React.ReactNode;
  label: React.ReactNode;
  /** Spans both columns of the grid. */
  wide?: boolean;
}): React.ReactElement {
  return (
    <div className={cx('ui-kpi', props.wide && 'is-wide')}>
      <span className="ui-kpi-v">
        {props.value}
        {props.of != null && <small> / {props.of}</small>}
      </span>
      <span className="ui-kpi-l">{props.label}</span>
    </div>
  );
}
