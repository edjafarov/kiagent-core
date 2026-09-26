import React from 'react';
import { Icon } from '../icon-sprite';
import { cx } from './cx';
import { TopBar } from './layout';

export type Platform = 'mac' | 'win' | 'linux';

export function detectPlatform(
  platform: string = typeof navigator !== 'undefined' ? navigator.platform : '',
): Platform {
  if (/Mac/i.test(platform)) return 'mac';
  if (/Win/i.test(platform)) return 'win';
  return 'linux';
}

/** What copy calls this machine: "Mac" on macOS, else "computer". */
export function computerNoun(
  platform: Platform = detectPlatform(),
): 'Mac' | 'computer' {
  return platform === 'mac' ? 'Mac' : 'computer';
}

/** The window: sidebar + one main area. `.ac` stays the root class so the
 *  `.ac *` box-sizing rule covers every screen, sheet and menu. */
export function AppShell(props: {
  sidebar: React.ReactNode;
  children: React.ReactNode;
  platform?: Platform;
}): React.ReactElement {
  const platform = props.platform ?? detectPlatform();
  return (
    <div className={cx('ac', 'ui-shell', `is-${platform}`)}>
      {props.sidebar}
      <main className="ui-main">{props.children}</main>
    </div>
  );
}

export function SidebarFrame(props: {
  brand: React.ReactNode;
  children: React.ReactNode;
  foot?: React.ReactNode;
}): React.ReactElement {
  return (
    <aside className="ui-sidebar">
      <div className="ui-sidebar-head">
        <span className="ui-brand">{props.brand}</span>
      </div>
      <nav className="ui-nav" aria-label="Main">
        {props.children}
      </nav>
      {props.foot != null && (
        <div className="ui-sidebar-foot">{props.foot}</div>
      )}
    </aside>
  );
}

/** A group of nav items; groups are separated by space, not labels. */
export function NavGroup(props: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="ui-nav-group" role="group" aria-label={props.label}>
      {props.children}
    </div>
  );
}

export type NavDotTone = 'ok' | 'work' | 'err' | 'off';

export function NavItem(props: {
  label: string;
  icon: string;
  active: boolean;
  onClick: () => void;
  count?: number;
  /** What the count means, read after the number. */
  countLabel?: string;
  dot?: { tone: NavDotTone; label: string };
  title?: string;
}): React.ReactElement {
  const {
    label,
    icon,
    active,
    onClick,
    count,
    countLabel = 'needs you',
    dot,
    title,
  } = props;
  const hasCount = count !== undefined && count > 0;
  const name = hasCount
    ? `${label}, ${count} ${countLabel}`
    : dot
      ? `${label} ${dot.label}`
      : label;
  return (
    <button
      type="button"
      className={cx('ui-nav-item', active && 'is-active')}
      aria-label={name}
      aria-current={active ? 'page' : undefined}
      title={title}
      onClick={onClick}
    >
      <Icon name={icon} size={16} />
      <span className="ui-nav-label">{label}</span>
      {hasCount ? (
        <span className="ui-nav-count" aria-hidden="true">
          {count > 99 ? '99+' : count}
        </span>
      ) : (
        dot && (
          <span
            className={cx('ui-nav-dot', `is-${dot.tone}`)}
            aria-hidden="true"
          />
        )
      )}
    </button>
  );
}

/** The frame for a screen that does not render its own page: the app's top
 *  bar with the view title, and the screen in an unpadded column. */
export function HostFrame(props: {
  title?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <>
      <TopBar title={props.title} />
      <div className="ui-legacy">{props.children}</div>
    </>
  );
}
