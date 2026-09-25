import React from 'react';
import { cx } from './cx';
import { TopBar } from './layout';

export interface SettingsPane {
  key: string;
  label: string;
}

/** Settings as a page: the top bar, a pane list and a content column. */
export function SettingsLayout(props: {
  panes: readonly SettingsPane[];
  active: string;
  onSelect: (key: string) => void;
  /** The pane title; omit for a pane that prints its own. */
  title?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <>
      <TopBar title="Settings" />
      <div className="ui-set">
        <nav className="ui-set-nav" aria-label="Settings">
          {props.panes.map((p) => {
            const active = p.key === props.active;
            return (
              <button
                key={p.key}
                type="button"
                className={cx('ui-set-item', active && 'is-active')}
                aria-current={active ? 'page' : undefined}
                onClick={() => props.onSelect(p.key)}
              >
                {p.label}
              </button>
            );
          })}
        </nav>
        <div className="ui-set-body">
          <div className="ui-set-col">
            {props.title != null && (
              <h2 className="ui-set-title">{props.title}</h2>
            )}
            {props.children}
          </div>
        </div>
      </div>
    </>
  );
}

export function SettingsGroup(props: {
  title?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="ui-set-group">
      {props.title != null && <h3 className="ui-set-gt">{props.title}</h3>}
      <div className="ui-set-card">{props.children}</div>
    </section>
  );
}

export function SettingsRow(props: {
  title: React.ReactNode;
  description?: React.ReactNode;
  control?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="ui-set-row">
      <div className="ui-set-text">
        <div className="ui-set-rt">{props.title}</div>
        {props.description != null && (
          <div className="ui-set-rd">{props.description}</div>
        )}
      </div>
      {props.control != null && (
        <div className="ui-set-ctl">{props.control}</div>
      )}
    </div>
  );
}
