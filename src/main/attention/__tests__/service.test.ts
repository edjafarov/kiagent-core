import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AttentionItemWire } from '@shared/attention';
import type { ExtensionSnapshot } from '@shared/contracts';

import { openDb, type AppDb } from '../../db/app-db';
import { openDbInWorker } from '../../db/worker-client';
import { createAttentionService } from '../service';

const producer = 'kiagent.test';

function item(id = `${producer}:one`, revision = 1): AttentionItemWire {
  return {
    id,
    producer,
    kind: 'upcoming',
    title: 'Test item',
    detail: null,
    priority: 1,
    dueAt: null,
    expiresAt: null,
    createdAt: 1,
    updatedAt: 1,
    revision,
    state: 'open',
    resolvedBy: null,
    actions: [],
  };
}

function extension(
  status: ExtensionSnapshot['status'] = 'activated',
): ExtensionSnapshot {
  return {
    id: producer,
    name: 'Test',
    version: '1.0.0',
    origin: 'bundled',
    enabled: true,
    status,
    caps: [],
    sourceIds: [],
    oauthSources: [],
  };
}

describe('createAttentionService', () => {
  let dir: string;
  let db: AppDb;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attention-service-'));
    db = await openDb(path.join(dir, 'test.db'));
  });

  afterEach(async () => {
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('S1a mixed-validity snapshot rejects atomically without dispatching it', async () => {
    const proc = jest.fn().mockResolvedValue({
      ok: true,
      changed: false,
      rowFailures: [],
    });
    const fakeDb = {
      ...db,
      _conn: undefined,
      proc,
    } as unknown as AppDb;
    const service = createAttentionService({
      db: fakeDb,
      onChanged: jest.fn(),
    });

    await expect(
      service.publish(producer, [item(), { nope: true }]),
    ).resolves.toEqual({
      rejected: [{ id: '', reason: expect.any(String) }],
    });
    expect(proc).not.toHaveBeenCalled();
    await service.dispose();
  });

  it('S3b commits a publication and lists only currently available producers', async () => {
    const onChanged = jest.fn();
    const service = createAttentionService({ db, onChanged });
    service.setExtensions([extension()]);

    await expect(service.publish(producer, [item()])).resolves.toEqual({
      rejected: [],
    });
    await expect(service.list()).resolves.toEqual([item()]);
    expect(onChanged).toHaveBeenCalledTimes(2);
    await service.dispose();
  });

  it('S4a rejects mutations after dispose and stops accepting work', async () => {
    const service = createAttentionService({ db, onChanged: jest.fn() });
    await service.dispose();

    await expect(service.publish(producer, [])).rejects.toMatchObject({
      code: 'ATTENTION_DISPOSED',
    });
    await expect(
      service.resolve(producer, `${producer}:one`),
    ).rejects.toMatchObject({
      code: 'ATTENTION_DISPOSED',
    });
    await expect(service.list()).resolves.toEqual([]);
  });

  it('S1c unclassified dispatched bridge rejection becomes one outcome-unknown hint', async () => {
    const proc = jest.fn().mockRejectedValue(new Error('bridge failed'));
    const fakeDb = { ...db, _conn: undefined, proc } as unknown as AppDb;
    const onChanged = jest.fn();
    const service = createAttentionService({ db: fakeDb, onChanged });

    await expect(service.publish(producer, [item()])).rejects.toMatchObject({
      code: 'ATTENTION_OUTCOME_UNKNOWN',
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
    await service.dispose();
  });

  it('S5a logs row diagnostics without replacing a transaction failure', async () => {
    const proc = jest.fn().mockResolvedValue({
      ok: false,
      error: { message: 'transaction failed' },
      rowFailures: [{ id: 'x', producer, message: 'bad row' }],
    });
    const log = jest.fn(() => {
      throw new Error('logger failed');
    });
    const fakeDb = { ...db, _conn: undefined, proc } as unknown as AppDb;
    const service = createAttentionService({
      db: fakeDb,
      log,
      onChanged: jest.fn(),
    });

    await expect(service.publish(producer, [item()])).rejects.toMatchObject({
      code: 'ATTENTION_TX_FAILED',
      message: 'transaction failed',
    });
    expect(log).toHaveBeenCalledTimes(1);
    await service.dispose();
  });

  it('S2a rejects ok:false with ATTENTION_TX_FAILED and emits no hint', async () => {
    const onChanged = jest.fn();
    const service = createAttentionService({ db, onChanged });
    service.setExtensions([extension()]);
    onChanged.mockClear();
    await db.exec(`
      CREATE TRIGGER attention_test_failure
      AFTER INSERT ON attention_items
      BEGIN SELECT RAISE(ABORT, 'forced failure'); END
    `);

    try {
      await expect(service.publish(producer, [item()])).rejects.toMatchObject({
        code: 'ATTENTION_TX_FAILED',
      });
      expect(onChanged).not.toHaveBeenCalled();
      expect(
        await db.all('SELECT COUNT(*) AS count FROM attention_items'),
      ).toEqual([{ count: 0 }]);
      expect(
        await db.all('SELECT COUNT(*) AS count FROM attention_revisions'),
      ).toEqual([{ count: 0 }]);
    } finally {
      await db.exec('DROP TRIGGER attention_test_failure');
      await service.dispose();
    }
  });

  it('S3a notifies once for each availability-set transition', async () => {
    const onChanged = jest.fn();
    const service = createAttentionService({ db, onChanged });
    service.setExtensions([extension('activating')]);
    expect(onChanged).not.toHaveBeenCalled();
    service.setExtensions([extension('activated')]);
    expect(onChanged).toHaveBeenCalledTimes(1);
    service.setExtensions([extension('activated')]);
    expect(onChanged).toHaveBeenCalledTimes(1);
    service.setExtensions([extension('disabled')]);
    expect(onChanged).toHaveBeenCalledTimes(2);
    await service.dispose();
  });

  it('S7/S11 uses the real worker registration and preserves dispatch order', async () => {
    const workerPath = path.join(
      dir,
      `worker-${process.pid}-${Date.now()}.sqlite`,
    );
    const preloadPath = path.join(
      dir,
      `worker-preload-${process.pid}-${Date.now()}.js`,
    );
    const rootBetterSqlite3 = path.join(
      path.resolve(__dirname, '../../../../'),
      'node_modules',
      'better-sqlite3',
    );
    fs.writeFileSync(
      preloadPath,
      `const M=require('module');const o=M._resolveFilename;M._resolveFilename=function(r,...a){return r==='better-sqlite3'?o.call(this,${JSON.stringify(rootBetterSqlite3)},...a):o.apply(this,[r,...a])}`,
    );
    const workerDb = await openDbInWorker(
      workerPath,
      require.resolve('../../db/worker-entry.ts'),
      {
        execArgv: [
          '--no-experimental-strip-types',
          '-r',
          preloadPath,
          '-r',
          'ts-node/register/transpile-only',
          '-r',
          'tsconfig-paths/register',
        ],
      },
    );
    try {
      await expect(
        workerDb.proc!('attention.publish', {
          producer,
          items: [item()],
          availableProducers: [producer],
        }),
      ).resolves.toMatchObject({ ok: true, changed: true });
      await expect(
        workerDb.proc!('attention.list', {
          availableProducers: [producer],
        }),
      ).resolves.toMatchObject({ ok: true, items: [item()] });

      const service = createAttentionService({
        db: workerDb,
        onChanged: jest.fn(),
      });
      service.setExtensions([extension()]);
      const first = service.publish(producer, [item()]);
      const second = service.publish(producer, [
        item(),
        item(`${producer}:two`),
      ]);
      const resolved = service.resolve(producer, `${producer}:one`);
      await Promise.all([first, second, resolved]);
      await expect(service.list()).resolves.toEqual([item(`${producer}:two`)]);
      await service.dispose();
    } finally {
      await workerDb.close();
      for (const file of [
        workerPath,
        `${workerPath}-wal`,
        `${workerPath}-shm`,
        preloadPath,
      ]) {
        if (fs.existsSync(file)) fs.rmSync(file);
      }
    }
  }, 20000);

  it('S1c classifies known asynchronous pre-dispatch failures without hints', async () => {
    const failures = [
      Object.assign(new Error('worker died'), { code: 'DB_WORKER_DEAD' }),
      Object.assign(new Error('coordinator is closed'), {
        code: 'DB_COORDINATOR_CLOSED',
      }),
      new Error('db worker closed'),
    ];

    for (const failure of failures) {
      const proc = jest.fn().mockRejectedValue(failure);
      const onChanged = jest.fn();
      const fakeDb = { ...db, _conn: undefined, proc } as unknown as AppDb;
      const service = createAttentionService({ db: fakeDb, onChanged });

      await expect(service.publish(producer, [item()])).rejects.toMatchObject({
        code: 'ATTENTION_DB_UNAVAILABLE',
      });
      expect(onChanged).not.toHaveBeenCalled();
      await service.dispose();
    }
  });

  it('S2b committed publish survives a throwing sink and setExtensions/notifyReset contain it', async () => {
    const onChanged = jest.fn(() => {
      throw new Error('sink failed');
    });
    const service = createAttentionService({ db, onChanged });

    expect(() => service.setExtensions([extension()])).not.toThrow();
    onChanged.mockClear();
    await expect(service.publish(producer, [item()])).resolves.toEqual({
      rejected: [],
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(
      await db.all('SELECT id FROM attention_items WHERE id = ?', [
        `${producer}:one`,
      ]),
    ).toEqual([{ id: `${producer}:one` }]);
    expect(() => service.notifyReset()).not.toThrow();
    expect(() => service.setExtensions([extension('disabled')])).not.toThrow();
    await service.dispose();
  });

  it('S1b closed DB rejects before dispatch with no hint', async () => {
    const proc = jest.fn();
    const onChanged = jest.fn();
    const fakeDb = {
      ...db,
      _conn: undefined,
      proc,
      isOpen: () => false,
    } as unknown as AppDb;
    const service = createAttentionService({ db: fakeDb, onChanged });

    await expect(service.publish(producer, [item()])).rejects.toMatchObject({
      code: 'ATTENTION_DB_UNAVAILABLE',
    });
    expect(proc).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
    await service.dispose();
  });

  it('S1c an unclassified async rejection remains outcome-unknown with one hint', async () => {
    const proc = jest.fn().mockRejectedValue(new Error('unexpected failure'));
    const onChanged = jest.fn();
    const fakeDb = { ...db, _conn: undefined, proc } as unknown as AppDb;
    const service = createAttentionService({ db: fakeDb, onChanged });

    await expect(service.publish(producer, [item()])).rejects.toMatchObject({
      code: 'ATTENTION_OUTCOME_UNKNOWN',
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
    await service.dispose();
  });

  it('G-list-b a successful list that expires a row hints exactly once, and the follow-up list hints zero times', async () => {
    // Deliberate (design R5: one hint per op with changed === true). A list
    // that expired a row changed consumer-visible state for OTHER consumers;
    // the refresh it triggers changes nothing, so it cannot loop. Only FAILED
    // reads are hint-free.
    let now = 1000;
    const onChanged = jest.fn();
    const service = createAttentionService({
      db,
      onChanged,
      clock: () => now,
    });
    service.setExtensions([extension()]);
    await service.publish(producer, [{ ...item(), expiresAt: 1100 }]);
    onChanged.mockClear();

    now = 1200;
    await expect(service.list()).resolves.toEqual([]);
    expect(onChanged).toHaveBeenCalledTimes(1);
    await expect(service.list()).resolves.toEqual([]);
    expect(onChanged).toHaveBeenCalledTimes(1);
    await service.dispose();
  });

  it('G-list distinguishes a failed read from a failed publication', async () => {
    const failure = Object.assign(new Error('sqlite I/O failure'), {
      code: 'SQLITE_IOERR',
    });
    const proc = jest.fn().mockRejectedValue(failure);
    const fakeDb = { ...db, _conn: undefined, proc } as unknown as AppDb;
    const onChanged = jest.fn();
    const service = createAttentionService({ db: fakeDb, onChanged });

    await expect(service.list()).rejects.toMatchObject({
      code: 'ATTENTION_READ_FAILED',
    });
    expect(onChanged).not.toHaveBeenCalled();

    await expect(service.publish(producer, [item()])).rejects.toMatchObject({
      code: 'ATTENTION_OUTCOME_UNKNOWN',
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
    await service.dispose();
  });

  it('S1c keeps an in-flight DB_WORKER_CRASHED rejection unclassified', async () => {
    let rejectProc!: (error: Error) => void;
    const proc = jest.fn(
      () =>
        new Promise((_, reject) => {
          rejectProc = reject;
        }),
    );
    const fakeDb = { ...db, _conn: undefined, proc } as unknown as AppDb;
    const onChanged = jest.fn();
    const service = createAttentionService({ db: fakeDb, onChanged });

    const publication = service.publish(producer, [item()]);
    rejectProc(
      Object.assign(new Error('worker crashed'), {
        code: 'DB_WORKER_CRASHED',
      }),
    );
    await expect(publication).rejects.toMatchObject({
      code: 'ATTENTION_OUTCOME_UNKNOWN',
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
    await service.dispose();
  });

  it('S3a enabled false and activating are unavailable', async () => {
    const onChanged = jest.fn();
    const service = createAttentionService({ db, onChanged });
    service.setExtensions([
      { ...extension('activated'), enabled: false },
      { ...extension('activating'), id: 'kiagent.other' },
    ]);
    expect(onChanged).toHaveBeenCalledTimes(0);
    await service.dispose();
  });

  it('S3b activating publication stays hidden until activation and identical availability is quiet', async () => {
    const onChanged = jest.fn();
    const service = createAttentionService({ db, onChanged });
    service.setExtensions([extension('activating')]);
    onChanged.mockClear();

    await service.publish(producer, [item()]);
    expect(onChanged).not.toHaveBeenCalled();
    await expect(service.list()).resolves.toEqual([]);

    service.setExtensions([extension('activated')]);
    expect(onChanged).toHaveBeenCalledTimes(1);
    await expect(service.list()).resolves.toEqual([item()]);
    service.setExtensions([extension('activated')]);
    expect(onChanged).toHaveBeenCalledTimes(1);
    await service.dispose();
  });

  it('S3c re-filters a list against response-time availability', async () => {
    let release!: (value: unknown) => void;
    const proc = jest.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const fakeDb = { ...db, _conn: undefined, proc } as unknown as AppDb;
    const service = createAttentionService({
      db: fakeDb,
      onChanged: jest.fn(),
    });
    service.setExtensions([extension()]);
    const listed = service.list();
    service.setExtensions([extension('disabled')]);
    release({ ok: true, changed: false, rowFailures: [], items: [item()] });
    await expect(listed).resolves.toEqual([]);
    await service.dispose();
  });

  it('S4a dispose drains a succeeding and failing admitted operation', async () => {
    let resolveProc!: (value: unknown) => void;
    let rejectProc!: (error: Error) => void;
    const proc = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveProc = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectProc = reject;
          }),
      );
    const fakeDb = { ...db, _conn: undefined, proc } as unknown as AppDb;
    const service = createAttentionService({
      db: fakeDb,
      onChanged: jest.fn(),
    });
    const success = service.publish(producer, [item()]);
    const failure = service.publish(producer, [item(`${producer}:two`)]);
    let settled = false;
    const disposal = service.dispose().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    resolveProc({ ok: true, changed: false, rowFailures: [] });
    rejectProc(new Error('bridge failed'));
    await expect(success).resolves.toEqual({ rejected: [] });
    await expect(failure).rejects.toMatchObject({
      code: 'ATTENTION_OUTCOME_UNKNOWN',
    });
    await expect(disposal).resolves.toBeUndefined();
  });

  it('S4a keeps dispose pending until separately gated operations both settle', async () => {
    let releaseFirst!: (value: unknown) => void;
    let releaseSecond!: (value: unknown) => void;
    const proc = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseSecond = resolve;
          }),
      );
    const fakeDb = { ...db, _conn: undefined, proc } as unknown as AppDb;
    const service = createAttentionService({
      db: fakeDb,
      onChanged: jest.fn(),
    });

    const first = service.publish(producer, [item()]);
    const second = service.publish(producer, [item(`${producer}:two`)]);
    let disposed = false;
    const disposal = service.dispose().then(() => {
      disposed = true;
    });

    releaseFirst({ ok: true, changed: false, rowFailures: [] });
    await expect(first).resolves.toEqual({ rejected: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(disposed).toBe(false);

    releaseSecond({ ok: true, changed: false, rowFailures: [] });
    await expect(second).resolves.toEqual({ rejected: [] });
    await expect(disposal).resolves.toBeUndefined();
    expect(disposed).toBe(true);
  });

  it('S4b dispose clears the interval and prevents timer dispatch', async () => {
    const callback = jest.fn();
    const clearInterval = jest.fn();
    const timers = {
      setInterval: (fn: () => void) => {
        callback.mockImplementation(fn);
        return 'attention-tick';
      },
      clearInterval,
    };
    const proc = jest.fn().mockResolvedValue({
      ok: true,
      changed: false,
      rowFailures: [],
    });
    const fakeDb = { ...db, _conn: undefined, proc } as unknown as AppDb;
    const service = createAttentionService({
      db: fakeDb,
      onChanged: jest.fn(),
      timers,
    });
    await service.dispose();
    expect(clearInterval).toHaveBeenCalledWith('attention-tick');
    callback();
    await Promise.resolve();
    expect(proc).not.toHaveBeenCalled();
  });

  it('S5a logs success diagnostics after settlement and preserves success when the logger throws', async () => {
    const events: string[] = [];
    const proc = jest.fn().mockResolvedValue({
      ok: true,
      changed: false,
      rowFailures: [{ id: 'one', producer, message: 'repair' }],
    });
    const fakeDb = { ...db, _conn: undefined, proc } as unknown as AppDb;
    const service = createAttentionService({
      db: fakeDb,
      log: () => {
        events.push('log');
        throw new Error('logger failed');
      },
      onChanged: () => events.push('changed'),
    });
    await expect(service.publish(producer, [item()])).resolves.toEqual({
      rejected: [],
    });
    expect(events).toEqual(['log']);
    await service.dispose();
  });

  it('S5a logs row-failure content only after the gated operation settles', async () => {
    let release!: (value: unknown) => void;
    const proc = jest.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const log = jest.fn();
    const fakeDb = { ...db, _conn: undefined, proc } as unknown as AppDb;
    const service = createAttentionService({
      db: fakeDb,
      log,
      onChanged: jest.fn(),
    });

    const publication = service.publish(producer, [item()]);
    expect(log).not.toHaveBeenCalled();
    release({
      ok: true,
      changed: false,
      rowFailures: [
        { id: `${producer}:failed-row`, producer, message: 'invalid reason' },
      ],
    });
    await expect(publication).resolves.toEqual({ rejected: [] });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(`${producer}/${producer}:failed-row`),
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining('invalid reason'));
    await service.dispose();
  });

  it('S7 default action policy denies navigation in-process and through the worker service', async () => {
    const navigable = {
      ...item(),
      actions: [
        {
          id: 'open',
          label: 'Open',
          target: { view: 'navigation' },
        },
      ],
    };
    const local = createAttentionService({ db, onChanged: jest.fn() });
    await expect(local.publish(producer, [navigable])).resolves.toMatchObject({
      rejected: [{ id: navigable.id }],
    });
    await local.dispose();

    const workerPath = path.join(dir, 'policy-worker.sqlite');
    const preloadPath = path.join(dir, 'policy-worker-preload.js');
    const rootBetterSqlite3 = path.join(
      path.resolve(__dirname, '../../../../'),
      'node_modules',
      'better-sqlite3',
    );
    fs.writeFileSync(
      preloadPath,
      `const M=require('module');const o=M._resolveFilename;M._resolveFilename=function(r,...a){return r==='better-sqlite3'?o.call(this,${JSON.stringify(rootBetterSqlite3)},...a):o.apply(this,[r,...a])}`,
    );
    const workerDb = await openDbInWorker(
      workerPath,
      require.resolve('../../db/worker-entry.ts'),
      {
        execArgv: [
          '--no-experimental-strip-types',
          '-r',
          preloadPath,
          '-r',
          'ts-node/register/transpile-only',
          '-r',
          'tsconfig-paths/register',
        ],
      },
    );
    const workerService = createAttentionService({
      db: workerDb,
      onChanged: jest.fn(),
    });
    try {
      await expect(
        workerService.publish(producer, [navigable]),
      ).resolves.toMatchObject({ rejected: [{ id: navigable.id }] });
    } finally {
      await workerService.dispose();
      await workerDb.close();
    }
  }, 20000);

  it('S6 uses the worker clock at execution time for queued expiry', async () => {
    const workerPath = path.join(dir, 'expiry-worker.sqlite');
    const preloadPath = path.join(dir, 'expiry-worker-preload.js');
    const rootBetterSqlite3 = path.join(
      path.resolve(__dirname, '../../../../'),
      'node_modules',
      'better-sqlite3',
    );
    fs.writeFileSync(
      preloadPath,
      `const M=require('module');const o=M._resolveFilename;M._resolveFilename=function(r,...a){return r==='better-sqlite3'?o.call(this,${JSON.stringify(rootBetterSqlite3)},...a):o.apply(this,[r,...a])}`,
    );
    const workerDb = await openDbInWorker(
      workerPath,
      require.resolve('../../db/worker-entry.ts'),
      {
        execArgv: [
          '--no-experimental-strip-types',
          '-r',
          preloadPath,
          '-r',
          'ts-node/register/transpile-only',
          '-r',
          'tsconfig-paths/register',
        ],
      },
    );
    const service = createAttentionService({
      db: workerDb,
      onChanged: jest.fn(),
    });
    service.setExtensions([extension()]);
    try {
      const expiring = {
        ...item(`${producer}:expiring`),
        expiresAt: Date.now() + 150,
      };
      await expect(service.publish(producer, [expiring])).resolves.toEqual({
        rejected: [],
      });
      await new Promise((resolve) => setTimeout(resolve, 350));
      await expect(service.list()).resolves.toEqual([]);
    } finally {
      await service.dispose();
      await workerDb.close();
      for (const file of [
        workerPath,
        `${workerPath}-wal`,
        `${workerPath}-shm`,
        preloadPath,
      ]) {
        if (fs.existsSync(file)) fs.rmSync(file);
      }
    }
  }, 20000);

  it('S7 applies the worker policy when proc bypasses service validation', async () => {
    const workerPath = path.join(dir, 'direct-policy-worker.sqlite');
    const preloadPath = path.join(dir, 'direct-policy-worker-preload.js');
    const rootBetterSqlite3 = path.join(
      path.resolve(__dirname, '../../../../'),
      'node_modules',
      'better-sqlite3',
    );
    fs.writeFileSync(
      preloadPath,
      `const M=require('module');const o=M._resolveFilename;M._resolveFilename=function(r,...a){return r==='better-sqlite3'?o.call(this,${JSON.stringify(rootBetterSqlite3)},...a):o.apply(this,[r,...a])}`,
    );
    const workerDb = await openDbInWorker(
      workerPath,
      require.resolve('../../db/worker-entry.ts'),
      {
        execArgv: [
          '--no-experimental-strip-types',
          '-r',
          preloadPath,
          '-r',
          'ts-node/register/transpile-only',
          '-r',
          'tsconfig-paths/register',
        ],
      },
    );
    const navigable = {
      ...item(`${producer}:navigation`),
      actions: [
        {
          id: 'open',
          label: 'Open',
          target: { view: 'navigation' },
        },
      ],
    };
    try {
      await expect(
        workerDb.proc!('attention.publish', {
          producer,
          items: [navigable],
          availableProducers: [producer],
        }),
      ).resolves.toMatchObject({ ok: true });
      await expect(
        workerDb.proc!('attention.list', {
          availableProducers: [producer],
        }),
      ).resolves.toMatchObject({
        items: [],
        rowFailures: expect.arrayContaining([
          expect.objectContaining({ id: navigable.id }),
        ]),
      });
    } finally {
      await workerDb.close();
      for (const file of [
        workerPath,
        `${workerPath}-wal`,
        `${workerPath}-shm`,
        preloadPath,
      ]) {
        if (fs.existsSync(file)) fs.rmSync(file);
      }
    }
  }, 20000);

  it('S8 acknowledged publication survives service recreation over the same DB file', async () => {
    const dbPath = path.join(dir, 'restart.sqlite');
    const firstDb = await openDb(dbPath);
    const first = createAttentionService({
      db: firstDb,
      onChanged: jest.fn(),
    });
    first.setExtensions([extension()]);
    await first.publish(producer, [item()]);
    await first.dispose();
    await firstDb.close();

    const secondDb = await openDb(dbPath);
    const second = createAttentionService({
      db: secondDb,
      onChanged: jest.fn(),
    });
    second.setExtensions([extension()]);
    await expect(second.list()).resolves.toEqual([item()]);
    await second.dispose();
    await secondDb.close();
  });

  it('S11 applies two publishes and a resolve in dispatch order in-process', async () => {
    const service = createAttentionService({ db, onChanged: jest.fn() });
    service.setExtensions([extension()]);
    const first = service.publish(producer, [item()]);
    const second = service.publish(producer, [item(), item(`${producer}:two`)]);
    const resolved = service.resolve(producer, `${producer}:one`);
    await Promise.all([first, second, resolved]);
    await expect(service.list()).resolves.toEqual([item(`${producer}:two`)]);
    await service.dispose();
  });

  it('S11 preserves publish, resolve, publish order when the second revision is higher', async () => {
    const service = createAttentionService({ db, onChanged: jest.fn() });
    service.setExtensions([extension()]);
    const first = service.publish(producer, [item(`${producer}:one`, 1)]);
    const second = service.publish(producer, [
      item(`${producer}:one`, 2),
      item(`${producer}:two`, 2),
    ]);
    const resolved = service.resolve(producer, `${producer}:one`);
    await Promise.all([first, resolved, second]);
    await expect(service.list()).resolves.toEqual([item(`${producer}:two`, 2)]);
    await service.dispose();
  });

  it('S11 preserves the same revision-sensitive order through the real worker', async () => {
    const workerPath = path.join(dir, 'ordering-worker.sqlite');
    const preloadPath = path.join(dir, 'ordering-worker-preload.js');
    const rootBetterSqlite3 = path.join(
      path.resolve(__dirname, '../../../../'),
      'node_modules',
      'better-sqlite3',
    );
    fs.writeFileSync(
      preloadPath,
      `const M=require('module');const o=M._resolveFilename;M._resolveFilename=function(r,...a){return r==='better-sqlite3'?o.call(this,${JSON.stringify(rootBetterSqlite3)},...a):o.apply(this,[r,...a])}`,
    );
    const workerDb = await openDbInWorker(
      workerPath,
      require.resolve('../../db/worker-entry.ts'),
      {
        execArgv: [
          '--no-experimental-strip-types',
          '-r',
          preloadPath,
          '-r',
          'ts-node/register/transpile-only',
          '-r',
          'tsconfig-paths/register',
        ],
      },
    );
    const service = createAttentionService({
      db: workerDb,
      onChanged: jest.fn(),
    });
    service.setExtensions([extension()]);
    try {
      const first = service.publish(producer, [item(`${producer}:one`, 1)]);
      const second = service.publish(producer, [
        item(`${producer}:one`, 2),
        item(`${producer}:two`, 2),
      ]);
      const resolved = service.resolve(producer, `${producer}:one`);
      await Promise.all([first, resolved, second]);
      await expect(service.list()).resolves.toEqual([
        item(`${producer}:two`, 2),
      ]);
    } finally {
      await service.dispose();
      await workerDb.close();
      for (const file of [
        workerPath,
        `${workerPath}-wal`,
        `${workerPath}-shm`,
        preloadPath,
      ]) {
        if (fs.existsSync(file)) fs.rmSync(file);
      }
    }
  }, 20000);
});
