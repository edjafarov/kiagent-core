/**
 * @jest-environment node
 *
 * Drift guards for the two hand-written dispatch tables the extension
 * boundary depends on. Both are plain object literals a refactor can quietly
 * outgrow, and both fail SILENTLY when they do: an unlisted namespace lands
 * on host-router's 'unknown namespace', an unlisted method never appears on
 * the child's proxy at all (a TypeError inside the extension, no main-side
 * log). Neither shape is checkable by the compiler, so it is checked here.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { Cap, Query } from '@shared/contracts';

import { NS_METHODS } from '../extension-host-entry';
import { NS_CAP } from '../host-router';
import { buildSurfaces, createEventBus } from '../host-surfaces';
import { CAPS } from '../manifest';

/** Caps that deliberately have NO host namespace: 'send' is host-initiated
 *  (main→child only) and 'unsafe.mainProcess' is delivered as activate()'s
 *  extras, not as a surface. Everything else must be routable. */
const NAMESPACE_LESS: readonly Cap[] = ['send', 'unsafe.mainProcess'];

function realSurfaces() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-captable-'));
  const noop = async () => '';
  // buildSurfaces takes no caps argument — it builds every namespace
  // unconditionally and the grant check lives in host-router — so this IS
  // the "all caps granted" surface set.
  const built = buildSurfaces({
    extensionId: 'test.captable',
    dataDir,
    query: {} as Query,
    inference: {
      complete: noop,
      see: noop,
      read: noop,
      hear: noop,
      lane: async () => 'open' as const,
    },
    notify: () => {},
    bus: createEventBus(),
    deliverEvent: () => {},
  });
  return {
    surfaces: built.surfaces,
    cleanup: () => {
      built.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

describe('NS_CAP (host-router) covers every namespace-bearing cap', () => {
  it('has exactly one identity entry per cap that is not deliberately namespace-less', () => {
    const expected = CAPS.filter((c) => !NAMESPACE_LESS.includes(c));
    // Caps map 1:1 onto namespaces by name (host-router's doc comment) —
    // so the whole table is derivable, and any hand-edit that breaks the
    // identity shows up here.
    expect(Object.keys(NS_CAP).sort()).toEqual([...expected].sort());
    for (const ns of Object.keys(NS_CAP)) expect(NS_CAP[ns]).toBe(ns);
  });

  it('routes every namespace the real surfaces expose', () => {
    const { surfaces, cleanup } = realSurfaces();
    try {
      expect(Object.keys(surfaces).sort()).toEqual(Object.keys(NS_CAP).sort());
    } finally {
      cleanup();
    }
  });
});

describe('NS_METHODS (extension-host-entry) matches the real surfaces', () => {
  // 'events' is the one namespace the child does NOT drive from NS_METHODS:
  // buildRemoteHost hand-rolls it because `on` must return an unsubscribe
  // closure and reference-count its subscribers, which a generic
  // method-list proxy cannot express (the host surface correspondingly
  // carries an extra `off` the child never exposes directly).
  const HAND_ROLLED = ['events'];

  it('lists exactly the namespaces the child proxies generically', () => {
    const { surfaces, cleanup } = realSurfaces();
    try {
      const expected = Object.keys(surfaces).filter(
        (ns) => !HAND_ROLLED.includes(ns),
      );
      expect(Object.keys(NS_METHODS).sort()).toEqual(expected.sort());
    } finally {
      cleanup();
    }
  });

  it.each(Object.keys(NS_METHODS))(
    "%s's method list equals its surface's own keys",
    (ns) => {
      const { surfaces, cleanup } = realSurfaces();
      try {
        expect([...NS_METHODS[ns]].sort()).toEqual(
          Object.keys(surfaces[ns]).sort(),
        );
      } finally {
        cleanup();
      }
    },
  );
});
