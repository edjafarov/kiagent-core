import React, { useEffect, useState } from 'react';
import type { Account, AccountId } from '@shared/contracts';
import { Page } from '@shared/web-ui/ui';
import { useAppState } from '@renderer/state/app-state';
import { useView, type ViewParams } from '@renderer/state/view';
import { useSourceDescriptors } from './sources-registry';
import { SourcesList } from './SourcesList';
import { SourceDetail } from './SourceDetail';
import { SourceCatalog } from './SourceCatalog';
import { AddSourcePanel } from './AddSourcePanel';
import { sourceLabel } from './connector-meta';
import './Sources.css';

type Reconnect = { accountId: AccountId; sourceId: string; identifier: string };

export type LocalView =
  | { view: 'list' }
  | { view: 'detail'; accountId: AccountId }
  | { view: 'catalog'; install?: string }
  | { view: 'connect'; sourceId: string }
  | { view: 'reconnect'; target: Reconnect };

/** The route params another screen may link with; each is used once. */
function viewFromParams(
  params: ViewParams,
  accounts: readonly Account[],
): LocalView | null {
  const { reconnect, add, install } = params;
  if (reconnect !== undefined) {
    const a = accounts.find((x) => x.id === reconnect);
    return a
      ? {
          view: 'reconnect',
          target: {
            accountId: a.id,
            sourceId: a.source,
            identifier: a.identifier,
          },
        }
      : { view: 'list' };
  }
  if (install !== undefined) return { view: 'catalog', install };
  if (add !== undefined)
    return add ? { view: 'connect', sourceId: add } : { view: 'catalog' };
  return null;
}

/** The wizard as a page of its own. */
function ConnectPage(props: {
  parent: string;
  sourceId: string;
  onBack: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  const descriptors = useSourceDescriptors();
  return (
    <Page
      crumb={{
        parent: props.parent,
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
 * Links arrive as route params — `reconnect=<accountId>`, `add=<sourceId>`,
 * `add=` (the catalog), `install=<owner>/<repo>` — read once and cleared.
 * The product's policy (hidden sources, get-started) comes from the
 * app-root `SourceDescriptorsProvider`.
 */
export function SourcesScreen(props: {
  onOpenConnection: () => void;
}): React.ReactElement {
  const { params, replaceParams } = useView();
  const accountEntries = useAppState((s) => s.accounts);
  const [local, setLocal] = useState<LocalView>(
    () =>
      viewFromParams(
        params,
        accountEntries.map((e) => e.account),
      ) ?? { view: 'list' },
  );

  useEffect(() => {
    const { reconnect, add, install, ...rest } = params;
    if (reconnect === undefined && add === undefined && install === undefined)
      return;
    const next = viewFromParams(
      params,
      accountEntries.map((e) => e.account),
    );
    replaceParams(rest);
    if (next) setLocal(next);
    // Params only: the account list is read at the moment a link lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, replaceParams]);

  const toList = (): void => setLocal({ view: 'list' });
  const finished = (accountId?: AccountId): void =>
    setLocal(accountId ? { view: 'detail', accountId } : { view: 'list' });

  let body: React.ReactElement;
  switch (local.view) {
    case 'detail':
      body = <SourceDetail accountId={local.accountId} onBack={toList} />;
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
          parent="Add a source"
          sourceId={local.sourceId}
          onBack={() => setLocal({ view: 'catalog' })}
        >
          <AddSourcePanel
            key={local.sourceId}
            add={local.sourceId}
            onDone={(accountId) =>
              accountId ? finished(accountId) : setLocal({ view: 'catalog' })
            }
          />
        </ConnectPage>
      );
      break;
    case 'reconnect':
      body = (
        <ConnectPage
          parent="Sources"
          sourceId={local.target.sourceId}
          onBack={toList}
        >
          <AddSourcePanel
            key={local.target.accountId}
            reconnect={local.target}
            onDone={finished}
          />
        </ConnectPage>
      );
      break;
    default:
      body = (
        <SourcesList
          onOpenDetail={(accountId) => setLocal({ view: 'detail', accountId })}
          onOpenConnection={props.onOpenConnection}
          onCatalog={(install) => setLocal({ view: 'catalog', install })}
          onReconnect={(a) =>
            setLocal({
              view: 'reconnect',
              target: {
                accountId: a.id,
                sourceId: a.source,
                identifier: a.identifier,
              },
            })
          }
        />
      );
  }

  return <div className="dash-shell">{body}</div>;
}
