/** Which core tables leave the master (spec sections 7.6 and 7.8). Explicit on
 *  purpose: a new core table stays on its device until someone decides
 *  otherwise, and tracking.test.ts fails until it is classified here. Parents
 *  come before their children: apply deletes in reverse order and upserts in
 *  this order. */
import { createHash } from 'node:crypto';

import type BetterSqlite3 from 'better-sqlite3';

import { pluginIdentifier } from '@shared/plugin-sql';

export const COPIED_CORE_TABLES: readonly string[] = [
  'accounts',
  'documents',
  'outbox',
  'event_drafts',
  'sync_epochs',
  'attention_items',
  'attention_revisions',
  'user_prefs',
  'shared_files',
  'shared_capture_files',
];

export const LOCAL_CORE_TABLES: readonly string[] = [
  'changes',
  'consents',
  'consumers',
  'meta',
  'schedule',
  'shared_mirror',
  'shared_pending',
  'sync_imported',
  'sync_moved',
  'sync_offers',
  'sync_outbound',
  'sync_retained',
  'sync_rows',
  'sync_state',
  'vault',
  'work_attempts',
  'work_ledger',
];

/** Search tables: in a snapshot, maintained by apply, never sent as rows. */
export function isDerivedTable(name: string): boolean {
  return /^documents_(fts|tri)(_|$)/.test(name);
}

interface Registered {
  pluginId: string;
  digest: string;
  synced: string[];
  ownerCapture: string[];
}

const ownerCaptureOf = (json: string): string[] => {
  try {
    const list = (JSON.parse(json) as { ownerCapture?: unknown }).ownerCapture;
    return Array.isArray(list) ? list.filter((n): n is string => typeof n === 'string') : [];
  } catch {
    return [];
  }
};

/** The plugins whose descriptors name synced tables, from the registry tables
 *  that live in the same file. `schema` is `main`, or an attached file. */
function registeredSynced(conn: BetterSqlite3.Database, schema: string): Registered[] {
  const have = conn
    .prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type = 'table' AND name = 'plugin_storage'`)
    .get();
  if (!have) return [];
  const rows = conn
    .prepare(
      `SELECT plugin_id, descriptor_digest, descriptor_json FROM ${schema}.plugin_storage
        WHERE state = 'active' ORDER BY plugin_id`,
    )
    .all() as { plugin_id: string; descriptor_digest: string; descriptor_json: string }[];
  const out: Registered[] = [];
  for (const r of rows) {
    let synced: unknown;
    try {
      synced = (JSON.parse(r.descriptor_json) as { synced?: unknown }).synced;
    } catch {
      continue;
    }
    if (!Array.isArray(synced) || synced.length === 0) continue;
    out.push({
      pluginId: r.plugin_id,
      digest: r.descriptor_digest,
      synced: synced.filter((n): n is string => typeof n === 'string'),
      ownerCapture: ownerCaptureOf(r.descriptor_json),
    });
  }
  return out;
}

/** The core list plus the physical names of every synced table of a registered
 *  plugin that exists in this file (Task 3, Decision 3). */
export function copiedTables(conn: BetterSqlite3.Database, schema = 'main'): string[] {
  const exists = conn.prepare(
    `SELECT 1 FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`,
  );
  const extra: string[] = [];
  for (const p of registeredSynced(conn, schema)) {
    for (const logical of p.synced) {
      const phys = pluginIdentifier(p.pluginId, logical).replaceAll('"', '');
      if (exists.get(phys)) extra.push(phys);
    }
  }
  return [...COPIED_CORE_TABLES, ...extra];
}

/** The physical names of the owner-capture tables the registered plugins of
 *  `schema` list (step 3): the capturing device keeps writing these on a
 *  follower, and a join keeps its own rows of them. */
export function ownerCaptureTables(conn: BetterSqlite3.Database, schema = 'main'): string[] {
  const exists = conn.prepare(
    `SELECT 1 FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`,
  );
  const out: string[] = [];
  for (const p of registeredSynced(conn, schema)) {
    for (const logical of p.ownerCapture) {
      const phys = pluginIdentifier(p.pluginId, logical).replaceAll('"', '');
      if (exists.get(phys)) out.push(phys);
    }
  }
  return out;
}

/** What two devices must agree on before one can read the other's rows
 *  (spec 7.8, ruling 6, narrowed in 7.9): which synced plugin tables exist and
 *  the digest of each descriptor that names them. Core tables and the schema
 *  version are out: the protocol and schema checks already gate those, and a
 *  new core table must not force a full re-copy. Never row data. */
export function copiedSetDigest(conn: BetterSqlite3.Database): string {
  const hash = createHash('sha256');
  const core = new Set(COPIED_CORE_TABLES);
  for (const t of copiedTables(conn).filter((n) => !core.has(n)).sort()) {
    hash.update(`table:${t}\n`);
  }
  for (const p of registeredSynced(conn, 'main')) {
    hash.update(`descriptor:${p.pluginId}:${p.digest}\n`);
  }
  return `v2:${hash.digest('hex')}`;
}

/** Primary-key columns in key order: the `pk` JSON array of a tracked row is
 *  positional over these. */
export function primaryKeyColumns(
  conn: BetterSqlite3.Database,
  table: string,
  schema = 'main',
): string[] {
  return (
    conn
      .prepare(`SELECT name FROM pragma_table_info(?, ?) WHERE pk > 0 ORDER BY pk`)
      .all(table, schema) as { name: string }[]
  ).map((c) => c.name);
}
