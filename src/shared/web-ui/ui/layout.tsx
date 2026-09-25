import React from 'react';
import { IconButton } from './buttons';
import { cx } from './cx';

export interface Crumb {
  parent: string;
  current: string;
  /** Steps back: a routed view passes the app's back(), a sub-view inside a
   *  screen passes its own state setter. */
  onBack: () => void;
  /** Where the parent label goes; defaults to onBack. */
  onParent?: () => void;
}

export interface TopBarProps {
  title?: React.ReactNode;
  meta?: React.ReactNode;
  crumb?: Crumb;
  actions?: React.ReactNode;
}

/** The page's one title bar: title or breadcrumb, then the page's actions.
 *  Part of the window's drag band; its controls opt out of dragging. */
export function TopBar(props: TopBarProps): React.ReactElement {
  const { title, meta, crumb, actions } = props;
  return (
    <header className="ui-top">
      {crumb ? (
        <nav className="ui-crumb" aria-label="Breadcrumb">
          <IconButton
            icon="arrow-left"
            label={`Back to ${crumb.parent}`}
            onClick={crumb.onBack}
          />
          <button
            type="button"
            className="ui-crumb-parent"
            onClick={crumb.onParent ?? crumb.onBack}
          >
            {crumb.parent}
          </button>
          <span className="ui-crumb-sep" aria-hidden="true">
            ›
          </span>
          <h1 className="ui-crumb-cur">{crumb.current}</h1>
        </nav>
      ) : (
        <>
          {title != null && <h1 className="ui-top-title">{title}</h1>}
          {meta != null && <span className="ui-top-meta">{meta}</span>}
        </>
      )}
      <span className="ui-top-gap" />
      {actions != null && <div className="ui-top-acts">{actions}</div>}
    </header>
  );
}

/** A migrated page's frame: the top bar plus the padded, scrolling pane. */
export function Page(
  props: TopBarProps & { children: React.ReactNode; className?: string },
): React.ReactElement {
  const { children, className, ...top } = props;
  return (
    <>
      <TopBar {...top} />
      <div className={cx('ui-pane', className)}>{children}</div>
    </>
  );
}

/** Main column + a right column. Stacks when the pane is narrower than 820px. */
export function Split(props: {
  aside: 'sm' | 'md';
  side: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className={cx('ui-split', `is-${props.aside}`)}>
      <div className="ui-split-main">{props.children}</div>
      <div className="ui-split-aside">{props.side}</div>
    </div>
  );
}

/** An explicit grid template; two columns under 900px, one under 620px. */
export function Columns(props: {
  template: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div
      className="ui-cols"
      style={{ '--ui-cols': props.template } as React.CSSProperties}
    >
      {props.children}
    </div>
  );
}

export function Stack(props: {
  gap?: 'page' | 'stack';
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div
      className={cx('ui-stack', props.gap === 'page' ? 'is-page' : 'is-stack')}
    >
      {props.children}
    </div>
  );
}
