/** @jest-environment node */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { openDbInWorker } from './src/main/db/worker-client';
import { buildSurfaces } from './src/main/platform/host-surfaces';
import { createNetworkService } from './src/main/platform/network-service';
import { createFileRootRegistry } from './src/main/platform/file-roots';
import { createScopedFiles } from './src/main/platform/scoped-files';
import { DESCRIPTOR } from './src/main/db/__tests__/plugin-test-fixture';

const workerFile = path.join(__dirname, 'src/main/db/worker-entry.ts');

function workerOptions(sourceA: string, sourceB: string) {
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
      pluginSources: {
        'test.plugin.a': sourceA,
        'test.plugin.b': sourceB,
      },
    },
  };
}

function makeLegacy(file: string, value: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(
    'CREATE TABLE profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE, rank INTEGER NOT NULL); CREATE TABLE user_overrides (profile_id TEXT PRIMARY KEY REFERENCES profiles(id), value TEXT NOT NULL); CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id TEXT NOT NULL REFERENCES profiles(id), status TEXT NOT NULL, payload BLOB); CREATE TABLE schema_meta (module TEXT PRIMARY KEY, version INTEGER NOT NULL);',
  );
  db.prepare(
    'INSERT INTO profiles(id, name, email, rank) VALUES (?, ?, ?, ?)',
  ).run('one', value, `${value}@example.test`, 1);
  db.prepare('INSERT INTO schema_meta(module, version) VALUES (?, ?)').run(
    'base',
    0,
  );
  db.close();
}

