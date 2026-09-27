import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Account, AccountId, AppState } from '@shared/contracts';
import {
  BrandGlyph,
  Busy,
  Button,
  Chip,
  DataTable,
  EmptyState,
  IconButton,
  Menu,
  Page,
  ProgressBar,
  Segmented,
  Split,
  Status,
  TextButton,
  sourceBrand,
  sourceCategory,
  SOURCE_CATEGORIES,
  type DataColumn,
  type SegmentedItem,
  type SourceCategory,
} from '@shared/web-ui/ui';
import { Icon } from '@shared/web-ui/icon-sprite';
import { useAppState } from '@renderer/state/app-state';
import { sourceLabel } from './source-label';
import { accountLabel, formatRelativeCompact } from './format';
import { GetStartedPanel } from './GetStartedPanel';
import { SourcePanel } from './SourcePanel';
import { syncNow } from './source-actions';
import { needsYou, sourceStatus } from './source-status';
import {
  useSourceDescriptors,
  useSourcesPolicy,
  useVisibleAccounts,
} from './sources-registry';
import { useCatalog } from './use-catalog';
import './SourcesList.css';

type Entry = AppState['accounts'][number];
type Filter = 'all' | SourceCategory;

/** The list's filter and selected source, kept by the screen so a trip to
 *  a source's page comes back to the same place. */
export interface ListSelection {
  filter: Filter;
  /** `null` until the default is committed. */
  picked: AccountId | null;
}

export const INITIAL_SELECTION: ListSelection = { filter: 'all', picked: null };

