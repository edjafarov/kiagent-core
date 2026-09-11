/** @jest-environment node */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { openDbInWorker } from './src/main/db/worker-client';
import { openStore } from './src/main/core/store/store';
import { createExtensionPlatform } from './src/main/platform/extension-platform';
import { createNetworkService } from './src/main/platform/network-service';
import { createFileRootRegistry } from './src/main/platform/file-roots';
import { nodeForkTransport } from './src/main/platform/transport';
import { parseDatabaseDescriptor } from './src/main/platform/database-descriptor';

const workerFile = path.join(__dirname, 'src/main/db/worker-entry.ts');
const SETTINGS_DESCRIPTOR = parseDatabaseDescriptor({
  format: 1,
  objects: [{ name: 'settings', kind: 'table' }],
  modules: [
    {
      name: 'base',
      migrations: [
        {
          version: 0,
          statements: [
            'CREATE TABLE {{settings}} (id TEXT PRIMARY KEY, value TEXT NOT NULL)',
          ],
        },
      ],
    },
  ],
  legacy: { tables: [] },
});

function workerOptions() {
  const preload = path.join(
    os.tmpdir(),
    `shared-infra-e2e-preload-${process.pid}-${Date.now()}-${Math.random()}.js`,
  );
  const rootBetter = path.join(
    path.resolve(__dirname),
    'node_modules',
    'better-sqlite3',
  );
  fs.writeFileSync(
    preload,
    `const M=require('module');const o=M._resolveFilename;M._resolveFilename=function(r,...a){return r==='better-sqlite3'?o.call(this,${JSON.stringify(rootBetter)},...a):o.apply(this,[r,...a])}`,
  );
  return {
    preload,
    options: {
      execArgv: [
        '--no-experimental-strip-types',
        '-r',
        preload,
        '-r',
        'ts-node/register/transpile-only',
        '-r',
        'tsconfig-paths/register',
      ],
    },
  };
}

