import React, { useState } from 'react';
import { Pill } from '@shared/web-ui/components';
import { Icon } from '@shared/web-ui/icon-sprite';

/**
 * MCP server status header. Not a literal port of any single legacy
 * component — legacy's own `screens/Connection/ConnectionHub.tsx` only used
 * `mcp.port` to build snippet URLs and never rendered its own status row
 * (the "Online" pill + mono port lived inside `LocalClients` instead). The
 * copy-a-URL row here reuses the `.url-input` + copy-button idiom from the
 * legacy mockups (`docs/screens/mcp-hub-active.html`'s "Remote MCP" row —
 * `<div class="url-input">…<button class="btn primary sm">Copy</button>`),
 * repointed at the always-on local endpoint since the Remote section itself
 * is intentionally omitted here (it shipped via a proprietary extension
 * slot the OSS build never had — see ui-inventory.md §2.4).
 */
export function ConnectionHub(props: {
  port: number | null;
}): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const { port } = props;
  const url = port != null ? `http://127.0.0.1:${port}/mcp` : null;

  function copy(): void {
    if (!url) return;
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }

  return (
    <div className="conn-hub">
      <div className="conn-hub-head">
        <h2 className="h-section">MCP server</h2>
        {port != null ? (
          <Pill variant="live">Online</Pill>
        ) : (
          <Pill variant="paused">Not ready</Pill>
        )}
      </div>
      <p className="conn-hub-desc t-meta">
        {port != null
          ? 'This machine is serving MCP over loopback HTTP. Use the endpoint below, or connect one of the clients detected below it.'
          : "The local MCP server hasn't reported a port yet — it may still be starting, or it failed to bind one. Check Logs for details."}
      </p>
      {url && (
        <div className="conn-hub-url-row">
          <span className="url-input">
            <Icon name="link" size={13} className="icon" />
            <span className="url">{url}</span>
          </span>
          <button type="button" className="btn primary sm" onClick={copy}>
            <Icon name="copy" size={12} />
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}
    </div>
  );
}
