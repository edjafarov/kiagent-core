import React, { useEffect, useState } from 'react';
import {
  Busy,
  Button,
  EmptyState,
  Page,
  Split,
  Stack,
  Status,
  useNow,
} from '@shared/web-ui/ui';
import { sourceLabel } from '@renderer/screens/Sources/connector-meta';
import { useSourceDescriptors } from '@renderer/screens/Sources/sources-registry';
import { useView } from '@renderer/state/view';
import { ConfirmModeCard } from './ConfirmModeCard';
import { History } from './History';
import { ReviewSheet } from './ReviewSheet';
import { SendsFrom } from './SendsFrom';
import { useOutbox } from './use-outbox';
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
 * can send. A message opens in the review sheet — from a row, or by link
 * (`draft=<id>`, e.g. Home's Review).
 */
export function Outbox(): React.ReactElement {
  const outbox = useOutbox();
  const { rows, loadFailed, reload } = outbox;
  const now = useNow(30_000);
  const descriptors = useSourceDescriptors();
  const sourceName = (id: string) => sourceLabel(id, descriptors);
  const { params, replaceParams } = useView();
  const [open, setOpen] = useState<string | null>(params.draft ?? null);

  useEffect(() => {
    if (!params.draft) return;
    const { draft, ...rest } = params;
    setOpen(draft);
    replaceParams(rest);
    // Params only: a link is read once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const waiting = rows?.filter((r) => r.status === 'draft') ?? [];
  const past = rows?.filter((r) => r.status !== 'draft') ?? [];
  const retry = (
    <Button size="sm" onClick={reload}>
      Try again
    </Button>
  );

  let body: React.ReactNode;
  if (rows === null) body = <Busy label="Loading the outbox…" />;
  else if (loadFailed && rows.length === 0)
    body = <EmptyState action={retry}>Couldn’t load the outbox.</EmptyState>;
  else
    body = (
      <Stack gap="page">
        {loadFailed && (
          <div className="ob-stale">
            <Status tone="err">
              Couldn’t refresh — this may be out of date
            </Status>
            {retry}
          </div>
        )}
        {waiting.length > 0 && (
          <WaitingDrafts
            rows={waiting}
            sourceName={sourceName}
            actions={outbox}
            onReview={setOpen}
          />
        )}
        <History
          rows={past}
          now={now}
          sourceName={sourceName}
          actions={outbox}
          onOpen={setOpen}
        />
      </Stack>
    );

  const known = rows !== null && !(loadFailed && rows.length === 0);
  return (
    <Page title="Outbox" meta={known ? outboxMeta(waiting.length) : undefined}>
      <Split
        aside="sm"
        side={
          <Stack gap="page">
            <ConfirmModeCard />
            <SendsFrom sourceName={sourceName} />
          </Stack>
        }
      >
        {body}
      </Split>
      {open && (
        <ReviewSheet
          key={open}
          draftId={open}
          sourceName={sourceName}
          onOpen={setOpen}
          onClose={() => setOpen(null)}
        />
      )}
    </Page>
  );
}
