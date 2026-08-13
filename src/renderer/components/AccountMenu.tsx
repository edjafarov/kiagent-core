import React, { useEffect, useRef, useState } from 'react';
import type { Identity } from '@shared/contracts';
import { Icon } from '@shared/web-ui/icon-sprite';

/**
 * Bottom-left account chip + popover (spec §4). The open-source build has no
 * sign-out concept — the menu carries Settings only. The KIAgent product
 * overlay SHADOWS this file to add "Log out" via its `auth:sign-out` IPC, so
 * the export name and AccountMenuProps are a frozen cross-repo interface.
 */
export interface AccountMenuProps {
  identity: Identity;
  collapsed: boolean;
  onOpenSettings: () => void;
}

export function AccountMenu(props: AccountMenuProps): React.ReactElement {
  const { identity, collapsed, onOpenSettings } = props;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const initial = (
    identity.name.trim()[0] ??
    identity.emails[0]?.trim()[0] ??
    '?'
  ).toUpperCase();
  const primary = identity.name || identity.emails[0] || '—';

  return (
    <div className="kg-acct" ref={rootRef}>
      {open && (
        <div className="kg-acct-menu" aria-label="Account">
          <div className="kg-acct-menu-head">
            <div className="kg-acct-menu-name">{primary}</div>
            {identity.emails[0] && (
              <div className="kg-acct-menu-mail">{identity.emails[0]}</div>
            )}
          </div>
          <button
            type="button"
            className="kg-acct-menu-item"
            onClick={() => {
              setOpen(false);
              onOpenSettings();
            }}
          >
            <Icon name="settings" size={13} />
            <span>Settings</span>
          </button>
        </div>
      )}
      <button
        type="button"
        className="kg-acct-chip"
        aria-label="Account menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="kg-acct-avatar" aria-hidden="true">
          {identity.avatarUrl ? (
            <img src={identity.avatarUrl} alt="" />
          ) : (
            initial
          )}
        </span>
        {!collapsed && (
          <>
            <span className="kg-acct-who">
              <span className="kg-acct-name">{primary}</span>
              {identity.emails[0] && (
                <span className="kg-acct-mail">{identity.emails[0]}</span>
              )}
            </span>
            <Icon name="chev-down" size={11} />
          </>
        )}
      </button>
    </div>
  );
}
