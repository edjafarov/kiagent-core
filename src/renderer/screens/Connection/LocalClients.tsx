import React, { useCallback, useEffect, useState } from 'react';
import { Busy, Pill } from '@shared/web-ui/components';
import type { McpInfo } from '@shared/ipc';

type ClientInfo = McpInfo['clients'][number];

/**
 * Short mono-initial glyph per client — mirrors the legacy renderer's
 * `screens/Connection/LocalClients.tsx` `GLYPH` map exactly (same 5 client
 * ids/initials). Neither `@shared/web-ui/provider-glyphs.tsx` (Google +
 * Microsoft sign-in glyphs only) nor `icon-sprite.tsx` ships a Claude/
 * Cursor/VS Code/Codex brand mark, so — same as legacy — this falls back to
 * a 2-letter mono-initial tile rather than a drawn brand glyph.
 */
const GLYPH: Record<string, { text: string; accent?: boolean }> = {
  'claude-desktop': { text: 'CD', accent: true },
  'claude-code': { text: 'CC', accent: true },
  cursor: { text: 'Cu' },
  vscode: { text: 'VS' },
  codex: { text: 'Cx' },
};

/**
 * Local MCP client list. Legacy read `connection:list-clients` /
 * `connection:connect` / `connection:disconnect` (a dedicated per-client
 * "detected but not connected" universe with a Disconnect action). The
 * current `@shared/ipc` contract collapses the listing to one channel,
 * `mcp:info` → `{port, clients: [{id, name, connected}]}`, whose backend
 * (`src/main/core/mcp/server.ts` `clients()`) already filters out clients
 * it doesn't detect on this machine — so, unlike legacy, there is no way for
 * the renderer to also render a dimmed "Not detected" row for an
 * undetected client (that would require guessing the full client roster
 * client-side); every row this component renders is therefore a detected
 * client. Connect/disconnect are separate `mcp:connect-client` /
 * `mcp:disconnect-client` channels; a connected client shows a "Connected"
 * pill plus a Disconnect button.
 */
export function LocalClients(props: {
  port: number | null;
}): React.ReactElement {
  const [clients, setClients] = useState<ClientInfo[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void window.kiagent
      .invoke('mcp:info', undefined)
      .then((info) => setClients(info.clients))
      .catch(() => setClients([]));
  }, []);

  useEffect(() => refresh(), [refresh]);

  async function withBusy(
    c: ClientInfo,
    run: () => Promise<void>,
  ): Promise<void> {
    setBusyId(c.id);
    try {
      await run();
    } finally {
      setBusyId(null);
      refresh(); // re-read actual state — a failed write stays as it was
    }
  }

  async function connect(c: ClientInfo): Promise<void> {
    await withBusy(c, () =>
      window.kiagent.invoke('mcp:connect-client', { id: c.id }),
    );
  }

  async function disconnect(c: ClientInfo): Promise<void> {
    await withBusy(c, () =>
      window.kiagent.invoke('mcp:disconnect-client', { id: c.id }),
    );
  }

  return (
    <section className="conn-section">
      <div className="conn-section-head">
        <h3 className="h-section">Local clients</h3>
        <span className="spacer" />
        <span className="sub mono">127.0.0.1:{props.port ?? '—'}</span>
      </div>
      <span className="t-meta" style={{ marginTop: -4 }}>
        Connect AI apps on this Mac — connect one to wire it up to your digital
        memory.
      </span>

      {clients === null ? (
        <Busy label="Detecting clients…" />
      ) : clients.length === 0 ? (
        <p className="t-meta conn-empty">
          No supported MCP clients detected on this machine yet.
        </p>
      ) : (
        <div className="conn-list">
          {clients.map((c) => {
            const g = GLYPH[c.id] ?? { text: c.name.slice(0, 2).toUpperCase() };
            return (
              <div
                key={c.id}
                className="conn-row"
                data-testid="local-client-row"
              >
                <span className={`conn-glyph${g.accent ? ' accent' : ''}`}>
                  {g.text}
                </span>
                <span className="body">
                  <span className="name">{c.name}</span>
                  <span className="desc">
                    {c.connected ? 'Connected to KIAgent' : 'Ready to connect'}
                  </span>
                </span>
                <span className="actions">
                  {c.connected ? (
                    <>
                      <Pill variant="live">Connected</Pill>
                      <button
                        type="button"
                        className="btn sm"
                        disabled={busyId === c.id}
                        aria-label={`Disconnect ${c.name}`}
                        onClick={() => void disconnect(c)}
                      >
                        Disconnect
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn sm primary"
                      disabled={busyId === c.id || props.port == null}
                      aria-label={`Connect ${c.name}`}
                      onClick={() => void connect(c)}
                    >
                      Connect
                    </button>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
