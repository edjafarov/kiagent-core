import fs from 'fs';
import os from 'os';
import path from 'path';

import { buildClientRegistry, reconcileHttpClientConfigs } from '../clients';

const stdioEntry = {
  command: '/x/app',
  args: ['/x/mcpStdio.js', '--db', '/x/kia.db'],
  env: { ELECTRON_RUN_AS_NODE: '1' },
};

const registry = buildClientRegistry({
  localUrl: 'http://127.0.0.1:7421/mcp',
  stdioEntry,
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

describe('URL-aware connectedness (candidate-port fallback)', () => {
  // A registry built after the server shifted to a fallback port, reading
  // configs written by the 7421 boot above.
  const shifted = buildClientRegistry({
    localUrl: 'http://127.0.0.1:7423/mcp',
    stdioEntry,
  });

  it.each(['claude-code', 'cursor', 'vscode'] as const)(
    '%s: an entry written for the old port is present but NOT connected',
    (id) => {
      const oldConfig = registry.find((a) => a.id === id)!.connect(null);
      const now = shifted.find((a) => a.id === id)!;
      expect(now.hasEntry(oldConfig)).toBe(true);
      expect(now.isConnected(oldConfig)).toBe(false);
      // connect() heals it:
      expect(now.isConnected(now.connect(oldConfig))).toBe(true);
    },
  );

  it.each(['claude-desktop', 'codex'] as const)(
    '%s: stdio entries are port-independent and stay connected',
    (id) => {
      const oldConfig = registry.find((a) => a.id === id)!.connect(null);
      const now = shifted.find((a) => a.id === id)!;
      expect(now.isConnected(oldConfig)).toBe(true);
    },
  );
});

describe('reconcileHttpClientConfigs', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-clients-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const shifted = buildClientRegistry({
    localUrl: 'http://127.0.0.1:7423/mcp',
    stdioEntry,
  });
  /** The real adapter's closures, pointed at a scratch config file. */
  function adapterIn(id: string, configFile: string) {
    const real = shifted.find((a) => a.id === id)!;
    return { ...real, configPath: path.join(dir, configFile), detectPath: dir };
  }

  it('rewrites a stale HTTP config to the bound port (with backup + log)', () => {
    const stale = registry
      .find((a) => a.id === 'claude-code')!
      .connect(
        JSON.stringify({ mcpServers: { Other: { url: 'http://other' } } }),
      );
    const adapter = adapterIn('claude-code', 'claude.json');
    fs.writeFileSync(adapter.configPath, stale);

    const logs: string[] = [];
    reconcileHttpClientConfigs([adapter], (m) => logs.push(m));

    const after = fs.readFileSync(adapter.configPath, 'utf8');
    expect(adapter.isConnected(after)).toBe(true);
    expect(after).toContain('Other'); // foreign entries preserved
    expect(fs.existsSync(`${adapter.configPath}.bak`)).toBe(true);
    expect(logs).toEqual([
      expect.stringMatching(/reconciled stale claude-code config/),
    ]);
  });

  it('leaves a current config and a config without our entry untouched', () => {
    const current = adapterIn('claude-code', 'current.json');
    fs.writeFileSync(current.configPath, current.connect(null));
    const foreign = adapterIn('cursor', 'foreign.json');
    fs.writeFileSync(
      foreign.configPath,
      JSON.stringify({ mcpServers: { Other: { url: 'http://other' } } }),
    );
    const before = [current, foreign].map((a) =>
      fs.readFileSync(a.configPath, 'utf8'),
    );

    const logs: string[] = [];
    reconcileHttpClientConfigs([current, foreign], (m) => logs.push(m));

    expect(
      [current, foreign].map((a) => fs.readFileSync(a.configPath, 'utf8')),
    ).toEqual(before);
    expect(logs).toEqual([]);
  });

  it('skips stdio adapters and missing config files', () => {
    const stdio = adapterIn('claude-desktop', 'desktop.json');
    fs.writeFileSync(
      stdio.configPath,
      registry.find((a) => a.id === 'claude-desktop')!.connect(null),
    );
    const missing = adapterIn('vscode', 'never-written.json');

    const logs: string[] = [];
    reconcileHttpClientConfigs([stdio, missing], (m) => logs.push(m));

    expect(logs).toEqual([]);
    expect(fs.existsSync(missing.configPath)).toBe(false);
  });
});