const ADD_MORE_MAX = 5;

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** "13 sources · 335,550 items · 1 needs you", zero parts dropped. */
function metaLine(entries: readonly Entry[]): string {
  const items = entries.reduce((n, e) => n + e.docCount, 0);
  const needs = entries.filter((e) => needsYou(e.account)).length;
  return [
    entries.length > 0 ? plural(entries.length, 'source') : null,
    items > 0 ? plural(items, 'item') : null,
    needs > 0 ? `${needs} needs you` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** The first row needing you, else the first row. */
function defaultSelection(rows: readonly Entry[]): AccountId | null {
  return (rows.find((e) => needsYou(e.account)) ?? rows[0])?.account.id ?? null;
}

function SourceCell(props: { entry: Entry }): React.ReactElement {
  const a = props.entry.account;
  const name = sourceLabel(a.source, useSourceDescriptors());
  return (
    <span className="src-cell">
      <BrandGlyph size={20} brand={sourceBrand(a.source, { name })} />
      <span className="src-cell-name">{name}</span>
      <span className="src-cell-sub">{accountLabel(a)}</span>
    </span>
  );
}

function ItemsCell(props: { entry: Entry }): React.ReactElement {
  const { account, docCount } = props.entry;
  const pct = sourceStatus(account).importPercent;
  return (
    <span className="src-items">
      <span className="src-num">{docCount.toLocaleString()}</span>
      {pct != null && (
        <>
          <span className="src-bar">
            <ProgressBar
              aria-label="First import"
              value={pct / 100}
              brand={sourceBrand(account.source).color ?? undefined}
            />
          </span>
          <span className="src-pct">{pct}%</span>
        </>
      )}
    </span>
  );
}

/** The last item's time, or the status when something is off. */
function LastCell(props: { entry: Entry }): React.ReactElement {
  const s = sourceStatus(props.entry.account);
  return s.label ? (
    <Status tone={s.tone}>{s.label}</Status>
  ) : (
    <span className="src-when">
      {formatRelativeCompact(props.entry.recent[0]?.ts)}
    </span>
  );
}

const COLUMNS: DataColumn<Entry>[] = [
  { key: 'source', header: 'Source', cell: (e) => <SourceCell entry={e} /> },
  {
    key: 'items',
    header: 'Items',
    width: '180px',
    align: 'right',
    cell: (e) => <ItemsCell entry={e} />,
  },
  {
    key: 'last',
    header: 'Last item',
    width: '120px',
    cell: (e) => <LastCell entry={e} />,
  },
];

function SyncAllMenu(props: {
  accounts: readonly Account[];
}): React.ReactElement {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <IconButton
        ref={anchor}
        icon="more"
        label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      />
      <Menu
        open={open}
        anchorRef={anchor}
        onClose={() => setOpen(false)}
        aria-label="More actions"
        placement="bottom-end"
        items={[
          {
            key: 'sync-all',
            label: 'Sync all',
            icon: 'refresh-cw',
            disabled: props.accounts.length === 0,
            // Syncing takes one account: fan out.
            onSelect: () => {
              for (const a of props.accounts) void syncNow(a.id);
            },
          },
        ]}
      />
    </>
  );
}

/** What else can be added — sources not connected yet, then store
 *  extensions — a few, then the whole catalog. */
function AddMore(props: {
  onCatalog: (install?: string) => void;
  onConnect: (sourceId: string) => void;
}): React.ReactElement | null {
  const catalog = useCatalog();
  const store = catalog.store ?? [];
  const unconnected = (catalog.sources ?? []).filter(
    (t) => t.footer.kind !== 'connected',
  );
  const tiles = [...unconnected, ...store].slice(0, ADD_MORE_MAX);
  if (tiles.length === 0) return null;
  const total = (catalog.sources?.length ?? 0) + store.length;
  return (
    <section className="src-more" aria-labelledby="src-more-lbl">
      <div className="src-more-hd">
        <h2 id="src-more-lbl" className="ui-card-lbl">
          Add more
        </h2>
        <TextButton onClick={() => props.onCatalog()}>
          All {total} sources
        </TextButton>
      </div>
      <div className="src-more-chips">
        {tiles.map((t) => (
          <Chip
            key={t.key}
            brand={t.brand}
            name={t.name}
            action="Add"
            onClick={() =>
              'sourceId' in t.start
                ? props.onConnect(t.start.sourceId)
                : props.onCatalog(`${t.start.item.owner}/${t.start.item.repo}`)
            }
          />
        ))}
      </div>
    </section>
  );
}

/**
 * The Sources page: every connected source by category, the selected one
 * in a panel beside the table, and what else can be added.
 */
export function SourcesList(props: {
  selection: ListSelection;
  onSelection: (next: ListSelection) => void;
  onOpenDetail: (accountId: AccountId) => void;
  onOpenConnection: () => void;
  /** Opens the catalog; with `owner/repo`, on that item's install sheet. */
  onCatalog: (install?: string) => void;
  /** Starts connecting a source that ships with the app or is installed. */
  onConnect: (sourceId: string) => void;
  /** Signs in again to THIS account (on its page). */
  onReconnect: (accountId: AccountId) => void;
}): React.ReactElement {
  const { showGetStarted } = useSourcesPolicy();
  const entries = useVisibleAccounts();
  const ready = useAppState((s) => s.ready);
  const { selection, onSelection } = props;
  const { filter, picked } = selection;

  const counts = useMemo(() => {
    const m = new Map<SourceCategory, number>();
    for (const e of entries) {
      const c = sourceCategory(e.account.source);
      m.set(c, (m.get(c) ?? 0) + 1);
    }
    return m;
  }, [entries]);
  const tabs: SegmentedItem<Filter>[] = [
    { key: 'all', label: 'All', count: entries.length },
    ...SOURCE_CATEGORIES.filter((c) => counts.has(c.key)).map((c) => ({
      key: c.key,
      label: c.label,
      count: counts.get(c.key),
    })),
  ];
  const active: Filter =
    filter === 'all' || counts.has(filter) ? filter : 'all';
  const rows =
    active === 'all'
      ? entries
      : entries.filter((e) => sourceCategory(e.account.source) === active);
  // Held while its account is on screen; otherwise the default, committed
  // once so a later status change doesn't move it.
  const selectedId = rows.some((e) => e.account.id === picked)
    ? picked
    : defaultSelection(rows);
  const selected = rows.find((e) => e.account.id === selectedId) ?? null;
  useEffect(() => {
    if (selectedId !== picked) onSelection({ filter, picked: selectedId });
  }, [selectedId, picked, filter, onSelection]);

  let body: React.ReactNode;
  if (entries.length === 0) {
    body = ready ? (
      <EmptyState
        action={
          <Button variant="primary" onClick={() => props.onCatalog()}>
            Add source
          </Button>
        }
      >
        No sources connected yet — add one to get started.
      </EmptyState>
    ) : (
      <Busy label="Loading sources…" />
    );
  } else {
    body = (
      <>
        {tabs.length > 2 && (
          <Segmented
            aria-label="Filter by kind"
            items={tabs}
            value={active}
            onChange={(f) => onSelection({ filter: f, picked })}
          />
        )}
        <Split
          aside="md"
          side={
            selected && (
              <SourcePanel
                key={selected.account.id}
                entry={selected}
                onOpen={() => props.onOpenDetail(selected.account.id)}
                onReconnect={() => props.onReconnect(selected.account.id)}
              />
            )
          }
        >
          <DataTable
            aria-label="Sources"
            columns={COLUMNS}
            rows={rows}
            rowKey={(e) => e.account.id}
            selectedKey={selectedId}
            onRowClick={(e) => onSelection({ filter, picked: e.account.id })}
          />
        </Split>
      </>
    );
  }

  return (
    <Page
      title="Sources"
      meta={metaLine(entries) || undefined}
      actions={
        <>
          <SyncAllMenu accounts={entries.map((e) => e.account)} />
          <Button onClick={() => props.onCatalog()}>
            <Icon name="plus" size={13} />
            Add source
          </Button>
        </>
      }
    >
      <div className="src-page">
        {showGetStarted && (
          <GetStartedPanel onOpenConnection={props.onOpenConnection} />
        )}
        {body}
        <AddMore onCatalog={props.onCatalog} onConnect={props.onConnect} />
      </div>
    </Page>
  );
}
