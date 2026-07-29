/**
 * @jest-environment node
 *
 * INVOKE_CHANNELS is checked against the `Invokes` INTERFACE at compile time
 * (`satisfies`), and preload refuses anything outside it — but nothing ties
 * either to the handlers that must actually answer. The two failure modes
 * that leaves are both silent:
 *
 *  - declared, never registered → preload lets the call through and it
 *    rejects with electron's opaque "No handler registered for '<channel>'";
 *  - registered, never declared → preload rejects it before it is ever sent,
 *    so the handler is dead code nobody can reach.
 *
 * Neither is visible to the compiler (ipcMain.handle takes a string) and
 * neither shows up in a normal test run, so this reads the registrars'
 * SOURCE and compares the two sets directly.
 */
import fs from 'fs';
import path from 'path';

import { INVOKE_CHANNELS } from '@shared/ipc';

const SRC = path.resolve(__dirname, '..');

/** Every file that registers an invoke handler. A new registrar that is not
 *  listed here shows up below as a DECLARED-BUT-UNREGISTERED channel — the
 *  failure names it, and adding the file is the fix. */
const REGISTRARS = ['main.ts', 'outbound/ipc.ts', 'updater/ipc.ts'];

/**
 * Pulls the channel out of every literal `handle('<channel>'` registration:
 * the local `handle(...)` wrapper in main.ts, `ipcMain.handle(...)`, and the
 * injected `bus.handle(...)` in updater/ipc.ts.
 *
 * `\b` (rather than a "not preceded by a dot" guard) is deliberate — the
 * dotted forms are exactly the ones that must match. Whole-file matching is
 * equally deliberate: `\s*` has to span newlines, because at least one real
 * registration puts the channel on the line AFTER `handle(` and a
 * line-oriented scan silently misses it.
 */
function extractChannels(source: string): string[] {
  return [...source.matchAll(/\bhandle\(\s*'([^']+)'/g)].map((m) => m[1]);
}

describe('extractChannels (self-check — a dead regex would pass everything)', () => {
  it('matches the plain, dotted and multi-line registration forms', () => {
    expect(extractChannels(`handle('app:get-state', () => {});`)).toEqual([
      'app:get-state',
    ]);
    expect(extractChannels(`ipcMain.handle('mcp:info', fn);`)).toEqual([
      'mcp:info',
    ]);
    expect(extractChannels(`bus.handle('update:check', fn);`)).toEqual([
      'update:check',
    ]);
    // THE regression case: the line-oriented grep this test replaces missed
    // 'accounts:update-outbound' for exactly this shape.
    expect(
      extractChannels("handle(\n    'accounts:update-outbound',\n    async"),
    ).toEqual(['accounts:update-outbound']);
  });

  it('does not match the wrapper declaration, a variable channel, or a lookalike name', () => {
    expect(
      extractChannels('const handle = <C extends keyof Invokes>('),
    ).toEqual([]);
    expect(
      extractChannels('ipcMain.handle(channel, (_e, req) => fn(req));'),
    ).toEqual([]);
    expect(extractChannels("myhandle('not:a:channel')")).toEqual([]);
  });
});

describe('every invoke channel is declared AND registered', () => {
  const registered = new Map<string, string>(); // channel -> file
  const duplicates: string[] = [];
  for (const rel of REGISTRARS) {
    const source = fs.readFileSync(path.join(SRC, rel), 'utf8');
    for (const channel of extractChannels(source)) {
      if (registered.has(channel)) duplicates.push(channel);
      else registered.set(channel, rel);
    }
  }

  it('found a plausible number of registrations (a silently dead scan would find none)', () => {
    expect(registered.size).toBeGreaterThan(50);
  });

  it('registers no channel twice — the later ipcMain.handle would throw at boot', () => {
    expect(duplicates).toEqual([]);
  });

  it('has a handler for every channel in INVOKE_CHANNELS', () => {
    const missing = INVOKE_CHANNELS.filter((c) => !registered.has(c));
    expect(missing).toEqual([]); // declared but no handler → opaque runtime reject
  });

  it('declares every channel that has a handler', () => {
    const declared = new Set<string>(INVOKE_CHANNELS);
    const extra = [...registered]
      .filter(([c]) => !declared.has(c))
      .map(([c, file]) => `${c} (registered in ${file})`);
    expect(extra).toEqual([]); // handler but undeclared → preload blocks it
  });
});
