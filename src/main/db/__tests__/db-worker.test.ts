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

  // The reconcile procedure set is the one place a piece of app state lives
  // ACROSS separate RPCs: the listing is staged into a TEMP table by one
  // proc call and read by another. TEMP tables are connection-scoped, so
  // that only works because every proc runs on the worker's single
  // connection — an assumption no in-process test can check, since there the
  // whole thing collapses onto one handle. This drives the real sequence over
  // the real bridge.
  //
  // It is also the shape that took the app down twice: on a 3.7M-document
  // account the old pass returned the live refs (2.16 GB clone → dead worker)
  // and then built the deletion set on the main heap (~3.2 GiB → dead main
  // process). Nothing here may come back but counts.
  it('runs the reconcile procedures inside the worker, staging across calls (proc round-trip)', async () => {
    await spawnAndReady();

    await client!.proc!('commit', {
      consumer: 'worker:test:reconcile',
      cursor: 0,
      documents: ['keep-1', 'keep-2', 'gone-1'].map((externalId) => ({
        externalId,
        type: 'note',
        title: externalId,
        markdown: `document ${externalId}`,
        metadata: {},
        createdAt: '2026-01-01T00:00:00Z',
      })),
    });

    const [{ id: accountId }] = (await client!.all(
      `SELECT id FROM accounts`,
    )) as Array<{ id: string }>;
    const [{ s: startSeq }] = (await client!.all(
      `SELECT MAX(seq) AS s FROM changes`,
    )) as Array<{ s: number }>;

    await client!.proc!('reconcileBegin', { accountId });
    // TWO staging calls: separate messages, separate proc invocations. If the
    // TEMP table did not survive between them, the second would find an empty
    // table and the diff would report both keeps as deletions.
    await client!.proc!('reconcileStage', {
      accountId,
      refs: [{ externalId: 'keep-1', type: 'note' }],
    });
    await client!.proc!('reconcileStage', {
      accountId,
      refs: [{ externalId: 'keep-2', type: 'note' }],
    });

    expect(
      await client!.proc!('reconcileDiff', { accountId, startSeq }),
    ).toEqual({ listedCount: 2, liveCount: 3, deletionCount: 1 });

    expect(
      await client!.proc!('reconcileArchive', { accountId, startSeq }),
    ).toBe(1);

    const rows = (await client!.all(
      `SELECT external_id, archived_at FROM documents ORDER BY external_id`,
    )) as Array<{ external_id: string; archived_at: string | null }>;
    expect(rows.map((r) => [r.external_id, r.archived_at !== null])).toEqual([
      ['gone-1', true],
      ['keep-1', false],
      ['keep-2', false],
    ]);

    // The archive ends the pass: a second diff sees an empty listing, so
    // every live doc now reads as unlisted. Proves the staging was cleared
    // rather than left behind to poison the next account's pass.
    expect(
      await client!.proc!('reconcileDiff', { accountId, startSeq }),
    ).toEqual({ listedCount: 0, liveCount: 2, deletionCount: 2 });

    await client!.close();
  }, 20000);

  // applyFolderScope is the only write the folder-scope flows make, and it is
  // dispatched through `proc` exactly like `commit` (store.ts takes the
  // `db.proc!(…)` branch whenever there is no raw `_conn` — i.e. always, in
  // the production main process). Registration in worker-entry.ts is the part
  // no in-process test can see, and so is the structured-clone round trip of
  // `archiveScopeRootIds`.
  it('runs applyFolderScope inside the worker (proc round-trip)', async () => {
    await spawnAndReady();

    await client!.proc!('commit', {
      consumer: 'worker:test:folder-scope',
      cursor: 0,
      documents: [
        {
          externalId: 'keep',
          scopeRootId: 'root',
          type: 'file',
          title: 'keep',
          markdown: 'document keep',
          metadata: {},
          createdAt: '2026-01-01T00:00:00Z',
        },
        {
          externalId: 'gone',
          scopeRootId: 'X',
          type: 'file',
          title: 'gone',
          markdown: 'document gone',
          metadata: {},
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    });

    // The `consumer` commit variant self-creates a synthetic account whose
    // source is 'worker' and whose config is the literal '{}' — which is
    // exactly what the stale guard is handed here, so this also pins that the
    // guard tolerates a caller passing the raw config column straight through.
    // (A worker emission never warns under R5 for a structural reason, not a
    // config one: the `consumer` branch of commitTx returns before the account
    // branch that carries the warn.)
    const [{ id: accountId, config }] = (await client!.all(
      `SELECT id, config FROM accounts`,
    )) as Array<{ id: string; config: string }>;
    expect(config).toBe('{}');

    const nextConfig = { folderRoots: [{ id: 'root', name: 'My Drive' }] };
    expect(
      await client!.proc!('applyFolderScope', {
        accountId,
        config: nextConfig,
        cursor: {
          page_token: 'p1',
          backfill_done: false,
          scope_roots: ['root'],
        },
        archiveScopeRootIds: ['X'],
        expectedConfigJson: config,
      }),
    ).toEqual({ archived: 1, remaining: 1, stale: false });

    const rows = (await client!.all(
      `SELECT external_id, archived_at, scope_root_id FROM documents ORDER BY external_id`,
    )) as Array<{
      external_id: string;
      archived_at: string | null;
      scope_root_id: string | null;
    }>;
    expect(rows).toEqual([
      {
        external_id: 'gone',
        archived_at: expect.any(String),
        scope_root_id: 'X',
      },
      { external_id: 'keep', archived_at: null, scope_root_id: 'root' },
    ]);

    // source 'worker' is not folder-scoped, so no legacy mirror is derived —
    // the config lands verbatim. Pins the A-2 source gating from the RPC side.
    const [{ config: written }] = (await client!.all(
      `SELECT config FROM accounts`,
    )) as Array<{ config: string }>;
    expect(written).toBe(JSON.stringify(nextConfig));

    await client!.close();
  }, 20000);

  // C-29 — the commit-before-ack window. bridge.ts's host handler COMMITS the
  // transaction and only THEN posts its reply (`value = await proc(req.args);`
  // … `port.postMessage({ id, ok: true, value })`, bridge.ts:100-127), so a
  // thread that dies in between leaves the write DURABLE while the caller's
  // promise rejects (worker-client.ts:168-183 tags it DB_WORKER_CRASHED) —
  // and `applyScope` can then exit without ever restarting the compensating
  // backfill. Reproduced deterministically WITHOUT killing the thread: post
  // the request RAW with an id nothing is waiting on. `createDbClient` drops
  // replies for unknown ids on the floor (`const p = pending.get(res.id); if
  // (!p) return;`), so from the caller's side this is byte-identical to the
  // reply never arriving. The ordering is safe rather than lucky: the port
  // delivers messages in arrival order, and `proc` runs the whole
  // better-sqlite3 transaction SYNCHRONOUSLY before the handler's first
  // `await` yields, so the follow-up read cannot observe a half-applied
  // state.
  it("a reply lost between applyFolderScope's commit and its postMessage still leaves the write DURABLE (C-29)", async () => {
    await spawnAndReady();

    await client!.proc!('commit', {
      consumer: 'worker:test:folder-scope-lost-reply',
      cursor: 0,
      documents: [
        {
          externalId: 'keep',
          scopeRootId: 'root',
          type: 'file',
          title: 'keep',
          markdown: 'document keep',
          metadata: {},
          createdAt: '2026-01-01T00:00:00Z',
        },
        {
          externalId: 'gone',
          scopeRootId: 'X',
          type: 'file',
          title: 'gone',
          markdown: 'document gone',
          metadata: {},
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    const [{ id: accountId, config }] = (await client!.all(
      `SELECT id, config FROM accounts`,
    )) as Array<{ id: string; config: string }>;

    const nextConfig = { folderRoots: [{ id: 'root', name: 'My Drive' }] };
    worker!.postMessage({
      // never issued by createDbClient's own counter, which starts at 1
      id: 990_001,
      op: 'proc',
      name: 'applyFolderScope',
      args: {
        accountId,
        config: nextConfig,
        cursor: {
          page_token: 'p1',
          backfill_done: false,
          scope_roots: ['root'],
        },
        archiveScopeRootIds: ['X'],
        expectedConfigJson: config,
      },
    });

    // The caller learned NOTHING, and the write happened anyway.
    const rows = (await client!.all(
      `SELECT external_id, archived_at FROM documents ORDER BY external_id`,
    )) as Array<{ external_id: string; archived_at: string | null }>;
    expect(rows).toEqual([
      { external_id: 'gone', archived_at: expect.any(String) },
      { external_id: 'keep', archived_at: null },
    ]);

    // Durable state is the only discriminator, and this is exactly the read
    // the engine's recovery path must make before deciding which loop to
    // restart — see CoreStore.applyFolderScope's CALLER CONTRACT (Step 8b).
    // Compare the PARSED folderRoots, never the config text.
    const [{ config: written }] = (await client!.all(
      `SELECT config FROM accounts`,
    )) as Array<{ config: string }>;
    expect(
      (JSON.parse(written) as { folderRoots: unknown }).folderRoots,
    ).toEqual(nextConfig.folderRoots);

    await client!.close();
  }, 20000);

  // maintenance.compact() dispatches to this proc (worker-backed AppDb has no
  // raw connection to call repopulateSearchIndex directly on — see
  // store.ts#maintenance.compact). Drive it through the REAL bridge against a
  // real migrated corpus file with a document already committed, having
  // first blanked both search tables — so the assertion only passes if the
  // rebuild actually did the repopulating work, not because the prior commit
  // already left rows behind.
  it('runs the rebuildSearchIndex procedure inside the worker (proc round-trip)', async () => {
    await spawnAndReady();

    await client!.proc!('commit', {
      consumer: 'worker:test:rebuild',
      cursor: 0,
      documents: [
        {
          externalId: 'r-1',
          type: 'note',
          title: 'Rebuild Doc',
          markdown: 'a document that must survive a search index rebuild',
          metadata: {},
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    });

    await client!.exec(`DELETE FROM documents_fts; DELETE FROM documents_tri;`);
    const blanked = await client!.all(
      `SELECT (SELECT COUNT(*) FROM documents_fts) AS fts,
              (SELECT COUNT(*) FROM documents_tri) AS tri`,
    );
    expect(Number(blanked[0].fts)).toBe(0);
    expect(Number(blanked[0].tri)).toBe(0);

    const result = await client!.proc!('rebuildSearchIndex', null);
    expect(result).toBeNull();

    const repopulated = await client!.all(
      `SELECT (SELECT COUNT(*) FROM documents_fts) AS fts,
              (SELECT COUNT(*) FROM documents_tri) AS tri`,
    );
    expect(Number(repopulated[0].fts)).toBeGreaterThan(0);
    expect(Number(repopulated[0].tri)).toBeGreaterThan(0);

    const fts = await client!.all(
      `SELECT doc_id FROM documents_fts WHERE documents_fts MATCH ?`,
      ['rebuild'],
    );
    expect(fts.length).toBeGreaterThan(0);

    await client!.close();
  }, 20000);
});
