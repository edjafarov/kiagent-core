/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AppDb } from '../db/app-db';
import type { CorePlatform } from '../core/boot';
import { createBootTimer } from '../core/boot-timing';
import { DEFAULT_PRODUCT } from '../product';
import {
  createRuntime,
  RuntimeStopped,
  type Runtime,
  type RuntimeHost,
} from '../runtime';

// The real runtime over the real bootCore and an in-process SQLite (no DB
// worker thread; the read worker fails to open, so reads fall back to the
// writer). Only the two edges that reach outside the process are replaced:
// the MCP listener and the extension platform, whose inputs are captured.

jest.mock('../db/worker-client', () => {
  const actual = jest.requireActual('../db/worker-client');
  const { openDb } = jest.requireActual('../db/app-db');
  return {
    ...actual,
    openDbInWorker: async (
      dbPath: string,
      _file: string,
      opts?: { role?: string },
    ): Promise<AppDb> => {
      if (opts?.role === 'read') throw new Error('no read worker in tests');
      return openDb(dbPath);
    },
  };
});

/** Which caller each read plane handed out was made for. */
const planeOf = new WeakMap<object, string>();
/** Lets a test hold bootCore open to stop the runtime mid-construction. */
const gate: { hold: Promise<void> | null } = { hold: null };
/** shutdown() spies of every platform bootCore produced. */
const shutdowns: jest.SpyInstance[] = [];

jest.mock('../core/boot', () => {
  const actual = jest.requireActual('../core/boot');
  return {
    ...actual,
    bootCore: async (deps: unknown) => {
      const p: CorePlatform = await actual.bootCore(deps);
      const { readsFor } = p;
      p.readsFor = (caller) => {
        const query = readsFor(caller);
        planeOf.set(query, caller);
        return query;
      };
      shutdowns.push(jest.spyOn(p, 'shutdown'));
      if (gate.hold) await gate.hold;
      return p;
    },
  };
});

const sqlRunner = { exec: jest.fn(), diagnostics: jest.fn(), stop: jest.fn() };
jest.mock('../core/mcp/sql-runner', () => ({
  createSqlRunner: () => sqlRunner,
}));

const mcpDeps: Array<Record<string, unknown>> = [];
const mcpStop = jest.fn(async () => {});
jest.mock('../core/mcp/server', () => ({
  startMcp: async (deps: Record<string, unknown>) => {
    mcpDeps.push(deps);
    return {
      port: 7421,
      stop: mcpStop,
      clients: async () => [],
      registerTool: () => () => {},
      sqlDiagnostics: () => null,
    };
  },
}));

const order: string[] = [];
const extDeps: Array<Record<string, unknown>> = [];
const extStop = jest.fn(async () => {});
jest.mock('../platform/extension-platform', () => ({
  createExtensionPlatform: (deps: Record<string, unknown>) => {
    extDeps.push(deps);
    return {
      load: async () => {
        order.push('load');
      },
      startInProcess: async () => {
        order.push('in-process');
        return { activatedMs: {}, pending: [] };
      },
      startUtility: async () => {
        order.push('utility');
      },
      start: async () => {},
      stop: extStop,
      snapshot: () => [],
      refreshLane: () => {},
      seedExtensionSet: async () => {},
      reconcileExtensions: async () => {},
    };
  },
}));

/** A host with no window, tray or dialogs: touching one fails the test. */
function headlessHost(dir: string): {
  host: RuntimeHost;
  touched: string[];
} {
  const touched: string[] = [];
  const touch = (name: string) => (): never => {
    touched.push(name);
    throw new Error(`headless host touched ${name}`);
  };
  const host: RuntimeHost = {
    userDataDir: dir,
    isPackaged: false,
    product: { ...DEFAULT_PRODUCT, headless: true },
    bundledExtensionsDir: path.join(dir, 'bundled-extensions'),
    assetPath: (...parts) => path.join(dir, 'assets', ...parts),
    app: {
      getPath: () => dir,
      getVersion: () => '0.0.0',
      getName: () => 'test',
    },
    encryption: {
      encrypt: (s) => Buffer.from(s, 'utf8'),
      decrypt: (b) => b.toString('utf8'),
      encryptStrict: (s) => Buffer.from(s, 'utf8'),
      keystoreAvailable: () => true,
    },
    env: () => ({
      onBattery: false,
      thermal: 'nominal',
      appFocus: 'hidden',
      userActive: false,
    }),
    downscale: async (bytes, mime) => ({ bytes, mime }) as never,
    notifyRenderer: () => {},
    tray: touch('tray'),
    openWindow: touch('openWindow'),
    notify: touch('notify'),
    trashItem: touch('trashItem'),
    confirm: touch('confirm'),
    inform: touch('inform'),
    bootTimer: createBootTimer(() => {}),
    log: { warn: () => {} },
  };
  return { host, touched };
}

