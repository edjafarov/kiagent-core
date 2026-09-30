import React, { useState } from 'react';
import type { AccountId } from '@shared/contracts';
import {
  AttentionList,
  AttentionRow,
  Button,
  Card,
  CardHeader,
  Disclosure,
  EmptyState,
  EntityHeading,
  Page,
  Row,
  Rows,
  Stack,
  TextButton,
  sourceBrand,
} from '@shared/web-ui/ui';
import { AddSourcePanel } from './AddSourcePanel';
import { sourceLabel } from './source-label';
import { accountLabel, formatRelative } from './format';
import {
  FixButtons,
  RemoveSourceSheet,
  SourceMenu,
  type SourceEntry,
} from './source-actions';
import { sourceStatus } from './source-status';
import { useSourceDescriptors, useVisibleAccounts } from './sources-registry';
import { TrackedFolders } from './sections/TrackedFolders';
import { TrackedContent } from './sections/TrackedContent';
import { Cadence } from './sections/Cadence';
import { ConnectorConfig } from './sections/ConnectorConfig';
import { Outbound } from './sections/Outbound';
import { RecentActivity } from './sections/RecentActivity';
import './SourceDetail.css';

function Problem(props: {
  entry: SourceEntry;
  onReconnect: () => void;
}): React.ReactElement | null {
  const { problem, tone, fixes } = sourceStatus(props.entry.account);
  if (problem === null) return null;
  return (
    <AttentionList aria-label="Needs you">
      <AttentionRow
        tone={tone === 'err' ? 'err' : 'work'}
        kind={problem.kind}
        title={problem.title}
        sub={problem.sub}
        action={
          <FixButtons
            entry={props.entry}
            fixes={fixes}
            tone={tone === 'err' ? 'err' : 'other'}
            onReconnect={props.onReconnect}
            primaryLast
          />
        }
      />
    </AttentionList>
  );
}

function RemoveCard(props: {
  entry: SourceEntry;
  name: string;
  onDone: () => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <CardHeader label="Remove" />
      <Rows>
        <Row
          size={42}
          title="Remove this source"
          sub={`Deletes its ${props.entry.docCount.toLocaleString()} items from this computer. Nothing changes in ${props.name} itself.`}
          trail={
            <Button size="sm" variant="danger" onClick={() => setOpen(true)}>
              Remove…
            </Button>
          }
        />
      </Rows>
      {open && (
        <RemoveSourceSheet
          entry={props.entry}
          name={props.name}
          onClose={() => setOpen(false)}
          onDone={props.onDone}
        />
      )}
    </Card>
  );
}

/**
 * A source's page: who it is and how much it holds, what needs you, what
 * it tracks, how often it syncs, its items, the technical details and
 * Remove. Signing in again runs the wizard in place.
 */
export function SourceDetail(props: {
  accountId: AccountId;
  onBack: () => void;
  /** Opens straight into signing in again. */
  reconnect?: boolean;
}): React.ReactElement {
  const entry = useVisibleAccounts().find(
    (a) => a.account.id === props.accountId,
  );
  const descriptors = useSourceDescriptors();
  const [view, setView] = useState<'page' | 'items' | 'reconnect'>(
    props.reconnect ? 'reconnect' : 'page',
  );

  if (!entry) {
    return (
      <Page
        crumb={{ parent: 'Sources', current: 'Source', onBack: props.onBack }}
      >
        <EmptyState>This source was removed.</EmptyState>
      </Page>
    );
  }

  const a = entry.account;
  const name = sourceLabel(a.source, descriptors);
  const descriptor = descriptors?.find((d) => d.id === a.source);
  const status = sourceStatus(a);
  const toPage = (): void => setView('page');

  if (view === 'items') {
    return (
      <Page crumb={{ parent: name, current: 'Items', onBack: toPage }}>
        <TrackedContent account={a} />
      </Page>
    );
  }

  const meta = [
    `${entry.docCount.toLocaleString()} items`,
    status.label
      ? status.label.toLowerCase()
      : `last item ${formatRelative(entry.recent[0]?.ts)}`,
  ].join(' · ');

  return (
    <Page
      crumb={{ parent: 'Sources', current: name, onBack: props.onBack }}
      actions={
        <SourceMenu
          entry={entry}
          name={name}
          withRemove={false}
          onReconnect={
            descriptor?.hasReauthenticate
              ? () => setView('reconnect')
              : undefined
          }
        />
      }
    >
      <div className="src-detail">
        <Stack gap="page">
          <div>
            <EntityHeading
              size="page"
              brand={sourceBrand(a.source, { name })}
              title={name}
              meta={accountLabel(a)}
            />
            <p className="src-detail-meta">{meta}</p>
          </div>
          {view === 'reconnect' ? (
            <AddSourcePanel
              reconnect={{
                accountId: a.id,
                sourceId: a.source,
                identifier: a.identifier,
              }}
              onDone={toPage}
            />
          ) : (
            <>
              <Problem entry={entry} onReconnect={() => setView('reconnect')} />
              {descriptor?.folderScope === true && (
                <TrackedFolders account={a} />
              )}
              <Cadence account={a} />
              {a.source === 'imap' && <Outbound account={a} />}
              <div>
                <TextButton onClick={() => setView('items')}>
                  Browse {entry.docCount.toLocaleString()} items →
                </TextButton>
              </div>
              <Disclosure
                label="Technical details"
                summary="settings, recent activity, sync position"
              >
                <ConnectorConfig account={a} />
                <RecentActivity account={a} recent={entry.recent} />
                <section className="src-tech" aria-labelledby="src-cursor-lbl">
                  <h3 id="src-cursor-lbl" className="src-tech-lbl">
                    Sync position
                  </h3>
                  <code className="src-cursor">
                    {a.cursor == null
                      ? 'Not started'
                      : JSON.stringify(a.cursor)}
                  </code>
                </section>
              </Disclosure>
              <RemoveCard entry={entry} name={name} onDone={props.onBack} />
            </>
          )}
        </Stack>
      </div>
    </Page>
  );
}
