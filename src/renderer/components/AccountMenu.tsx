import React, { useRef, useState } from 'react';
import type { Identity } from '@shared/contracts';
import { Avatar, IconButton, Menu } from '@shared/web-ui/ui';

/**
 * The account row in the sidebar foot: avatar and name open the account
 * menu, the gear opens Settings directly. The open-source build has no
 * sign-out concept — the menu carries Settings only. The KIAgent product
 * overlay SHADOWS this file to add "Log out", so the export name and
 * AccountMenuProps are a frozen cross-repo interface.
 */
export interface AccountMenuProps {
  identity: Identity;
  collapsed: boolean;
  onOpenSettings: () => void;
}

export function AccountMenu(props: AccountMenuProps): React.ReactElement {
  const { identity, collapsed, onOpenSettings } = props;
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
        onClick={() => setOpen((v) => !v)}
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
        ]}
      />
    </div>
  );
}
