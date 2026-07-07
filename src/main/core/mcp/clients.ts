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
  /** True if our server entry is already present in `text`. */
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

function jsonAdapter(opts: {
  id: ClientId;
  label: string;
  transport: 'stdio' | 'http';
  configPath: string;
  detectPath: string;
  containerKey: string;
  entry: unknown;
}): ClientAdapter {
  const { containerKey, entry } = opts;
  return {
    id: opts.id,
    label: opts.label,
    transport: opts.transport,
    configPath: opts.configPath,
    detectPath: opts.detectPath,
    isConnected(text) {
      try {
        return SERVER_KEY in jsonContainer(parseJsonRoot(text), containerKey);
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
  return {
    id: opts.id,
    label: opts.label,
    transport: 'stdio',
    configPath: opts.configPath,
    detectPath: opts.detectPath,
    isConnected(text) {
      try {
        if (!text || !text.trim()) return false;
        const root = TOML.parse(text) as Record<string, unknown>;
        return SERVER_KEY in tomlServers(root);
      } catch {
        return false;
      }
    },
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
    }),
    jsonAdapter({
      id: 'cursor',
      label: 'Cursor',
      transport: 'http',
      configPath: path.join(home, '.cursor', 'mcp.json'),
      detectPath: path.join(home, '.cursor'),
      containerKey: 'mcpServers',
      entry: cursorEntry,
    }),
    jsonAdapter({
      id: 'vscode',
      label: 'VS Code',
      transport: 'http',
      configPath: path.join(appData, 'Code', 'User', 'mcp.json'),
      detectPath: path.join(appData, 'Code', 'User'),
      containerKey: 'servers', // NOT mcpServers
      entry: httpEntry,
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
