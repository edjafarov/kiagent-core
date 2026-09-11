/** @jest-environment node */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDbInWorker, DB_WORKER_CRASHED } from '../worker-client';

const DESCRIPTOR = {
  format: 1 as const,
  objects: [{ name: 'items', kind: 'table' as const }],
  modules: [
    {
      name: 'base',
      migrations: [
        {
          version: 0,
          statements: ['CREATE TABLE {{items}} (id TEXT PRIMARY KEY)'],
        },
      ],
    },
  ],
  legacy: { tables: [{ name: 'items', columns: ['id'] }] },
};

it('reopens the real worker, rejects the stale plugin handle, and re-registers the trusted source', async () => {
  const file = path.join(
    os.tmpdir(),
    `plugin-respawn-${process.pid}-${Date.now()}.sqlite`,
  );
  const sourceFile = path.join(
    os.tmpdir(),
    `plugin-respawn-source-${process.pid}-${Date.now()}`,
    'private.db',
  );
  const preload = path.join(
    os.tmpdir(),
    `plugin-respawn-preload-${process.pid}-${Date.now()}.js`,
  );
  const rootBetter = path.join(
    path.resolve(__dirname, '..', '..', '..', '..'),
    'node_modules',
    'better-sqlite3',
  );
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  fs.writeFileSync(
    preload,
    `const M=require('module');const o=M._resolveFilename;M._resolveFilename=function(r,...a){return r==='better-sqlite3'?o.call(this,${JSON.stringify(rootBetter)},...a):o.apply(this,[r,...a])}`,
  );
  const source = new Database(sourceFile);
  source.exec(
    "CREATE TABLE items (id TEXT PRIMARY KEY); INSERT INTO items VALUES ('before-crash')",
  );
  source.close();
  const execArgv = [
    '--no-experimental-strip-types',
    '-r',
    preload,
    '-r',
    'ts-node/register/transpile-only',
    '-r',
    'tsconfig-paths/register',
  ];
  const oldOwner = {
    kind: 'plugin' as const,
    extensionId: 'respawn.plugin',
    handle: 'old-owner',
  };
  const newOwner = {
    kind: 'plugin' as const,
    extensionId: 'respawn.plugin',
    handle: 'new-owner',
  };
  let db: Awaited<ReturnType<typeof openDbInWorker>> | undefined;
  try {
    db = await openDbInWorker(
      file,
      require.resolve('./fixtures/respawn-plugin-worker-entry.ts'),
      { execArgv },
    );
    await db.registerPluginSource!('respawn.plugin', sourceFile, DESCRIPTOR);
    await db.plugin!({
      op: 'prepare',
      pluginId: 'respawn.plugin',
      descriptor: DESCRIPTOR,
    });
    await db.plugin!({
      op: 'open',
      pluginId: 'respawn.plugin',
      owner: oldOwner,
    });
    await expect(
      db.plugin!({
        op: 'query',
        owner: oldOwner,
        sql: 'SELECT * FROM {{items}}',
      }),
    ).resolves.toEqual([{ id: 'before-crash' }]);

    const crash = db.proc!('crash', null).then(
      () => null,
      (error) => error,
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    const queuedSignal = new AbortController();
    const queued = db.plugin!(
      { op: 'diagnostics' },
      { signal: queuedSignal.signal },
    );
    setTimeout(() => queuedSignal.abort(), 5);
    await expect(queued).rejects.toMatchObject({
      code: 'DB_OPERATION_CANCELLED',
    });
    await expect(crash).resolves.toMatchObject({ code: DB_WORKER_CRASHED });
    await expect(
      db.plugin!({
        op: 'query',
        owner: oldOwner,
        sql: 'SELECT * FROM {{items}}',
      }),
    ).rejects.toMatchObject({ code: 'PLUGIN_DB_NOT_OPEN' });
    await expect(
      db.plugin!({
        op: 'prepare',
        pluginId: 'respawn.plugin',
        descriptor: DESCRIPTOR,
      }),
    ).resolves.toEqual(expect.objectContaining({ state: 'active' }));
    await db.plugin!({
      op: 'open',
      pluginId: 'respawn.plugin',
      owner: newOwner,
    });
    await expect(
      db.plugin!({
        op: 'query',
        owner: newOwner,
        sql: 'SELECT * FROM {{items}}',
      }),
    ).resolves.toEqual([{ id: 'before-crash' }]);
  } finally {
    if (db?.isOpen()) await db.close();
    for (const p of [
      file,
      `${file}-wal`,
      `${file}-shm`,
      sourceFile,
      `${sourceFile}-wal`,
      `${sourceFile}-shm`,
      preload,
      path.dirname(sourceFile),
    ])
      if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
  }
}, 15000);