describe('shared plugin infrastructure real worker path', () => {
  it('isolates two owners on one worker/file and never opens main-thread private.db', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-infra-e2e-'));
    const dbFile = path.join(tmp, 'kiagent.db');
    const dataA = path.join(tmp, 'a-data');
    const dataB = path.join(tmp, 'b-data');
    const sourceA = path.join(dataA, 'private.db');
    const sourceB = path.join(dataB, 'private.db');
    makeLegacy(sourceA, 'A');
    makeLegacy(sourceB, 'B');
    const worker = workerOptions(sourceA, sourceB);
    const db = await openDbInWorker(dbFile, workerFile, worker.options);
    const ownerA = {
      kind: 'plugin' as const,
      extensionId: 'test.plugin.a',
      handle: 'a-incarnation',
    };
    const ownerB = {
      kind: 'plugin' as const,
      extensionId: 'test.plugin.b',
      handle: 'b-incarnation',
    };
    try {
      for (const pluginId of ['test.plugin.a', 'test.plugin.b']) {
        await db.plugin?.({ op: 'register', pluginId, descriptor: DESCRIPTOR });
        await db.plugin?.({ op: 'prepare', pluginId, descriptor: DESCRIPTOR });
      }
      await db.plugin?.({
        op: 'open',
        owner: ownerA,
        pluginId: ownerA.extensionId,
      });
      await db.plugin?.({
        op: 'open',
        owner: ownerB,
        pluginId: ownerB.extensionId,
      });

      const base = {
        extensionId: 'test.plugin.a',
        dataDir: path.join(tmp, 'main-surface-a'),
        appDb: db,
        owner: ownerA,
        query: {} as never,
        inference: {
          complete: async () => '',
          see: async () => '',
          read: async () => '',
          hear: async () => '',
          lane: async () => 'open' as const,
        },
        notify: () => undefined,
        bus: { emit: () => undefined, subscribe: () => () => undefined },
        deliverEvent: () => undefined,
      };
      const serviceOwner = `${ownerA.extensionId}:${ownerA.handle}`;
      const roots = createFileRootRegistry();
      const root = await roots.grant(ownerA.extensionId, tmp, {
        name: 'shared-infra-e2e',
        writable: true,
      });
      const ownerAbort = new AbortController();
      const network = createNetworkService({
        owner: serviceOwner,
        signal: ownerAbort.signal,
        fetch: async (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => {
                const error = new Error('aborted');
                error.name = 'AbortError';
                reject(error);
              },
              { once: true },
            );
          }),
        log: () => undefined,
      });
      const files = createScopedFiles({
        owner: ownerA.extensionId,
        roots,
        signal: ownerAbort.signal,
      });
      const a = buildSurfaces({ ...base, network, files } as never);
      const b = buildSurfaces({
        ...base,
        extensionId: 'test.plugin.b',
        dataDir: path.join(tmp, 'main-surface-b'),
        owner: ownerB,
      } as never);
      await a.surfaces.db.exec('INSERT INTO {{profiles}} VALUES (?, ?, ?, ?)', [
        'a',
        'A',
        'a@example.test',
        2,
      ]);
      await b.surfaces.db.exec('INSERT INTO {{profiles}} VALUES (?, ?, ?, ?)', [
        'b',
        'B',
        'b@example.test',
        3,
      ]);
      await expect(
        a.surfaces.db.query('SELECT name FROM {{profiles}} ORDER BY id'),
      ).resolves.toEqual([{ name: 'A' }, { name: 'A' }]);
      await expect(
        b.surfaces.db.query('SELECT name FROM {{profiles}} ORDER BY id'),
      ).resolves.toEqual([{ name: 'B' }, { name: 'B' }]);
      await expect(
        a.surfaces.db.query(
          `SELECT * FROM ${b.surfaces.db.identifier('profiles')}`,
        ),
      ).rejects.toThrow();
      const escape = path.join(tmp, 'escape.db');
      await expect(
        a.surfaces.db.exec(`ATTACH DATABASE '${escape}' AS out`),
      ).rejects.toThrow(/ATTACH/i);
      await expect(
        a.surfaces.db.exec(`VACUUM INTO '${escape}'`),
      ).rejects.toThrow(/VACUUM INTO|schema changes/i);
      expect(fs.existsSync(escape)).toBe(false);
      expect(fs.existsSync(path.join(base.dataDir, 'private.db'))).toBe(false);
      expect(
        fs.existsSync(path.join(tmp, 'main-surface-b', 'private.db')),
      ).toBe(false);
      const token = await (
        a.surfaces.db.begin as (...args: unknown[]) => Promise<string>
      )();
      await (a.surfaces.db.exec as (...args: unknown[]) => Promise<void>)(
        token,
        'INSERT INTO {{profiles}} VALUES (?, ?, ?, ?)',
        ['rollback', 'rollback', 'rollback@example.test', 9],
      );
      const pendingNet = (
        a.surfaces.net.fetch as (...args: unknown[]) => Promise<unknown>
      )('https://example.test', {}).then(
        () => null,
        (error: unknown) => error,
      );
      const pendingWatch = a.surfaces.files.watch(
        { root: root.id, rel: '' },
        () => undefined,
      );
      await pendingWatch;
      await a.close();
      await expect(pendingNet).resolves.toMatchObject({ name: 'AbortError' });
      await db.plugin?.({
        op: 'open',
        owner: { ...ownerA, handle: 'a-after-close' },
        pluginId: ownerA.extensionId,
      });
      await expect(
        db.plugin?.({
          op: 'query',
          owner: { ...ownerA, handle: 'a-after-close' },
          sql: 'SELECT id FROM {{profiles}} WHERE id = ?',
          params: ['rollback'],
        }),
      ).resolves.toEqual([]);
      await db.plugin?.({
        op: 'release',
        owner: { ...ownerA, handle: 'a-after-close' },
      });
      await b.close();
    } finally {
      await db
        .plugin?.({ op: 'release', owner: ownerA })
        .catch(() => undefined);
      await db
        .plugin?.({ op: 'release', owner: ownerB })
        .catch(() => undefined);
      await db.close();
      for (const p of [worker.preload, tmp])
        if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    }
  });
});
