import React from 'react';
import type { Identity } from '@shared/contracts';
import { AccountRow } from '@renderer/components/AccountRow';

/**
 * The account row in the sidebar foot (see AccountRow). The open-source
 * build has no sign-out concept — the menu carries Settings only. The
 * KIAgent product overlay SHADOWS this file to add "Log out", so the export
 * name and AccountMenuProps are a frozen cross-repo interface.
 */
export interface AccountMenuProps {
  identity: Identity;
  collapsed: boolean;
  onOpenSettings: () => void;
}

export function AccountMenu(props: AccountMenuProps): React.ReactElement {
  return <AccountRow {...props} />;
}
