/**
 * @jest-environment node
 *
 * Channel coverage itself is no longer this file's job. `InvokeHandlers`
 * (shared/ipc.ts) makes main hold one map with an entry per declared channel,
 * so "declared but never registered" and "registered but never declared" are
 * both tsc errors now — verified in both directions when that map landed.
 * This file used to scrape the registrars' source because ipcMain.handle
 * takes a string and the compiler could see none of it.
 *
 * What the compiler still cannot see is a SECOND registration site. The map
 * is only exhaustive over the channels it holds; a module that calls
 * `ipcMain.handle('some:channel', …)` on its own compiles perfectly and then
 * throws "Attempted to register a second handler" at boot — which is exactly
 * the trap the updater and outbound seams were shaped to avoid. So the
 * remaining assertion is architectural: every invoke channel is registered by
 * the one loop in main.ts, and modules contribute handlers rather than
 * registering them.
 */
import fs from 'fs';
import path from 'path';

import { INVOKE_CHANNELS, PUSH_CHANNELS } from '@shared/ipc';

const SRC = path.resolve(__dirname, '..');

/** Every .ts under src/main, tests excluded. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      sourceFiles(full, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** `ipcMain.handle('literal:channel'` — the second-registration shape. A
 *  variable channel (the loop in main.ts) deliberately does NOT match. */
function literalRegistrations(source: string): string[] {
  return [...source.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)].map(
    (m) => m[1],
  );
}

describe('literalRegistrations (self-check — a dead regex would pass everything)', () => {
  it('matches a literal channel and ignores the variable form', () => {
    expect(literalRegistrations("ipcMain.handle('mcp:info', fn);")).toEqual([
      'mcp:info',
    ]);
    expect(
      literalRegistrations("ipcMain.handle(\n  'update:check',\n  fn,\n);"),
    ).toEqual(['update:check']);
    expect(
      literalRegistrations('ipcMain.handle(channel, (_e, req) => fn(req));'),
    ).toEqual([]);
  });
});

describe('invoke channels are registered in exactly one place', () => {
  const files = sourceFiles(SRC);

  it('found the main-process tree (a dead scan would find nothing)', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain(path.join(SRC, 'main.ts'));
  });

  it('no module registers a literal channel — that would double-register at boot', () => {
    const offenders = files.flatMap((file) => {
      const hits = literalRegistrations(fs.readFileSync(file, 'utf8'));
      return hits.map((c) => `${path.relative(SRC, file)}: ${c}`);
    });
    expect(offenders).toEqual([]);
  });

  it('main.ts registers over the derived allowlist, not a hand-written list', () => {
    const source = fs.readFileSync(path.join(SRC, 'main.ts'), 'utf8');
    expect(source).toContain('for (const channel of INVOKE_CHANNELS)');
  });
});

describe('the derived allowlists', () => {
  // Object.keys() of a map that `satisfies Record<Channel, 0>` cannot lose or
  // invent an entry, but the `as readonly Channel[]` cast is unchecked — so
  // assert the shape preload actually consumes.
  it('are non-empty and duplicate-free', () => {
    expect(INVOKE_CHANNELS.length).toBeGreaterThan(50);
    expect(new Set(INVOKE_CHANNELS).size).toBe(INVOKE_CHANNELS.length);
    expect(PUSH_CHANNELS.length).toBeGreaterThan(0);
    expect(new Set(PUSH_CHANNELS).size).toBe(PUSH_CHANNELS.length);
  });

  it('keep the two namespaces disjoint', () => {
    const pushes = new Set<string>(PUSH_CHANNELS);
    expect(INVOKE_CHANNELS.filter((c) => pushes.has(c))).toEqual([]);
  });
});
