import React from 'react';
import type { Identity } from '@shared/contracts';
import { Avatar, cx } from '@shared/web-ui/ui';
import { Icon } from '@shared/web-ui/icon-sprite';

/**
 * The account row in the sidebar foot: avatar, name and a gear drawn as one
 * button that opens Settings. It stays highlighted while Settings is open.
 * Signing out lives in Settings (a build adds it to the pane list's foot).
 *
 * Not shadowed: both builds' sidebars render it.
 */
export interface AccountRowProps {
  identity: Identity;
  collapsed: boolean;
  onOpenSettings: () => void;
  /** Settings is the current page. */
  active?: boolean;
}

export function AccountRow(props: AccountRowProps): React.ReactElement {
  const { identity, collapsed, onOpenSettings, active = false } = props;
  const primary = identity.name || identity.emails[0] || '—';
  const email = identity.emails[0];

  return (
    <button
      type="button"
      className={cx('ui-acct', active && 'is-active')}
      aria-label={`Settings — ${primary}`}
      aria-current={active ? 'page' : undefined}
      title={collapsed ? 'Settings' : undefined}
      onClick={() => onOpenSettings()}
    >
      <Avatar
        name={identity.name || email || '?'}
        imageUrl={identity.avatarUrl}
      />
      {!collapsed && <span className="ui-acct-name">{primary}</span>}
      {!collapsed && <Icon name="settings" size={16} />}
    </button>
  );
}
