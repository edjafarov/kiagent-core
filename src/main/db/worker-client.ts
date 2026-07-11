import { Worker } from 'node:worker_threads';
import type { AppDb } from './app-db';
import { createDbClient, type DbClient } from './bridge';

/** Bounded crash-loop protection: give up after this many respawns inside a
 *  rolling window rather than retrying forever against, say, a corrupt DB
 *  file. Each *attempt* (including a respawn whose handshake itself fails
 *  before reaching 'ready') consumes one slot. */
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60_000;
/** Small delay between attempts so a rapid crash-loop doesn't hot-spin. */
const RESTART_BACKOFF_MS = 250;

/** Caller can retry — the worker is being respawned after a crash. Since
 *  guard() now PARKS new requests during a respawn instead of rejecting them,
 *  this code no longer reaches callers; it is kept for compatibility and
 *  classified as transient below. */
export const DB_WORKER_RESTARTING = 'DB_WORKER_RESTARTING';
/** Caller can retry — this request was in flight when the worker crashed.
 *  SQLite transactions are atomic, so nothing was half-committed; a retry
 *  after the respawn window re-runs it cleanly. */
export const DB_WORKER_CRASHED = 'DB_WORKER_CRASHED';
/** Terminal — crash-loop protection gave up; this AppDb is dead forever. */
export const DB_WORKER_DEAD = 'DB_WORKER_DEAD';

/** True for store errors an infinite consumer (feed tail, projection, pull
 *  loop) should treat as "the DB worker hiccuped — back off and resume from
 *  the durable cursor" rather than as a reason to die. DB_WORKER_DEAD is
 *  deliberately NOT transient. */
export function isDbWorkerTransientError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === DB_WORKER_CRASHED || code === DB_WORKER_RESTARTING;
}