describe('shared plugin infrastructure real worker path', () => {
  it('drives two forked production hosts through the router and one worker/file', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-infra-e2e-'));
    const dbFile = path.join(tmp, 'kiagent.db');
    const extensionDir = path.join(tmp, 'extensions');
    const worker = workerOptions();
    const db = await openDbInWorker(dbFile, workerFile, worker.options);
    const tools = new Map<
      string,
      { call(args: Record<string, unknown>): Promise<unknown> }
    >();
    const roots = createFileRootRegistry();
    const fixtureServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('fixture');
    });
    let fixturePort = 0;
    let fixtureReady = true;
    const serviceOwners = new Set<string>();
    try {
      await new Promise<void>((resolve, reject) => {
        fixtureServer.once('error', reject);
        fixtureServer.listen(0, '127.0.0.1', resolve);
      });
      fixturePort = (fixtureServer.address() as { port: number }).port;
    } catch (error) {
      // Managed sandboxes may deny loopback binds. Keep the fork/RPC
      // cancellation assertion meaningful with the same real NetworkService
      // and a signal-aware bounded dependency in that environment.
      fixtureReady = false;
      expect((error as NodeJS.ErrnoException).code).toBe('EPERM');
    }
    const hostEntry = path.join(
      __dirname,
      'src/main/platform/extension-host-entry.ts',
    );
    const forkArgs = [
      '-r',
      'ts-node/register/transpile-only',
      '-r',
      'tsconfig-paths/register',
    ];
    const makeFixture = (id: string, value: string) => {
      const dir = path.join(extensionDir, id);
      fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'manifest.json'),
        JSON.stringify({
          id,
          name: id,
          version: '1.0.0',
          engine: '^2.0.0',
          entry: 'dist/index.js',
          caps: ['db', 'files', 'net'],
          database: { schema: 'dist/database.json' },
          contributes: { sources: [], senders: [] },
        }),
      );
      fs.writeFileSync(
        path.join(dir, 'dist/database.json'),
        JSON.stringify(SETTINGS_DESCRIPTOR),
      );
      fs.writeFileSync(
        path.join(dir, 'dist/index.js'),
        `
        let abort;
        module.exports = { async activate(host) {
          await host.db.exec('INSERT OR REPLACE INTO {{settings}} VALUES (?, ?)', ['value', '${value}']);
          abort = new AbortController();
          return { tools: [
            { name: '${id}.read', description: '', inputSchema: {}, call: async () => host.db.query('SELECT value FROM {{settings}}') },
            { name: '${id}.cross', description: '', inputSchema: {}, call: async () => host.db.query('SELECT * FROM "p_746573742e${id.endsWith('.a') ? '62' : '61'}__settings"') },
            { name: '${id}.proc', description: '', inputSchema: {}, call: async () => host.db.transaction(async tx => { await new Promise(resolve => setTimeout(resolve, 100)); await tx.exec('INSERT INTO {{settings}} VALUES (?, ?)', ['proc', '${value}']); }) },
            { name: '${id}.tx', description: '', inputSchema: {}, call: async () => host.db.transaction(async tx => { await tx.exec('INSERT INTO {{settings}} VALUES (?, ?)', ['rollback', 'x']); await new Promise((resolve, reject) => abort.signal.addEventListener('abort', () => reject(new Error('deactivated')), { once: true })); }) },
            { name: '${id}.net', description: '', inputSchema: {}, call: async () => host.net.fetch('http://127.0.0.1:${fixturePort}/wait', { signal: abort.signal, timeoutMs: 10000 }) },
            { name: '${id}.crash', description: '', inputSchema: {}, call: async () => { process.exit(1); } },
            { name: '${id}.watch', description: '', inputSchema: {}, call: async () => { const root = (await host.files.roots())[0]; await host.files.watch({ root: root.id, rel: '' }, undefined); return true; } },
          ] };
        }, deactivate() { abort?.abort(); } };
      `,
      );
    };
    makeFixture('test.a', 'A');
    makeFixture('test.b', 'B');
    const platformStore = openStore(db, {
      encrypt: (s) => Buffer.from(s),
      decrypt: (b) => b.toString(),
      detectLanguages: () => [],
      profileDir: tmp,
    });
    const networkFactory = (owner: string, signal: AbortSignal) => {
      serviceOwners.add(owner);
      return createNetworkService({
        owner,
        signal,
        log: () => undefined,
        // This is deliberately abort-gated: it exercises the production
        // NetworkService and forked RPC cancellation without opening a
        // socket or depending on the loopback guard's rejection behavior.
        fetch: async (_url, init) =>
          await new Promise((_resolve, reject) => {
            const abort = () =>
              reject(
                Object.assign(new Error('aborted'), {
                  name: 'AbortError',
                }),
              );
            if (init?.signal?.aborted) abort();
            else init?.signal?.addEventListener('abort', abort, { once: true });
          }),
      });
    };
    const platform = createExtensionPlatform({
      extDir: extensionDir,
      db,
      fileRoots: roots,
      store: platformStore,
      sources: {
        register: () => {},
        unregister: () => {},
        get: () => undefined,
        list: () => [],
      },
      senders: {
        register: () => {},
        unregister: () => {},
        get: () => undefined,
        ids: () => [],
      },
      scheduler: {
        register: jest.fn(),
        unregister: jest.fn(),
        jobs: jest.fn(async () => []),
        trigger: jest.fn(),
        env: {},
      } as never,
      registerTool: (tool: {
        name: string;
        call(args: Record<string, unknown>): Promise<unknown>;
      }) => {
        tools.set(tool.name, tool);
        return () => tools.delete(tool.name);
      },
      inference: {
        complete: async () => '',
        see: async () => '',
        read: async () => '',
        hear: async () => '',
        describe: async () => null,
      },
      laneState: () => 'open',
      onLaneChange: () => () => {},
      logSink: { log: () => {} } as never,
      notify: () => {},
      transportFactory: () =>
        nodeForkTransport(hostEntry, {
          cwd: __dirname,
          execArgv: forkArgs,
          env: {
            ...process.env,
            KIA_EXT_HOST_CHILD: '1',
            TS_NODE_TRANSPILE_ONLY: '1',
            TS_NODE_PROJECT: path.join(__dirname, 'tsconfig.json'),
          },
        }),
      networkFactory,
      onChange: () => {},
    } as never);
    try {
      await roots.grant('test.a', tmp, { name: 'e2e', writable: true });
      await roots.grant('test.b', tmp, { name: 'e2e', writable: true });
      for (const extensionId of ['test.a', 'test.b'])
        await platformStore.consents.record({
          extensionId: extensionId as never,
          caps: ['db', 'files', 'net'],
          manifestVersion: '1.0.0',
          grantedAt: new Date().toISOString(),
        });
      await platform.start();
      await platform.grantConsent('test.a');
      await platform.grantConsent('test.b');
      for (const owner of serviceOwners)
        await roots.grant(owner, tmp, { name: 'e2e', writable: true });
      if (!tools.has('test.a.read') || !tools.has('test.b.read'))
        throw new Error(
          `host activation failed: ${JSON.stringify(platform.snapshot())}`,
        );
      await expect(tools.get('test.a.read')!.call({})).resolves.toEqual([
        { value: 'A' },
      ]);
      await expect(tools.get('test.b.read')!.call({})).resolves.toEqual([
        { value: 'B' },
      ]);
      await expect(tools.get('test.a.cross')!.call({})).rejects.toThrow();
      const crash = tools
        .get('test.b.crash')!
        .call({})
        .catch((error) => error);
      await expect(crash).resolves.toMatchObject({
        name: 'Error',
        message: 'extension process exited',
      });
      const proc = tools.get('test.a.proc')!.call({});
      await new Promise((resolve) => setTimeout(resolve, 10));
      const coreStarted = Date.now();
      const coreCommit = platformStore.createAccount({
        source: 'core-e2e',
        identifier: 'core',
      });
      await Promise.all([proc, coreCommit]);
      expect(Date.now() - coreStarted).toBeGreaterThanOrEqual(60);
      const tx = tools
        .get('test.a.tx')!
        .call({})
        .catch((error) => error);
      const net = tools
        .get('test.a.net')!
        .call({})
        .catch((error) => error);
      const watch = tools.get('test.a.watch')!.call({});
      await watch;
      await platform.setEnabled('test.a', false);
      await expect(tx).resolves.toMatchObject({ message: 'deactivated' });
      await expect(net).resolves.toMatchObject({ name: 'AbortError' });
      await platform.setEnabled('test.a', true);
      await expect(tools.get('test.a.read')!.call({})).resolves.toEqual(
        expect.arrayContaining([{ value: 'A' }, { value: 'A' }]),
      );
      expect(await platformStore.read.count({ includeArchived: true })).toBe(0);
    } finally {
      await platform.stop().catch(() => undefined);
      await platformStore.close().catch(() => undefined);
      if (fixtureReady) fixtureServer.close(() => undefined);
      await db.close();
      for (const p of [worker.preload, tmp])
        if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    }
  });
});
