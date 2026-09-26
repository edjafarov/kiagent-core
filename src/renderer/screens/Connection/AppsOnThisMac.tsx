import React, { useState } from 'react';
import {
  BrandGlyph,
  Busy,
  Button,
  Card,
  CardFooter,
  CardHeader,
  Row,
  Rows,
  TextButton,
  clientBrand,
} from '@shared/web-ui/ui';
import type { ClientInfo } from './use-mcp-clients';

export function computerNoun(): 'Mac' | 'computer' {
  return typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
    ? 'Mac'
    : 'computer';
}

/**
 * The AI apps detected on this computer (the server lists only those it
 * finds) and whether each is connected. Connect writes the app's settings
 * in one click; Disconnect, revealed on hover, removes the entry. Every
 * write re-reads the real state after — a failed one stays as it was.
 */
export function AppsOnThisMac(props: {
  clients: ClientInfo[] | null;
  port: number | null;
  onChanged: () => void;
  onManualSetup: () => void;
}): React.ReactElement {
  const { clients, port } = props;
  const [busyId, setBusyId] = useState<string | null>(null);

  async function write(
    c: ClientInfo,
    channel: 'mcp:connect-client' | 'mcp:disconnect-client',
  ): Promise<void> {
    setBusyId(c.id);
    try {
      await window.kiagent.invoke(channel, { id: c.id });
    } catch {
      // the re-read below shows what actually happened
    } finally {
      setBusyId(null);
      props.onChanged();
    }
  }

  const connected = clients?.filter((c) => c.connected).length ?? 0;
  return (
    <Card>
      <CardHeader
        label={`Apps on this ${computerNoun()}`}
        count={
          clients && clients.length > 0
            ? `${connected} of ${clients.length} connected`
            : undefined
        }
        meta={<span className="conn-mono">127.0.0.1:{port ?? '—'}</span>}
      />
      {clients === null ? (
        <Busy label="Looking for apps…" />
      ) : clients.length === 0 ? (
        <p className="conn-note">
          No supported apps found on this computer yet.
        </p>
      ) : (
        <Rows aria-label={`Apps on this ${computerNoun()}`}>
          {clients.map((c) => {
            const busy = busyId === c.id;
            return (
              <Row
                key={c.id}
                size={42}
                data-testid="local-client-row"
                lead={<BrandGlyph brand={clientBrand(c.id)} size={20} />}
                title={c.name}
                sub={c.connected ? '✓ Connected' : 'Ready to connect'}
                trail={
                  c.connected ? undefined : (
                    <Button
                      size="sm"
                      disabled={busy || port == null}
                      aria-label={`Connect ${c.name}`}
                      onClick={() => void write(c, 'mcp:connect-client')}
                    >
                      Connect
                    </Button>
                  )
                }
                hoverActions={
                  c.connected ? (
                    <TextButton
                      disabled={busy}
                      aria-label={`Disconnect ${c.name}`}
                      onClick={() => void write(c, 'mcp:disconnect-client')}
                    >
                      Disconnect
                    </TextButton>
                  ) : undefined
                }
              />
            );
          })}
        </Rows>
      )}
      <CardFooter>
        <span className="conn-note">
          One click adds the server to the app’s settings. Another app?{' '}
          <TextButton onClick={props.onManualSetup}>Manual setup</TextButton>
        </span>
      </CardFooter>
    </Card>
  );
}
