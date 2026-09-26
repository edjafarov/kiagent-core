// What a user can do to one source, shared by the list's panel and the
// source's page: the ··· menu, the remove confirmation and the one fix.
import React, { useRef, useState } from 'react';
import type { AppState } from '@shared/contracts';
import {
  ConfirmSheet,
  IconButton,
  Menu,
  type MenuEntry,
} from '@shared/web-ui/ui';
import type { SourceFix } from './source-status';

export type SourceEntry = AppState['accounts'][number];

export const FIX_WORDS: Record<SourceFix, string> = {
  reconnect: 'Sign in again',
  retry: 'Retry',
  resume: 'Resume',
};

/** Runs a status's fix; reconnecting is the caller's flow. */
export function runFix(
  entry: SourceEntry,
  fix: SourceFix,
  onReconnect: () => void,
): void {
  if (fix === 'reconnect') {
    onReconnect();
    return;
  }
  void window.kiagent.invoke(
    fix === 'resume' ? 'accounts:resume' : 'accounts:sync-now',
    { accountId: entry.account.id },
  );
}

export function RemoveSourceSheet(props: {
  entry: SourceEntry;
  name: string;
  onClose: () => void;
}): React.ReactElement {
  const { entry, name } = props;
  return (
    <ConfirmSheet
      title={`Remove ${name}?`}
      confirmLabel="Remove"
      tone="danger"
      onConfirm={() =>
        window.kiagent.invoke('accounts:remove', {
          accountId: entry.account.id,
        })
      }
      onClose={props.onClose}
    >
      Its {entry.docCount.toLocaleString()} items are deleted from this
      computer. Nothing changes in {name} itself.
    </ConfirmSheet>
  );
}

/** A source's ··· menu: Sync now, Pause/Resume and, unless the page has its
 *  own Remove card, Remove. */
export function SourceMenu(props: {
  entry: SourceEntry;
  name: string;
  withRemove?: boolean;
}): React.ReactElement {
  const { entry, name, withRemove = true } = props;
  const a = entry.account;
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const paused = a.status === 'paused';
  const items: MenuEntry[] = [
    {
      key: 'sync',
      label: 'Sync now',
      icon: 'refresh-cw',
      onSelect: () =>
        void window.kiagent.invoke('accounts:sync-now', { accountId: a.id }),
    },
    {
      key: 'pause',
      label: paused ? 'Resume' : 'Pause',
      icon: paused ? 'play' : 'pause',
      onSelect: () =>
        void window.kiagent.invoke(
          paused ? 'accounts:resume' : 'accounts:pause',
          { accountId: a.id },
        ),
    },
    ...(withRemove
      ? ([
          'separator',
          {
            key: 'remove',
            label: 'Remove',
            icon: 'trash',
            danger: true,
            onSelect: () => setRemoving(true),
          },
        ] as MenuEntry[])
      : []),
  ];
  return (
    <>
      <IconButton
        ref={anchor}
        icon="more"
        label="Source actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      />
      <Menu
        open={open}
        anchorRef={anchor}
        onClose={() => setOpen(false)}
        items={items}
        aria-label="Source actions"
        placement="bottom-end"
      />
      {removing && (
        <RemoveSourceSheet
          entry={entry}
          name={name}
          onClose={() => setRemoving(false)}
        />
      )}
    </>
  );
}
