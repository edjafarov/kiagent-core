import React, { useRef, useState } from 'react';
import type { Identity } from '@shared/contracts';
import { Avatar, IconButton, Menu, type MenuEntry } from '@shared/web-ui/ui';

/**
 * The account row in the sidebar foot: avatar and name open the account
 * menu, the gear opens Settings directly. The menu always starts with
 * Settings; a build adds its own entries after it (the KIAgent product adds
 * Log out) and may show a footer line (e.g. a sign-out error).
 *
 * Not shadowed: both builds' `AccountMenu` wrap this.
 */
export interface AccountRowProps {
  identity: Identity;
  collapsed: boolean;
  onOpenSettings: () => void;
  /** Entries after Settings. */
  extraItems?: readonly MenuEntry[];
  /** A line under the menu items. */
  footer?: React.ReactNode;
  /** Called when the menu opens (e.g. to drop a stale error). */
  onOpen?: () => void;
}

export function AccountRow(props: AccountRowProps): React.ReactElement {
  const {
    identity,
    collapsed,
    onOpenSettings,
    extraItems = [],
    footer,
    onOpen,
  } = props;
  const [open, setOpen] = useState(false);
  const whoRef = useRef<HTMLButtonElement>(null);
  const primary = identity.name || identity.emails[0] || '—';
  const email = identity.emails[0];

  return (
    <div className="ui-acct">
      <button
        ref={whoRef}
        type="button"
        className="ui-acct-who"
        aria-label="Account menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (!open) onOpen?.();
          setOpen(!open);
        }}
      >
        <Avatar
          name={identity.name || email || '?'}
          imageUrl={identity.avatarUrl}
        />
        {!collapsed && <span className="ui-acct-name">{primary}</span>}
      </button>
      <IconButton
        icon="settings"
        label="Settings"
        onClick={() => onOpenSettings()}
      />
      <Menu
        open={open}
        anchorRef={whoRef}
        onClose={() => setOpen(false)}
        aria-label="Account"
        placement="top-start"
        header={
          <>
            <div className="ui-acct-hn">{primary}</div>
            {email && <div className="ui-acct-he">{email}</div>}
          </>
        }
        items={[
          {
            key: 'settings',
            label: 'Settings',
            icon: 'settings',
            onSelect: () => onOpenSettings(),
          },
          ...extraItems,
        ]}
        footer={footer}
      />
    </div>
  );
}