function taggedError(message: string, code: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface OpenDbInWorkerOptions {
  /** Extra execArgv passed to every `Worker` spawn (initial + respawns). The
   *  production bundle needs none — this exists so tests can run the TS
   *  worker entry (or a test fixture) under ts-node, mirroring the spawn in
   *  db-worker.test.ts. */
  execArgv?: string[];
}

/** Spawn `workerFile` and wait for its ready/open-error handshake. Used both
 *  for the initial open and every respawn attempt, so a fixture crashing
 *  before 'ready' is treated identically to a bundled worker failing to open
 *  the DB file. */
function spawnWorker(
  dbPath: string,
  workerFile: string,
  opts: OpenDbInWorkerOptions,
): { worker: Worker; ready: Promise<void> } {
  const worker = new Worker(workerFile, {
    workerData: { dbPath },
    execArgv: opts.execArgv,
  });

  const ready = new Promise<void>((resolve, reject) => {
    const onMessage = (m: unknown) => {
      const msg = m as { t?: string; message?: string };
      if (msg?.t === 'ready') {
        cleanup();
        resolve();
      } else if (msg?.t === 'open-error') {
        cleanup();
        reject(new Error(`db worker failed to open: ${msg.message}`));
        void worker.terminate();
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
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
    }
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
  });

  return { worker, ready };
}

/**
 * Open the corpus database inside a worker thread and return an AppDb whose
 * calls are RPCs to it. Every better-sqlite3 operation is synchronous; hosting
 * the connection off-thread is what keeps multi-ms statements (checkpoint,
 * VACUUM, cold queries, giant transactions) from freezing the UI event loop.
 *
 * `workerFile` is the bundled worker entry emitted next to the main bundle
 * (webpack entry `dbWorker`); migrations run inside the worker before `ready`.
 *
 * A worker that dies unexpectedly (crash, `error`, or a `messageerror` that
 * can't be mapped back to a pending request) is respawned in place: every
 * in-flight request is rejected (SQLite transactions are atomic, so a killed
 * worker can never have half-committed one), a fresh worker re-opens the same
 * `dbPath` and re-registers its host procedures (worker-entry builds those at
 * startup, so nothing on the main side needs replaying), and requests resume
 * being served through the SAME returned AppDb — callers never see a new
 * object. In-flight requests reject with a `DB_WORKER_CRASHED`-coded error so
 * callers can tell a retryable crash from a SQL error; requests that arrive
 * while the respawn is in flight are PARKED until it settles (then served by
 * the fresh worker, or rejected with `DB_WORKER_DEAD` if the supervisor gave
 * up) — so the respawn window is invisible to well-behaved callers instead of
 * a burst of rejections. A deliberate `close()` never respawns.
 * Repeated crashes (more than `MAX_RESTARTS` within `RESTART_WINDOW_MS`) give
 * up: the AppDb becomes permanently dead (`DB_WORKER_DEAD`), exactly like the
 * old unconditional `_markDead` behavior, and the failure is logged loudly.
 */
export async function openDbInWorker(
  dbPath: string,
  workerFile: string,
  opts: OpenDbInWorkerOptions = {},
): Promise<AppDb> {
  const first = spawnWorker(dbPath, workerFile, opts);
  await first.ready;

  let { worker } = first;
  let client: DbClient = createDbClient(worker);
  let intentionalClose = false;
  let permanentlyDead: (Error & { code: string }) | null = null;
  let respawning = false;
  /** Timestamps (ms) of restart attempts still inside the rolling window. */
  const restarts: number[] = [];

  function attachDeathHandlers(w: Worker): void {
    let handled = false;
    const onDeath = (err: Error) => {
      if (handled) return;
      handled = true;
      // messageerror/error leave the worker alive (only `exit` guarantees
      // termination) — kill it explicitly so a respawn never leaves two
      // workers contending over the same WAL file.
      void w.terminate().catch(() => {});
      handleDeath(err);
    };
    w.on('error', (e) => onDeath(new Error(`db worker error: ${e.message}`)));
    w.on('messageerror', (e) =>
      onDeath(new Error(`db worker message error: ${String(e)}`)),
    );
    w.on('exit', (code) => {
      // Even the clean exit(0) of an intentional close() marks the client
      // dead (matching the pre-supervisor behavior): `request()` only
      // short-circuits on `dead`, so skipping _markDead here would let a
      // request racing the shutdown post into a terminated worker and hang
      // forever. handleDeath still never respawns once intentionalClose is
      // set — dead-without-respawn IS the correct closed terminal state.
      onDeath(new Error(`db worker exited (code ${code})`));
    });
  }

  function handleDeath(err: Error): void {
    // Always mark the dying client dead — even on an intentional close, this
    // is what makes any request racing the shutdown reject promptly instead
    // of hanging forever waiting on a worker that will never reply (the
    // bridge only short-circuits pending/future requests once `dead` is set;
    // `closed` alone does not stop `request()` from posting into the void).
    // A crash death is tagged DB_WORKER_CRASHED so in-flight callers can
    // classify it as retryable; a deliberate close stays untagged (retrying
    // into a closed AppDb is never useful).
    const isCrash = !intentionalClose && !permanentlyDead;
    client._markDead(
      isCrash ? taggedError(err.message, DB_WORKER_CRASHED) : err,
    );
    if (!isCrash) return; // no respawn
    void respawn();
  }

  async function respawn(): Promise<void> {
    if (respawning || permanentlyDead || intentionalClose) return;
    respawning = true;
    let settle!: () => void;
    respawnSettled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    try {
      for (;;) {
        const now = Date.now();
        while (restarts.length && now - restarts[0] > RESTART_WINDOW_MS) {
          restarts.shift();
        }
        if (restarts.length >= MAX_RESTARTS) {
          permanentlyDead = taggedError(
            `db worker crash-looped (${MAX_RESTARTS} restarts within ${RESTART_WINDOW_MS}ms) — giving up, corpus DB is permanently unavailable`,
            DB_WORKER_DEAD,
          );
          // eslint-disable-next-line no-console
          console.error('[db worker]', permanentlyDead.message);
          return;
        }
        restarts.push(now);

        if (RESTART_BACKOFF_MS > 0) await sleep(RESTART_BACKOFF_MS);
        if (intentionalClose) return; // close() arrived while backing off

        try {
          const attempt = spawnWorker(dbPath, workerFile, opts);
          await attempt.ready;
          if (intentionalClose) {
            // close() arrived while the respawn was in flight — discard it.
            // AWAIT the terminate (not fire-and-forget) so close()'s
            // `await respawnSettled` guarantees this fresh worker — which has
            // already opened the DB and run migrations — has released its
            // SQLite/WAL handles before close() resolves. Otherwise a caller
            // that deletes the data dir right after close() (e.g. a test
            // afterEach) can race a live WAL handle (EBUSY/EPERM on Windows).
            await attempt.worker.terminate().catch(() => {});
            return;
          }
          worker = attempt.worker;
          client = createDbClient(worker);
          attachDeathHandlers(worker);
          return; // respawn succeeded — back in service
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error(
            '[db worker] respawn attempt failed, retrying',
            e instanceof Error ? e.message : e,
          );
          // loop: another attempt, still bounded by the rolling window above
        }
      }
    } finally {
      respawning = false;
      settle();
    }
  }

  attachDeathHandlers(worker);

  /** Resolves when no respawn is in flight. Reassigned at every respawn()
   *  entry (synchronously — handleDeath → respawn() runs in one turn, so a
   *  caller can never observe the death without also seeing the pending
   *  promise) and resolved in its finally, win or lose. */
  let respawnSettled: Promise<void> = Promise.resolve();

  function guard<T>(fn: (c: DbClient) => Promise<T>): Promise<T> {
    if (permanentlyDead) return Promise.reject(permanentlyDead);
    // A close() that landed inside a crash-respawn window leaves the old
    // client marked dead with a transient DB_WORKER_CRASHED code (the respawn
    // abandons without ever re-marking it). Reject deliberately-closed
    // requests with a NON-transient error instead, so a retry-aware consumer
    // stops rather than spinning FEED_RETRY_MAX times against a closed AppDb.
    if (intentionalClose) return Promise.reject(new Error('db worker closed'));
    if (!respawning) return fn(client);
    // Park until the respawn settles: served by the fresh worker on success,
    // rejected DB_WORKER_DEAD if the crash-loop breaker gave up.
    return respawnSettled.then(() => {
      if (permanentlyDead) throw permanentlyDead;
      if (intentionalClose) throw new Error('db worker closed');
      return fn(client);
    });
  }

  return {
    exec: (sql) => guard((c) => c.exec(sql)),
    all: (sql, params) => guard((c) => c.all(sql, params)),
    run: (sql, params) => guard((c) => c.run(sql, params)),
    batch: (steps) => guard((c) => c.batch(steps)),
    proc: (name, args) => guard((c) => c.proc!(name, args)),
    isOpen: () => !permanentlyDead && !respawning && client.isOpen(),
    close: async () => {
      intentionalClose = true;
      try {
        await client.close();
      } finally {
        await worker.terminate();
        // A crash-respawn racing this close may have spawned a fresh worker
        // that opened the DB before it observed intentionalClose; that path
        // terminates it, but await the respawn so no worker still holds the
        // SQLite/WAL handles once close() resolves. Resolved (Promise.resolve)
        // on the common no-crash path, so this is free there.
        await respawnSettled;
      }
    },
  };
}
