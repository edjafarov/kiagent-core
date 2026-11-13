// What a user can do to one source, shared by the list's panel and the
// source's page: the ··· menu, the remove confirmation and the one fix.
import React, { useEffect, useRef, useState } from 'react';
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

/** Runs a status's fix; reconnecting is the caller's flow. Resolves when
 *  the request is accepted (a sync is started, not finished). */
export function runFix(
  entry: SourceEntry,
  fix: SourceFix,
  onReconnect: () => void,
): Promise<void> {
  if (fix === 'reconnect') {
    onReconnect();
    return Promise.resolve();
  }
  if (fix === 'resume')
    return window.kiagent.invoke('accounts:resume', {
      accountId: entry.account.id,
    });
  return syncNow(entry.account.id);
}

const STATUS_MS = 2000;

/** A short confirmation line for actions that only start something. */
function useStatusLine(): {
  line: React.ReactElement;
  flash: (text: string) => void;
} {
  const [text, setText] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const flash = (next: string): void => {
    setText(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setText(''), STATUS_MS);
  };
  return {
    line: (
      <span role="status" className="t-meta">
        {text}
      </span>
    ),
    flash,
  };
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
  const { line, flash } = useStatusLine();
  return (
    <>
      {order.map((fix) => (
        <Button
          key={fix}
          size="sm"
          variant={
            fix === main && props.tone === 'err' ? 'primary' : 'secondary'
          }
          onAction={() =>
            runFix(props.entry, fix, props.onReconnect).then(() => {
              if (fix !== 'reconnect')
                flash(fix === 'resume' ? 'Resumed' : 'Sync started');
            })
          }
        >
          {FIX_WORDS[fix]}
        </Button>
      ))}
      {line}
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
  const { line, flash } = useStatusLine();
  const paused = a.status === 'paused';
  const items: MenuEntry[] = [
    {
      key: 'sync',
      label: 'Sync now',
      icon: 'refresh-cw',
      onSelect: () => void syncNow(a.id).then(() => flash('Sync started')),
    },
    {
      key: 'pause',
      label: paused ? 'Resume' : 'Pause',
      icon: paused ? 'play' : 'pause',
      onSelect: () =>
        void window.kiagent
          .invoke(paused ? 'accounts:resume' : 'accounts:pause', {
            accountId: a.id,
          })
          .then(() => flash(paused ? 'Resumed' : 'Paused')),
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
      {line}
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
