/**
 * Local AI client detection + config writing — ported from kiagent-ref's
 * src/main/mcp/clients/{registry,json-config,toml-config,write}.ts. Legacy
 * received resolved OS paths (appData/home/exePath) from main.ts via
 * Electron's `app.getPath`; `core/` stays Electron-free, so those same paths
 * are derived here from `os.homedir()` + platform convention — identical
 * values on macOS/Windows/Linux, just computed locally instead of injected.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import * as TOML from '@iarna/toml';

/** Kept distinct from the legacy 'Kia' key — a fresh app identity, not a
 *  silent takeover of an existing Kia server entry in a shared config file. */
const SERVER_KEY = 'KIAgent';

export type ClientId =
  | 'claude-desktop'
  | 'claude-code'
  | 'cursor'
  | 'vscode'
  | 'codex';

export interface StdioLaunchDescriptor {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface ClientAdapter {
  id: ClientId;
  label: string;
  transport: 'stdio' | 'http';
  /** Absolute path to the client's MCP config file. */
  configPath: string;
  /** Existence of this path means the client is installed. */
  detectPath: string;
  /** True if our server entry is present in `text` at all, current or stale.
   *  The reconcile pass keys off `hasEntry && !isConnected`. */
  hasEntry(text: string | null): boolean;
  /** True if our server entry is present AND current. For HTTP adapters that
   *  means the stored url matches this boot's actual bind — a config written
   *  against a port we no longer hold reports disconnected, not a lie. */
  isConnected(text: string | null): boolean;
  /** Return new config text with our entry merged in (preserves everything else). */
  connect(text: string | null): string;
  /** Return new config text with our entry removed (preserves everything else). */
  disconnect(text: string | null): string;
}

/** Electron's `app.getPath('appData')` equivalent, computed without Electron:
 *  `~/Library/Application Support` (macOS), `%APPDATA%` (Windows), XDG config
 *  dir (Linux) — the parent folder every one of these clients stores its
 *  config under. */
export function appDataDir(): string {
  const home = os.homedir();
  if (process.platform === 'darwin')
    return path.join(home, 'Library', 'Application Support');
  if (process.platform === 'win32')
    return process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
  return process.env.XDG_CONFIG_HOME ?? path.join(home, '.config');
}

function parseJsonRoot(text: string | null): Record<string, unknown> {
  if (!text || !text.trim()) return {};
  const parsed = JSON.parse(text) as unknown; // throws on malformed JSON — never clobber
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('config root is not a JSON object — refusing to overwrite');
  }
  return parsed as Record<string, unknown>;
}

function jsonContainer(
  root: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const cur = root[key];
  return cur && typeof cur === 'object' && !Array.isArray(cur)
    ? (cur as Record<string, unknown>)
    : {};
}

/** The `url` field of our server entry, whatever the entry shape — both the
 *  standard `{type:'http', url}` and Cursor's bare `{url}` carry one. */
function entryUrl(container: Record<string, unknown>): string | null {
  const entry = container[SERVER_KEY];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const { url } = entry as Record<string, unknown>;
  return typeof url === 'string' ? url : null;
}

function jsonAdapter(opts: {
  id: ClientId;
  label: string;
  transport: 'stdio' | 'http';
  configPath: string;
  detectPath: string;
  containerKey: string;
  entry: unknown;
  /** HTTP adapters only: the url the entry must carry to count as connected.
   *  Stdio entries are launch-command-based and port-independent, so deep
   *  comparison there could false-negative after exePath changes across app
   *  updates — presence stays the whole test for them. */
  expectedUrl?: string;
}): ClientAdapter {
  const { containerKey, entry, expectedUrl } = opts;
  return {
    id: opts.id,
    label: opts.label,
    transport: opts.transport,
    configPath: opts.configPath,
    detectPath: opts.detectPath,
    hasEntry(text) {
      try {
        return SERVER_KEY in jsonContainer(parseJsonRoot(text), containerKey);
      } catch {
        return false;
      }
    },
    isConnected(text) {
      try {
        const container = jsonContainer(parseJsonRoot(text), containerKey);
        if (!(SERVER_KEY in container)) return false;
        return expectedUrl === undefined || entryUrl(container) === expectedUrl;
      } catch {
        return false;
      }
    },
    connect(text) {
      const root = parseJsonRoot(text);
      root[containerKey] = {
        ...jsonContainer(root, containerKey),
        [SERVER_KEY]: entry,
      };
      return `${JSON.stringify(root, null, 2)}\n`;
    },
    disconnect(text) {
      const root = parseJsonRoot(text); // throws on malformed — applyConfigChange catches, file untouched
      const container = { ...jsonContainer(root, containerKey) };
      delete container[SERVER_KEY];
      root[containerKey] = container;
      return `${JSON.stringify(root, null, 2)}\n`;
    },
  };
}

