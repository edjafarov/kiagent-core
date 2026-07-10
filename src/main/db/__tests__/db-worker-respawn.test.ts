/**
 * @jest-environment node
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {
  openDbInWorker,
  DB_WORKER_RESTARTING,
  DB_WORKER_DEAD,
} from '@main/db/worker-client';
import type { AppDb } from '@main/db/app-db';

// Exercises the respawn supervisor in worker-client.ts against a REAL worker
// thread (not a mock) — same rationale as db-worker.test.ts: the production
// worker is a webpack bundle, so this drives the TS source directly under
// ts-node via execArgv. `openDbInWorker`'s optional `execArgv` option exists
// specifically so this suite can do that through the real public entry point,
// rather than reimplementing the spawn.
//
// See fixtures/respawn-worker-entry.ts (recoverable: every spawn opens fine
// and exposes a `crash` proc the test calls to kill the thread on demand) and
// fixtures/crash-loop-worker-entry.ts (the first spawn opens fine, every
// respawn after that dies before 'ready' — used for the exhaustion case).
describe('DB worker respawn supervisor (real spawn)', () => {
  let dbPath: string;
  let preloadPath: string;
  let execArgv: string[];
  let db: AppDb | undefined;

  beforeEach(() => {
    const tmp = os.tmpdir();
    const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(tmp, `kiagent-db-respawn-test-${unique}.sqlite3`);

    // Same better-sqlite3 module-resolution workaround as db-worker.test.ts:
    // src/ resolves the bare specifier through the src/node_modules ERB
    // junction (built for Electron's ABI); redirect it to the root
    // node_modules copy (built for plain Node, which `npm test` runs under).
    const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
    const rootBetterSqlite3 = path
      .join(repoRoot, 'node_modules', 'better-sqlite3')
      .replace(/\\/g, '\\\\');
    preloadPath = path.join(tmp, `kiagent-db-respawn-preload-${unique}.js`);
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
    execArgv = [
      '--no-experimental-strip-types',
      '-r',
      preloadPath,
      '-r',
      'ts-node/register/transpile-only',
      '-r',
      'tsconfig-paths/register',
    ];
  });

  afterEach(async () => {
    if (db?.isOpen()) {
      try {
        await db.close();
      } catch {
        // worker may already be dead — nothing more to clean up
      }
    }
    const counterPath = `${dbPath}.spawns`;
    for (const p of [
      dbPath,
      `${dbPath}-wal`,
      `${dbPath}-shm`,
      counterPath,
      preloadPath,
    ]) {
      if (fs.existsSync(p)) fs.rmSync(p);
    }
  });

  /** Poll `fn` until it resolves without throwing, or the timeout elapses.
   *  Used instead of a fixed sleep so the test doesn't race the supervisor's
   *  fire-and-forget respawn (which has no promise a caller can await) —
   *  robust under the CPU contention a full 797-test run puts on timers. */
  async function waitUntil<T>(
    fn: () => Promise<T>,
    timeoutMs = 15_000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown;
    for (;;) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        if (Date.now() > deadline) throw lastErr;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }

  it('rejects the in-flight request on crash, then auto-respawns and serves requests again', async () => {
    db = await openDbInWorker(
      dbPath,
      require.resolve('./fixtures/respawn-worker-entry.ts'),
      { execArgv },
    );
    expect(db.isOpen()).toBe(true);

    // Kill the worker mid-request: the `crash` proc exits before replying,
    // so this specific in-flight call must reject.
    await expect(db.proc!('crash', {})).rejects.toThrow();

    // Once the supervisor finishes respawning, a fresh query succeeds again
    // through the SAME returned AppDb (no new object, no re-open call).
    const rows = await waitUntil(() => db!.all('SELECT 1 AS x'));
    expect(rows).toEqual([{ x: 1 }]);
    expect(db.isOpen()).toBe(true);

    // The re-registered `crash` proc proves the fresh worker is a full
    // worker-entry re-open, not some degraded fallback — invoke it again to
    // show a second crash/respawn cycle also recovers.
    await expect(db.proc!('crash', {})).rejects.toThrow();
    const rows2 = await waitUntil(() => db!.all('SELECT 2 AS x'));
    expect(rows2).toEqual([{ x: 2 }]);
  }, 30000);

  it('does not respawn after an intentional close()', async () => {
    db = await openDbInWorker(
      dbPath,
      require.resolve('./fixtures/respawn-worker-entry.ts'),
      { execArgv },
    );
    expect(db.isOpen()).toBe(true);

    await db.close();
    expect(db.isOpen()).toBe(false);

    // Give any errant respawn a chance to happen, then confirm it stayed
    // closed rather than silently coming back to life.
    await new Promise((r) => setTimeout(r, 500));
    expect(db.isOpen()).toBe(false);
    await expect(db.all('SELECT 1')).rejects.toThrow();
  }, 15000);

  it('gives up permanently once the restart budget is exhausted', async () => {
    db = await openDbInWorker(
      dbPath,
      require.resolve('./fixtures/crash-loop-worker-entry.ts'),
      { execArgv },
    );
    expect(db.isOpen()).toBe(true);

    // Crash once — every subsequent respawn attempt from this fixture dies
    // before 'ready', so the supervisor burns through its restart budget and
    // gives up.
    await expect(db.proc!('crash', {})).rejects.toThrow();

    const err = await waitUntil(async () => {
      try {
        await db!.all('SELECT 1');
        throw new Error('expected all() to keep rejecting');
      } catch (e) {
        if ((e as { code?: string }).code === DB_WORKER_RESTARTING) {
          throw e; // still mid-respawn — keep polling
        }
        return e as Error & { code?: string };
      }
    });
    expect(err.code).toBe(DB_WORKER_DEAD);
    expect(db.isOpen()).toBe(false);

    // Permanently dead now — stays that way, no further recovery.
    await expect(db.all('SELECT 1')).rejects.toMatchObject({
      code: DB_WORKER_DEAD,
    });
  }, 30000);
});
