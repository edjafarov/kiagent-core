/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { Source } from '@shared/contracts';

import type { ConnectBroker } from '../../../auth/connect-broker';
import { openDb } from '../../../db/app-db';
import { registerBundledSources } from '../../../sources';
import { SCHEMA_DOC } from '../tools/schema-doc';

/**
 * Bidirectional drift detection between SCHEMA_DOC (what get_schema tells MCP
 * agents) and the live greenfield schema:
 *   1. every live column of a documented table has a doc entry;
 *   2. every live table is documented OR allowlisted (SQLite/FTS5 internals +
 *      the internal bookkeeping tables), and every documented table exists;
 *   3. the `source` enum exactly matches the registered source ids.
 * NOT enforced: the `type` enum (scattered per-source literals; hand-kept).
 */
describe('schema-doc drift detector', () => {
  let dir: string;
  let db: Awaited<ReturnType<typeof openDb>>;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-drift-'));
    db = await openDb(path.join(dir, 'test.db'));
  });

  afterAll(async () => {
    await db.close();
  });

  it('every live column in every documented table is documented', async () => {
    const missing: string[] = [];
    for (const table of SCHEMA_DOC.tables) {
      const liveCols = (await db.all(
        `PRAGMA table_info(${table.name})`,
      )) as Array<{ name: string }>;
      if (liveCols.length === 0) continue; // some virtual tables report 0 cols
      const documented = new Set(table.columns.map((c) => c.name));
      for (const col of liveCols) {
        if (!documented.has(col.name))
          missing.push(`${table.name}.${col.name}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every live table is documented or allowlisted, and vice versa', async () => {
    const liveRows = (await db.all(
      `SELECT name FROM sqlite_master WHERE type='table'`,
    )) as Array<{ name: string }>;
    const liveNames = liveRows.map((r) => r.name);
    const documented = new Set(SCHEMA_DOC.tables.map((t) => t.name));

    // Internal bookkeeping tables (not agent-facing) + SQLite internals + the
    // FTS5 shadow tables of documented virtual tables.
    const INTERNAL = new Set([
      'meta',
      'consumers',
      'work_ledger',
      'vault',
      'consents',
      'schedule',
    ]);
    const isInternal = (name: string): boolean => {
      if (name.startsWith('sqlite_')) return true;
      if (INTERNAL.has(name)) return true;
      for (const doc of documented) {
        if (
          name.startsWith(`${doc}_`) &&
          /_(data|idx|content|docsize|config)$/.test(name)
        ) {
          return true;
        }
      }
      return false;
    };

    const undocumented = liveNames.filter(
      (n) => !isInternal(n) && !documented.has(n),
    );
    expect(undocumented).toEqual([]);

    const liveSet = new Set(liveNames);
    const phantom = [...documented].filter((n) => !liveSet.has(n));
    expect(phantom).toEqual([]);
  });

  it('the source enum exactly matches the registered source ids', () => {
    const ids: string[] = [];
    const brokerStub = {
      registerOAuthProfile: () => {},
    } as unknown as ConnectBroker;
    registerBundledSources(
      (s: Source) => ids.push(s.descriptor.id),
      brokerStub,
    );

    const sourceEnum = SCHEMA_DOC.enums.find((e) => e.name === 'source');
    expect(sourceEnum).toBeDefined();
    expect([...sourceEnum!.values].sort()).toEqual([...ids].sort());
  });
});
