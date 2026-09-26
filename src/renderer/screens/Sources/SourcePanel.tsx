import React, { useState } from 'react';
import {
  Button,
  EntityHeading,
  KeyValue,
  Panel,
  Status,
  TextButton,
  sourceBrand,
  type KeyValueItem,
} from '@shared/web-ui/ui';
import { sourceLabel } from './connector-meta';
import { folderRoots } from './folder-roots';
import { accountLabel, describeCadence, formatRelative } from './format';
import { sourceStatus } from './source-status';
import { useSourceDescriptors } from './sources-registry';
import {
  FIX_WORDS,
  SourceMenu,
  runFix,
  type SourceEntry,
} from './source-actions';

/** What is wrong, in words, and the one thing that fixes it. */
export function SourceProblem(props: {
  entry: SourceEntry;
  onReconnect: () => void;
}): React.ReactElement | null {
  const a = props.entry.account;
  const status = sourceStatus(a);
  const [why, setWhy] = useState(false);
  if (status.label === null || status.fix === null) return null;
  const { fix } = status;
  return (
    <div className="src-problem">
      <Status tone={status.tone}>{status.label}</Status>
      <div className="src-problem-acts">
        <Button
          size="sm"
          variant={status.tone === 'err' ? 'primary' : 'secondary'}
          onClick={() => runFix(props.entry, fix, props.onReconnect)}
        >
          {FIX_WORDS[fix]}
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
  entry: SourceEntry;
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
