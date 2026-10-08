import { openCorpusReadConnection, type AppDb } from '../../../../db/app-db';
import type { SqlExecutorHandle } from '../../sql-runner';
import { createInProcessSqlExecutor } from '../../tools/raw-sql';

/** Test executor over its own query-only corpus connection to `dbPath`, opened
 *  lazily on first use (the file may be created after the call site) and
 *  closed by stop(). Same open path the stdio sibling uses. */
export function createTestSqlExecutor(dbPath: string): SqlExecutorHandle {
  let opened: Promise<{ db: AppDb; inner: SqlExecutorHandle }> | null = null;
  const open = (): Promise<{ db: AppDb; inner: SqlExecutorHandle }> => {
    opened ??= openCorpusReadConnection(dbPath, { queryOnly: true }).then(
      (db) => ({ db, inner: createInProcessSqlExecutor(db._conn!) }),
    );
    return opened;
  };
  return {
    exec: async (sql) => (await open()).inner.exec(sql),
    stop: async () => {
      if (!opened) return;
      const { db } = await opened;
      opened = null;
      await db.close();
    },
  };
}
