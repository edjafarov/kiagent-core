import React, { createContext, useContext, useId } from 'react';
import { cx } from './cx';

/** Native section attributes (id, aria-label, aria-labelledby, …);
 *  className is restated so the prop-types lint sees it. */
interface SectionProps extends React.HTMLAttributes<HTMLElement> {
  className?: string;
}

/** The id a Card gives its CardHeader label, so the header names the card. */
const CardLabelId = createContext<string | undefined>(undefined);

/** A named region. A CardHeader inside names it; `aria-label` or
 *  `aria-labelledby` names a card without a header. */
export function Card(props: SectionProps): React.ReactElement {
  const { className, children, ...rest } = props;
  const labelId = useId();
  const named = rest['aria-label'] != null || rest['aria-labelledby'] != null;
  return (
    <CardLabelId.Provider value={named ? undefined : labelId}>
      <section
        className={cx('ui-card', className)}
        aria-labelledby={named ? undefined : labelId}
        {...rest}
      >
        {children}
      </section>
    </CardLabelId.Provider>
  );
}

export function CardHeader(props: {
  label: React.ReactNode;
  count?: React.ReactNode;
  meta?: React.ReactNode;
  action?: React.ReactNode;
}): React.ReactElement {
  const { label, count, meta, action } = props;
  const labelId = useContext(CardLabelId);
  return (
    <div className="ui-card-hd">
      <h2 id={labelId} className="ui-card-lbl">
        {label}
      </h2>
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
export function Panel(
  props: Omit<SectionProps, 'title'> & { title?: React.ReactNode },
): React.ReactElement {
  const { title, className, children, ...rest } = props;
  return (
    <section className={cx('ui-panel', className)} {...rest}>
      {title != null && <h3 className="ui-panel-title">{title}</h3>}
      {children}
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
