// What a user can do to one source, shared by the list's panel and the
// source's page: the ··· menu, the remove confirmation and the one fix.
import React, { useRef, useState } from 'react';
import type { AccountId, AppState } from '@shared/contracts';
import {
  Button,
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

/** The one way to sync a source now: Sync now, Retry, Sync all and Run
 *  now all come here. */
export function syncNow(accountId: AccountId): Promise<void> {
  return window.kiagent.invoke('accounts:sync-now', { accountId });
}

/** Runs a status's fix; reconnecting is the caller's flow. */
export function runFix(
  entry: SourceEntry,
  fix: SourceFix,
  onReconnect: () => void,
): void {
  if (fix === 'reconnect') onReconnect();
  else if (fix === 'resume')
    void window.kiagent.invoke('accounts:resume', {
      accountId: entry.account.id,
    });
  else void syncNow(entry.account.id);
}

/** A status's fixes as buttons; the main one is primary. The page's
 *  attention row puts it last (at the row's end), the panel first. */
export function FixButtons(props: {
  entry: SourceEntry;
  fixes: readonly SourceFix[];
  tone: 'err' | 'other';
  onReconnect: () => void;
  primaryLast?: boolean;
}): React.ReactElement {
  const [main] = props.fixes;
  const order = props.primaryLast ? [...props.fixes].reverse() : props.fixes;
  return (
    <>
      {order.map((fix) => (
        <Button
          key={fix}
          size="sm"
          variant={
            fix === main && props.tone === 'err' ? 'primary' : 'secondary'
          }
          onClick={() => runFix(props.entry, fix, props.onReconnect)}
        >
          {FIX_WORDS[fix]}
        </Button>
      ))}
    </>
  );
}

export function RemoveSourceSheet(props: {
  entry: SourceEntry;
  name: string;
  onClose: () => void;
  /** After the source is gone; the source's page goes back with it. */
  onDone?: () => void;
}): React.ReactElement {
  const { entry, name } = props;
  return (
    <ConfirmSheet
      title={`Remove ${name}?`}
      confirmLabel="Remove"
      busyLabel="Removing…"
      tone="danger"
      onConfirm={async () => {
        await window.kiagent.invoke('accounts:remove', {
          accountId: entry.account.id,
        });
        props.onDone?.();
      }}
      onClose={props.onClose}
    >
      Its {entry.docCount.toLocaleString()} items are deleted from this
      computer. Nothing changes in {name} itself. A large source can take a few
      minutes.
    </ConfirmSheet>
  );
}

/** A source's ··· menu: Sync now, Pause/Resume, Reconnect when the caller
 *  offers it (the source can re-authenticate — a healthy account too, e.g.
 *  to grant a scope a newer connector asks for) and, unless the page has its
 *  own Remove card, Remove. */
export function SourceMenu(props: {
  entry: SourceEntry;
  name: string;
  withRemove?: boolean;
  onReconnect?: () => void;
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
      onSelect: () => void syncNow(a.id),
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
    ...(props.onReconnect
      ? [
          {
            key: 'reconnect',
            label: 'Reconnect',
            icon: 'refresh-cw',
            onSelect: props.onReconnect,
          },
        ]
      : []),
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
