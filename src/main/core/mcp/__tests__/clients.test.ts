import { buildClientRegistry } from '../clients';

const registry = buildClientRegistry({
  localUrl: 'http://127.0.0.1:7421/mcp',
  stdioEntry: {
    command: '/x/app',
    args: ['/x/mcpStdio.js', '--db', '/x/kia.db'],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  },
});

describe.each(registry.map((a) => [a.id, a] as const))(
  '%s adapter',
  (_id, a) => {
    it('disconnect(connect(null)) round-trips to not-connected', () => {
      const connected = a.connect(null);
      expect(a.isConnected(connected)).toBe(true);
      const disconnected = a.disconnect(connected);
      expect(a.isConnected(disconnected)).toBe(false);
    });

    it('disconnect preserves foreign entries', () => {
      const withOurs = a.connect(
        a.id === 'codex'
          ? 'other_key = "keep"\n[mcp_servers.Other]\ncommand = "other"\n'
          : JSON.stringify(
              a.id === 'vscode'
                ? { servers: { Other: { url: 'http://other' } }, keep: true }
                : {
                    mcpServers: { Other: { url: 'http://other' } },
                    keep: true,
                  },
            ),
      );
      const after = a.disconnect(withOurs);
      expect(a.isConnected(after)).toBe(false);
      expect(after).toContain('Other');
      expect(after).toContain('keep');
    });

    it('disconnect of a config without our entry is a no-op-shaped write', () => {
      expect(a.isConnected(a.disconnect(null))).toBe(false);
    });
  },
);
