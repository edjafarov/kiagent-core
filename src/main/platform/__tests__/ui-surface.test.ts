/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { Query } from '@shared/contracts';

import { buildSurfaces, CapError, createEventBus } from '../host-surfaces';
import { createUiRegistry } from '../ui-registry';

const fakeQuery = {
  document: jest.fn(async () => null),
  children: jest.fn(async () => []),
  byExternalId: jest.fn(async () => null),
  search: jest.fn(async () => []),
  count: jest.fn(async () => 0),
  accounts: jest.fn(async () => []),
} as unknown as Query;

function makeDeps(
  overrides: Partial<Parameters<typeof buildSurfaces>[0]> = {},
) {
  return {
    extensionId: 'test.ui',
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'kia-ui-surface-')),
    query: fakeQuery,
    inference: {
      complete: jest.fn(async () => ''),
      see: jest.fn(async () => ''),
      read: jest.fn(async () => ''),
      hear: jest.fn(async () => ''),
      lane: jest.fn(async () => 'open' as const),
      describe: jest.fn(async () => null),
    },
    notify: jest.fn(),
    attention: {
      publish: jest.fn(async () => ({ rejected: [] })),
      resolve: jest.fn(async () => ({ rejected: [] })),
    } as never,
    bus: createEventBus(),
    deliverEvent: () => {},
    owner: {
      kind: 'plugin' as const,
      extensionId: 'test.ui',
      handle: 'test.ui:inc-1',
    },
    ...overrides,
  };
}

describe('buildSurfaces — ui.handle/unhandle/broadcast (B1)', () => {
  it('bundled tier: handle/unhandle/broadcast all succeed and reach the registry', () => {
    const uiRegistry = createUiRegistry();
    const deps = makeDeps({ uiRegistry, tier: 'bundled' });
    const { surfaces } = buildSurfaces(deps);
    expect(() => surfaces.ui.handle('foo')).not.toThrow();
    expect(uiRegistry.resolve('test.ui', 'foo')).toEqual({
      incarnation: 'test.ui:inc-1',
      tier: 'bundled',
    });
    expect(() => surfaces.ui.broadcast('foo', { a: 1 })).not.toThrow();
    expect(() => surfaces.ui.unhandle('foo')).not.toThrow();
    expect(uiRegistry.resolve('test.ui', 'foo')).toBeUndefined();
  });

  it('external tier: handle/unhandle/broadcast are ALL denied with a CapError', () => {
    const uiRegistry = createUiRegistry();
    const deps = makeDeps({ uiRegistry, tier: 'external' });
    const { surfaces } = buildSurfaces(deps);
    expect(() => surfaces.ui.handle('foo')).toThrow(CapError);
    expect(() => surfaces.ui.handle('foo')).toThrow(/external-tier/);
    expect(() => surfaces.ui.unhandle('foo')).toThrow(CapError);
    expect(() => surfaces.ui.broadcast('foo', 1)).toThrow(CapError);
    // Denied registration never reaches the registry.
    expect(uiRegistry.namesFor('test.ui')).toEqual([]);
  });

  it('external tier: notify still works — ui.notify stays all-tier', () => {
    const uiRegistry = createUiRegistry();
    const deps = makeDeps({ uiRegistry, tier: 'external' });
    const { surfaces } = buildSurfaces(deps);
    expect(() => surfaces.ui.notify('hello')).not.toThrow();
    expect(deps.notify).toHaveBeenCalledWith('hello', undefined);
  });

  it('omitted tier defaults to the more restrictive external (matches parseManifest convention)', () => {
    const uiRegistry = createUiRegistry();
    const deps = makeDeps({ uiRegistry });
    const { surfaces } = buildSurfaces(deps);
    expect(() => surfaces.ui.handle('foo')).toThrow(CapError);
  });

  it('duplicate names REJECT through the surface (host-side, authoritative)', () => {
    const uiRegistry = createUiRegistry();
    const deps = makeDeps({ uiRegistry, tier: 'bundled' });
    const { surfaces } = buildSurfaces(deps);
    surfaces.ui.handle('foo');
    expect(() => surfaces.ui.handle('foo')).toThrow(/already registered/);
  });

  it("close() (buildSurfaces' own teardown) synchronously clears this incarnation's registrations", async () => {
    const uiRegistry = createUiRegistry();
    const deps = makeDeps({ uiRegistry, tier: 'bundled' });
    const { surfaces, close } = buildSurfaces(deps);
    surfaces.ui.handle('foo');
    expect(uiRegistry.namesFor('test.ui')).toEqual(['foo']);
    await close();
    expect(uiRegistry.namesFor('test.ui')).toEqual([]);
  });

  it('an aborted lifecycle signal closes registration SYNCHRONOUSLY — before the listener call even returns', () => {
    const uiRegistry = createUiRegistry();
    const controller = new AbortController();
    const deps = makeDeps({
      uiRegistry,
      tier: 'bundled',
      signal: controller.signal,
    });
    const { surfaces } = buildSurfaces(deps);
    surfaces.ui.handle('foo');
    expect(uiRegistry.namesFor('test.ui')).toEqual(['foo']);
    controller.abort();
    // No await, no microtask — proves the listener ran synchronously inside
    // abort(), matching host-process.ts's own synchronous
    // lifecycle.abort() at the start of every teardown path.
    expect(uiRegistry.namesFor('test.ui')).toEqual([]);
  });

  it('an ALREADY-aborted signal closes registration before buildSurfaces even returns — no listener ever fires for a signal that fired before this ran', () => {
    const uiRegistry = createUiRegistry();
    const controller = new AbortController();
    controller.abort();
    const deps = makeDeps({
      uiRegistry,
      tier: 'bundled',
      signal: controller.signal,
    });
    const { surfaces } = buildSurfaces(deps);
    expect(() => surfaces.ui.handle('foo')).toThrow(/torn down/);
    expect(uiRegistry.namesFor('test.ui')).toEqual([]);
  });

  it('ui.broadcast rejects synchronously on an unclonable payload, before it ever reaches the registry or a subscriber', () => {
    const uiRegistry = createUiRegistry();
    const received: unknown[] = [];
    uiRegistry.onBroadcast((evt) => received.push(evt));
    const deps = makeDeps({ uiRegistry, tier: 'bundled' });
    const { surfaces } = buildSurfaces(deps);
    expect(() => surfaces.ui.broadcast('foo', { f() {} })).toThrow(CapError);
    expect(() => surfaces.ui.broadcast('foo', { f() {} })).toThrow(
      /structured-clone-safe/,
    );
    expect(received).toEqual([]);
    // A clone-safe payload still goes through fine.
    expect(() => surfaces.ui.broadcast('foo', { a: 1 })).not.toThrow();
    expect(received).toEqual([
      { extensionId: 'test.ui', name: 'foo', payload: { a: 1 } },
    ]);
  });

  it('a live registration made through ANOTHER incarnation is unaffected by this one aborting', () => {
    const uiRegistry = createUiRegistry();
    const other = uiRegistry.bind('test.ui', 'test.ui:other-inc', 'bundled');
    other.handle('bar');

    const controller = new AbortController();
    const deps = makeDeps({
      uiRegistry,
      tier: 'bundled',
      signal: controller.signal,
      owner: {
        kind: 'plugin' as const,
        extensionId: 'test.ui',
        handle: 'test.ui:this-inc',
      },
    });
    const { surfaces } = buildSurfaces(deps);
    surfaces.ui.handle('foo');
    controller.abort();
    expect(uiRegistry.namesFor('test.ui')).toEqual(['bar']);
  });
});
