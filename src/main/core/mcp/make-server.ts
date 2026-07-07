/**
 * The one place the MCP server's identity lives — ported from kiagent-ref's
 * register.ts `makeMcpServer`. Both the HTTP transport (server.ts, one
 * McpServer per session) and the stdio sibling (../../mcp/stdio-entry.ts, one
 * for the process) construct through here so the handshake — name/title,
 * capabilities, `instructions`, `serverInfo.icons` — can never drift between
 * the two.
 *
 * The icon is a self-contained data URI because the stdio server runs
 * headless (ELECTRON_RUN_AS_NODE) and can't serve an icon over the loopback
 * HTTP port.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { KIA_INSTRUCTIONS } from './instructions';
import { KIA_SERVER_ICON_DATA_URI } from './server-icon';

export function makeMcpServer(): McpServer {
  return new McpServer(
    {
      // `name` is the protocol-level machine id; `title` is the display name
      // clients show. Hardcoded brand pending the brand-asset pass (TODO.md).
      name: 'kiagent',
      version: '0.1.0',
      title: 'KIAgent',
      icons: [
        {
          src: KIA_SERVER_ICON_DATA_URI,
          mimeType: 'image/png',
          sizes: ['256x256'],
        },
      ],
    },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: KIA_INSTRUCTIONS,
    },
  );
}
