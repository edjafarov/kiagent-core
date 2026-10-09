/** Shared harness for the #140/#137 platform suites: a real store, fake
 *  source/sender/tool registries, and the real child runtime over in-memory
 *  pairs (one fresh pair per spawn — exactly what a wake needs). */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type {
  ExtensionSnapshot,
  McpTool,
  Sender,
  Source,
} from '@shared/contracts';
import { openDb } from '@main/db/app-db';
import { openStore, type CoreStore } from '@main/core/store/store';

import {
  createExtensionPlatform,
  type ExtensionPlatform,
  type ExtensionPlatformDeps,
} from '../../extension-platform';
import { runExtensionHost } from '../../extension-host-entry';
import { createInMemoryHostPair } from '../../transport';

export const FIXTURES = path.join(__dirname, '..', 'fixtures');

export async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 10));
  }
}

export interface PlatformHarness {
  tmp: string;
  store: CoreStore;
  registry: Map<string, Source>;
  tools: Map<string, McpTool>;
  logs: Array<{ scope: string; level: string; msg: string }>;
  snapshots: ExtensionSnapshot[][];
  /** transportFactory (utility-process) spawns, per extension id. */
  spawns: Map<string, number>;
  counts: { registerTool: number };
  scheduler: { register: jest.Mock; unregister: jest.Mock };
  make(overrides?: Partial<ExtensionPlatformDeps>): ExtensionPlatform;
  /** Copies a fixture into <tmp>/bundled and returns that bundledDir. */
  copyBundled(fixture: string): string;
  /** installPreview + installCommit through `platform`; returns the id. */
  install(platform: ExtensionPlatform, fixture: string): Promise<string>;
  close(): Promise<void>;
}

export async function createHarness(): Promise<PlatformHarness> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-boot-'));
  const store = openStore(await openDb(path.join(tmp, 'kiagent.db')), {
    encrypt: (s) => Buffer.from(s, 'utf8'),
    decrypt: (b) => b.toString('utf8'),
    detectLanguages: () => [],
  });
  const registry = new Map<string, Source>();
  const senders = new Map<string, Sender>();
  const tools = new Map<string, McpTool>();
  const logs: PlatformHarness['logs'] = [];
  const snapshots: ExtensionSnapshot[][] = [];
  const spawns = new Map<string, number>();
  const counts = { registerTool: 0 };
  const scheduler = { register: jest.fn(), unregister: jest.fn() };
  const h: PlatformHarness = {
    tmp,
    store,
    registry,
    tools,
    logs,
    snapshots,
    spawns,
    counts,
    scheduler,
    make: (overrides = {}) =>
      createExtensionPlatform({
        extDir: path.join(tmp, 'extensions'),
        store,
        attention: {
          publish: async () => ({ rejected: [] }),
          resolve: async () => ({ rejected: [] }),
        } as never,
        sources: {
          register: (s: Source) => void registry.set(s.descriptor.id, s),
          get: (id: string) => registry.get(id),
          list: () => [...registry.values()].map((s) => s.descriptor),
          unregister: (id: string) => void registry.delete(id),
        },
        senders: {
          register: (id: string, s: Sender) => void senders.set(id, s),
          get: (id: string) => senders.get(id),
          ids: () => [...senders.keys()],
          unregister: (id: string) => void senders.delete(id),
        },
        scheduler: {
          ...scheduler,
          jobs: jest.fn(async () => []),
          trigger: jest.fn(),
          env: {},
        } as never,
        registerTool: (t) => {
          counts.registerTool += 1;
          tools.set(t.name, t);
          return () => tools.delete(t.name);
        },
        inference: {
          complete: async () => '',
          see: async () => '',
          read: async () => '',
          hear: async () => '',
          describe: async () => null,
        },
        laneState: () => 'open',
        logSink: {
          log: (scope: string, level: string, msg: string) =>
            logs.push({ scope, level, msg }),
        } as never,
        notify: jest.fn(),
        transportFactory: (id) => {
          spawns.set(id, (spawns.get(id) ?? 0) + 1);
          const pair = createInMemoryHostPair();
          runExtensionHost(pair.child, { exit: (c) => pair.simulateExit(c) });
          return pair.main;
        },
        onChange: (snap) => snapshots.push(snap),
        ...overrides,
      }),
    copyBundled: (fixture) => {
      const bundledDir = path.join(tmp, 'bundled');
      fs.cpSync(path.join(FIXTURES, fixture), path.join(bundledDir, fixture), {
        recursive: true,
      });
      return bundledDir;
    },
    install: async (platform, fixture) => {
      const preview = await platform.installPreview(fixture);
      if (!('token' in preview)) throw new Error(JSON.stringify(preview));
      const result = await platform.installCommit(preview.token);
      if (!result.ok || !result.id) throw new Error(result.error);
      return result.id;
    },
    close: async () => {
      await store.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
  return h;
}
