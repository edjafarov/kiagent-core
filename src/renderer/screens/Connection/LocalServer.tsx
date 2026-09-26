import React, { useState } from 'react';
import {
  Card,
  CardHeader,
  CodeBlock,
  CopyField,
  KeyValue,
  Segmented,
  Status,
} from '@shared/web-ui/ui';
import { buildSnippet, localUrl, type SnippetKind } from './snippets';

const KINDS = [
  { key: 'json', label: 'JSON' },
  { key: 'claude-code', label: 'Claude Code' },
  { key: 'vscode', label: 'VS Code' },
] as const;

/** The loopback server: whether it is up, its endpoint, who can use it,
 *  and the snippets for an app that isn't in the Connect list. */
export function LocalServer(props: {
  port: number | null;
}): React.ReactElement {
  const { port } = props;
  const [kind, setKind] = useState<SnippetKind>('json');
  const url = port != null ? localUrl(port) : null;
  return (
    <Card>
      <CardHeader
        label="Local server"
        meta={
          url ? (
            <Status tone="ok">Online</Status>
          ) : (
            <Status tone="off">Not ready</Status>
          )
        }
      />
      {url ? (
        <>
          <KeyValue
            items={[
              {
                label: 'Endpoint',
                value: <CopyField value={url} aria-label="Local endpoint" />,
              },
              {
                label: 'Who can use it',
                value: 'Apps on this computer only — no sign-in',
              },
            ]}
          />
          <h3 className="conn-sub">Manual setup</h3>
          <p className="conn-note">
            For an app that isn’t in the list on Connection. Paste this into its
            MCP settings.
          </p>
          <Segmented
            items={KINDS}
            value={kind}
            onChange={setKind}
            aria-label="Snippet format"
          />
          <CodeBlock>{buildSnippet(kind, url)}</CodeBlock>
        </>
      ) : (
        <p className="conn-note">
          The local server hasn’t reported a port yet — it may still be
          starting, or it failed to bind one. Check Logs for details.
        </p>
      )}
      <p className="conn-note">
        Claude Desktop and Codex start the server themselves — use Connect on
        Connection for those.
      </p>
    </Card>
  );
}
