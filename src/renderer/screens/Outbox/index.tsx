import React from 'react';
import {
  Busy,
  Button,
  EmptyState,
  Page,
  Split,
  Stack,
  useNow,
} from '@shared/web-ui/ui';
import { sourceLabel } from '@renderer/screens/Sources/connector-meta';
import { useSourceDescriptors } from '@renderer/screens/Sources/sources-registry';
import { History } from './History';
import { useOutbox } from './use-outbox';
import { useRowAction } from './use-row-action';
import { WaitingDrafts } from './WaitingDrafts';
import './Outbox.css';

const PROMISE = 'nothing is sent until you confirm it';

export function outboxMeta(waiting: number): string {
  if (waiting === 0) return `Nothing waiting · ${PROMISE}`;
  return `${waiting} ${waiting === 1 ? 'draft' : 'drafts'} waiting · ${PROMISE}`;
}

/**
 * The Outbox: drafts waiting for the user, then everything sent or not sent
 * in day groups; on the side, how drafts are confirmed and which accounts
 * can send.
 */
export function Outbox(): React.ReactElement {
  const { rows, loadFailed, reload } = useOutbox();
  const actions = useRowAction(reload);
  const now = useNow(30_000);
  const descriptors = useSourceDescriptors();
  const sourceName = (id: string) => sourceLabel(id, descriptors);

  // Until the review sheet lands, a message opens on its browser page.
  const open = (draftId: string) =>
    void actions.run(draftId, () =>
      window.kiagent.invoke('outbox:open-confirm', { draftId }),
    );

  const waiting = rows?.filter((r) => r.status === 'draft') ?? [];
  const past = rows?.filter((r) => r.status !== 'draft') ?? [];

  let body: React.ReactNode;
  if (rows === null) body = <Busy label="Loading the outbox…" />;
  else if (loadFailed && rows.length === 0)
    body = (
      <EmptyState
        action={
          <Button size="sm" onClick={reload}>
            Try again
          </Button>
        }
      >
        Couldn’t load the outbox.
      </EmptyState>
    );
  else
    body = (
      <Stack gap="page">
        {waiting.length > 0 && (
          <WaitingDrafts
            rows={waiting}
            sourceName={sourceName}
            actions={actions}
            onReview={open}
          />
        )}
        <History
          rows={past}
          now={now}
          sourceName={sourceName}
          actions={actions}
          onOpen={open}
        />
      </Stack>
    );

  return (
    <Page
      title="Outbox"
      meta={rows === null ? undefined : outboxMeta(waiting.length)}
    >
      <Split aside="sm" side={null}>
        {body}
      </Split>
    </Page>
  );
}
