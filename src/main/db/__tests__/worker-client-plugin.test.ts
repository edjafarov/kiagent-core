/** @jest-environment node */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { openDbInWorker } from '../worker-client';
import { DESCRIPTOR } from './plugin-test-fixture';

const WORKER_DESCRIPTOR = {
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

it('serializes a diagnostics request through the bridge fixture (transport only)', async () => {
  const file = path.join(
    os.tmpdir(),
    `plugin-worker-${process.pid}-${Date.now()}.sqlite`,
  );
  const preload = path.join(
    os.tmpdir(),
    `plugin-worker-preload-${process.pid}-${Date.now()}.js`,
  );
  const rootBetter = path.join(
    path.resolve(__dirname, '..', '..', '..', '..'),
    'node_modules',
    'better-sqlite3',
  );
  fs.writeFileSync(
    preload,
    `const M=require('module');const o=M._resolveFilename;M._resolveFilename=function(r,...a){return r==='better-sqlite3'?o.call(this,${JSON.stringify(rootBetter)},...a):o.apply(this,[r,...a])}`,
  );
  const db = await openDbInWorker(
    file,
    require.resolve('./fixtures/plugin-worker-entry.ts'),
    {
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
  );
  await expect(db.plugin?.({ op: 'diagnostics' })).resolves.toEqual({
    op: 'diagnostics',
  });
  await db.close();
  for (const p of [file, `${file}-wal`, `${file}-shm`, preload])
    if (fs.existsSync(p)) fs.rmSync(p);
});

it('registers through the production worker and keeps an unavailable namespace closed before import', async () => {
  const file = path.join(
    os.tmpdir(),
    `plugin-worker-register-${process.pid}-${Date.now()}.sqlite`,
  );
  const preload = path.join(
    os.tmpdir(),
    `plugin-worker-register-preload-${process.pid}-${Date.now()}.js`,
  );
  const legacyPath = path.join(
    path.dirname(file),
    'bundled-extensions-data',
    'worker.registration',
    'private.db',
  );
  const rootBetter = path.join(
    path.resolve(__dirname, '..', '..', '..', '..'),
    'node_modules',
    'better-sqlite3',
  );
  fs.writeFileSync(
    preload,
    `const M=require('module');const o=M._resolveFilename;M._resolveFilename=function(r,...a){return r==='better-sqlite3'?o.call(this,${JSON.stringify(rootBetter)},...a):o.apply(this,[r,...a])}`,
  );
  const db = await openDbInWorker(file, require.resolve('../worker-entry.ts'), {
    execArgv: [
      '--no-experimental-strip-types',
      '-r',
      preload,
      '-r',
      'ts-node/register/transpile-only',
      '-r',
      'tsconfig-paths/register',
    ],
    pluginSources: { 'worker.registration': legacyPath },
  });
  await expect(
    db.plugin?.({
      op: 'register',
      pluginId: 'worker.registration',
      descriptor: WORKER_DESCRIPTOR,
    }),
  ).resolves.toEqual(expect.objectContaining({ state: 'registered' }));
  const owner = {
    kind: 'plugin' as const,
    extensionId: 'worker.registration',
    handle: 'registration-owner',
  };
  await expect(
    db.plugin?.({ op: 'open', owner, pluginId: owner.extensionId }),
  ).rejects.toMatchObject({ code: 'PLUGIN_DB_IMPORT_INCOMPLETE' });
  await db.close();
  for (const p of [file, `${file}-wal`, `${file}-shm`, preload])
    if (fs.existsSync(p)) fs.rmSync(p);
});

it('prepares and opens a trusted WAL legacy source through the production worker', async () => {
  const file = path.join(
    os.tmpdir(),
    `plugin-worker-import-${process.pid}-${Date.now()}.sqlite`,
  );
  const sourceFile = path.join(
    os.tmpdir(),
    `plugin-worker-import-source-${process.pid}-${Date.now()}`,
    'private.db',
  );
  const preload = path.join(
    os.tmpdir(),
    `plugin-worker-import-preload-${process.pid}-${Date.now()}.js`,
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
  source.pragma('journal_mode = WAL');
  source.pragma('foreign_keys = ON');
  source.exec(
    'CREATE TABLE profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE, rank INTEGER NOT NULL); CREATE TABLE user_overrides (profile_id TEXT PRIMARY KEY REFERENCES profiles(id), value TEXT NOT NULL); CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id TEXT NOT NULL REFERENCES profiles(id), status TEXT NOT NULL, payload BLOB); CREATE TABLE schema_meta (module TEXT PRIMARY KEY, version INTEGER NOT NULL);',
  );
  const seed = source.transaction(() => {
    source
      .prepare('INSERT INTO schema_meta(module, version) VALUES (?, ?)')
      .run('base', 0);
    const insertProfile = source.prepare(
      'INSERT INTO profiles(id, name, email, rank) VALUES (?, ?, ?, ?)',
    );
    const insertJob = source.prepare(
      'INSERT INTO jobs(profile_id, status, payload) VALUES (?, ?, ?)',
    );
    for (let i = 0; i < 1001; i++) {
      const id = `p-${String(i).padStart(4, '0')}`;
      insertProfile.run(
        id,
        `Person ${i}`,
        `${id}@example.test`,
        i === 1000 ? 9007199254740993n : i,
      );
      insertJob.run(
        id,
        i === 1000 ? 'processing' : 'queued',
        i === 1000 ? Buffer.from([0, 255, 7]) : null,
      );
    }
    source
      .prepare('INSERT INTO user_overrides(profile_id, value) VALUES (?, ?)')
      .run('p-1000', 'edited by user');
  });
  seed();
  const owner = {
    kind: 'plugin' as const,
    extensionId: 'worker.import',
    handle: 'import-owner',
  };
  let db: Awaited<ReturnType<typeof openDbInWorker>> | undefined;
  try {
    db = await openDbInWorker(file, require.resolve('../worker-entry.ts'), {
      execArgv: [
        '--no-experimental-strip-types',
        '-r',
        preload,
        '-r',
        'ts-node/register/transpile-only',
        '-r',
        'tsconfig-paths/register',
      ],
      pluginSources: { 'worker.import': sourceFile },
    });
    await expect(
      db.plugin?.({
        op: 'register',
        pluginId: 'worker.import',
        descriptor: DESCRIPTOR,
      }),
    ).resolves.toEqual(expect.objectContaining({ state: 'registered' }));
    const prepared = await Promise.all([
      db.plugin?.({
        op: 'prepare',
        pluginId: 'worker.import',
        descriptor: DESCRIPTOR,
      }),
      db.plugin?.({
        op: 'prepare',
        pluginId: 'worker.import',
        descriptor: DESCRIPTOR,
      }),
    ]);
    expect(prepared).toEqual([
      expect.objectContaining({ state: 'active' }),
      expect.objectContaining({ state: 'active' }),
    ]);
    await expect(
      db.plugin?.({ op: 'open', owner, pluginId: owner.extensionId }),
    ).resolves.toEqual({ opened: true });
    await expect(
      db.plugin?.({
        op: 'query',
        owner,
        sql: 'SELECT COUNT(*) AS count FROM {{profiles}}',
      }),
    ).resolves.toEqual([{ count: 1001 }]);
    await expect(
      db.plugin?.({
        op: 'query',
        owner,
        sql: 'SELECT id, rank FROM {{profiles}} WHERE id = ?',
        params: ['p-1000'],
      }),
    ).resolves.toEqual([{ id: 'p-1000', rank: 9007199254740993n }]);
    await expect(
      db.plugin?.({
        op: 'query',
        owner,
        sql: 'SELECT value FROM {{user_overrides}} WHERE profile_id = ?',
        params: ['p-1000'],
      }),
    ).resolves.toEqual([{ value: 'edited by user' }]);
    await expect(
      db.plugin?.({
        op: 'query',
        owner,
        sql: 'SELECT status, payload FROM {{jobs}} WHERE profile_id = ?',
        params: ['p-1000'],
      }),
    ).resolves.toEqual([{ status: 'queued', payload: expect.any(Uint8Array) }]);
    const job = (await db.plugin?.({
      op: 'query',
      owner,
      sql: 'SELECT status, payload FROM {{jobs}} WHERE profile_id = ?',
      params: ['p-1000'],
    })) as Array<{ status: string; payload: Uint8Array }>;
    expect(Array.from(job[0].payload)).toEqual([0, 255, 7]);
    await db.plugin?.({ op: 'release', owner });
    await db.close();
    db = undefined;

    const reopened = await openDbInWorker(
      file,
      require.resolve('../worker-entry.ts'),
      {
        execArgv: [
          '--no-experimental-strip-types',
          '-r',
          preload,
          '-r',
          'ts-node/register/transpile-only',
          '-r',
          'tsconfig-paths/register',
        ],
        pluginSources: { 'worker.import': sourceFile },
      },
    );
    try {
      await expect(
        reopened.plugin?.({
          op: 'register',
          pluginId: 'worker.import',
          descriptor: DESCRIPTOR,
        }),
      ).resolves.toEqual(expect.objectContaining({ state: 'active' }));
      await expect(
        reopened.plugin?.({
          op: 'prepare',
          pluginId: 'worker.import',
          descriptor: DESCRIPTOR,
        }),
      ).resolves.toEqual(expect.objectContaining({ state: 'active' }));
      await expect(
        reopened.plugin?.({ op: 'open', owner, pluginId: owner.extensionId }),
      ).resolves.toEqual({ opened: true });
      await expect(
        reopened.plugin?.({
          op: 'query',
          owner,
          sql: 'SELECT COUNT(*) AS count FROM {{profiles}}',
        }),
      ).resolves.toEqual([{ count: 1001 }]);
      await reopened.plugin?.({ op: 'release', owner });
    } finally {
      await reopened.close();
    }
  } finally {
    if (db?.isOpen()) await db.close();
    source.close();
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
});

it('resets an imported namespace, preserves the tombstone across worker reopen, and backs up in the worker', async () => {
  const file = path.join(
    os.tmpdir(),
    `plugin-worker-reset-${process.pid}-${Date.now()}.sqlite`,
  );
  const sourceFile = path.join(
    os.tmpdir(),
    `plugin-worker-reset-source-${process.pid}-${Date.now()}`,
    'private.db',
  );
  const backupFile = path.join(
    os.tmpdir(),
    `plugin-worker-reset-backup-${process.pid}-${Date.now()}.sqlite`,
  );
  const preload = path.join(
    os.tmpdir(),
    `plugin-worker-reset-preload-${process.pid}-${Date.now()}.js`,
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
    "CREATE TABLE items (id TEXT PRIMARY KEY); INSERT INTO items VALUES ('legacy')",
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
  const owner = {
    kind: 'plugin' as const,
    extensionId: 'reset.plugin',
    handle: 'reset-owner',
  };
  let db: Awaited<ReturnType<typeof openDbInWorker>> | undefined;
  try {
    db = await openDbInWorker(file, require.resolve('../worker-entry.ts'), {
      execArgv,
    });
    await db.registerPluginSource!(
      'reset.plugin',
      sourceFile,
      WORKER_DESCRIPTOR,
    );
    await db.plugin!({
      op: 'prepare',
      pluginId: 'reset.plugin',
      descriptor: WORKER_DESCRIPTOR,
    });
    await db.plugin!({ op: 'open', pluginId: 'reset.plugin', owner });
    await expect(
      db.plugin!({ op: 'query', owner, sql: 'SELECT * FROM {{items}}' }),
    ).resolves.toEqual([{ id: 'legacy' }]);
    await db.plugin!({ op: 'release', owner });
    await db.plugin!({ op: 'reset', pluginId: 'reset.plugin' });
    await expect(
      db.plugin!({
        op: 'prepare',
        pluginId: 'reset.plugin',
        descriptor: WORKER_DESCRIPTOR,
      }),
    ).resolves.toEqual(expect.objectContaining({ state: 'tombstoned' }));
    await db.plugin!({ op: 'rearm', pluginId: 'reset.plugin' });
    await db.backup!(backupFile);
    const backup = new Database(backupFile, { readonly: true });
    expect(
      (
        backup
          .prepare('SELECT state FROM plugin_storage WHERE plugin_id=?')
          .get('reset.plugin') as { state: string }
      ).state,
    ).toBe('active');
    backup.close();
    await db.close();
    db = undefined;

    const reopened = await openDbInWorker(
      file,
      require.resolve('../worker-entry.ts'),
      { execArgv },
    );
    try {
      await reopened.registerPluginSource!(
        'reset.plugin',
        sourceFile,
        WORKER_DESCRIPTOR,
      );
      await expect(
        reopened.plugin!({
          op: 'prepare',
          pluginId: 'reset.plugin',
          descriptor: WORKER_DESCRIPTOR,
        }),
      ).resolves.toEqual(expect.objectContaining({ state: 'active' }));
      await reopened.plugin!({ op: 'open', pluginId: 'reset.plugin', owner });
      await expect(
        reopened.plugin!({
          op: 'query',
          owner,
          sql: 'SELECT * FROM {{items}}',
        }),
      ).resolves.toEqual([]);
    } finally {
      await reopened.close();
    }
  } finally {
    if (db?.isOpen()) await db.close();
    for (const p of [
      file,
      `${file}-wal`,
      `${file}-shm`,
      sourceFile,
      `${sourceFile}-wal`,
      `${sourceFile}-shm`,
      backupFile,
      `${backupFile}-wal`,
      `${backupFile}-shm`,
      preload,
      path.dirname(sourceFile),
    ])
      if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
  }
});

it('coalesces concurrent production-worker prepare requests behind a held transaction', async () => {
  const file = path.join(
    os.tmpdir(),
    `plugin-worker-prepare-race-${process.pid}-${Date.now()}.sqlite`,
  );
  const preload = path.join(
    os.tmpdir(),
    `plugin-worker-prepare-race-preload-${process.pid}-${Date.now()}.js`,
  );
  const blockerSource = path.join(
    os.tmpdir(),
    `plugin-worker-prepare-race-blocker-${process.pid}-${Date.now()}`,
    'private.db',
  );
  const targetSource = path.join(
    os.tmpdir(),
    `plugin-worker-prepare-race-target-${process.pid}-${Date.now()}`,
    'private.db',
  );
  const rootBetter = path.join(
    path.resolve(__dirname, '..', '..', '..', '..'),
    'node_modules',
    'better-sqlite3',
  );
  fs.writeFileSync(
    preload,
    `const M=require('module');const o=M._resolveFilename;M._resolveFilename=function(r,...a){return r==='better-sqlite3'?o.call(this,${JSON.stringify(rootBetter)},...a):o.apply(this,[r,...a])}`,
  );
  let db: Awaited<ReturnType<typeof openDbInWorker>> | undefined;
  try {
    db = await openDbInWorker(file, require.resolve('../worker-entry.ts'), {
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
        'worker.prepare-blocker': blockerSource,
        'worker.prepare-target': targetSource,
      },
    });
    await db.plugin?.({
      op: 'register',
      pluginId: 'worker.prepare-blocker',
      descriptor: WORKER_DESCRIPTOR,
    });
    await db.plugin?.({
      op: 'register',
      pluginId: 'worker.prepare-target',
      descriptor: WORKER_DESCRIPTOR,
    });
    await db.plugin?.({
      op: 'prepare',
      pluginId: 'worker.prepare-blocker',
      descriptor: WORKER_DESCRIPTOR,
    });
    const blockerOwner = {
      kind: 'plugin' as const,
      extensionId: 'worker.prepare-blocker',
      handle: 'prepare-blocker-owner',
    };
    await db.plugin?.({
      op: 'open',
      owner: blockerOwner,
      pluginId: blockerOwner.extensionId,
    });
    const token = (await db.plugin?.({
      op: 'begin',
      owner: blockerOwner,
    })) as string;

    const first = db.plugin?.({
      op: 'prepare',
      pluginId: 'worker.prepare-target',
      descriptor: WORKER_DESCRIPTOR,
    });
    const second = db.plugin?.({
      op: 'prepare',
      pluginId: 'worker.prepare-target',
      descriptor: WORKER_DESCRIPTOR,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await db.plugin?.({ op: 'commit', owner: blockerOwner, token });
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ state: 'active' }),
      expect.objectContaining({ state: 'active' }),
    ]);
  } finally {
    if (db?.isOpen()) await db.close();
    for (const p of [
      file,
      `${file}-wal`,
      `${file}-shm`,
      preload,
      path.dirname(blockerSource),
      path.dirname(targetSource),
    ])
      if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
  }
});

it('cancels a queued plugin transport request through the bridge fixture (transport only)', async () => {
  const file = path.join(
    os.tmpdir(),
    `plugin-worker-cancel-${process.pid}-${Date.now()}.sqlite`,
  );
  const preload = path.join(
    os.tmpdir(),
    `plugin-worker-cancel-preload-${process.pid}-${Date.now()}.js`,
  );
  const rootBetter = path.join(
    path.resolve(__dirname, '..', '..', '..', '..'),
    'node_modules',
    'better-sqlite3',
  );
  fs.writeFileSync(
    preload,
    `const M=require('module');const o=M._resolveFilename;M._resolveFilename=function(r,...a){return r==='better-sqlite3'?o.call(this,${JSON.stringify(rootBetter)},...a):o.apply(this,[r,...a])}`,
  );
  const db = await openDbInWorker(
    file,
    require.resolve('./fixtures/plugin-worker-entry.ts'),
    {
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
  );
  await db.exec('CREATE TABLE "p_70__items"(v INTEGER)');
  const owner = {
    kind: 'plugin' as const,
    extensionId: 'p',
    handle: 'worker-one',
  };
  const other = {
    kind: 'plugin' as const,
    extensionId: 'p',
    handle: 'worker-two',
  };
  await db.plugin?.({ op: 'open', owner, pluginId: 'p', tables: ['items'] });
  await db.plugin?.({
    op: 'open',
    owner: other,
    pluginId: 'p',
    tables: ['items'],
  });
  const token = (await db.plugin?.({ op: 'begin', owner })) as string;
  const preAbort = new AbortController();
  preAbort.abort();
  await expect(
    db.plugin?.(
      {
        op: 'exec',
        owner,
        token,
        sql: 'INSERT INTO {{items}} VALUES (?)',
        params: [8],
      },
      { signal: preAbort.signal },
    ),
  ).rejects.toMatchObject({ code: 'DB_OPERATION_CANCELLED' });
  const abort = new AbortController();
  const queued = db.plugin?.(
    {
      op: 'exec',
      owner: other,
      sql: 'INSERT INTO {{items}} VALUES (?)',
      params: [9],
    },
    { signal: abort.signal },
  );
  abort.abort();
  await expect(queued).rejects.toMatchObject({
    code: 'DB_OPERATION_CANCELLED',
  });
  await db.plugin?.({ op: 'commit', owner, token });
  await expect(
    db.all('SELECT COUNT(*) AS c FROM "p_70__items"'),
  ).resolves.toEqual([{ c: 0 }]);
  await db.plugin?.({ op: 'release', owner });
  await db.plugin?.({ op: 'release', owner: other });
  await db.close();
  for (const p of [file, `${file}-wal`, `${file}-shm`, preload])
    if (fs.existsSync(p)) fs.rmSync(p);
});
