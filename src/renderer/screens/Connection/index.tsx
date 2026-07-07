import React from 'react';
import { useAppState } from '@renderer/state/app-state';
import { ConnectionHub } from './ConnectionHub';
import { LocalClients } from './LocalClients';
import { ManualSetup } from './ManualSetup';
import { buildLocalHttpSnippet } from './snippets';
import { ActivityPanel } from './ActivityPanel';
import './Connection.css';

/**
 * Connection screen — "how do I plug an LLM client into kia" (ui-inventory.md
 * §2.4). Mirrors the legacy renderer's `ConnectionHub` + `LocalClients` +
 * `ManualSetup` trio (kiagent-ref `src/renderer/screens/Connection/*`), with
 * two deliberate differences from legacy:
 *
 *  - The legacy "Remote" section (a public HTTPS URL for hosted clients) is
 *    OMITTED entirely — it was rendered by a `registerRemoteSection`
 *    extension slot filled by a proprietary overlay; the OSS build always
 *    rendered nothing there, so this build matches that OSS behavior.
 *  - `mcp.port` is read live from `state.mcp.port` (`useAppState`) instead
 *    of legacy's `useAppStateSelector(s => s?.mcp) ?? 7421` fallback — a
 *    `null` port here is surfaced as an explicit "Not ready" state (see
 *    `ConnectionHub`) rather than papered over with a guessed default port.
 *  - A third element legacy never had: the ActivityPanel right column — the
 *    MCP data-access trail (see specs/2026-07-06-mcp-activity-feed-design.md).
 */
export function Connection(): React.ReactElement {
  const port = useAppState((s) => s.mcp.port);

  return (
    <div className="dash-shell">
      <div className="conn-body conn-columns">
        <div className="conn-main">
          <ConnectionHub port={port} />

          <div className="div-h" />

          <div className="conn-group">
            <LocalClients port={port} />
            <ManualSetup
              summary={
                port != null
                  ? `local URL http://127.0.0.1:${port}/mcp & config snippets`
                  : 'local URL & config snippets'
              }
            >
              {port != null ? (
                <pre className="code-block wrap">
                  {buildLocalHttpSnippet(port)}
                </pre>
              ) : (
                <p className="t-meta">
                  Waiting for the local MCP server to report a port before a
                  snippet can be built.
                </p>
              )}
              <div className="lbl-section">stdio (Claude Desktop / Codex)</div>
              <p className="t-meta">
                Claude Desktop and Codex connect over stdio, which needs an
                absolute path to this app&apos;s executable that the renderer
                doesn&apos;t have access to — use each app&apos;s Connect button
                above (it writes the stdio entry for you), or see the docs for
                the raw command/args/env snippet.
              </p>
            </ManualSetup>
          </div>
        </div>

        <ActivityPanel />
      </div>
    </div>
  );
}
