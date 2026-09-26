import React, { useEffect, useState } from 'react';
import type { AccountId } from '@shared/contracts';
import { Page } from '@shared/web-ui/ui';
import { useView, type ViewParams } from '@renderer/state/view';
import { useSourceDescriptors, useVisibleAccounts } from './sources-registry';
import {
  INITIAL_SELECTION,
  SourcesList,
  type ListSelection,
} from './SourcesList';
import { SourceDetail } from './SourceDetail';
import { SourceCatalog } from './SourceCatalog';
import { AddSourcePanel } from './AddSourcePanel';
import { sourceLabel } from './connector-meta';
import './Sources.css';

export type LocalView =
  | { view: 'list' }
  | { view: 'detail'; accountId: AccountId; reconnect?: boolean }
  | { view: 'catalog'; install?: string }
  | { view: 'connect'; sourceId: string };

/** The route params another screen may link with; each is used once. */
function viewFromParams(
  params: ViewParams,
  entries: ReturnType<typeof useVisibleAccounts>,
): LocalView | null {
  const { reconnect, accountId, add, install } = params;
  const target = reconnect ?? accountId;
  if (target !== undefined) {
    const known = entries.find((e) => e.account.id === target);
    return known
      ? {
          view: 'detail',
          accountId: known.account.id,
          reconnect: reconnect !== undefined || undefined,
        }
      : { view: 'list' };
  }
  if (install !== undefined) return { view: 'catalog', install };
  if (add !== undefined)
    return add ? { view: 'connect', sourceId: add } : { view: 'catalog' };
  return null;
}

/** The wizard as a page of its own, under the catalog. */
function ConnectPage(props: {
  sourceId: string;
  onBack: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  const descriptors = useSourceDescriptors();
  return (
    <Page
      crumb={{
        parent: 'Add a source',
        current: sourceLabel(props.sourceId, descriptors),
        onBack: props.onBack,
      }}
    >
      {props.children}
    </Page>
  );
}

/**
 * The Sources screen: list, a source's page, the catalog and the connect
 * wizard, as screen-local views (the shared `View` union has no sub-routes).
 * Links arrive as route params — `accountId=<id>` (that source's page),
 * `reconnect=<accountId>` (the same, signing in again), `add=<sourceId>`, `add=` (the catalog),
 * `install=<owner>/<repo>` — read once and cleared. The list's selection
 * and filter live here so they survive a trip to a source's page. The
 * product's policy (hidden sources, get-started) comes from the app-root
 * `SourceDescriptorsProvider`.
 */
export function SourcesScreen(props: {
  onOpenConnection: () => void;
}): React.ReactElement {
  const { params, replaceParams } = useView();
  const entries = useVisibleAccounts();
  // A link is read at mount too, so the list never flashes first; the
  // effect below then clears it (and reads later links).
  const [local, setLocal] = useState<LocalView>(
    () => viewFromParams(params, entries) ?? { view: 'list' },
  );
  const [selection, setSelection] = useState<ListSelection>(INITIAL_SELECTION);

  useEffect(() => {
    const next = viewFromParams(params, entries);
    if (!next) return;
    const {
      reconnect: _r,
      accountId: _id,
      add: _a,
      install: _i,
      ...rest
    } = params;
    replaceParams(rest);
    setLocal(next);
    // Params only: the account list is read at the moment a link lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, replaceParams]);

  const toList = (): void => setLocal({ view: 'list' });
  const toDetail = (accountId: AccountId, reconnect?: boolean): void =>
    setLocal({ view: 'detail', accountId, reconnect });

  let body: React.ReactElement;
  switch (local.view) {
    case 'detail':
      body = (
        <SourceDetail
          key={local.accountId}
          accountId={local.accountId}
          reconnect={local.reconnect}
          onBack={toList}
        />
      );
      break;
    case 'catalog':
      body = (
        <SourceCatalog
          install={local.install}
          onBack={toList}
          onPick={(sourceId) => setLocal({ view: 'connect', sourceId })}
        />
      );
      break;
    case 'connect':
      body = (
        <ConnectPage
          sourceId={local.sourceId}
          onBack={() => setLocal({ view: 'catalog' })}
        >
          <AddSourcePanel
            key={local.sourceId}
            add={local.sourceId}
            onDone={(accountId) =>
              accountId ? toDetail(accountId) : setLocal({ view: 'catalog' })
            }
          />
        </ConnectPage>
      );
      break;
    default:
      body = (
        <SourcesList
          selection={selection}
          onSelection={setSelection}
          onOpenDetail={(accountId) => toDetail(accountId)}
          onOpenConnection={props.onOpenConnection}
          onCatalog={(install) => setLocal({ view: 'catalog', install })}
          onConnect={(sourceId) => setLocal({ view: 'connect', sourceId })}
          onReconnect={(accountId) => toDetail(accountId, true)}
        />
      );
  }

  return <div className="dash-shell">{body}</div>;
}
