/**
 * Child process entry for query_sql (spec §3.4). Opens the corpus query-only
 * and answers `{ id, sql }` with the bounded result. It deliberately installs
 * NO signal handlers: the default SIGTERM action kills the process even while
 * SQLite is inside a long `sqlite3_step`, which is the whole point.
 */
import { openCorpusReadConnection } from '../../db/app-db';
import { runQuerySqlBounded } from './tools/query-sql';

type ParentPort = {
  postMessage(m: unknown): void;
  on(ev: 'message', cb: (m: unknown) => void): void;
};
// Electron utilityProcess has `process.parentPort`; child_process.fork has
// `process.send` / `process.on('message')`.
const { parentPort } = process as unknown as { parentPort?: ParentPort };

/** `done` runs once the message has left this process, so a following
 *  `process.exit` cannot drop it. */
const send = (m: unknown, done?: () => void): void => {
  if (parentPort) {
    parentPort.postMessage(m);
    if (done) setTimeout(done, 100); // utilityProcess has no send callback
  } else if (process.send) {
    process.send(m, undefined, undefined, () => done?.());
  } else {
    done?.();
  }
};
const onMessage = (cb: (m: unknown) => void): void => {
  if (parentPort) {
    parentPort.on('message', (ev: unknown) =>
      cb(
        ev && typeof ev === 'object' && 'data' in ev
          ? (ev as { data: unknown }).data
          : ev,
      ),
    );
  } else {
    process.on('message', cb);
  }
};

// Not a signal handler: the forked (non-Electron) child leaves when its parent
// goes away; a utilityProcess dies with the app.
process.on('disconnect', () => process.exit(0));

(async () => {
  try {
    const dbPath = process.env.KIA_SQL_RUNNER_DB;
    if (!dbPath) throw new Error('KIA_SQL_RUNNER_DB is not set');
    const db = await openCorpusReadConnection(dbPath, {
      cacheKiB: 2048,
      queryOnly: true,
    });
    const conn = db._conn!;
    onMessage((m) => {
      const req = m as { id: number; sql: string };
      const started = performance.now();
      try {
        const { result, bytes } = runQuerySqlBounded(conn, req.sql);
        send({
          id: req.id,
          ok: true,
          result,
          bytes,
          execMs: performance.now() - started,
        });
      } catch (e) {
        send({
          id: req.id,
          ok: false,
          message: e instanceof Error ? e.message : String(e),
          execMs: performance.now() - started,
        });
      }
    });
    send({ t: 'ready' });
  } catch (e) {
    // Exit only after the reason has been delivered (never drop it).
    send(
      { t: 'open-error', message: e instanceof Error ? e.message : String(e) },
      () => process.exit(1),
    );
  }
})();