function tomlServers(root: Record<string, unknown>): Record<string, unknown> {
  const cur = root.mcp_servers;
  return cur && typeof cur === 'object' && !Array.isArray(cur)
    ? (cur as Record<string, unknown>)
    : {};
}

/** Codex stores MCP servers in ~/.codex/config.toml under [mcp_servers.<key>].
 *  Round-tripping via @iarna/toml does not preserve comments/formatting —
 *  values survive, layout doesn't; `applyConfigChange` backs up first. */
function tomlAdapter(opts: {
  id: ClientId;
  label: string;
  configPath: string;
  detectPath: string;
  entry: StdioLaunchDescriptor;
}): ClientAdapter {
  function hasEntry(text: string | null): boolean {
    try {
      if (!text || !text.trim()) return false;
      const root = TOML.parse(text) as Record<string, unknown>;
      return SERVER_KEY in tomlServers(root);
    } catch {
      return false;
    }
  }
  return {
    id: opts.id,
    label: opts.label,
    transport: 'stdio',
    configPath: opts.configPath,
    detectPath: opts.detectPath,
    hasEntry,
    isConnected: hasEntry, // stdio: launch-command entries have no url to go stale

    connect(text) {
      const root =
        text && text.trim()
          ? (TOML.parse(text) as Record<string, unknown>)
          : {};
      root.mcp_servers = { ...tomlServers(root), [SERVER_KEY]: opts.entry };
      return TOML.stringify(root as TOML.JsonMap);
    },
    disconnect(text) {
      const root =
        text && text.trim()
          ? (TOML.parse(text) as Record<string, unknown>)
          : {};
      const servers = { ...tomlServers(root) };
      delete servers[SERVER_KEY];
      root.mcp_servers = servers;
      return TOML.stringify(root as TOML.JsonMap);
    },
  };
}

export function claudeDesktopConfigPath(appData: string): string {
  return path.join(appData, 'Claude', 'claude_desktop_config.json');
}

/** Build the launch descriptor for stdio clients (Claude Desktop, Codex): the
 *  app's own executable, run in Node mode against the bundled stdio entry
 *  script, pointed at the same SQLite file the HTTP transport reads from. */
