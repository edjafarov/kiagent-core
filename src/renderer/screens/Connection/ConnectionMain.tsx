import React from 'react';
import { Button, Page, Split, Stack } from '@shared/web-ui/ui';
import { useAppState } from '@renderer/state/app-state';
import { AppsOnThisMac, computerNoun } from './AppsOnThisMac';
import { Requests } from './Requests';
import { useMcpClients } from './use-mcp-clients';
import './Connection.css';

/** What a product adds above the apps: its card and a meta phrase. */
export interface ConnectionRemote {
  card: React.ReactNode;
  meta: string;
}

/**
 * The Connection page: an optional card a product adds (its public
 * address), the apps on this computer, and every request on the right.
 */
export function ConnectionMain(props: {
  remote?: ConnectionRemote;
  onAdvanced: () => void;
}): React.ReactElement {
  const port = useAppState((s) => s.mcp.port);
  const { clients, refresh } = useMcpClients();
  const connected = clients?.filter((c) => c.connected).length ?? 0;
  const appsMeta =
    clients === null
      ? null
      : `${connected} ${connected === 1 ? 'app' : 'apps'} on this ${computerNoun()} connected`;
  const meta = [props.remote?.meta, appsMeta].filter(Boolean).join(' · ');
  return (
    <Page
      title="Connection"
      meta={meta || undefined}
      actions={
        <Button
          variant="ghost"
          size="sm"
          icon="sliders"
          onClick={props.onAdvanced}
        >
          Advanced
        </Button>
      }
    >
      <Split aside="md" side={<Requests />}>
        <Stack gap="page">
          {props.remote?.card}
          <AppsOnThisMac
            clients={clients}
            port={port}
            onChanged={refresh}
            onManualSetup={props.onAdvanced}
          />
        </Stack>
      </Split>
    </Page>
  );
}
