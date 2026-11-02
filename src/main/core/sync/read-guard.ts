/** The outbox and event drafts write through the generic database handle, which
 *  has no writer guard. On a follower, or a master that has not heard from
 *  registration yet, they refuse every statement that is not a read (spec 7.8:
 *  one write authority per copied table). The role is asked on each call. */
import type { AppDb } from '../../db/app-db';

import { SyncReadOnly } from './role';

const READS = /^\s*(?:--[^\n]*\n\s*)*(select|pragma|explain)\b/i;
const WITH_WRITES = /\b(insert|update|delete|replace)\b/i;

const isRead = (sql: string): boolean =>
  READS.test(sql) || (/^\s*with\b/i.test(sql) && !WITH_WRITES.test(sql));

export function readGuardedDb(db: AppDb, readOnly: () => boolean): AppDb {
  const refuse = (sql: string): never => {
    throw new SyncReadOnly(sql.trim().split(/\s+/).slice(0, 3).join(' '));
  };
  const guarded = Object.create(db) as AppDb;
  guarded.exec = (sql) => (readOnly() && !isRead(sql) ? Promise.reject(safe(sql)) : db.exec(sql));
  guarded.run = (sql, params) =>
    readOnly() && !isRead(sql) ? Promise.reject(safe(sql)) : db.run(sql, params);
  guarded.batch = (steps) => {
    if (readOnly()) {
      const bad = steps.find((s) => !isRead(s.sql));
      if (bad) return Promise.reject(safe(bad.sql));
    }
    return db.batch(steps);
  };
  function safe(sql: string): Error {
    try {
      return refuse(sql);
    } catch (e) {
      return e as Error;
    }
  }
  return guarded;
}
