import React, { useRef, useState } from 'react';
import type { AppState } from '@shared/contracts';
import {
  Button,
  ConfirmSheet,
  EntityHeading,
  IconButton,
  KeyValue,
  Menu,
  Panel,
  Status,
  TextButton,
  sourceBrand,
  type KeyValueItem,
  type MenuEntry,
} from '@shared/web-ui/ui';
import { sourceLabel } from './connector-meta';
import { folderRoots } from './folder-roots';
import { accountLabel, describeCadence, formatRelative } from './format';
import { sourceStatus, type SourceFix } from './source-status';
import { useSourceDescriptors } from './sources-registry';

type Entry = AppState['accounts'][number];

const FIX_WORDS: Record<SourceFix, string> = {
  reconnect: 'Sign in again',
  retry: 'Retry',
  resume: 'Resume',
};

/** A source's ··· menu: Sync now, Pause/Resume, Remove (confirmed). */
export function SourceMenu(props: {
  entry: Entry;
  name: string;
}): React.ReactElement {
  const a = props.entry.account;
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
    'separator',
    {
      key: 'remove',
      label: 'Remove',
      icon: 'trash',
      danger: true,
      onSelect: () => setRemoving(true),
    },
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
        <ConfirmSheet
          title={`Remove ${props.name}?`}
          confirmLabel="Remove"
          tone="danger"
          onConfirm={() =>
            window.kiagent.invoke('accounts:remove', { accountId: a.id })
          }
          onClose={() => setRemoving(false)}
        >
          Its {props.entry.docCount.toLocaleString()} items are deleted from
          this computer. Nothing changes in {props.name} itself.
        </ConfirmSheet>
      )}
    </>
  );
}

/** What is wrong, in words, and the one thing that fixes it. */
export function SourceProblem(props: {
  entry: Entry;
  onReconnect: () => void;
}): React.ReactElement | null {
  const a = props.entry.account;
  const status = sourceStatus(a);
  const [why, setWhy] = useState(false);
  if (status.label === null || status.fix === null) return null;
  const fix = (): void => {
    if (status.fix === 'reconnect') props.onReconnect();
    else
      void window.kiagent.invoke(
        status.fix === 'resume' ? 'accounts:resume' : 'accounts:sync-now',
        { accountId: a.id },
      );
  };
  return (
    <div className="src-problem">
      <Status tone={status.tone}>{status.label}</Status>
      <div className="src-problem-acts">
        <Button
          size="sm"
          variant={status.tone === 'err' ? 'primary' : 'secondary'}
          onClick={fix}
        >
          {FIX_WORDS[status.fix]}
        </Button>
        {a.lastError && (
          <TextButton aria-expanded={why} onClick={() => setWhy((w) => !w)}>
            Why?
          </TextButton>
        )}
      </div>
      {why && a.lastError && <p className="src-problem-why">{a.lastError}</p>}
    </div>
  );
}

/** The selected source beside the list: who it is, what's wrong, the
 *  facts, and the way to its page. */
export function SourcePanel(props: {
  entry: Entry;
  onOpen: () => void;
  onReconnect: () => void;
}): React.ReactElement {
  const { entry } = props;
  const a = entry.account;
  const descriptors = useSourceDescriptors();
  const descriptor = descriptors?.find((d) => d.id === a.source);
  const name = sourceLabel(a.source, descriptors);
  const status = sourceStatus(a);
  const roots = descriptor?.folderScope ? folderRoots(a) : null;
  const facts: KeyValueItem[] = [
    {
      label: 'Items',
      value:
        status.importPercent != null
          ? `${entry.docCount.toLocaleString()} · importing, ${status.importPercent}%`
          : entry.docCount.toLocaleString(),
    },
    { label: 'Last item', value: formatRelative(entry.recent[0]?.ts) },
    {
      label: 'Checks',
      value: describeCadence(a.cadence ?? descriptor?.cadence),
    },
    ...(roots
      ? [
          {
            label: 'What’s tracked',
            value:
              roots.length === 0
                ? 'Nothing chosen yet'
                : roots.map((r) => r.name).join(', '),
          },
        ]
      : []),
  ];
  return (
    <Panel aria-label={name} className="src-panel">
      <EntityHeading
        brand={sourceBrand(a.source, { name })}
        title={name}
        meta={accountLabel(a)}
      >
        <SourceMenu entry={entry} name={name} />
      </EntityHeading>
      <SourceProblem entry={entry} onReconnect={props.onReconnect} />
      <KeyValue items={facts} />
      <div className="src-panel-foot">
        <TextButton onClick={props.onOpen}>Open {name}</TextButton>
      </div>
    </Panel>
  );
}
