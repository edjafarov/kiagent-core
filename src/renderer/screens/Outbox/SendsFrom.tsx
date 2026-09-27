import React, { useEffect, useState } from 'react';
import {
  BrandMark,
  Card,
  CardHeader,
  EmptyState,
  Row,
  Rows,
  Status,
  sourceBrand,
} from '@shared/web-ui/ui';
import { useAppState } from '@renderer/state/app-state';

/** Sends from: every account whose source can send (bundled or extension
 *  senders, `outbox:sender-sources`), signed-out ones marked. */
export function SendsFrom(props: {
  sourceName: (sourceId: string) => string;
}): React.ReactElement {
  const entries = useAppState((s) => s.accounts);
  const accounts = entries.map((e) => e.account);
  const [sources, setSources] = useState<string[] | null>(null);

  useEffect(() => {
    void window.kiagent
      .invoke('outbox:sender-sources', undefined)
      .then(setSources)
      .catch(() => setSources([]));
  }, []);

  const senders =
    sources === null ? [] : accounts.filter((a) => sources.includes(a.source));

  return (
    <Card>
      <CardHeader label="Sends from" />
      {sources !== null && senders.length === 0 ? (
        <EmptyState>
          No account can send yet — connect an email or chat account in Sources.
        </EmptyState>
      ) : (
        <Rows aria-label="Accounts that can send">
          {senders.map((a) => {
            const name = props.sourceName(a.source);
            const out = a.status === 'needsReauth';
            return (
              <Row
                key={a.id}
                faint={out}
                lead={
                  <BrandMark
                    brand={sourceBrand(a.source, { name })}
                    faint={out}
                  />
                }
                title={name}
                trail={
                  out ? <Status tone="err">Signed out</Status> : a.identifier
                }
              />
            );
          })}
        </Rows>
      )}
    </Card>
  );
}
