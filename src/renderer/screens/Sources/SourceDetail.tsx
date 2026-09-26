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
import { useAppState } from '@renderer/state/app-state';
import { AddSourcePanel } from './AddSourcePanel';
import { sourceLabel } from './connector-meta';
import { accountLabel, formatRelative } from './format';
import {
  FIX_WORDS,
  RemoveSourceSheet,
  SourceMenu,
  runFix,
  type SourceEntry,
} from './source-actions';
import { sourceStatus, type SourceFix } from './source-status';
import { useSourceDescriptors } from './sources-registry';
import { TrackedFolders } from './sections/TrackedFolders';
import { TrackedContent } from './sections/TrackedContent';
import { Cadence } from './sections/Cadence';
import { ConnectorConfig } from './sections/ConnectorConfig';
import { Outbound } from './sections/Outbound';
import { RecentActivity } from './sections/RecentActivity';
import './SourceDetail.css';

const PROBLEM: Record<SourceFix, { kind: string; title: string; sub: string }> =
  {
    reconnect: {
      kind: 'Error',
      title: 'Signed out',
      sub: 'Nothing new arrives until you sign in again. What’s already here stays searchable.',
    },
    retry: {
      kind: 'Error',
      title: 'Stopped by an error',
      sub: 'Nothing new arrives until it runs again.',
    },
    resume: {
      kind: 'Paused',
      title: 'Paused',
      sub: 'Nothing new arrives until you resume it.',
    },
  };

function Problem(props: {
  entry: SourceEntry;
  onReconnect: () => void;
}): React.ReactElement | null {
  const a = props.entry.account;
  const { fix, tone } = sourceStatus(a);
  if (fix === null) return null;
  const words = PROBLEM[fix];
  return (
    <AttentionList aria-label="Needs you">
      <AttentionRow
        tone={tone === 'err' ? 'err' : 'work'}
        kind={words.kind}
        title={words.title}
        sub={fix === 'retry' && a.lastError ? a.lastError : words.sub}
        action={
          <>
            {/* R4: an error can be a dead sign-in, so it can also sign in
                again. */}
            {fix === 'retry' && (
              <Button size="sm" onClick={props.onReconnect}>
                {FIX_WORDS.reconnect}
              </Button>
            )}
            <Button
              size="sm"
              variant="primary"
              onClick={() => runFix(props.entry, fix, props.onReconnect)}
            >
              {FIX_WORDS[fix]}
            </Button>
          </>
        }
      />
    </AttentionList>
  );
}

function RemoveCard(props: {
  entry: SourceEntry;
  name: string;
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
}): React.ReactElement {
  const entry = useAppState((s) =>
    s.accounts.find((a) => a.account.id === props.accountId),
  );
  const descriptors = useSourceDescriptors();
  const [view, setView] = useState<'page' | 'items' | 'reconnect'>('page');

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
      actions={<SourceMenu entry={entry} name={name} withRemove={false} />}
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
                summary="settings, recent activity"
              >
                <ConnectorConfig account={a} />
                <RecentActivity account={a} recent={entry.recent} />
              </Disclosure>
              <RemoveCard entry={entry} name={name} />
            </>
          )}
        </Stack>
      </div>
    </Page>
  );
}
