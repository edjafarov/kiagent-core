import React from 'react';
import { Columns, Page } from '@shared/web-ui/ui';
import { useAppState } from '@renderer/state/app-state';
import { LocalServer } from './LocalServer';
import './Connection.css';

/** Advanced: the product's remote details (when it has any) beside the
 *  local server and its manual setup. */
export function ConnectionAdvanced(props: {
  remote?: React.ReactNode;
  onBack: () => void;
}): React.ReactElement {
  const port = useAppState((s) => s.mcp.port);
  return (
    <Page
      crumb={{
        parent: 'Connection',
        current: 'Advanced',
        onBack: props.onBack,
      }}
    >
      {props.remote ? (
        <Columns template="minmax(0, 1fr) minmax(0, 1fr)">
          {props.remote}
          <LocalServer port={port} />
        </Columns>
      ) : (
        <div className="conn-narrow">
          <LocalServer port={port} />
        </div>
      )}
    </Page>
  );
}