export function buildStdioLaunchDescriptor(opts: {
  exePath: string;
  entryScriptPath: string;
  dbPath: string;
}): StdioLaunchDescriptor {
  return {
    command: opts.exePath,
    args: [opts.entryScriptPath, '--db', opts.dbPath],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
}

export function buildClientRegistry(opts: {
  localUrl: string;
  stdioEntry: StdioLaunchDescriptor;
}): ClientAdapter[] {
  const home = os.homedir();
  const appData = appDataDir();
  const httpEntry = { type: 'http', url: opts.localUrl }; // no bearer — loopback bind IS the auth
  const cursorEntry = { url: opts.localUrl }; // Cursor wants a bare url

  return [
    jsonAdapter({
      id: 'claude-desktop',
      label: 'Claude Desktop',
      transport: 'stdio',
      configPath: claudeDesktopConfigPath(appData),
      detectPath: path.join(appData, 'Claude'),
      containerKey: 'mcpServers',
      entry: opts.stdioEntry,
    }),
    jsonAdapter({
      id: 'claude-code',
      label: 'Claude Code',
      transport: 'http',
      configPath: path.join(home, '.claude.json'),
      detectPath: path.join(home, '.claude.json'), // the file itself is the install marker
      containerKey: 'mcpServers',
      entry: httpEntry,
      expectedUrl: opts.localUrl,
    }),
    jsonAdapter({
      id: 'cursor',
      label: 'Cursor',
      transport: 'http',
      configPath: path.join(home, '.cursor', 'mcp.json'),
      detectPath: path.join(home, '.cursor'),
      containerKey: 'mcpServers',
      entry: cursorEntry,
      expectedUrl: opts.localUrl,
    }),
    jsonAdapter({
      id: 'vscode',
      label: 'VS Code',
      transport: 'http',
      configPath: path.join(appData, 'Code', 'User', 'mcp.json'),
      detectPath: path.join(appData, 'Code', 'User'),
      containerKey: 'servers', // NOT mcpServers
      entry: httpEntry,
      expectedUrl: opts.localUrl,
    }),
    tomlAdapter({
      id: 'codex',
      label: 'Codex',
      configPath: path.join(home, '.codex', 'config.toml'),
      detectPath: path.join(home, '.codex'),
      entry: opts.stdioEntry,
    }),
  ];
}

/**
 * Rewrite HTTP client configs whose stored url no longer matches the port we
 * actually bound. PORT_CANDIDATES fallback means a third-party process
 * squatting the first port silently shifts the server — without this, every
 * previously connected HTTP client keeps POSTing its handshake at the stale
 * port. Only fires when our entry is present but stale (`hasEntry &&
 * !isConnected`), so a normal boot on the usual port writes nothing. Stdio
 * adapters are skipped — they launch by command and are port-independent.
 *
 * Caveat: this re-serializes the whole config file and can last-writer-wins
 * race a concurrently running client instance (applyConfigChange takes a .bak
 * first) — acceptable for a write that only fires on an actual port change,
 * and each rewrite is logged.
 */
export function reconcileHttpClientConfigs(
  adapters: ClientAdapter[],
  log: (message: string, meta?: Record<string, unknown>) => void,
): void {
  for (const adapter of adapters) {
    if (adapter.transport !== 'http') continue;
    try {
      if (!fs.existsSync(adapter.configPath)) continue;
      const text = fs.readFileSync(adapter.configPath, 'utf8');
      if (!adapter.hasEntry(text) || adapter.isConnected(text)) continue;
      const result = applyConfigChange(adapter.configPath, (t) =>
        adapter.connect(t),
      );
      if (result.ok) {
        log(`reconciled stale ${adapter.id} config to the bound port`, {
          path: result.path,
          backup: result.backupPath,
        });
      } else {
        log(`failed to reconcile stale ${adapter.id} config`, {
          error: result.error,
        });
      }
    } catch (e) {
      log(`failed to reconcile stale ${adapter.id} config`, {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

export type WriteResult =
  | { ok: true; path: string; backupPath: string | null }
  | { ok: false; error: string };

/**
 * Apply `transform` to a client config file:
 *  - parent dir missing → {ok:false} (client not installed; no write).
 *  - existing file → `.bak` backup first (overwritten on repeat connects).
 *  - transform throws (malformed config etc.) → {ok:false}, file untouched.
 *  - write temp file + atomic rename over the target.
 */
export function applyConfigChange(
  configPath: string,
  transform: (text: string | null) => string,
): WriteResult {
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    return { ok: false, error: `config folder not found: ${dir}` };
  }
  try {
    const existing = fs.existsSync(configPath)
      ? fs.readFileSync(configPath, 'utf8')
      : null;
    let backupPath: string | null = null;
    if (existing !== null) {
      backupPath = `${configPath}.bak`;
      fs.writeFileSync(backupPath, existing);
    }
    const next = transform(existing); // may throw — caught below, no partial write
    const tmp = `${configPath}.tmp`;
    try {
      fs.writeFileSync(tmp, next);
      fs.renameSync(tmp, configPath);
    } catch (writeErr) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore cleanup failure */
      }
      throw writeErr;
    }
    return { ok: true, path: configPath, backupPath };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'write failed',
    };
  }
}