/** The background chain is fired, not awaited: wait for its last step. */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => {
      setTimeout(r, 10);
    });
  }
  expect(cond()).toBe(true);
}

describe('createRuntime', () => {
  let dir: string;
  let rt: Runtime | null = null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-runtime-'));
    order.length = 0;
    mcpDeps.length = 0;
    extDeps.length = 0;
    mcpStop.mockClear();
    extStop.mockClear();
    gate.hold = null;
    shutdowns.length = 0;
  });
  afterEach(async () => {
    await rt?.stop();
    rt = null;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('builds the services before the window phase and starts utility extensions after it, touching no window, tray or dialog', async () => {
    const { host, touched } = headlessHost(dir);
    rt = createRuntime(host);
    const h = await rt.ready;
    // Everything the IPC handler map needs exists before any extension runs.
    expect(order).toEqual([]);
    expect(h.platform.store).toBeDefined();
    expect(h.mcp.port).toBe(7421);
    expect(h.lastPush().state.ready).toBe(false);

    await rt.start({
      afterInProcessExtensions: async () => {
        order.push('window');
      },
    });
    await until(() => order.includes('utility'));
    expect(order).toEqual(['load', 'in-process', 'window', 'utility']);
    expect(touched).toEqual([]);
  });

  it('hands MCP the read plane and the killable SQL runner, and extensions their own read plane', async () => {
    rt = createRuntime(headlessHost(dir).host);
    await rt.ready;
    expect(mcpDeps).toHaveLength(1);
    expect(planeOf.get(mcpDeps[0].query as object)).toBe('mcp');
    expect(mcpDeps[0].sqlExecutor).toBe(sqlRunner);
    expect(extDeps).toHaveLength(1);
    expect(planeOf.get(extDeps[0].reads as object)).toBe('extension');
  });

  it('stop() while the services are still being built ends construction and shuts down what was acquired', async () => {
    let release = (): void => {};
    gate.hold = new Promise((r) => {
      release = r;
    });
    rt = createRuntime(headlessHost(dir).host);
    const stopped = rt.stop();
    release();
    // stop() itself waits for the step that was running and its cleanup.
    await stopped;
    expect(shutdowns).toHaveLength(1);
    expect(shutdowns[0]).toHaveBeenCalledTimes(1);
    await expect(rt.ready).rejects.toBeInstanceOf(RuntimeStopped);
    // Construction stopped at its first check: no listener was ever bound.
    expect(mcpDeps).toEqual([]);
    await expect(
      rt.start({ afterInProcessExtensions: async () => {} }),
    ).rejects.toBeInstanceOf(RuntimeStopped);
  });

  it('stop() during start: nothing further starts', async () => {
    const built = createRuntime(headlessHost(dir).host);
    rt = built;
    await built.ready;
    await built.start({
      afterInProcessExtensions: () => built.stop(),
    });
    await new Promise((r) => {
      setTimeout(r, 50);
    });
    expect(order).toEqual(['load', 'in-process']);
    expect(mcpStop).toHaveBeenCalledTimes(1);
    expect(extStop).toHaveBeenCalledTimes(1);
  });

  it('stop() after start stops the listener, the extensions and the platform, once', async () => {
    rt = createRuntime(headlessHost(dir).host);
    const h = await rt.ready;
    const shutdown = jest.spyOn(h.platform, 'shutdown');
    await rt.start({ afterInProcessExtensions: async () => {} });
    await until(() => order.includes('utility'));
    await rt.stop();
    await rt.stop();
    expect(mcpStop).toHaveBeenCalledTimes(1);
    expect(extStop).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});
