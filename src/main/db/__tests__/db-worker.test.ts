/**
 * @jest-environment node
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { createDbClient, type DbClient } from '@main/db/bridge';

// The bridge protocol itself is fully covered over a real MessageChannel in
// db-bridge.test.ts — this suite's only job is to prove the actual worker
// thread (webpack entry `dbWorker`, source at ../worker-entry.ts) really
// spawns, opens+migrates the DB, and serves a batch over the real bridge.
//
// The production worker is a webpack bundle (plain JS, no loader concerns);
// here we run the TS source directly under ts-node so no build step is
// required. `openDbInWorker` (../worker-client.ts) itself takes no execArgv
// — by design, since the bundled worker never needs one — so it can't spawn
// a .ts file. This suite therefore spawns the Worker directly (mirroring
// openDbInWorker's ready/error wiring) and drives it with the same
// `createDbClient` the production client uses, giving a real, unmodified
// exercise of worker-entry.ts + bridge.ts end to end.
//
// Two dev-environment-only loader quirks need working around, both scoped to
// this one spawn via `execArgv` (nothing here touches repo files):
//  1. Node's own native type-stripping (unflagged since v23) intercepts a
//     .ts Worker entry before ts-node's require hook runs, and — because the
//     file has import/export syntax — auto-detects it as ESM, which then
//     rejects our extension-less relative imports. `--no-experimental-strip-types`
//     forces ts-node (registered right after) to transpile to CJS instead.
//  2. This repo's `src/node_modules` is an ERB/electron-react-boilerplate
//     junction to `release/app/node_modules` (so webpack/electron-rebuild see
//     native deps built for Electron's ABI). Any file under `src/` — like
//     `app-db.ts` — resolves the bare `better-sqlite3` specifier through
//     that junction before ever reaching the repo's real root
//     `node_modules/better-sqlite3` (rebuilt for plain Node, which is what
//     `npm test` runs under) — the same mismatch jest works around with its
//     own `better-sqlite3` `moduleNameMapper` entry. A tiny `-r` preload
//     applies that identical redirect for this one spawned thread.
describe('DB worker thread (real spawn)', () => {
  let dbPath: string;
  let preloadPath: string;
  let worker: Worker | undefined;
  let client: DbClient | undefined;

  beforeEach(() => {
    const tmp = os.tmpdir();
    const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(tmp, `kiagent-db-worker-test-${unique}.sqlite3`);

    const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
    const rootBetterSqlite3 = path
      .join(repoRoot, 'node_modules', 'better-sqlite3')
      .replace(/\\/g, '\\\\');
    preloadPath = path.join(tmp, `kiagent-db-worker-preload-${unique}.js`);
    fs.writeFileSync(
      preloadPath,
      `const Module = require('module');
const target = ${JSON.stringify(rootBetterSqlite3)};
const orig = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'better-sqlite3') {
    return orig.call(this, target, ...rest);
  }
  return orig.apply(this, [request, ...rest]);
};
`,
    );
  });

  afterEach(async () => {
    if (client?.isOpen()) {
      try {
        await client.close();
      } catch {
        // worker may already be dead — terminate below regardless
      }
    }
    if (worker) await worker.terminate();
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, preloadPath]) {
      if (fs.existsSync(p)) fs.rmSync(p);
    }
  });

  // Spawn the real worker-entry under ts-node and wait for its `ready`, then
  // wire a production `createDbClient`. Mirrors openDbInWorker's handshake.
  async function spawnAndReady(): Promise<void> {
    worker = new Worker(require.resolve('../worker-entry.ts'), {
      workerData: { dbPath },
      execArgv: [
        '--no-experimental-strip-types',
        '-r',
        preloadPath,
        '-r',
        'ts-node/register/transpile-only',
        '-r',
        'tsconfig-paths/register',
      ],
    });
    await new Promise<void>((resolve, reject) => {
      const onMessage = (m: unknown) => {
        const msg = m as { t?: string; message?: string };
        if (msg?.t === 'ready') {
          cleanup();
          resolve();
        } else if (msg?.t === 'open-error') {
          cleanup();
          reject(new Error(`db worker failed to open: ${msg.message}`));
        }
      };
      const onError = (e: Error) => {
        cleanup();
        reject(e);
      };
      const onExit = (code: number) => {
        cleanup();
        reject(new Error(`db worker exited before ready (code ${code})`));
      };
      function cleanup() {
        worker!.off('message', onMessage);
        worker!.off('error', onError);
        worker!.off('exit', onExit);
      }
      worker!.on('message', onMessage);
      worker!.on('error', onError);
      worker!.on('exit', onExit);
    });
    client = createDbClient(worker);
  }

  it('spawns, opens+migrates the DB, serves a batch, and closes cleanly', async () => {
    await spawnAndReady();
    expect(client!.isOpen()).toBe(true);

    const results = await client!.batch([
      { sql: 'CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)' },
      { sql: 'INSERT INTO t(v) VALUES (?) RETURNING id', params: ['x'] },
    ]);
    expect(results).toHaveLength(2);
    expect(typeof results[1].row?.id).toBe('number');
    expect(results[1].row?.id).toBe(1);

    const exited = new Promise<number>((resolve) => {
      worker!.once('exit', resolve);
    });
    await client!.close();
    expect(client!.isOpen()).toBe(false);
    expect(await exited).toBe(0);
  }, 20000);

  // The corpus `commit` transaction is relocated into the worker and invoked
  // via the `proc` op. No in-process test exercises that RPC path — this drives
  // a real commit THROUGH the worker: the `consumer` batch variant self-creates
  // its synthetic account, so getOrCreateAccountTx + upsertDocument + ftsUpsert
  // + appendChange + detectLanguages (franc-min) all run inside the worker, and
  // the CommitBatch crosses the structured-clone boundary intact.
  it('runs the relocated commit procedure inside the worker (proc round-trip)', async () => {
    await spawnAndReady();

    const seq = await client!.proc!('commit', {
      consumer: 'worker:test:v1',
      cursor: 0,
      documents: [
        {
          externalId: 'w-1',
          type: 'note',
          title: 'Worker Doc',
          markdown: 'a document committed through the worker thread',
          metadata: {},
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    expect(typeof seq).toBe('number');
    expect(seq as number).toBeGreaterThan(0);

    const docs = await client!.all(
      `SELECT external_id, title, languages FROM documents`,
    );
    expect(docs).toHaveLength(1);
    expect(docs[0].external_id).toBe('w-1');
    expect(docs[0].title).toBe('Worker Doc');
    // languages is a JSON array produced by detectLanguages RUNNING IN THE
    // WORKER — it must be valid JSON (proves franc-min loaded + ran there).
    expect(Array.isArray(JSON.parse(docs[0].languages as string))).toBe(true);

    // FTS search (also written inside the worker commit) finds the doc.
    const fts = await client!.all(
      `SELECT doc_id FROM documents_fts WHERE documents_fts MATCH ?`,
      ['committed'],
    );
    expect(fts.length).toBeGreaterThan(0);

    await client!.close();
  }, 20000);
});
